#[test_only]
module creatorflow::router_tests;

use creatorflow::router;
use creatorflow::split_config::{Self, SplitConfig};
use creatorflow::protocol_config::{Self, ProtocolConfig, AdminCap};
use creatorflow::capabilities::{OwnerCap, TaxCap, SavingsCap};
use creatorflow::vaults::{Self, TaxVault, SavingsVault};
use creatorflow::yield_adapter;
use sui::test_scenario as ts;
use sui::coin::{Self, Coin};
use sui::clock;
use usdc::usdc::USDC;
use std::unit_test::{assert_eq, destroy};

const CREATOR: address = @0xC;
const ALICE: address = @0xA1;
const BOB: address = @0xB0;
const TREASURY: address = @0x73;
const PAYER: address = @0xFA1;

// Standard split: alice 6000 + bob 3000 + tax 500 + savings 450 + fee 50 = 10000,
// yield 400 (<= savings 450). A clean allocation reused across tests.
fun standard_recipients(): vector<split_config::Recipient> {
    vector[
        split_config::new_recipient(ALICE, 6000, b"alice"),
        split_config::new_recipient(BOB, 3000, b"bob"),
    ]
}

fun strategy(): Option<split_config::StrategyRef> {
    option::some(split_config::new_strategy_ref(0, object::id_from_address(@0x5CA)))
}

fun mint(amount: u64, sc: &mut ts::Scenario): Coin<USDC> {
    coin::mint_for_testing<USDC>(amount, sc.ctx())
}

// Publish the protocol and point its treasury at a distinct address (so the fee
// slice is easy to isolate from the creator's caps in assertions).
fun init_protocol(sc: &mut ts::Scenario) {
    protocol_config::init_for_testing(sc.ctx());
    sc.next_tx(CREATOR);
    let mut protocol = sc.take_shared<ProtocolConfig>();
    let admin = sc.take_from_sender<AdminCap>();
    protocol_config::set_treasury(&mut protocol, &admin, TREASURY);
    ts::return_shared(protocol);
    sc.return_to_sender(admin);
    // Materialize the returned shared ProtocolConfig so the next take sees it.
    sc.next_tx(CREATOR);
}

// Create config + vaults via the router with the given yield strategy. Leaves
// the scenario at a fresh tx where the shared objects + caps are takeable.
fun create(yield_strategy: Option<split_config::StrategyRef>, sc: &mut ts::Scenario) {
    let protocol = sc.take_shared<ProtocolConfig>();
    router::create_config_and_vaults(
        &protocol,
        standard_recipients(),
        500,   // tax
        450,   // savings
        50,    // fee
        400,   // yield
        yield_strategy,
        sc.ctx(),
    );
    ts::return_shared(protocol);
    sc.next_tx(CREATOR);
}

// --- create_config_and_vaults ------------------------------------------------

#[test]
fun create_wires_everything_and_binds_caps() {
    let mut sc = ts::begin(CREATOR);
    init_protocol(&mut sc);
    create(strategy(), &mut sc);

    let config = sc.take_shared<SplitConfig>();
    let tax_vault = sc.take_shared<TaxVault>();
    let savings_vault = sc.take_shared<SavingsVault>();
    let owner_cap = sc.take_from_sender<OwnerCap>();
    let tax_cap = sc.take_from_sender<TaxCap>();
    let savings_cap = sc.take_from_sender<SavingsCap>();

    let config_id = object::id(&config);
    // Bidirectional binding is fully wired (T9): config ↔ vault both ways.
    assert_eq!(vaults::tax_config_id(&tax_vault), config_id);
    assert_eq!(vaults::savings_config_id(&savings_vault), config_id);
    assert_eq!(split_config::tax_vault_id(&config), object::id(&tax_vault));
    assert_eq!(split_config::savings_vault_id(&config), object::id(&savings_vault));
    assert_eq!(split_config::version(&config), 0);

    ts::return_shared(config);
    ts::return_shared(tax_vault);
    ts::return_shared(savings_vault);
    sc.return_to_sender(owner_cap);
    sc.return_to_sender(tax_cap);
    sc.return_to_sender(savings_cap);
    sc.end();
}

/// create_config_and_vaults emits exactly one user event: the ConfigCreated the
/// indexer needs to register the config. (Protocol init + set_treasury are
/// event-silent, so a clean create tx has exactly one emitted event.)
#[test]
fun create_emits_config_created_once() {
    let mut sc = ts::begin(CREATOR);
    init_protocol(&mut sc);

    let protocol = sc.take_shared<ProtocolConfig>();
    router::create_config_and_vaults(
        &protocol,
        standard_recipients(),
        500, 450, 50, 400,
        strategy(),
        sc.ctx(),
    );
    ts::return_shared(protocol);
    let eff = sc.next_tx(CREATOR);

    assert_eq!(ts::num_user_events(&eff), 1);
    sc.end();
}

// --- execute_split: happy path -----------------------------------------------

#[test]
fun execute_split_routes_all_slices_and_emits_once() {
    let mut sc = ts::begin(CREATOR);
    init_protocol(&mut sc);
    create(strategy(), &mut sc);

    let config = sc.take_shared<SplitConfig>();
    let protocol = sc.take_shared<ProtocolConfig>();
    let mut tax_vault = sc.take_shared<TaxVault>();
    let mut savings_vault = sc.take_shared<SavingsVault>();

    let amount = 1_000_000u64;
    sc.next_tx(PAYER);
    let pay = mint(amount, &mut sc);
    let clk = clock::create_for_testing(sc.ctx());
    router::execute_split(
        &config, &protocol, &mut tax_vault, &mut savings_vault,
        pay, true, 0, &clk, sc.ctx(),
    );
    let eff = sc.next_tx(CREATOR);

    // Exactly one SplitExecuted event for the whole settlement.
    assert_eq!(ts::num_user_events(&eff), 1);

    // tax 5% = 50_000; savings 4.5% = 45_000, of which yield 4% = 40_000 routed
    // to the position, leaving 5_000 in the savings vault balance.
    assert_eq!(vaults::tax_balance(&tax_vault), 50_000);
    assert_eq!(vaults::savings_balance(&savings_vault), 5_000);
    assert_eq!(yield_adapter::position_value(&savings_vault), 40_000);

    // recipients: alice 60% = 600_000; bob (last) 30% = 300_000 (exact, no dust).
    let alice_coin = sc.take_from_address<Coin<USDC>>(ALICE);
    let bob_coin = sc.take_from_address<Coin<USDC>>(BOB);
    let fee_coin = sc.take_from_address<Coin<USDC>>(TREASURY);
    assert_eq!(alice_coin.value(), 600_000);
    assert_eq!(bob_coin.value(), 300_000);
    assert_eq!(fee_coin.value(), 5_000); // 0.5%

    // Conservation: nothing created or destroyed.
    let total = alice_coin.value() + bob_coin.value() + fee_coin.value()
        + vaults::tax_balance(&tax_vault) + vaults::savings_balance(&savings_vault)
        + yield_adapter::position_value(&savings_vault);
    assert_eq!(total, amount);

    destroy(alice_coin);
    destroy(bob_coin);
    destroy(fee_coin);
    clk.destroy_for_testing();
    ts::return_shared(config);
    ts::return_shared(protocol);
    ts::return_shared(tax_vault);
    ts::return_shared(savings_vault);
    sc.end();
}

// --- execute_split: yield off keeps the slice in savings ---------------------

#[test]
fun execute_split_without_yield_banks_slice_to_savings() {
    let mut sc = ts::begin(CREATOR);
    init_protocol(&mut sc);
    create(strategy(), &mut sc);

    let config = sc.take_shared<SplitConfig>();
    let protocol = sc.take_shared<ProtocolConfig>();
    let mut tax_vault = sc.take_shared<TaxVault>();
    let mut savings_vault = sc.take_shared<SavingsVault>();

    sc.next_tx(PAYER);
    let pay = mint(1_000_000, &mut sc);
    let clk = clock::create_for_testing(sc.ctx());
    // include_yield = false → the 40_000 yield slice stays in the savings vault.
    router::execute_split(
        &config, &protocol, &mut tax_vault, &mut savings_vault,
        pay, false, 0, &clk, sc.ctx(),
    );
    sc.next_tx(CREATOR);

    assert_eq!(vaults::savings_balance(&savings_vault), 45_000); // full savings slice
    assert!(!yield_adapter::has_position(&savings_vault));       // no position opened

    clk.destroy_for_testing();
    cleanup_payouts(&sc);
    ts::return_shared(config);
    ts::return_shared(protocol);
    ts::return_shared(tax_vault);
    ts::return_shared(savings_vault);
    sc.end();
}

// --- execute_split: no strategy → yield never routes even if asked -----------

#[test]
fun execute_split_no_strategy_ignores_include_yield() {
    let mut sc = ts::begin(CREATOR);
    init_protocol(&mut sc);
    create(option::none(), &mut sc); // no strategy configured

    let config = sc.take_shared<SplitConfig>();
    let protocol = sc.take_shared<ProtocolConfig>();
    let mut tax_vault = sc.take_shared<TaxVault>();
    let mut savings_vault = sc.take_shared<SavingsVault>();

    sc.next_tx(PAYER);
    let pay = mint(1_000_000, &mut sc);
    let clk = clock::create_for_testing(sc.ctx());
    // include_yield = true but strategy is none → route_yield is false.
    router::execute_split(
        &config, &protocol, &mut tax_vault, &mut savings_vault,
        pay, true, 0, &clk, sc.ctx(),
    );
    sc.next_tx(CREATOR);

    assert_eq!(vaults::savings_balance(&savings_vault), 45_000);
    assert!(!yield_adapter::has_position(&savings_vault));

    clk.destroy_for_testing();
    cleanup_payouts(&sc);
    ts::return_shared(config);
    ts::return_shared(protocol);
    ts::return_shared(tax_vault);
    ts::return_shared(savings_vault);
    sc.end();
}

// --- Red team: stale config version (T2) -------------------------------------

#[test, expected_failure(abort_code = router::EConfigChanged)]
fun execute_split_rejects_stale_version() {
    let mut sc = ts::begin(CREATOR);
    init_protocol(&mut sc);
    create(strategy(), &mut sc);

    let config = sc.take_shared<SplitConfig>();
    let protocol = sc.take_shared<ProtocolConfig>();
    let mut tax_vault = sc.take_shared<TaxVault>();
    let mut savings_vault = sc.take_shared<SavingsVault>();

    sc.next_tx(PAYER);
    let pay = mint(1_000_000, &mut sc);
    let clk = clock::create_for_testing(sc.ctx());
    // Payer expects version 1, but the live config is still 0 → abort.
    router::execute_split(
        &config, &protocol, &mut tax_vault, &mut savings_vault,
        pay, true, 1, &clk, sc.ctx(),
    );

    abort // unreachable
}

// --- Red team: zero-value spam (T6) ------------------------------------------

#[test, expected_failure(abort_code = router::EZeroPayment)]
fun execute_split_rejects_zero_payment() {
    let mut sc = ts::begin(CREATOR);
    init_protocol(&mut sc);
    create(strategy(), &mut sc);

    let config = sc.take_shared<SplitConfig>();
    let protocol = sc.take_shared<ProtocolConfig>();
    let mut tax_vault = sc.take_shared<TaxVault>();
    let mut savings_vault = sc.take_shared<SavingsVault>();

    sc.next_tx(PAYER);
    // A zero-value coin: would otherwise mint zero-coin objects at every
    // recipient + emit a junk SplitExecuted at only gas cost. Must abort.
    let pay = mint(0, &mut sc);
    let clk = clock::create_for_testing(sc.ctx());
    router::execute_split(
        &config, &protocol, &mut tax_vault, &mut savings_vault,
        pay, true, 0, &clk, sc.ctx(),
    );

    abort // unreachable
}

// --- Red team: fake vault impersonation (T9) ---------------------------------

#[test, expected_failure(abort_code = router::EVaultMismatch)]
fun execute_split_rejects_foreign_vault() {
    let mut sc = ts::begin(CREATOR);
    init_protocol(&mut sc);
    create(strategy(), &mut sc);

    let config = sc.take_shared<SplitConfig>();
    let protocol = sc.take_shared<ProtocolConfig>();
    let savings_vault = sc.take_shared<SavingsVault>();

    // A tax vault bound to a *different* config id — the attacker's swap.
    let (mut foreign_tax, foreign_tax_cap) =
        vaults::new_tax_vault(object::id_from_address(@0xBEEF), sc.ctx());

    sc.next_tx(PAYER);
    let pay = mint(1_000_000, &mut sc);
    let clk = clock::create_for_testing(sc.ctx());
    let mut savings_vault = savings_vault;
    // config + foreign tax vault → tax_vault.config_id != config.id → abort.
    router::execute_split(
        &config, &protocol, &mut foreign_tax, &mut savings_vault,
        pay, true, 0, &clk, sc.ctx(),
    );

    destroy(foreign_tax); destroy(foreign_tax_cap);
    clk.destroy_for_testing();
    abort // unreachable
}

// --- Dust: indivisible amount, last recipient absorbs remainder --------------

#[test]
fun execute_split_dust_goes_to_last_recipient_no_loss() {
    let mut sc = ts::begin(CREATOR);
    init_protocol(&mut sc);
    create(strategy(), &mut sc);

    let config = sc.take_shared<SplitConfig>();
    let protocol = sc.take_shared<ProtocolConfig>();
    let mut tax_vault = sc.take_shared<TaxVault>();
    let mut savings_vault = sc.take_shared<SavingsVault>();

    // A prime-ish gross that no bps divides evenly.
    let amount = 1_000_003u64;
    sc.next_tx(PAYER);
    let pay = mint(amount, &mut sc);
    let clk = clock::create_for_testing(sc.ctx());
    router::execute_split(
        &config, &protocol, &mut tax_vault, &mut savings_vault,
        pay, true, 0, &clk, sc.ctx(),
    );
    sc.next_tx(CREATOR);

    let alice_coin = sc.take_from_address<Coin<USDC>>(ALICE);
    let bob_coin = sc.take_from_address<Coin<USDC>>(BOB);
    let fee_coin = sc.take_from_address<Coin<USDC>>(TREASURY);

    // Everything still sums to the exact gross — no micro-USDC vanished.
    let total = alice_coin.value() + bob_coin.value() + fee_coin.value()
        + vaults::tax_balance(&tax_vault) + vaults::savings_balance(&savings_vault)
        + yield_adapter::position_value(&savings_vault);
    assert_eq!(total, amount);
    // alice took her exact floor; bob (last) carries the dust units on top.
    assert_eq!(alice_coin.value(), 600_001); // floor(1_000_003 * 0.6)
    assert!(bob_coin.value() >= 300_000);

    destroy(alice_coin);
    destroy(bob_coin);
    destroy(fee_coin);
    clk.destroy_for_testing();
    ts::return_shared(config);
    ts::return_shared(protocol);
    ts::return_shared(tax_vault);
    ts::return_shared(savings_vault);
    sc.end();
}

// --- mutate_config bumps version + emits -------------------------------------

#[test]
fun mutate_config_bumps_version_and_emits() {
    let mut sc = ts::begin(CREATOR);
    init_protocol(&mut sc);
    create(strategy(), &mut sc);

    let mut config = sc.take_shared<SplitConfig>();
    let owner_cap = sc.take_from_sender<OwnerCap>();
    let protocol = sc.take_shared<ProtocolConfig>();

    // Re-balance to alice 9000 + bob 100 + tax 400 + savings 450 + fee 50 = 10000.
    // savings stays >= the unchanged yield_bps (400), per the config invariant.
    router::mutate_config(
        &mut config, &owner_cap, &protocol,
        vector[
            split_config::new_recipient(ALICE, 9000, b"a"),
            split_config::new_recipient(BOB, 100, b"b"),
        ],
        400, 450, sc.ctx(),
    );
    let eff = sc.next_tx(CREATOR);

    assert_eq!(ts::num_user_events(&eff), 1); // ConfigMutated
    assert_eq!(split_config::version(&config), 1);

    ts::return_shared(config);
    ts::return_shared(protocol);
    sc.return_to_sender(owner_cap);
    sc.end();
}

// --- withdraw + redeem wrappers ----------------------------------------------

#[test]
fun withdraw_and_redeem_route_funds_to_caller() {
    let mut sc = ts::begin(CREATOR);
    init_protocol(&mut sc);
    create(strategy(), &mut sc);

    let config = sc.take_shared<SplitConfig>();
    let protocol = sc.take_shared<ProtocolConfig>();
    let mut tax_vault = sc.take_shared<TaxVault>();
    let mut savings_vault = sc.take_shared<SavingsVault>();

    // Fund the vaults via one split.
    sc.next_tx(PAYER);
    let pay = mint(1_000_000, &mut sc);
    let clk = clock::create_for_testing(sc.ctx());
    router::execute_split(
        &config, &protocol, &mut tax_vault, &mut savings_vault,
        pay, true, 0, &clk, sc.ctx(),
    );
    sc.next_tx(CREATOR);
    cleanup_payouts(&sc);

    let tax_cap = sc.take_from_sender<TaxCap>();
    let savings_cap = sc.take_from_sender<SavingsCap>();

    router::withdraw_tax(&mut tax_vault, &tax_cap, 20_000, sc.ctx());
    router::withdraw_savings(&mut savings_vault, &savings_cap, 1_000, sc.ctx());
    router::redeem_yield(&mut savings_vault, &savings_cap, 10_000, sc.ctx());
    sc.next_tx(CREATOR);

    assert_eq!(vaults::tax_balance(&tax_vault), 30_000);          // 50_000 - 20_000
    assert_eq!(vaults::savings_balance(&savings_vault), 4_000);   // 5_000 - 1_000
    assert_eq!(yield_adapter::position_value(&savings_vault), 30_000); // 40_000 - 10_000

    // Three coins landed with the creator.
    let total = drain_address(&sc, CREATOR);
    assert_eq!(total, 31_000);

    clk.destroy_for_testing();
    sc.return_to_sender(tax_cap);
    sc.return_to_sender(savings_cap);
    ts::return_shared(config);
    ts::return_shared(protocol);
    ts::return_shared(tax_vault);
    ts::return_shared(savings_vault);
    sc.end();
}

// --- wire_vaults is one-time (binding immutable after creation) --------------

#[test, expected_failure(abort_code = split_config::EAlreadyWired)]
fun wire_vaults_rejects_rebind() {
    let mut sc = ts::begin(CREATOR);
    init_protocol(&mut sc);

    let protocol = sc.take_shared<ProtocolConfig>();
    let (mut config, owner_cap) = split_config::new_unwired(
        &protocol, standard_recipients(), 500, 450, 50, 400, strategy(), sc.ctx(),
    );
    split_config::wire_vaults(&mut config, object::id_from_address(@0x1), object::id_from_address(@0x2));
    // Second wiring attempt must abort — bindings are fixed after the first.
    split_config::wire_vaults(&mut config, object::id_from_address(@0x3), object::id_from_address(@0x4));

    destroy(config); destroy(owner_cap);
    ts::return_shared(protocol);
    sc.end();
}

// --- Monkey: hammer many gross amounts, conservation must always hold --------

#[test]
fun monkey_varied_amounts_conserve_value() {
    let mut sc = ts::begin(CREATOR);
    init_protocol(&mut sc);
    create(strategy(), &mut sc);

    let config = sc.take_shared<SplitConfig>();
    let protocol = sc.take_shared<ProtocolConfig>();
    let mut tax_vault = sc.take_shared<TaxVault>();
    let mut savings_vault = sc.take_shared<SavingsVault>();

    sc.next_tx(PAYER);
    let clk = clock::create_for_testing(sc.ctx());

    let mut running = 0u64; // total gross pushed in
    let mut i = 0u64;
    while (i < 10) {
        // Awkward amounts: small, large, prime-ish, +1 boundaries.
        let amount = 1 + i * 333_667 + (i * 7) % 11;
        sc.next_tx(PAYER);
        let pay = mint(amount, &mut sc);
        router::execute_split(
            &config, &protocol, &mut tax_vault, &mut savings_vault,
            pay, true, 0, &clk, sc.ctx(),
        );
        running = running + amount;
        i = i + 1;
    };
    sc.next_tx(CREATOR);

    // Sum everything that left the system (recipient coins) plus everything that
    // stayed (vault balances + yield position) — must equal total pushed in.
    let mut received = vaults::tax_balance(&tax_vault)
        + vaults::savings_balance(&savings_vault)
        + yield_adapter::position_value(&savings_vault);
    received = received + drain_address(&sc, ALICE);
    received = received + drain_address(&sc, BOB);
    received = received + drain_address(&sc, TREASURY);
    assert_eq!(received, running);

    clk.destroy_for_testing();
    ts::return_shared(config);
    ts::return_shared(protocol);
    ts::return_shared(tax_vault);
    ts::return_shared(savings_vault);
    sc.end();
}

// --- helpers -----------------------------------------------------------------

// Discard the recipient/fee coins produced by a split we don't assert on.
fun cleanup_payouts(sc: &ts::Scenario) {
    drain_address(sc, ALICE);
    drain_address(sc, BOB);
    drain_address(sc, TREASURY);
}

// Sum + destroy every USDC coin currently owned by `who`.
fun drain_address(sc: &ts::Scenario, who: address): u64 {
    let mut sum = 0u64;
    while (ts::has_most_recent_for_address<Coin<USDC>>(who)) {
        let c = sc.take_from_address<Coin<USDC>>(who);
        sum = sum + c.value();
        destroy(c);
    };
    sum
}
