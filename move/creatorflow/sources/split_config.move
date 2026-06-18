/// The creator's payment routing table: a shared `SplitConfig` that says what
/// fraction of every incoming payment goes to each recipient, the tax vault,
/// the savings vault, and the protocol treasury. The `router` reads it with an
/// immutable `&` on the hot path (so concurrent payments never contend on it)
/// and bumps `version` only on explicit owner mutation.
///
/// Dependency position (spec module-dependency graph): this module sits above
/// `capabilities` + `protocol_config` and below everything else. It depends on
/// *only* those two — deliberately NOT on `vaults` or `events`:
///   - Vault creation + the cross-ID wiring is orchestrated by `router`
///     (which holds all the arrows). `new` takes vault IDs as plain `ID`
///     inputs, so this module never references the `vaults` types.
///   - Mutation emits no `ConfigMutated` event from here — same call as
///     `protocol_config`: an owner mutation is observable via the object's
///     `version` field changing on-chain, and adding an `events` dependency
///     would invert the documented graph. `router` owns event emission.
///
/// `StrategyRef` lives here (not in `yield_adapter`) because it is config-time
/// data — *which* yield pool this config routes to. `yield_adapter` (a higher
/// module) back-depends on this module for the type; the hot path reads it via
/// the getter and hands it to `yield_adapter::deposit`.
module creatorflow::split_config;

use creatorflow::capabilities::{Self, OwnerCap};
use creatorflow::protocol_config::{Self, ProtocolConfig};

/// Recipient list is bounded so `execute_split`'s per-recipient loop cannot be
/// griefed into gas exhaustion (threat T6).
const MAX_RECIPIENTS: u64 = 16;

#[error]
const EInvalidBps: vector<u8> =
    b"sum(recipients.bps) + tax_bps + savings_bps + protocol_fee_bps must equal 10000";

#[error]
const ETooManyRecipients: vector<u8> =
    b"recipient count exceeds MAX_RECIPIENTS (16)";

#[error]
const EZeroRecipientBps: vector<u8> =
    b"a recipient with 0 bps is dead weight; omit it instead";

#[error]
const EYieldExceedsSavings: vector<u8> =
    b"yield_bps must be <= savings_bps (yield is a sub-allocation of savings)";

#[error]
const EWrongOwnerCap: vector<u8> =
    b"OwnerCap does not govern this SplitConfig";

#[error]
const EAlreadyWired: vector<u8> =
    b"vault back-pointers already wired; bindings are one-time and immutable";

/// One payout target. `bps` is this recipient's share of the gross payment in
/// basis points (1–10000). `label` is opaque UTF-8 for the dashboard only.
public struct Recipient has store, copy, drop {
    addr: address,
    bps: u16,
    label: vector<u8>,
}

/// Config-time pointer to a yield venue (e.g. a Scallop USDC pool). Pure data;
/// `yield_adapter` interprets `kind`/`pool_id`. Stored inside `SplitConfig` so
/// the hot path can read it without an extra object.
public struct StrategyRef has store, copy, drop {
    kind: u8,
    pool_id: ID,
}

/// Who may mutate a config. MVP only ever constructs `OwnerOnly`; the v1
/// `OwnerPlusLockHolders` variant is declared now because adding an enum
/// variant later is a non-compatible upgrade for a *stored* type — unlike a
/// brand-new struct (cf. `RecipientLockCap`, which was safely deferred).
public enum MutationPolicy has store, copy, drop {
    OwnerOnly,
    OwnerPlusLockHolders { k: u8 },
}

/// The shared routing table. `owner` is display-only — authorization is by
/// `OwnerCap`, never by address. Fields are private: the only way to obtain one
/// is `new` (package-only), so vault-ID bindings cannot be forged from outside.
public struct SplitConfig has key {
    id: UID,
    /// Display only; auth uses `OwnerCap`. Do not gate on this.
    owner: address,
    /// Bumped on every mutation; the payer asserts `expected_version` against
    /// it so a config edit cannot silently re-route an in-flight payment (T2).
    version: u64,
    recipients: vector<Recipient>,
    tax_bps: u16,
    savings_bps: u16,
    /// Protocol take-rate; constrained to `[min_fee_bps, max_fee_bps]` of the
    /// `ProtocolConfig` at every create/mutate (T11, both directions).
    protocol_fee_bps: u16,
    /// Slice of `savings_bps` routed to yield, carved at execute time. A
    /// sub-allocation — NOT part of the 10000 sum. `0` disables yield.
    yield_bps: u16,
    /// Back-pointer to the tax vault this config feeds. Plain `ID` so this
    /// module needs no dependency on `vaults`.
    tax_vault_id: ID,
    savings_vault_id: ID,
    yield_strategy: Option<StrategyRef>,
    mutation_policy: MutationPolicy,
}

/// Build a `Recipient`. Public so the TS SDK can construct the vector inside a
/// PTB (struct fields are private — there is no other way to make one).
public fun new_recipient(addr: address, bps: u16, label: vector<u8>): Recipient {
    Recipient { addr, bps, label }
}

/// Build a `StrategyRef`. Public for the same PTB-construction reason.
public fun new_strategy_ref(kind: u8, pool_id: ID): StrategyRef {
    StrategyRef { kind, pool_id }
}

/// Create a fresh `SplitConfig` and its governing `OwnerCap`, bound to each
/// other. `public(package)` — only `router` may call it, as part of the
/// create-config-and-vaults orchestration (router pre-derives the vault IDs,
/// passes them here, then assembles the vaults). The caller shares the config
/// and transfers the `OwnerCap` to the creator.
///
/// Validates the full allocation invariant before constructing anything, so a
/// bad split aborts without side effects.
public(package) fun new(
    protocol: &ProtocolConfig,
    recipients: vector<Recipient>,
    tax_bps: u16,
    savings_bps: u16,
    protocol_fee_bps: u16,
    yield_bps: u16,
    yield_strategy: Option<StrategyRef>,
    tax_vault_id: ID,
    savings_vault_id: ID,
    ctx: &mut TxContext,
): (SplitConfig, OwnerCap) {
    let (mut config, owner_cap) = new_unwired(
        protocol,
        recipients,
        tax_bps,
        savings_bps,
        protocol_fee_bps,
        yield_bps,
        yield_strategy,
        ctx,
    );
    wire_vaults(&mut config, tax_vault_id, savings_vault_id);
    (config, owner_cap)
}

/// Create a config whose vault back-pointers are not yet set (both default to a
/// `@0x0` sentinel), returning it alongside its `OwnerCap`.
///
/// **Why this exists:** Sui forbids constructing an object from a `UID` that was
/// not minted by `object::new` *in the same function* (verifier E01001), so the
/// config and its vaults cannot pre-derive each other's IDs across module
/// boundaries. `router` therefore builds the config here first (minting its own
/// `UID`), uses the resulting `config_id` to build the vaults, then calls
/// `wire_vaults` to record the vault IDs — a one-time, package-only step before
/// the config is shared. The allocation invariant is fully validated here, so a
/// bad split aborts before any vault is created.
public(package) fun new_unwired(
    protocol: &ProtocolConfig,
    recipients: vector<Recipient>,
    tax_bps: u16,
    savings_bps: u16,
    protocol_fee_bps: u16,
    yield_bps: u16,
    yield_strategy: Option<StrategyRef>,
    ctx: &mut TxContext,
): (SplitConfig, OwnerCap) {
    assert_allocation(
        protocol,
        &recipients,
        tax_bps,
        savings_bps,
        protocol_fee_bps,
        yield_bps,
    );

    let id = object::new(ctx);
    let config_id = id.to_inner();
    let sentinel = object::id_from_address(@0x0);
    let config = SplitConfig {
        id,
        owner: ctx.sender(),
        version: 0,
        recipients,
        tax_bps,
        savings_bps,
        protocol_fee_bps,
        yield_bps,
        tax_vault_id: sentinel,
        savings_vault_id: sentinel,
        yield_strategy,
        mutation_policy: MutationPolicy::OwnerOnly,
    };
    let owner_cap = capabilities::new_owner_cap(config_id, ctx);
    (config, owner_cap)
}

/// Record the config's vault back-pointers exactly once (T9 bidirectional
/// cross-check). `public(package)` — only `router` calls it, immediately after
/// creating the vaults and before sharing the config. Asserts the IDs are still
/// the `@0x0` sentinel so the binding can never be re-pointed after wiring,
/// preserving the same immutability guarantee as setting them in the constructor.
public(package) fun wire_vaults(
    config: &mut SplitConfig,
    tax_vault_id: ID,
    savings_vault_id: ID,
) {
    let sentinel = object::id_from_address(@0x0);
    assert!(config.tax_vault_id == sentinel, EAlreadyWired);
    config.tax_vault_id = tax_vault_id;
    config.savings_vault_id = savings_vault_id;
}

/// Share the freshly-created `SplitConfig`. `public(package)` — `router` owns the
/// create orchestration but cannot `transfer::share_object` a `key`-only object
/// defined in this module (Move's private-transfer rule), so the share is
/// delegated here. Called exactly once, after `wire_vaults`.
public(package) fun share(config: SplitConfig) {
    transfer::share_object(config);
}

/// Replace the recipient list and tax/savings allocations. `OwnerCap`-gated and
/// re-validated end to end: the new split must still sum to 10000, the
/// (unchanged) `protocol_fee_bps` must still sit within the *current* protocol
/// bounds (defends T11 if the protocol moved its floor since create), and
/// `yield_bps` must still fit inside the new `savings_bps`.
///
/// Bumps `version`; emits no event (see module header). `protocol_fee_bps` and
/// `yield_bps` are intentionally not mutable here (spec §4.4) — changing the
/// take-rate is not an owner privilege, and re-pointing yield is a v1 concern.
public fun update_recipients(
    config: &mut SplitConfig,
    owner_cap: &OwnerCap,
    protocol: &ProtocolConfig,
    new_recipients: vector<Recipient>,
    new_tax_bps: u16,
    new_savings_bps: u16,
) {
    assert!(
        capabilities::owner_cap_config_id(owner_cap) == config.id.to_inner(),
        EWrongOwnerCap,
    );
    assert_allocation(
        protocol,
        &new_recipients,
        new_tax_bps,
        new_savings_bps,
        config.protocol_fee_bps,
        config.yield_bps,
    );

    config.recipients = new_recipients;
    config.tax_bps = new_tax_bps;
    config.savings_bps = new_savings_bps;
    config.version = config.version + 1;
}

/// The allocation invariant, asserted on every write. Accumulates the bps sum
/// in `u64` because 16 recipients × 10000 = 160000 overflows `u16` — summing in
/// `u16` would wrap and let a malformed split pass the `== 10000` check.
fun assert_allocation(
    protocol: &ProtocolConfig,
    recipients: &vector<Recipient>,
    tax_bps: u16,
    savings_bps: u16,
    protocol_fee_bps: u16,
    yield_bps: u16,
) {
    assert!(recipients.length() <= MAX_RECIPIENTS, ETooManyRecipients);
    protocol_config::assert_fee_in_bounds(protocol, protocol_fee_bps);
    assert!(yield_bps <= savings_bps, EYieldExceedsSavings);

    let mut sum: u64 = (tax_bps as u64) + (savings_bps as u64) + (protocol_fee_bps as u64);
    recipients.do_ref!(|r| {
        assert!(r.bps > 0, EZeroRecipientBps);
        sum = sum + (r.bps as u64);
    });
    assert!(sum == (protocol_config::bps_denominator() as u64), EInvalidBps);
}

// --- getters: everything `router`/`execute_split` and the dashboard read -----

/// Display-only owner address.
public fun owner(config: &SplitConfig): address { config.owner }

/// Current version; the payer pins `expected_version` to this.
public fun version(config: &SplitConfig): u64 { config.version }

/// The recipient list, by reference (router iterates it to carve payouts).
public fun recipients(config: &SplitConfig): &vector<Recipient> { &config.recipients }

public fun tax_bps(config: &SplitConfig): u16 { config.tax_bps }

public fun savings_bps(config: &SplitConfig): u16 { config.savings_bps }

public fun protocol_fee_bps(config: &SplitConfig): u16 { config.protocol_fee_bps }

public fun yield_bps(config: &SplitConfig): u16 { config.yield_bps }

public fun tax_vault_id(config: &SplitConfig): ID { config.tax_vault_id }

public fun savings_vault_id(config: &SplitConfig): ID { config.savings_vault_id }

/// The yield strategy, if any. `router` checks `is_some()` together with the
/// caller's `include_yield` flag before routing the yield slice.
public fun yield_strategy(config: &SplitConfig): &Option<StrategyRef> {
    &config.yield_strategy
}

// --- Recipient / StrategyRef field accessors --------------------------------

public fun recipient_addr(r: &Recipient): address { r.addr }

public fun recipient_bps(r: &Recipient): u16 { r.bps }

public fun recipient_label(r: &Recipient): vector<u8> { r.label }

public fun strategy_kind(s: &StrategyRef): u8 { s.kind }

public fun strategy_pool_id(s: &StrategyRef): ID { s.pool_id }
