import { describe, it, expect } from "vitest";
import { app } from "../src/app.js";
import {
  truncateAll,
  seedConfig,
  seedMutation,
  seedSplit,
  seedPayout,
} from "./helpers/db.js";

describe("app skeleton", () => {
  it("GET /health returns ok", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("unknown route returns 404 in error shape", async () => {
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toHaveProperty("error.code");
  });
});

describe("GET /configs", () => {
  it("lists configs by owner, u64 ts as string, keyset paginates", async () => {
    await truncateAll();
    for (let i = 0; i < 3; i++) {
      await seedConfig({
        configId: `0xc${i}`,
        txDigest: `T${i}`,
        taxVaultId: `0xt${i}`,
        savingsVaultId: `0xs${i}`,
        owner: "0xabc1",
        ts: BigInt(1000 + i),
      });
    }
    const res = await app.request("/configs?owner=0xABC1&limit=2");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.data[0].configId).toBe("0xc2"); // newest first
    expect(typeof body.data[0].checkpointTimestampMs).toBe("string");
    expect(body.cursor).toBeTruthy();

    const res2 = await app.request(
      `/configs?owner=0xabc1&limit=2&cursor=${encodeURIComponent(body.cursor)}`,
    );
    const body2 = await res2.json();
    expect(body2.data).toHaveLength(1);
    expect(body2.data[0].configId).toBe("0xc0");
    expect(body2.cursor).toBeNull();
  });

  it("rejects missing owner with 400", async () => {
    const res = await app.request("/configs");
    expect(res.status).toBe(400);
  });
});

describe("GET /configs/:id", () => {
  it("returns detail with latest version, 404 when absent", async () => {
    await truncateAll();
    await seedConfig({
      configId: "0xc1",
      txDigest: "T1",
      taxVaultId: "0xt1",
      savingsVaultId: "0xs1",
      owner: "0xowner",
      ts: 1000n,
    });
    await seedMutation({
      txDigest: "M1",
      eventSeq: 0n,
      configId: "0xc1",
      oldVersion: 1n,
      newVersion: 2n,
      mutator: "0xowner",
      ts: 1100n,
    });
    await seedMutation({
      txDigest: "M2",
      eventSeq: 0n,
      configId: "0xc1",
      oldVersion: 2n,
      newVersion: 3n,
      mutator: "0xowner",
      ts: 1200n,
    });

    const res = await app.request("/configs/0xc1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.configId).toBe("0xc1");
    expect(body.latestVersion).toBe("3");

    const miss = await app.request("/configs/0xnope");
    expect(miss.status).toBe(404);
  });
});

describe("GET /configs/:id/splits", () => {
  it("returns splits newest-first with embedded payouts, keyset paginates", async () => {
    await truncateAll();
    await seedConfig({
      configId: "0xc1",
      txDigest: "C",
      taxVaultId: "0xt",
      savingsVaultId: "0xs",
      owner: "0xo",
      ts: 1n,
    });
    for (let i = 0; i < 3; i++) {
      await seedSplit({
        txDigest: `S${i}`,
        eventSeq: 0n,
        configId: "0xc1",
        configVersion: 1n,
        amountIn: 1000n,
        taxAmount: 100n,
        savingsAmount: 200n,
        protocolFeeAmount: 10n,
        yieldAmount: 0n,
        yieldIncluded: false,
        timestampMs: BigInt(500 + i),
        checkpoint: 1n,
      });
      await seedPayout({
        txDigest: `S${i}`,
        eventSeq: 0n,
        payoutIdx: 0,
        recipient: "0xr1",
        amount: 690n,
        bps: 6900,
      });
    }
    const res = await app.request("/configs/0xc1/splits?limit=2");
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.data[0].txDigest).toBe("S2");
    expect(body.data[0].amountIn).toBe("1000");
    expect(body.data[0].payouts).toHaveLength(1);
    expect(body.data[0].payouts[0].amount).toBe("690");
    expect(body.cursor).toBeTruthy();

    const res2 = await app.request(
      `/configs/0xc1/splits?limit=2&cursor=${encodeURIComponent(body.cursor)}`,
    );
    const body2 = await res2.json();
    expect(body2.data).toHaveLength(1);
    expect(body2.data[0].txDigest).toBe("S0");
    expect(body2.cursor).toBeNull();
  });

  it("empty payouts -> payouts: []", async () => {
    await truncateAll();
    await seedSplit({
      txDigest: "S0",
      eventSeq: 0n,
      configId: "0xc1",
      configVersion: 1n,
      amountIn: 0n,
      taxAmount: 0n,
      savingsAmount: 0n,
      protocolFeeAmount: 0n,
      yieldAmount: 0n,
      yieldIncluded: false,
      timestampMs: 1n,
      checkpoint: 1n,
    });
    const res = await app.request("/configs/0xc1/splits");
    const body = await res.json();
    expect(body.data[0].payouts).toEqual([]);
    expect(body.data[0].amountIn).toBe("0");
  });
});

describe("GET /configs/:id/mutations", () => {
  it("lists mutation history newest-first, versions as strings", async () => {
    await truncateAll();
    await seedMutation({
      txDigest: "M0",
      eventSeq: 0n,
      configId: "0xc1",
      oldVersion: 1n,
      newVersion: 2n,
      mutator: "0xo",
      ts: 100n,
    });
    await seedMutation({
      txDigest: "M1",
      eventSeq: 0n,
      configId: "0xc1",
      oldVersion: 2n,
      newVersion: 3n,
      mutator: "0xo",
      ts: 200n,
    });
    const res = await app.request("/configs/0xc1/mutations");
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.data[0].newVersion).toBe("3");
    expect(body.cursor).toBeNull();
  });
});

describe("GET /configs/:id/summary", () => {
  it("aggregates revenue and count, strings for sums", async () => {
    await truncateAll();
    for (let i = 0; i < 2; i++) {
      await seedSplit({
        txDigest: `S${i}`,
        eventSeq: 0n,
        configId: "0xc1",
        configVersion: 1n,
        amountIn: 1000n,
        taxAmount: 100n,
        savingsAmount: 200n,
        protocolFeeAmount: 10n,
        yieldAmount: 5n,
        yieldIncluded: true,
        timestampMs: BigInt(i),
        checkpoint: 1n,
      });
    }
    const res = await app.request("/configs/0xc1/summary");
    const body = await res.json();
    expect(body.count).toBe(2);
    expect(body.totalAmountIn).toBe("2000");
    expect(body.totalTax).toBe("200");
    expect(body.totalSavings).toBe("400");
    expect(body.totalProtocolFee).toBe("20");
    expect(body.totalYield).toBe("10");
  });

  it("empty config -> zeros", async () => {
    await truncateAll();
    const res = await app.request("/configs/0xempty/summary");
    const body = await res.json();
    expect(body).toEqual({
      count: 0,
      totalAmountIn: "0",
      totalTax: "0",
      totalSavings: "0",
      totalProtocolFee: "0",
      totalYield: "0",
    });
  });
});
