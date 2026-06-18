import { pgTable, index, text, bigint, varchar, timestamp, foreignKey, primaryKey, integer, smallint, boolean } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"



export const configCreated = pgTable("config_created", {
	configId: text("config_id").primaryKey().notNull(),
	txDigest: text("tx_digest").notNull(),
	taxVaultId: text("tax_vault_id").notNull(),
	savingsVaultId: text("savings_vault_id").notNull(),
	owner: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	checkpointTimestampMs: bigint("checkpoint_timestamp_ms", { mode: "number" }).notNull(),
}, (table) => {
	return {
		ownerIdx: index("config_created_owner_idx").using("btree", table.owner.asc().nullsLast().op("text_ops")),
	}
});

export const dieselSchemaMigrations = pgTable("__diesel_schema_migrations", {
	version: varchar({ length: 50 }).primaryKey().notNull(),
	runOn: timestamp("run_on", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const watermarks = pgTable("watermarks", {
	pipeline: text().primaryKey().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	epochHiInclusive: bigint("epoch_hi_inclusive", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	checkpointHiInclusive: bigint("checkpoint_hi_inclusive", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	txHi: bigint("tx_hi", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	timestampMsHiInclusive: bigint("timestamp_ms_hi_inclusive", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	readerLo: bigint("reader_lo", { mode: "number" }).notNull(),
	prunerTimestamp: timestamp("pruner_timestamp", { mode: 'string' }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	prunerHi: bigint("pruner_hi", { mode: "number" }).notNull(),
	// TODO: failed to parse database type 'bytea'
	chainId: unknown("chain_id"),
});

export const recipientPayout = pgTable("recipient_payout", {
	txDigest: text("tx_digest").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	eventSeq: bigint("event_seq", { mode: "number" }).notNull(),
	payoutIdx: integer("payout_idx").notNull(),
	recipient: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	amount: bigint({ mode: "number" }).notNull(),
	bps: integer().notNull(),
}, (table) => {
	return {
		recipientIdx: index("recipient_payout_recipient_idx").using("btree", table.recipient.asc().nullsLast().op("text_ops")),
		recipientPayoutTxDigestEventSeqFkey: foreignKey({
			columns: [table.txDigest, table.eventSeq],
			foreignColumns: [splitExecuted.txDigest, splitExecuted.eventSeq],
			name: "recipient_payout_tx_digest_event_seq_fkey"
		}),
		recipientPayoutPkey: primaryKey({ columns: [table.txDigest, table.eventSeq, table.payoutIdx], name: "recipient_payout_pkey"}),
	}
});

export const configMutated = pgTable("config_mutated", {
	txDigest: text("tx_digest").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	eventSeq: bigint("event_seq", { mode: "number" }).notNull(),
	configId: text("config_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	oldVersion: bigint("old_version", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	newVersion: bigint("new_version", { mode: "number" }).notNull(),
	mutator: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	checkpointTimestampMs: bigint("checkpoint_timestamp_ms", { mode: "number" }).notNull(),
}, (table) => {
	return {
		configMutatedPkey: primaryKey({ columns: [table.txDigest, table.eventSeq], name: "config_mutated_pkey"}),
	}
});

export const vaultWithdrawn = pgTable("vault_withdrawn", {
	txDigest: text("tx_digest").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	eventSeq: bigint("event_seq", { mode: "number" }).notNull(),
	vaultId: text("vault_id").notNull(),
	kind: smallint().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	amount: bigint({ mode: "number" }).notNull(),
	recipient: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	checkpointTimestampMs: bigint("checkpoint_timestamp_ms", { mode: "number" }).notNull(),
}, (table) => {
	return {
		vaultWithdrawnPkey: primaryKey({ columns: [table.txDigest, table.eventSeq], name: "vault_withdrawn_pkey"}),
	}
});

export const splitExecuted = pgTable("split_executed", {
	txDigest: text("tx_digest").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	eventSeq: bigint("event_seq", { mode: "number" }).notNull(),
	configId: text("config_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	configVersion: bigint("config_version", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	amountIn: bigint("amount_in", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	taxAmount: bigint("tax_amount", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	savingsAmount: bigint("savings_amount", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	protocolFeeAmount: bigint("protocol_fee_amount", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	yieldAmount: bigint("yield_amount", { mode: "number" }).notNull(),
	yieldIncluded: boolean("yield_included").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	timestampMs: bigint("timestamp_ms", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	checkpoint: bigint({ mode: "number" }).notNull(),
}, (table) => {
	return {
		configTsIdx: index("split_executed_config_ts_idx").using("btree", table.configId.asc().nullsLast().op("int8_ops"), table.timestampMs.desc().nullsFirst().op("text_ops")),
		splitExecutedPkey: primaryKey({ columns: [table.txDigest, table.eventSeq], name: "split_executed_pkey"}),
	}
});
