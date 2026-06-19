type VaultJson = { balance?: { value?: string } | string } | null | undefined;

export function extractVaultBalance(j: VaultJson): bigint {
  const b = j?.balance;
  if (b == null) return 0n;
  if (typeof b === "string") return BigInt(b);
  return BigInt(b.value ?? "0");
}
