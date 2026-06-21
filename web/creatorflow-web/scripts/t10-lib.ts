export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return NaN;
  // nearest-rank: rank = ceil(p/100 * N), clamped to [1, N]
  const rank = Math.min(sortedAsc.length, Math.max(1, Math.ceil((p / 100) * sortedAsc.length)));
  return sortedAsc[rank - 1];
}

export type Bucket = "success" | "congestion" | "locked" | "terminal" | "ratelimited" | "network";

export function classify(r: { ok: true } | { ok: false; error: string }): Bucket {
  if (r.ok) return "success";
  const e = r.error;
  if (/congest/i.test(e)) return "congestion";
  // owned-object version conflict / equivocation: validators report it as either
  // "not available" or "unavailable" for consumption depending on the path.
  if (/lock|equivocat|(?:not |un)available for consumption/i.test(e)) return "locked";
  // public-RPC throttle (HTTP 429) — a client/infra ceiling, NOT a contract abort.
  if (/too many requests|429|rate.?limit|resource_exhausted/i.test(e)) return "ratelimited";
  // network must precede the generic terminal fallback: "fetch failed ECONNRESET"
  // contains no abort/status token, so it would otherwise fall through to terminal.
  if (/fetch|econn|timeout|network|socket/i.test(e)) return "network";
  if (/moveabort|abort|^e[A-Z]|status/i.test(e)) return "terminal";
  return "terminal";
}

export function conserves(
  parts: { payouts: bigint[]; tax: bigint; savings: bigint; fee: bigint },
  amountIn: bigint,
): boolean {
  const sum = parts.payouts.reduce((a, b) => a + b, 0n) + parts.tax + parts.savings + parts.fee;
  return sum === amountIn;
}
