# CreatorFlow Indexer — Design (GTM hybrid)

> 2026-06-15 · Status: approved design, pre-implementation
> Authority spec: `docs/specs/2026-05-28-creatorflow-architecture-spec.md` §8

## Goal

Production/GTM-grade indexer for CreatorFlow on-chain events. Two layers joined
by a shared Postgres schema:

- **Ingest (Rust)** — `sui-indexer-alt-framework` checkpoint pipeline → Postgres.
  Owns correctness, durability (watermark resume), adaptive concurrency, metrics.
- **Read API (TypeScript)** — Drizzle read-only mirror + Hono REST. Shares types
  with the Next.js dashboard.

Resolves the spec §8 internal conflict (Drizzle vs "Protocol 124 framework"):
Rust owns ingest + sqlx migrations (single source of truth); Drizzle is a
read-only introspected mirror, NOT a second migration system.

Vault **current balances** stay on gRPC (not indexer) per spec §8 data-access
decision. Indexer owns: historical splits, collaborator search, config registry,
mutation history, withdrawal history, revenue aggregates.

## Architecture

```
Sui testnet checkpoint stream
        │
        ▼
  creatorflow-indexer (Rust)            ── ingest layer
    Service + 1 processor (CreatorflowProcessor) — handles ALL 4 event types
    in a single per-checkpoint pass (single watermark, atomic write):
      ConfigCreated | SplitExecuted (+flatten payouts) | ConfigMutated | VaultWithdrawn
    Why single (not 4 parallel) processors: 4 independent processors advance on
    independent watermarks → temporal skew (a SplitExecuted's config_id can land
    before its config_created row; cross-table refs have NO ordering guarantee).
    One processor = one watermark = per-checkpoint atomicity, killing that skew
    class. Event volume (single-creator payments protocol) needs no 4-way parallelism.
    filter: event.type_.address == PKG && module == "events" && name == <Event>
    parsed_json -> row, sqlx upsert ON CONFLICT DO NOTHING (idempotent)
    parsed_json shape: u64 fields are STRINGS ("1000000" -> str->i64 parse);
    ID/address are 0x+64hex -> normalize (lowercase, zero-pad to 32 bytes) on insert.
    framework-managed: watermark/resume, adaptive concurrency, Prometheus :9184
        │ writes
        ▼
   PostgreSQL  ── interface: shared schema, Rust sqlx migrations = source of truth
        │ reads (read-only)
        ▼
  creatorflow-api (TypeScript)          ── read layer
    Drizzle read-only mirror (drizzle-kit pull, no migrations)
    Hono REST (edge-ready); GraphQL deferred (schema does not preclude)
    shared Drizzle types -> dashboard
```

## Required contract change (Move)

`create_config_and_vaults` currently emits nothing → indexer can't discover new
configs or map vault→config. Add a **`ConfigCreated`** event.

- New `events::ConfigCreated { config_id, tax_vault_id, savings_vault_id, owner }`
  (`copy, drop`), `public(package)` emit fn — stays inside `events` leaf module,
  does NOT break events-as-leaf topology.
- `owner = ctx.sender()` — the only trustworthy source for "list my configs".
- **No bps snapshot.** bps are mutable (`mutate_config` bumps version). Point-in-
  time bps is reconstructed from `SplitExecuted.config_version` + `config_mutated`
  history, not a create-time snapshot (would go stale + costs event gas).
- **Emission MUST be after `wire_vaults`** in `router::create_config_and_vaults`.
  Before wiring, vault IDs are the `@0x0` sentinel (ID-cycle break, arch spec §1).
  Non-obvious ordering dependency — flag in plan.
- Add tests: `events_tests` (field round-trip), `router_tests` (emitted once,
  carries real wired vault IDs). Re-run `sui move test` (58 → +N green).

## Shared Postgres schema (sqlx migrations)

```sql
config_created (
  config_id        text PRIMARY KEY,
  tx_digest        text not null,
  tax_vault_id     text not null,
  savings_vault_id text not null,
  owner            text not null,
  checkpoint_timestamp_ms bigint not null
);
CREATE INDEX ON config_created (owner);

split_executed (
  tx_digest text, event_seq bigint,
  config_id text not null, config_version bigint not null,
  amount_in bigint not null, tax_amount bigint not null,
  savings_amount bigint not null, protocol_fee_amount bigint not null,
  yield_amount bigint not null, yield_included boolean not null,
  timestamp_ms bigint not null,        -- from SplitExecuted (on-chain clock)
  checkpoint bigint not null,
  PRIMARY KEY (tx_digest, event_seq)
);
CREATE INDEX ON split_executed (config_id, timestamp_ms DESC);

recipient_payout (
  tx_digest text, event_seq bigint, payout_idx int,
  recipient text not null, amount bigint not null, bps int not null,
  PRIMARY KEY (tx_digest, event_seq, payout_idx),
  FOREIGN KEY (tx_digest, event_seq) REFERENCES split_executed
);
CREATE INDEX ON recipient_payout (recipient);

config_mutated (
  tx_digest text, event_seq bigint,
  config_id text not null, old_version bigint not null, new_version bigint not null,
  mutator text not null, checkpoint_timestamp_ms bigint not null,
  PRIMARY KEY (tx_digest, event_seq)
);

vault_withdrawn (
  tx_digest text, event_seq bigint,
  vault_id text not null, kind smallint not null,   -- 0=tax 1=savings
  amount bigint not null, recipient text not null,
  checkpoint_timestamp_ms bigint not null,
  PRIMARY KEY (tx_digest, event_seq)
);
```

Notes:
- `(tx_digest, event_seq)` = Sui's canonical event unique key → idempotent upsert.
- u64 → `bigint` (i64) safe for USDC 6-dec (i64 max ≈ 9.2e18 ≫ realistic supply).
- watermark/resume table managed BY the framework — not hand-built here.
- events without on-chain timestamp (ConfigCreated/ConfigMutated/VaultWithdrawn)
  use `checkpoint_summary.timestamp_ms`.

## Read API (REST, Hono)

| Endpoint | Purpose | Tables |
|---|---|---|
| `GET /configs?owner=0x..` | list configs by owner | config_created |
| `GET /configs/:id` | config detail + latest version | config_created (+ latest config_mutated) |
| `GET /configs/:id/splits?cursor=&limit=` | paginated split history | split_executed (+ payouts) |
| `GET /configs/:id/mutations` | mutation history | config_mutated |
| `GET /collaborators/:addr/earnings?cursor=` | cross-config earnings + detail | recipient_payout JOIN split_executed |
| `GET /vaults/:id/withdrawals` | withdrawal history + config_id | vault_withdrawn JOIN config_created |
| `GET /configs/:id/summary` | revenue/payout/count aggregates | split_executed agg |

- Keyset pagination on `(timestamp_ms, tx_digest)` (not offset) for GTM stability.
- `vault_withdrawn` → config via **LEFT** `JOIN config_created ON vault_id IN
  (tax_vault_id, savings_vault_id)`. LEFT (not INNER) so a withdrawal/split whose
  `config_created` row has not yet been written does not vanish — config_id is null
  until the row catches up. (Single-processor design makes same-checkpoint races
  impossible, but cross-checkpoint create→withdraw ordering still warrants LEFT.)

## Config / env

- Rust: `DATABASE_URL`, `CREATORFLOW_PKG`, `SUI_FULLNODE` (testnet),
  `START_CHECKPOINT` (backfill; default resumes from watermark).
- `CREATORFLOW_PKG` injected post-deploy; indexer codes against schema now
  (package not yet deployed — non-blocker).
- TS: `DATABASE_URL` (read-only role recommended).

## Testing strategy

- **Move**: ConfigCreated round-trip + emitted-once-with-real-vault-IDs;
  `sui move test` fully green.
- **Rust ingest**: synthetic `CheckpointData` fixture carrying all 4 event types.
  Assert correct rows, idempotency (replay same checkpoint = no dupes), payout
  flattening. **Fixtures must use the real `parsed_json` shape** (addresses/IDs as
  `0x`-prefixed hex strings) — not assumed BCS bytes — or green tests break on chain.
- **TS API**: seed Postgres → hit every endpoint; assert pagination boundaries +
  cross-config collaborator aggregation.
- **Monkey** (test.md): empty recipient_payouts, zero amounts, very long history
  pagination, same addr appearing multiple times in one split, out-of-order
  checkpoint arrival.
- **e2e** (optional, blocked on deploy): real testnet deploy → PTB → ingest → API.

## Open / deferred

- GraphQL layer (schema does not preclude).
- Real e2e blocked on deploy + Circle USDC testnet address (shared blocker with
  gas benchmark + T10 load test).
- Architecture review (sui-architect) findings folded in:
  - Round 1: emit-after-wire ordering, drop bps snapshot, parsed_json shape in fixtures.
  - Round 2: single processor (not 4 parallel) to kill cross-processor watermark skew;
    LEFT JOIN config_created in API; u64-as-string parse + address normalization.
