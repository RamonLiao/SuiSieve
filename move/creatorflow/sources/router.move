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

/// The payment hot path (spec §4.2). Splits `payment` by the config's bps into
/// recipient payouts + tax + savings (with optional yield carve) + protocol fee,
/// then emits one `SplitExecuted`. Permissionless by design (anyone can push a
/// payment into a config), so its only trust anchors are the two asserts below.
///
/// Rounding: each slice is a floor of `amount_in * bps / 10000` computed on
/// `u128` intermediates (no `u64` overflow); the last recipient absorbs the
/// accumulated remainder so the gross is conserved exactly (no dust burned). A
/// recipient-less config (legal: 100% to tax/savings/fee) banks the remainder to
/// savings instead.
public fun execute_split(
    config: &SplitConfig,
    protocol: &ProtocolConfig,
    tax_vault: &mut TaxVault,
    savings_vault: &mut SavingsVault,
    mut payment: Coin<USDC>,
    include_yield: bool,
    expected_version: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    // T2: the payer is paying into the exact config revision they signed for.
    assert!(split_config::version(config) == expected_version, EConfigChanged);

    // T9: the vaults actually belong to this config (reject fake-vault siphon).
    // Bidirectional — vault back-points to config AND config back-points to
    // vault — so neither a spoofed vault nor a spoofed config slips through.
    let config_id = object::id(config);
    assert!(vaults::tax_config_id(tax_vault) == config_id, EVaultMismatch);
    assert!(vaults::savings_config_id(savings_vault) == config_id, EVaultMismatch);
    assert!(split_config::tax_vault_id(config) == object::id(tax_vault), EVaultMismatch);
    assert!(
        split_config::savings_vault_id(config) == object::id(savings_vault),
        EVaultMismatch,
    );

    // T6 (spam): reject zero-value payments. A permissionless hot path with no
    // floor lets an attacker push `Coin<USDC>` of value 0 to mint a zero-coin
    // object at every recipient (object bloat) and emit a junk `SplitExecuted`
    // (indexer poisoning) at only gas cost. Every legitimate split moves funds.
    let amount_in = payment.value();
    assert!(amount_in > 0, EZeroPayment);
    let denom = (protocol_config::bps_denominator() as u128);

    // Protocol fee → treasury.
    let fee_amt = slice(amount_in, split_config::protocol_fee_bps(config), denom);
    if (fee_amt > 0) {
        transfer::public_transfer(
            payment.split(fee_amt, ctx),
            protocol_config::treasury(protocol),
        );
    };

    // Tax slice → tax vault.
    let tax_amt = slice(amount_in, split_config::tax_bps(config), denom);
    if (tax_amt > 0) {
        vaults::deposit_tax(tax_vault, payment.split(tax_amt, ctx));
    };

    // Savings slice, with the yield sub-slice carved out of it. `yield_bps <=
    // savings_bps` (config invariant) ⇒ `yield_amt <= savings_total`, so the
    // inner split never underflows.
    let savings_total = slice(amount_in, split_config::savings_bps(config), denom);
    let yield_amt = slice(amount_in, split_config::yield_bps(config), denom);
    let route_yield = include_yield && split_config::yield_strategy(config).is_some();
    let mut savings_coin = payment.split(savings_total, ctx);

    let savings_deposited;
    let yield_deposited;
    if (route_yield) {
        // Mode A (spec §7): in-PTB yield deposit. If the venue call aborts the
        // WHOLE split reverts — the client retries with `include_yield = false`.
        let yield_coin = savings_coin.split(yield_amt, ctx);
        let strategy = *split_config::yield_strategy(config).borrow();
        yield_adapter::deposit(savings_vault, yield_coin, strategy);
        savings_deposited = savings_total - yield_amt;
        yield_deposited = yield_amt;
    } else {
        // Yield not wired in → the slice stays in savings (observable as
        // `yield_included = false`).
        savings_deposited = savings_total;
        yield_deposited = 0;
    };
    vaults::deposit_savings(savings_vault, savings_coin);

    // Recipients: first n-1 by floor, last absorbs the remaining balance (its
    // own floor + all accumulated dust) so nothing is lost.
    let recipients = split_config::recipients(config);
    let n = recipients.length();
    let mut payouts = vector[];
    let mut i = 0;
    while (i < n) {
        let r = recipients.borrow(i);
        let addr = split_config::recipient_addr(r);
        let bps = split_config::recipient_bps(r);
        let amt = if (i + 1 == n) {
            payment.value() // last recipient: whatever is left, dust included
        } else {
            slice(amount_in, bps, denom)
        };
        transfer::public_transfer(payment.split(amt, ctx), addr);
        payouts.push_back(events::new_recipient_payout(addr, amt, bps));
        i = i + 1;
    };

    // No recipients ⇒ no one absorbed the dust; bank it to savings. With ≥1
    // recipient, the last split consumed everything, so `payment` is now zero.
    if (n == 0) {
        vaults::deposit_savings(savings_vault, payment);
    } else {
        payment.destroy_zero();
    };

    events::emit_split_executed(
        config_id,
        split_config::version(config),
        amount_in,
        payouts,
        tax_amt,
        savings_deposited,
        fee_amt,
        yield_deposited,
        route_yield,
        clock.timestamp_ms(),
    );
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
    savings_vault: &mut SavingsVault,
    cap: &SavingsCap,
    amount: u64,
    ctx: &mut TxContext,
) {
    let coin = yield_adapter::redeem(savings_vault, cap, amount, ctx);
    let to = ctx.sender();
    events::emit_vault_withdrawn(
        object::id(savings_vault),
        events::kind_savings(),
        amount,
        to,
    );
    transfer::public_transfer(coin, to);
}

/// Floor of `amount * bps / 10000`, computed on `u128` so the product cannot
/// overflow `u64` (max `amount * 10000 ≈ 1.8e23 << u128 max`).
fun slice(amount: u64, bps: u16, denom: u128): u64 {
    (((amount as u128) * (bps as u128)) / denom) as u64
}
