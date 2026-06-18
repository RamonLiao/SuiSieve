// Read-only mirror of the Rust indexer's Postgres schema (db creatorflow_indexer).
// Seeded from `drizzle-kit pull` (drizzle/schema.ts) then corrected:
//   - All u64 columns use { mode: "bigint" } NOT the pull default { mode: "number" }.
//     Reason: indexer amounts/versions/timestamps are u64; JS `number` loses precision
//     above 2^53. bigint mode + serializeRow() preserves them as decimal strings over JSON.
//   - smallint(kind), integer(payout_idx, bps) stay JS number (fit safely).
//   - Framework tables (__diesel_schema_migrations, watermarks) omitted: unused by the API,
//     and the pulled `watermarks.chain_id` bytea emitted an uncompilable `unknown(...)`.
// The Rust ingest owns the schema; this file is the TS read view. Keep column names in sync
// if a migration changes them (re-pull into drizzle/, port deltas here).
import {
  pgTable,
  index,
  text,
  bigint,
  integer,
  smallint,
  boolean,
  foreignKey,
  primaryKey,
} from "drizzle-orm/pg-core";

export const configCreated = pgTable(
  "config_created",
  {
    configId: text("config_id").primaryKey().notNull(),
    txDigest: text("tx_digest").notNull(),
    taxVaultId: text("tax_vault_id").notNull(),
    savingsVaultId: text("savings_vault_id").notNull(),
    owner: text().notNull(),
    checkpointTimestampMs: bigint("checkpoint_timestamp_ms", { mode: "bigint" }).notNull(),
  },
  (table) => ({
    ownerIdx: index("config_created_owner_idx").using("btree", table.owner),
  }),
);

export const splitExecuted = pgTable(
  "split_executed",
  {
    txDigest: text("tx_digest").notNull(),
    eventSeq: bigint("event_seq", { mode: "bigint" }).notNull(),
    configId: text("config_id").notNull(),
    configVersion: bigint("config_version", { mode: "bigint" }).notNull(),
    amountIn: bigint("amount_in", { mode: "bigint" }).notNull(),
    taxAmount: bigint("tax_amount", { mode: "bigint" }).notNull(),
    savingsAmount: bigint("savings_amount", { mode: "bigint" }).notNull(),
    protocolFeeAmount: bigint("protocol_fee_amount", { mode: "bigint" }).notNull(),
    yieldAmount: bigint("yield_amount", { mode: "bigint" }).notNull(),
    yieldIncluded: boolean("yield_included").notNull(),
    timestampMs: bigint("timestamp_ms", { mode: "bigint" }).notNull(),
    checkpoint: bigint("checkpoint", { mode: "bigint" }).notNull(),
  },
  (table) => ({
    configTsIdx: index("split_executed_config_ts_idx").using(
      "btree",
      table.configId,
      table.timestampMs.desc(),
    ),
    pk: primaryKey({ columns: [table.txDigest, table.eventSeq], name: "split_executed_pkey" }),
  }),
);

export const recipientPayout = pgTable(
  "recipient_payout",
  {
    txDigest: text("tx_digest").notNull(),
    eventSeq: bigint("event_seq", { mode: "bigint" }).notNull(),
    payoutIdx: integer("payout_idx").notNull(),
    recipient: text().notNull(),
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    bps: integer().notNull(),
  },
  (table) => ({
    recipientIdx: index("recipient_payout_recipient_idx").using("btree", table.recipient),
    fk: foreignKey({
      columns: [table.txDigest, table.eventSeq],
      foreignColumns: [splitExecuted.txDigest, splitExecuted.eventSeq],
      name: "recipient_payout_tx_digest_event_seq_fkey",
    }),
    pk: primaryKey({
      columns: [table.txDigest, table.eventSeq, table.payoutIdx],
      name: "recipient_payout_pkey",
    }),
  }),
);

export const configMutated = pgTable(
  "config_mutated",
  {
    txDigest: text("tx_digest").notNull(),
    eventSeq: bigint("event_seq", { mode: "bigint" }).notNull(),
    configId: text("config_id").notNull(),
    oldVersion: bigint("old_version", { mode: "bigint" }).notNull(),
    newVersion: bigint("new_version", { mode: "bigint" }).notNull(),
    mutator: text().notNull(),
    checkpointTimestampMs: bigint("checkpoint_timestamp_ms", { mode: "bigint" }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.txDigest, table.eventSeq], name: "config_mutated_pkey" }),
  }),
);

export const vaultWithdrawn = pgTable(
  "vault_withdrawn",
  {
    txDigest: text("tx_digest").notNull(),
    eventSeq: bigint("event_seq", { mode: "bigint" }).notNull(),
    vaultId: text("vault_id").notNull(),
    kind: smallint().notNull(),
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    recipient: text().notNull(),
    checkpointTimestampMs: bigint("checkpoint_timestamp_ms", { mode: "bigint" }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.txDigest, table.eventSeq], name: "vault_withdrawn_pkey" }),
  }),
);
