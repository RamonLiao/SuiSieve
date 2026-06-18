/// Tests for `creatorflow::events`. Events can't be read back from chain state,
/// so we assert two things that DO matter: (1) the `RecipientPayout` constructor
/// faithfully records what router hands it (the indexer trusts these fields),
/// and (2) each `emit_*` actually produces exactly one user event per call
/// (via `test_scenario`'s effect counter) — proving router's emission wiring
/// fires and doesn't silently no-op (Rule 9: test intent, not just shape).
#[test_only]
module creatorflow::events_tests;

use creatorflow::events;
use sui::test_scenario as ts;

const CREATOR: address = @0xC0FFEE;
const ALICE: address = @0xA11CE;

/// RecipientPayout round-trips every field — these cross the BCS boundary to
/// the indexer, so a swapped/dropped field would corrupt payout history.
#[test]
fun recipient_payout_roundtrips_fields() {
    let p = events::new_recipient_payout(ALICE, 4200, 3500);
    assert!(events::payout_addr(&p) == ALICE, 0);
    assert!(events::payout_amount(&p) == 4200, 1);
    assert!(events::payout_bps(&p) == 3500, 2);
}

/// The kind discriminants are the spec-fixed 0/1; router and the indexer both
/// depend on these exact values.
#[test]
fun kind_discriminants_match_spec() {
    assert!(events::kind_tax() == 0, 0);
    assert!(events::kind_savings() == 1, 1);
}

/// emit_split_executed produces exactly one user event. Uses a dummy ID minted
/// from a throwaway UID (we only need a valid `ID`, not a live object).
#[test]
fun emit_split_executed_emits_one_event() {
    let mut scenario = ts::begin(CREATOR);
    ts::next_tx(&mut scenario, CREATOR);
    {
        let ctx = ts::ctx(&mut scenario);
        let uid = object::new(ctx);
        let config_id = uid.to_inner();
        let payouts = vector[
            events::new_recipient_payout(ALICE, 6000, 6000),
            events::new_recipient_payout(CREATOR, 4000, 4000),
        ];
        events::emit_split_executed(
            config_id,
            7,        // config_version
            10000,    // amount_in
            payouts,
            0,        // tax_amount
            0,        // savings_amount
            0,        // protocol_fee_amount
            0,        // yield_amount
            false,    // yield_included
            1_700_000_000_000, // timestamp_ms
        );
        uid.delete();
    };
    let effects = ts::next_tx(&mut scenario, CREATOR);
    assert!(ts::num_user_events(&effects) == 1, 0);
    ts::end(scenario);
}

/// emit_config_mutated produces exactly one user event.
#[test]
fun emit_config_mutated_emits_one_event() {
    let mut scenario = ts::begin(CREATOR);
    ts::next_tx(&mut scenario, CREATOR);
    {
        let ctx = ts::ctx(&mut scenario);
        let uid = object::new(ctx);
        let config_id = uid.to_inner();
        events::emit_config_mutated(config_id, 3, 4, CREATOR);
        uid.delete();
    };
    let effects = ts::next_tx(&mut scenario, CREATOR);
    assert!(ts::num_user_events(&effects) == 1, 0);
    ts::end(scenario);
}

/// emit_config_created produces exactly one user event. Mints a throwaway UID
/// for each ID arg (we only need valid `ID`s, not live objects).
#[test]
fun emit_config_created_emits_one_event() {
    let mut scenario = ts::begin(CREATOR);
    ts::next_tx(&mut scenario, CREATOR);
    {
        let ctx = ts::ctx(&mut scenario);
        let u1 = object::new(ctx);
        let u2 = object::new(ctx);
        let u3 = object::new(ctx);
        events::emit_config_created(
            u1.to_inner(),  // config_id
            u2.to_inner(),  // tax_vault_id
            u3.to_inner(),  // savings_vault_id
            CREATOR,        // owner
        );
        u1.delete();
        u2.delete();
        u3.delete();
    };
    let effects = ts::next_tx(&mut scenario, CREATOR);
    assert!(ts::num_user_events(&effects) == 1, 0);
    ts::end(scenario);
}

/// emit_vault_withdrawn produces exactly one user event, with the savings kind.
#[test]
fun emit_vault_withdrawn_emits_one_event() {
    let mut scenario = ts::begin(CREATOR);
    ts::next_tx(&mut scenario, CREATOR);
    {
        let ctx = ts::ctx(&mut scenario);
        let uid = object::new(ctx);
        let vault_id = uid.to_inner();
        events::emit_vault_withdrawn(vault_id, events::kind_savings(), 5000, CREATOR);
        uid.delete();
    };
    let effects = ts::next_tx(&mut scenario, CREATOR);
    assert!(ts::num_user_events(&effects) == 1, 0);
    ts::end(scenario);
}

/// Monkey: an empty recipient vector + all-zero amounts must still emit cleanly
/// (degenerate split — e.g. a 100%-protocol-fee config). Emission must never
/// abort on edge values; the indexer tolerates zero-amount facts.
#[test]
fun emit_split_executed_tolerates_empty_and_zero() {
    let mut scenario = ts::begin(CREATOR);
    ts::next_tx(&mut scenario, CREATOR);
    {
        let ctx = ts::ctx(&mut scenario);
        let uid = object::new(ctx);
        let config_id = uid.to_inner();
        events::emit_split_executed(
            config_id, 0, 0, vector[], 0, 0, 0, 0, true, 0,
        );
        uid.delete();
    };
    let effects = ts::next_tx(&mut scenario, CREATOR);
    assert!(ts::num_user_events(&effects) == 1, 0);
    ts::end(scenario);
}
