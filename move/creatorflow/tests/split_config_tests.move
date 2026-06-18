#[test_only]
module creatorflow::split_config_tests;

use creatorflow::split_config::{
    Self,
    SplitConfig,
    EInvalidBps,
    ETooManyRecipients,
    EZeroRecipientBps,
    EYieldExceedsSavings,
    EWrongOwnerCap,
};
use creatorflow::protocol_config::{Self, ProtocolConfig, EFeeOutOfBounds};
use creatorflow::capabilities::OwnerCap;
use sui::test_scenario as ts;
use std::unit_test::{assert_eq, destroy};

const CREATOR: address = @0xC;
const ALICE: address = @0xA1;
const BOB: address = @0xB0;

// Dummy vault IDs — split_config only stores them as back-pointers, never
// dereferences them, so synthetic IDs are sufficient (mirrors capabilities_tests).
fun tax_id(): ID { object::id_from_address(@0x7A) }
fun savings_id(): ID { object::id_from_address(@0x5A) }

// A standard valid allocation summing to exactly 10000:
//   alice 6000 + bob 3000 + tax 500 + savings 450 + fee 50 = 10000, yield 400 (<= savings).
fun standard_recipients(): vector<split_config::Recipient> {
    vector[
        split_config::new_recipient(ALICE, 6000, b"alice"),
        split_config::new_recipient(BOB, 3000, b"bob"),
    ]
}

fun mk_standard(protocol: &ProtocolConfig, ctx: &mut TxContext): (SplitConfig, OwnerCap) {
    split_config::new(
        protocol,
        standard_recipients(),
        500,   // tax_bps
        450,   // savings_bps
        50,    // protocol_fee_bps (within default [30,100])
        400,   // yield_bps (<= savings_bps)
        option::some(split_config::new_strategy_ref(0, object::id_from_address(@0xDEAD))),
        tax_id(),
        savings_id(),
        ctx,
    )
}

// --- happy path -------------------------------------------------------------

#[test]
fun new_sets_fields_and_binds_owner_cap() {
    let mut sc = ts::begin(CREATOR);
    protocol_config::init_for_testing(sc.ctx());
    sc.next_tx(CREATOR);
    let protocol = sc.take_shared<ProtocolConfig>();

    let (config, owner_cap) = mk_standard(&protocol, sc.ctx());

    assert_eq!(config.owner(), CREATOR);
    assert_eq!(config.version(), 0);
    assert_eq!(config.tax_bps(), 500);
    assert_eq!(config.savings_bps(), 450);
    assert_eq!(config.protocol_fee_bps(), 50);
    assert_eq!(config.yield_bps(), 400);
    assert_eq!(config.tax_vault_id(), tax_id());
    assert_eq!(config.savings_vault_id(), savings_id());
    assert!(config.yield_strategy().is_some());
    assert_eq!(config.recipients().length(), 2);

    // OwnerCap is minted bound to THIS config — the access-control link.
    assert_eq!(
        creatorflow::capabilities::owner_cap_config_id(&owner_cap),
        object::id(&config),
    );

    destroy(config);
    destroy(owner_cap);
    ts::return_shared(protocol);
    sc.end();
}

// Empty recipient list is legal: a creator routing 100% to tax/savings/fee.
#[test]
fun new_allows_empty_recipients() {
    let mut sc = ts::begin(CREATOR);
    protocol_config::init_for_testing(sc.ctx());
    sc.next_tx(CREATOR);
    let protocol = sc.take_shared<ProtocolConfig>();

    // 0 recipients + tax 5000 + savings 4950 + fee 50 = 10000.
    let (config, owner_cap) = split_config::new(
        &protocol, vector[], 5000, 4950, 50, 0, option::none(),
        tax_id(), savings_id(), sc.ctx(),
    );
    assert_eq!(config.recipients().length(), 0);
    assert!(config.yield_strategy().is_none());

    destroy(config);
    destroy(owner_cap);
    ts::return_shared(protocol);
    sc.end();
}

#[test]
fun update_recipients_bumps_version_and_replaces() {
    let mut sc = ts::begin(CREATOR);
    protocol_config::init_for_testing(sc.ctx());
    sc.next_tx(CREATOR);
    let protocol = sc.take_shared<ProtocolConfig>();
    let (mut config, owner_cap) = mk_standard(&protocol, sc.ctx());

    // New split: alice 9000 + tax 500 + savings 450 + fee 50 = 10000.
    let new_recipients = vector[split_config::new_recipient(ALICE, 9000, b"alice")];
    split_config::update_recipients(&mut config, &owner_cap, &protocol, new_recipients, 500, 450);

    assert_eq!(config.version(), 1);
    assert_eq!(config.recipients().length(), 1);
    assert_eq!(config.tax_bps(), 500);
    // protocol_fee_bps + yield_bps are intentionally preserved across mutation.
    assert_eq!(config.protocol_fee_bps(), 50);
    assert_eq!(config.yield_bps(), 400);

    destroy(config);
    destroy(owner_cap);
    ts::return_shared(protocol);
    sc.end();
}

// --- abort paths ------------------------------------------------------------

#[test, expected_failure(abort_code = EInvalidBps)]
fun new_rejects_wrong_sum() {
    let mut sc = ts::begin(CREATOR);
    protocol_config::init_for_testing(sc.ctx());
    sc.next_tx(CREATOR);
    let protocol = sc.take_shared<ProtocolConfig>();

    // Sums to 9999, not 10000.
    let (config, owner_cap) = split_config::new(
        &protocol,
        vector[split_config::new_recipient(ALICE, 5999, b"a")],
        3500, 450, 50, 0, option::none(), tax_id(), savings_id(), sc.ctx(),
    );
    abort_cleanup(config, owner_cap, protocol, sc)
}

#[test, expected_failure(abort_code = ETooManyRecipients)]
fun new_rejects_too_many_recipients() {
    let mut sc = ts::begin(CREATOR);
    protocol_config::init_for_testing(sc.ctx());
    sc.next_tx(CREATOR);
    let protocol = sc.take_shared<ProtocolConfig>();

    // 17 recipients (one over MAX_RECIPIENTS), each 1 bps; sum is irrelevant —
    // the count check fires first.
    let mut rs = vector[];
    17u64.do!(|_| rs.push_back(split_config::new_recipient(ALICE, 1, b"x")));
    let (config, owner_cap) = split_config::new(
        &protocol, rs, 0, 0, 50, 0, option::none(), tax_id(), savings_id(), sc.ctx(),
    );
    abort_cleanup(config, owner_cap, protocol, sc)
}

#[test, expected_failure(abort_code = EZeroRecipientBps)]
fun new_rejects_zero_bps_recipient() {
    let mut sc = ts::begin(CREATOR);
    protocol_config::init_for_testing(sc.ctx());
    sc.next_tx(CREATOR);
    let protocol = sc.take_shared<ProtocolConfig>();

    let (config, owner_cap) = split_config::new(
        &protocol,
        vector[
            split_config::new_recipient(ALICE, 9950, b"a"),
            split_config::new_recipient(BOB, 0, b"dead"),
        ],
        0, 0, 50, 0, option::none(), tax_id(), savings_id(), sc.ctx(),
    );
    abort_cleanup(config, owner_cap, protocol, sc)
}

#[test, expected_failure(abort_code = EYieldExceedsSavings)]
fun new_rejects_yield_over_savings() {
    let mut sc = ts::begin(CREATOR);
    protocol_config::init_for_testing(sc.ctx());
    sc.next_tx(CREATOR);
    let protocol = sc.take_shared<ProtocolConfig>();

    // savings 450 but yield 500 — would underflow at execute time.
    let (config, owner_cap) = split_config::new(
        &protocol, standard_recipients(), 500, 450, 50, 500,
        option::none(), tax_id(), savings_id(), sc.ctx(),
    );
    abort_cleanup(config, owner_cap, protocol, sc)
}

#[test, expected_failure(abort_code = EFeeOutOfBounds)]
fun new_rejects_fee_below_floor() {
    let mut sc = ts::begin(CREATOR);
    protocol_config::init_for_testing(sc.ctx());
    sc.next_tx(CREATOR);
    let protocol = sc.take_shared<ProtocolConfig>();

    // fee 10 < min_fee_bps (30). Sum is valid (alice 6500 + bob 3000 + tax 490 = 10000).
    let (config, owner_cap) = split_config::new(
        &protocol,
        vector[
            split_config::new_recipient(ALICE, 6500, b"a"),
            split_config::new_recipient(BOB, 3000, b"b"),
        ],
        490, 0, 10, 0, option::none(), tax_id(), savings_id(), sc.ctx(),
    );
    abort_cleanup(config, owner_cap, protocol, sc)
}

#[test, expected_failure(abort_code = EWrongOwnerCap)]
fun update_rejects_foreign_owner_cap() {
    let mut sc = ts::begin(CREATOR);
    protocol_config::init_for_testing(sc.ctx());
    sc.next_tx(CREATOR);
    let protocol = sc.take_shared<ProtocolConfig>();

    let (config_a, cap_a) = mk_standard(&protocol, sc.ctx());
    let (mut config_b, cap_b) = mk_standard(&protocol, sc.ctx());

    // cap_a governs config_a, not config_b → must abort.
    split_config::update_recipients(
        &mut config_b, &cap_a, &protocol, standard_recipients(), 500, 450,
    );

    destroy(config_a);
    destroy(config_b);
    destroy(cap_a);
    destroy(cap_b);
    ts::return_shared(protocol);
    sc.end();
}

// --- monkey: the u16-overflow trap ------------------------------------------

// 8 recipients (9441 + 7×9437) + fee 36 = 75536. 75536 mod 65536 == 10000, so a
// buggy u16-accumulating sum would WRAP to exactly 10000 and wrongly pass. The
// u64 accumulation sees the true 75536 ≠ 10000 and aborts. If this test ever
// stops failing, the overflow guard regressed.
#[test, expected_failure(abort_code = EInvalidBps)]
fun new_rejects_u16_wraparound_sum() {
    let mut sc = ts::begin(CREATOR);
    protocol_config::init_for_testing(sc.ctx());
    sc.next_tx(CREATOR);
    let protocol = sc.take_shared<ProtocolConfig>();

    let mut rs = vector[split_config::new_recipient(ALICE, 9441, b"a")];
    7u64.do!(|_| rs.push_back(split_config::new_recipient(BOB, 9437, b"b")));
    let (config, owner_cap) = split_config::new(
        &protocol, rs, 0, 0, 36, 0, option::none(), tax_id(), savings_id(), sc.ctx(),
    );
    abort_cleanup(config, owner_cap, protocol, sc)
}

// Shared teardown for abort tests: these lines are never reached (the call
// above aborts), but the compiler still requires every value be consumed.
fun abort_cleanup(
    config: SplitConfig,
    owner_cap: OwnerCap,
    protocol: ProtocolConfig,
    sc: ts::Scenario,
) {
    destroy(config);
    destroy(owner_cap);
    ts::return_shared(protocol);
    sc.end();
}
