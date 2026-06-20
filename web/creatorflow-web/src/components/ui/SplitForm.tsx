"use client";

import type { SplitDraft } from '@/lib/bps';

const inputClass = "w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2.5 text-sm text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-cyan-400/70 focus:ring-2 focus:ring-cyan-400/10";

export function SplitForm({ value, onChange, error, onSubmit, submitting }: { value: SplitDraft; onChange: (d: SplitDraft) => void; error: string | null; onSubmit: () => void; submitting: boolean }) {
  const updateRecipient = (index: number, field: "addr" | "label" | "bps", nextValue: string | number) => {
    onChange({
      ...value,
      recipients: value.recipients.map((recipient, recipientIndex) =>
        recipientIndex === index ? { ...recipient, [field]: nextValue } : recipient,
      ),
    });
  };

  const allocationFields = [
    ["Tax reserve", "taxBps"],
    ["Savings reserve", "savingsBps"],
    ["Platform fee", "feeBps"],
    ["Yield allocation", "yieldBps"],
  ] as const;

  return (
    <div className="overflow-hidden rounded-[1.5rem] border border-slate-800 bg-slate-950 shadow-[0_28px_70px_-45px_rgba(14,165,233,0.7)]">
      <div className="border-b border-slate-800 bg-gradient-to-r from-cyan-400/[0.07] to-transparent px-5 py-5 sm:px-6">
        <p className="text-[0.65rem] font-bold uppercase tracking-[0.22em] text-cyan-300">Payment routing</p>
        <h2 className="mt-1.5 text-lg font-semibold tracking-tight text-white">Build a revenue split</h2>
        <p className="mt-1 text-xs leading-5 text-slate-500">Define recipients and reserve policy in basis points.</p>
      </div>

      <div className="space-y-7 p-5 sm:p-6">
        <section aria-labelledby="split-recipients">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h3 id="split-recipients" className="text-sm font-bold text-slate-200">Recipients</h3>
              <p className="mt-0.5 text-xs text-slate-600">{value.recipients.length} payout destinations</p>
            </div>
            <button
              type="button"
              onClick={() => onChange({ ...value, recipients: [...value.recipients, { addr: "", bps: 0, label: "" }] })}
              className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-400/20 bg-cyan-400/8 px-3 py-2 text-xs font-bold text-cyan-300 transition hover:border-cyan-400/40 hover:bg-cyan-400/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
            >
              <span aria-hidden="true" className="text-base leading-none">+</span>
              Add recipient
            </button>
          </div>

          <div className="mt-4 space-y-3">
            {value.recipients.length === 0 && (
              <div className="rounded-xl border border-dashed border-slate-700 px-4 py-8 text-center">
                <p className="text-sm font-medium text-slate-400">No recipients added</p>
                <p className="mt-1 text-xs text-slate-600">Add a wallet to begin defining this split.</p>
              </div>
            )}
            {value.recipients.map((recipient, index) => (
              <div key={index} className="rounded-xl border border-slate-800 bg-slate-900/45 p-4">
                <div className="mb-3 flex items-center justify-between">
                  <span className="grid h-6 w-6 place-items-center rounded-md bg-slate-800 font-mono text-[0.65rem] font-bold text-slate-400">{index + 1}</span>
                  <button
                    type="button"
                    onClick={() => onChange({ ...value, recipients: value.recipients.filter((_, recipientIndex) => recipientIndex !== index) })}
                    aria-label={`Remove recipient ${index + 1}`}
                    className="rounded-md p-1.5 text-slate-600 transition hover:bg-rose-400/10 hover:text-rose-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
                  >
                    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-4 w-4">
                      <path d="M7 7l10 10M17 7 7 17" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
                <label className="block text-[0.65rem] font-bold uppercase tracking-[0.16em] text-slate-500">
                  Wallet address
                  <input type="text" value={recipient.addr} onChange={(event) => updateRecipient(index, "addr", event.target.value)} placeholder="0x…" className={`${inputClass} mt-1.5 font-mono text-xs`} />
                </label>
                <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_9rem]">
                  <label className="block text-[0.65rem] font-bold uppercase tracking-[0.16em] text-slate-500">
                    Label
                    <input type="text" value={recipient.label} onChange={(event) => updateRecipient(index, "label", event.target.value)} placeholder="e.g. Editor" className={`${inputClass} mt-1.5`} />
                  </label>
                  <label className="block text-[0.65rem] font-bold uppercase tracking-[0.16em] text-slate-500">
                    Share
                    <span className="relative mt-1.5 block">
                      <input type="text" inputMode="numeric" value={recipient.bps} onChange={(event) => updateRecipient(index, "bps", Number(event.target.value.replace(/\D/g, "")))} className={`${inputClass} pr-12 font-mono tabular-nums`} />
                      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[0.65rem] font-bold text-slate-600">BPS</span>
                    </span>
                  </label>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section aria-labelledby="split-policy">
          <div className="flex items-end justify-between gap-4">
            <div>
              <h3 id="split-policy" className="text-sm font-bold text-slate-200">Reserve policy</h3>
              <p className="mt-0.5 text-xs text-slate-600">10,000 bps equals 100%</p>
            </div>
            <span className="font-mono text-xs text-slate-500">BPS</span>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {allocationFields.map(([label, field]) => (
              <label key={field} className="rounded-xl border border-slate-800 bg-slate-900/45 p-3 text-[0.65rem] font-bold uppercase tracking-[0.14em] text-slate-500">
                {label}
                <span className="relative mt-2 block">
                  <input type="text" inputMode="numeric" value={value[field]} onChange={(event) => onChange({ ...value, [field]: Number(event.target.value.replace(/\D/g, "")) })} className={`${inputClass} pr-12 font-mono tabular-nums`} />
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[0.65rem] text-slate-600">BPS</span>
                </span>
              </label>
            ))}
          </div>
        </section>

        {error && (
          <div role="alert" className="flex gap-2.5 rounded-xl border border-rose-400/25 bg-rose-400/[0.07] px-3.5 py-3 text-xs leading-5 text-rose-200">
            <span aria-hidden="true" className="font-bold text-rose-400">!</span>
            <span>{error}</span>
          </div>
        )}

        <button
          type="button"
          onClick={onSubmit}
          disabled={submitting}
          aria-busy={submitting}
          className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-cyan-300/25 bg-cyan-400 px-5 py-3 text-sm font-extrabold tracking-wide text-slate-950 shadow-[0_14px_32px_-16px_rgba(34,211,238,0.9)] transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:border-slate-700 disabled:bg-slate-800 disabled:text-slate-500 disabled:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
        >
          {submitting && <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-950/25 border-t-slate-950" />}
          {submitting ? "Saving configuration…" : "Save split configuration"}
        </button>
      </div>
    </div>
  );
}
