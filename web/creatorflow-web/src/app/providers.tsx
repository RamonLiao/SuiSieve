"use client";
import dynamic from "next/dynamic";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Lazy-import dapp-kit-react to avoid SSR window/document access at module eval
const DAppKitProviderDynamic = dynamic(
  () =>
    Promise.all([
      import("@mysten/dapp-kit-react").then((m) => m.DAppKitProvider),
      import("@/dapp-kit").then((m) => m.dAppKit),
    ]).then(([DAppKitProvider, dAppKit]) => {
      function Wrapper({ children }: { children: React.ReactNode }) {
        return (
          <DAppKitProvider dAppKit={dAppKit}>{children}</DAppKitProvider>
        );
      }
      return Wrapper;
    }),
  { ssr: false }
);

const qc = new QueryClient();

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={qc}>
      <DAppKitProviderDynamic>{children}</DAppKitProviderDynamic>
    </QueryClientProvider>
  );
}
