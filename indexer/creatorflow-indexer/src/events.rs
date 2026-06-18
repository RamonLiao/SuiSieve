//! Move-event BCS mirror structs + pure parsers. This is the ONLY place that
//! knows the on-chain BCS layout. Field **order and types** MUST match
//! `move/creatorflow/sources/events.move` exactly — BCS is positional, a field
//! out of order silently corrupts every row.
//!
//! `ID` and `address` both BCS-encode as 32 raw bytes; `ObjectID`/`SuiAddress`
//! decode from those bytes and `.to_canonical_string(true)` yields the
//! `0x`+64-hex lowercase form for free (no manual normalization).

use crate::models::*;
use serde::{Deserialize, Serialize};
use sui_indexer_alt_framework::types::base_types::{ObjectID, SuiAddress};

// ---- BCS mirrors (field order/types MUST match events.move) ----

/// Mirrors `events::ConfigCreated { config_id, tax_vault_id, savings_vault_id, owner }`.
#[derive(Deserialize, Serialize, Debug)]
pub struct ConfigCreatedEvent {
    pub config_id: ObjectID,
    pub tax_vault_id: ObjectID,
    pub savings_vault_id: ObjectID,
    pub owner: SuiAddress,
}

/// Mirrors `events::RecipientPayout { addr, amount, bps }`. Field names are
/// irrelevant to BCS (order/type only); `recipient` here == Move's `addr`.
#[derive(Deserialize, Serialize, Debug)]
pub struct RecipientPayoutEvent {
    pub recipient: SuiAddress,
    pub amount: u64,
    pub bps: u16,
}

/// Mirrors `events::SplitExecuted`. CRITICAL: `recipient_payouts` is the 4th
/// field (between `amount_in` and `tax_amount`) — an embedded
/// `vector<RecipientPayout>`, NOT a trailing/separate event.
#[derive(Deserialize, Serialize, Debug)]
pub struct SplitExecutedEvent {
    pub config_id: ObjectID,
    pub config_version: u64,
    pub amount_in: u64,
    pub recipient_payouts: Vec<RecipientPayoutEvent>,
    pub tax_amount: u64,
    pub savings_amount: u64,
    pub protocol_fee_amount: u64,
    pub yield_amount: u64,
    pub yield_included: bool,
    pub timestamp_ms: u64,
}

/// Mirrors `events::ConfigMutated { config_id, old_version, new_version, mutator }`.
#[derive(Deserialize, Serialize, Debug)]
pub struct ConfigMutatedEvent {
    pub config_id: ObjectID,
    pub old_version: u64,
    pub new_version: u64,
    pub mutator: SuiAddress,
}

/// Mirrors `events::VaultWithdrawn { vault_id, kind, amount, to }`.
#[derive(Deserialize, Serialize, Debug)]
pub struct VaultWithdrawnEvent {
    pub vault_id: ObjectID,
    pub kind: u8,
    pub amount: u64,
    pub recipient: SuiAddress,
}

/// Checked `u64 -> i64` for on-chain values stored in Postgres `BIGINT`. Move
/// amounts/versions/timestamps are `u64`; Postgres has no unsigned integer.
/// Values in `[2^63, 2^64)` would silently wrap to a negative `i64` — for the
/// revenue fact table that is silent corruption, so we fail loud instead. A
/// genuine overflow stalls the (single) pipeline watermark loudly rather than
/// poisoning analytics. Realistic USDC (6-dec u64) is ~5 orders below i64::MAX.
fn to_i64(v: u64, field: &str) -> anyhow::Result<i64> {
    i64::try_from(v).map_err(|_| anyhow::anyhow!("{field} = {v} exceeds i64::MAX"))
}

// ---- pure parsers: BCS bytes + context -> typed Row(s) ----

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

/// Decode a `SplitExecuted` and project it into the parent `split_executed` row
/// PLUS the flattened `recipient_payout` rows (one per vector element, indexed
/// by `payout_idx`). Decodes once.
pub fn parse_split_executed(
    bytes: &[u8],
    tx: &str,
    event_seq: i64,
    checkpoint: i64,
) -> anyhow::Result<(SplitExecutedRow, Vec<RecipientPayoutRow>)> {
    let e: SplitExecutedEvent = bcs::from_bytes(bytes)?;
    let row = SplitExecutedRow {
        tx_digest: tx.to_string(),
        event_seq,
        config_id: e.config_id.to_canonical_string(true),
        config_version: to_i64(e.config_version, "config_version")?,
        amount_in: to_i64(e.amount_in, "amount_in")?,
        tax_amount: to_i64(e.tax_amount, "tax_amount")?,
        savings_amount: to_i64(e.savings_amount, "savings_amount")?,
        protocol_fee_amount: to_i64(e.protocol_fee_amount, "protocol_fee_amount")?,
        yield_amount: to_i64(e.yield_amount, "yield_amount")?,
        yield_included: e.yield_included,
        timestamp_ms: to_i64(e.timestamp_ms, "timestamp_ms")?,
        checkpoint,
    };
    let payouts = e
        .recipient_payouts
        .iter()
        .enumerate()
        .map(|(i, p)| {
            Ok(RecipientPayoutRow {
                tx_digest: tx.to_string(),
                event_seq,
                payout_idx: i as i32,
                recipient: p.recipient.to_string(),
                amount: to_i64(p.amount, "payout.amount")?,
                bps: p.bps as i32,
            })
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    Ok((row, payouts))
}

pub fn parse_config_mutated(
    bytes: &[u8],
    tx: &str,
    event_seq: i64,
    ts_ms: i64,
) -> anyhow::Result<ConfigMutatedRow> {
    let e: ConfigMutatedEvent = bcs::from_bytes(bytes)?;
    Ok(ConfigMutatedRow {
        tx_digest: tx.to_string(),
        event_seq,
        config_id: e.config_id.to_canonical_string(true),
        old_version: to_i64(e.old_version, "old_version")?,
        new_version: to_i64(e.new_version, "new_version")?,
        mutator: e.mutator.to_string(),
        checkpoint_timestamp_ms: ts_ms,
    })
}

pub fn parse_vault_withdrawn(
    bytes: &[u8],
    tx: &str,
    event_seq: i64,
    ts_ms: i64,
) -> anyhow::Result<VaultWithdrawnRow> {
    let e: VaultWithdrawnEvent = bcs::from_bytes(bytes)?;
    Ok(VaultWithdrawnRow {
        tx_digest: tx.to_string(),
        event_seq,
        vault_id: e.vault_id.to_canonical_string(true),
        kind: e.kind as i16,
        amount: to_i64(e.amount, "vault.amount")?,
        recipient: e.recipient.to_string(),
        checkpoint_timestamp_ms: ts_ms,
    })
}
