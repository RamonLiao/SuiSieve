import { expect, test } from "vitest";
import { percentile, classify, conserves } from "./t10-lib";

test("percentile nearest-rank p50/p90/p99", () => {
  const xs = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100 sorted
  expect(percentile(xs, 50)).toBe(50);
  expect(percentile(xs, 90)).toBe(90);
  expect(percentile(xs, 99)).toBe(99);
  expect(percentile(xs, 100)).toBe(100);
});
test("percentile empty -> NaN", () => {
  expect(Number.isNaN(percentile([], 50))).toBe(true);
});
test("classify buckets the T10 congestion ceiling distinctly", () => {
  expect(classify({ ok: true })).toBe("success");
  expect(classify({ ok: false, error: "ExecutionCancelledDueToSharedObjectCongestion" })).toBe("congestion");
  expect(classify({ ok: false, error: "Object 0x.. is not available for consumption, locked" })).toBe("locked");
  expect(classify({ ok: false, error: "MoveAbort .. EConfigChanged" })).toBe("terminal");
  expect(classify({ ok: false, error: "fetch failed ECONNRESET" })).toBe("network");
});
test("conserves: payout+tax+savings+fee == amountIn (zero dust)", () => {
  expect(conserves({ payouts: [897000n], tax: 50000n, savings: 50000n, fee: 3000n }, 1000000n)).toBe(true);
  expect(conserves({ payouts: [897000n], tax: 50000n, savings: 50000n, fee: 2999n }, 1000000n)).toBe(false);
});
