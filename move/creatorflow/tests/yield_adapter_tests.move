#[test_only]
module creatorflow::yield_adapter_tests;

use creatorflow::yield_adapter::{Self, EWrongCap, ENoPosition, EInsufficientYield};
use creatorflow::split_config::{Self, StrategyRef};
use creatorflow::vaults::{Self, SavingsVault};
use creatorflow::capabilities::SavingsCap;
use sui::test_scenario as ts;
use sui::coin;
use usdc::usdc::USDC;
use std::unit_test::{assert_eq, destroy};

const CREATOR: address = @0xC;

fun config_id(): ID { object::id_from_address(@0xC0F19) }

fun strategy(): StrategyRef {
    // kind 0 = Scallop (MVP); pool_id is recorded but unused until real CPI.
    split_config::new_strategy_ref(0, object::id_from_address(@0x5CA110))
}

fun mint(amount: u64, sc: &mut ts::Scenario): coin::Coin<USDC> {
    coin::mint_for_testing<USDC>(amount, sc.ctx())
}

fun new_vault(sc: &mut ts::Scenario): (SavingsVault, SavingsCap) {
    vaults::new_savings_vault(config_id(), sc.ctx())
}

// --- deposit (Mode A) -------------------------------------------------------

#[test]
fun deposit_creates_position_and_accounts() {
    let mut sc = ts::begin(CREATOR);
    let (mut vault, cap) = new_vault(&mut sc);

    // No position before the first deposit.
    assert!(!yield_adapter::has_position(&vault));
    assert_eq!(yield_adapter::position_value(&vault), 0);
    assert_eq!(yield_adapter::position_principal(&vault), 0);

    yield_adapter::deposit(&mut vault, mint(1_000_000, &mut sc), strategy());

    assert!(yield_adapter::has_position(&vault));
    assert_eq!(yield_adapter::position_value(&vault), 1_000_000);
    assert_eq!(yield_adapter::position_principal(&vault), 1_000_000);

    destroy(vault);
    destroy(cap);
    sc.end();
}

#[test]
fun deposit_accumulates_into_one_position() {
    let mut sc = ts::begin(CREATOR);
    let (mut vault, cap) = new_vault(&mut sc);

    yield_adapter::deposit(&mut vault, mint(600_000, &mut sc), strategy());
    yield_adapter::deposit(&mut vault, mint(400_000, &mut sc), strategy());

    // Still a single position (one YieldKey), summed.
    assert_eq!(yield_adapter::position_value(&vault), 1_000_000);
    assert_eq!(yield_adapter::position_principal(&vault), 1_000_000);

    destroy(vault);
    destroy(cap);
    sc.end();
}

// --- redeem -----------------------------------------------------------------

#[test]
fun redeem_partial_draws_down_principal() {
    let mut sc = ts::begin(CREATOR);
    let (mut vault, cap) = new_vault(&mut sc);
    yield_adapter::deposit(&mut vault, mint(1_000_000, &mut sc), strategy());

    let out = yield_adapter::redeem(&mut vault, &cap, 400_000, sc.ctx());
    assert_eq!(out.value(), 400_000);
    assert_eq!(yield_adapter::position_value(&vault), 600_000);
    assert_eq!(yield_adapter::position_principal(&vault), 600_000);

    destroy(out);
    destroy(vault);
    destroy(cap);
    sc.end();
}

#[test]
fun redeem_full_empties_position_but_keeps_it() {
    let mut sc = ts::begin(CREATOR);
    let (mut vault, cap) = new_vault(&mut sc);
    yield_adapter::deposit(&mut vault, mint(500_000, &mut sc), strategy());

    let out = yield_adapter::redeem(&mut vault, &cap, 500_000, sc.ctx());
    assert_eq!(out.value(), 500_000);
    // Position object persists (dynamic field stays) but is drained to zero.
    assert!(yield_adapter::has_position(&vault));
    assert_eq!(yield_adapter::position_value(&vault), 0);
    assert_eq!(yield_adapter::position_principal(&vault), 0);

    destroy(out);
    destroy(vault);
    destroy(cap);
    sc.end();
}

// --- sweep (Mode B) ---------------------------------------------------------

#[test]
fun sweep_moves_banked_savings_into_position() {
    let mut sc = ts::begin(CREATOR);
    let (mut vault, cap) = new_vault(&mut sc);

    // Savings already banked in the vault (as if from a prior split).
    vaults::deposit_savings(&mut vault, mint(1_000_000, &mut sc));
    assert_eq!(vaults::savings_balance(&vault), 1_000_000);

    yield_adapter::sweep(&mut vault, &cap, 700_000, strategy(), sc.ctx());

    // Funds left the vault's free balance and entered the yield position.
    assert_eq!(vaults::savings_balance(&vault), 300_000);
    assert_eq!(yield_adapter::position_value(&vault), 700_000);
    assert_eq!(yield_adapter::position_principal(&vault), 700_000);

    destroy(vault);
    destroy(cap);
    sc.end();
}

// --- red-team / abort paths -------------------------------------------------

// T4: a SavingsCap minted for a *different* vault must not drain this one.
#[test, expected_failure(abort_code = EWrongCap)]
fun redeem_rejects_foreign_cap() {
    let mut sc = ts::begin(CREATOR);
    let (mut vault_a, cap_a) = new_vault(&mut sc);
    let (vault_b, cap_b) = new_vault(&mut sc);
    yield_adapter::deposit(&mut vault_a, mint(1_000_000, &mut sc), strategy());

    // cap_b governs vault_b, not vault_a → EWrongCap.
    let out = yield_adapter::redeem(&mut vault_a, &cap_b, 100, sc.ctx());

    destroy(out);
    destroy(vault_a);
    destroy(cap_a);
    destroy(vault_b);
    destroy(cap_b);
    sc.end();
}

#[test, expected_failure(abort_code = ENoPosition)]
fun redeem_without_position_aborts() {
    let mut sc = ts::begin(CREATOR);
    let (mut vault, cap) = new_vault(&mut sc);

    // Never deposited → no YieldKey field.
    let out = yield_adapter::redeem(&mut vault, &cap, 1, sc.ctx());

    destroy(out);
    destroy(vault);
    destroy(cap);
    sc.end();
}

#[test, expected_failure(abort_code = EInsufficientYield)]
fun redeem_over_balance_aborts() {
    let mut sc = ts::begin(CREATOR);
    let (mut vault, cap) = new_vault(&mut sc);
    yield_adapter::deposit(&mut vault, mint(500_000, &mut sc), strategy());

    // Ask for one more than the position holds → fail loud, not silent-cap.
    let out = yield_adapter::redeem(&mut vault, &cap, 500_001, sc.ctx());

    destroy(out);
    destroy(vault);
    destroy(cap);
    sc.end();
}

// --- monkey -----------------------------------------------------------------

// Zero-value deposit: creates a position with 0/0, and a 0 redeem round-trips.
#[test]
fun zero_value_deposit_and_redeem_are_inert() {
    let mut sc = ts::begin(CREATOR);
    let (mut vault, cap) = new_vault(&mut sc);

    yield_adapter::deposit(&mut vault, mint(0, &mut sc), strategy());
    assert!(yield_adapter::has_position(&vault));
    assert_eq!(yield_adapter::position_value(&vault), 0);

    let out = yield_adapter::redeem(&mut vault, &cap, 0, sc.ctx());
    assert_eq!(out.value(), 0);
    assert_eq!(yield_adapter::position_principal(&vault), 0);

    destroy(out);
    destroy(vault);
    destroy(cap);
    sc.end();
}
