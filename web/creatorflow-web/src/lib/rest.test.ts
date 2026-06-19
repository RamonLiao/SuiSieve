import { afterEach, expect, test, vi } from "vitest";
import { listConfigs } from "./rest";

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
