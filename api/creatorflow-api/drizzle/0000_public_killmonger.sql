-- Current sql file was generated after introspecting the database
-- If you want to run this migration please uncomment this code before executing migrations
/*
CREATE TABLE IF NOT EXISTS "config_created" (
	"config_id" text PRIMARY KEY NOT NULL,
	"tx_digest" text NOT NULL,
	"tax_vault_id" text NOT NULL,
	"savings_vault_id" text NOT NULL,
	"owner" text NOT NULL,
	"checkpoint_timestamp_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "__diesel_schema_migrations" (
	"version" varchar(50) PRIMARY KEY NOT NULL,
	"run_on" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "watermarks" (
	"pipeline" text PRIMARY KEY NOT NULL,
	"epoch_hi_inclusive" bigint NOT NULL,
	"checkpoint_hi_inclusive" bigint NOT NULL,
	"tx_hi" bigint NOT NULL,
	"timestamp_ms_hi_inclusive" bigint NOT NULL,
	"reader_lo" bigint NOT NULL,
	"pruner_timestamp" timestamp NOT NULL,
	"pruner_hi" bigint NOT NULL,
	"chain_id" "bytea"
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "recipient_payout" (
	"tx_digest" text NOT NULL,
	"event_seq" bigint NOT NULL,
	"payout_idx" integer NOT NULL,
	"recipient" text NOT NULL,
	"amount" bigint NOT NULL,
	"bps" integer NOT NULL,
	CONSTRAINT "recipient_payout_pkey" PRIMARY KEY("tx_digest","event_seq","payout_idx")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "config_mutated" (
	"tx_digest" text NOT NULL,
	"event_seq" bigint NOT NULL,
	"config_id" text NOT NULL,
	"old_version" bigint NOT NULL,
	"new_version" bigint NOT NULL,
	"mutator" text NOT NULL,
	"checkpoint_timestamp_ms" bigint NOT NULL,
	CONSTRAINT "config_mutated_pkey" PRIMARY KEY("tx_digest","event_seq")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vault_withdrawn" (
	"tx_digest" text NOT NULL,
	"event_seq" bigint NOT NULL,
	"vault_id" text NOT NULL,
	"kind" smallint NOT NULL,
	"amount" bigint NOT NULL,
	"recipient" text NOT NULL,
	"checkpoint_timestamp_ms" bigint NOT NULL,
	CONSTRAINT "vault_withdrawn_pkey" PRIMARY KEY("tx_digest","event_seq")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "split_executed" (
	"tx_digest" text NOT NULL,
	"event_seq" bigint NOT NULL,
	"config_id" text NOT NULL,
	"config_version" bigint NOT NULL,
	"amount_in" bigint NOT NULL,
	"tax_amount" bigint NOT NULL,
	"savings_amount" bigint NOT NULL,
	"protocol_fee_amount" bigint NOT NULL,
	"yield_amount" bigint NOT NULL,
	"yield_included" boolean NOT NULL,
	"timestamp_ms" bigint NOT NULL,
	"checkpoint" bigint NOT NULL,
	CONSTRAINT "split_executed_pkey" PRIMARY KEY("tx_digest","event_seq")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "recipient_payout" ADD CONSTRAINT "recipient_payout_tx_digest_event_seq_fkey" FOREIGN KEY ("tx_digest","event_seq") REFERENCES "public"."split_executed"("tx_digest","event_seq") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "config_created_owner_idx" ON "config_created" USING btree ("owner" text_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recipient_payout_recipient_idx" ON "recipient_payout" USING btree ("recipient" text_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "split_executed_config_ts_idx" ON "split_executed" USING btree ("config_id" int8_ops,"timestamp_ms" text_ops);
*/