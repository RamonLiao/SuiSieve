import { describe, it, expect } from "vitest";
import { bigintToString, serializeRow } from "../src/lib/serialize.js";

describe("bigintToString", () => {
  it("converts bigint to decimal string", () => {
    expect(bigintToString(0n)).toBe("0");
    expect(bigintToString(18446744073709551615n)).toBe("18446744073709551615"); // u64 max
  });
  it("passes through null", () => {
    expect(bigintToString(null)).toBeNull();
  });
});

describe("serializeRow", () => {
  it("stringifies only bigint fields, leaves others", () => {
    const row = { configId: "0xabc", amount: 100n, kind: 1, owner: null };
    expect(serializeRow(row)).toEqual({ configId: "0xabc", amount: "100", kind: 1, owner: null });
  });
});
