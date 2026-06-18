import { Hono } from "hono";
import { and, eq, lt, or, desc, sql, inArray } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { serializeRow } from "../lib/serialize.js";
import { encodeCursor } from "../lib/cursor.js";
import { normalizeAddress, parseLimit, HttpError, decodeCursorOr400 } from "../lib/validate.js";

export const configs = new Hono();
const cc = schema.configCreated;
const cm = schema.configMutated;
const se = schema.splitExecuted;
const rp = schema.recipientPayout;

// GET /configs?owner= — list a creator's configs, keyset (ts DESC, config_id DESC).
configs.get("/configs", async (c) => {
  const ownerRaw = c.req.query("owner");
  if (!ownerRaw) throw new HttpError(400, "BAD_OWNER", "owner query param is required");
  const owner = normalizeAddress(ownerRaw);
  const limit = parseLimit(c.req.query("limit"));
  const cursorStr = c.req.query("cursor");

  let keyset;
  if (cursorStr) {
    const [ts, id] = decodeCursorOr400(cursorStr, ["i", "s"]) as [bigint, string];
    keyset = or(
      lt(cc.checkpointTimestampMs, ts),
      and(eq(cc.checkpointTimestampMs, ts), lt(cc.configId, id)),
    );
  }

  const rows = await db
    .select()
    .from(cc)
    .where(keyset ? and(eq(cc.owner, owner), keyset) : eq(cc.owner, owner))
    .orderBy(desc(cc.checkpointTimestampMs), desc(cc.configId))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const cursor = hasMore ? encodeCursor([last.checkpointTimestampMs, last.configId]) : null;

  return c.json({ data: page.map(serializeRow), cursor });
});

// GET /configs/:id — detail + latest version from mutation history.
configs.get("/configs/:id", async (c) => {
  const id = c.req.param("id");
  const [row] = await db.select().from(cc).where(eq(cc.configId, id)).limit(1);
  if (!row) throw new HttpError(404, "NOT_FOUND", "config not found");

  const [latest] = await db
    .select({ v: cm.newVersion })
    .from(cm)
    .where(eq(cm.configId, id))
    .orderBy(desc(cm.newVersion))
    .limit(1);

  return c.json({
    ...(serializeRow(row) as object),
    latestVersion: latest ? latest.v.toString() : null,
  });
});

// GET /configs/:id/splits — split history with embedded payouts, keyset 3-tuple.
configs.get("/configs/:id/splits", async (c) => {
  const id = c.req.param("id");
  const limit = parseLimit(c.req.query("limit"));
  const cursorStr = c.req.query("cursor");

  let keyset;
  if (cursorStr) {
    const [ts, dig, seq] = decodeCursorOr400(cursorStr, ["i", "s", "i"]) as [bigint, string, bigint];
    keyset = or(
      lt(se.timestampMs, ts),
      and(eq(se.timestampMs, ts), lt(se.txDigest, dig)),
      and(eq(se.timestampMs, ts), eq(se.txDigest, dig), lt(se.eventSeq, seq)),
    );
  }

  const rows = await db
    .select()
    .from(se)
    .where(keyset ? and(eq(se.configId, id), keyset) : eq(se.configId, id))
    .orderBy(desc(se.timestampMs), desc(se.txDigest), desc(se.eventSeq))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  // Backfill payouts in one IN query keyed by (tx_digest, event_seq).
  const payoutsByKey = new Map<string, unknown[]>();
  if (page.length > 0) {
    const digests = [...new Set(page.map((r) => r.txDigest))];
    const payouts = await db
      .select()
      .from(rp)
      .where(inArray(rp.txDigest, digests))
      .orderBy(rp.payoutIdx);
    for (const p of payouts) {
      const key = `${p.txDigest}:${p.eventSeq}`;
      if (!payoutsByKey.has(key)) payoutsByKey.set(key, []);
      payoutsByKey.get(key)!.push(serializeRow(p));
    }
  }

  const data = page.map((r) => ({
    ...(serializeRow(r) as object),
    payouts: payoutsByKey.get(`${r.txDigest}:${r.eventSeq}`) ?? [],
  }));

  const last = page[page.length - 1];
  const cursor = hasMore ? encodeCursor([last.timestampMs, last.txDigest, last.eventSeq]) : null;

  return c.json({ data, cursor });
});

// GET /configs/:id/mutations — mutation history, keyset 3-tuple.
configs.get("/configs/:id/mutations", async (c) => {
  const id = c.req.param("id");
  const limit = parseLimit(c.req.query("limit"));
  const cursorStr = c.req.query("cursor");

  let keyset;
  if (cursorStr) {
    const [ts, dig, seq] = decodeCursorOr400(cursorStr, ["i", "s", "i"]) as [bigint, string, bigint];
    keyset = or(
      lt(cm.checkpointTimestampMs, ts),
      and(eq(cm.checkpointTimestampMs, ts), lt(cm.txDigest, dig)),
      and(eq(cm.checkpointTimestampMs, ts), eq(cm.txDigest, dig), lt(cm.eventSeq, seq)),
    );
  }

  const rows = await db
    .select()
    .from(cm)
    .where(keyset ? and(eq(cm.configId, id), keyset) : eq(cm.configId, id))
    .orderBy(desc(cm.checkpointTimestampMs), desc(cm.txDigest), desc(cm.eventSeq))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const cursor = hasMore
    ? encodeCursor([last.checkpointTimestampMs, last.txDigest, last.eventSeq])
    : null;

  return c.json({ data: page.map(serializeRow), cursor });
});

// GET /configs/:id/summary — revenue aggregates over splits.
configs.get("/configs/:id/summary", async (c) => {
  const id = c.req.param("id");
  const [agg] = await db
    .select({
      count: sql<string>`count(*)`,
      totalAmountIn: sql<string | null>`sum(${se.amountIn})`,
      totalTax: sql<string | null>`sum(${se.taxAmount})`,
      totalSavings: sql<string | null>`sum(${se.savingsAmount})`,
      totalProtocolFee: sql<string | null>`sum(${se.protocolFeeAmount})`,
      totalYield: sql<string | null>`sum(${se.yieldAmount})`,
    })
    .from(se)
    .where(eq(se.configId, id));

  return c.json({
    count: Number(agg.count),
    totalAmountIn: agg.totalAmountIn ?? "0",
    totalTax: agg.totalTax ?? "0",
    totalSavings: agg.totalSavings ?? "0",
    totalProtocolFee: agg.totalProtocolFee ?? "0",
    totalYield: agg.totalYield ?? "0",
  });
});
