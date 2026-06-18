import { describe, it, expect } from "vitest";
import { app } from "../src/app.js";
import { truncateAll, seedConfig, seedWithdrawal } from "./helpers/db.js";

describe("GET /vaults/:id/withdrawals", () => {
  it("returns withdrawals with resolved config_id via LEFT JOIN", async () => {
    await truncateAll();
    await seedConfig({
      configId: "0xc1",
      txDigest: "C",
      taxVaultId: "0xtax",
      savingsVaultId: "0xsav",
      owner: "0xo",
      ts: 1n,
    });
    await seedWithdrawal({
      txDigest: "W0",
      eventSeq: 0n,
      vaultId: "0xtax",
      kind: 0,
      amount: 300n,
      recipient: "0xo",
      ts: 100n,
    });
    const res = await app.request("/vaults/0xtax/withdrawals");
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].configId).toBe("0xc1");
    expect(body.data[0].amount).toBe("300");
  });

  it("withdrawal with no matching config -> configId null (LEFT JOIN)", async () => {
    await truncateAll();
    await seedWithdrawal({
      txDigest: "W0",
      eventSeq: 0n,
      vaultId: "0xorphan",
      kind: 1,
      amount: 50n,
      recipient: "0xo",
      ts: 100n,
    });
    const res = await app.request("/vaults/0xorphan/withdrawals");
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].configId).toBeNull();
  });
});
