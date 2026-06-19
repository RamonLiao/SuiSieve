"use client";

import { use, useState, useEffect, useCallback } from "react";
import { useCurrentAccount } from "@mysten/dapp-kit-react";
import Link from "next/link";
import {
  getConfig,
  getConfigSummary,
  listSplits,
  listMutations,
  listEarnings,
  listWithdrawals,
} from "@/lib/rest";
import { getClient, getUsdcBalance, getOwnerCapId } from "@/lib/chain";
import { extractVaultBalance } from "@/lib/vault";
import {
  useExecuteSplit,
  useWithdraw,
  useRedeemYield,
  pollUntil,
} from "@/hooks/useWrite";
import { HistoryTable } from "@/components/ui/HistoryTable";
import { AmountInput } from "@/components/ui/AmountInput";
import { TxButton } from "@/components/ui/TxButton";
import { Toast } from "@/components/ui/Toast";
import { VaultBalance } from "@/components/ui/VaultBalance";

// ─── types ───────────────────────────────────────────────────────────────────

type ConfigRow = {
  configId: string;
  txDigest: string;
  taxVaultId: string;
  savingsVaultId: string;
  owner: string;
  checkpointTimestampMs: string;
  latestVersion: string | null;
};

type SummaryRow = {
  count: number;
  totalAmountIn: string;
  totalTax: string;
  totalSavings: string;
  totalProtocolFee: string;
  totalYield: string;
};

type VaultJson = { balance?: { value?: string } | string } | null | undefined;

// ─── helpers ─────────────────────────────────────────────────────────────────

const USDC_DECIMALS = 6n;

function parseUsdcInput(s: string): bigint | null {
  const trimmed = s.trim();
  if (!trimmed || trimmed === ".") return null;
  const [whole = "0", frac = ""] = trimmed.split(".");
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(frac)) return null;
  const paddedFrac = frac.slice(0, 6).padEnd(6, "0");
  try {
    return BigInt(whole) * 10n ** USDC_DECIMALS + BigInt(paddedFrac);
  } catch {
    return null;
  }
}

function formatUsdcHuman(base: bigint): string {
  const neg = base < 0n;
  const abs = neg ? -base : base;
  const digits = abs.toString().padStart(7, "0");
  const whole = digits.slice(0, -6).replace(/^0+/, "") || "0";
  const frac = digits.slice(-6).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

function rowToStrings(row: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined) {
      out[k] = "";
    } else if (typeof v === "object") {
      out[k] = JSON.stringify(v);
    } else {
      out[k] = String(v);
    }
  }
  return out;
}

// ─── paged history hook ───────────────────────────────────────────────────────

type PagedState = { rows: Array<Record<string, string>>; cursor: string | null };

function usePagedHistory(
  fetchFn: (cursor?: string) => Promise<{ data: Array<Record<string, unknown>>; cursor: string | null }>,
  deps: unknown[],
) {
  const [state, setState] = useState<PagedState>({ rows: [], cursor: null });
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (append = false) => {
      setLoading(true);
      try {
        const cursor = append ? (state.cursor ?? undefined) : undefined;
        const page = await fetchFn(cursor);
        const newRows = page.data.map(rowToStrings);
        setState((prev) => ({
          rows: append ? [...prev.rows, ...newRows] : newRows,
          cursor: page.cursor,
        }));
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [...deps, state.cursor],
  );

  // initial load + refetch when deps change (but not cursor)
  const refresh = useCallback(
    async () => {
      setLoading(true);
      try {
        const page = await fetchFn(undefined);
        setState({ rows: page.data.map(rowToStrings), cursor: page.cursor });
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    deps,
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  const loadMore = useCallback(() => load(true), [load]);

  return { rows: state.rows, cursor: state.cursor, loading, loadMore, refresh };
}

// ─── vault balance section ────────────────────────────────────────────────────

function VaultBalances({
  taxVaultId,
  savingsVaultId,
  refreshKey,
}: {
  taxVaultId: string;
  savingsVaultId: string;
  refreshKey: number;
}) {
  const [taxBalance, setTaxBalance] = useState<bigint>(0n);
  const [savingsBalance, setSavingsBalance] = useState<bigint>(0n);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!taxVaultId || !savingsVaultId) return;
    setLoading(true);
    const client = getClient();
    Promise.all([
      client.getObject({ objectId: taxVaultId, include: { json: true } }),
      client.getObject({ objectId: savingsVaultId, include: { json: true } }),
    ])
      .then(([taxObj, savingsObj]) => {
        setTaxBalance(extractVaultBalance(taxObj.object?.json as VaultJson));
        setSavingsBalance(extractVaultBalance(savingsObj.object?.json as VaultJson));
      })
      .finally(() => setLoading(false));
  }, [taxVaultId, savingsVaultId, refreshKey]);

  return (
    <div className="grid grid-cols-2 gap-3">
      <VaultBalance label="Tax" amount={taxBalance} symbol="USDC" loading={loading} />
      <VaultBalance label="Savings" amount={savingsBalance} symbol="USDC" loading={loading} />
    </div>
  );
}

// ─── trigger split panel ──────────────────────────────────────────────────────

function TriggerSplitPanel({
  configId,
  taxVaultId,
  savingsVaultId,
  onSuccess,
}: {
  configId: string;
  taxVaultId: string;
  savingsVaultId: string;
  onSuccess: () => void;
}) {
  const account = useCurrentAccount();
  const address = account?.address;
  const [amount, setAmount] = useState("");
  const [usdcMax, setUsdcMax] = useState(0n);
  const [toast, setToast] = useState<{ kind: "error" | "success"; message: string } | null>(null);

  const { run, pending, error } = useExecuteSplit({ configId, taxVaultId, savingsVaultId });

  useEffect(() => {
    if (!address) return;
    getUsdcBalance(address).then(setUsdcMax).catch(() => setUsdcMax(0n));
  }, [address]);

  useEffect(() => {
    if (error) setToast({ kind: "error", message: error });
  }, [error]);

  const handleSplit = useCallback(async () => {
    setToast(null);
    const baseUnits = parseUsdcInput(amount);
    if (baseUnits === null || baseUnits <= 0n) {
      setToast({ kind: "error", message: "Enter a valid USDC amount." });
      return;
    }
    if (baseUnits > usdcMax) {
      setToast({ kind: "error", message: "Amount exceeds your USDC balance." });
      return;
    }
    const outcome = await run(baseUnits);
    if (outcome.ok) {
      setToast({ kind: "success", message: `Split executed. Digest: ${outcome.digest.slice(0, 12)}…` });
      setAmount("");
      // poll until the new split appears in REST, then trigger parent refresh
      await pollUntil(
        () => listSplits(configId),
        (page) => page.data.some((r) => (r as Record<string, unknown>).txDigest === outcome.digest),
        { maxMs: 30_000 },
      );
      onSuccess();
    }
  }, [amount, usdcMax, run, configId, onSuccess]);

  const maxHuman = formatUsdcHuman(usdcMax);

  return (
    <section className="space-y-4 rounded-[1.4rem] border border-slate-800 bg-slate-950 p-5 shadow-[0_24px_60px_-40px_rgba(14,165,233,0.65)]">
      <h2 className="text-sm font-bold uppercase tracking-[0.18em] text-slate-300">Trigger split</h2>
      <AmountInput value={amount} onChange={setAmount} max={maxHuman} symbol="USDC" />
      <TxButton
        label="Split"
        onClick={handleSplit}
        pending={pending}
        disabled={!address || !amount}
      />
      {toast && <Toast kind={toast.kind} message={toast.message} />}
    </section>
  );
}

// ─── withdraw panel ───────────────────────────────────────────────────────────

function WithdrawPanel({
  label,
  vaultId,
  kind,
  onSuccess,
}: {
  label: string;
  vaultId: string;
  kind: "tax" | "savings";
  onSuccess: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [toast, setToast] = useState<{ kind: "error" | "success"; message: string } | null>(null);
  const { run, pending, error } = useWithdraw({ vaultId, kind });

  useEffect(() => {
    if (error) setToast({ kind: "error", message: error });
  }, [error]);

  const handleWithdraw = useCallback(async () => {
    setToast(null);
    const baseUnits = parseUsdcInput(amount);
    if (baseUnits === null || baseUnits <= 0n) {
      setToast({ kind: "error", message: "Enter a valid USDC amount." });
      return;
    }
    const outcome = await run(baseUnits);
    if (outcome.ok) {
      setToast({ kind: "success", message: `Withdrawn. Digest: ${outcome.digest.slice(0, 12)}…` });
      setAmount("");
      onSuccess();
    }
  }, [amount, run, onSuccess]);

  return (
    <section className="space-y-4 rounded-[1.4rem] border border-slate-800 bg-slate-950 p-5">
      <h2 className="text-sm font-bold uppercase tracking-[0.18em] text-slate-300">{label}</h2>
      <AmountInput value={amount} onChange={setAmount} max="" symbol="USDC" />
      <TxButton
        label="Withdraw"
        onClick={handleWithdraw}
        pending={pending}
        disabled={!amount}
      />
      {toast && <Toast kind={toast.kind} message={toast.message} />}
    </section>
  );
}

// ─── redeem yield panel ───────────────────────────────────────────────────────

function RedeemYieldPanel({
  savingsVaultId,
  onSuccess,
}: {
  savingsVaultId: string;
  onSuccess: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [toast, setToast] = useState<{ kind: "error" | "success"; message: string } | null>(null);
  const { run, pending, error } = useRedeemYield({ savingsVaultId });

  useEffect(() => {
    if (error) setToast({ kind: "error", message: error });
  }, [error]);

  const handleRedeem = useCallback(async () => {
    setToast(null);
    const baseUnits = parseUsdcInput(amount);
    if (baseUnits === null || baseUnits <= 0n) {
      setToast({ kind: "error", message: "Enter a valid USDC amount." });
      return;
    }
    const outcome = await run(baseUnits);
    if (outcome.ok) {
      setToast({ kind: "success", message: `Yield redeemed. Digest: ${outcome.digest.slice(0, 12)}…` });
      setAmount("");
      onSuccess();
    }
  }, [amount, run, onSuccess]);

  return (
    <section className="space-y-4 rounded-[1.4rem] border border-slate-800 bg-slate-950 p-5">
      <h2 className="text-sm font-bold uppercase tracking-[0.18em] text-slate-300">Redeem yield</h2>
      <AmountInput value={amount} onChange={setAmount} max="" symbol="USDC" />
      <TxButton
        label="Redeem"
        onClick={handleRedeem}
        pending={pending}
        disabled={!amount}
      />
      {toast && <Toast kind={toast.kind} message={toast.message} />}
    </section>
  );
}

// ─── main page ────────────────────────────────────────────────────────────────

export default function ConfigDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const account = useCurrentAccount();
  const address = account?.address;

  const [configRow, setConfigRow] = useState<ConfigRow | null>(null);
  const [summary, setSummary] = useState<SummaryRow | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState<string | null>(null);

  // cap gating
  const [hasTaxCap, setHasTaxCap] = useState(false);
  const [hasSavingsCap, setHasSavingsCap] = useState(false);

  // balances refresh counter
  const [balanceKey, setBalanceKey] = useState(0);
  const bumpBalance = useCallback(() => setBalanceKey((k) => k + 1), []);

  // load config row + summary
  useEffect(() => {
    setConfigLoading(true);
    setConfigError(null);
    Promise.all([getConfig(id), getConfigSummary(id)])
      .then(([row, sum]) => {
        setConfigRow(row as ConfigRow);
        setSummary(sum as SummaryRow);
      })
      .catch((e) => setConfigError((e as Error).message))
      .finally(() => setConfigLoading(false));
  }, [id]);

  // cap gating
  useEffect(() => {
    if (!address) { setHasTaxCap(false); setHasSavingsCap(false); return; }
    getOwnerCapId(address, "TaxCap").then((cap) => setHasTaxCap(cap !== null)).catch(() => setHasTaxCap(false));
    getOwnerCapId(address, "SavingsCap").then((cap) => setHasSavingsCap(cap !== null)).catch(() => setHasSavingsCap(false));
  }, [address]);

  // history tables
  const splits = usePagedHistory(
    useCallback((cursor?: string) => listSplits(id, cursor) as Promise<{ data: Array<Record<string, unknown>>; cursor: string | null }>, [id]),
    [id],
  );
  const mutations = usePagedHistory(
    useCallback((cursor?: string) => listMutations(id, cursor) as Promise<{ data: Array<Record<string, unknown>>; cursor: string | null }>, [id]),
    [id],
  );
  const earnings = usePagedHistory(
    useCallback(
      (cursor?: string) =>
        address
          ? (listEarnings(address, cursor) as Promise<{ data: Array<Record<string, unknown>>; cursor: string | null }>)
          : Promise.resolve({ data: [], cursor: null }),
      [address],
    ),
    [address],
  );
  const taxWithdrawals = usePagedHistory(
    useCallback(
      (cursor?: string) =>
        configRow?.taxVaultId
          ? (listWithdrawals(configRow.taxVaultId, cursor) as Promise<{ data: Array<Record<string, unknown>>; cursor: string | null }>)
          : Promise.resolve({ data: [], cursor: null }),
      [configRow?.taxVaultId],
    ),
    [configRow?.taxVaultId],
  );
  const savingsWithdrawals = usePagedHistory(
    useCallback(
      (cursor?: string) =>
        configRow?.savingsVaultId
          ? (listWithdrawals(configRow.savingsVaultId, cursor) as Promise<{ data: Array<Record<string, unknown>>; cursor: string | null }>)
          : Promise.resolve({ data: [], cursor: null }),
      [configRow?.savingsVaultId],
    ),
    [configRow?.savingsVaultId],
  );

  const refreshAll = useCallback(() => {
    splits.refresh();
    mutations.refresh();
    earnings.refresh();
    taxWithdrawals.refresh();
    savingsWithdrawals.refresh();
    bumpBalance();
  }, [splits, mutations, earnings, taxWithdrawals, savingsWithdrawals, bumpBalance]);

  if (configLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-cyan-400 border-t-transparent" />
      </main>
    );
  }

  if (configError || !configRow) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-950 px-4">
        <p className="text-rose-300">{configError ?? "Config not found."}</p>
        <Link href="/dashboard" className="text-sm text-cyan-300 hover:underline">← Dashboard</Link>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-10">
      <div className="mx-auto max-w-2xl space-y-8">
        {/* header */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <Link href="/dashboard" className="text-xs text-slate-500 hover:text-slate-300">← Dashboard</Link>
            <h1 className="mt-1 text-lg font-bold text-white font-mono truncate">{id}</h1>
          </div>
          <Link
            href={`/config/${id}/edit`}
            className="rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-bold text-slate-300 hover:bg-slate-800"
          >
            Edit
          </Link>
        </div>

        {/* summary */}
        {summary && (
          <section className="rounded-[1.4rem] border border-slate-800 bg-slate-950 p-5 shadow-[0_24px_60px_-40px_rgba(14,165,233,0.65)]">
            <h2 className="mb-4 text-sm font-bold uppercase tracking-[0.18em] text-slate-300">Summary</h2>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {[
                ["Splits", String(summary.count)],
                ["Total in (USDC)", formatUsdcHuman(BigInt(summary.totalAmountIn))],
                ["Total tax", formatUsdcHuman(BigInt(summary.totalTax))],
                ["Total savings", formatUsdcHuman(BigInt(summary.totalSavings))],
                ["Protocol fee", formatUsdcHuman(BigInt(summary.totalProtocolFee))],
                ["Yield", formatUsdcHuman(BigInt(summary.totalYield))],
              ].map(([label, value]) => (
                <div key={label} className="rounded-xl border border-slate-800 bg-slate-900 px-3 py-3">
                  <dt className="text-[0.6rem] font-bold uppercase tracking-[0.18em] text-slate-500">{label}</dt>
                  <dd className="mt-1 font-mono text-sm font-semibold text-white tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}

        {/* vault balances */}
        <VaultBalances
          taxVaultId={configRow.taxVaultId}
          savingsVaultId={configRow.savingsVaultId}
          refreshKey={balanceKey}
        />

        {/* trigger split */}
        <TriggerSplitPanel
          configId={id}
          taxVaultId={configRow.taxVaultId}
          savingsVaultId={configRow.savingsVaultId}
          onSuccess={refreshAll}
        />

        {/* withdraw panels (cap-gated) */}
        {hasTaxCap && (
          <WithdrawPanel
            label="Withdraw tax"
            vaultId={configRow.taxVaultId}
            kind="tax"
            onSuccess={refreshAll}
          />
        )}
        {hasSavingsCap && (
          <WithdrawPanel
            label="Withdraw savings"
            vaultId={configRow.savingsVaultId}
            kind="savings"
            onSuccess={refreshAll}
          />
        )}
        {hasSavingsCap && (
          <RedeemYieldPanel savingsVaultId={configRow.savingsVaultId} onSuccess={refreshAll} />
        )}

        {/* history tables */}
        <div>
          <h2 className="mb-3 text-sm font-bold uppercase tracking-[0.18em] text-slate-400">Split history</h2>
          <HistoryTable
            columns={["txDigest", "amountIn", "taxAmount", "savingsAmount", "protocolFeeAmount", "timestampMs"]}
            rows={splits.rows}
            onLoadMore={splits.loadMore}
            hasMore={splits.cursor !== null}
          />
        </div>

        <div>
          <h2 className="mb-3 text-sm font-bold uppercase tracking-[0.18em] text-slate-400">Mutations</h2>
          <HistoryTable
            columns={["txDigest", "oldVersion", "newVersion", "mutator", "checkpointTimestampMs"]}
            rows={mutations.rows}
            onLoadMore={mutations.loadMore}
            hasMore={mutations.cursor !== null}
          />
        </div>

        <div>
          <h2 className="mb-3 text-sm font-bold uppercase tracking-[0.18em] text-slate-400">My earnings</h2>
          <HistoryTable
            columns={["txDigest", "amount", "bps", "configId", "timestampMs"]}
            rows={earnings.rows}
            onLoadMore={earnings.loadMore}
            hasMore={earnings.cursor !== null}
          />
        </div>

        <div>
          <h2 className="mb-3 text-sm font-bold uppercase tracking-[0.18em] text-slate-400">Tax vault withdrawals</h2>
          <HistoryTable
            columns={["txDigest", "amount", "kind", "recipient", "checkpointTimestampMs"]}
            rows={taxWithdrawals.rows}
            onLoadMore={taxWithdrawals.loadMore}
            hasMore={taxWithdrawals.cursor !== null}
          />
        </div>

        <div>
          <h2 className="mb-3 text-sm font-bold uppercase tracking-[0.18em] text-slate-400">Savings vault withdrawals</h2>
          <HistoryTable
            columns={["txDigest", "amount", "kind", "recipient", "checkpointTimestampMs"]}
            rows={savingsWithdrawals.rows}
            onLoadMore={savingsWithdrawals.loadMore}
            hasMore={savingsWithdrawals.cursor !== null}
          />
        </div>
      </div>
    </main>
  );
}
