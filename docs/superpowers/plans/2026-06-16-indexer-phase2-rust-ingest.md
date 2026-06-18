# Indexer Phase 2 — Rust Ingest (`sui-indexer-alt-framework`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `creatorflow-indexer`, a Rust checkpoint-ingest service that consumes the SUI testnet checkpoint stream, decodes CreatorFlow's 5 on-chain events, and writes them to Postgres with framework-managed watermark/resume — the durable source of truth the Phase 3 TypeScript read API mirrors.

**Architecture:** A single `sui-indexer-alt-framework` **sequential pipeline** with one `Handler` whose `Value` is an enum over all 5 row types (`ConfigCreated`, `SplitExecuted`, `RecipientPayout`, `ConfigMutated`, `VaultWithdrawn`). `process()` filters checkpoint events by `(package, module="events", name)` and BCS-decodes each into a Rust mirror struct via `bcs::from_bytes(&event.contents)`; `commit()` groups the batch by variant and bulk-inserts each table inside one diesel transaction. Sequential (not concurrent) pipeline → commits advance in strict checkpoint order under one watermark, killing the cross-table temporal skew the design rejected. diesel migrations are the single schema source of truth.

**Tech Stack:** Rust (edition 2021), `sui-indexer-alt-framework` (git, pinned rev), `diesel` + `diesel-async` (Postgres), `bcs`, `serde`, `tokio`, Postgres 15+.

**Spec:** `docs/superpowers/specs/2026-06-15-indexer-design.md` (ingest layer + shared Postgres schema).

---

## Conflicts surfaced vs. the design spec (Rule 7 — read before starting)

The design spec was written before the actual crate API was verified (it explicitly deferred this plan for that reason). Three spec statements are superseded here by the framework's real API. Each is intentional, not an oversight:

1. **diesel, not sqlx.** Spec §Architecture says "Rust sqlx migrations = source of truth." The framework's `Handler::commit` receives a diesel-async `&mut Connection` and the framework embeds **diesel** migrations. Using sqlx would mean abandoning the framework's transactional batch+watermark commit. → This plan uses **diesel migrations + diesel inserts**. The "single source of truth" intent is preserved; only the tool changes. The Phase 3 TS Drizzle mirror does `drizzle-kit pull` against the live schema and is unaffected by which Rust ORM produced it.

2. **BCS decode, not `parsed_json`.** Spec §ingest says decode `parsed_json` (u64-as-string, address normalization). The framework's documented path is `bcs::from_bytes::<Mirror>(&event.contents)` into a struct mirroring the Move event (field **order and types must match exactly**). This is more robust: `u64` decodes to `u64` directly (no string parse), and `ObjectID`/`address` decode to typed values whose `.to_canonical_string(true)` yields the lowercase `0x`+64hex form for free — eliminating the manual normalization step entirely.

3. **"single processor" = one sequential pipeline with an enum `Value`.** The framework's unit of watermarking is the *pipeline*, and each `Handler` typically maps to one table. To keep the spec's single-watermark/atomic-cross-table guarantee, the one Handler's `Value` is an enum over all 5 rows and `commit` writes every table in one transaction. Do NOT split into 5 pipelines — that reintroduces the per-pipeline watermark skew the round-2 architect review rejected.

**Version pinning (dev-rules: don't trust stale docs).** Context7 shows testnet `v1.65.2` / mainnet `v1.66.2`; the crate's breaking-change log runs through v1.72. Task 1 pins one rev and **compiles a skeleton before any logic is written**, so the exact builder/trait signatures are discovered by `cargo build`, not assumed. If a signature below differs from what compiles, the skeleton task (Task 3) is the single place to adapt — later tasks only touch pure mapping logic and SQL.

---

## File Structure

```
indexer/creatorflow-indexer/
  Cargo.toml                      # crate + pinned framework rev
  diesel.toml                     # diesel config (points at schema.rs)
  .env.example                    # DATABASE_URL, CREATORFLOW_PKG, SUI_FULLNODE, START_CHECKPOINT
  migrations/
    00000000000000_diesel_initial_setup/   # diesel boilerplate
    2026-06-16-000001_creatorflow_schema/
      up.sql                      # the 5 tables (spec §Shared Postgres schema)
      down.sql
  src/
    main.rs                       # wire Indexer/cluster + sequential pipeline
    schema.rs                     # diesel table! macros (hand-written, mirrors up.sql)
    models.rs                     # Insertable row structs (one per table) + Row enum
    events.rs                     # Move-event mirror structs (BCS) + parse_*() pure fns
    handler.rs                    # CreatorflowHandler: Processor + sequential::Handler
  tests/
    parse.rs                      # pure BCS→Row unit tests (no DB)
    commit.rs                     # diesel idempotency integration test (needs PG)
```

Responsibilities: `events.rs` is the only place that knows Move BCS layout; `models.rs` is the only place that knows diesel row shape; `handler.rs` glues them and owns filtering; `main.rs` owns service wiring. Files that change when an event is added/changed (`events.rs` + `models.rs` + `schema.rs` + a migration) are co-located by that concern.

---

### Task 1: Scaffold crate + pin framework rev + prove it compiles

**Files:**
- Create: `indexer/creatorflow-indexer/Cargo.toml`
- Create: `indexer/creatorflow-indexer/src/main.rs`
- Create: `indexer/creatorflow-indexer/.env.example`

- [ ] **Step 1: Create `Cargo.toml`** (pin a rev — start with the tag below; if it fails to resolve, bump to the next published `testnet-vX` tag and record which one worked in `move-notes.md`)

```toml
[package]
name = "creatorflow-indexer"
version = "0.1.0"
edition = "2021"

[dependencies]
sui-indexer-alt-framework = { git = "https://github.com/MystenLabs/sui.git", tag = "testnet-v1.66.2" }
diesel = { version = "2.2", features = ["postgres", "chrono"] }
diesel-async = { version = "0.5", features = ["postgres", "bb8"] }
bcs = "0.1"
serde = { version = "1", features = ["derive"] }
tokio = { version = "1", features = ["full"] }
anyhow = "1"
async-trait = "0.1"
dotenvy = "0.15"
prometheus = "0.13"
tokio-util = "0.7"
clap = { version = "4", features = ["derive"] }
```

> diesel/diesel-async versions must match what the pinned framework rev re-exports. The framework re-exports its diesel under `sui_indexer_alt_framework::*`; prefer importing diesel **through** the framework re-exports where available to avoid a version mismatch. If `cargo build` reports two diesel versions, drop the direct `diesel`/`diesel-async` deps and use only the re-exports.

- [ ] **Step 2: Minimal `main.rs` that links the framework** (no logic — just prove the crate + key imports resolve)

```rust
use sui_indexer_alt_framework::cluster::IndexerCluster;
use sui_indexer_alt_framework::cli::Args;
use clap::Parser;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    let _args = Args::parse();
    println!("creatorflow-indexer skeleton links");
    Ok(())
}
```

- [ ] **Step 3: Compile** — this is the verification gate for the pinned API

Run: `cd indexer/creatorflow-indexer && cargo build`
Expected: builds clean. If `IndexerCluster`/`Args` import paths differ on the resolved rev, run `cargo doc --open -p sui-indexer-alt-framework` (or `cargo tree | grep indexer`) and correct the paths. **Record the working rev + the correct import paths in `move-notes.md` before continuing** — every later task depends on them.

- [ ] **Step 4: Create `.env.example`**

```
DATABASE_URL=postgres://creatorflow:creatorflow@localhost:5432/creatorflow_indexer
CREATORFLOW_PKG=0x0000000000000000000000000000000000000000000000000000000000000000
SUI_FULLNODE=https://fullnode.testnet.sui.io:443
SUI_REMOTE_STORE=https://checkpoints.testnet.sui.io
# Omit to resume from the framework watermark. Set post-deploy to the package's publish checkpoint for backfill.
START_CHECKPOINT=
```

- [ ] **Step 5: Commit** (skip — not a git repo; see Git note)

---

### Task 2: diesel migration — the 5 tables (schema source of truth)

**Files:**
- Create: `indexer/creatorflow-indexer/migrations/2026-06-16-000001_creatorflow_schema/up.sql`
- Create: `indexer/creatorflow-indexer/migrations/2026-06-16-000001_creatorflow_schema/down.sql`
- Create: `indexer/creatorflow-indexer/diesel.toml`

- [ ] **Step 1: Install diesel CLI + init** (idempotent; needs a reachable Postgres)

Run:
```bash
cargo install diesel_cli --no-default-features --features postgres
cd indexer/creatorflow-indexer
echo 'DATABASE_URL=postgres://creatorflow:creatorflow@localhost:5432/creatorflow_indexer' > .env
diesel setup        # creates DB + diesel_initial_setup migration + diesel.toml
```
Expected: `creatorflow_indexer` DB created, `migrations/00000000000000_diesel_initial_setup/` written.

- [ ] **Step 2: Generate the migration dir**

Run: `diesel migration generate creatorflow_schema`
Then replace the generated `up.sql` with the schema (matches spec §Shared Postgres schema verbatim; note framework owns the watermark table separately):

```sql
CREATE TABLE config_created (
  config_id        TEXT PRIMARY KEY,
  tx_digest        TEXT NOT NULL,
  tax_vault_id     TEXT NOT NULL,
  savings_vault_id TEXT NOT NULL,
  owner            TEXT NOT NULL,
  checkpoint_timestamp_ms BIGINT NOT NULL
);
CREATE INDEX config_created_owner_idx ON config_created (owner);

CREATE TABLE split_executed (
  tx_digest TEXT NOT NULL,
  event_seq BIGINT NOT NULL,
  config_id TEXT NOT NULL,
  config_version BIGINT NOT NULL,
  amount_in BIGINT NOT NULL,
  tax_amount BIGINT NOT NULL,
  savings_amount BIGINT NOT NULL,
  protocol_fee_amount BIGINT NOT NULL,
  yield_amount BIGINT NOT NULL,
  yield_included BOOLEAN NOT NULL,
  timestamp_ms BIGINT NOT NULL,
  checkpoint BIGINT NOT NULL,
  PRIMARY KEY (tx_digest, event_seq)
);
CREATE INDEX split_executed_config_ts_idx ON split_executed (config_id, timestamp_ms DESC);

CREATE TABLE recipient_payout (
  tx_digest TEXT NOT NULL,
  event_seq BIGINT NOT NULL,
  payout_idx INT NOT NULL,
  recipient TEXT NOT NULL,
  amount BIGINT NOT NULL,
  bps INT NOT NULL,
  PRIMARY KEY (tx_digest, event_seq, payout_idx),
  FOREIGN KEY (tx_digest, event_seq) REFERENCES split_executed (tx_digest, event_seq)
);
CREATE INDEX recipient_payout_recipient_idx ON recipient_payout (recipient);

CREATE TABLE config_mutated (
  tx_digest TEXT NOT NULL,
  event_seq BIGINT NOT NULL,
  config_id TEXT NOT NULL,
  old_version BIGINT NOT NULL,
  new_version BIGINT NOT NULL,
  mutator TEXT NOT NULL,
  checkpoint_timestamp_ms BIGINT NOT NULL,
  PRIMARY KEY (tx_digest, event_seq)
);

CREATE TABLE vault_withdrawn (
  tx_digest TEXT NOT NULL,
  event_seq BIGINT NOT NULL,
  vault_id TEXT NOT NULL,
  kind SMALLINT NOT NULL,
  amount BIGINT NOT NULL,
  recipient TEXT NOT NULL,
  checkpoint_timestamp_ms BIGINT NOT NULL,
  PRIMARY KEY (tx_digest, event_seq)
);
```

> **Ordering caveat:** `recipient_payout` has an FK to `split_executed`. Because Phase-2 commits group rows per checkpoint and write `split_executed` before `recipient_payout` inside the same transaction (Task 6), the FK holds. If a future change splits these across transactions, drop the FK — the LEFT-JOIN read model already tolerates orphans.

- [ ] **Step 3: `down.sql`**

```sql
DROP TABLE vault_withdrawn;
DROP TABLE config_mutated;
DROP TABLE recipient_payout;
DROP TABLE split_executed;
DROP TABLE config_created;
```

- [ ] **Step 4: Run + verify round-trips**

Run: `diesel migration run && diesel migration redo`
Expected: both succeed; `diesel migration redo` (down then up) proves `down.sql` is correct.

- [ ] **Step 5: Commit** (skip — not a git repo)

---

### Task 3: diesel `schema.rs` + models + Row enum (compiling skeleton, no logic)

**Files:**
- Create: `indexer/creatorflow-indexer/src/schema.rs`
- Create: `indexer/creatorflow-indexer/src/models.rs`

- [ ] **Step 1: Generate `schema.rs` from the live DB**

Run: `cd indexer/creatorflow-indexer && diesel print-schema > src/schema.rs`
Expected: `table! { ... }` blocks for all 5 tables. (Hand-editing is fine if no DB is reachable — mirror the column types: `Text`→`Text`, `BIGINT`→`Int8`, `INT`→`Int4`, `SMALLINT`→`Int2`, `BOOLEAN`→`Bool`.)

- [ ] **Step 2: Write `models.rs`** — one `Insertable` struct per table + the dispatch enum

```rust
use diesel::prelude::*;
use crate::schema::*;

#[derive(Insertable, Clone, Debug)]
#[diesel(table_name = config_created)]
pub struct ConfigCreatedRow {
    pub config_id: String,
    pub tx_digest: String,
    pub tax_vault_id: String,
    pub savings_vault_id: String,
    pub owner: String,
    pub checkpoint_timestamp_ms: i64,
}

#[derive(Insertable, Clone, Debug)]
#[diesel(table_name = split_executed)]
pub struct SplitExecutedRow {
    pub tx_digest: String,
    pub event_seq: i64,
    pub config_id: String,
    pub config_version: i64,
    pub amount_in: i64,
    pub tax_amount: i64,
    pub savings_amount: i64,
    pub protocol_fee_amount: i64,
    pub yield_amount: i64,
    pub yield_included: bool,
    pub timestamp_ms: i64,
    pub checkpoint: i64,
}

#[derive(Insertable, Clone, Debug)]
#[diesel(table_name = recipient_payout)]
pub struct RecipientPayoutRow {
    pub tx_digest: String,
    pub event_seq: i64,
    pub payout_idx: i32,
    pub recipient: String,
    pub amount: i64,
    pub bps: i32,
}

#[derive(Insertable, Clone, Debug)]
#[diesel(table_name = config_mutated)]
pub struct ConfigMutatedRow {
    pub tx_digest: String,
    pub event_seq: i64,
    pub config_id: String,
    pub old_version: i64,
    pub new_version: i64,
    pub mutator: String,
    pub checkpoint_timestamp_ms: i64,
}

#[derive(Insertable, Clone, Debug)]
#[diesel(table_name = vault_withdrawn)]
pub struct VaultWithdrawnRow {
    pub tx_digest: String,
    pub event_seq: i64,
    pub vault_id: String,
    pub kind: i16,
    pub amount: i64,
    pub recipient: String,
    pub checkpoint_timestamp_ms: i64,
}

/// The single Handler's `Value`. One enum so all 5 tables share one pipeline =
/// one watermark = per-checkpoint atomic commit (design round-2 decision).
#[derive(Clone, Debug)]
pub enum Row {
    Config(ConfigCreatedRow),
    Split(SplitExecutedRow),
    Payout(RecipientPayoutRow),
    Mutated(ConfigMutatedRow),
    Withdrawn(VaultWithdrawnRow),
}
```

- [ ] **Step 3: Wire modules into `main.rs`** — add `mod schema; mod models;` and `cargo build`

Run: `cargo build`
Expected: clean compile. Fixes here are diesel-type mismatches only.

- [ ] **Step 4: Commit** (skip — not a git repo)

---

### Task 4: Move-event mirror structs + pure `parse_*` fns (TDD — the testable core)

**Files:**
- Create: `indexer/creatorflow-indexer/src/events.rs`
- Test: `indexer/creatorflow-indexer/tests/parse.rs`

The mirror structs MUST match each Move event's field **order and types** exactly (cross-check against `move/creatorflow/sources/events.move`). `ObjectID`/`SuiAddress` decode from BCS; `.to_canonical_string(true)` → `0x`+64hex lowercase.

- [ ] **Step 1: Write the failing test** (`tests/parse.rs`)

```rust
use creatorflow_indexer::events::{self, SplitExecutedEvent};
use sui_indexer_alt_framework::types::base_types::{ObjectID, SuiAddress};

#[test]
fn split_executed_bcs_round_trips_into_row() {
    let cfg = ObjectID::random();
    let ev = SplitExecutedEvent {
        config_id: cfg,
        config_version: 3,
        amount_in: 1_000_000,
        tax_amount: 50_000,
        savings_amount: 90_000,
        protocol_fee_amount: 5_000,
        yield_amount: 0,
        yield_included: false,
        timestamp_ms: 1_700_000_000_000,
    };
    let bytes = bcs::to_bytes(&ev).unwrap();

    let row = events::parse_split_executed(&bytes, "0xabc", 7, 42).unwrap();

    assert_eq!(row.config_id, cfg.to_canonical_string(true));
    assert_eq!(row.config_version, 3);
    assert_eq!(row.amount_in, 1_000_000);
    assert_eq!(row.tx_digest, "0xabc");
    assert_eq!(row.event_seq, 7);
    assert_eq!(row.checkpoint, 42);
    assert!(!row.yield_included);
}
```

> Requires exposing the crate as a lib. Add to `Cargo.toml`: `[lib]\npath = "src/lib.rs"` and create `src/lib.rs` with `pub mod schema; pub mod models; pub mod events; pub mod handler;` (and have `main.rs` `use creatorflow_indexer::...`). Do this in Step 3.

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --test parse split_executed_bcs_round_trips_into_row`
Expected: FAIL — `events` unresolved / `parse_split_executed` undefined.

- [ ] **Step 3: Implement `events.rs`** (mirrors + pure parsers; same pattern for all 5 — full code shown, no "similar to" shortcuts)

```rust
use serde::Deserialize;
use sui_indexer_alt_framework::types::base_types::{ObjectID, SuiAddress};
use crate::models::*;

// ---- BCS mirrors (field order/types MUST match events.move) ----

#[derive(Deserialize, Debug)]
pub struct ConfigCreatedEvent {
    pub config_id: ObjectID,
    pub tax_vault_id: ObjectID,
    pub savings_vault_id: ObjectID,
    pub owner: SuiAddress,
}

#[derive(Deserialize, Debug, serde::Serialize)]
pub struct SplitExecutedEvent {
    pub config_id: ObjectID,
    pub config_version: u64,
    pub amount_in: u64,
    pub tax_amount: u64,
    pub savings_amount: u64,
    pub protocol_fee_amount: u64,
    pub yield_amount: u64,
    pub yield_included: bool,
    pub timestamp_ms: u64,
    // payouts: confirm against events.move. If SplitExecuted embeds a
    // `vector<RecipientPayout>`, add `pub payouts: Vec<RecipientPayoutEvent>` HERE
    // (BCS order matters) and flatten in parse_split_executed. If payouts are a
    // separate event, parse them via parse_recipient_payouts instead. VERIFY before coding.
}

#[derive(Deserialize, Debug, serde::Serialize)]
pub struct RecipientPayoutEvent {
    pub recipient: SuiAddress,
    pub amount: u64,
    pub bps: u16,
}

#[derive(Deserialize, Debug)]
pub struct ConfigMutatedEvent {
    pub config_id: ObjectID,
    pub old_version: u64,
    pub new_version: u64,
    pub mutator: SuiAddress,
}

#[derive(Deserialize, Debug)]
pub struct VaultWithdrawnEvent {
    pub vault_id: ObjectID,
    pub kind: u8,
    pub amount: u64,
    pub recipient: SuiAddress,
}

// ---- pure parsers: BCS bytes + context -> typed Row fields ----

pub fn parse_config_created(bytes: &[u8], tx: &str, ts_ms: i64) -> anyhow::Result<ConfigCreatedRow> {
    let e: ConfigCreatedEvent = bcs::from_bytes(bytes)?;
    Ok(ConfigCreatedRow {
        config_id: e.config_id.to_canonical_string(true),
        tx_digest: tx.to_string(),
        tax_vault_id: e.tax_vault_id.to_canonical_string(true),
        savings_vault_id: e.savings_vault_id.to_canonical_string(true),
        owner: e.owner.to_string(),
        checkpoint_timestamp_ms: ts_ms,
    })
}

pub fn parse_split_executed(bytes: &[u8], tx: &str, event_seq: i64, checkpoint: i64) -> anyhow::Result<SplitExecutedRow> {
    let e: SplitExecutedEvent = bcs::from_bytes(bytes)?;
    Ok(SplitExecutedRow {
        tx_digest: tx.to_string(),
        event_seq,
        config_id: e.config_id.to_canonical_string(true),
        config_version: e.config_version as i64,
        amount_in: e.amount_in as i64,
        tax_amount: e.tax_amount as i64,
        savings_amount: e.savings_amount as i64,
        protocol_fee_amount: e.protocol_fee_amount as i64,
        yield_amount: e.yield_amount as i64,
        yield_included: e.yield_included,
        timestamp_ms: e.timestamp_ms as i64,
        checkpoint,
    })
}

pub fn parse_config_mutated(bytes: &[u8], tx: &str, event_seq: i64, ts_ms: i64) -> anyhow::Result<ConfigMutatedRow> {
    let e: ConfigMutatedEvent = bcs::from_bytes(bytes)?;
    Ok(ConfigMutatedRow {
        tx_digest: tx.to_string(),
        event_seq,
        config_id: e.config_id.to_canonical_string(true),
        old_version: e.old_version as i64,
        new_version: e.new_version as i64,
        mutator: e.mutator.to_string(),
        checkpoint_timestamp_ms: ts_ms,
    })
}

pub fn parse_vault_withdrawn(bytes: &[u8], tx: &str, event_seq: i64, ts_ms: i64) -> anyhow::Result<VaultWithdrawnRow> {
    let e: VaultWithdrawnEvent = bcs::from_bytes(bytes)?;
    Ok(VaultWithdrawnRow {
        tx_digest: tx.to_string(),
        event_seq,
        vault_id: e.vault_id.to_canonical_string(true),
        kind: e.kind as i16,
        amount: e.amount as i64,
        recipient: e.recipient.to_string(),
        checkpoint_timestamp_ms: ts_ms,
    })
}
```

> **VERIFY against `events.move` before running:** field names/order/types and the SplitExecuted↔RecipientPayout relationship (embedded vector vs separate event). The Phase-1 notes say `RecipientPayout` is a constructor used inside `SplitExecuted` — if it is an embedded `vector<RecipientPayout>`, add the `payouts` field to `SplitExecutedEvent` and a `parse_payouts(&SplitExecutedEvent, tx, seq) -> Vec<RecipientPayoutRow>` helper. Adjust the test in Step 1 accordingly. `bps: u16` matches the Move type — keep it `u16` in the mirror, widen to `i32` in the row.

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test --test parse`
Expected: PASS.

- [ ] **Step 5: Add monkey-test cases** (test.md mandate) to `tests/parse.rs`: zero amounts, `yield_included=true` with `yield_amount=0`, empty payouts vector (if embedded), `bps` boundary `10000`, and a deliberately truncated `bytes` slice asserting `parse_*` returns `Err` (not panic).

Run: `cargo test --test parse`
Expected: all PASS.

- [ ] **Step 6: Commit** (skip — not a git repo)

---

### Task 5: `process()` — filter checkpoint events → `Vec<Row>`

**Files:**
- Create: `indexer/creatorflow-indexer/src/handler.rs`
- Modify: `indexer/creatorflow-indexer/src/lib.rs` (already declares `mod handler`)

- [ ] **Step 1: Write the failing test** (`tests/parse.rs` — extend; keeps DB out of this layer)

```rust
// Build a synthetic Event and assert the dispatcher routes by (module, name).
#[test]
fn dispatch_routes_events_by_name() {
    use creatorflow_indexer::handler::classify;
    assert_eq!(classify("events", "ConfigCreated"), Some(creatorflow_indexer::handler::Kind::Config));
    assert_eq!(classify("events", "SplitExecuted"), Some(creatorflow_indexer::handler::Kind::Split));
    assert_eq!(classify("events", "Unknown"), None);
    assert_eq!(classify("other", "ConfigCreated"), None);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --test parse dispatch_routes_events_by_name`
Expected: FAIL — `handler::classify` undefined.

- [ ] **Step 3: Implement `handler.rs` Processor half**

```rust
use std::sync::Arc;
use async_trait::async_trait;
use sui_indexer_alt_framework::pipeline::Processor;
use sui_indexer_alt_framework::types::full_checkpoint_content::CheckpointData;
use crate::events;
use crate::models::Row;

#[derive(Debug, PartialEq, Eq)]
pub enum Kind { Config, Split, Mutated, Withdrawn }

/// Pure routing: which event-name in the `events` module maps to which row kind.
pub fn classify(module: &str, name: &str) -> Option<Kind> {
    if module != "events" { return None; }
    match name {
        "ConfigCreated" => Some(Kind::Config),
        "SplitExecuted" => Some(Kind::Split),
        "ConfigMutated" => Some(Kind::Mutated),
        "VaultWithdrawn" => Some(Kind::Withdrawn),
        _ => None,
    }
}

pub struct CreatorflowHandler {
    pub package: sui_indexer_alt_framework::types::base_types::ObjectID,
}

impl Processor for CreatorflowHandler {
    const NAME: &'static str = "creatorflow";
    type Value = Row;

    async fn process(&self, checkpoint: &Arc<CheckpointData>) -> anyhow::Result<Vec<Row>> {
        let cp = checkpoint.checkpoint_summary.sequence_number as i64;
        let cp_ts = checkpoint.checkpoint_summary.timestamp_ms as i64;
        let mut out = Vec::new();

        for tx in &checkpoint.transactions {
            let digest = tx.transaction.digest().base58_encode();
            // event_seq = index of the event within the tx (Sui's canonical event key)
            let Some(events) = tx.events.as_ref() else { continue };
            for (seq, ev) in events.data.iter().enumerate() {
                if ev.type_.address != self.package.into() { continue; }
                let module = ev.type_.module.as_str();
                let name = ev.type_.name.as_str();
                let Some(kind) = classify(module, name) else { continue };
                let seq = seq as i64;
                let b = &ev.contents;
                match kind {
                    Kind::Config => out.push(Row::Config(events::parse_config_created(b, &digest, cp_ts)?)),
                    Kind::Split => {
                        out.push(Row::Split(events::parse_split_executed(b, &digest, seq, cp)?));
                        // If payouts are an embedded vector, also push Row::Payout rows here
                        // via the parse_payouts helper (see Task 4 note).
                    }
                    Kind::Mutated => out.push(Row::Mutated(events::parse_config_mutated(b, &digest, seq, cp_ts)?)),
                    Kind::Withdrawn => out.push(Row::Withdrawn(events::parse_vault_withdrawn(b, &digest, seq, cp_ts)?)),
                }
            }
        }
        Ok(out)
    }
}
```

> **VERIFY field paths against the resolved crate rev** (Task 1 discovery): `checkpoint.checkpoint_summary.{sequence_number,timestamp_ms}`, `tx.events.as_ref().data`, `ev.type_.{address,module,name}`, `ev.contents`, `tx.transaction.digest()`. These names match the `full_checkpoint_content::CheckpointData` shape but the exact accessors can shift across revs — fix against `cargo doc` if a path is wrong. `tx_digest` is base58 here (Sui's canonical digest form) — make sure the Phase-3 API and any e2e expectations use the same encoding (NOT 0x-hex).

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test --test parse dispatch_routes_events_by_name && cargo build`
Expected: test PASS, crate builds.

- [ ] **Step 5: Commit** (skip — not a git repo)

---

### Task 6: `commit()` — transactional, idempotent multi-table insert (TDD, needs Postgres)

**Files:**
- Modify: `indexer/creatorflow-indexer/src/handler.rs` (add `sequential::Handler` impl)
- Test: `indexer/creatorflow-indexer/tests/commit.rs`

- [ ] **Step 1: Write the failing integration test** (`tests/commit.rs`)

```rust
// Requires a reachable Postgres at $DATABASE_URL with migrations applied.
// Asserts: (a) a mixed batch writes every table; (b) replaying the SAME batch
// produces no duplicates (idempotent upsert) — the core durability guarantee.
use creatorflow_indexer::handler::commit_rows;
use creatorflow_indexer::models::*;
use diesel_async::{AsyncPgConnection, AsyncConnection, RunQueryDsl};

async fn conn() -> AsyncPgConnection {
    AsyncPgConnection::establish(&std::env::var("DATABASE_URL").unwrap()).await.unwrap()
}

#[tokio::test]
async fn commit_is_idempotent_across_tables() {
    let mut c = conn().await;
    let batch = vec![
        Row::Config(ConfigCreatedRow {
            config_id: "0x01".into(), tx_digest: "d1".into(),
            tax_vault_id: "0x02".into(), savings_vault_id: "0x03".into(),
            owner: "0x04".into(), checkpoint_timestamp_ms: 1,
        }),
        Row::Split(SplitExecutedRow {
            tx_digest: "d1".into(), event_seq: 0, config_id: "0x01".into(),
            config_version: 1, amount_in: 100, tax_amount: 5, savings_amount: 9,
            protocol_fee_amount: 1, yield_amount: 0, yield_included: false,
            timestamp_ms: 1, checkpoint: 1,
        }),
    ];

    let n1 = commit_rows(&batch, &mut c).await.unwrap();
    let n2 = commit_rows(&batch, &mut c).await.unwrap(); // replay
    assert!(n1 >= 2);
    assert_eq!(n2, 0, "replay must insert zero rows");

    use creatorflow_indexer::schema::config_created::dsl::*;
    let cnt: i64 = config_created.count().get_result(&mut c).await.unwrap();
    assert_eq!(cnt, 1);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd indexer/creatorflow-indexer && DATABASE_URL=postgres://creatorflow:creatorflow@localhost:5432/creatorflow_indexer cargo test --test commit`
Expected: FAIL — `commit_rows` undefined.

- [ ] **Step 3: Implement `commit_rows` + the `sequential::Handler` impl in `handler.rs`**

```rust
use diesel_async::{AsyncPgConnection, RunQueryDsl, scoped_futures::ScopedFutureExt, AsyncConnection};
use sui_indexer_alt_framework::pipeline::sequential::Handler;

/// Group a heterogeneous batch by table and bulk-insert each inside ONE
/// transaction. `ON CONFLICT DO NOTHING` on every table → replaying a checkpoint
/// (framework retry / restart before watermark advance) is a no-op. Returns rows
/// actually inserted.
pub async fn commit_rows(batch: &[Row], conn: &mut AsyncPgConnection) -> anyhow::Result<usize> {
    use crate::schema::*;
    let mut configs = Vec::new();
    let mut splits = Vec::new();
    let mut payouts = Vec::new();
    let mut mutateds = Vec::new();
    let mut withdrawns = Vec::new();
    for r in batch {
        match r {
            Row::Config(x) => configs.push(x.clone()),
            Row::Split(x) => splits.push(x.clone()),
            Row::Payout(x) => payouts.push(x.clone()),
            Row::Mutated(x) => mutateds.push(x.clone()),
            Row::Withdrawn(x) => withdrawns.push(x.clone()),
        }
    }

    let inserted = conn.transaction::<usize, anyhow::Error, _>(|conn| async move {
        let mut n = 0;
        // split_executed BEFORE recipient_payout (FK order).
        n += diesel::insert_into(config_created::table).values(&configs)
            .on_conflict_do_nothing().execute(conn).await?;
        n += diesel::insert_into(split_executed::table).values(&splits)
            .on_conflict_do_nothing().execute(conn).await?;
        n += diesel::insert_into(recipient_payout::table).values(&payouts)
            .on_conflict_do_nothing().execute(conn).await?;
        n += diesel::insert_into(config_mutated::table).values(&mutateds)
            .on_conflict_do_nothing().execute(conn).await?;
        n += diesel::insert_into(vault_withdrawn::table).values(&withdrawns)
            .on_conflict_do_nothing().execute(conn).await?;
        Ok(n)
    }.scope_boxed()).await?;
    Ok(inserted)
}

#[async_trait::async_trait]
impl Handler for CreatorflowHandler {
    // Bridge the framework's Handler::commit to commit_rows. The exact associated
    // types / connection handle come from the resolved rev — adapt the signature
    // to what `sui_indexer_alt_framework::pipeline::sequential::Handler` declares
    // (it passes a pooled connection; call commit_rows with it).
    async fn commit(values: &[Self::Value], conn: &mut Self::Store /* per-rev */) -> anyhow::Result<usize> {
        commit_rows(values, conn).await
    }
}
```

> The exact `Handler` associated types (`Store`/connection type, whether `commit` is `&self` or assoc-fn, batch ownership) depend on the resolved rev — the `commit_rows` free fn holds all logic so the trait impl is a thin adapter. Fix the impl signature against `cargo doc` for `pipeline::sequential::Handler`; do NOT move logic into it.

- [ ] **Step 4: Run to verify it passes**

Run: `DATABASE_URL=... cargo test --test commit`
Expected: PASS — replay inserts 0, count==1.

- [ ] **Step 5: Monkey cases** (test.md): empty batch (commit returns 0, no tx error), batch with only payouts whose parent split already exists, duplicate `(tx_digest,event_seq)` within one batch (dedupe-by-conflict). Add to `tests/commit.rs`, run, all PASS.

- [ ] **Step 6: Commit** (skip — not a git repo)

---

### Task 7: Wire `main.rs` — sequential pipeline + ingestion + metrics

**Files:**
- Modify: `indexer/creatorflow-indexer/src/main.rs`

- [ ] **Step 1: Implement `main.rs`** (cluster path; falls back to manual `Indexer::new` if the cluster builder differs on the resolved rev)

```rust
use std::str::FromStr;
use clap::Parser;
use sui_indexer_alt_framework::cli::Args;
use sui_indexer_alt_framework::cluster::IndexerCluster;
use sui_indexer_alt_framework::pipeline::sequential::{sequential_pipeline, SequentialConfig};
use sui_indexer_alt_framework::types::base_types::ObjectID;
use creatorflow_indexer::handler::CreatorflowHandler;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    let args = Args::parse();

    let package = ObjectID::from_str(&std::env::var("CREATORFLOW_PKG")?)?;
    let db_pool = IndexerCluster::build_db_pool(&args.database_url).await?;
    let cluster = IndexerCluster::builder(args.clone(), db_pool.clone()).await?;

    let handler = CreatorflowHandler { package };
    cluster.run(sequential_pipeline(handler, db_pool, SequentialConfig::default())).await
}
```

> Adapt to the resolved rev: the `cluster::IndexerCluster` + `sequential_pipeline` shape is from the framework's `build.mdx` example. If the rev exposes only the manual `Indexer::new(store, IndexerArgs, ClientArgs{ ingestion: IngestionClientArgs{ rpc_api_url, remote_store_url, .. } }, IngestionConfig, &Registry, CancellationToken)` path (per `bring-your-own-store.mdx`), use that instead and call `indexer.sequential_pipeline(handler, SequentialConfig::default()).await?; indexer.run().await`. Pull `SUI_FULLNODE`/`SUI_REMOTE_STORE`/`START_CHECKPOINT` from env into `ClientArgs`/`IndexerArgs`. Metrics: the cluster wires Prometheus automatically; for the manual path pass a `prometheus::Registry` and the framework serves `:9184`.

- [ ] **Step 2: Build**

Run: `cargo build --release`
Expected: clean. This is the full-service compile gate.

- [ ] **Step 3: Smoke run against testnet** (read-only ingest; safe even pre-deploy — it just finds zero matching events)

Run: `DATABASE_URL=... CREATORFLOW_PKG=0x0 SUI_FULLNODE=https://fullnode.testnet.sui.io:443 cargo run --release`
Expected: connects, begins advancing checkpoints, logs ingestion progress, `:9184/metrics` serves `indexer_*` gauges. Ctrl-C → clean shutdown. (With `CREATORFLOW_PKG=0x0`, no rows written — confirms the pipeline runs without depending on the deploy.)

- [ ] **Step 4: Commit** (skip — not a git repo)

---

### Task 8: Review + notes

**Files:** `move-notes.md`, `tasks/progress.md` (no code)

- [ ] **Step 1: Review.** This is Rust (non-Move, non-SUI-Move) → per `.claude/rules/skill-routing.md` the Move-specific reviewers do NOT apply; use the generic two-round review from `~/.claude/rules/general/dev-rules.md` (`/dual-review`): round-1 codex on the diff, round-2 project-rules. Focus areas: BCS field-order correctness vs `events.move` (a silent mismatch corrupts every row), `ON CONFLICT DO NOTHING` present on all 5 inserts, `i64` casts can't overflow for USDC 6-dec (spec-confirmed), no `unwrap()` on network/DB paths in `process`/`commit`.

- [ ] **Step 2: Append to `move-notes.md`** a dated Phase-2 section: resolved framework rev + corrected import paths, the 3 spec-vs-reality conflicts and resolutions (diesel/BCS/enum-Value sequential pipeline), tx_digest base58 encoding decision, and any accessor paths that differed from this plan.

- [ ] **Step 3: Update `tasks/progress.md`** — mark Indexer Phase 2 done (or partial if e2e blocked on deploy), note Phase 3 (TS Drizzle mirror + Hono REST) is next and now has a live schema to `drizzle-kit pull` from.

- [ ] **Step 4: Commit** (skip — not a git repo)

---

## Self-Review (completed by plan author)

**1. Spec coverage:**
- "Ingest (Rust) — checkpoint pipeline → Postgres, watermark resume, adaptive concurrency, metrics" → Tasks 1,5,6,7 (framework provides watermark/concurrency/metrics; sequential chosen for ordering). ✓
- "single processor handles ALL 4 event types, single watermark, atomic write" → Task 5 (one Handler) + Task 6 (one transaction) + Task 7 (one sequential pipeline). Note: 5 row types (4 events + flattened RecipientPayout). ✓
- "filter event.type_.address==PKG && module==events && name==<Event>" → Task 5 `process`/`classify`. ✓
- "parsed_json shape / u64-as-string / normalize" → **superseded** by BCS decode (conflict #2, documented). ✓
- "Shared Postgres schema (5 tables)" → Task 2 migration, verbatim. ✓
- "(tx_digest,event_seq) idempotent upsert" → Task 6 `ON CONFLICT DO NOTHING` + idempotency test. ✓
- "u64→bigint safe" → Task 3/4 `i64`. ✓
- "watermark table managed by framework" → not hand-built; Task 2 note. ✓
- "events without on-chain ts use checkpoint timestamp_ms" → Task 4/5 (`cp_ts` for Config/Mutated/Withdrawn; SplitExecuted uses its own `timestamp_ms`). ✓
- "Config/env: DATABASE_URL, CREATORFLOW_PKG, SUI_FULLNODE, START_CHECKPOINT" → Task 1 `.env.example` + Task 7 wiring. ✓
- Testing strategy "Rust ingest: synthetic fixture, idempotency, payout flattening, real parsed_json/BCS shape" → Tasks 4 (parse + monkey) + 6 (commit idempotency). Full-CheckpointData e2e deferred to deploy (spec marks e2e optional/blocked). ✓
- Read API / Drizzle / Hono → **out of scope** (Phase 3, separate plan). ✓

**2. Placeholder scan:** No "TBD"/"add error handling"/"write tests for the above". The two unavoidable rev-dependent spots (framework builder signature, `Handler` associated types) carry explicit verification instructions + a self-contained fallback, with all real logic in pure fns that don't depend on the rev. The one genuine pre-coding verification — SplitExecuted↔RecipientPayout BCS layout — is flagged in Tasks 4 & 5 with both branches specified. ✓

**3. Type consistency:** `parse_split_executed(bytes, tx, event_seq, checkpoint)` and the `Row`/`*Row` field names are identical across Tasks 3,4,5,6. `classify`/`Kind` identical across Task 5 def + test. `commit_rows(&[Row], &mut AsyncPgConnection)` identical across Task 6 def, test, and the Handler adapter. ✓

## Git note

This directory is NOT a git repository (`git rev-parse` fails). Skip all `git commit` steps, OR `git init` first if version control is wanted. `cargo build` + `cargo test` are the verification gates, not commits.
```