import { expect, test } from "vitest";
import { buildExecuteSplit, buildCreateConfig, buildExecuteSplitWithYield, buildRedeemYield } from "./ptb";
import { PACKAGE_ID, MOCK_MARKET_ID } from "./constants";

test("execute_split targets router::execute_split with the right package", () => {
  const tx = buildExecuteSplit({
    configId: "0x" + "a".repeat(64),
    taxVaultId: "0x" + "b".repeat(64),
    savingsVaultId: "0x" + "c".repeat(64),
    amountIn: 1_000_000n,
    expectedVersion: 0n,
    usdcCoinIds: ["0x" + "d".repeat(64)],
  });
  const data = tx.getData();
  const calls = data.commands.filter((c) => c.$kind === "MoveCall");
  const target = calls.map(
    (c) =>
      `${c.MoveCall!.package}::${c.MoveCall!.module}::${c.MoveCall!.function}`,
  );
  expect(target).toContain(`${PACKAGE_ID}::router::execute_split`);

  const hasSplitCoins = data.commands.some((c) => c.$kind === "SplitCoins");
  expect(hasSplitCoins).toBe(true);
});

test("create_config assembles a makeMoveVec of recipients", () => {
  const tx = buildCreateConfig({
    recipients: [{ addr: "0x" + "1".repeat(64), bps: 10000, label: "me" }],
    taxBps: 0,
    savingsBps: 0,
    feeBps: 0,
    yieldBps: 0,
  });
  const data = tx.getData();
  const hasNewRecipient = data.commands.some(
    (c) => c.$kind === "MoveCall" && c.MoveCall!.function === "new_recipient",
  );
  expect(hasNewRecipient).toBe(true);
});

test("buildExecuteSplitWithYield targets the _with_yield entry and includes market+clock", () => {
  const tx = buildExecuteSplitWithYield({
    configId: "0x1", taxVaultId: "0x2", savingsVaultId: "0x3",
    amountIn: 1_000_000n, expectedVersion: 1n, usdcCoinIds: ["0xc1"],
  });
  const data = tx.getData();
  const calls = data.commands.filter((c) => c.$kind === "MoveCall");
  const targets = calls.map(
    (c) => `${c.MoveCall!.package}::${c.MoveCall!.module}::${c.MoveCall!.function}`,
  );
  expect(targets).toContain(`${PACKAGE_ID}::router::execute_split_with_yield`);
  // verify MOCK_MARKET_ID and CLOCK_ID appear as object inputs
  const objectIds = data.inputs
    .filter((i) => i.$kind === "UnresolvedObject")
    .map((i) => i.UnresolvedObject!.objectId);
  expect(objectIds).toContain(MOCK_MARKET_ID);
  expect(objectIds).toContain("0x0000000000000000000000000000000000000000000000000000000000000006"); // clock (SDK normalizes 0x6)
});

test("buildRedeemYield includes the mock market and clock", () => {
  const tx = buildRedeemYield({ savingsVaultId: "0x3", savingsCapId: "0x4", amount: 500n });
  const data = tx.getData();
  const calls = data.commands.filter((c) => c.$kind === "MoveCall");
  const targets = calls.map(
    (c) => `${c.MoveCall!.package}::${c.MoveCall!.module}::${c.MoveCall!.function}`,
  );
  expect(targets).toContain(`${PACKAGE_ID}::router::redeem_yield`);
  const objectIds = data.inputs
    .filter((i) => i.$kind === "UnresolvedObject")
    .map((i) => i.UnresolvedObject!.objectId);
  expect(objectIds).toContain(MOCK_MARKET_ID);
  expect(objectIds).toContain("0x0000000000000000000000000000000000000000000000000000000000000006"); // clock (SDK normalizes 0x6)
});
