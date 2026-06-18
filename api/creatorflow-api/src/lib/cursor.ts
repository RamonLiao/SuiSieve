export type CursorPart = bigint | string;

// Each part is tagged: "i:" for bigint (integer), "s:" for string.
export function encodeCursor(parts: CursorPart[]): string {
  const tagged = parts
    .map((p) => (typeof p === "bigint" ? `i:${p.toString()}` : `s:${p}`))
    .join("|");
  return Buffer.from(tagged, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string, arity: number): CursorPart[] {
  let raw: string;
  try {
    raw = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new Error("invalid cursor encoding");
  }
  const tagged = raw.split("|");
  if (tagged.length !== arity) {
    throw new Error(`cursor arity mismatch: expected ${arity}, got ${tagged.length}`);
  }
  return tagged.map((t) => {
    if (t.startsWith("i:")) return BigInt(t.slice(2));
    if (t.startsWith("s:")) return t.slice(2);
    throw new Error("invalid cursor part");
  });
}
