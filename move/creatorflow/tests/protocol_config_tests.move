#[test_only]
module creatorflow::protocol_config_tests;

use creatorflow::protocol_config::{
    Self,
    ProtocolConfig,
    AdminCap,
    EInvalidBounds,
    EZeroTreasury,
    EFeeOutOfBounds,
};
use sui::test_scenario as ts;
use std::unit_test::assert_eq;

const ADMIN: address = @0xA;
const TREASURY: address = @0xBEEF;

// --- happy path -------------------------------------------------------------

#[test]
fun init_sets_defaults_and_caps() {
    let mut sc = ts::begin(ADMIN);
    protocol_config::init_for_testing(sc.ctx());

    sc.next_tx(ADMIN);
    let config = sc.take_shared<ProtocolConfig>();
    // publisher becomes treasury, default window [30,100].
    assert_eq!(config.treasury(), ADMIN);
    assert_eq!(config.min_fee_bps(), 30);
    assert_eq!(config.max_fee_bps(), 100);
    assert_eq!(protocol_config::bps_denominator(), 10000);
    // AdminCap landed with the publisher.
    assert!(sc.has_most_recent_for_sender<AdminCap>());
    ts::return_shared(config);
    sc.end();
}

#[test]
fun set_treasury_and_bounds_then_fee_check() {
    let mut sc = ts::begin(ADMIN);
    protocol_config::init_for_testing(sc.ctx());

    sc.next_tx(ADMIN);
    let mut config = sc.take_shared<ProtocolConfig>();
    let cap = sc.take_from_sender<AdminCap>();

    config.set_treasury(&cap, TREASURY);
    config.set_bounds(&cap, 50, 300);
    assert_eq!(config.treasury(), TREASURY);
    assert_eq!(config.min_fee_bps(), 50);
    assert_eq!(config.max_fee_bps(), 300);

    // boundary fees pass; in-window passes.
    config.assert_fee_in_bounds(50);
    config.assert_fee_in_bounds(300);
    config.assert_fee_in_bounds(175);

    sc.return_to_sender(cap);
    ts::return_shared(config);
    sc.end();
}

// --- monkey / extreme cases -------------------------------------------------

#[test, expected_failure(abort_code = EInvalidBounds)]
fun set_bounds_rejects_min_gt_max() {
    let mut sc = ts::begin(ADMIN);
    protocol_config::init_for_testing(sc.ctx());
    sc.next_tx(ADMIN);
    let mut config = sc.take_shared<ProtocolConfig>();
    let cap = sc.take_from_sender<AdminCap>();
    config.set_bounds(&cap, 200, 100); // min > max
    abort
}

#[test, expected_failure(abort_code = EInvalidBounds)]
fun set_bounds_rejects_above_ceiling() {
    let mut sc = ts::begin(ADMIN);
    protocol_config::init_for_testing(sc.ctx());
    sc.next_tx(ADMIN);
    let mut config = sc.take_shared<ProtocolConfig>();
    let cap = sc.take_from_sender<AdminCap>();
    config.set_bounds(&cap, 0, 1001); // > MAX_FEE_CEILING (1000) — T11 guard
    abort
}

#[test]
fun set_bounds_allows_exactly_ceiling() {
    let mut sc = ts::begin(ADMIN);
    protocol_config::init_for_testing(sc.ctx());
    sc.next_tx(ADMIN);
    let mut config = sc.take_shared<ProtocolConfig>();
    let cap = sc.take_from_sender<AdminCap>();
    config.set_bounds(&cap, 1000, 1000); // min == max == ceiling, valid
    assert_eq!(config.max_fee_bps(), 1000);
    sc.return_to_sender(cap);
    ts::return_shared(config);
    sc.end();
}

#[test, expected_failure(abort_code = EZeroTreasury)]
fun set_treasury_rejects_zero() {
    let mut sc = ts::begin(ADMIN);
    protocol_config::init_for_testing(sc.ctx());
    sc.next_tx(ADMIN);
    let mut config = sc.take_shared<ProtocolConfig>();
    let cap = sc.take_from_sender<AdminCap>();
    config.set_treasury(&cap, @0x0);
    abort
}

#[test, expected_failure(abort_code = EFeeOutOfBounds)]
fun assert_fee_rejects_below_floor() {
    let mut sc = ts::begin(ADMIN);
    protocol_config::init_for_testing(sc.ctx());
    sc.next_tx(ADMIN);
    let config = sc.take_shared<ProtocolConfig>();
    config.assert_fee_in_bounds(29); // floor is 30
    abort
}

#[test, expected_failure(abort_code = EFeeOutOfBounds)]
fun assert_fee_rejects_above_ceiling() {
    let mut sc = ts::begin(ADMIN);
    protocol_config::init_for_testing(sc.ctx());
    sc.next_tx(ADMIN);
    let config = sc.take_shared<ProtocolConfig>();
    config.assert_fee_in_bounds(101); // ceiling is 100
    abort
}
