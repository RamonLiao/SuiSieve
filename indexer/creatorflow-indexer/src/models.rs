use crate::schema::*;
use diesel::prelude::*;

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
