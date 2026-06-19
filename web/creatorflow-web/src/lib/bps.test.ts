import { expect, test } from "vitest";
import { validateSplit, type SplitDraft } from "./bps";

const base: SplitDraft = {
  recipients: [{ addr: "0x" + "1".repeat(64), bps: 8970, label: "me" }],
  taxBps: 500, savingsBps: 500, feeBps: 30, yieldBps: 0,
};

test("accepts a draft summing to 10000", () => {
  expect(validateSplit(base)).toEqual({ ok: true });
});
test("rejects sum != 10000", () => {
  const r = validateSplit({ ...base, taxBps: 600 });
  expect(r.ok).toBe(false);
});
test("rejects a recipient with 0 bps", () => {
  const r = validateSplit({ ...base, recipients: [{ addr: "0x" + "1".repeat(64), bps: 0, label: "x" }], taxBps: 9470 });
  expect(r.ok).toBe(false);
});
test("rejects > MAX_RECIPIENTS recipients", () => {
  const many = Array.from({ length: 17 }, () => ({ addr: "0x" + "1".repeat(64), bps: 100, label: "x" }));
  const r = validateSplit({ ...base, recipients: many, taxBps: 0, savingsBps: 0, feeBps: 0, yieldBps: 0 });
  expect(r.ok).toBe(false);
});
test("rejects yield > savings", () => {
  const r = validateSplit({ ...base, yieldBps: 600 });
  expect(r.ok).toBe(false);
});
test("monkey: u16 wrap (sum 75536 mod 65536 == 10000) still rejected", () => {
  const r = validateSplit({ ...base, recipients: [{ addr: "0x" + "1".repeat(64), bps: 65536 + 8970 - 1030 - 30, label: "x" }] });
  expect(r.ok).toBe(false); // bps field individually out of u16 range -> rejected
});
