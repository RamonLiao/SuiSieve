#[test_only]
module creatorflow::mock_lending_tests;

use creatorflow::mock_lending::{Self, EAccrualOverflow, EWrongMarketCap, ERateTooHigh, EZeroAmount, MockMarket, MockMarketCap};
use creatorflow::protocol_config::{Self, AdminCap};
use sui::test_scenario as ts;
use sui::coin;
use usdc::usdc::USDC;
use std::unit_test::{assert_eq, destroy};

const ADMIN: address = @0xAD;

// interest = principal · rate · elapsed_ms / (10000 · 1000)
// 1_000_000 · 5 · 2000 / 10_000_000 = 1000
#[test]
fun accrue_matches_pinned_example() {
    assert_eq!(mock_lending::accrue(1_000_000, 5, 2_000), 1_000);
}

#[test]
fun accrue_zero_elapsed_or_zero_principal_is_zero() {
    assert_eq!(mock_lending::accrue(1_000_000, 5, 0), 0);
    assert_eq!(mock_lending::accrue(0, 5, 2_000), 0);
}

#[test]
fun accrue_is_linear() {
    let a = mock_lending::accrue(1_000_000, 5, 2_000);
    assert_eq!(mock_lending::accrue(1_000_000, 5, 4_000), a * 2);
    assert_eq!(mock_lending::accrue(2_000_000, 5, 2_000), a * 2);
}

// u64::MAX principal with a small elapsed must NOT overflow u128 and result fits u64.
#[test]
fun accrue_no_u128_overflow_at_max_principal_bounded() {
    // principal=u64::MAX, rate=5, elapsed=1 ms:
    // product = 1.84e19 · 5 · 1 = 9.2e19 << u128 max (3.4e38).
    // result  = 9.2e19 / 1e7 = 9.2e12 << u64::MAX — computes, no abort.
    let _ = mock_lending::accrue(18_446_744_073_709_551_615, 5, 1);
}

// A result that exceeds u64 range must fail loud, not silently truncate.
#[test, expected_failure(abort_code = EAccrualOverflow)]
fun accrue_overflow_fails_loud() {
    // principal=u64::MAX, rate=5, elapsed=3_000_000 ms:
    // product = 1.84e19 · 5 · 3e6 = 2.76e26 << u128 max — no u128 overflow.
    // result  = 2.76e26 / 1e7 = 2.76e19 >> u64::MAX → EAccrualOverflow.
    let _ = mock_lending::accrue(18_446_744_073_709_551_615, 5, 3_000_000);
}

// ── Task-2 helpers ──────────────────────────────────────────────────────────

fun new_market(sc: &mut ts::Scenario): (MockMarket, MockMarketCap) {
    protocol_config::init_for_testing(sc.ctx());
    sc.next_tx(ADMIN);
    let admin = sc.take_from_sender<AdminCap>();
    mock_lending::create_market(&admin, sc.ctx());
    sc.next_tx(ADMIN);
    let market = sc.take_shared<MockMarket>();
    let cap = sc.take_from_sender<MockMarketCap>();
    sc.return_to_sender(admin);
    (market, cap)
}

fun usdc(amount: u64, sc: &mut ts::Scenario): coin::Coin<USDC> {
    coin::mint_for_testing<USDC>(amount, sc.ctx())
}

// ── Task-2 tests ────────────────────────────────────────────────────────────

#[test]
fun supply_grows_principal_pool_and_total() {
    let mut sc = ts::begin(ADMIN);
    let (mut market, cap) = new_market(&mut sc);
    let added = mock_lending::supply(&mut market, usdc(1_000_000, &mut sc));
    assert!(added == 1_000_000);
    assert!(mock_lending::principal_pool_value(&market) == 1_000_000);
    assert!(mock_lending::total_supplied(&market) == 1_000_000);
    destroy(cap); ts::return_shared(market); sc.end();
}

#[test]
fun realize_interest_moves_buffer_best_effort() {
    let mut sc = ts::begin(ADMIN);
    let (mut market, cap) = new_market(&mut sc);
    mock_lending::seed(&mut market, &cap, usdc(1_000, &mut sc));
    // want within buffer → full realize.
    assert!(mock_lending::realize_interest(&mut market, 400) == 400);
    assert!(mock_lending::buffer_value(&market) == 600);
    assert!(mock_lending::principal_pool_value(&market) == 400);
    // want beyond buffer → best-effort min, NEVER aborts.
    assert!(mock_lending::realize_interest(&mut market, 10_000) == 600);
    assert!(mock_lending::buffer_value(&market) == 0);
    destroy(cap); ts::return_shared(market); sc.end();
}

#[test]
fun redeem_takes_from_principal_pool() {
    let mut sc = ts::begin(ADMIN);
    let (mut market, cap) = new_market(&mut sc);
    let _ = mock_lending::supply(&mut market, usdc(1_000_000, &mut sc));
    let out = mock_lending::redeem(&mut market, 300_000, sc.ctx());
    assert!(out.value() == 300_000);
    assert!(mock_lending::principal_pool_value(&market) == 700_000);
    destroy(out); destroy(cap); ts::return_shared(market); sc.end();
}

#[test, expected_failure(abort_code = EZeroAmount)]
fun redeem_zero_aborts() {
    let mut sc = ts::begin(ADMIN);
    let (mut market, cap) = new_market(&mut sc);
    let _ = mock_lending::supply(&mut market, usdc(100, &mut sc));
    let out = mock_lending::redeem(&mut market, 0, sc.ctx());
    destroy(out); destroy(cap); ts::return_shared(market); sc.end();
}

#[test, expected_failure(abort_code = ERateTooHigh)]
fun set_rate_above_max_aborts() {
    let mut sc = ts::begin(ADMIN);
    let (mut market, cap) = new_market(&mut sc);
    mock_lending::set_rate(&mut market, &cap, 100_001);
    destroy(cap); ts::return_shared(market); sc.end();
}

#[test, expected_failure(abort_code = EWrongMarketCap)]
fun seed_with_foreign_cap_aborts() {
    let mut sc = ts::begin(ADMIN);
    let (mut market_a, cap_a) = new_market(&mut sc);
    let (market_b, cap_b) = new_market(&mut sc);
    // cap_b governs market_b, not market_a.
    mock_lending::seed(&mut market_a, &cap_b, usdc(1, &mut sc));
    destroy(cap_a); destroy(cap_b);
    ts::return_shared(market_a); ts::return_shared(market_b); sc.end();
}
