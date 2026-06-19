"use client";

export function HistoryTable({ columns, rows, onLoadMore, hasMore }: { columns: string[]; rows: Array<Record<string,string>>; onLoadMore: () => void; hasMore: boolean }) {
  return (
    <section className="overflow-hidden rounded-[1.4rem] border border-slate-800 bg-slate-950 shadow-[0_24px_60px_-40px_rgba(14,165,233,0.65)]">
      <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
        <div>
          <h2 className="text-sm font-bold text-slate-100">Transaction history</h2>
          <p className="mt-0.5 text-xs text-slate-500">Verified CreatorFlow activity</p>
        </div>
        <span className="rounded-full border border-slate-800 bg-slate-900 px-2.5 py-1 font-mono text-[0.65rem] font-bold text-slate-400">
          {rows.length} records
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="bg-slate-900/55">
              {columns.map((column) => (
                <th key={column} scope="col" className="whitespace-nowrap border-b border-slate-800 px-5 py-3 text-[0.65rem] font-bold uppercase tracking-[0.18em] text-slate-500">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/80">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={Math.max(columns.length, 1)} className="px-5 py-14 text-center">
                  <span className="mx-auto grid h-10 w-10 place-items-center rounded-full border border-dashed border-slate-700 text-slate-600">
                    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-5 w-5">
                      <path d="M6 7h12M6 12h8M6 17h5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                    </svg>
                  </span>
                  <span className="mt-3 block text-sm font-medium text-slate-400">No activity recorded</span>
                  <span className="mt-1 block text-xs text-slate-600">Completed transactions will appear here.</span>
                </td>
              </tr>
            ) : (
              rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="group transition hover:bg-cyan-400/[0.035]">
                  {columns.map((column, columnIndex) => (
                    <td key={column} className={`whitespace-nowrap px-5 py-4 text-xs ${columnIndex === 0 ? "font-semibold text-slate-200" : "font-mono tabular-nums text-slate-400"}`}>
                      {row[column] || "—"}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {hasMore && (
        <div className="border-t border-slate-800 bg-slate-900/25 px-5 py-3 text-center">
          <button type="button" onClick={onLoadMore} className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-bold text-cyan-300 transition hover:bg-cyan-400/10 hover:text-cyan-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300">
            Load more
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-3.5 w-3.5">
              <path d="m7 10 5 5 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      )}
    </section>
  );
}
