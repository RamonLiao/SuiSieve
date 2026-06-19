"use client";

import { useQuery } from "@tanstack/react-query";
import { useCurrentAccount } from "@mysten/dapp-kit-react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { listConfigs } from "@/lib/rest";
import { getClient } from "@/lib/chain";
import { ConfigCard } from "@/components/ui/ConfigCard";
import { VaultBalance } from "@/components/ui/VaultBalance";

// REST row shape from configCreated table (serialized via serializeRow)
type ConfigRow = {
  configId: string;
  txDigest: string;
  taxVaultId: string;
  savingsVaultId: string;
  owner: string;
  checkpointTimestampMs: string; // u64 serialized as string
};

// Chain object JSON shape for SplitConfig
type ConfigJson = {
  version: string;
  recipients: Array<{ addr: string; bps: string; label: string }>;
  tax_bps: string;
  savings_bps: string;
  protocol_fee_bps: string;
  yield_bps: string;
  tax_vault_id: string;
  savings_vault_id: string;
};

async function fetchConfigChainData(
  configId: string,
  taxVaultId: string,
  savingsVaultId: string,
): Promise<{ taxBps: number; savingsBps: number; recipientCount: number; taxBalance: bigint; savingsBalance: bigint }> {
  const client = getClient();

  const [configObj, taxObj, savingsObj] = await Promise.all([
    client.getObject({ objectId: configId, include: { json: true } }),
    client.getObject({ objectId: taxVaultId, include: { json: true } }),
    client.getObject({ objectId: savingsVaultId, include: { json: true } }),
  ]);

  const cfg = configObj.object?.json as ConfigJson | null | undefined;
  const taxBps = cfg ? Number(cfg.tax_bps) : 0;
  const savingsBps = cfg ? Number(cfg.savings_bps) : 0;
  const recipientCount = cfg ? cfg.recipients.length : 0;

  // Balance<T> serializes as { balance: { value: "12345" } } or flat { balance: "12345" }
  type VaultJson = { balance?: { value?: string } | string } | null | undefined;
  function extractVaultBalance(j: VaultJson): bigint {
    const b = j?.balance;
    if (b == null) return 0n;
    if (typeof b === "string") return BigInt(b);
    return BigInt(b.value ?? "0");
  }
  const taxBalance = extractVaultBalance(taxObj.object?.json as VaultJson);
  const savingsBalance = extractVaultBalance(savingsObj.object?.json as VaultJson);

  return { taxBps, savingsBps, recipientCount, taxBalance, savingsBalance };
}

function ConfigCardWithBalances({ row }: { row: ConfigRow }) {
  const router = useRouter();
  const { data, isLoading } = useQuery({
    queryKey: ["config-chain", row.configId],
    queryFn: () => fetchConfigChainData(row.configId, row.taxVaultId, row.savingsVaultId),
    staleTime: 30_000,
  });

  return (
    <div className="flex flex-col gap-3">
      <ConfigCard
        config={{
          id: row.configId,
          recipientCount: data?.recipientCount ?? 0,
          taxBps: data?.taxBps ?? 0,
          savingsBps: data?.savingsBps ?? 0,
          createdAtMs: row.checkpointTimestampMs,
        }}
        onClick={() => router.push(`/config/${row.configId}`)}
      />
      <div className="grid grid-cols-2 gap-3">
        <VaultBalance
          label="Tax"
          amount={data?.taxBalance ?? 0n}
          symbol="USDC"
          loading={isLoading}
        />
        <VaultBalance
          label="Savings"
          amount={data?.savingsBalance ?? 0n}
          symbol="USDC"
          loading={isLoading}
        />
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const account = useCurrentAccount();
  const address = account?.address;

  const { data, isLoading, error } = useQuery({
    queryKey: ["configs", address],
    queryFn: () => listConfigs(address!),
    enabled: !!address,
    staleTime: 15_000,
  });

  if (!address) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-slate-950 px-4">
        <p className="text-lg font-semibold text-slate-300">Connect your wallet to view your configs.</p>
        <Link
          href="/"
          className="rounded-xl border border-cyan-400/30 bg-cyan-400/10 px-5 py-2.5 text-sm font-bold text-cyan-300 transition hover:bg-cyan-400/20"
        >
          Go to home to connect
        </Link>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-10">
      <div className="mx-auto max-w-2xl">
        <div className="mb-8 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-white">Your Configs</h1>
            <p className="mt-1 text-sm text-slate-500 font-mono truncate max-w-xs">{address}</p>
          </div>
          <Link
            href="/config/new"
            className="inline-flex items-center gap-2 rounded-xl border border-cyan-300/25 bg-cyan-400 px-4 py-2.5 text-sm font-extrabold tracking-wide text-slate-950 shadow-[0_10px_24px_-12px_rgba(34,211,238,0.8)] transition hover:bg-cyan-300"
          >
            + New config
          </Link>
        </div>

        {isLoading && (
          <div className="space-y-4">
            {[1, 2].map((i) => (
              <div key={i} className="h-40 animate-pulse rounded-[1.4rem] bg-slate-900" />
            ))}
          </div>
        )}

        {error && (
          <div role="alert" className="rounded-xl border border-rose-400/25 bg-rose-400/[0.07] px-4 py-3 text-sm text-rose-200">
            Failed to load configs: {(error as Error).message}
          </div>
        )}

        {data && data.data.length === 0 && (
          <div className="rounded-xl border border-dashed border-slate-700 px-6 py-16 text-center">
            <p className="text-slate-400 font-medium">No configs yet.</p>
            <p className="mt-1 text-sm text-slate-600">Create your first split configuration.</p>
          </div>
        )}

        {data && data.data.length > 0 && (
          <div className="space-y-6">
            {(data.data as ConfigRow[]).map((row) => (
              <ConfigCardWithBalances key={row.configId} row={row} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
