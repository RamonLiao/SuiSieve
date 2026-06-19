import { createDAppKit } from "@mysten/dapp-kit-core";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { NETWORK } from "./lib/constants";

export const dAppKit = createDAppKit({
  networks: [NETWORK] as const,
  defaultNetwork: NETWORK,
  createClient: (network) =>
    new SuiJsonRpcClient({
      url: getJsonRpcFullnodeUrl(network as "mainnet" | "testnet" | "devnet" | "localnet"),
      network,
    }),
});
