#[test_only]
module creatorflow::yield_adapter_tests;

use creatorflow::yield_adapter::{Self, EWrongCap, ENoPosition, EInsufficientYield, EZeroRedeem};
use creatorflow::mock_lending::{Self, MockMarket, MockMarketCap};
use creatorflow::protocol_config::{Self, AdminCap};
use creatorflow::split_config::{Self, StrategyRef};
use creatorflow::vaults::{Self, SavingsVault};
use creatorflow::capabilities::SavingsCap;
use sui::test_scenario as ts;
use sui::clock::{Self, Clock};
use sui::coin;
use usdc::usdc::USDC;
use std::unit_test::{assert_eq, destroy};

const CREATOR: address = @0xC;

fun config_id(): ID { object::id_from_address(@0xC0F19) }
fun strategy(): StrategyRef { split_config::new_strategy_ref(0, object::id_from_address(@0x5CA110)) }
fun mint(amount: u64, sc: &mut ts::Scenario): coin::Coin<USDC> { coin::mint_for_testing<USDC>(amount, sc.ctx()) }
fun new_vault(sc: &mut ts::Scenario): (SavingsVault, SavingsCap) { vaults::new_savings_vault(config_id(), sc.ctx()) }

fun new_market(sc: &mut ts::Scenario): (MockMarket, MockMarketCap) {
    protocol_config::init_for_testing(sc.ctx());
    sc.next_tx(CREATOR);
    let admin = sc.take_from_sender<AdminCap>();
    mock_lending::create_market(&admin, sc.ctx());
    sc.next_tx(CREATOR);
    let market = sc.take_shared<MockMarket>();
    let cap = sc.take_from_sender<MockMarketCap>();
    sc.return_to_sender(admin);
    (market, cap)
}

#[test]
fun deposit_creates_position_and_accounts() {
    let mut sc = ts::begin(CREATOR);
    let (mut market, mcap) = new_market(&mut sc);
    let (mut vault, cap) = new_vault(&mut sc);
    let clk = clock::create_for_testing(sc.ctx());

    assert!(!yield_adapter::has_position(&vault));
    yield_adapter::deposit(&mut market, &mut vault, mint(1_000_000, &mut sc), strategy(), &clk);
    assert!(yield_adapter::has_position(&vault));
    // elapsed=0 → value == principal.
    assert_eq!(yield_adapter::position_value(&vault, &market, &clk), 1_000_000);
    assert_eq!(yield_adapter::position_principal(&vault), 1_000_000);
    assert_eq!(mock_lending::principal_pool_value(&market), 1_000_000);

    clock::destroy_for_testing(clk);
    destroy(vault); destroy(cap); destroy(mcap); ts::return_shared(market); sc.end();
}

#[test]
fun value_accrues_with_clock_when_buffer_funded() {
    let mut sc = ts::begin(CREATOR);
    let (mut market, mcap) = new_market(&mut sc);
    let (mut vault, cap) = new_vault(&mut sc);
    mock_lending::seed(&mut market, &mcap, mint(1_000_000, &mut sc));
    let mut clk = clock::create_for_testing(sc.ctx());

    yield_adapter::deposit(&mut market, &mut vault, mint(1_000_000, &mut sc), strategy(), &clk);
    clock::increment_for_testing(&mut clk, 2_000); // 2s @ rate 5 → +1000
    assert_eq!(yield_adapter::position_value(&vault, &market, &clk), 1_001_000);

    clock::destroy_for_testing(clk);
    destroy(vault); destroy(cap); destroy(mcap); ts::return_shared(market); sc.end();
}

#[test]
fun redeem_returns_principal_plus_realized_interest() {
    let mut sc = ts::begin(CREATOR);
    let (mut market, mcap) = new_market(&mut sc);
    let (mut vault, cap) = new_vault(&mut sc);
    mock_lending::seed(&mut market, &mcap, mint(1_000_000, &mut sc));
    let mut clk = clock::create_for_testing(sc.ctx());

    yield_adapter::deposit(&mut market, &mut vault, mint(1_000_000, &mut sc), strategy(), &clk);
    clock::increment_for_testing(&mut clk, 2_000); // settle on redeem realizes +1000
    let out = yield_adapter::redeem(&mut market, &mut vault, &cap, 1_001_000, &clk, sc.ctx());
    assert_eq!(out.value(), 1_001_000);
    assert_eq!(yield_adapter::position_principal(&vault), 0);

    destroy(out); clock::destroy_for_testing(clk);
    destroy(vault); destroy(cap); destroy(mcap); ts::return_shared(market); sc.end();
}

#[test, expected_failure(abort_code = EWrongCap)]
fun redeem_rejects_foreign_cap() {
    let mut sc = ts::begin(CREATOR);
    let (mut market, mcap) = new_market(&mut sc);
    let (mut vault_a, cap_a) = new_vault(&mut sc);
    let (vault_b, cap_b) = new_vault(&mut sc);
    let clk = clock::create_for_testing(sc.ctx());
    yield_adapter::deposit(&mut market, &mut vault_a, mint(1_000_000, &mut sc), strategy(), &clk);
    let out = yield_adapter::redeem(&mut market, &mut vault_a, &cap_b, 100, &clk, sc.ctx());
    destroy(out); clock::destroy_for_testing(clk);
    destroy(vault_a); destroy(cap_a); destroy(vault_b); destroy(cap_b);
    destroy(mcap); ts::return_shared(market); sc.end();
}

#[test, expected_failure(abort_code = ENoPosition)]
fun redeem_without_position_aborts() {
    let mut sc = ts::begin(CREATOR);
    let (mut market, mcap) = new_market(&mut sc);
    let (mut vault, cap) = new_vault(&mut sc);
    let clk = clock::create_for_testing(sc.ctx());
    let out = yield_adapter::redeem(&mut market, &mut vault, &cap, 1, &clk, sc.ctx());
    destroy(out); clock::destroy_for_testing(clk);
    destroy(vault); destroy(cap); destroy(mcap); ts::return_shared(market); sc.end();
}

#[test, expected_failure(abort_code = EInsufficientYield)]
fun redeem_over_principal_aborts() {
    let mut sc = ts::begin(CREATOR);
    let (mut market, mcap) = new_market(&mut sc);
    let (mut vault, cap) = new_vault(&mut sc);
    let clk = clock::create_for_testing(sc.ctx());
    yield_adapter::deposit(&mut market, &mut vault, mint(500_000, &mut sc), strategy(), &clk);
    let out = yield_adapter::redeem(&mut market, &mut vault, &cap, 500_001, &clk, sc.ctx());
    destroy(out); clock::destroy_for_testing(clk);
    destroy(vault); destroy(cap); destroy(mcap); ts::return_shared(market); sc.end();
}

#[test, expected_failure(abort_code = EZeroRedeem)]
fun redeem_zero_aborts() {
    let mut sc = ts::begin(CREATOR);
    let (mut market, mcap) = new_market(&mut sc);
    let (mut vault, cap) = new_vault(&mut sc);
    let clk = clock::create_for_testing(sc.ctx());
    yield_adapter::deposit(&mut market, &mut vault, mint(500_000, &mut sc), strategy(), &clk);
    let out = yield_adapter::redeem(&mut market, &mut vault, &cap, 0, &clk, sc.ctx());
    destroy(out); clock::destroy_for_testing(clk);
    destroy(vault); destroy(cap); destroy(mcap); ts::return_shared(market); sc.end();
}

// Shared-fate liveness (red-team/security-guard finding 5): A drains the buffer,
// B with unsettled interest still redeems its PRINCIPAL (settle realizes 0, no abort).
#[test]
fun dry_buffer_never_strands_principal() {
    let mut sc = ts::begin(CREATOR);
    let (mut market, mcap) = new_market(&mut sc);
    let (mut vault_a, cap_a) = new_vault(&mut sc);
    let (mut vault_b, cap_b) = new_vault(&mut sc);
    mock_lending::seed(&mut market, &mcap, mint(100, &mut sc)); // tiny buffer
    let mut clk = clock::create_for_testing(sc.ctx());

    yield_adapter::deposit(&mut market, &mut vault_a, mint(1_000_000, &mut sc), strategy(), &clk);
    yield_adapter::deposit(&mut market, &mut vault_b, mint(1_000_000, &mut sc), strategy(), &clk);
    clock::increment_for_testing(&mut clk, 10_000);
    // A settles first, drains the whole 100 buffer into its principal.
    let oa = yield_adapter::redeem(&mut market, &mut vault_a, &cap_a, 1_000_100, &clk, sc.ctx());
    assert_eq!(mock_lending::buffer_value(&market), 0);
    // B's settle realizes 0 (dry) but B's PRINCIPAL redeem still succeeds.
    let ob = yield_adapter::redeem(&mut market, &mut vault_b, &cap_b, 1_000_000, &clk, sc.ctx());
    assert_eq!(ob.value(), 1_000_000);

    destroy(oa); destroy(ob); clock::destroy_for_testing(clk);
    destroy(vault_a); destroy(cap_a); destroy(vault_b); destroy(cap_b);
    destroy(mcap); ts::return_shared(market); sc.end();
}

#[test]
fun sweep_moves_banked_savings_into_position() {
    let mut sc = ts::begin(CREATOR);
    let (mut market, mcap) = new_market(&mut sc);
    let (mut vault, cap) = new_vault(&mut sc);
    let clk = clock::create_for_testing(sc.ctx());
    vaults::deposit_savings(&mut vault, mint(1_000_000, &mut sc));
    yield_adapter::sweep(&mut market, &mut vault, &cap, 700_000, strategy(), &clk, sc.ctx());
    assert_eq!(vaults::savings_balance(&vault), 300_000);
    assert_eq!(yield_adapter::position_principal(&vault), 700_000);
    clock::destroy_for_testing(clk);
    destroy(vault); destroy(cap); destroy(mcap); ts::return_shared(market); sc.end();
}
