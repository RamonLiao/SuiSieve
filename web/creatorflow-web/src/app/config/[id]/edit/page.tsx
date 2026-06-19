"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { useCurrentAccount } from "@mysten/dapp-kit-react";
import Link from "next/link";
import { SplitForm } from "@/components/ui/SplitForm";
import { Toast } from "@/components/ui/Toast";
import { validateSplit, type SplitDraft } from "@/lib/bps";
import { useMutateConfig } from "@/hooks/useWrite";
import { getClient, getConfigVersion } from "@/lib/chain";

type RecipientJson = { addr: string; bps: string; label: string };
type ConfigJson = {
  version: string;
  recipients: RecipientJson[];
  tax_bps: string;
  savings_bps: string;
  protocol_fee_bps: string;
  yield_bps: string;
};

async function fetchConfigDraft(configId: string): Promise<SplitDraft> {
  const client = getClient();
  const { object } = await client.getObject({ objectId: configId, include: { json: true } });
  const cfg = object?.json as ConfigJson | null | undefined;
  if (!cfg) throw new Error("Config object not found on chain.");
  return {
    recipients: cfg.recipients.map((r) => ({
      addr: r.addr,
      bps: Number(r.bps),
      label: r.label ?? "",
    })),
    taxBps: Number(cfg.tax_bps),
    savingsBps: Number(cfg.savings_bps),
    feeBps: Number(cfg.protocol_fee_bps),
    yieldBps: Number(cfg.yield_bps),
  };
}

export default function EditConfigPage() {
  const { id } = useParams<{ id: string }>();
  const account = useCurrentAccount();
  const router = useRouter();
  const { run, pending } = useMutateConfig({ configId: id });

  const [draft, setDraft] = useState<SplitDraft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "error" | "success"; message: string } | null>(null);

  useEffect(() => {
    if (!id) return;
    fetchConfigDraft(id)
      .then(setDraft)
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, [id]);

  function handleChange(d: SplitDraft) {
    setDraft(d);
    const result = validateSplit(d);
    setValidationError(result.ok ? null : result.error);
  }

  async function handleSubmit() {
    if (!draft) return;
    const result = validateSplit(draft);
    if (!result.ok) {
      setValidationError(result.error);
      return;
    }
    if (!account?.address) {
      setToast({ kind: "error", message: "Wallet not connected." });
      return;
    }

    const outcome = await run({
      recipients: draft.recipients,
      taxBps: draft.taxBps,
      savingsBps: draft.savingsBps,
    });

    if (!outcome.ok) {
      setToast({ kind: "error", message: outcome.error });
      return;
    }

    // Confirm version bump: re-read config version from chain
    try {
      const newVersion = await getConfigVersion(id);
      setToast({
        kind: "success",
        message: `Config updated. New version: ${newVersion.toString()}. Tx: ${outcome.digest}`,
      });
      setTimeout(() => router.push(`/config/${id}`), 2000);
    } catch {
      setToast({ kind: "success", message: `Config updated. Tx: ${outcome.digest}` });
      setTimeout(() => router.push(`/config/${id}`), 2000);
    }
  }

  if (!account?.address) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-slate-950 px-4">
        <p className="text-lg font-semibold text-slate-300">Connect your wallet to edit this config.</p>
        <Link
          href="/"
          className="rounded-xl border border-cyan-400/30 bg-cyan-400/10 px-5 py-2.5 text-sm font-bold text-cyan-300 transition hover:bg-cyan-400/20"
        >
          Go to home to connect
        </Link>
      </main>
    );
  }

  if (loadError) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-slate-950 px-4">
        <div role="alert" className="rounded-xl border border-rose-400/25 bg-rose-400/[0.07] px-4 py-3 text-sm text-rose-200 max-w-md text-center">
          Failed to load config: {loadError}
        </div>
        <Link href="/dashboard" className="text-sm text-slate-500 hover:text-slate-300 transition">
          ← Back to dashboard
        </Link>
      </main>
    );
  }

  if (!draft) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950">
        <div className="h-10 w-10 animate-spin rounded-full border-2 border-slate-800 border-t-cyan-400" />
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-10">
      <div className="mx-auto max-w-2xl">
        <div className="mb-6 flex items-center gap-3">
          <Link
            href={`/config/${id}`}
            className="text-sm text-slate-500 hover:text-slate-300 transition"
          >
            ← Config
          </Link>
          <span className="text-slate-700">/</span>
          <span className="text-sm text-slate-400">Edit</span>
        </div>

        <div className="mb-4 rounded-xl border border-slate-800 bg-slate-900/50 px-4 py-3">
          <p className="text-[0.65rem] font-bold uppercase tracking-[0.18em] text-slate-500">Editing config</p>
          <p className="mt-0.5 font-mono text-xs text-slate-400 break-all">{id}</p>
        </div>

        {toast && (
          <div className="mb-6">
            <Toast kind={toast.kind} message={toast.message} />
          </div>
        )}

        <SplitForm
          value={draft}
          onChange={handleChange}
          error={validationError}
          onSubmit={handleSubmit}
          submitting={pending}
        />
      </div>
    </main>
  );
}
