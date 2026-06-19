export interface ConfigCardProps {
  config: {
    id: string;
    recipientCount: number;
    taxBps: number;
    savingsBps: number;
    createdAtMs: string;
  };
  onClick: () => void;
}

export function ConfigCard({ config, onClick }: ConfigCardProps) {
  const fmt = (bps: number) => `${(bps / 100).toFixed(2)}%`;
  const date = new Date(Number(config.createdAtMs)).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  return (
    <button
      type="button"
      onClick={onClick}
      className="group w-full text-left rounded-xl border border-zinc-800 bg-zinc-900 p-5 transition-all duration-150 hover:border-indigo-500 hover:shadow-lg hover:shadow-indigo-900/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <p className="truncate font-mono text-xs text-zinc-500 mb-1">{config.id}</p>
          <p className="text-sm text-zinc-300 font-medium">Created {date}</p>
        </div>
        <span className="shrink-0 rounded-full bg-zinc-800 px-2 py-0.5 text-xs font-medium text-zinc-400 group-hover:bg-indigo-900/40 group-hover:text-indigo-300 transition-colors">
          {config.recipientCount} recipient{config.recipientCount !== 1 ? "s" : ""}
        </span>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="rounded-lg bg-zinc-800/60 px-3 py-2">
          <p className="text-xs text-zinc-500 uppercase tracking-wide mb-0.5">Tax</p>
          <p className="text-base font-semibold text-amber-400">{fmt(config.taxBps)}</p>
        </div>
        <div className="rounded-lg bg-zinc-800/60 px-3 py-2">
          <p className="text-xs text-zinc-500 uppercase tracking-wide mb-0.5">Savings</p>
          <p className="text-base font-semibold text-emerald-400">{fmt(config.savingsBps)}</p>
        </div>
      </div>
    </button>
  );
}
