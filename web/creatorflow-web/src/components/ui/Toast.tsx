export function Toast({ kind, message }: { kind: 'error' | 'success'; message: string }) {
  const success = kind === "success";

  return (
    <div
      role={success ? "status" : "alert"}
      aria-live={success ? "polite" : "assertive"}
      className={`relative flex items-start gap-3 overflow-hidden rounded-xl border bg-slate-950 px-4 py-3.5 shadow-[0_18px_45px_-20px_rgba(0,0,0,0.9)] ${success ? "border-emerald-400/30" : "border-rose-400/30"}`}
    >
      <span className={`absolute inset-y-0 left-0 w-1 ${success ? "bg-emerald-400" : "bg-rose-400"}`} />
      <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full ${success ? "bg-emerald-400/12 text-emerald-300" : "bg-rose-400/12 text-rose-300"}`}>
        {success ? (
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-4 w-4">
            <path d="m6.5 12.5 3.5 3.5 7.5-8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-4 w-4">
            <path d="M12 7.5v5M12 16.5h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.7" />
          </svg>
        )}
      </span>
      <div className="min-w-0">
        <p className={`text-[0.65rem] font-bold uppercase tracking-[0.18em] ${success ? "text-emerald-300" : "text-rose-300"}`}>
          {success ? "Transaction confirmed" : "Action required"}
        </p>
        <p className="mt-1 break-words text-sm leading-5 text-slate-300">{message}</p>
      </div>
    </div>
  );
}
