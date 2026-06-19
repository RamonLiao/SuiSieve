import { expect, test } from "vitest";
import { buildCreateConfig, buildExecuteSplit } from "./ptb";
import { validateSplit } from "./bps";
import type { SplitDraft, RecipientInput } from "./bps";

// Utility to create a valid address string
const validAddr = (index: number): string =>
  "0x" + index.toString().padStart(64, "0");

// Helper to create a minimal valid split with N recipients
function validSplitDraft(n: number): SplitDraft {
  const savingsBps = 2500;
  const feeBps = 500;
  const yieldBps = 500;
  const taxBps = 1500;
  const recipientBpsTotal = 10000 - (savingsBps + feeBps + taxBps); // 5500
  const bpsPerRecipient = Math.floor(recipientBpsTotal / n);
  const remainder = recipientBpsTotal - bpsPerRecipient * n;
  const recipients: RecipientInput[] = Array.from({ length: n }, (_, i) => ({
    addr: validAddr(i),
    bps: bpsPerRecipient + (i === 0 ? remainder : 0),
    label: `Recipient ${i}`,
  }));
  return {
    recipients,
    taxBps,
    savingsBps,
    feeBps,
    yieldBps,
  };
}

// ------ validateSplit boundary tests ------

test("validateSplit: rejects sum < 10000", () => {
  const draft: SplitDraft = {
    recipients: [{ addr: validAddr(0), bps: 5000, label: "R0" }],
    taxBps: 2000,
    savingsBps: 2000,
    feeBps: 500,
    yieldBps: 500,
    // Sum: 5000+2000+2000+500 = 9500 (missing 500)
  };
  const result = validateSplit(draft);
  expect(result.ok).toBe(false);
  expect((result as any).error).toMatch(/sum to 10000/);
});

test("validateSplit: rejects sum > 10000", () => {
  const draft: SplitDraft = {
    recipients: [{ addr: validAddr(0), bps: 5500, label: "R0" }],
    taxBps: 2500,
    savingsBps: 2000,
    feeBps: 500,
    yieldBps: 500,
    // Sum: 5500+2500+2000+500 = 10500 (too much)
  };
  const result = validateSplit(draft);
  expect(result.ok).toBe(false);
  expect((result as any).error).toMatch(/sum to 10000/);
});

test("validateSplit: rejects recipient with bps 0", () => {
  const draft: SplitDraft = {
    recipients: [
      { addr: validAddr(0), bps: 5000, label: "R0" },
      { addr: validAddr(1), bps: 0, label: "R1" }, // Invalid
    ],
    taxBps: 2500,
    savingsBps: 2000,
    feeBps: 500,
    yieldBps: 0,
    // Sum: 5000+2500+2000+500 = 10000 (sum is valid, but bps 0 should fail first)
  };
  const result = validateSplit(draft);
  expect(result.ok).toBe(false);
  expect((result as any).error).toMatch(/bps must be/);
});

test("validateSplit: rejects 17 recipients (max is 16)", () => {
  const recipients: RecipientInput[] = Array.from({ length: 17 }, (_, i) => ({
    addr: validAddr(i),
    bps: Math.floor(10000 / 17),
    label: `R${i}`,
  }));
  // Adjust first one to make sum = 10000 (with tax/savings/fee/yield = 0)
  recipients[0].bps = 10000 - 16 * Math.floor(10000 / 17);
  const draft: SplitDraft = {
    recipients,
    taxBps: 0,
    savingsBps: 0,
    feeBps: 0,
    yieldBps: 0,
  };
  const result = validateSplit(draft);
  expect(result.ok).toBe(false);
  expect((result as any).error).toMatch(/At most 16 recipients/);
});

test("validateSplit: rejects yield > savings", () => {
  const draft: SplitDraft = {
    recipients: [{ addr: validAddr(0), bps: 5000, label: "R0" }],
    taxBps: 2500,
    savingsBps: 1000, // yield > savings violates invariant
    feeBps: 500,
    yieldBps: 1500, // 1500 > 1000: invalid
  };
  const result = validateSplit(draft);
  expect(result.ok).toBe(false);
  expect((result as any).error).toMatch(/yield bps cannot exceed savings/);
});

test("validateSplit: accepts valid 16-recipient split", () => {
  const draft = validSplitDraft(16);
  const result = validateSplit(draft);
  expect(result.ok).toBe(true);
});

// ------ buildExecuteSplit boundary tests ------

test("buildExecuteSplit: builds with amountIn 0n without crashing", () => {
  // Contract will reject 0 via EZeroPayment, but the builder must not throw
  const tx = buildExecuteSplit({
    configId: validAddr(1),
    taxVaultId: validAddr(2),
    savingsVaultId: validAddr(3),
    amountIn: 0n,
    expectedVersion: 1n,
    usdcCoinIds: ["0x" + "d".repeat(64)], // Valid dummy coin ID
  });
  expect(tx).toBeDefined();
  // Verify the transaction has serializable data (no throw)
  const data = tx.getData?.();
  expect(data).toBeDefined();
});

test("buildExecuteSplit: builds with positive amountIn", () => {
  const tx = buildExecuteSplit({
    configId: validAddr(1),
    taxVaultId: validAddr(2),
    savingsVaultId: validAddr(3),
    amountIn: 1000000n, // 1 USDC (6 decimals)
    expectedVersion: 1n,
    usdcCoinIds: ["0x" + "a".repeat(64)],
  });
  expect(tx).toBeDefined();
  const data = tx.getData?.();
  expect(data).toBeDefined();
});

test("buildExecuteSplit: merges multiple coin inputs", () => {
  // Provide multiple coins; builder should merge them
  const tx = buildExecuteSplit({
    configId: validAddr(1),
    taxVaultId: validAddr(2),
    savingsVaultId: validAddr(3),
    amountIn: 500000n,
    expectedVersion: 1n,
    usdcCoinIds: [
      "0x" + "a".repeat(64),
      "0x" + "b".repeat(64),
      "0x" + "c".repeat(64),
    ],
  });
  expect(tx).toBeDefined();
  const data = tx.getData?.();
  expect(data).toBeDefined();
});

// ------ buildCreateConfig boundary tests ------

test("buildCreateConfig: builds with exactly 16 recipients", () => {
  const draft = validSplitDraft(16);
  const tx = buildCreateConfig({
    recipients: draft.recipients,
    taxBps: draft.taxBps,
    savingsBps: draft.savingsBps,
    feeBps: draft.feeBps,
    yieldBps: draft.yieldBps,
  });
  expect(tx).toBeDefined();
  // Verify the transaction has serializable data (no throw)
  const data = tx.getData?.();
  expect(data).toBeDefined();
});

test("buildCreateConfig: builds with 1 recipient", () => {
  const draft = validSplitDraft(1);
  const tx = buildCreateConfig({
    recipients: draft.recipients,
    taxBps: draft.taxBps,
    savingsBps: draft.savingsBps,
    feeBps: draft.feeBps,
    yieldBps: draft.yieldBps,
  });
  expect(tx).toBeDefined();
  const data = tx.getData?.();
  expect(data).toBeDefined();
});
