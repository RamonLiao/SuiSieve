function formatUsdc(amount: bigint) {
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString().padStart(7, "0");
  const whole = digits.slice(0, -6).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = digits.slice(-6).replace(/0+$/, "").padEnd(2, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

export function VaultBalance({ label, amount, symbol, loading }: { label: 'Tax' | 'Savings'; amount: bigint; symbol: 'USDC'; loading: boolean }) {
  const isTax = label === "Tax";

  return (
    <section className="relative isolate overflow-hidden rounded-[1.5rem] border border-slate-800 bg-slate-950 px-5 py-5 shadow-[0_24px_60px_-36px_rgba(14,165,233,0.65)]">
      <div className={`absolute -right-10 -top-12 -z-10 h-32 w-32 rounded-full blur-3xl ${isTax ? "bg-amber-400/15" : "bg-cyan-400/15"}`} />
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <span className={`grid h-8 w-8 place-items-center rounded-lg border ${isTax ? "border-amber-400/25 bg-amber-400/10 text-amber-300" : "border-cyan-400/25 bg-cyan-400/10 text-cyan-300"}`}>
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-4 w-4">
              <path d="M5 8.5h14v10H5zM7 8.5V6.8C7 5.8 7.8 5 8.8 5h6.4C16.2 5 17 5.8 17 6.8v1.7M8 13h8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
          </span>
          <div>
            <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-slate-300">{label} vault</h3>
            <p className="mt-0.5 text-[0.65rem] text-slate-500">Protected on-chain reserve</p>
          </div>
        </div>
        <span className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-[0.65rem] font-bold tracking-wider text-slate-400">
          {symbol}
        </span>
      </div>

      <div className="mt-7 min-h-10" aria-busy={loading}>
        {loading ? (
          <div className="flex items-end gap-2">
            <span className="h-9 w-36 animate-pulse rounded-lg bg-slate-800" />
            <span className="mb-1 h-4 w-12 animate-pulse rounded bg-slate-800/70" />
          </div>
        ) : (
          <p className="flex items-baseline gap-2">
            <span className="font-mono text-3xl font-semibold tracking-[-0.05em] tabular-nums text-white sm:text-4xl">
              {formatUsdc(amount)}
            </span>
            <span className={`text-xs font-bold ${isTax ? "text-amber-300" : "text-cyan-300"}`}>{symbol}</span>
          </p>
        )}
      </div>
    </section>
  );
}
