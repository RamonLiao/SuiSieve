import { expect, test } from "vitest";
import { signResultToOutcome, pollUntil } from "./useWrite";

// The REAL sign result shape from @mysten/sui SuiClientTypes.TransactionResult:
//   Success: { $kind: 'Transaction', Transaction: { digest: string, status: { success: true, error: null }, ... } }
//   Failure: { $kind: 'FailedTransaction', FailedTransaction: { digest: string, status: { success: false, error: { message: string, ... } }, ... } }
//
// signResultToOutcome maps failure via mapAbort(result.FailedTransaction.status.error.message)
// and success to { ok: true, digest: result.Transaction.digest }

test("signResultToOutcome maps FailedTransaction via mapAbort", () => {
  const r = {
    $kind: "FailedTransaction" as const,
    FailedTransaction: {
      digest: "xyz",
      status: { success: false as const, error: { message: "EConfigChanged: version mismatch" } },
    },
  } as any;
  const o = signResultToOutcome(r);
  expect(o).toEqual({ ok: false, error: expect.stringMatching(/refresh/i) });
});

test("signResultToOutcome maps success to digest", () => {
  const r = {
    $kind: "Transaction" as const,
    Transaction: { digest: "abc", status: { success: true as const, error: null } },
  } as any;
  expect(signResultToOutcome(r)).toEqual({ ok: true, digest: "abc" });
});

test("signResultToOutcome returns unknown error for unexpected shape", () => {
  const o = signResultToOutcome({} as any);
  expect(o).toEqual({ ok: false, error: expect.any(String) });
});

test("pollUntil resolves when predicate passes", async () => {
  let n = 0;
  const out = await pollUntil(async () => ++n, (v) => v >= 3, { baseMs: 1, capMs: 5, maxMs: 1000 });
  expect(out).toBe(3);
});

test("pollUntil returns last value on timeout", async () => {
  const out = await pollUntil(async () => 0, () => false, { baseMs: 1, capMs: 5, maxMs: 10 });
  expect(out).toBe(0);
});
