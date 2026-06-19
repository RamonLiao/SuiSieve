"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useCurrentAccount } from "@mysten/dapp-kit-react";
import Link from "next/link";
import { SplitForm } from "@/components/ui/SplitForm";
import { Toast } from "@/components/ui/Toast";
import { validateSplit, type SplitDraft } from "@/lib/bps";
import { useCreateConfig } from "@/hooks/useWrite";
import { listConfigs } from "@/lib/rest";
import { pollUntil } from "@/hooks/useWrite";

type ConfigRow = { configId: string };

const EMPTY_DRAFT: SplitDraft = {
  recipients: [],
  taxBps: 0,
  savingsBps: 0,
  feeBps: 0,
  yieldBps: 0,
};

export default function NewConfigPage() {
  const account = useCurrentAccount();
  const router = useRouter();
  const { run, pending } = useCreateConfig();

  const [draft, setDraft] = useState<SplitDraft>(EMPTY_DRAFT);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  function handleChange(d: SplitDraft) {
    setDraft(d);
    const result = validateSplit(d);
    setValidationError(result.ok ? null : result.error);
  }

  async function handleSubmit() {
    const result = validateSplit(draft);
    if (!result.ok) {
      setValidationError(result.error);
      return;
    }
    if (!account?.address) {
      setToastMsg("Wallet not connected.");
      return;
    }

    const outcome = await run(draft);
    if (!outcome.ok) {
      setToastMsg(outcome.error);
      return;
    }

    const address = account.address;
    // Poll until the new config appears in the index
    const page = await pollUntil(
      () => listConfigs(address),
      (p) => (p.data as ConfigRow[]).length > 0,
      { baseMs: 800, capMs: 5000, maxMs: 30_000 },
    );

    const rows = page.data as ConfigRow[];
    if (rows.length > 0) {
      router.push(`/config/${rows[0].configId}`);
    } else {
      router.push("/dashboard");
    }
  }

  if (!account?.address) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-slate-950 px-4">
        <p className="text-lg font-semibold text-slate-300">Connect your wallet to create a config.</p>
        <Link
          href="/"
          className="rounded-xl border border-cyan-400/30 bg-cyan-400/10 px-5 py-2.5 text-sm font-bold text-cyan-300 transition hover:bg-cyan-400/20"
        >
          Go to home to connect
        </Link>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-10">
      <div className="mx-auto max-w-2xl">
        <div className="mb-6 flex items-center gap-3">
          <Link
            href="/dashboard"
            className="text-sm text-slate-500 hover:text-slate-300 transition"
          >
            ← Dashboard
          </Link>
          <span className="text-slate-700">/</span>
          <span className="text-sm text-slate-400">New config</span>
        </div>

        {toastMsg && (
          <div className="mb-6">
            <Toast kind="error" message={toastMsg} />
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
