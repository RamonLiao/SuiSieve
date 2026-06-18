import { describe, it, expect } from "vitest";
import { app } from "../src/app.js";
import { truncateAll, seedSplit, seedPayout } from "./helpers/db.js";

describe("GET /collaborators/:addr/earnings", () => {
  it("aggregates a collaborator across multiple configs with split context", async () => {
    await truncateAll();
    await seedSplit({
      txDigest: "SA",
      eventSeq: 0n,
      configId: "0xca",
      configVersion: 1n,
      amountIn: 1000n,
      taxAmount: 0n,
      savingsAmount: 0n,
      protocolFeeAmount: 0n,
      yieldAmount: 0n,
      yieldIncluded: false,
      timestampMs: 100n,
      checkpoint: 1n,
    });
    await seedPayout({
      txDigest: "SA",
      eventSeq: 0n,
      payoutIdx: 0,
      recipient: "0xabc1",
      amount: 500n,
      bps: 5000,
    });
    await seedSplit({
      txDigest: "SB",
      eventSeq: 0n,
      configId: "0xcb",
      configVersion: 1n,
      amountIn: 2000n,
      taxAmount: 0n,
      savingsAmount: 0n,
      protocolFeeAmount: 0n,
      yieldAmount: 0n,
      yieldIncluded: false,
      timestampMs: 200n,
      checkpoint: 1n,
    });
    await seedPayout({
      txDigest: "SB",
      eventSeq: 0n,
      payoutIdx: 0,
      recipient: "0xabc1",
      amount: 800n,
      bps: 4000,
    });

    const res = await app.request("/collaborators/0xABC1/earnings");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.data[0].configId).toBe("0xcb"); // newest first
    expect(body.data[0].amount).toBe("800");
    expect(body.data[0].timestampMs).toBe("200");
    expect(body.data[1].configId).toBe("0xca");
  });

  it("rejects bad address with 400", async () => {
    const res = await app.request("/collaborators/notanaddr/earnings");
    expect(res.status).toBe(400);
  });
});
