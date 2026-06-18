/// Structured on-chain events consumed by the off-chain indexer (spec §3.4,
/// §8). This module is the canonical home for every event the protocol emits;
/// the indexer subscribes to these three types via the Sui gRPC stream and
/// projects them into Postgres.
///
/// Dependency position (module-dependency.mmd): `events` is a **leaf** — it
/// depends on nothing inside `creatorflow`, only `sui::event` and the `ID`
/// type. This is deliberate: the lower modules (`split_config`, `vaults`,
/// `protocol_config`) all forgo a `→ events` edge and stay event-silent, while
/// the top module (`router`) owns emission and calls the `emit_*` functions
/// here. Centralizing emission keeps the event schema in one auditable place
/// and lets the indexer track a single module.
///
/// **Why the emit functions are `public(package)`:** an event is the indexer's
/// source of truth. If any caller outside the package could emit a
/// `SplitExecuted`, an attacker could forge payout history (poison analytics,
/// fake "I paid you" receipts). Restricting emission to package-internal
/// callers (only `router`, per the graph) means every emitted event is backed
/// by a real state transition. Same rationale for the `RecipientPayout`
/// constructor — only `router` assembles the payout vector while it actually
/// splits the coin.
module creatorflow::events;

use sui::event;

/// `VaultWithdrawn.kind` discriminants. `u8` (not an enum) because the field
/// crosses the BCS boundary to the indexer, where a stable integer tag is
/// simpler to decode than an enum variant. Spec §3.4 fixes 0=tax, 1=savings.
const KIND_TAX: u8 = 0;
const KIND_SAVINGS: u8 = 1;

/// One recipient's slice of a single `execute_split`. Carried inside
/// `SplitExecuted.recipient_payouts` so the indexer can reconstruct exactly who
/// got paid how much without re-deriving bps math. `bps` is echoed for
/// cross-checking against the `SplitConfig` snapshot at `config_version`.
public struct RecipientPayout has copy, drop {
    addr: address,
    amount: u64,
    bps: u16,
}

/// Emitted once per `execute_split`. The complete settlement record: the gross
/// `amount_in`, every recipient payout, and each protocol-side slice. Indexed
/// as the primary creator-revenue fact table.
///
/// `yield_included` records whether the yield-deposit call was *constructed*
/// into this PTB (the client's `include_yield` decision AND a strategy being
/// configured) — NOT a runtime success flag. A Scallop abort reverts the whole
/// PTB, so the event never emits at all; a `false` here means "yield path was
/// not wired in", which is observable, whereas a hypothetical
/// `yield_success: false` never could be (spec §3.4, §7).
public struct SplitExecuted has copy, drop {
    config_id: ID,
    config_version: u64,
    amount_in: u64,
    recipient_payouts: vector<RecipientPayout>,
    tax_amount: u64,
    savings_amount: u64,
    protocol_fee_amount: u64,
    yield_amount: u64,
    yield_included: bool,
    timestamp_ms: u64,
}

/// Emitted when an `OwnerCap` holder mutates a config's recipients/bps. Carries
/// the version delta so the indexer can order mutations and invalidate cached
/// pay-links built against `old_version` (spec §6.1 stale pay-link flow).
public struct ConfigMutated has copy, drop {
    config_id: ID,
    old_version: u64,
    new_version: u64,
    mutator: address,
}

/// Emitted when a creator pulls funds out of a vault with the governing Cap.
/// `kind` ∈ {KIND_TAX, KIND_SAVINGS}. `router` wraps `vaults::withdraw_*` (which
/// is itself event-silent) and emits this.
public struct VaultWithdrawn has copy, drop {
    vault_id: ID,
    kind: u8,
    amount: u64,
    to: address,
}

/// Emitted once by `router::create_config_and_vaults` when a creator provisions
/// a new `SplitConfig` + its two vaults. The indexer's sole source for "this
/// config exists / who owns it / which vaults back it" — without it a config is
/// invisible until its first `SplitExecuted`, and `VaultWithdrawn` (which carries
/// only `vault_id`) cannot be joined to a config. Deliberately carries NO bps
/// snapshot: allocations are mutable (`ConfigMutated` bumps version), so a
/// create-time snapshot would go stale; point-in-time bps is reconstructed from
/// `SplitExecuted.config_version` + the `ConfigMutated` history instead.
public struct ConfigCreated has copy, drop {
    config_id: ID,
    tax_vault_id: ID,
    savings_vault_id: ID,
    owner: address,
}

/// Build one `RecipientPayout`. `public(package)` — only `router` assembles
/// these, during the coin split, so the vector inside `SplitExecuted` always
/// mirrors real transfers.
public(package) fun new_recipient_payout(
    addr: address,
    amount: u64,
    bps: u16,
): RecipientPayout {
    RecipientPayout { addr, amount, bps }
}

/// Emit the settlement record for one split. `public(package)` — router-only,
/// so the indexer can trust every `SplitExecuted` is backed by a real split.
public(package) fun emit_split_executed(
    config_id: ID,
    config_version: u64,
    amount_in: u64,
    recipient_payouts: vector<RecipientPayout>,
    tax_amount: u64,
    savings_amount: u64,
    protocol_fee_amount: u64,
    yield_amount: u64,
    yield_included: bool,
    timestamp_ms: u64,
) {
    event::emit(SplitExecuted {
        config_id,
        config_version,
        amount_in,
        recipient_payouts,
        tax_amount,
        savings_amount,
        protocol_fee_amount,
        yield_amount,
        yield_included,
        timestamp_ms,
    });
}

/// Emit a config-mutation record. `public(package)` — router-only (mutation is
/// orchestrated there per the dependency graph; `split_config` stays leaf).
public(package) fun emit_config_mutated(
    config_id: ID,
    old_version: u64,
    new_version: u64,
    mutator: address,
) {
    event::emit(ConfigMutated { config_id, old_version, new_version, mutator });
}

/// Emit a vault-withdrawal record. `public(package)` — router wraps the
/// `public(package)` `vaults::withdraw_*` and emits this (the graph forbids a
/// `vault → events` edge).
public(package) fun emit_vault_withdrawn(
    vault_id: ID,
    kind: u8,
    amount: u64,
    to: address,
) {
    event::emit(VaultWithdrawn { vault_id, kind, amount, to });
}

/// Emit a config-creation record. `public(package)` — router-only (creation is
/// orchestrated there). All IDs are taken by the caller directly from the freshly
/// built objects, so the event is correct regardless of `wire_vaults` ordering.
public(package) fun emit_config_created(
    config_id: ID,
    tax_vault_id: ID,
    savings_vault_id: ID,
    owner: address,
) {
    event::emit(ConfigCreated { config_id, tax_vault_id, savings_vault_id, owner });
}

/// Tax-vault discriminant for `VaultWithdrawn.kind`. Exposed so `router` (and
/// tests) reference the named constant instead of a magic `0`.
public fun kind_tax(): u8 { KIND_TAX }

/// Savings-vault discriminant for `VaultWithdrawn.kind`.
public fun kind_savings(): u8 { KIND_SAVINGS }

// --- getters: test assertions + any in-package reads ------------------------

/// Recipient address of a payout (test/introspection).
public fun payout_addr(p: &RecipientPayout): address { p.addr }

/// Amount transferred to the recipient.
public fun payout_amount(p: &RecipientPayout): u64 { p.amount }

/// Recipient's bps share echoed from the config snapshot.
public fun payout_bps(p: &RecipientPayout): u16 { p.bps }
