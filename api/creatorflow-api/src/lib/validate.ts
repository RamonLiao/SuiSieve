import { decodeCursor, type CursorPart } from "./cursor.js";

// Part-type template: "i" = bigint, "s" = string. Used to validate a decoded
// cursor's shape so a tampered cursor (wrong arity OR wrong part types) is a
// 400, never a DB 500 from binding a string into a bigint comparison.
export type CursorShape = ("i" | "s")[];

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

// Decode a keyset cursor and validate it matches the expected part-type shape.
// Any malformed/tampered cursor (bad encoding, wrong arity, wrong part types)
// maps to a 400 — never reaches the DB as a mistyped comparison.
export function decodeCursorOr400(cursor: string, shape: CursorShape): CursorPart[] {
  let parts: CursorPart[];
  try {
    parts = decodeCursor(cursor, shape.length);
  } catch {
    throw new HttpError(400, "BAD_CURSOR", "invalid cursor");
  }
  for (let i = 0; i < shape.length; i++) {
    const wantBigint = shape[i] === "i";
    if (wantBigint !== (typeof parts[i] === "bigint")) {
      throw new HttpError(400, "BAD_CURSOR", "invalid cursor");
    }
  }
  return parts;
}

const ADDR_RE = /^0x[0-9a-f]{1,64}$/;

export function normalizeAddress(input: string): string {
  const lower = (input ?? "").toLowerCase();
  if (!ADDR_RE.test(lower)) {
    throw new HttpError(400, "BAD_ADDRESS", "address must be 0x-prefixed hex");
  }
  return lower;
}

export function parseLimit(input: string | undefined): number {
  if (input === undefined) return 50;
  if (!/^\d+$/.test(input)) {
    throw new HttpError(400, "BAD_LIMIT", "limit must be a positive integer");
  }
  const n = Number(input);
  if (n < 1) throw new HttpError(400, "BAD_LIMIT", "limit must be >= 1");
  return Math.min(n, 200);
}
