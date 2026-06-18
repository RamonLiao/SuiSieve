import { describe, it, expect } from "vitest";
import { app } from "../src/app.js";
import { truncateAll, seedSplit, seedPayout } from "./helpers/db.js";

describe("monkey", () => {
  it("multiple same-type events in one tx straddle page boundary without loss/dup", async () => {
    await truncateAll();
    // 3 split rows: same tx_digest, same timestamp, different event_seq
    for (let seq = 0; seq < 3; seq++) {
      await seedSplit({
        txDigest: "BATCH",
        eventSeq: BigInt(seq),
        configId: "0xc1",
        configVersion: 1n,
        amountIn: 100n,
        taxAmount: 0n,
        savingsAmount: 0n,
        protocolFeeAmount: 0n,
        yieldAmount: 0n,
        yieldIncluded: false,
        timestampMs: 500n,
        checkpoint: 1n,
      });
    }
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const url = `/configs/0xc1/splits?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const body: any = await (await app.request(url)).json();
      for (const r of body.data) seen.add(`${r.txDigest}:${r.eventSeq}`);
      cursor = body.cursor;
      if (!cursor) break;
    }
    expect(seen.size).toBe(3); // all event_seq distinct, none skipped or duplicated
    expect([...seen]).toEqual(expect.arrayContaining(["BATCH:0", "BATCH:1", "BATCH:2"]));
  });

  it('zero amount serializes as "0" not 0/null', async () => {
    await truncateAll();
    await seedSplit({
      txDigest: "Z",
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
    const body: any = await (await app.request("/configs/0xc1/splits")).json();
    expect(body.data[0].amountIn).toBe("0");
  });

  it("same addr with multiple payouts in one split is not undercounted", async () => {
    await truncateAll();
    await seedSplit({
      txDigest: "S",
      eventSeq: 0n,
      configId: "0xc1",
      configVersion: 1n,
      amountIn: 1000n,
      taxAmount: 0n,
      savingsAmount: 0n,
      protocolFeeAmount: 0n,
      yieldAmount: 0n,
      yieldIncluded: false,
      timestampMs: 1n,
      checkpoint: 1n,
    });
    await seedPayout({
      txDigest: "S",
      eventSeq: 0n,
      payoutIdx: 0,
      recipient: "0xabc1",
      amount: 300n,
      bps: 3000,
    });
    await seedPayout({
      txDigest: "S",
      eventSeq: 0n,
      payoutIdx: 1,
      recipient: "0xabc1",
      amount: 200n,
      bps: 2000,
    });
    const body: any = await (await app.request("/collaborators/0xabc1/earnings")).json();
    expect(body.data).toHaveLength(2);
    const total = body.data.reduce((s: bigint, r: any) => s + BigInt(r.amount), 0n);
    expect(total).toBe(500n);
  });

  it("out-of-order checkpoint arrival still orders by ts", async () => {
    await truncateAll();
    await seedSplit({
      txDigest: "HI",
      eventSeq: 0n,
      configId: "0xc1",
      configVersion: 1n,
      amountIn: 1n,
      taxAmount: 0n,
      savingsAmount: 0n,
      protocolFeeAmount: 0n,
      yieldAmount: 0n,
      yieldIncluded: false,
      timestampMs: 900n,
      checkpoint: 9n,
    });
    await seedSplit({
      txDigest: "LO",
      eventSeq: 0n,
      configId: "0xc1",
      configVersion: 1n,
      amountIn: 1n,
      taxAmount: 0n,
      savingsAmount: 0n,
      protocolFeeAmount: 0n,
      yieldAmount: 0n,
      yieldIncluded: false,
      timestampMs: 100n,
      checkpoint: 1n,
    });
    const body: any = await (await app.request("/configs/0xc1/splits")).json();
    expect(body.data.map((r: any) => r.txDigest)).toEqual(["HI", "LO"]);
  });

  it("bad cursor returns 400", async () => {
    const res = await app.request("/configs/0xc1/splits?cursor=%%%bogus%%%");
    expect(res.status).toBe(400);
  });

  it("type-mismatched cursor returns 400 (not a DB 500)", async () => {
    // arity correct (3) but all-string parts where route expects [i,s,i]
    const tampered = Buffer.from("s:x|s:y|s:z", "utf8").toString("base64url");
    const res = await app.request(`/configs/0xc1/splits?cursor=${encodeURIComponent(tampered)}`);
    expect(res.status).toBe(400);
  });

  it("paginated earnings across multi-payout split loses no payout (F1)", async () => {
    await truncateAll();
    await seedSplit({
      txDigest: "MULTI",
      eventSeq: 0n,
      configId: "0xc1",
      configVersion: 1n,
      amountIn: 1000n,
      taxAmount: 0n,
      savingsAmount: 0n,
      protocolFeeAmount: 0n,
      yieldAmount: 0n,
      yieldIncluded: false,
      timestampMs: 1n,
      checkpoint: 1n,
    });
    // 3 payouts to same recipient in the one split — boundary will land mid-group
    for (let idx = 0; idx < 3; idx++) {
      await seedPayout({
        txDigest: "MULTI",
        eventSeq: 0n,
        payoutIdx: idx,
        recipient: "0xabc1",
        amount: BigInt(100 * (idx + 1)),
        bps: 1000,
      });
    }
    const seen = new Set<string>();
    let total = 0n;
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const url = `/collaborators/0xabc1/earnings?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const body: any = await (await app.request(url)).json();
      for (const r of body.data) {
        seen.add(`${r.txDigest}:${r.eventSeq}:${r.payoutIdx}`);
        total += BigInt(r.amount);
      }
      cursor = body.cursor;
      if (!cursor) break;
    }
    expect(seen.size).toBe(3); // none skipped, none duplicated
    expect(total).toBe(600n); // 100 + 200 + 300
  });
});
