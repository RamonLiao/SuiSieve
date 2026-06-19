"use client";

import type { SplitDraft } from "@/lib/bps";

export interface SplitFormProps {
  value: SplitDraft;
  onChange: (d: SplitDraft) => void;
  error: string | null;
  onSubmit: () => void;
  submitting: boolean;
}

function BpsField({
  label,
  fieldKey,
  value,
  onChange,
}: {
  label: string;
  fieldKey: "taxBps" | "savingsBps" | "feeBps" | "yieldBps";
  value: SplitDraft;
  onChange: (d: SplitDraft) => void;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-zinc-400 mb-1">{label}</label>
      <div className="relative">
        <input
          type="number"
          min={0}
          max={10000}
          value={value[fieldKey]}
          onChange={(e) =>
            onChange({ ...value, [fieldKey]: Number(e.target.value) })
          }
          className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 pr-14 text-sm text-zinc-100 placeholder-zinc-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        />
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-zinc-500">
          bps
        </span>
      </div>
    </div>
  );
}

export function SplitForm({ value, onChange, error, onSubmit, submitting }: SplitFormProps) {
  const addRecipient = () =>
    onChange({
      ...value,
      recipients: [...value.recipients, { addr: "", bps: 0, label: "" }],
    });

  const removeRecipient = (idx: number) =>
    onChange({
      ...value,
      recipients: value.recipients.filter((_, i) => i !== idx),
    });

  const updateRecipient = (
    idx: number,
    field: "addr" | "bps" | "label",
    val: string | number
  ) => {
    const next = value.recipients.map((r, i) =>
      i === idx ? { ...r, [field]: val } : r
    );
    onChange({ ...value, recipients: next });
  };

  return (
    <div className="space-y-6">
      {/* Recipients */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-zinc-200">Recipients</h3>
          <button
            type="button"
            onClick={addRecipient}
            className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
          >
            + Add
          </button>
        </div>
        <div className="space-y-3">
          {value.recipients.map((r, i) => (
            <div key={i} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 space-y-2">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  placeholder="0x… address"
                  value={r.addr}
                  onChange={(e) => updateRecipient(i, "addr", e.target.value)}
                  className="flex-1 min-w-0 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 font-mono text-xs text-zinc-100 placeholder-zinc-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
                <button
                  type="button"
                  onClick={() => removeRecipient(i)}
                  className="text-zinc-600 hover:text-red-400 text-xs transition-colors"
                >
                  ✕
                </button>
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Label"
                  value={r.label}
                  onChange={(e) => updateRecipient(i, "label", e.target.value)}
                  className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-100 placeholder-zinc-600 focus:border-indigo-500 focus:outline-none"
                />
                <div className="relative w-28">
                  <input
                    type="number"
                    min={0}
                    max={10000}
                    placeholder="0"
                    value={r.bps}
                    onChange={(e) => updateRecipient(i, "bps", Number(e.target.value))}
                    className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 pr-10 text-xs text-zinc-100 focus:border-indigo-500 focus:outline-none"
                  />
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-zinc-600">bps</span>
                </div>
              </div>
            </div>
          ))}
          {value.recipients.length === 0 && (
            <p className="text-xs text-zinc-600 text-center py-3">No recipients yet</p>
          )}
        </div>
      </section>

      {/* BPS Fields */}
      <section>
        <h3 className="text-sm font-semibold text-zinc-200 mb-3">Allocation (bps)</h3>
        <div className="grid grid-cols-2 gap-3">
          <BpsField label="Tax" fieldKey="taxBps" value={value} onChange={onChange} />
          <BpsField label="Savings" fieldKey="savingsBps" value={value} onChange={onChange} />
          <BpsField label="Fee" fieldKey="feeBps" value={value} onChange={onChange} />
          <BpsField label="Yield" fieldKey="yieldBps" value={value} onChange={onChange} />
        </div>
      </section>

      {/* Error */}
      {error && (
        <p className="rounded-lg border border-red-800 bg-red-950/40 px-3 py-2 text-xs text-red-400">
          {error}
        </p>
      )}

      {/* Submit */}
      <button
        type="button"
        onClick={onSubmit}
        disabled={submitting}
        className="w-full rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white transition-all hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
      >
        {submitting ? (
          <span className="flex items-center justify-center gap-2">
            <span className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
            Submitting…
          </span>
        ) : (
          "Save Split Config"
        )}
      </button>
    </div>
  );
}
