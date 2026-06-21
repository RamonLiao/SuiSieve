/**
 * Capability-defense demo (BUSINESS_SPEC §12 step 3, threat T4).
 *
 * Proves the owned-object Capability pattern: a TaxCap is bound to ONE TaxVault.
 * Using config A's TaxCap against config B's TaxVault aborts with EWrongCap —
 * the Move type system + per-object binding cap blast radius to a single vault.
 *
 * Read-only: uses gRPC simulateTransaction. No signing, no gas, no key needed.
 *
 * Run: cd web/creatorflow-web && pnpm exec tsx scripts/cap-defense-demo.mts
 *      (tsx not in deps — use: npx -y tsx scripts/cap-defense-demo.mts)
 */
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import { NETWORK, PACKAGE_ID } from "../src/lib/constants";

const OWNER = "0x1509b5fdf09296b2cf749a710e36da06f5693ccd5b2144ad643b3a895abcbc4c";
const client = new SuiGrpcClient({ network: NETWORK, baseUrl: "https://rpc.testnet.sui.io" });

type Cap = { capId: string; vaultId: string };

async function ownedTaxCaps(): Promise<Cap[]> {
  const { objects } = await client.listOwnedObjects({
    owner: OWNER,
    type: `${PACKAGE_ID}::capabilities::TaxCap`,
  });
  const out: Cap[] = [];
  for (const o of objects) {
    const { object } = await client.getObject({ objectId: o.objectId, include: { json: true } });
    const vaultId = (object?.json as Record<string, string> | undefined)?.vault_id;
    if (vaultId) out.push({ capId: o.objectId, vaultId });
  }
  return out;
}

function buildWithdraw(taxVaultId: string, taxCapId: string): Transaction {
  const tx = new Transaction();
  tx.setSender(OWNER);
  tx.moveCall({
    target: `${PACKAGE_ID}::router::withdraw_tax`,
    arguments: [tx.object(taxVaultId), tx.object(taxCapId), tx.pure.u64(1n)],
  });
  return tx;
}

async function simulate(label: string, taxVaultId: string, taxCapId: string) {
  const tx = buildWithdraw(taxVaultId, taxCapId);
  const res = await client.simulateTransaction({ transaction: tx, include: { effects: true } });
  console.log(`\n── ${label} ──`);
  console.log(`   vault ${taxVaultId.slice(0, 18)}…  cap ${taxCapId.slice(0, 18)}…`);
  if (res.$kind === "Transaction") {
    console.log(`   ✅ SUCCESS — status ${JSON.stringify(res.Transaction.status)}`);
  } else {
    console.log(`   🛑 ABORTED — ${JSON.stringify(res.FailedTransaction.status)}`);
  }
}

async function main() {
  const caps = await ownedTaxCaps();
  if (caps.length < 2) throw new Error(`need ≥2 TaxCaps to demo cross-config, got ${caps.length}`);
  const [a, b] = caps;

  console.log("CreatorFlow — Capability Defense (T4 / EWrongCap)");
  console.log(`owner ${OWNER.slice(0, 18)}…`);
  console.log(`config A: cap ${a.capId.slice(0, 14)}… → vault ${a.vaultId.slice(0, 14)}…`);
  console.log(`config B: cap ${b.capId.slice(0, 14)}… → vault ${b.vaultId.slice(0, 14)}…`);

  // Attack: A's cap against B's vault → must abort EWrongCap
  await simulate("ATTACK  config A's TaxCap → config B's TaxVault (expect EWrongCap)", b.vaultId, a.capId);
  // Legit: B's own cap against B's vault → must succeed
  await simulate("LEGIT   config B's TaxCap → config B's TaxVault (expect success)", b.vaultId, b.capId);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
