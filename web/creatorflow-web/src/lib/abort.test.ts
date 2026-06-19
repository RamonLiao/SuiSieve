import { expect, test } from "vitest";
import { mapAbort } from "./abort";

test("maps EConfigChanged abort", () => {
  // Move aborts surface as: "...MoveAbort(... router) , 1) ..." or named in newer effects.
  expect(mapAbort("MoveAbort(... ::router::execute_split, EConfigChanged)")).toMatch(/refresh/i);
});
test("maps zero payment", () => {
  expect(mapAbort("... EZeroPayment ...")).toMatch(/greater than 0|> 0/i);
});
test("maps vault mismatch", () => {
  expect(mapAbort("EVaultMismatch")).toMatch(/mismatch/i);
});
test("unknown error passes through trimmed", () => {
  expect(mapAbort("some network error")).toBe("some network error");
});
test("null -> generic", () => {
  expect(mapAbort(null)).toMatch(/failed/i);
});
