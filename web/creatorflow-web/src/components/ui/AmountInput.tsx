"use client";

export interface AmountInputProps {
  value: string;
  onChange: (s: string) => void;
  max: string;
  symbol: "USDC";
}

export function AmountInput({ value, onChange, max, symbol }: AmountInputProps) {
  return (
    <div className="rounded-xl border border-zinc-700 bg-zinc-900 p-4 focus-within:border-indigo-500 focus-within:ring-1 focus-within:ring-indigo-500 transition-all">
      <div className="flex items-center gap-3">
        <input
          type="text"
          inputMode="decimal"
          placeholder="0.00"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="flex-1 min-w-0 bg-transparent text-2xl font-bold text-zinc-100 placeholder-zinc-700 focus:outline-none tabular-nums"
        />
        <span className="shrink-0 rounded-lg bg-zinc-800 px-3 py-1.5 text-sm font-semibold text-zinc-300">
          {symbol}
        </span>
      </div>
      <div className="mt-2 flex items-center justify-between">
        <span className="text-xs text-zinc-600">Amount</span>
        <button
          type="button"
          onClick={() => onChange(max)}
          className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
        >
          Max: {max}
        </button>
      </div>
    </div>
  );
}
