/// A demo yield venue (spec 2026-06-21-yield-mock-venue-design). Real Scallop is
/// type-incompatible (wUSDC != Circle-native USDC), so this in-house market is the
/// type-compatible stand-in that the `yield_adapter` seam plugs into. Funds are
/// SEGREGATED: `principal_pool` always backs Σ settled principal (a principal redeem
/// is never stranded); `interest_buffer` is the seeded USDC that pays yield. On settle,
/// realized interest moves buffer→principal_pool, but only `min(accrued, buffer)` —
/// best-effort, NEVER aborts on a dry buffer (principal liveness is absolute).
module creatorflow::mock_lending;

use creatorflow::protocol_config::AdminCap;
use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};
use sui::object::{Self, ID};
use sui::transfer;
use usdc::usdc::USDC;

/// Demo-unrealistic by design (visible delta in seconds). Adjustable via `set_rate`.
const DEMO_RATE_BPS_PER_SEC: u64 = 5;
/// Overflow guard (NOT economic): bounds the u128 `principal·rate·elapsed` product.
const MAX_RATE_BPS_PER_SEC: u64 = 100_000;
const BPS_DENOM: u128 = 10_000;
const MS_PER_SEC: u128 = 1_000;
const U64_MAX: u128 = 18_446_744_073_709_551_615;

#[error]
const EWrongMarketCap: vector<u8> = b"MockMarketCap does not govern this market";
#[error]
const ERateTooHigh: vector<u8> = b"rate exceeds MAX_RATE_BPS_PER_SEC";
#[error]
const EZeroAmount: vector<u8> = b"redeem amount must be > 0";
#[error]
const EReserveDry: vector<u8> = b"principal_pool cannot cover redeem (invariant breach)";
#[error]
const EAccrualOverflow: vector<u8> = b"accrued interest exceeds u64 range";

/// Pure interest calc. u128 internally; result range-checked back to u64 (fail loud).
public fun accrue(principal: u64, rate_bps_per_sec: u64, elapsed_ms: u64): u64 {
    let num = (principal as u128) * (rate_bps_per_sec as u128) * (elapsed_ms as u128);
    let interest = num / (BPS_DENOM * MS_PER_SEC);
    assert!(interest <= U64_MAX, EAccrualOverflow);
    interest as u64
}

// ── Market object ───────────────────────────────────────────────────────────

/// Shared. `principal_pool` always = Σ settled principal; `interest_buffer` pays yield.
public struct MockMarket has key {
    id: UID,
    principal_pool: Balance<USDC>,
    interest_buffer: Balance<USDC>,
    rate_bps_per_sec: u64,
    total_supplied: u64,
}

/// Admin cap for seed/set_rate. Bound to one market.
public struct MockMarketCap has key, store { id: UID, market_id: ID }

/// One-shot constructor. `init` does NOT run on package upgrade, so the market is
/// created here, gated by the already-deployed protocol `AdminCap`. Call once.
public fun create_market(_: &AdminCap, ctx: &mut TxContext) {
    let market = MockMarket {
        id: object::new(ctx),
        principal_pool: balance::zero(),
        interest_buffer: balance::zero(),
        rate_bps_per_sec: DEMO_RATE_BPS_PER_SEC,
        total_supplied: 0,
    };
    let cap = MockMarketCap { id: object::new(ctx), market_id: object::id(&market) };
    transfer::share_object(market);
    transfer::public_transfer(cap, ctx.sender());
}

/// Seed the interest buffer. `public` — the deployer seeds via an off-chain PTB.
public fun seed(market: &mut MockMarket, cap: &MockMarketCap, coin: Coin<USDC>) {
    assert!(cap.market_id == object::id(market), EWrongMarketCap);
    market.interest_buffer.join(coin.into_balance());
}

public fun set_rate(market: &mut MockMarket, cap: &MockMarketCap, new_rate: u64) {
    assert!(cap.market_id == object::id(market), EWrongMarketCap);
    assert!(new_rate <= MAX_RATE_BPS_PER_SEC, ERateTooHigh);
    market.rate_bps_per_sec = new_rate;
}

/// Supply principal into the pool. Returns the amount added. `public(package)` —
/// only `yield_adapter` reaches it.
public(package) fun supply(market: &mut MockMarket, coin: Coin<USDC>): u64 {
    let v = coin.value();
    market.principal_pool.join(coin.into_balance());
    market.total_supplied = market.total_supplied + v;
    v
}

/// Move `min(want, buffer)` from interest_buffer→principal_pool. Best-effort, NEVER
/// aborts (principal liveness must not depend on buffer solvency). Returns realized.
public(package) fun realize_interest(market: &mut MockMarket, want: u64): u64 {
    let avail = market.interest_buffer.value();
    let amount = if (want <= avail) want else avail;
    if (amount > 0) {
        let b = market.interest_buffer.split(amount);
        market.principal_pool.join(b);
    };
    amount
}

/// Take `amount` USDC out of principal_pool. Always solvent post-settle; `EReserveDry`
/// is a defensive invariant guard.
public(package) fun redeem(market: &mut MockMarket, amount: u64, ctx: &mut TxContext): Coin<USDC> {
    assert!(amount > 0, EZeroAmount);
    assert!(amount <= market.principal_pool.value(), EReserveDry);
    coin::take(&mut market.principal_pool, amount, ctx)
}

public fun rate(market: &MockMarket): u64 { market.rate_bps_per_sec }
public fun buffer_value(market: &MockMarket): u64 { market.interest_buffer.value() }
public fun principal_pool_value(market: &MockMarket): u64 { market.principal_pool.value() }
public fun total_supplied(market: &MockMarket): u64 { market.total_supplied }
