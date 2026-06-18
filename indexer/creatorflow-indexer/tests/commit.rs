//! diesel idempotency integration test. Requires a reachable Postgres at
//! $DATABASE_URL with the migration applied (the harness applies it via the
//! framework `Db` below). Asserts: (a) a mixed batch writes every table;
//! (b) replaying the SAME batch inserts zero rows — the core durability
//! guarantee that makes checkpoint replay (framework retry / restart) a no-op.

use creatorflow_indexer::handler::commit_rows;
use creatorflow_indexer::models::*;
use diesel_async::RunQueryDsl;
use sui_indexer_alt_framework::postgres::{Db, DbArgs};
use url::Url;

async fn fresh_db() -> Db {
    let url = Url::parse(&std::env::var("DATABASE_URL").unwrap()).unwrap();
    let db = Db::for_write(url, DbArgs::default()).await.unwrap();
    // Apply the schema (idempotent: drop+create) so each run starts clean. The
    // connection borrows `db`, so scope it to drop before `db` is returned.
    {
        let mut conn = db.connect().await.unwrap();
        // diesel-async sends each query as a prepared statement, which rejects
        // multi-command strings — split up.sql into single statements.
        let drop = "DROP TABLE IF EXISTS recipient_payout, vault_withdrawn, config_mutated, split_executed, config_created CASCADE";
        let up = include_str!("../migrations/2026-06-16-000001_creatorflow_schema/up.sql");
        let stmts = std::iter::once(drop).chain(
            up.split(';').map(str::trim).filter(|s| !s.is_empty()),
        );
        for stmt in stmts {
            diesel::sql_query(stmt).execute(&mut conn).await.unwrap();
        }
    }
    db
}

fn config(id: &str) -> Row {
    Row::Config(ConfigCreatedRow {
        config_id: id.into(),
        tx_digest: "d1".into(),
        tax_vault_id: "0x02".into(),
        savings_vault_id: "0x03".into(),
        owner: "0x04".into(),
        checkpoint_timestamp_ms: 1,
    })
}

fn split(seq: i64) -> Row {
    Row::Split(SplitExecutedRow {
        tx_digest: "d1".into(),
        event_seq: seq,
        config_id: "0x01".into(),
        config_version: 1,
        amount_in: 100,
        tax_amount: 5,
        savings_amount: 9,
        protocol_fee_amount: 1,
        yield_amount: 0,
        yield_included: false,
        timestamp_ms: 1,
        checkpoint: 1,
    })
}

fn payout(seq: i64, idx: i32) -> Row {
    Row::Payout(RecipientPayoutRow {
        tx_digest: "d1".into(),
        event_seq: seq,
        payout_idx: idx,
        recipient: "0x05".into(),
        amount: 50,
        bps: 5000,
    })
}

#[tokio::test]
async fn commit_is_idempotent_across_tables() {
    let db = fresh_db().await;
    let mut conn = db.connect().await.unwrap();

    let batch = vec![config("0x01"), split(0), payout(0, 0), payout(0, 1)];

    let n1 = commit_rows(&batch, &mut conn).await.unwrap();
    let n2 = commit_rows(&batch, &mut conn).await.unwrap(); // replay
    assert_eq!(n1, 4, "first commit writes config + split + 2 payouts");
    assert_eq!(n2, 0, "replay must insert zero rows");

    use creatorflow_indexer::schema::config_created::dsl as c;
    use diesel::dsl::count_star;
    use diesel::QueryDsl;
    let cnt: i64 = c::config_created
        .select(count_star())
        .get_result(&mut conn)
        .await
        .unwrap();
    assert_eq!(cnt, 1);
}

#[tokio::test]
async fn empty_batch_is_noop() {
    let db = fresh_db().await;
    let mut conn = db.connect().await.unwrap();
    let n = commit_rows(&[], &mut conn).await.unwrap();
    assert_eq!(n, 0);
}

#[tokio::test]
async fn payout_with_preexisting_parent_split() {
    let db = fresh_db().await;
    let mut conn = db.connect().await.unwrap();

    // Parent split committed in an earlier batch (FK target already present).
    let n1 = commit_rows(&[split(7)], &mut conn).await.unwrap();
    assert_eq!(n1, 1);
    // Later batch carries only the payout — FK holds because parent exists.
    let n2 = commit_rows(&[payout(7, 0)], &mut conn).await.unwrap();
    assert_eq!(n2, 1);
}

#[tokio::test]
async fn duplicate_keys_within_one_batch_dedupe_by_conflict() {
    let db = fresh_db().await;
    let mut conn = db.connect().await.unwrap();
    // Two configs with the same PK in one batch — ON CONFLICT collapses to one.
    let n = commit_rows(&[config("0xAA"), config("0xAA")], &mut conn)
        .await
        .unwrap();
    assert_eq!(n, 1, "duplicate PK within a batch inserts once");
}
