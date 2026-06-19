"use client";

export function ConfigCard({ config, onClick }: { config: { id: string; recipientCount: number; taxBps: number; savingsBps: number; createdAtMs: string }; onClick: () => void }) {
  const createdAt = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Number(config.createdAtMs)));

  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative w-full overflow-hidden rounded-[1.4rem] border border-slate-800 bg-slate-950 p-5 text-left shadow-[0_20px_50px_-30px_rgba(2,132,199,0.55)] transition duration-200 hover:-translate-y-0.5 hover:border-cyan-400/50 hover:bg-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
    >
      <span className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-cyan-300 via-sky-500 to-blue-700" />
      <span className="absolute -right-12 -top-16 h-36 w-36 rounded-full bg-cyan-400/8 blur-2xl transition group-hover:bg-cyan-400/15" />

      <span className="relative flex items-start justify-between gap-4">
        <span className="min-w-0">
          <span className="block text-[0.65rem] font-bold uppercase tracking-[0.22em] text-cyan-300">
            Split configuration
          </span>
          <span className="mt-2 block truncate font-mono text-sm font-medium text-slate-100">
            {config.id}
          </span>
          <span className="mt-1 block text-xs text-slate-500">Created {createdAt}</span>
        </span>
        <span className="shrink-0 rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-xs font-semibold text-slate-300">
          {config.recipientCount} {config.recipientCount === 1 ? "recipient" : "recipients"}
        </span>
      </span>

      <span className="relative mt-5 grid grid-cols-2 overflow-hidden rounded-xl border border-slate-800 bg-black/20">
        <span className="border-r border-slate-800 px-3.5 py-3">
          <span className="block text-[0.65rem] font-bold uppercase tracking-[0.18em] text-slate-500">Tax reserve</span>
          <span className="mt-1 block font-mono text-xl font-semibold tabular-nums text-amber-300">
            {(config.taxBps / 100).toFixed(2)}%
          </span>
        </span>
        <span className="px-3.5 py-3">
          <span className="block text-[0.65rem] font-bold uppercase tracking-[0.18em] text-slate-500">Savings</span>
          <span className="mt-1 block font-mono text-xl font-semibold tabular-nums text-cyan-300">
            {(config.savingsBps / 100).toFixed(2)}%
          </span>
        </span>
      </span>
    </button>
  );
}
