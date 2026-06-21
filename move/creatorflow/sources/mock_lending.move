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
