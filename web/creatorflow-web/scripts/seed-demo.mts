/**
 * Demo seed for the fresh-deploy package (Task 7, pkg 0xe16643b1…).
 *
 * Creates ONE SplitConfig (+ tax/savings vaults) then runs TWO splits against it:
 *   1. plain  execute_split            (yield slice stays in savings)
 *   2. yield  execute_split_with_yield (yield slice routed to MockMarket)
 *
 * On-chain invariants honoured (split_config::new_unwired):
 *   sum(recipients.bps) + tax + savings + fee = 10000 ; yield ≤ savings ; fee ∈ [30,100].
 *
 * Run:
 *   cd web/creatorflow-web
 *   SUI_PRIVATE_KEY=$(sui keytool export --key-identity "$(sui client active-address)" --json | jq -r .exportedPrivateKey) \
 *     node --import tsx scripts/seed-demo.mts
 */
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { buildCreateConfig, buildExecuteSplit, buildExecuteSplitWithYield } from "../src/lib/ptb";
import { NETWORK, USDC_TYPE } from "../src/lib/constants";

const BASE_URL = "https://rpc.testnet.sui.io";
const PK = process.env.SUI_PRIVATE_KEY;
if (!PK) throw new Error("SUI_PRIVATE_KEY (suiprivkey… bech32) required");
const signer = Ed25519Keypair.fromSecretKey(PK);
const OWNER = signer.toSuiAddress();
const client = new SuiGrpcClient({ network: NETWORK, baseUrl: BASE_URL });

const USDC = 1_000_000n; // 6 decimals
const AMOUNT = 5n * USDC; // 5 USDC per split

type Json = Record<string, unknown>;

async function exec(tx: import("@mysten/sui/transactions").Transaction, label: string) {
  tx.setSender(OWNER);
  const res = await client.signAndExecuteTransaction({
    transaction: tx,
    signer,
    include: { effects: true, events: true },
  });
  if (res.$kind !== "Transaction") throw new Error(`${label} failed: ${JSON.stringify(res)}`);
  await client.waitForTransaction({ digest: res.Transaction.digest });
  console.log(`  ✓ ${label}  digest=${res.Transaction.digest}`);
  return res.Transaction;
}

/** USDC coin objectIds whose balances sum to ≥ need. */
async function usdcCoinIds(need: bigint): Promise<string[]> {
  const { objects } = await client.listCoins({ owner: OWNER, coinType: USDC_TYPE });
  const sorted = [...objects].sort((a, b) => (BigInt(b.balance) > BigInt(a.balance) ? 1 : -1));
  const picked: string[] = [];
  let sum = 0n;
  for (const c of sorted) {
    picked.push(c.objectId);
    sum += BigInt(c.balance);
    if (sum >= need) break;
  }
  if (sum < need) throw new Error(`insufficient USDC: have ${sum}, need ${need}`);
  return picked;
}

function findConfigCreated(txn: Json): { configId: string; taxVaultId: string; savingsVaultId: string } {
  // grpc SDK 2.0 event shapes vary; probe the common nests.
  const raw =
    (txn.events as Json | undefined)?.events ??
    (txn.events as unknown) ??
    [];
  const list = Array.isArray(raw) ? (raw as Json[]) : [];
  const ev = list.find((e) => String((e as Json).type ?? (e as Json).eventType ?? "").includes("::events::ConfigCreated"));
  if (!ev) throw new Error(`no ConfigCreated event; saw: ${JSON.stringify(list).slice(0, 600)}`);
  const j = ((ev.json ?? ev.parsedJson ?? ev.contents ?? ev) as Json);
  const out = {
    configId: String(j.config_id),
    taxVaultId: String(j.tax_vault_id),
    savingsVaultId: String(j.savings_vault_id),
  };
  for (const [k, v] of Object.entries(out))
    if (!/^0x[0-9a-f]{64}$/.test(v)) throw new Error(`bad ${k}=${v}; event json=${JSON.stringify(j)}`);
  return out;
}

async function main() {
  console.log(`Seeding demo as ${OWNER} on ${NETWORK}`);

  // 1) create config + vaults
  const createTx = buildCreateConfig({
    recipients: [
      { addr: OWNER, bps: 5000, label: "Lead Creator" },
      { addr: OWNER, bps: 1950, label: "Collaborator" },
    ],
    taxBps: 1000,
    savingsBps: 2000,
    feeBps: 50,
    yieldBps: 1000,
  });
  const created = await exec(createTx, "create_config_and_vaults");
  const cfg = findConfigCreated(created as unknown as Json);
  console.log(`  config=${cfg.configId}\n  tax=${cfg.taxVaultId}\n  savings=${cfg.savingsVaultId}`);
  const version = 0n; // fresh config

  // 2) plain split
  const plainTx = buildExecuteSplit({
    configId: cfg.configId,
    taxVaultId: cfg.taxVaultId,
    savingsVaultId: cfg.savingsVaultId,
    amountIn: AMOUNT,
    expectedVersion: version,
    usdcCoinIds: await usdcCoinIds(AMOUNT),
  });
  await exec(plainTx, "execute_split (plain)");

  // 3) yield split
  const yieldTx = buildExecuteSplitWithYield({
    configId: cfg.configId,
    taxVaultId: cfg.taxVaultId,
    savingsVaultId: cfg.savingsVaultId,
    amountIn: AMOUNT,
    expectedVersion: version,
    usdcCoinIds: await usdcCoinIds(AMOUNT),
  });
  await exec(yieldTx, "execute_split_with_yield");

  console.log("\nDone. config_id for the dashboard:");
  console.log(cfg.configId);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
