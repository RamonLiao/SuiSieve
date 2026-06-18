import { describe, it, expect } from "vitest";
import { normalizeAddress, parseLimit, HttpError } from "../src/lib/validate.js";

describe("normalizeAddress", () => {
  it("lowercases a valid 0x address", () => {
    expect(normalizeAddress("0xABCdef01")).toBe("0xabcdef01");
  });
  it("rejects non-hex", () => {
    expect(() => normalizeAddress("nope")).toThrow(HttpError);
  });
  it("rejects empty", () => {
    expect(() => normalizeAddress("")).toThrow(HttpError);
  });
});

describe("parseLimit", () => {
  it("defaults to 50 when absent", () => {
    expect(parseLimit(undefined)).toBe(50);
  });
  it("clamps to max 200", () => {
    expect(parseLimit("500")).toBe(200);
  });
  it("rejects non-numeric", () => {
    expect(() => parseLimit("abc")).toThrow(HttpError);
  });
  it("rejects zero / negative", () => {
    expect(() => parseLimit("0")).toThrow(HttpError);
    expect(() => parseLimit("-3")).toThrow(HttpError);
  });
});
