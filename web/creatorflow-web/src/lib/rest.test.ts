import { afterEach, expect, test, vi } from "vitest";
import { listConfigs, listSplits, listMutations, listEarnings, listWithdrawals } from "./rest";

afterEach(() => vi.restoreAllMocks());

test("listConfigs hits /configs?owner= and returns the envelope", async () => {
  const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ data: [{ configId: "0xabc" }], cursor: "c1" }), { status: 200 }),
  );
  const page = await listConfigs("0x" + "1".repeat(64));
  expect(page.cursor).toBe("c1");
  expect(page.data[0].configId).toBe("0xabc");
  expect(spy.mock.calls[0][0]).toContain("/configs?owner=0x");
});

test("non-2xx throws with the server error message", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ error: { code: "BAD_OWNER", message: "owner required" } }), { status: 400 }),
  );
  await expect(listConfigs("bad")).rejects.toThrow(/owner required/);
});

test("listSplits without cursor produces no trailing ?", async () => {
  const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ data: [], cursor: null }), { status: 200 }),
  );
  await listSplits("config1");
  const url = spy.mock.calls[0][0] as string;
  expect(url).toMatch(/\/splits$/);
  expect(url).not.toMatch(/\?$/);
});

test("listSplits with cursor includes ?cursor= encoded", async () => {
  const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ data: [], cursor: null }), { status: 200 }),
  );
  await listSplits("config1", "c1&c2");
  const url = spy.mock.calls[0][0] as string;
  expect(url).toContain("/splits?cursor=c1%26c2");
});

test("listMutations without cursor produces no trailing ?", async () => {
  const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ data: [], cursor: null }), { status: 200 }),
  );
  await listMutations("config1");
  const url = spy.mock.calls[0][0] as string;
  expect(url).toMatch(/\/mutations$/);
  expect(url).not.toMatch(/\?$/);
});

test("listEarnings without cursor produces no trailing ?", async () => {
  const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ data: [], cursor: null }), { status: 200 }),
  );
  await listEarnings("addr1");
  const url = spy.mock.calls[0][0] as string;
  expect(url).toMatch(/\/earnings$/);
  expect(url).not.toMatch(/\?$/);
});

test("listWithdrawals without cursor produces no trailing ?", async () => {
  const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ data: [], cursor: null }), { status: 200 }),
  );
  await listWithdrawals("vault1");
  const url = spy.mock.calls[0][0] as string;
  expect(url).toMatch(/\/withdrawals$/);
  expect(url).not.toMatch(/\?$/);
});

test("listConfigs with cursor includes ?cursor= and ?owner=", async () => {
  const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ data: [], cursor: null }), { status: 200 }),
  );
  await listConfigs("owner@example", "c1");
  const url = spy.mock.calls[0][0] as string;
  expect(url).toContain("?owner=owner%40example&cursor=c1");
});
