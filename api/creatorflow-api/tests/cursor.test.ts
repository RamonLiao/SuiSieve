import { describe, it, expect } from "vitest";
import { encodeCursor, decodeCursor } from "../src/lib/cursor.js";

describe("cursor", () => {
  it("round-trips a 3-tuple event cursor", () => {
    const c = encodeCursor([1718000000000n, "AbC123", 2n]);
    expect(decodeCursor(c, 3)).toEqual([1718000000000n, "AbC123", 2n]);
  });
  it("round-trips a 2-tuple config cursor", () => {
    const c = encodeCursor([1718000000000n, "0xdead"]);
    expect(decodeCursor(c, 2)).toEqual([1718000000000n, "0xdead"]);
  });
  it("throws on wrong arity", () => {
    const c = encodeCursor([1n, "x", 2n]);
    expect(() => decodeCursor(c, 2)).toThrow();
  });
  it("throws on malformed base64", () => {
    expect(() => decodeCursor("!!!not-base64!!!", 3)).toThrow();
  });
});
