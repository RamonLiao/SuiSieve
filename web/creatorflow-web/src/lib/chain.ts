import { SuiGrpcClient } from "@mysten/sui/grpc";
import { NETWORK, PACKAGE_ID, USDC_TYPE } from "./constants";

let client: SuiGrpcClient | null = null;
export function getClient(): SuiGrpcClient {
  if (!client)
    client = new SuiGrpcClient({
      network: NETWORK,
      // baseUrl is required by GrpcWebOptions; Sui testnet gRPC-web endpoint
      baseUrl: "https://rpc.testnet.sui.io",
    });
  return client;
}

/**
 * Pure helper — extracts the `version` field from a Move object's content.
 * Accepts the brief's expected shape { fields: { version: string } } which
 * mirrors the JSON representation returned by `include: { json: true }`.
 */
export function extractVersion(content: unknown): bigint {
  const fields = (content as { fields?: Record<string, unknown> })?.fields;
  const v = fields?.version;
  if (v === undefined || v === null) throw new Error("config object missing `version` field");
  return BigInt(v as string);
}

/**
 * Reads the `version` field from the on-chain config object.
 *
 * API note: gRPC 2.19 uses `getObject({ objectId, include: { json: true } })`
 * and returns `{ object: { json: Record<string,unknown> | null } }`.
 * The `json` field maps to the Move struct's fields as-is.
 */
export async function getConfigVersion(configId: string): Promise<bigint> {
  const { object } = await getClient().getObject({
    objectId: configId,
    include: { json: true },
  });
  if (!object) throw new Error(`config object not found: ${configId}`);
  // json contains the Move struct fields at top level
  return extractVersion({ fields: object.json ?? {} });
}

/**
 * Returns coin object IDs for the USDC coin type owned by `owner`.
 *
 * API note: gRPC 2.19 uses `listCoins({ owner, coinType })` returning
 * `{ objects: Coin[] }` where each `Coin` has `objectId` (not `coinObjectId`).
 */
export async function getUsdcCoinIds(owner: string): Promise<string[]> {
  const { objects } = await getClient().listCoins({ owner, coinType: USDC_TYPE });
  return objects.map((c) => c.objectId);
}

/**
 * Finds the first owned cap object of the given kind for `owner`.
 *
 * API note: gRPC 2.19 uses `listOwnedObjects({ owner, type })` with a `type`
 * filter, returning `{ objects: Object[] }` where each has `objectId` and `type`.
 */
export async function getOwnerCapId(
  owner: string,
  capKind: "OwnerCap" | "TaxCap" | "SavingsCap",
): Promise<string | null> {
  const type = `${PACKAGE_ID}::capabilities::${capKind}`;
  const { objects } = await getClient().listOwnedObjects({ owner, type });
  return objects[0]?.objectId ?? null;
}
