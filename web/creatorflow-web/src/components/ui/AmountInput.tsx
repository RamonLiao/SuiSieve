"use client";

export function AmountInput({ value, onChange, max, symbol }: { value: string; onChange: (s: string) => void; max: string; symbol: 'USDC' }) {
  return (
    <div className="rounded-[1.25rem] border border-slate-800 bg-slate-950 p-1 shadow-[0_20px_50px_-35px_rgba(14,165,233,0.8)] transition focus-within:border-cyan-400/70 focus-within:ring-2 focus-within:ring-cyan-400/10">
      <div className="rounded-[1rem] bg-gradient-to-br from-slate-900 to-slate-950 px-4 py-4">
        <div className="flex items-center justify-between">
          <label htmlFor="creatorflow-amount" className="text-[0.65rem] font-bold uppercase tracking-[0.22em] text-slate-500">
            Transfer amount
          </label>
          <button
            type="button"
            onClick={() => onChange(max)}
            className="rounded-md px-2 py-1 text-xs font-semibold text-cyan-300 transition hover:bg-cyan-400/10 hover:text-cyan-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
          >
            Use max
          </button>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <input
            id="creatorflow-amount"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            className="min-w-0 flex-1 bg-transparent font-mono text-3xl font-semibold tracking-[-0.05em] tabular-nums text-white outline-none placeholder:text-slate-700 sm:text-4xl"
          />
          <span className="inline-flex shrink-0 items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-bold text-slate-100 shadow-inner">
            <span className="grid h-5 w-5 place-items-center rounded-full bg-[#2775ca] text-[0.55rem] font-black text-white">$</span>
            {symbol}
          </span>
        </div>
        <div className="mt-3 flex items-center justify-between border-t border-slate-800 pt-3 text-xs">
          <span className="text-slate-600">Available balance</span>
          <span className="font-mono font-medium tabular-nums text-slate-400">{max} {symbol}</span>
        </div>
      </div>
    </div>
  );
}
