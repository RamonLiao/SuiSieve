"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useCurrentAccount } from "@mysten/dapp-kit-react";
import { ConnectButton } from "@mysten/dapp-kit-react/ui";

export default function Home() {
  const account = useCurrentAccount();
  const router = useRouter();

  useEffect(() => {
    if (account) {
      router.push("/dashboard");
    }
  }, [account, router]);

  return (
    <div className="flex flex-col flex-1 items-center justify-center min-h-screen bg-zinc-50 dark:bg-black">
      <main className="flex flex-col items-center gap-8 p-16">
        <h1 className="text-3xl font-semibold tracking-tight text-black dark:text-zinc-50">
          CreatorFlow
        </h1>
        <p className="text-zinc-600 dark:text-zinc-400">
          Connect your wallet to get started
        </p>
        <ConnectButton />
      </main>
    </div>
  );
}
