"use client";

export function TxButton({ label, onClick, pending, disabled }: { label: string; onClick: () => void; pending: boolean; disabled: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || pending}
      aria-busy={pending}
      className="group relative inline-flex min-h-12 items-center justify-center gap-2.5 overflow-hidden rounded-xl border border-cyan-300/25 bg-cyan-400 px-5 py-3 text-sm font-extrabold tracking-wide text-slate-950 shadow-[0_14px_32px_-16px_rgba(34,211,238,0.9)] transition duration-200 hover:-translate-y-0.5 hover:bg-cyan-300 hover:shadow-[0_18px_36px_-14px_rgba(34,211,238,0.9)] active:translate-y-0 disabled:cursor-not-allowed disabled:border-slate-700 disabled:bg-slate-800 disabled:text-slate-500 disabled:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
    >
      <span className="absolute inset-x-0 top-0 h-px bg-white/70" />
      {pending ? (
        <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity=".25" strokeWidth="3" />
          <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        </svg>
      ) : (
        <svg className="h-4 w-4 transition group-hover:translate-x-0.5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M5 12h14m-5-5 5 5-5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      <span>{pending ? `${label}…` : label}</span>
    </button>
  );
}
