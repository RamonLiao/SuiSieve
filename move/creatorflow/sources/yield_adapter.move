/// The Scallop yield wrapper (spec §7). Routes a `SavingsVault`'s yield slice
/// into a yield venue and redeems it back. Two flows, matching the §7 failure
/// model:
///   - **Mode A (MVP/demo)**: `router::execute_split` calls `deposit` in the
///     same PTB. Move has NO try/catch — if the underlying venue call aborts,
///     the *entire* split PTB reverts; the dashboard retries with
///     `include_yield = false`. The "fallback" is that off-chain retry, not an
///     in-Move catch.
///   - **Mode B (v1)**: `execute_split` always parks the yield slice in
///     `SavingsVault`; a separate scheduled `sweep` PTB moves it to the venue
///     later, so the payment path never depends on venue uptime.
///
/// Dependency position (module-dependency.mmd): `yield_adapter → vaults`,
/// `yield_adapter → split_config` (for `StrategyRef` — a legal backward edge,
/// module 6 reading a type from module 3), `→ capabilities` (cap-gated redeem),
/// `→ mock_lending` (venue CPI seam).
///
/// **Position storage (Rule 7 / spec §3.3):** the position is a **dynamic
/// field** on the `SavingsVault`, NOT a struct field. This keeps `vaults`
/// venue-agnostic and dodges the non-compatible-upgrade cost of adding a
/// stored field later.
///
/// **Venue CPI seam (MVP scope):** `principal` is the settled net USDC (interest
/// folded in on each touch); the actual USDC lives in `MockMarket.principal_pool`.
/// Swapping `mock_lending` calls for real Scallop market-coin calls is the only
/// change needed to go live. Everything else — cap gating, accounting, settle
/// logic — is real. `StrategyRef.pool_id`/`kind` is recorded but not yet used
/// to route funds; the real CPI will validate it against the supplied pool.
module creatorflow::yield_adapter;

use creatorflow::capabilities::{Self, SavingsCap};
use creatorflow::mock_lending::{Self, MockMarket};
use creatorflow::split_config::StrategyRef;
use creatorflow::vaults::{Self, SavingsVault};
use sui::clock::Clock;
use sui::coin::Coin;
use sui::dynamic_field as df;
use usdc::usdc::USDC;

#[error]
const EWrongCap: vector<u8> =
    b"SavingsCap does not govern this vault (cross-vault cap reuse rejected)";
#[error]
const ENoPosition: vector<u8> = b"no yield position exists on this savings vault";
#[error]
const EInsufficientYield: vector<u8> = b"redeem amount exceeds settled principal";
#[error]
const EZeroRedeem: vector<u8> = b"redeem amount must be > 0";
#[error]
const EStrategyMismatch: vector<u8> = b"deposit strategy differs from the position's pinned strategy";
#[error]
const EClockRewind: vector<u8> = b"clock timestamp is before the position's last settle";

/// Positional dynamic-field key for the single yield position on a
/// `SavingsVault`. One position per vault (MVP); a multi-venue creator is a v1
/// concern that would key by `pool_id`.
public struct YieldKey() has copy, drop, store;

/// `principal` is the settled net USDC (interest folded in on each touch); the actual
/// USDC lives in `MockMarket.principal_pool`. `deposited_at_ms` is the accrual base.
public struct YieldPosition has store {
    strategy: StrategyRef,
    principal: u64,
    deposited_at_ms: u64,
}

/// Fold accrued interest (best-effort, capped at buffer) into principal and reset the
/// clock. NEVER aborts on a dry buffer — principal liveness is absolute.
fun settle(market: &mut MockMarket, position: &mut YieldPosition, now: u64) {
    assert!(now >= position.deposited_at_ms, EClockRewind);
    let rate = mock_lending::rate(market);
    let accrued = mock_lending::accrue(position.principal, rate, now - position.deposited_at_ms);
    let realized = mock_lending::realize_interest(market, accrued);
    position.principal = position.principal + realized;
    position.deposited_at_ms = now;
}

/// Mode A: deposit the carved yield `coin` into the vault's position via the market.
public(package) fun deposit(
    market: &mut MockMarket,
    vault: &mut SavingsVault,
    coin: Coin<USDC>,
    strategy: StrategyRef,
    clock: &Clock,
) {
    let now = clock.timestamp_ms();
    let uid = vaults::savings_uid_mut(vault);
    if (!df::exists<YieldKey>(uid, YieldKey())) {
        df::add(uid, YieldKey(), YieldPosition { strategy, principal: 0, deposited_at_ms: now });
    };
    let position = df::borrow_mut<YieldKey, YieldPosition>(uid, YieldKey());
    assert!(position.strategy == strategy, EStrategyMismatch);
    settle(market, position, now);
    let added = mock_lending::supply(market, coin);
    position.principal = position.principal + added;
    position.deposited_at_ms = now;
}

/// Mode B: move `amount` of already-banked savings into the yield position. SavingsCap-
/// gated (withdraw_savings asserts the cap binds this vault + covers `amount`).
public(package) fun sweep(
    market: &mut MockMarket,
    vault: &mut SavingsVault,
    cap: &SavingsCap,
    amount: u64,
    strategy: StrategyRef,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let coin = vaults::withdraw_savings(vault, cap, amount, ctx);
    deposit(market, vault, coin, strategy, clock);
}

/// Redeem `amount` USDC out of the position back to the caller. SavingsCap-gated + bound
/// to THIS vault (T4). Settles first (best-effort interest), then draws principal.
public(package) fun redeem(
    market: &mut MockMarket,
    vault: &mut SavingsVault,
    cap: &SavingsCap,
    amount: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<USDC> {
    assert!(capabilities::savings_cap_vault_id(cap) == object::id(vault), EWrongCap);
    assert!(amount > 0, EZeroRedeem);
    let now = clock.timestamp_ms();
    let uid = vaults::savings_uid_mut(vault);
    assert!(df::exists<YieldKey>(uid, YieldKey()), ENoPosition);
    let position = df::borrow_mut<YieldKey, YieldPosition>(uid, YieldKey());
    settle(market, position, now);
    assert!(amount <= position.principal, EInsufficientYield);
    position.principal = position.principal - amount;
    mock_lending::redeem(market, amount, ctx)
}

// --- test-only helpers -------------------------------------------------------

/// Expose `settle` with an explicit `now_ms` so tests can drive `EClockRewind`
/// without needing a backwards-moving Clock (Sui's clock enforces monotonicity,
/// making it impossible to reach the guard through the normal Clock API).
#[test_only]
public fun settle_at_for_testing(
    market: &mut MockMarket,
    vault: &mut SavingsVault,
    now_ms: u64,
) {
    let uid = vaults::savings_uid_mut(vault);
    assert!(df::exists<YieldKey>(uid, YieldKey()), ENoPosition);
    let position = df::borrow_mut<YieldKey, YieldPosition>(uid, YieldKey());
    settle(market, position, now_ms);
}

// --- getters -----------------------------------------------------------------

/// Whether the savings vault has an open yield position.
public fun has_position(vault: &SavingsVault): bool {
    df::exists<YieldKey>(vaults::savings_uid(vault), YieldKey())
}

/// Live redeemable value: settled principal + interest accrued since last settle
/// (display figure; uncapped by buffer — actual realize is best-effort on touch).
public fun position_value(vault: &SavingsVault, market: &MockMarket, clock: &Clock): u64 {
    let uid = vaults::savings_uid(vault);
    if (!df::exists<YieldKey>(uid, YieldKey())) return 0;
    let position = df::borrow<YieldKey, YieldPosition>(uid, YieldKey());
    let now = clock.timestamp_ms();
    let elapsed = if (now >= position.deposited_at_ms) now - position.deposited_at_ms else 0;
    position.principal + mock_lending::accrue(position.principal, mock_lending::rate(market), elapsed)
}

/// Net principal supplied into the position (0 if none).
public fun position_principal(vault: &SavingsVault): u64 {
    let uid = vaults::savings_uid(vault);
    if (!df::exists<YieldKey>(uid, YieldKey())) return 0;
    df::borrow<YieldKey, YieldPosition>(uid, YieldKey()).principal
}
