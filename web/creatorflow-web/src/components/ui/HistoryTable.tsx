export interface HistoryTableProps {
  columns: string[];
  rows: Array<Record<string, string>>;
  onLoadMore: () => void;
  hasMore: boolean;
}

export function HistoryTable({ columns, rows, onLoadMore, hasMore }: HistoryTableProps) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 bg-zinc-950/60">
              {columns.map((col) => (
                <th
                  key={col}
                  className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-widest text-zinc-500"
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/60">
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length || 1}
                  className="px-4 py-10 text-center text-xs text-zinc-600"
                >
                  No transactions yet
                </td>
              </tr>
            ) : (
              rows.map((row, i) => (
                <tr
                  key={i}
                  className="transition-colors hover:bg-zinc-800/40"
                >
                  {columns.map((col) => (
                    <td key={col} className="px-4 py-3 font-mono text-xs text-zinc-300 whitespace-nowrap">
                      {row[col] ?? "—"}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {hasMore && (
        <div className="border-t border-zinc-800 p-3 text-center">
          <button
            type="button"
            onClick={onLoadMore}
            className="text-xs font-medium text-indigo-400 hover:text-indigo-300 transition-colors"
          >
            Load more ↓
          </button>
        </div>
      )}
    </div>
  );
}
