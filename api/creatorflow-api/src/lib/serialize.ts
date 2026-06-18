export function bigintToString(v: bigint | null): string | null {
  return v === null ? null : v.toString();
}

// Recursively stringify any bigint value in a plain object/array so u64 values
// survive JSON without precision loss. Non-bigint values pass through unchanged.
export function serializeRow<T>(row: T): unknown {
  if (typeof row === "bigint") return row.toString();
  if (row === null || typeof row !== "object") return row;
  if (Array.isArray(row)) return row.map(serializeRow);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
    out[k] = serializeRow(v);
  }
  return out;
}
