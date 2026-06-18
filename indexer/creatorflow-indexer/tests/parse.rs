//! Pure BCS→Row parser tests (no DB). Each event is serialized with the SAME
//! mirror struct the parser decodes with, so a field-order regression in the
//! mirror is caught here (the mirror order itself is verified by eye against
//! `move/creatorflow/sources/events.move`).

use creatorflow_indexer::events::{
    self, ConfigCreatedEvent, RecipientPayoutEvent, SplitExecutedEvent, VaultWithdrawnEvent,
};
use creatorflow_indexer::handler::{classify, Kind};
use sui_indexer_alt_framework::types::base_types::{ObjectID, SuiAddress};

#[test]
fn split_executed_bcs_round_trips_with_payouts() {
    let cfg = ObjectID::random();
    let r0 = SuiAddress::random_for_testing_only();
    let r1 = SuiAddress::random_for_testing_only();
    let ev = SplitExecutedEvent {
        config_id: cfg,
        config_version: 3,
        amount_in: 1_000_000,
        recipient_payouts: vec![
            RecipientPayoutEvent { recipient: r0, amount: 600_000, bps: 6000 },
            RecipientPayoutEvent { recipient: r1, amount: 400_000, bps: 4000 },
        ],
        tax_amount: 50_000,
        savings_amount: 90_000,
        protocol_fee_amount: 5_000,
        yield_amount: 0,
        yield_included: false,
        timestamp_ms: 1_700_000_000_000,
    };
    let bytes = bcs::to_bytes(&ev).unwrap();

    let (row, payouts) = events::parse_split_executed(&bytes, "0xabc", 7, 42).unwrap();

    assert_eq!(row.config_id, cfg.to_canonical_string(true));
    assert_eq!(row.config_version, 3);
    assert_eq!(row.amount_in, 1_000_000);
    assert_eq!(row.tax_amount, 50_000);
    assert_eq!(row.tx_digest, "0xabc");
    assert_eq!(row.event_seq, 7);
    assert_eq!(row.checkpoint, 42);
    assert!(!row.yield_included);

    assert_eq!(payouts.len(), 2);
    assert_eq!(payouts[0].payout_idx, 0);
    assert_eq!(payouts[0].recipient, r0.to_string());
    assert_eq!(payouts[0].amount, 600_000);
    assert_eq!(payouts[0].bps, 6000);
    assert_eq!(payouts[1].payout_idx, 1);
    assert_eq!(payouts[1].bps, 4000);
    // every payout shares the parent (tx_digest, event_seq) — the FK target.
    assert!(payouts.iter().all(|p| p.tx_digest == "0xabc" && p.event_seq == 7));
}

#[test]
fn config_created_round_trips_and_normalizes_ids() {
    let cfg = ObjectID::random();
    let tax = ObjectID::random();
    let sav = ObjectID::random();
    let owner = SuiAddress::random_for_testing_only();
    let ev = ConfigCreatedEvent { config_id: cfg, tax_vault_id: tax, savings_vault_id: sav, owner };
    let bytes = bcs::to_bytes(&ev).unwrap();

    let row = events::parse_config_created(&bytes, "d1", 99).unwrap();
    assert_eq!(row.config_id, cfg.to_canonical_string(true));
    assert!(row.config_id.starts_with("0x") && row.config_id.len() == 66);
    assert_eq!(row.tax_vault_id, tax.to_canonical_string(true));
    assert_eq!(row.checkpoint_timestamp_ms, 99);
}

#[test]
fn dispatch_routes_events_by_name() {
    assert_eq!(classify("events", "ConfigCreated"), Some(Kind::Config));
    assert_eq!(classify("events", "SplitExecuted"), Some(Kind::Split));
    assert_eq!(classify("events", "ConfigMutated"), Some(Kind::Mutated));
    assert_eq!(classify("events", "VaultWithdrawn"), Some(Kind::Withdrawn));
    // RecipientPayout is embedded, never dispatched standalone.
    assert_eq!(classify("events", "RecipientPayout"), None);
    assert_eq!(classify("events", "Unknown"), None);
    assert_eq!(classify("other", "ConfigCreated"), None);
}

// ---- monkey cases (test.md mandate) ----

#[test]
fn truncated_bytes_returns_err_not_panic() {
    let ev = VaultWithdrawnEvent {
        vault_id: ObjectID::random(),
        kind: 1,
        amount: 1,
        recipient: SuiAddress::ZERO,
    };
    let mut bytes = bcs::to_bytes(&ev).unwrap();
    bytes.truncate(bytes.len() - 4); // chop the tail
    let r = events::parse_vault_withdrawn(&bytes, "d", 0, 0);
    assert!(r.is_err(), "truncated BCS must Err, not panic");
}

#[test]
fn split_zero_amounts_and_empty_payouts() {
    let ev = SplitExecutedEvent {
        config_id: ObjectID::random(),
        config_version: 0,
        amount_in: 0,
        recipient_payouts: vec![],
        tax_amount: 0,
        savings_amount: 0,
        protocol_fee_amount: 0,
        yield_amount: 0,
        yield_included: true, // wired but zero yield — observable per events.move
        timestamp_ms: 0,
    };
    let bytes = bcs::to_bytes(&ev).unwrap();
    let (row, payouts) = events::parse_split_executed(&bytes, "d", 0, 0).unwrap();
    assert_eq!(row.amount_in, 0);
    assert!(row.yield_included);
    assert!(payouts.is_empty());
}

#[test]
fn amount_exceeding_i64_errs_not_silently_negative() {
    // u64 in [2^63, 2^64) must fail loud, never wrap to a negative BIGINT.
    let ev = SplitExecutedEvent {
        config_id: ObjectID::random(),
        config_version: 1,
        amount_in: u64::MAX, // > i64::MAX
        recipient_payouts: vec![],
        tax_amount: 0,
        savings_amount: 0,
        protocol_fee_amount: 0,
        yield_amount: 0,
        yield_included: false,
        timestamp_ms: 1,
    };
    let bytes = bcs::to_bytes(&ev).unwrap();
    let r = events::parse_split_executed(&bytes, "d", 0, 0);
    assert!(r.is_err(), "u64 > i64::MAX must Err, not store a negative amount");
}

#[test]
fn payout_bps_boundary_10000() {
    let ev = SplitExecutedEvent {
        config_id: ObjectID::random(),
        config_version: 1,
        amount_in: 100,
        recipient_payouts: vec![RecipientPayoutEvent {
            recipient: SuiAddress::ZERO,
            amount: 100,
            bps: 10_000,
        }],
        tax_amount: 0,
        savings_amount: 0,
        protocol_fee_amount: 0,
        yield_amount: 0,
        yield_included: false,
        timestamp_ms: 1,
    };
    let bytes = bcs::to_bytes(&ev).unwrap();
    let (_row, payouts) = events::parse_split_executed(&bytes, "d", 0, 0).unwrap();
    assert_eq!(payouts[0].bps, 10_000);
}
