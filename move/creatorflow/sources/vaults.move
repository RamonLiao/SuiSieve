/// The two creator-owned holding vaults: `TaxVault` (set-aside for tax) and
/// `SavingsVault` (long-term reserve, optionally swept into a Scallop yield
/// position). Both are **shared objects** so the `router`'s `execute_split`
/// PTB can deposit into them without the creator signing every payment — the
/// payer pushes funds in, the creator pulls funds out with a cold-wallet Cap.
///
/// Dependency position (module-dependency.mmd): `vaults → capabilities` only.
/// Deliberately NOT depending on:
///   - `events`: the graph has no `vault → events` edge. `withdraw_*` is
///     `public(package)` and emits nothing; `router` wraps it and emits
///     `VaultWithdrawn` (same precedent as `split_config`/`protocol_config` —
///     the top module owns event emission so lower modules stay leaf-clean).
///   - `yield_adapter`: the edge runs the other way (`yield_adapter → vault`).
///     So the Scallop position is NOT a field here. `yield_adapter` (module 6)
///     attaches/reads it via a **dynamic field** on the `SavingsVault`, keeping
///     this module Scallop-agnostic AND dodging the non-compatible-upgrade cost
///     of adding a struct field later. (Spec §3.3 drew it as
///     `Option<ScallopPositionRef>`; resolved per the dependency graph — Rule 7.)
///
/// Asset is monomorphic `Coin<USDC>` for MVP (real Circle native USDC; see
/// Move.toml). Genericizing to `Coin<T>` changes these vault types and is a
/// non-compatible v2 redeploy (spec §4.2).
module creatorflow::vaults;

use creatorflow::capabilities::{Self, TaxCap, SavingsCap};
use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};
use usdc::usdc::USDC;

#[error]
const EWrongCap: vector<u8> =
    b"capability does not govern this vault (cross-vault cap reuse rejected)";

#[error]
const EInsufficientBalance: vector<u8> =
    b"withdraw amount exceeds vault balance";

/// Tax set-aside vault. `config_id` back-points to the `SplitConfig` that feeds
/// it, for indexer joins and the `EVaultMismatch` cross-check `router` runs on
/// every `execute_split` (threat T9). `total_*` are monotonic lifetime counters
/// for analytics — NOT the current balance (`balance.value()` is that).
public struct TaxVault has key {
    id: UID,
    balance: Balance<USDC>,
    config_id: ID,
    total_deposited: u64,
    total_withdrawn: u64,
}

/// Long-term savings vault. Same shape as `TaxVault`; the Scallop yield position
/// (Mode A/B, spec §7) is held off-struct as a dynamic field managed by
/// `yield_adapter`, so this type never references Scallop.
public struct SavingsVault has key {
    id: UID,
    balance: Balance<USDC>,
    config_id: ID,
    total_deposited: u64,
    total_withdrawn: u64,
}

/// Mint an empty `TaxVault` bound to `config_id`, plus the `TaxCap` that gates
/// withdrawals from it. `public(package)` — only `router` calls this, during
/// the create-config-and-vaults orchestration; it shares the vault and
/// transfers the cap to the creator's cold wallet. The cap is bound to this
/// vault's own ID, so it can never withdraw from any other vault (T4).
public(package) fun new_tax_vault(
    config_id: ID,
    ctx: &mut TxContext,
): (TaxVault, TaxCap) {
    let id = object::new(ctx);
    let vault_id = id.to_inner();
    let vault = TaxVault {
        id,
        balance: balance::zero(),
        config_id,
        total_deposited: 0,
        total_withdrawn: 0,
    };
    let cap = capabilities::new_tax_cap(vault_id, ctx);
    (vault, cap)
}

/// Mint an empty `SavingsVault` + its `SavingsCap`. Same contract as
/// `new_tax_vault`.
public(package) fun new_savings_vault(
    config_id: ID,
    ctx: &mut TxContext,
): (SavingsVault, SavingsCap) {
    let id = object::new(ctx);
    let vault_id = id.to_inner();
    let vault = SavingsVault {
        id,
        balance: balance::zero(),
        config_id,
        total_deposited: 0,
        total_withdrawn: 0,
    };
    let cap = capabilities::new_savings_cap(vault_id, ctx);
    (vault, cap)
}

/// Share a freshly-created `TaxVault`. `public(package)` — `router` orchestrates
/// creation but cannot `transfer::share_object` a `key`-only object defined in
/// this module (Move's private-transfer rule), so the share is delegated here.
public(package) fun share_tax(vault: TaxVault) {
    transfer::share_object(vault);
}

/// Share a freshly-created `SavingsVault`. Same rationale as `share_tax`.
public(package) fun share_savings(vault: SavingsVault) {
    transfer::share_object(vault);
}

/// Deposit a coin into the tax vault. `public(package)` — funds enter only via
/// `router::execute_split`, so `total_deposited` stays a faithful lifetime sum
/// (an arbitrary external deposit would skew analytics without authorization
/// context). Consumes the coin into the vault's `Balance`.
public(package) fun deposit_tax(vault: &mut TaxVault, coin: Coin<USDC>) {
    vault.total_deposited = vault.total_deposited + coin.value();
    vault.balance.join(coin.into_balance());
}

/// Deposit a coin into the savings vault. Called by `router::execute_split` for
/// the savings slice and, in Mode B, the yield slice (which then sits in
/// savings until `yield_adapter::sweep` moves it to Scallop).
public(package) fun deposit_savings(vault: &mut SavingsVault, coin: Coin<USDC>) {
    vault.total_deposited = vault.total_deposited + coin.value();
    vault.balance.join(coin.into_balance());
}

/// Withdraw `amount` from the tax vault, returning a fresh `Coin<USDC>`.
/// `public(package)` — `router` wraps this to emit `VaultWithdrawn` (the graph
/// forbids a `vault → events` edge). Asserts the cap is bound to THIS vault
/// (T4: a `TaxCap` for another vault aborts `EWrongCap`) and that the balance
/// covers the amount (`EInsufficientBalance`, fail loud rather than silently
/// capping).
public(package) fun withdraw_tax(
    vault: &mut TaxVault,
    cap: &TaxCap,
    amount: u64,
    ctx: &mut TxContext,
): Coin<USDC> {
    assert!(capabilities::tax_cap_vault_id(cap) == vault.id.to_inner(), EWrongCap);
    assert!(amount <= vault.balance.value(), EInsufficientBalance);
    vault.total_withdrawn = vault.total_withdrawn + amount;
    coin::take(&mut vault.balance, amount, ctx)
}

/// Withdraw `amount` from the savings vault. Same contract as `withdraw_tax`,
/// gated by `SavingsCap`. (Withdrawing a position currently parked in Scallop
/// is `yield_adapter`'s concern — it redeems back into this vault first.)
public(package) fun withdraw_savings(
    vault: &mut SavingsVault,
    cap: &SavingsCap,
    amount: u64,
    ctx: &mut TxContext,
): Coin<USDC> {
    assert!(capabilities::savings_cap_vault_id(cap) == vault.id.to_inner(), EWrongCap);
    assert!(amount <= vault.balance.value(), EInsufficientBalance);
    vault.total_withdrawn = vault.total_withdrawn + amount;
    coin::take(&mut vault.balance, amount, ctx)
}

/// Package-only mutable access to the savings vault's `UID`, so `yield_adapter`
/// can attach/read its Scallop yield position as a **dynamic field** without
/// this module ever referencing Scallop types (the seam promised in the module
/// header; spec §3.3 resolution / Rule 7). `public(package)` keeps the UID
/// unforgeable from outside — only `yield_adapter` (same package) reaches it.
public(package) fun savings_uid_mut(vault: &mut SavingsVault): &mut UID {
    &mut vault.id
}

/// Read-only `UID` for existence checks on the yield-position dynamic field.
public(package) fun savings_uid(vault: &SavingsVault): &UID {
    &vault.id
}

// --- getters: indexer cross-checks (T9), dashboard balances, analytics -------

/// Current spendable balance of the tax vault.
public fun tax_balance(vault: &TaxVault): u64 { vault.balance.value() }

/// The `SplitConfig` this tax vault is bound to. `router` asserts this equals
/// the config it was handed before depositing (T9 fake-config defense).
public fun tax_config_id(vault: &TaxVault): ID { vault.config_id }

/// Lifetime gross deposited into the tax vault (monotonic).
public fun tax_total_deposited(vault: &TaxVault): u64 { vault.total_deposited }

/// Lifetime gross withdrawn from the tax vault (monotonic).
public fun tax_total_withdrawn(vault: &TaxVault): u64 { vault.total_withdrawn }

/// Current spendable balance of the savings vault.
public fun savings_balance(vault: &SavingsVault): u64 { vault.balance.value() }

/// The `SplitConfig` this savings vault is bound to (T9 cross-check).
public fun savings_config_id(vault: &SavingsVault): ID { vault.config_id }

/// Lifetime gross deposited into the savings vault (monotonic).
public fun savings_total_deposited(vault: &SavingsVault): u64 { vault.total_deposited }

/// Lifetime gross withdrawn from the savings vault (monotonic).
public fun savings_total_withdrawn(vault: &SavingsVault): u64 { vault.total_withdrawn }
