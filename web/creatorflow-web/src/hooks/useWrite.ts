import { useState } from "react";
import { useDAppKit } from "@mysten/dapp-kit-react";
import { mapAbort } from "@/lib/abort";
import {
  buildCreateConfig,
  buildExecuteSplit,
  buildMutateConfig,
  buildWithdraw,
  buildRedeemYield,
} from "@/lib/ptb";
import { getConfigVersion, getUsdcCoinIds, getOwnerCapId } from "@/lib/chain";
import type { RecipientInput } from "@/lib/bps";
import type { SuiClientTypes } from "@mysten/sui/client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Outcome = { ok: true; digest: string } | { ok: false; error: string };

/**
 * The REAL sign result shape (SuiClientTypes.TransactionResult):
 *   Success: { $kind: 'Transaction', Transaction: { digest, status: { success: true, error: null }, ... } }
 *   Failure: { $kind: 'FailedTransaction', FailedTransaction: { digest, status: { success: false, error: { message } }, ... } }
 *
 * NOTE: The brief assumed a plain { FailedTransaction } | { Transaction } union without $kind.
 * The actual SDK uses $kind as the discriminant. Both union branches exist; we check $kind.
 */
export function signResultToOutcome(
  result: SuiClientTypes.TransactionResult<{ effects: true; transaction: true; bcs: true }>,
): Outcome {
  if (result.$kind === "Transaction" && result.Transaction?.digest) {
    return { ok: true, digest: result.Transaction.digest };
  }
  if (result.$kind === "FailedTransaction") {
    const errMsg = (result.FailedTransaction?.status as any)?.error?.message ?? null;
    return { ok: false, error: mapAbort(errMsg) };
  }
  return { ok: false, error: "Unknown transaction result" };
}

// ---------------------------------------------------------------------------
// pollUntil — exponential backoff, ~30s cap
// ---------------------------------------------------------------------------

export async function pollUntil<T>(
  fn: () => Promise<T>,
  done: (t: T) => boolean,
  opts: { baseMs?: number; capMs?: number; maxMs?: number } = {},
): Promise<T> {
  const { baseMs = 500, capMs = 4000, maxMs = 30_000 } = opts;
  const start = Date.now();
  let delay = baseMs;
  for (;;) {
    const v = await fn();
    if (done(v)) return v;
    if (Date.now() - start > maxMs) return v;
    await new Promise<void>((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, capMs);
  }
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function useExecuteSplit(p: {
  configId: string;
  taxVaultId: string;
  savingsVaultId: string;
}) {
  const kit = useDAppKit();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(amountIn: bigint): Promise<Outcome> {
    setPending(true);
    setError(null);
    try {
      // T2 guard: read expected version immediately before build
      const { account } = kit.stores.$connection.get() as { account: { address: string } | null };
      if (!account) throw new Error("Wallet not connected.");

      const expectedVersion = await getConfigVersion(p.configId);
      const usdcCoinIds = await getUsdcCoinIds(account.address);
      if (usdcCoinIds.length === 0) throw new Error("No USDC coins found in wallet.");

      const tx = buildExecuteSplit({
        configId: p.configId,
        taxVaultId: p.taxVaultId,
        savingsVaultId: p.savingsVaultId,
        amountIn,
        expectedVersion,
        usdcCoinIds,
      });

      const result = await kit.signAndExecuteTransaction({ transaction: tx });
      const o = signResultToOutcome(result);
      if (!o.ok) setError(o.error);
      return o;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const mapped = mapAbort(msg);
      setError(mapped);
      return { ok: false, error: mapped };
    } finally {
      setPending(false);
    }
  }

  return { run, pending, error };
}

/**
 * Returns { run(args), pending, error } for creating a new config+vaults.
 */
export function useCreateConfig() {
  const kit = useDAppKit();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(args: {
    recipients: RecipientInput[];
    taxBps: number;
    savingsBps: number;
    feeBps: number;
    yieldBps: number;
  }): Promise<Outcome> {
    setPending(true);
    setError(null);
    try {
      const tx = buildCreateConfig(args);
      const result = await kit.signAndExecuteTransaction({ transaction: tx });
      const o = signResultToOutcome(result);
      if (!o.ok) setError(o.error);
      return o;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const mapped = mapAbort(msg);
      setError(mapped);
      return { ok: false, error: mapped };
    } finally {
      setPending(false);
    }
  }

  return { run, pending, error };
}

export function useMutateConfig(p: { configId: string }) {
  const kit = useDAppKit();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(args: {
    recipients: RecipientInput[];
    taxBps: number;
    savingsBps: number;
  }): Promise<Outcome> {
    setPending(true);
    setError(null);
    try {
      const { account } = kit.stores.$connection.get() as { account: { address: string } | null };
      if (!account) throw new Error("Wallet not connected.");

      const ownerCapId = await getOwnerCapId(account.address, "OwnerCap");
      if (!ownerCapId) throw new Error("No OwnerCap found for this wallet.");

      const tx = buildMutateConfig({
        configId: p.configId,
        ownerCapId,
        ...args,
      });
      const result = await kit.signAndExecuteTransaction({ transaction: tx });
      const o = signResultToOutcome(result);
      if (!o.ok) setError(o.error);
      return o;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const mapped = mapAbort(msg);
      setError(mapped);
      return { ok: false, error: mapped };
    } finally {
      setPending(false);
    }
  }

  return { run, pending, error };
}

export function useWithdraw(p: { vaultId: string; kind: "tax" | "savings" }) {
  const kit = useDAppKit();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(amount: bigint): Promise<Outcome> {
    setPending(true);
    setError(null);
    try {
      const { account } = kit.stores.$connection.get() as { account: { address: string } | null };
      if (!account) throw new Error("Wallet not connected.");

      const capKind = p.kind === "tax" ? ("TaxCap" as const) : ("SavingsCap" as const);
      const capId = await getOwnerCapId(account.address, capKind);
      if (!capId) throw new Error(`No ${capKind} found for this wallet.`);

      const tx = buildWithdraw({ vaultId: p.vaultId, capId, amount, kind: p.kind });
      const result = await kit.signAndExecuteTransaction({ transaction: tx });
      const o = signResultToOutcome(result);
      if (!o.ok) setError(o.error);
      return o;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const mapped = mapAbort(msg);
      setError(mapped);
      return { ok: false, error: mapped };
    } finally {
      setPending(false);
    }
  }

  return { run, pending, error };
}

export function useRedeemYield(p: { savingsVaultId: string }) {
  const kit = useDAppKit();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(amount: bigint): Promise<Outcome> {
    setPending(true);
    setError(null);
    try {
      const { account } = kit.stores.$connection.get() as { account: { address: string } | null };
      if (!account) throw new Error("Wallet not connected.");

      const savingsCapId = await getOwnerCapId(account.address, "SavingsCap");
      if (!savingsCapId) throw new Error("No SavingsCap found for this wallet.");

      const tx = buildRedeemYield({
        savingsVaultId: p.savingsVaultId,
        savingsCapId,
        amount,
      });
      const result = await kit.signAndExecuteTransaction({ transaction: tx });
      const o = signResultToOutcome(result);
      if (!o.ok) setError(o.error);
      return o;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const mapped = mapAbort(msg);
      setError(mapped);
      return { ok: false, error: mapped };
    } finally {
      setPending(false);
    }
  }

  return { run, pending, error };
}
