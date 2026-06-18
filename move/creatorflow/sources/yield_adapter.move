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
/// module 6 reading a type from module 3), `→ capabilities` (cap-gated redeem).
///
/// **Position storage (Rule 7 / spec §3.3):** the position is a **dynamic
/// field** on the `SavingsVault`, NOT a struct field. This keeps `vaults`
/// Scallop-agnostic and dodges the non-compatible-upgrade cost of adding a
/// stored field later.
///
/// **Scallop CPI seam (MVP scope):** a position holds the principal as a
/// `Balance<USDC>` parked in the dynamic field. The real Scallop supply/redeem
/// CPI is isolated to `supply_into` / `redeem_from` below — swapping those two
/// bodies for actual Scallop market-coin calls (and changing the position's
/// held type from `Balance<USDC>` to the Scallop sCoin) is the only change
/// needed to go live. Everything else — cap gating, accounting, events seam —
/// is real. `StrategyRef.pool_id`/`kind` is recorded but not yet used to route
/// funds; the real CPI will validate it against the supplied pool.
module creatorflow::yield_adapter;

use creatorflow::capabilities::{Self, SavingsCap};
use creatorflow::split_config::StrategyRef;
use creatorflow::vaults::{Self, SavingsVault};
use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};
use sui::dynamic_field as df;
use usdc::usdc::USDC;

#[error]
const EWrongCap: vector<u8> =
    b"SavingsCap does not govern this vault (cross-vault cap reuse rejected)";

#[error]
const ENoPosition: vector<u8> =
    b"no yield position exists on this savings vault";

#[error]
const EInsufficientYield: vector<u8> =
    b"redeem/sweep amount exceeds yield position balance";

/// Positional dynamic-field key for the single yield position on a
/// `SavingsVault`. One position per vault (MVP); a multi-venue creator is a v1
/// concern that would key by `pool_id`.
public struct YieldKey() has copy, drop, store;

/// A creator's yield position, parked under the `YieldKey` dynamic field of
/// their `SavingsVault`. `principal` is the lifetime-net USDC supplied (the
/// accounting figure the dashboard shows); `balance` is the actual held funds
/// — the **Scallop CPI seam** (real impl swaps this for the Scallop sCoin).
public struct YieldPosition has store {
    strategy: StrategyRef,
    principal: u64,
    balance: Balance<USDC>,
}

/// Mode A: deposit the already-carved yield `coin` into the vault's position,
/// creating the position on first use. `public(package)` — only
/// `router::execute_split` calls this, in-PTB. This is the call that "can
/// abort" in the §7 sense: in the real Scallop wiring, `supply_into` may abort
/// (pool paused, min-deposit, version drift), reverting the whole split PTB.
public(package) fun deposit(
    vault: &mut SavingsVault,
    coin: Coin<USDC>,
    strategy: StrategyRef,
) {
    let uid = vaults::savings_uid_mut(vault);
    if (!df::exists<YieldKey>(uid, YieldKey())) {
        df::add(uid, YieldKey(), YieldPosition {
            strategy,
            principal: 0,
            balance: balance::zero(),
        });
    };
    let position = df::borrow_mut<YieldKey, YieldPosition>(uid, YieldKey());
    supply_into(position, coin);
}

/// Mode B: move `amount` of *already-banked* savings into the yield position.
/// `SavingsCap`-gated (this spends creator funds, so it needs the cold-wallet
/// cap, unlike the Mode A `deposit` which is authorized by the payment PTB).
/// Run by a scheduled off-chain job, decoupled from the payment path.
public(package) fun sweep(
    vault: &mut SavingsVault,
    cap: &SavingsCap,
    amount: u64,
    strategy: StrategyRef,
    ctx: &mut TxContext,
) {
    // `withdraw_savings` already asserts the cap binds to this vault (T4) and
    // that the balance covers `amount`; no need to re-check here.
    let coin = vaults::withdraw_savings(vault, cap, amount, ctx);
    deposit(vault, coin, strategy);
}

/// Redeem `amount` of USDC out of the yield position, returning a fresh coin to
/// the caller (the creator's cold wallet, via the PTB — spec §5 "Drain yield
/// only"). `SavingsCap`-gated and bound to THIS vault (T4). The real Scallop
/// wiring redeems the sCoin back to USDC inside `redeem_from`.
public(package) fun redeem(
    vault: &mut SavingsVault,
    cap: &SavingsCap,
    amount: u64,
    ctx: &mut TxContext,
): Coin<USDC> {
    assert!(capabilities::savings_cap_vault_id(cap) == object::id(vault), EWrongCap);
    let uid = vaults::savings_uid_mut(vault);
    assert!(df::exists<YieldKey>(uid, YieldKey()), ENoPosition);
    let position = df::borrow_mut<YieldKey, YieldPosition>(uid, YieldKey());
    redeem_from(position, amount, ctx)
}

// --- Scallop CPI seam --------------------------------------------------------
// Swapping ONLY these two bodies (and `YieldPosition.balance`'s type) for real
// Scallop market-coin calls takes this live. Everything above is production.

/// Supply `coin` into the position. MVP: park it in the held balance and credit
/// principal. Real impl: call Scallop `supply` → receive sCoin → store sCoin.
fun supply_into(position: &mut YieldPosition, coin: Coin<USDC>) {
    position.principal = position.principal + coin.value();
    position.balance.join(coin.into_balance());
}

/// Redeem `amount` USDC out of the position. MVP: take from the parked balance.
/// Real impl: burn sCoin via Scallop `redeem` → receive USDC. Asserts the
/// position can cover `amount` (fail loud, not silent-cap).
fun redeem_from(
    position: &mut YieldPosition,
    amount: u64,
    ctx: &mut TxContext,
): Coin<USDC> {
    assert!(amount <= position.balance.value(), EInsufficientYield);
    // `principal` tracks net supplied; on redeem we draw it down by the
    // withdrawn amount (yield earned over principal, once real, is the excess
    // balance beyond `principal` and is redeemed last).
    position.principal = if (amount >= position.principal) {
        0
    } else {
        position.principal - amount
    };
    coin::take(&mut position.balance, amount, ctx)
}

// --- getters: dashboard yield panel, indexer ---------------------------------

/// Whether the savings vault has an open yield position.
public fun has_position(vault: &SavingsVault): bool {
    df::exists<YieldKey>(vaults::savings_uid(vault), YieldKey())
}

/// Current redeemable USDC held in the position (0 if none). For real Scallop
/// this is the sCoin's USDC-equivalent (principal + accrued yield).
public fun position_value(vault: &SavingsVault): u64 {
    let uid = vaults::savings_uid(vault);
    if (!df::exists<YieldKey>(uid, YieldKey())) return 0;
    df::borrow<YieldKey, YieldPosition>(uid, YieldKey()).balance.value()
}

/// Net principal supplied into the position (0 if none).
public fun position_principal(vault: &SavingsVault): u64 {
    let uid = vaults::savings_uid(vault);
    if (!df::exists<YieldKey>(uid, YieldKey())) return 0;
    df::borrow<YieldKey, YieldPosition>(uid, YieldKey()).principal
}
