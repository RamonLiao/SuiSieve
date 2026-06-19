import { expect, test } from "vitest";
import { PACKAGE_ID, USDC_TYPE, BPS_TOTAL } from "./constants";

test("package id is a 0x 32-byte hex", () => {
  expect(PACKAGE_ID).toMatch(/^0x[0-9a-f]{64}$/);
});
test("usdc type is fully-qualified", () => {
  expect(USDC_TYPE).toMatch(/^0x[0-9a-f]{64}::usdc::USDC$/);
});
test("bps total is 10000", () => {
  expect(BPS_TOTAL).toBe(10_000);
});
