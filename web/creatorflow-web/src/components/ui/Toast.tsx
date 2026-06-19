export interface ToastProps {
  kind: "error" | "success";
  message: string;
}

export function Toast({ kind, message }: ToastProps) {
  const styles = {
    error: {
      container: "border-red-800 bg-red-950/70 text-red-300",
      icon: "text-red-400",
      glyph: "✕",
    },
    success: {
      container: "border-emerald-800 bg-emerald-950/70 text-emerald-300",
      icon: "text-emerald-400",
      glyph: "✓",
    },
  } as const;

  const s = styles[kind];

  return (
    <div
      role="alert"
      aria-live="assertive"
      className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-xl backdrop-blur-sm ${s.container}`}
    >
      <span className={`mt-0.5 shrink-0 text-base font-bold leading-none ${s.icon}`}>
        {s.glyph}
      </span>
      <p className="leading-snug">{message}</p>
    </div>
  );
}
