export interface VaultBalanceProps {
  label: "Tax" | "Savings";
  amount: bigint;
  symbol: "USDC";
  loading: boolean;
}

export function VaultBalance({ label, amount, symbol, loading }: VaultBalanceProps) {
  const colorMap = {
    Tax: {
      ring: "ring-amber-500/30",
      dot: "bg-amber-400",
      value: "text-amber-300",
      badge: "bg-amber-900/30 text-amber-400",
    },
    Savings: {
      ring: "ring-emerald-500/30",
      dot: "bg-emerald-400",
      value: "text-emerald-300",
      badge: "bg-emerald-900/30 text-emerald-400",
    },
  } as const;

  const c = colorMap[label];

  // USDC has 6 decimals
  const formatted = loading
    ? null
    : (Number(amount) / 1_000_000).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 6,
      });

  return (
    <div className={`rounded-xl border border-zinc-800 bg-zinc-900 ring-1 ${c.ring} p-5`}>
      <div className="flex items-center gap-2 mb-3">
        <span className={`h-2 w-2 rounded-full ${c.dot}`} />
        <span className="text-xs font-semibold uppercase tracking-widest text-zinc-400">
          {label} Vault
        </span>
        <span className={`ml-auto rounded-full px-2 py-0.5 text-xs font-medium ${c.badge}`}>
          {symbol}
        </span>
      </div>
      {loading ? (
        <div className="h-8 w-32 rounded-md bg-zinc-800 animate-pulse" />
      ) : (
        <p className={`text-3xl font-bold tabular-nums tracking-tight ${c.value}`}>
          {formatted}
        </p>
      )}
      <p className="mt-1 text-xs text-zinc-600">on-chain balance</p>
    </div>
  );
}
