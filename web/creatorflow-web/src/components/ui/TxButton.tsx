export interface TxButtonProps {
  label: string;
  onClick: () => void;
  pending: boolean;
  disabled: boolean;
}

export function TxButton({ label, onClick, pending, disabled }: TxButtonProps) {
  const isDisabled = disabled || pending;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isDisabled}
      className="relative inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-900/40 transition-all duration-150 hover:bg-indigo-500 hover:shadow-indigo-800/50 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
    >
      {pending && (
        <span className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
      )}
      {label}
    </button>
  );
}
