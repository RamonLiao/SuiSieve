#[test_only]
module creatorflow::vaults_tests;

use creatorflow::vaults;
use sui::test_scenario as ts;
use sui::coin;
use usdc::usdc::USDC;
use std::unit_test::{assert_eq, destroy};

const CREATOR: address = @0xC;

// Deterministic config ID to bind vaults to. Real flow uses the router-derived
// SplitConfig ID; tests only need a stable value to assert the back-pointer.
fun config_id(): ID { object::id_from_address(@0xC0F19) }

fun mint(amount: u64, sc: &mut ts::Scenario): coin::Coin<USDC> {
    coin::mint_for_testing<USDC>(amount, sc.ctx())
}

// --- TaxVault -----------------------------------------------------------------

#[test]
fun new_tax_vault_is_empty_and_bound() {
    let mut sc = ts::begin(CREATOR);
    let (vault, cap) = vaults::new_tax_vault(config_id(), sc.ctx());

    // Fresh vault: zero balance, zero counters, bound to the config.
    assert_eq!(vaults::tax_balance(&vault), 0);
    assert_eq!(vaults::tax_total_deposited(&vault), 0);
    assert_eq!(vaults::tax_total_withdrawn(&vault), 0);
    assert_eq!(vaults::tax_config_id(&vault), config_id());

    destroy(vault);
    destroy(cap);
    sc.end();
}

#[test]
fun deposit_then_withdraw_tracks_accounting() {
    let mut sc = ts::begin(CREATOR);
    let (mut vault, cap) = vaults::new_tax_vault(config_id(), sc.ctx());

    let c = mint(1_000_000, &mut sc);
    vaults::deposit_tax(&mut vault, c);
    assert_eq!(vaults::tax_balance(&vault), 1_000_000);
    assert_eq!(vaults::tax_total_deposited(&vault), 1_000_000);

    let out = vaults::withdraw_tax(&mut vault, &cap, 400_000, sc.ctx());
    assert_eq!(out.value(), 400_000);
    // The invariant the analytics counters must always satisfy:
    //   balance == total_deposited - total_withdrawn
    assert_eq!(vaults::tax_balance(&vault), 600_000);
    assert_eq!(vaults::tax_total_withdrawn(&vault), 400_000);
    assert_eq!(
        vaults::tax_balance(&vault),
        vaults::tax_total_deposited(&vault) - vaults::tax_total_withdrawn(&vault),
    );

    destroy(out);
    destroy(vault);
    destroy(cap);
    sc.end();
}

#[test]
fun withdraw_full_balance_ok() {
    let mut sc = ts::begin(CREATOR);
    let (mut vault, cap) = vaults::new_tax_vault(config_id(), sc.ctx());
    vaults::deposit_tax(&mut vault, mint(500, &mut sc));

    let out = vaults::withdraw_tax(&mut vault, &cap, 500, sc.ctx());
    assert_eq!(out.value(), 500);
    assert_eq!(vaults::tax_balance(&vault), 0);

    destroy(out);
    destroy(vault);
    destroy(cap);
    sc.end();
}

#[test, expected_failure(abort_code = vaults::EInsufficientBalance)]
fun withdraw_over_balance_aborts() {
    let mut sc = ts::begin(CREATOR);
    let (mut vault, cap) = vaults::new_tax_vault(config_id(), sc.ctx());
    vaults::deposit_tax(&mut vault, mint(500, &mut sc));

    // One micro-unit over → fail loud, no silent capping.
    let out = vaults::withdraw_tax(&mut vault, &cap, 501, sc.ctx());

    destroy(out);
    destroy(vault);
    destroy(cap);
    sc.end();
}

#[test, expected_failure(abort_code = vaults::EWrongCap)]
fun withdraw_tax_with_foreign_cap_aborts() {
    let mut sc = ts::begin(CREATOR);
    // Two independent tax vaults; cap from vault B must not drain vault A (T4).
    let (mut vault_a, cap_a) = vaults::new_tax_vault(config_id(), sc.ctx());
    let (vault_b, cap_b) = vaults::new_tax_vault(config_id(), sc.ctx());
    vaults::deposit_tax(&mut vault_a, mint(1000, &mut sc));

    let out = vaults::withdraw_tax(&mut vault_a, &cap_b, 100, sc.ctx());

    destroy(out);
    destroy(vault_a);
    destroy(vault_b);
    destroy(cap_a);
    destroy(cap_b);
    sc.end();
}

// --- SavingsVault -------------------------------------------------------------

#[test]
fun new_savings_vault_is_empty_and_bound() {
    let mut sc = ts::begin(CREATOR);
    let (vault, cap) = vaults::new_savings_vault(config_id(), sc.ctx());
    assert_eq!(vaults::savings_balance(&vault), 0);
    assert_eq!(vaults::savings_config_id(&vault), config_id());
    destroy(vault);
    destroy(cap);
    sc.end();
}

#[test]
fun savings_deposit_withdraw_ok() {
    let mut sc = ts::begin(CREATOR);
    let (mut vault, cap) = vaults::new_savings_vault(config_id(), sc.ctx());
    vaults::deposit_savings(&mut vault, mint(2_000, &mut sc));

    let out = vaults::withdraw_savings(&mut vault, &cap, 750, sc.ctx());
    assert_eq!(out.value(), 750);
    assert_eq!(vaults::savings_balance(&vault), 1_250);
    assert_eq!(vaults::savings_total_deposited(&vault), 2_000);
    assert_eq!(vaults::savings_total_withdrawn(&vault), 750);

    destroy(out);
    destroy(vault);
    destroy(cap);
    sc.end();
}

#[test, expected_failure(abort_code = vaults::EWrongCap)]
fun withdraw_savings_with_foreign_cap_aborts() {
    let mut sc = ts::begin(CREATOR);
    let (mut vault_a, cap_a) = vaults::new_savings_vault(config_id(), sc.ctx());
    let (vault_b, cap_b) = vaults::new_savings_vault(config_id(), sc.ctx());
    vaults::deposit_savings(&mut vault_a, mint(1000, &mut sc));

    let out = vaults::withdraw_savings(&mut vault_a, &cap_b, 100, sc.ctx());

    destroy(out);
    destroy(vault_a);
    destroy(vault_b);
    destroy(cap_a);
    destroy(cap_b);
    sc.end();
}

// --- Monkey: hammer accounting across many ops -------------------------------

#[test]
fun monkey_many_deposits_and_partial_withdraws_keep_invariant() {
    let mut sc = ts::begin(CREATOR);
    let (mut vault, cap) = vaults::new_tax_vault(config_id(), sc.ctx());

    // Interleave 8 deposits and 8 partial withdrawals of varying sizes; after
    // every step the counter invariant must hold and balance must never wrap.
    let mut i = 0u64;
    while (i < 8) {
        vaults::deposit_tax(&mut vault, mint(1_000 + i * 137, &mut sc));
        let w = if (i % 2 == 0) { 300 } else { 50 };
        let out = vaults::withdraw_tax(&mut vault, &cap, w, sc.ctx());
        destroy(out);
        assert_eq!(
            vaults::tax_balance(&vault),
            vaults::tax_total_deposited(&vault) - vaults::tax_total_withdrawn(&vault),
        );
        i = i + 1;
    };

    destroy(vault);
    destroy(cap);
    sc.end();
}
