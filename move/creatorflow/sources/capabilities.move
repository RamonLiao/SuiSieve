/// Owned-object capability types — the entire access-control surface of the
/// protocol. Deliberately logic-free (spec §3.1): structs + package-only
/// constructors + read-only getters, nothing else. Isolating Cap *definitions*
/// from the modules that *use* them shrinks the audit surface — to reason about
/// "what can forge a Cap?" you only read this file.
///
/// Security model (spec §5): every Cap binds to exactly one object `ID`, so a
/// stolen Cap grants access to that one object, never the system. Caps are
/// nominal types (`TaxCap` ≠ `SavingsCap`) so the type checker rejects
/// confusion. Fields are private with no setters, so a binding is fixed at mint
/// time and cannot be re-pointed. Constructors are `public(package)` — only the
/// sibling modules (`split_config`, `vaults`) can mint, never an external
/// package. Holding any Cap can never be combined into a "SuperCap".
module creatorflow::capabilities;

/// Authorizes mutation of one `SplitConfig`. Held in the creator's hot wallet
/// (rerouting future payments is the worst a compromise can do — funds already
/// in vaults are protected by the Tax/Savings caps).
public struct OwnerCap has key, store {
    id: UID,
    /// The single `SplitConfig` this cap governs.
    config_id: ID,
}

/// Authorizes withdrawal from one `TaxVault`. Held in a cold wallet /
/// accountant — orthogonal to `OwnerCap`, so a hot-wallet compromise cannot
/// drain tax reserves.
public struct TaxCap has key, store {
    id: UID,
    /// The single `TaxVault` this cap can withdraw from.
    vault_id: ID,
}

/// Authorizes withdrawal from one `SavingsVault` (including its yield position
/// via `yield_adapter`). Held in a cold wallet.
public struct SavingsCap has key, store {
    id: UID,
    /// The single `SavingsVault` this cap can withdraw from.
    vault_id: ID,
}

/// Mint an `OwnerCap` bound to `config_id`. Called by `split_config::create`;
/// the caller transfers it to the creator.
public(package) fun new_owner_cap(config_id: ID, ctx: &mut TxContext): OwnerCap {
    OwnerCap { id: object::new(ctx), config_id }
}

/// Mint a `TaxCap` bound to `vault_id`. Called when a `TaxVault` is created.
public(package) fun new_tax_cap(vault_id: ID, ctx: &mut TxContext): TaxCap {
    TaxCap { id: object::new(ctx), vault_id }
}

/// Mint a `SavingsCap` bound to `vault_id`. Called when a `SavingsVault` is
/// created.
public(package) fun new_savings_cap(vault_id: ID, ctx: &mut TxContext): SavingsCap {
    SavingsCap { id: object::new(ctx), vault_id }
}

/// The `SplitConfig` ID an `OwnerCap` governs. Consumers assert this matches
/// the config they were handed before trusting the cap.
public fun owner_cap_config_id(cap: &OwnerCap): ID { cap.config_id }

/// The `TaxVault` ID a `TaxCap` may withdraw from. `vaults::withdraw_tax`
/// asserts this equals the vault's own ID (rejects cross-vault cap reuse).
public fun tax_cap_vault_id(cap: &TaxCap): ID { cap.vault_id }

/// The `SavingsVault` ID a `SavingsCap` may withdraw from.
public fun savings_cap_vault_id(cap: &SavingsCap): ID { cap.vault_id }
