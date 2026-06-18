import { Hono } from "hono";
import { and, eq, lt, or, desc } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { serializeRow } from "../lib/serialize.js";
import { encodeCursor } from "../lib/cursor.js";
import { normalizeAddress, parseLimit, decodeCursorOr400 } from "../lib/validate.js";

export const collaborators = new Hono();
const rp = schema.recipientPayout;
const se = schema.splitExecuted;

// GET /collaborators/:addr/earnings — every payout to addr + its split context.
collaborators.get("/collaborators/:addr/earnings", async (c) => {
  const addr = normalizeAddress(c.req.param("addr"));
  const limit = parseLimit(c.req.query("limit"));
  const cursorStr = c.req.query("cursor");

  // 4-tuple keyset: one split can hold multiple payouts to the same recipient
  // (distinct payout_idx), so payout_idx MUST be part of the cursor or a page
  // boundary inside that group silently drops the trailing payouts.
  let keyset;
  if (cursorStr) {
    const [ts, dig, seq, idx] = decodeCursorOr400(cursorStr, ["i", "s", "i", "i"]) as [
      bigint,
      string,
      bigint,
      bigint,
    ];
    keyset = or(
      lt(se.timestampMs, ts),
      and(eq(se.timestampMs, ts), lt(se.txDigest, dig)),
      and(eq(se.timestampMs, ts), eq(se.txDigest, dig), lt(se.eventSeq, seq)),
      and(
        eq(se.timestampMs, ts),
        eq(se.txDigest, dig),
        eq(se.eventSeq, seq),
        lt(rp.payoutIdx, Number(idx)),
      ),
    );
  }

  const rows = await db
    .select({
      txDigest: rp.txDigest,
      eventSeq: rp.eventSeq,
      payoutIdx: rp.payoutIdx,
      recipient: rp.recipient,
      amount: rp.amount,
      bps: rp.bps,
      configId: se.configId,
      timestampMs: se.timestampMs,
    })
    .from(rp)
    .innerJoin(se, and(eq(rp.txDigest, se.txDigest), eq(rp.eventSeq, se.eventSeq)))
    .where(keyset ? and(eq(rp.recipient, addr), keyset) : eq(rp.recipient, addr))
    .orderBy(desc(se.timestampMs), desc(se.txDigest), desc(se.eventSeq), desc(rp.payoutIdx))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const cursor = hasMore
    ? encodeCursor([last.timestampMs, last.txDigest, last.eventSeq, BigInt(last.payoutIdx)])
    : null;

  return c.json({ data: page.map(serializeRow), cursor });
});
