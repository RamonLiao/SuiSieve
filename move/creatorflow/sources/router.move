/// The PTB entry path (spec §4.2): `execute_split` is the atomic flow a payer
/// signs, plus the owner-side wrappers (`create_config_and_vaults`,
/// `mutate_config`, `withdraw_*`, `redeem_yield`). This is the *only* module
/// that holds all the arrows of the dependency graph — it orchestrates the lower
/// modules and owns every event emission (the lower modules stay event-silent so
/// the schema lives in one auditable place; see `events` module header).
///
/// Dependency position (module-dependency.mmd): `router → {split_config, vaults,
/// capabilities, protocol_config, yield_adapter, events}` — the top of the graph.
///
/// **Why `&SplitConfig` (immutable) on the hot path:** Move's reference rules
/// linearize an in-flight split against any config mutation for free — a payer
/// reads the config they pinned (`expected_version`) and no `&mut` edit can race
/// it. `ProtocolConfig` is read `&` too, so neither config object contends under
/// the UC-2 fan burst; only the two vaults take `&mut` (the T10 serialization
/// point, load-tested separately).
module creatorflow::router;

use creatorflow::capabilities::{OwnerCap, TaxCap, SavingsCap};
use creatorflow::events;
use creatorflow::mock_lending::MockMarket;
use creatorflow::protocol_config::{Self, ProtocolConfig};
use creatorflow::split_config::{Self, SplitConfig, Recipient, StrategyRef};
use creatorflow::vaults::{Self, TaxVault, SavingsVault};
use creatorflow::yield_adapter;
use sui::clock::Clock;
use sui::coin::Coin;
use usdc::usdc::USDC;

#[error]
const EConfigChanged: vector<u8> =
    b"config.version != expected_version: the split was edited after the payer saw it (T2)";

#[error]
const EVaultMismatch: vector<u8> =
    b"a supplied vault is not bound to this config (fake-vault impersonation, T9)";

#[error]
const EZeroPayment: vector<u8> =
    b"payment amount must be > 0 (rejects zero-value spam: object bloat + event poisoning, T6)";

/// Create a `SplitConfig` + its `TaxVault`/`SavingsVault`, all bound to each
/// other, shared, with the three governing caps transferred to the caller.
///
/// Breaks the ID cycle (config stores vault IDs; vaults store config ID, both
/// fixed for T9) within Sui's constraint that an object's `UID` must be minted
/// in the same function that builds it: create the config first (vault IDs left
/// at a sentinel) → derive `config_id` → build the vaults with it → `wire_vaults`
/// records the now-known vault IDs back on the config. `new_unwired` runs the
/// full allocation invariant, so a bad split aborts before any vault is created.
#[allow(lint(self_transfer))]
public fun create_config_and_vaults(
    protocol: &ProtocolConfig,
    recipients: vector<Recipient>,
    tax_bps: u16,
    savings_bps: u16,
    protocol_fee_bps: u16,
    yield_bps: u16,
    yield_strategy: Option<StrategyRef>,
    ctx: &mut TxContext,
) {
    let (mut config, owner_cap) = split_config::new_unwired(
        protocol,
        recipients,
        tax_bps,
        savings_bps,
        protocol_fee_bps,
        yield_bps,
        yield_strategy,
        ctx,
    );
    let config_id = object::id(&config);

    let (tax_vault, tax_cap) = vaults::new_tax_vault(config_id, ctx);
    let (savings_vault, savings_cap) = vaults::new_savings_vault(config_id, ctx);
    split_config::wire_vaults(
        &mut config,
        object::id(&tax_vault),
        object::id(&savings_vault),
    );

    let creator = ctx.sender();
    events::emit_config_created(
        config_id,
        object::id(&tax_vault),
        object::id(&savings_vault),
        creator,
    );
    transfer::public_transfer(owner_cap, creator);
    transfer::public_transfer(tax_cap, creator);
    transfer::public_transfer(savings_cap, creator);
    split_config::share(config);
    vaults::share_tax(tax_vault);
    vaults::share_savings(savings_vault);
}

/// The shared split body — fee/tax/savings/recipient/dust + SplitExecuted emit. Returns
/// the carved yield coin as `some(coin)` ONLY when `route_yield && yield_amt > 0`, else
/// `none`. References can't live in `Option`, so the market is routed by the caller.
public(package) fun split_core(
    config: &SplitConfig,
    protocol: &ProtocolConfig,
    tax_vault: &mut TaxVault,
    savings_vault: &mut SavingsVault,
    mut payment: Coin<USDC>,
    route_yield: bool,
    expected_version: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): Option<Coin<USDC>> {
    assert!(split_config::version(config) == expected_version, EConfigChanged);
    let config_id = object::id(config);
    assert!(vaults::tax_config_id(tax_vault) == config_id, EVaultMismatch);
    assert!(vaults::savings_config_id(savings_vault) == config_id, EVaultMismatch);
    assert!(split_config::tax_vault_id(config) == object::id(tax_vault), EVaultMismatch);
    assert!(split_config::savings_vault_id(config) == object::id(savings_vault), EVaultMismatch);

    let amount_in = payment.value();
    assert!(amount_in > 0, EZeroPayment);
    let denom = (protocol_config::bps_denominator() as u128);

    let fee_amt = slice(amount_in, split_config::protocol_fee_bps(config), denom);
    if (fee_amt > 0) {
        transfer::public_transfer(payment.split(fee_amt, ctx), protocol_config::treasury(protocol));
    };

    let tax_amt = slice(amount_in, split_config::tax_bps(config), denom);
    if (tax_amt > 0) { vaults::deposit_tax(tax_vault, payment.split(tax_amt, ctx)); };

    let savings_total = slice(amount_in, split_config::savings_bps(config), denom);
    let yield_amt = slice(amount_in, split_config::yield_bps(config), denom);
    // Option contract = "is there a NON-ZERO coin to route" (red-team #5).
    let do_yield = route_yield && split_config::yield_strategy(config).is_some() && yield_amt > 0;
    let mut savings_coin = payment.split(savings_total, ctx);

    let savings_deposited;
    let yield_deposited;
    let yield_out;
    if (do_yield) {
        yield_out = option::some(savings_coin.split(yield_amt, ctx));
        savings_deposited = savings_total - yield_amt;
        yield_deposited = yield_amt;
    } else {
        yield_out = option::none();
        savings_deposited = savings_total;
        yield_deposited = 0;
    };
    vaults::deposit_savings(savings_vault, savings_coin);

    let recipients = split_config::recipients(config);
    let n = recipients.length();
    let mut payouts = vector[];
    let mut i = 0;
    while (i < n) {
        let r = recipients.borrow(i);
        let addr = split_config::recipient_addr(r);
        let bps = split_config::recipient_bps(r);
        let amt = if (i + 1 == n) { payment.value() } else { slice(amount_in, bps, denom) };
        transfer::public_transfer(payment.split(amt, ctx), addr);
        payouts.push_back(events::new_recipient_payout(addr, amt, bps));
        i = i + 1;
    };
    if (n == 0) { vaults::deposit_savings(savings_vault, payment); } else { payment.destroy_zero(); };

    events::emit_split_executed(
        config_id, split_config::version(config), amount_in, payouts,
        tax_amt, savings_deposited, fee_amt, yield_deposited, do_yield, clock.timestamp_ms(),
    );
    yield_out
}

/// The payment hot path (spec §4.2). Plain path — NEVER routes yield to a venue
/// (would force every split to lock MockMarket → kills T10). The yield slice, if
/// any, stays in savings (`route_yield = false` ⇒ always `none`).
///
/// `_include_yield` is kept for PTB/ABI compatibility but is intentionally
/// ignored; use `execute_split_with_yield` to route the yield sub-slice.
public fun execute_split(
    config: &SplitConfig,
    protocol: &ProtocolConfig,
    tax_vault: &mut TaxVault,
    savings_vault: &mut SavingsVault,
    payment: Coin<USDC>,
    _include_yield: bool,
    expected_version: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let leftover = split_core(config, protocol, tax_vault, savings_vault, payment, false, expected_version, clock, ctx);
    leftover.destroy_none();
}

/// Opt-in yield path: same split, but routes the yield sub-slice through `mock_lending`.
/// The ONLY entry taking `&mut MockMarket` (so it does NOT serialize the plain hot path).
public fun execute_split_with_yield(
    config: &SplitConfig,
    protocol: &ProtocolConfig,
    market: &mut MockMarket,
    tax_vault: &mut TaxVault,
    savings_vault: &mut SavingsVault,
    payment: Coin<USDC>,
    expected_version: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let yield_out = split_core(config, protocol, tax_vault, savings_vault, payment, true, expected_version, clock, ctx);
    if (yield_out.is_some()) {
        let yc = yield_out.destroy_some();
        let strategy = *split_config::yield_strategy(config).borrow();
        yield_adapter::deposit(market, savings_vault, yc, strategy, clock);
    } else {
        yield_out.destroy_none();
    };
}

/// Mutate a config's recipients/allocation (spec §4.4), then emit
/// `ConfigMutated`. `split_config::update_recipients` is `OwnerCap`-gated and
/// bumps `version`; emission lives here so `split_config` stays event-silent
/// (dependency-graph rule). The `version` bump invalidates every outstanding
/// pay-link (§6.1) — clients re-read the version at sign time.
public fun mutate_config(
    config: &mut SplitConfig,
    owner_cap: &OwnerCap,
    protocol: &ProtocolConfig,
    new_recipients: vector<Recipient>,
    new_tax_bps: u16,
    new_savings_bps: u16,
    ctx: &TxContext,
) {
    let old_version = split_config::version(config);
    split_config::update_recipients(
        config,
        owner_cap,
        protocol,
        new_recipients,
        new_tax_bps,
        new_savings_bps,
    );
    events::emit_config_mutated(
        object::id(config),
        old_version,
        split_config::version(config),
        ctx.sender(),
    );
}

/// Withdraw `amount` from the tax vault to the caller and emit `VaultWithdrawn`.
/// `TaxCap`-gated (the assert lives in `vaults::withdraw_tax`); wraps the
/// event-silent vault call so the indexer sees the withdrawal.
#[allow(lint(self_transfer))]
public fun withdraw_tax(
    vault: &mut TaxVault,
    cap: &TaxCap,
    amount: u64,
    ctx: &mut TxContext,
) {
    let coin = vaults::withdraw_tax(vault, cap, amount, ctx);
    let to = ctx.sender();
    events::emit_vault_withdrawn(object::id(vault), events::kind_tax(), amount, to);
    transfer::public_transfer(coin, to);
}

/// Withdraw `amount` from the savings vault to the caller. Same contract as
/// `withdraw_tax`, `SavingsCap`-gated.
#[allow(lint(self_transfer))]
public fun withdraw_savings(
    vault: &mut SavingsVault,
    cap: &SavingsCap,
    amount: u64,
    ctx: &mut TxContext,
) {
    let coin = vaults::withdraw_savings(vault, cap, amount, ctx);
    let to = ctx.sender();
    events::emit_vault_withdrawn(object::id(vault), events::kind_savings(), amount, to);
    transfer::public_transfer(coin, to);
}

/// Redeem `amount` of USDC out of the savings vault's yield position to the
/// caller (spec §5 "Drain yield only"). `SavingsCap`-gated in
/// `yield_adapter::redeem`; emits `VaultWithdrawn` with the savings discriminant
/// (the funds leave the savings vault's yield position).
#[allow(lint(self_transfer))]
public fun redeem_yield(
    market: &mut MockMarket,
    savings_vault: &mut SavingsVault,
    cap: &SavingsCap,
    amount: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let coin = yield_adapter::redeem(market, savings_vault, cap, amount, clock, ctx);
    let to = ctx.sender();
    events::emit_vault_withdrawn(object::id(savings_vault), events::kind_savings(), amount, to);
    transfer::public_transfer(coin, to);
}

/// Floor of `amount * bps / 10000`, computed on `u128` so the product cannot
/// overflow `u64` (max `amount * 10000 ≈ 1.8e23 << u128 max`).
fun slice(amount: u64, bps: u16, denom: u128): u64 {
    (((amount as u128) * (bps as u128)) / denom) as u64
}
