import { expect, test, vi } from "vitest";
import { extractVersion } from "./chain";

test("extractVersion reads the version field as bigint", () => {
  const content = { dataType: "moveObject", fields: { version: "7" } };
  expect(extractVersion(content)).toBe(7n);
});
test("extractVersion throws on missing field (fail-loud)", () => {
  expect(() => extractVersion({ dataType: "moveObject", fields: {} })).toThrow();
});
