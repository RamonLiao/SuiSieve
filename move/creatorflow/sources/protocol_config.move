/// Protocol-level configuration: treasury address + fee bounds for the
/// `protocol_fee_bps` take-rate. Lowest module in the dependency graph
/// (depends on nothing internal — deliberately not on `events`, which would
/// invert the dependency direction). Created once at publish via `init`,
/// shared, and read with an immutable `&` on the `execute_split` hot path so
/// it never causes shared-object contention.
module creatorflow::protocol_config;

/// Basis-point denominator. A full split sums to 10000 bps (= 100%).
const BPS_DENOMINATOR: u16 = 10000;

/// Hard ceiling on `max_fee_bps`, independent of the AdminCap. Bounds the
/// blast radius of a compromised/abusive AdminCap (threat T11): even the
/// protocol can never raise the take-rate ceiling above 10%.
const MAX_FEE_CEILING: u16 = 1000;

#[error]
const EInvalidBounds: vector<u8> =
    b"fee bounds must satisfy min_fee_bps <= max_fee_bps <= MAX_FEE_CEILING";

#[error]
const EZeroTreasury: vector<u8> =
    b"treasury must not be the zero address (would burn protocol fees)";

#[error]
const EFeeOutOfBounds: vector<u8> =
    b"protocol_fee_bps outside [min_fee_bps, max_fee_bps]";

/// Shared, package-level config. Read-only on the payment hot path.
public struct ProtocolConfig has key {
    id: UID,
    /// Where `protocol_fee` slices are sent.
    treasury: address,
    /// Floor a creator's `protocol_fee_bps` may not go below.
    min_fee_bps: u16,
    /// Ceiling a creator's `protocol_fee_bps` may not exceed; itself bounded
    /// by `MAX_FEE_CEILING` so the AdminCap cannot inflate it arbitrarily.
    max_fee_bps: u16,
}

/// Gates every mutation of treasury / fee bounds. Orthogonal to per-creator
/// caps — holding it cannot touch any creator vault, only redirect/bound
/// future protocol-fee slices.
public struct AdminCap has key, store { id: UID }

/// Publish-time setup: one shared `ProtocolConfig` (treasury defaults to the
/// publisher, fee window [30, 100] bps = 0.3%–1%) and the `AdminCap` to the
/// publisher. Bounds are validated against the invariant up front.
fun init(ctx: &mut TxContext) {
    let publisher = ctx.sender();
    let min_fee_bps = 30;
    let max_fee_bps = 100;
    assert_bounds(min_fee_bps, max_fee_bps);

    let config = ProtocolConfig {
        id: object::new(ctx),
        treasury: publisher,
        min_fee_bps,
        max_fee_bps,
    };
    transfer::share_object(config);
    transfer::transfer(AdminCap { id: object::new(ctx) }, publisher);
}

/// Internal bounds invariant: `0 <= min <= max <= MAX_FEE_CEILING`.
fun assert_bounds(min_fee_bps: u16, max_fee_bps: u16) {
    assert!(
        min_fee_bps <= max_fee_bps && max_fee_bps <= MAX_FEE_CEILING,
        EInvalidBounds,
    );
}

/// Update the treasury address. AdminCap-gated. Rejects the zero address to
/// fail loud rather than silently burn future fees.
public fun set_treasury(
    config: &mut ProtocolConfig,
    _: &AdminCap,
    new_treasury: address,
) {
    assert!(new_treasury != @0x0, EZeroTreasury);
    config.treasury = new_treasury;
}

/// Update the fee window. AdminCap-gated and re-validated against the hard
/// ceiling, so the take-rate ceiling can never be inflated beyond
/// `MAX_FEE_CEILING` regardless of who holds the cap (threat T11).
public fun set_bounds(
    config: &mut ProtocolConfig,
    _: &AdminCap,
    min_fee_bps: u16,
    max_fee_bps: u16,
) {
    assert_bounds(min_fee_bps, max_fee_bps);
    config.min_fee_bps = min_fee_bps;
    config.max_fee_bps = max_fee_bps;
}

/// Assert a creator-chosen `protocol_fee_bps` lies within the protocol window.
/// Called by `split_config` on `create`/`mutate` so the protocol cannot
/// retroactively inflate a fee and creators cannot underset below the floor.
public fun assert_fee_in_bounds(config: &ProtocolConfig, fee_bps: u16) {
    assert!(
        fee_bps >= config.min_fee_bps && fee_bps <= config.max_fee_bps,
        EFeeOutOfBounds,
    );
}

/// Treasury address; read on the hot path to route the protocol-fee slice.
public fun treasury(config: &ProtocolConfig): address { config.treasury }

/// Current fee floor in bps.
public fun min_fee_bps(config: &ProtocolConfig): u16 { config.min_fee_bps }

/// Current fee ceiling in bps.
public fun max_fee_bps(config: &ProtocolConfig): u16 { config.max_fee_bps }

/// Basis-point denominator (10000), exposed for split-math consumers.
public fun bps_denominator(): u16 { BPS_DENOMINATOR }

#[test_only]
/// Run `init` in tests to obtain a shared `ProtocolConfig` + `AdminCap`.
public fun init_for_testing(ctx: &mut TxContext) { init(ctx) }
