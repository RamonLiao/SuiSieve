/**
 * T10 contention load test (spec docs/superpowers/specs/2026-06-21-t10-load-test-design.md).
 * Single-key N-coin fan on testnet: isolates shared TaxVault+SavingsVault serialization.
 *
 * Run: cd web/creatorflow-web && \
 *   SUI_PRIVATE_KEY=suiprivkey... T10_CONFIG_ID=0x... \
 *   npx -y tsx scripts/t10-load-test.mts [tier]
 *   (no [tier] arg → runs 10,50,150,350; a number → runs just that tier)
 */
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { buildExecuteSplit } from "../src/lib/ptb";
import { NETWORK, USDC_TYPE } from "../src/lib/constants";
import { percentile, classify, type Bucket } from "./t10-lib";

const AMOUNT_RAW = 10_000n;
const FIXED_GAS_BUDGET = 20_000_000n;
const TIERS = [10, 50, 150, 350];
const BASE_URL = "https://rpc.testnet.sui.io";

const PK = process.env.SUI_PRIVATE_KEY;
if (!PK) throw new Error("SUI_PRIVATE_KEY (suiprivkey… bech32) required");
const signer = Ed25519Keypair.fromSecretKey(PK);
const OWNER = process.env.T10_OWNER ?? signer.toSuiAddress();
const CONFIG_ID = process.env.T10_CONFIG_ID;
if (!CONFIG_ID) throw new Error("T10_CONFIG_ID required");

const client = new SuiGrpcClient({ network: NETWORK, baseUrl: BASE_URL });

type Json = Record<string, unknown>;

/** Read config object → version + vault ids. */
async function readConfig(): Promise<{ version: bigint; taxVaultId: string; savingsVaultId: string }> {
  const { object } = await client.getObject({ objectId: CONFIG_ID!, include: { json: true } });
  const j = object?.json as Json | undefined;
  if (!j) throw new Error(`config ${CONFIG_ID} has no json content`);
  const version = BigInt(String(j.version));
  const taxVaultId = String(j.tax_vault_id);
  const savingsVaultId = String(j.savings_vault_id);
  if (!/^0x[0-9a-f]{64}$/.test(taxVaultId) || !/^0x[0-9a-f]{64}$/.test(savingsVaultId))
    throw new Error(`config missing tax/savings vault ids: ${taxVaultId} ${savingsVaultId}`);
  return { version, taxVaultId, savingsVaultId };
}

type ObjRef = { objectId: string; version: string; digest: string };

/** gRPC-web trailers arrive percent-encoded ("needs%20to%20be%20rebuilt"). Decode so
 *  retry-detection AND classify() see real spaces — otherwise every bucket mis-classifies. */
function decodeErr(x: unknown): string {
  const s = typeof x === "string" ? x : x instanceof Error ? `${x}` : JSON.stringify(x);
  try {
    return decodeURIComponent(s);
  } catch {
    return s.replace(/%20/g, " ");
  }
}

/** Retry a PREP step on transient owned-object version drift (fullnode lag between
 *  back-to-back fan txs). Prep-only — the timed burst never retries (would mask the ceiling). */
async function withRebuildRetry<T>(label: string, fn: () => Promise<T>, tries = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const msg = decodeErr(e);
      const transient = /needs to be rebuilt|unavailable for consumption|not available for consumption/i.test(msg);
      if (!transient || attempt >= tries) throw e;
      console.log(`  ⟳ ${label} retry ${attempt}/${tries - 1} (version drift)`);
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
}

/** Split one source coin (USDC or gas SUI) into `n` coins of `each`, transfer back to owner.
 *  Returns full refs for the n created coins (gas payment needs version+digest). Awaits finality. */
async function fanCoins(kind: "usdc" | "gas", n: number, each: bigint): Promise<ObjRef[]> {
  const tx = new Transaction();
  tx.setSender(OWNER);
  let source;
  if (kind === "usdc") {
    const coins = await client.listCoins({ owner: OWNER, coinType: USDC_TYPE });
    const big = coins.objects.find((c) => BigInt(c.balance) >= each * BigInt(n));
    if (!big) throw new Error(`no single USDC coin ≥ ${each * BigInt(n)}; merge first`);
    source = tx.object(big.objectId);
  } else {
    source = tx.gas; // split the gas coin itself
  }
  const parts = tx.splitCoins(source, Array.from({ length: n }, () => tx.pure.u64(each)));
  tx.transferObjects(Array.from({ length: n }, (_, i) => parts[i]), tx.pure.address(OWNER));
  const res = await client.signAndExecuteTransaction({ transaction: tx, signer, include: { effects: true } });
  if (res.$kind !== "Transaction") throw new Error(`fan ${kind} failed: ${JSON.stringify(res)}`);
  await client.waitForTransaction({ digest: res.Transaction.digest });
  // Created coin refs straight from effects — objectId + post-tx version + digest.
  const changed = (res.Transaction.effects?.changedObjects ?? []) as unknown as Json[];
  const created: ObjRef[] = changed
    .filter((o) => String(o.idOperation) === "Created")
    .map((o) => ({
      objectId: String(o.objectId),
      version: String(o.outputVersion ?? ""),
      digest: String(o.outputDigest ?? ""),
    }))
    .filter((r) => /^0x[0-9a-f]{64}$/.test(r.objectId) && r.version !== "" && r.digest !== "");
  if (created.length < n) throw new Error(`expected ≥${n} created ${kind} coins, got ${created.length}`);
  return created.slice(0, n);
}

/** Page all owner SUI coins into objectId → freshest {version,digest}.
 *  The fan-effects outputVersion can lag the fullnode's consumable version (gas smashing);
 *  this re-reads the authoritative current ref so pre-build's setGasPayment won't drift. */
async function freshSuiRefs(): Promise<Map<string, ObjRef>> {
  const map = new Map<string, ObjRef>();
  let cursor: string | null = null;
  do {
    const page = await client.listCoins({ owner: OWNER, coinType: "0x2::sui::SUI", cursor });
    for (const c of page.objects)
      map.set(c.objectId, { objectId: c.objectId, version: c.version, digest: c.digest });
    cursor = page.hasNextPage ? page.cursor : null;
  } while (cursor);
  return map;
}

type TierResult = {
  n: number; wallMs: number; tps: number;
  p50: number; p90: number; p99: number;
  buckets: Record<Bucket, number>;
};

async function runTier(n: number, cfg: Awaited<ReturnType<typeof readConfig>>): Promise<TierResult> {
  console.log(`\n=== tier N=${n} ===`);
  const usdcCoins = await withRebuildRetry("fan usdc", () => fanCoins("usdc", n, AMOUNT_RAW));
  const gasCoins = await withRebuildRetry("fan gas", () => fanCoins("gas", n, FIXED_GAS_BUDGET * 2n));

  // Refresh gas refs from the authoritative current snapshot (fan-effects version can lag).
  const sui = await freshSuiRefs();
  const gasRefs = gasCoins.map((g) => sui.get(g.objectId) ?? g);

  // PRE-BUILD all N tx bytes (object resolution happens here, OUT of the timed burst).
  const built: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    const tx = buildExecuteSplit({
      configId: CONFIG_ID!, taxVaultId: cfg.taxVaultId, savingsVaultId: cfg.savingsVaultId,
      amountIn: AMOUNT_RAW, expectedVersion: cfg.version, usdcCoinIds: [usdcCoins[i].objectId],
    });
    tx.setSender(OWNER);
    tx.setGasPayment([gasRefs[i]]); // freshest {objectId,version,digest} ref → no build-time drift
    tx.setGasBudget(FIXED_GAS_BUDGET);
    built.push(await withRebuildRetry(`prebuild#${i}`, () => tx.build({ client })));
  }

  // BURST: time only sign + execute.
  const buckets: Record<Bucket, number> = { success: 0, congestion: 0, locked: 0, terminal: 0, ratelimited: 0, network: 0 };
  const lat: number[] = [];
  const t0 = performance.now();
  const settled = await Promise.allSettled(built.map(async (bytes) => {
    const start = performance.now();
    try {
      const { signature } = await signer.signTransaction(bytes);
      const res = await client.executeTransaction({ transaction: bytes, signatures: [signature] });
      const ok = res.$kind === "Transaction";
      return { ms: performance.now() - start, r: ok ? { ok: true as const } : { ok: false as const, error: decodeErr(res) } };
    } catch (e) {
      return { ms: performance.now() - start, r: { ok: false as const, error: decodeErr(e) } };
    }
  }));
  const wallMs = performance.now() - t0;
  const samples: Partial<Record<Bucket, string>> = {};
  for (const s of settled) {
    if (s.status !== "fulfilled") { buckets.network++; continue; }
    lat.push(s.value.ms);
    const b = classify(s.value.r);
    buckets[b]++;
    if (b !== "success" && !samples[b] && !s.value.r.ok) samples[b] = s.value.r.error.slice(0, 200);
  }
  for (const [b, msg] of Object.entries(samples)) console.log(`  sample[${b}]: ${msg}`);
  lat.sort((a, b) => a - b);
  const out: TierResult = {
    n, wallMs, tps: (buckets.success / wallMs) * 1000,
    p50: percentile(lat, 50), p90: percentile(lat, 90), p99: percentile(lat, 99), buckets,
  };
  console.log(`  wall=${wallMs.toFixed(0)}ms tps=${out.tps.toFixed(1)} p50=${out.p50.toFixed(0)} p90=${out.p90.toFixed(0)} p99=${out.p99.toFixed(0)}`);
  console.log(`  buckets=${JSON.stringify(buckets)}`);
  return out;
}

function table(rows: TierResult[]): string {
  const h = "| N | wall(ms) | TPS | p50 | p90 | p99 | success | congestion | locked | terminal | ratelimited | network |";
  const sep = "|---|---|---|---|---|---|---|---|---|---|---|---|";
  const body = rows.map((r) =>
    `| ${r.n} | ${r.wallMs.toFixed(0)} | ${r.tps.toFixed(1)} | ${r.p50.toFixed(0)} | ${r.p90.toFixed(0)} | ${r.p99.toFixed(0)} | ${r.buckets.success} | ${r.buckets.congestion} | ${r.buckets.locked} | ${r.buckets.terminal} | ${r.buckets.ratelimited} | ${r.buckets.network} |`);
  return [h, sep, ...body].join("\n");
}

async function main() {
  const arg = process.argv[2];
  const tiers = arg ? [Number(arg)] : TIERS;
  const cfg = await readConfig();
  console.log(`owner ${OWNER.slice(0, 14)}… config ${CONFIG_ID!.slice(0, 14)}… version ${cfg.version}`);
  console.log(`tax ${cfg.taxVaultId.slice(0, 14)}… savings ${cfg.savingsVaultId.slice(0, 14)}…`);
  const rows: TierResult[] = [];
  for (const n of tiers) rows.push(await runTier(n, cfg));
  console.log("\n" + table(rows));
  console.log("\nNOTE: latency resolve = validator execution-ack, not checkpoint finality.");
  console.log("conserves() sample check: split math is enforced on-chain (Move tests); congestion>0 with success>0 = serialized-but-throughput-bound (expected T10 signal).");
}

main().catch((e) => { console.error(e); process.exit(1); });
