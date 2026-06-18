//! The single CreatorFlow pipeline: one `Processor` that BCS-decodes the 5
//! protocol events out of each checkpoint, and one **sequential** `Handler`
//! whose `commit` writes every table. Sequential (not concurrent) → the
//! framework runs `commit` + the watermark bump inside ONE transaction in
//! strict checkpoint order, giving the single-watermark / atomic-cross-table
//! guarantee the round-2 architecture review required (no per-table skew, and
//! `recipient_payout`'s FK to `split_executed` never splits across batches).

use std::sync::Arc;

use async_trait::async_trait;
use diesel_async::RunQueryDsl;
use sui_indexer_alt_framework::pipeline::Processor;
use sui_indexer_alt_framework::pipeline::sequential::Handler;
use sui_indexer_alt_framework::postgres::{Connection, Db};
use sui_indexer_alt_framework::types::base_types::ObjectID;
use sui_indexer_alt_framework::types::full_checkpoint_content::Checkpoint;

use crate::events;
use crate::models::Row;

#[derive(Debug, PartialEq, Eq)]
pub enum Kind {
    Config,
    Split,
    Mutated,
    Withdrawn,
}

/// Pure routing: which event-name in the `events` module maps to which row kind.
/// `RecipientPayout` is intentionally absent — it is an embedded vector inside
/// `SplitExecuted`, flattened during `Split` parsing, never a standalone event.
pub fn classify(module: &str, name: &str) -> Option<Kind> {
    if module != "events" {
        return None;
    }
    match name {
        "ConfigCreated" => Some(Kind::Config),
        "SplitExecuted" => Some(Kind::Split),
        "ConfigMutated" => Some(Kind::Mutated),
        "VaultWithdrawn" => Some(Kind::Withdrawn),
        _ => None,
    }
}

pub struct CreatorflowHandler {
    pub package: ObjectID,
}

#[async_trait]
impl Processor for CreatorflowHandler {
    const NAME: &'static str = "creatorflow";
    type Value = Row;

    async fn process(&self, checkpoint: &Arc<Checkpoint>) -> anyhow::Result<Vec<Row>> {
        let cp = checkpoint.summary.sequence_number as i64;
        let cp_ts = checkpoint.summary.timestamp_ms as i64;
        let mut out = Vec::new();

        for tx in &checkpoint.transactions {
            let Some(events) = tx.events.as_ref() else {
                continue;
            };
            // event_seq = index of the event within the tx (Sui's canonical event key).
            let mut digest: Option<String> = None;
            for (seq, ev) in events.data.iter().enumerate() {
                if ev.package_id != self.package {
                    continue;
                }
                let Some(kind) = classify(ev.type_.module.as_str(), ev.type_.name.as_str()) else {
                    continue;
                };
                // Compute the digest lazily, only when this tx actually has a match.
                let tx_digest =
                    digest.get_or_insert_with(|| tx.transaction.digest().base58_encode());
                let seq = seq as i64;
                let b = &ev.contents;
                match kind {
                    Kind::Config => {
                        out.push(Row::Config(events::parse_config_created(b, tx_digest, cp_ts)?))
                    }
                    Kind::Split => {
                        let (split, payouts) =
                            events::parse_split_executed(b, tx_digest, seq, cp)?;
                        out.push(Row::Split(split));
                        out.extend(payouts.into_iter().map(Row::Payout));
                    }
                    Kind::Mutated => out.push(Row::Mutated(events::parse_config_mutated(
                        b, tx_digest, seq, cp_ts,
                    )?)),
                    Kind::Withdrawn => out.push(Row::Withdrawn(events::parse_vault_withdrawn(
                        b, tx_digest, seq, cp_ts,
                    )?)),
                }
            }
        }
        Ok(out)
    }
}

/// Group a heterogeneous batch by table and insert each, `split_executed`
/// BEFORE `recipient_payout` (FK order). `ON CONFLICT DO NOTHING` on every table
/// → replaying a checkpoint (framework retry / restart before the watermark
/// advances) is a no-op. Returns the number of rows actually inserted.
///
/// No explicit transaction here: under the sequential pipeline the framework
/// already wraps this call + the watermark update in one transaction. The
/// standalone idempotency test calls it outside that wrapper, which is fine —
/// the per-row `ON CONFLICT` is what makes replay safe either way.
pub async fn commit_rows(batch: &[Row], conn: &mut Connection<'_>) -> anyhow::Result<usize> {
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

    let mut n = 0;
    if !configs.is_empty() {
        n += diesel::insert_into(config_created::table)
            .values(&configs)
            .on_conflict_do_nothing()
            .execute(conn)
            .await?;
    }
    if !splits.is_empty() {
        n += diesel::insert_into(split_executed::table)
            .values(&splits)
            .on_conflict_do_nothing()
            .execute(conn)
            .await?;
    }
    if !payouts.is_empty() {
        n += diesel::insert_into(recipient_payout::table)
            .values(&payouts)
            .on_conflict_do_nothing()
            .execute(conn)
            .await?;
    }
    if !mutateds.is_empty() {
        n += diesel::insert_into(config_mutated::table)
            .values(&mutateds)
            .on_conflict_do_nothing()
            .execute(conn)
            .await?;
    }
    if !withdrawns.is_empty() {
        n += diesel::insert_into(vault_withdrawn::table)
            .values(&withdrawns)
            .on_conflict_do_nothing()
            .execute(conn)
            .await?;
    }
    Ok(n)
}

#[async_trait]
impl Handler for CreatorflowHandler {
    type Store = Db;
    type Batch = Vec<Row>;

    fn batch(&self, batch: &mut Self::Batch, values: std::vec::IntoIter<Self::Value>) {
        batch.extend(values);
    }

    async fn commit<'a>(&self, batch: &Self::Batch, conn: &mut Connection<'a>) -> anyhow::Result<usize> {
        commit_rows(batch, conn).await
    }
}
