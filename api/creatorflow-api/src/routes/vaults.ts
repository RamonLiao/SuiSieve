import { Hono } from "hono";
import { and, eq, lt, or, desc } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { serializeRow } from "../lib/serialize.js";
import { encodeCursor } from "../lib/cursor.js";
import { parseLimit, decodeCursorOr400 } from "../lib/validate.js";

export const vaults = new Hono();
const vw = schema.vaultWithdrawn;
const cc = schema.configCreated;

// GET /vaults/:id/withdrawals — withdrawals from a vault, LEFT JOIN config_created
// so rows survive even before the config row is indexed (config_id null until then).
vaults.get("/vaults/:id/withdrawals", async (c) => {
  const vaultId = c.req.param("id");
  const limit = parseLimit(c.req.query("limit"));
  const cursorStr = c.req.query("cursor");

  let keyset;
  if (cursorStr) {
    const [ts, dig, seq] = decodeCursorOr400(cursorStr, ["i", "s", "i"]) as [bigint, string, bigint];
    keyset = or(
      lt(vw.checkpointTimestampMs, ts),
      and(eq(vw.checkpointTimestampMs, ts), lt(vw.txDigest, dig)),
      and(eq(vw.checkpointTimestampMs, ts), eq(vw.txDigest, dig), lt(vw.eventSeq, seq)),
    );
  }

  const rows = await db
    .select({
      txDigest: vw.txDigest,
      eventSeq: vw.eventSeq,
      vaultId: vw.vaultId,
      kind: vw.kind,
      amount: vw.amount,
      recipient: vw.recipient,
      checkpointTimestampMs: vw.checkpointTimestampMs,
      configId: cc.configId,
    })
    .from(vw)
    .leftJoin(cc, or(eq(vw.vaultId, cc.taxVaultId), eq(vw.vaultId, cc.savingsVaultId)))
    .where(keyset ? and(eq(vw.vaultId, vaultId), keyset) : eq(vw.vaultId, vaultId))
    .orderBy(desc(vw.checkpointTimestampMs), desc(vw.txDigest), desc(vw.eventSeq))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const cursor = hasMore
    ? encodeCursor([last.checkpointTimestampMs, last.txDigest, last.eventSeq])
    : null;

  return c.json({ data: page.map(serializeRow), cursor });
});
