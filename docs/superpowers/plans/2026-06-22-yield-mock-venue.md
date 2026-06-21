# Mock Yield Venue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `yield_adapter` CPI stub with a working, type-compatible in-house `mock_lending` venue so the testnet demo shows live Clock-based yield (deposit → redeem more).

**Architecture:** New `mock_lending` module holds a single shared `MockMarket` with **segregated** `principal_pool` + `interest_buffer` balances and a Clock-ms interest rate. `yield_adapter`'s `YieldPosition` drops its held `Balance` and tracks `{strategy, principal, deposited_at_ms}`; principal USDC lives in the market. A shared `router::split_core` is extracted so a new opt-in `execute_split_with_yield` entry can route yield through the market while the existing `execute_split` (and the T10 load path) stay byte-identical.

**Tech Stack:** Sui Move 2024 (`move/creatorflow/`), Circle native USDC dep, `sui::clock::Clock`, `sui::dynamic_field`; frontend `@mysten/sui` Transaction PTB builders (`web/creatorflow-web/src/lib/ptb.ts`).

**Authoritative spec:** `docs/superpowers/specs/2026-06-21-yield-mock-venue-design.md` (v4, three SUI reviews folded).

## Global Constraints

- Move edition `2024`; package address name `creatorflow`; USDC type `usdc::usdc::USDC` (Circle native, monomorphic).
- Interest is **best-effort and NEVER aborts on a dry buffer** — principal liveness is absolute. Settle realizes `min(accrued, buffer)`.
- Exact accrual formula: `interest = principal · rate_bps_per_sec · elapsed_ms / (10000 · 1000)`, computed in u128, range-checked back to u64.
- `DEMO_RATE_BPS_PER_SEC = 5`; `MAX_RATE_BPS_PER_SEC = 100_000` (overflow guard, not economic).
- `mock_lending` is **added in a package upgrade** → `fun init` does NOT run; `MockMarket` is created by cap-gated one-shot `create_market(&AdminCap)`.
- `execute_split`'s public signature MUST stay unchanged (preserves T10 + frontend/t10/cap-defense callers).
- Run `sui move test` after every Move task before commit. Move review: `move-code-quality` → `sui-security-guard` → `sui-red-team` (NOT generic reviewer).
- Frontend: `pnpm vitest run` + `npx tsc --noEmit` green before commit.

---

### Task 1: `mock_lending` — pure `accrue` + module scaffold

**Files:**
- Create: `move/creatorflow/sources/mock_lending.move`
- Create: `move/creatorflow/tests/mock_lending_tests.move`

**Interfaces:**
- Produces: `mock_lending::accrue(principal: u64, rate_bps_per_sec: u64, elapsed_ms: u64): u64` (pure); error consts `EWrongMarketCap`, `ERateTooHigh`, `EZeroAmount`, `EReserveDry`, `EAccrualOverflow`; consts `DEMO_RATE_BPS_PER_SEC`, `MAX_RATE_BPS_PER_SEC`.

- [ ] **Step 1: Write the failing test** (`move/creatorflow/tests/mock_lending_tests.move`)

```move
#[test_only]
module creatorflow::mock_lending_tests;

use creatorflow::mock_lending::{Self, EAccrualOverflow};
use std::unit_test::assert_eq;

// interest = principal · rate · elapsed_ms / (10000 · 1000)
// 1_000_000 · 5 · 2000 / 10_000_000 = 1000
#[test]
fun accrue_matches_pinned_example() {
    assert_eq!(mock_lending::accrue(1_000_000, 5, 2_000), 1_000);
}

#[test]
fun accrue_zero_elapsed_or_zero_principal_is_zero() {
    assert_eq!(mock_lending::accrue(1_000_000, 5, 0), 0);
    assert_eq!(mock_lending::accrue(0, 5, 2_000), 0);
}

#[test]
fun accrue_is_linear() {
    let a = mock_lending::accrue(1_000_000, 5, 2_000);
    assert_eq!(mock_lending::accrue(1_000_000, 5, 4_000), a * 2);
    assert_eq!(mock_lending::accrue(2_000_000, 5, 2_000), a * 2);
}

// u64::MAX principal with a bounded elapsed must NOT overflow u128 internally.
#[test]
fun accrue_no_u128_overflow_at_max_principal_bounded() {
    // principal=u64::MAX, rate=MAX_RATE(100_000), elapsed=1e12 ms:
    // 1.84e19 · 1e5 · 1e12 = 1.84e36 < u128 max (3.4e38) — computes, no abort.
    let _ = mock_lending::accrue(18_446_744_073_709_551_615, 100_000, 1_000_000_000_000);
}

// A result that exceeds u64 range must fail loud, not silently truncate.
#[test, expected_failure(abort_code = EAccrualOverflow)]
fun accrue_overflow_fails_loud() {
    // principal=u64::MAX, rate=100_000, elapsed=1e15 ms:
    // interest = 1.84e19·1e5·1e15/1e7 = 1.84e32 >> u64::MAX → EAccrualOverflow.
    let _ = mock_lending::accrue(18_446_744_073_709_551_615, 100_000, 1_000_000_000_000_000);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd move/creatorflow && sui move test mock_lending`
Expected: FAIL — `mock_lending` module does not exist.

- [ ] **Step 3: Write the module scaffold + `accrue`** (`move/creatorflow/sources/mock_lending.move`)

```move
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd move/creatorflow && sui move test mock_lending`
Expected: PASS (5 accrue tests).

- [ ] **Step 5: Commit**

```bash
git add move/creatorflow/sources/mock_lending.move move/creatorflow/tests/mock_lending_tests.move
git commit -m "feat(move): mock_lending accrue + scaffold (pure interest, u64 range-check)"
```

---

### Task 2: `mock_lending` — MockMarket object + balance ops

**Files:**
- Modify: `move/creatorflow/sources/mock_lending.move`
- Modify: `move/creatorflow/tests/mock_lending_tests.move`

**Interfaces:**
- Consumes: `protocol_config::AdminCap`, `protocol_config::init_for_testing`.
- Produces: structs `MockMarket has key`, `MockMarketCap has key, store`; `create_market(&AdminCap, &mut TxContext)`; `seed(&mut MockMarket, &MockMarketCap, Coin<USDC>)`; `set_rate(&mut MockMarket, &MockMarketCap, u64)`; `public(package) supply(&mut MockMarket, Coin<USDC>): u64`; `public(package) realize_interest(&mut MockMarket, u64): u64`; `public(package) redeem(&mut MockMarket, u64, &mut TxContext): Coin<USDC>`; getters `rate`, `buffer_value`, `principal_pool_value`, `total_supplied`.

- [ ] **Step 1: Write the failing tests** (append to `move/creatorflow/tests/mock_lending_tests.move`)

```move
// add to the `use` block at the top:
//   use creatorflow::mock_lending::{Self, EAccrualOverflow, EWrongMarketCap, ERateTooHigh, EZeroAmount, MockMarket, MockMarketCap};
//   use creatorflow::protocol_config::{Self, AdminCap};
//   use sui::test_scenario as ts;
//   use sui::coin;
//   use usdc::usdc::USDC;
//   use std::unit_test::destroy;
// const ADMIN: address = @0xAD;

fun new_market(sc: &mut ts::Scenario): (MockMarket, MockMarketCap) {
    protocol_config::init_for_testing(sc.ctx());
    sc.next_tx(ADMIN);
    let admin = sc.take_from_sender<AdminCap>();
    mock_lending::create_market(&admin, sc.ctx());
    sc.next_tx(ADMIN);
    let market = sc.take_shared<MockMarket>();
    let cap = sc.take_from_sender<MockMarketCap>();
    sc.return_to_sender(admin);
    (market, cap)
}

fun usdc(amount: u64, sc: &mut ts::Scenario): coin::Coin<USDC> {
    coin::mint_for_testing<USDC>(amount, sc.ctx())
}

#[test]
fun supply_grows_principal_pool_and_total() {
    let mut sc = ts::begin(ADMIN);
    let (mut market, cap) = new_market(&mut sc);
    let added = mock_lending::supply(&mut market, usdc(1_000_000, &mut sc));
    assert!(added == 1_000_000);
    assert!(mock_lending::principal_pool_value(&market) == 1_000_000);
    assert!(mock_lending::total_supplied(&market) == 1_000_000);
    destroy(cap); ts::return_shared(market); sc.end();
}

#[test]
fun realize_interest_moves_buffer_best_effort() {
    let mut sc = ts::begin(ADMIN);
    let (mut market, cap) = new_market(&mut sc);
    mock_lending::seed(&mut market, &cap, usdc(1_000, &mut sc));
    // want within buffer → full realize.
    assert!(mock_lending::realize_interest(&mut market, 400) == 400);
    assert!(mock_lending::buffer_value(&market) == 600);
    assert!(mock_lending::principal_pool_value(&market) == 400);
    // want beyond buffer → best-effort min, NEVER aborts.
    assert!(mock_lending::realize_interest(&mut market, 10_000) == 600);
    assert!(mock_lending::buffer_value(&market) == 0);
    destroy(cap); ts::return_shared(market); sc.end();
}

#[test]
fun redeem_takes_from_principal_pool() {
    let mut sc = ts::begin(ADMIN);
    let (mut market, cap) = new_market(&mut sc);
    let _ = mock_lending::supply(&mut market, usdc(1_000_000, &mut sc));
    let out = mock_lending::redeem(&mut market, 300_000, sc.ctx());
    assert!(out.value() == 300_000);
    assert!(mock_lending::principal_pool_value(&market) == 700_000);
    destroy(out); destroy(cap); ts::return_shared(market); sc.end();
}

#[test, expected_failure(abort_code = EZeroAmount)]
fun redeem_zero_aborts() {
    let mut sc = ts::begin(ADMIN);
    let (mut market, cap) = new_market(&mut sc);
    let _ = mock_lending::supply(&mut market, usdc(100, &mut sc));
    let out = mock_lending::redeem(&mut market, 0, sc.ctx());
    destroy(out); destroy(cap); ts::return_shared(market); sc.end();
}

#[test, expected_failure(abort_code = ERateTooHigh)]
fun set_rate_above_max_aborts() {
    let mut sc = ts::begin(ADMIN);
    let (mut market, cap) = new_market(&mut sc);
    mock_lending::set_rate(&mut market, &cap, 100_001);
    destroy(cap); ts::return_shared(market); sc.end();
}

#[test, expected_failure(abort_code = EWrongMarketCap)]
fun seed_with_foreign_cap_aborts() {
    let mut sc = ts::begin(ADMIN);
    let (mut market_a, cap_a) = new_market(&mut sc);
    let (market_b, cap_b) = new_market(&mut sc);
    // cap_b governs market_b, not market_a.
    mock_lending::seed(&mut market_a, &cap_b, usdc(1, &mut sc));
    destroy(cap_a); destroy(cap_b);
    ts::return_shared(market_a); ts::return_shared(market_b); sc.end();
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd move/creatorflow && sui move test mock_lending`
Expected: FAIL — `MockMarket`, `create_market`, etc. undefined.

- [ ] **Step 3: Implement the market ops** (append to `move/creatorflow/sources/mock_lending.move`, after `accrue`)

```move
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd move/creatorflow && sui move test mock_lending`
Expected: PASS (all mock_lending tests).

- [ ] **Step 5: Commit**

```bash
git add move/creatorflow/sources/mock_lending.move move/creatorflow/tests/mock_lending_tests.move
git commit -m "feat(move): mock_lending MockMarket (segregated pools, best-effort realize, cap-gated)"
```

---

### Task 3: `yield_adapter` — venue wiring (settle-on-touch, market+clock)

**Files:**
- Modify: `move/creatorflow/sources/yield_adapter.move` (full rewrite of position shape + 3 entry fns + getters)
- Modify: `move/creatorflow/tests/yield_adapter_tests.move` (existing 10 tests break — rewrite for new signatures)

**Interfaces:**
- Consumes: `mock_lending::{MockMarket, accrue, rate, realize_interest, supply, redeem}`; `sui::clock::Clock`.
- Produces (new signatures):
  - `public(package) deposit(&mut MockMarket, &mut SavingsVault, Coin<USDC>, StrategyRef, &Clock)`
  - `public(package) sweep(&mut MockMarket, &mut SavingsVault, &SavingsCap, u64, StrategyRef, &Clock, &mut TxContext)`
  - `public(package) redeem(&mut MockMarket, &mut SavingsVault, &SavingsCap, u64, &Clock, &mut TxContext): Coin<USDC>`
  - `public position_value(&SavingsVault, &MockMarket, &Clock): u64`
  - `public position_principal(&SavingsVault): u64`, `public has_position(&SavingsVault): bool`
  - error consts incl. `EStrategyMismatch`, `EZeroRedeem` (plus existing `EWrongCap`, `ENoPosition`, `EInsufficientYield`).

- [ ] **Step 1: Rewrite the test file** (`move/creatorflow/tests/yield_adapter_tests.move`)

Replace the whole file. Key changes: thread a test `Clock` + `MockMarket` through every call; `position_value` takes `(&vault, &market, &clock)`; seed the buffer to observe accrual.

```move
#[test_only]
module creatorflow::yield_adapter_tests;

use creatorflow::yield_adapter::{Self, EWrongCap, ENoPosition, EInsufficientYield, EZeroRedeem};
use creatorflow::mock_lending::{Self, MockMarket, MockMarketCap};
use creatorflow::protocol_config::{Self, AdminCap};
use creatorflow::split_config::{Self, StrategyRef};
use creatorflow::vaults::{Self, SavingsVault};
use creatorflow::capabilities::SavingsCap;
use sui::test_scenario as ts;
use sui::clock::{Self, Clock};
use sui::coin;
use usdc::usdc::USDC;
use std::unit_test::{assert_eq, destroy};

const CREATOR: address = @0xC;

fun config_id(): ID { object::id_from_address(@0xC0F19) }
fun strategy(): StrategyRef { split_config::new_strategy_ref(0, object::id_from_address(@0x5CA110)) }
fun mint(amount: u64, sc: &mut ts::Scenario): coin::Coin<USDC> { coin::mint_for_testing<USDC>(amount, sc.ctx()) }
fun new_vault(sc: &mut ts::Scenario): (SavingsVault, SavingsCap) { vaults::new_savings_vault(config_id(), sc.ctx()) }

fun new_market(sc: &mut ts::Scenario): (MockMarket, MockMarketCap) {
    protocol_config::init_for_testing(sc.ctx());
    sc.next_tx(CREATOR);
    let admin = sc.take_from_sender<AdminCap>();
    mock_lending::create_market(&admin, sc.ctx());
    sc.next_tx(CREATOR);
    let market = sc.take_shared<MockMarket>();
    let cap = sc.take_from_sender<MockMarketCap>();
    sc.return_to_sender(admin);
    (market, cap)
}

#[test]
fun deposit_creates_position_and_accounts() {
    let mut sc = ts::begin(CREATOR);
    let (mut market, mcap) = new_market(&mut sc);
    let (mut vault, cap) = new_vault(&mut sc);
    let clk = clock::create_for_testing(sc.ctx());

    assert!(!yield_adapter::has_position(&vault));
    yield_adapter::deposit(&mut market, &mut vault, mint(1_000_000, &mut sc), strategy(), &clk);
    assert!(yield_adapter::has_position(&vault));
    // elapsed=0 → value == principal.
    assert_eq!(yield_adapter::position_value(&vault, &market, &clk), 1_000_000);
    assert_eq!(yield_adapter::position_principal(&vault), 1_000_000);
    assert_eq!(mock_lending::principal_pool_value(&market), 1_000_000);

    clock::destroy_for_testing(clk);
    destroy(vault); destroy(cap); destroy(mcap); ts::return_shared(market); sc.end();
}

#[test]
fun value_accrues_with_clock_when_buffer_funded() {
    let mut sc = ts::begin(CREATOR);
    let (mut market, mcap) = new_market(&mut sc);
    let (mut vault, cap) = new_vault(&mut sc);
    mock_lending::seed(&mut market, &mcap, mint(1_000_000, &mut sc));
    let mut clk = clock::create_for_testing(sc.ctx());

    yield_adapter::deposit(&mut market, &mut vault, mint(1_000_000, &mut sc), strategy(), &clk);
    clock::increment_for_testing(&mut clk, 2_000); // 2s @ rate 5 → +1000
    assert_eq!(yield_adapter::position_value(&vault, &market, &clk), 1_001_000);

    clock::destroy_for_testing(clk);
    destroy(vault); destroy(cap); destroy(mcap); ts::return_shared(market); sc.end();
}

#[test]
fun redeem_returns_principal_plus_realized_interest() {
    let mut sc = ts::begin(CREATOR);
    let (mut market, mcap) = new_market(&mut sc);
    let (mut vault, cap) = new_vault(&mut sc);
    mock_lending::seed(&mut market, &mcap, mint(1_000_000, &mut sc));
    let mut clk = clock::create_for_testing(sc.ctx());

    yield_adapter::deposit(&mut market, &mut vault, mint(1_000_000, &mut sc), strategy(), &clk);
    clock::increment_for_testing(&mut clk, 2_000); // settle on redeem realizes +1000
    let out = yield_adapter::redeem(&mut market, &mut vault, &cap, 1_001_000, &clk, sc.ctx());
    assert_eq!(out.value(), 1_001_000);
    assert_eq!(yield_adapter::position_principal(&vault), 0);

    destroy(out); clock::destroy_for_testing(clk);
    destroy(vault); destroy(cap); destroy(mcap); ts::return_shared(market); sc.end();
}

#[test, expected_failure(abort_code = EWrongCap)]
fun redeem_rejects_foreign_cap() {
    let mut sc = ts::begin(CREATOR);
    let (mut market, mcap) = new_market(&mut sc);
    let (mut vault_a, cap_a) = new_vault(&mut sc);
    let (vault_b, cap_b) = new_vault(&mut sc);
    let clk = clock::create_for_testing(sc.ctx());
    yield_adapter::deposit(&mut market, &mut vault_a, mint(1_000_000, &mut sc), strategy(), &clk);
    let out = yield_adapter::redeem(&mut market, &mut vault_a, &cap_b, 100, &clk, sc.ctx());
    destroy(out); clock::destroy_for_testing(clk);
    destroy(vault_a); destroy(cap_a); destroy(vault_b); destroy(cap_b);
    destroy(mcap); ts::return_shared(market); sc.end();
}

#[test, expected_failure(abort_code = ENoPosition)]
fun redeem_without_position_aborts() {
    let mut sc = ts::begin(CREATOR);
    let (mut market, mcap) = new_market(&mut sc);
    let (mut vault, cap) = new_vault(&mut sc);
    let clk = clock::create_for_testing(sc.ctx());
    let out = yield_adapter::redeem(&mut market, &mut vault, &cap, 1, &clk, sc.ctx());
    destroy(out); clock::destroy_for_testing(clk);
    destroy(vault); destroy(cap); destroy(mcap); ts::return_shared(market); sc.end();
}

#[test, expected_failure(abort_code = EInsufficientYield)]
fun redeem_over_principal_aborts() {
    let mut sc = ts::begin(CREATOR);
    let (mut market, mcap) = new_market(&mut sc);
    let (mut vault, cap) = new_vault(&mut sc);
    let clk = clock::create_for_testing(sc.ctx());
    yield_adapter::deposit(&mut market, &mut vault, mint(500_000, &mut sc), strategy(), &clk);
    let out = yield_adapter::redeem(&mut market, &mut vault, &cap, 500_001, &clk, sc.ctx());
    destroy(out); clock::destroy_for_testing(clk);
    destroy(vault); destroy(cap); destroy(mcap); ts::return_shared(market); sc.end();
}

#[test, expected_failure(abort_code = EZeroRedeem)]
fun redeem_zero_aborts() {
    let mut sc = ts::begin(CREATOR);
    let (mut market, mcap) = new_market(&mut sc);
    let (mut vault, cap) = new_vault(&mut sc);
    let clk = clock::create_for_testing(sc.ctx());
    yield_adapter::deposit(&mut market, &mut vault, mint(500_000, &mut sc), strategy(), &clk);
    let out = yield_adapter::redeem(&mut market, &mut vault, &cap, 0, &clk, sc.ctx());
    destroy(out); clock::destroy_for_testing(clk);
    destroy(vault); destroy(cap); destroy(mcap); ts::return_shared(market); sc.end();
}

// Shared-fate liveness (red-team/security-guard finding 5): A drains the buffer,
// B with unsettled interest still redeems its PRINCIPAL (settle realizes 0, no abort).
#[test]
fun dry_buffer_never_strands_principal() {
    let mut sc = ts::begin(CREATOR);
    let (mut market, mcap) = new_market(&mut sc);
    let (mut vault_a, cap_a) = new_vault(&mut sc);
    let (mut vault_b, cap_b) = new_vault(&mut sc);
    mock_lending::seed(&mut market, &mcap, mint(100, &mut sc)); // tiny buffer
    let mut clk = clock::create_for_testing(sc.ctx());

    yield_adapter::deposit(&mut market, &mut vault_a, mint(1_000_000, &mut sc), strategy(), &clk);
    yield_adapter::deposit(&mut market, &mut vault_b, mint(1_000_000, &mut sc), strategy(), &clk);
    clock::increment_for_testing(&mut clk, 10_000);
    // A settles first, drains the whole 100 buffer into its principal.
    let oa = yield_adapter::redeem(&mut market, &mut vault_a, &cap_a, 1_000_100, &clk, sc.ctx());
    assert_eq!(mock_lending::buffer_value(&market), 0);
    // B's settle realizes 0 (dry) but B's PRINCIPAL redeem still succeeds.
    let ob = yield_adapter::redeem(&mut market, &mut vault_b, &cap_b, 1_000_000, &clk, sc.ctx());
    assert_eq!(ob.value(), 1_000_000);

    destroy(oa); destroy(ob); clock::destroy_for_testing(clk);
    destroy(vault_a); destroy(cap_a); destroy(vault_b); destroy(cap_b);
    destroy(mcap); ts::return_shared(market); sc.end();
}

#[test]
fun sweep_moves_banked_savings_into_position() {
    let mut sc = ts::begin(CREATOR);
    let (mut market, mcap) = new_market(&mut sc);
    let (mut vault, cap) = new_vault(&mut sc);
    let clk = clock::create_for_testing(sc.ctx());
    vaults::deposit_savings(&mut vault, mint(1_000_000, &mut sc));
    yield_adapter::sweep(&mut market, &mut vault, &cap, 700_000, strategy(), &clk, sc.ctx());
    assert_eq!(vaults::savings_balance(&vault), 300_000);
    assert_eq!(yield_adapter::position_principal(&vault), 700_000);
    clock::destroy_for_testing(clk);
    destroy(vault); destroy(cap); destroy(mcap); ts::return_shared(market); sc.end();
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd move/creatorflow && sui move test yield_adapter`
Expected: FAIL — old signatures, `position_value` arity, `EZeroRedeem` undefined.

- [ ] **Step 3: Rewrite `yield_adapter.move`**

Replace the module body below the doc-comment. New imports + position shape + private `settle` + 3 entry fns + getters.

```move
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

// --- getters -----------------------------------------------------------------

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

public fun position_principal(vault: &SavingsVault): u64 {
    let uid = vaults::savings_uid(vault);
    if (!df::exists<YieldKey>(uid, YieldKey())) return 0;
    df::borrow<YieldKey, YieldPosition>(uid, YieldKey()).principal
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd move/creatorflow && sui move test yield_adapter`
Expected: PASS (all rewritten yield_adapter tests).

- [ ] **Step 5: Commit**

```bash
git add move/creatorflow/sources/yield_adapter.move move/creatorflow/tests/yield_adapter_tests.move
git commit -m "feat(move): yield_adapter venue wiring (settle-on-touch, market+clock, EStrategyMismatch/EZeroRedeem)"
```

---

### Task 4: `router` — split_core extraction + execute_split_with_yield + redeem_yield update

**Files:**
- Modify: `move/creatorflow/sources/router.move`
- Modify: `move/creatorflow/tests/router_tests.move` (add integration tests; existing redeem_yield test, if any, updates for new signature)

**Interfaces:**
- Consumes: `mock_lending::MockMarket`; `yield_adapter::deposit/redeem`.
- Produces:
  - `public(package) split_core(&SplitConfig, &ProtocolConfig, &mut TaxVault, &mut SavingsVault, Coin<USDC>, bool route_yield, u64 expected_version, &Clock, &mut TxContext): Option<Coin<USDC>>`
  - `execute_split(...)` — SAME public signature as today (delegates to split_core with route_yield=false).
  - `public execute_split_with_yield(&SplitConfig, &ProtocolConfig, &mut MockMarket, &mut TaxVault, &mut SavingsVault, Coin<USDC>, u64 expected_version, &Clock, &mut TxContext)`
  - `redeem_yield(&mut MockMarket, &mut SavingsVault, &SavingsCap, u64, &Clock, &mut TxContext)` — new signature.

**IMPORTANT — existing tests break (behavior change):** today `execute_split(..., include_yield=true)` routes the yield slice into a position. The redesign makes plain `execute_split` NEVER route yield, and `position_value` becomes 3-arg `(&vault, &market, &clk)`. Four existing tests in `router_tests.move` must be migrated (Step 1b) before adding the new ones (Step 1a).

- [ ] **Step 1a: Add a market helper + the new integration tests** (in `move/creatorflow/tests/router_tests.move`)

Add to the `use` block:

```move
use creatorflow::mock_lending::{Self, MockMarket, MockMarketCap};
```

Add a helper (after `init_protocol`/`create`). It assumes the scenario is just past `create(...)` and the `AdminCap` is in CREATOR's inventory (left there by `init_protocol`):

```move
// Create + seed a MockMarket in CREATOR's scenario. Buffer funded so interest is
// realizable in tests that advance the clock.
fun funded_market(sc: &mut ts::Scenario): (MockMarket, MockMarketCap) {
    let admin = sc.take_from_sender<AdminCap>();
    mock_lending::create_market(&admin, sc.ctx());
    sc.return_to_sender(admin);
    sc.next_tx(CREATOR);
    let mut mkt = sc.take_shared<MockMarket>();
    let cap = sc.take_from_sender<MockMarketCap>();
    mock_lending::seed(&mut mkt, &cap, mint(1_000_000, sc));
    (mkt, cap)
}

// Variant of `create` with a caller-chosen yield_bps (for the zero-slice test).
fun create_yield_bps(yield_bps: u16, sc: &mut ts::Scenario) {
    let protocol = sc.take_shared<ProtocolConfig>();
    router::create_config_and_vaults(
        &protocol, standard_recipients(), 500, 450, 50, yield_bps, strategy(), sc.ctx(),
    );
    ts::return_shared(protocol);
    sc.next_tx(CREATOR);
}
```

```move
// yield_bps=0 with strategy=some via _with_yield → NO position, no zero-coin (red-team #5).
#[test]
fun zero_yield_slice_creates_no_position() {
    let mut sc = ts::begin(CREATOR);
    init_protocol(&mut sc);
    create_yield_bps(0, &mut sc);
    let (mut mkt, mcap) = funded_market(&mut sc);

    let config = sc.take_shared<SplitConfig>();
    let protocol = sc.take_shared<ProtocolConfig>();
    let mut tax_vault = sc.take_shared<TaxVault>();
    let mut savings_vault = sc.take_shared<SavingsVault>();

    sc.next_tx(PAYER);
    let pay = mint(1_000_000, &mut sc);
    let clk = clock::create_for_testing(sc.ctx());
    router::execute_split_with_yield(
        &config, &protocol, &mut mkt, &mut tax_vault, &mut savings_vault,
        pay, 0, &clk, sc.ctx(),
    );
    sc.next_tx(CREATOR);

    assert!(!yield_adapter::has_position(&savings_vault));        // no position created
    assert_eq!(mock_lending::principal_pool_value(&mkt), 0);      // no zero-coin supplied
    assert_eq!(vaults::savings_balance(&savings_vault), 45_000);  // full savings slice stays

    clk.destroy_for_testing();
    cleanup_payouts(&sc);
    destroy(mcap);
    ts::return_shared(config); ts::return_shared(protocol);
    ts::return_shared(tax_vault); ts::return_shared(savings_vault);
    ts::return_shared(mkt);
    sc.end();
}

// Plain execute_split NEVER mutates the market (T10 carve-out regression lock).
#[test]
fun plain_execute_split_does_not_touch_market() {
    let mut sc = ts::begin(CREATOR);
    init_protocol(&mut sc);
    create(strategy(), &mut sc);
    let (mkt, mcap) = funded_market(&mut sc);

    let config = sc.take_shared<SplitConfig>();
    let protocol = sc.take_shared<ProtocolConfig>();
    let mut tax_vault = sc.take_shared<TaxVault>();
    let mut savings_vault = sc.take_shared<SavingsVault>();

    sc.next_tx(PAYER);
    let pay = mint(1_000_000, &mut sc);
    let clk = clock::create_for_testing(sc.ctx());
    router::execute_split(
        &config, &protocol, &mut tax_vault, &mut savings_vault,
        pay, true, 0, &clk, sc.ctx(),  // include_yield ignored on the plain path
    );
    sc.next_tx(CREATOR);

    // Market untouched: no supply happened, no position. Plain path doesn't take it.
    assert_eq!(mock_lending::principal_pool_value(&mkt), 0);
    assert_eq!(mock_lending::total_supplied(&mkt), 0);
    assert!(!yield_adapter::has_position(&savings_vault));
    assert_eq!(vaults::savings_balance(&savings_vault), 45_000); // slice stayed in savings

    clk.destroy_for_testing();
    cleanup_payouts(&sc);
    destroy(mcap);
    ts::return_shared(config); ts::return_shared(protocol);
    ts::return_shared(tax_vault); ts::return_shared(savings_vault);
    ts::return_shared(mkt);
    sc.end();
}

// Intra-PTB deposit→redeem extracts 0 interest (single Clock snapshot, red-team #4).
#[test]
fun intra_tx_deposit_then_redeem_zero_interest() {
    let mut sc = ts::begin(CREATOR);
    init_protocol(&mut sc);
    create(strategy(), &mut sc);
    let (mut mkt, mcap) = funded_market(&mut sc);

    let config = sc.take_shared<SplitConfig>();
    let protocol = sc.take_shared<ProtocolConfig>();
    let mut tax_vault = sc.take_shared<TaxVault>();
    let mut savings_vault = sc.take_shared<SavingsVault>();
    let savings_cap = sc.take_from_sender<SavingsCap>();

    sc.next_tx(PAYER);
    let pay = mint(1_000_000, &mut sc);
    let clk = clock::create_for_testing(sc.ctx()); // never incremented
    router::execute_split_with_yield(
        &config, &protocol, &mut mkt, &mut tax_vault, &mut savings_vault,
        pay, 0, &clk, sc.ctx(),
    );
    // Same tx-time redeem: elapsed = 0 → 0 interest → out == deposited principal (40_000).
    router::redeem_yield(&mut mkt, &mut savings_vault, &savings_cap, 40_000, &clk, sc.ctx());
    sc.next_tx(CREATOR);
    assert_eq!(drain_address(&sc, CREATOR), 40_000); // exactly principal, no interest

    clk.destroy_for_testing();
    cleanup_payouts(&sc);
    sc.return_to_sender(savings_cap);
    destroy(mcap);
    ts::return_shared(config); ts::return_shared(protocol);
    ts::return_shared(tax_vault); ts::return_shared(savings_vault);
    ts::return_shared(mkt);
    sc.end();
}
```

- [ ] **Step 1b: Migrate the four breaking existing tests**

1. **`execute_split_routes_all_slices_and_emits_once`** — this asserted the *plain* path routes yield, which it no longer does. Convert it to the **yield path**: take a `funded_market`, call `execute_split_with_yield` (drop the `include_yield` bool arg), and make `position_value` 3-arg. The numbers are identical (tax 50_000, savings 5_000, yield 40_000):

```move
#[test]
fun execute_split_with_yield_routes_all_slices_and_emits_once() {
    let mut sc = ts::begin(CREATOR);
    init_protocol(&mut sc);
    create(strategy(), &mut sc);
    let (mut mkt, mcap) = funded_market(&mut sc);

    let config = sc.take_shared<SplitConfig>();
    let protocol = sc.take_shared<ProtocolConfig>();
    let mut tax_vault = sc.take_shared<TaxVault>();
    let mut savings_vault = sc.take_shared<SavingsVault>();

    let amount = 1_000_000u64;
    sc.next_tx(PAYER);
    let pay = mint(amount, &mut sc);
    let clk = clock::create_for_testing(sc.ctx());
    router::execute_split_with_yield(
        &config, &protocol, &mut mkt, &mut tax_vault, &mut savings_vault,
        pay, 0, &clk, sc.ctx(),
    );
    let eff = sc.next_tx(CREATOR);
    assert_eq!(ts::num_user_events(&eff), 1);

    assert_eq!(vaults::tax_balance(&tax_vault), 50_000);
    assert_eq!(vaults::savings_balance(&savings_vault), 5_000);
    assert_eq!(yield_adapter::position_value(&savings_vault, &mkt, &clk), 40_000);
    assert_eq!(mock_lending::principal_pool_value(&mkt), 40_000);

    let alice_coin = sc.take_from_address<Coin<USDC>>(ALICE);
    let bob_coin = sc.take_from_address<Coin<USDC>>(BOB);
    let fee_coin = sc.take_from_address<Coin<USDC>>(TREASURY);
    assert_eq!(alice_coin.value(), 600_000);
    assert_eq!(bob_coin.value(), 300_000);
    assert_eq!(fee_coin.value(), 5_000);
    // 5-term conservation on the yield path (red-team #6).
    let total = alice_coin.value() + bob_coin.value() + fee_coin.value()
        + vaults::tax_balance(&tax_vault) + vaults::savings_balance(&savings_vault)
        + yield_adapter::position_value(&savings_vault, &mkt, &clk);
    assert_eq!(total, amount);

    destroy(alice_coin); destroy(bob_coin); destroy(fee_coin);
    clk.destroy_for_testing();
    destroy(mcap);
    ts::return_shared(config); ts::return_shared(protocol);
    ts::return_shared(tax_vault); ts::return_shared(savings_vault);
    ts::return_shared(mkt);
    sc.end();
}
```

2. **The redeem_yield test (~line 420-470)** — funds via `execute_split`, then `redeem_yield`. Plain split no longer creates a position, so `redeem_yield` would abort `ENoPosition`. Migrate: fund via `execute_split_with_yield` + `funded_market`, and give `redeem_yield` the new `(&mut mkt, …, &clk, …)` signature. The asserted numbers are unchanged (tax 30_000, savings 4_000, position 30_000, drain 31_000). Replace the two `router::execute_split(...)`→`execute_split_with_yield(...)` (drop bool, add `&mut mkt`), `router::redeem_yield(&mut savings_vault, &savings_cap, 10_000, sc.ctx())`→`router::redeem_yield(&mut mkt, &mut savings_vault, &savings_cap, 10_000, &clk, sc.ctx())`, and `position_value(&savings_vault)`→`position_value(&savings_vault, &mkt, &clk)`; add the market teardown (`destroy(mcap); ts::return_shared(mkt);`).

3. **The dust-conservation test (~line 340-366)** and **4. `monkey_varied_amounts_conserve_value` (~line 480-522)** — these stay on **plain** `execute_split` (testing dust math, not yield). Plain split now banks the yield slice into savings, so simply **delete the `+ yield_adapter::position_value(&savings_vault)` term** from each conservation sum — the slice is already counted in `vaults::savings_balance`. No market needed. (Conservation still holds: `alice + bob + fee + tax + savings == amount`.)

   The two tests that already assert `!has_position` (`execute_split_without_yield_banks_slice_to_savings`, `execute_split_no_strategy_ignores_include_yield`) compile unchanged — `has_position` stays 1-arg and plain-path behavior (no routing) is what they already expect.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd move/creatorflow && sui move test router`
Expected: FAIL — `execute_split_with_yield`, `split_core` undefined; `redeem_yield` arity changed.

- [ ] **Step 3: Refactor `router.move`**

(a) Add imports near the existing `use` block:

```move
use creatorflow::mock_lending::MockMarket;
```

(b) Extract `split_core`: move the entire current body of `execute_split` (lines 116–226: the T2/T9/T6 asserts, fee, tax, savings/yield carve, recipients, dust, event emit) into:

```move
/// The shared split body — fee/tax/savings/recipient/dust + SplitExecuted emit. Returns
/// the carved yield coin as `some(coin)` ONLY when `route_yield && yield_amt > 0`, else
/// `none`. References can't live in `Option`, so the market is routed by the caller.
public(package) fun split_core(
    config: &SplitConfig,
    protocol: &ProtocolConfig,
    tax_vault: &mut TaxVault,
    savings_vault: &mut SavingsVault,
    mut payment: Coin<USDC>,
    route_yield: bool,
    expected_version: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): Option<Coin<USDC>> {
    assert!(split_config::version(config) == expected_version, EConfigChanged);
    let config_id = object::id(config);
    assert!(vaults::tax_config_id(tax_vault) == config_id, EVaultMismatch);
    assert!(vaults::savings_config_id(savings_vault) == config_id, EVaultMismatch);
    assert!(split_config::tax_vault_id(config) == object::id(tax_vault), EVaultMismatch);
    assert!(split_config::savings_vault_id(config) == object::id(savings_vault), EVaultMismatch);

    let amount_in = payment.value();
    assert!(amount_in > 0, EZeroPayment);
    let denom = (protocol_config::bps_denominator() as u128);

    let fee_amt = slice(amount_in, split_config::protocol_fee_bps(config), denom);
    if (fee_amt > 0) {
        transfer::public_transfer(payment.split(fee_amt, ctx), protocol_config::treasury(protocol));
    };

    let tax_amt = slice(amount_in, split_config::tax_bps(config), denom);
    if (tax_amt > 0) { vaults::deposit_tax(tax_vault, payment.split(tax_amt, ctx)); };

    let savings_total = slice(amount_in, split_config::savings_bps(config), denom);
    let yield_amt = slice(amount_in, split_config::yield_bps(config), denom);
    // Option contract = "is there a NON-ZERO coin to route" (red-team #5).
    let do_yield = route_yield && split_config::yield_strategy(config).is_some() && yield_amt > 0;
    let mut savings_coin = payment.split(savings_total, ctx);

    let savings_deposited;
    let yield_deposited;
    let yield_out;
    if (do_yield) {
        yield_out = option::some(savings_coin.split(yield_amt, ctx));
        savings_deposited = savings_total - yield_amt;
        yield_deposited = yield_amt;
    } else {
        yield_out = option::none();
        savings_deposited = savings_total;
        yield_deposited = 0;
    };
    vaults::deposit_savings(savings_vault, savings_coin);

    let recipients = split_config::recipients(config);
    let n = recipients.length();
    let mut payouts = vector[];
    let mut i = 0;
    while (i < n) {
        let r = recipients.borrow(i);
        let addr = split_config::recipient_addr(r);
        let bps = split_config::recipient_bps(r);
        let amt = if (i + 1 == n) { payment.value() } else { slice(amount_in, bps, denom) };
        transfer::public_transfer(payment.split(amt, ctx), addr);
        payouts.push_back(events::new_recipient_payout(addr, amt, bps));
        i = i + 1;
    };
    if (n == 0) { vaults::deposit_savings(savings_vault, payment); } else { payment.destroy_zero(); };

    events::emit_split_executed(
        config_id, split_config::version(config), amount_in, payouts,
        tax_amt, savings_deposited, fee_amt, yield_deposited, do_yield, clock.timestamp_ms(),
    );
    yield_out
}
```

(c) Replace `execute_split`'s body to delegate (KEEP the exact public signature; rename the now-unused `include_yield` to `_include_yield`):

```move
public fun execute_split(
    config: &SplitConfig,
    protocol: &ProtocolConfig,
    tax_vault: &mut TaxVault,
    savings_vault: &mut SavingsVault,
    payment: Coin<USDC>,
    _include_yield: bool,
    expected_version: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    // No venue on this path (would force every split to lock MockMarket → kills T10).
    // The yield slice, if any, stays in savings; route_yield = false ⇒ always `none`.
    let leftover = split_core(config, protocol, tax_vault, savings_vault, payment, false, expected_version, clock, ctx);
    leftover.destroy_none();
}
```

(d) Add `execute_split_with_yield` after `execute_split`:

```move
/// Opt-in yield path: same split, but routes the yield sub-slice through `mock_lending`.
/// The ONLY entry taking `&mut MockMarket` (so it does NOT serialize the plain hot path).
public fun execute_split_with_yield(
    config: &SplitConfig,
    protocol: &ProtocolConfig,
    market: &mut MockMarket,
    tax_vault: &mut TaxVault,
    savings_vault: &mut SavingsVault,
    payment: Coin<USDC>,
    expected_version: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let yield_out = split_core(config, protocol, tax_vault, savings_vault, payment, true, expected_version, clock, ctx);
    if (yield_out.is_some()) {
        let yc = yield_out.destroy_some();
        let strategy = *split_config::yield_strategy(config).borrow();
        yield_adapter::deposit(market, savings_vault, yc, strategy, clock);
    } else {
        yield_out.destroy_none();
    };
}
```

(e) Update `redeem_yield` to thread market + clock:

```move
public fun redeem_yield(
    market: &mut MockMarket,
    savings_vault: &mut SavingsVault,
    cap: &SavingsCap,
    amount: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let coin = yield_adapter::redeem(market, savings_vault, cap, amount, clock, ctx);
    let to = ctx.sender();
    events::emit_vault_withdrawn(object::id(savings_vault), events::kind_savings(), amount, to);
    transfer::public_transfer(coin, to);
}
```

- [ ] **Step 4: Run the full suite to verify it passes**

Run: `cd move/creatorflow && sui move test`
Expected: PASS — full suite (prior 57+ tests, now updated, plus the new router integration + mock_lending + yield_adapter tests). Confirm count went UP, none skipped.

- [ ] **Step 5: Commit**

```bash
git add move/creatorflow/sources/router.move move/creatorflow/tests/router_tests.move
git commit -m "feat(move): router split_core + execute_split_with_yield + market-threaded redeem_yield"
```

---

### Task 5: Move review gate (quality + security + red-team)

**Files:** none (review only). No code changes unless a finding requires a fix; fixes go in the relevant module with a test.

- [ ] **Step 1: Build + lint**

Run: `cd move/creatorflow && sui move build`
Expected: 0 errors, 0 warnings (the `self_transfer` `#[allow]` precedent in router is the only pre-existing allow).

- [ ] **Step 2: `move-code-quality`** on `mock_lending.move`, `yield_adapter.move`, `router.move`. Expected: 0 critical / 0 warning. Fix anything flagged, re-run `sui move test`.

- [ ] **Step 3: `sui-security-guard`** on the three files. Confirm the §8 defenses are present in code: segregated pools, best-effort `realize_interest` (never aborts), `EZeroRedeem`/`EZeroAmount`, `set_rate` bound, `create_market` single path, `public(package)` on supply/realize/redeem.

- [ ] **Step 4: `sui-red-team`** on `mock_lending` + `yield_adapter` + the two router entries. Confirm all 12 §8 vectors have a corresponding test. Add tests for any uncovered vector.

- [ ] **Step 5: Commit any fixes**

```bash
git add move/creatorflow/
git commit -m "test(move): close yield venue review findings (move-quality/security/red-team)"
```

(If no fixes were needed, skip the commit and note "review clean" in the task log.)

---

### Task 6: Frontend PTB builders + constants

**Files:**
- Modify: `web/creatorflow-web/src/lib/constants.ts`
- Modify: `web/creatorflow-web/src/lib/ptb.ts`
- Modify: `web/creatorflow-web/src/lib/ptb.test.ts`

**Interfaces:**
- Consumes: deployed `MOCK_MARKET_ID` (placeholder until Task 7 deploy), `CLOCK_ID`, `PROTOCOL_CONFIG_ID`.
- Produces: `buildExecuteSplitWithYield(p)`; updated `buildRedeemYield(p)` (now takes `mockMarketId`).
- Argument ORDER must match Move exactly:
  - `execute_split_with_yield(config, protocol, market, tax_vault, savings_vault, payment, expected_version, clock)`
  - `redeem_yield(market, savings_vault, cap, amount, clock)`

- [ ] **Step 1: Write the failing test** (append to `web/creatorflow-web/src/lib/ptb.test.ts`)

```ts
import { buildExecuteSplitWithYield, buildRedeemYield } from "./ptb";
import { MOCK_MARKET_ID, PACKAGE_ID } from "./constants";

test("buildExecuteSplitWithYield targets the _with_yield entry and includes market+clock", () => {
  const tx = buildExecuteSplitWithYield({
    configId: "0x1", taxVaultId: "0x2", savingsVaultId: "0x3",
    amountIn: 1_000_000n, expectedVersion: 1n, usdcCoinIds: ["0xc1"],
  });
  const json = JSON.stringify(tx.getData());
  expect(json).toContain(`${PACKAGE_ID}::router::execute_split_with_yield`);
  expect(json).toContain(MOCK_MARKET_ID);
  expect(json).toContain("0x6"); // clock
});

test("buildRedeemYield includes the mock market and clock", () => {
  const tx = buildRedeemYield({ savingsVaultId: "0x3", savingsCapId: "0x4", amount: 500n });
  const json = JSON.stringify(tx.getData());
  expect(json).toContain(`${PACKAGE_ID}::router::redeem_yield`);
  expect(json).toContain(MOCK_MARKET_ID);
  expect(json).toContain("0x6");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web/creatorflow-web && pnpm vitest run src/lib/ptb.test.ts`
Expected: FAIL — `buildExecuteSplitWithYield`/`MOCK_MARKET_ID` not exported.

- [ ] **Step 3: Add the constant + builders**

In `constants.ts` (after `PROTOCOL_CONFIG_ID`):

```ts
// Created post-upgrade via router/mock_lending create_market one-shot (see plan Task 7).
// Placeholder until deploy; replace with the real shared object id.
export const MOCK_MARKET_ID =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
```

In `ptb.ts`, add `MOCK_MARKET_ID` to the import from `./constants`, then add/replace:

```ts
export function buildExecuteSplitWithYield(p: {
  configId: string;
  taxVaultId: string;
  savingsVaultId: string;
  amountIn: bigint;
  expectedVersion: bigint;
  usdcCoinIds: string[];
}): Transaction {
  const tx = new Transaction();
  const [primary, ...rest] = p.usdcCoinIds;
  const primaryCoin = tx.object(primary);
  if (rest.length > 0) {
    tx.mergeCoins(primaryCoin, rest.map((id) => tx.object(id)));
  }
  const [payment] = tx.splitCoins(primaryCoin, [tx.pure.u64(p.amountIn)]);
  tx.moveCall({
    target: `${R}::execute_split_with_yield`,
    arguments: [
      tx.object(p.configId),
      tx.object(PROTOCOL_CONFIG_ID),
      tx.object(MOCK_MARKET_ID),
      tx.object(p.taxVaultId),
      tx.object(p.savingsVaultId),
      payment,
      tx.pure.u64(p.expectedVersion),
      tx.object(CLOCK_ID),
    ],
  });
  return tx;
}
```

Replace `buildRedeemYield` to thread the market + clock:

```ts
export function buildRedeemYield(p: {
  savingsVaultId: string;
  savingsCapId: string;
  amount: bigint;
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${R}::redeem_yield`,
    arguments: [
      tx.object(MOCK_MARKET_ID),
      tx.object(p.savingsVaultId),
      tx.object(p.savingsCapId),
      tx.pure.u64(p.amount),
      tx.object(CLOCK_ID),
    ],
  });
  return tx;
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `cd web/creatorflow-web && pnpm vitest run && npx tsc --noEmit`
Expected: PASS (new ptb tests + existing suite green); tsc clean. If a `useWrite`/component caller of `buildRedeemYield` passed args positionally, update it to the new object shape.

- [ ] **Step 5: Commit**

```bash
git add web/creatorflow-web/src/lib/constants.ts web/creatorflow-web/src/lib/ptb.ts web/creatorflow-web/src/lib/ptb.test.ts
git commit -m "feat(web): execute_split_with_yield + market-threaded redeem_yield PTB builders"
```

---

### Task 7: Testnet deploy + e2e (operational — gated on user)

**Files:**
- Modify: `web/creatorflow-web/src/lib/constants.ts` (real `MOCK_MARKET_ID` after create_market)
- Modify: `move-notes.md` (record ids + tx digests)

**This task touches the live chain — confirm with the user before each on-chain step.**

- [ ] **Step 1: Migration gate (spec §3).** Confirm zero live old-shape `YieldPosition`s exist on the deployed package (the stub never created one — its redeem demo aborts `ENoPosition`). If any exists, STOP and fresh-deploy vaults instead of in-place upgrade.

- [ ] **Step 2: Upgrade the package.** `sui client upgrade` with the existing UpgradeCap (`0x56bcc662…f736d40`). Record the new package id. Update `PACKAGE_ID` in constants if it changes (Sui in-place upgrade keeps the original id for type identity but emits a new published-at; confirm which the frontend uses).

- [ ] **Step 3: Create the market.** Build + run a `create_market(&AdminCap)` PTB (AdminCap `0x6a37ee33…9c3f5000`). Record the shared `MockMarket` id and the `MockMarketCap` id. Set the real `MOCK_MARKET_ID` in `constants.ts`.

- [ ] **Step 4: Seed the buffer.** Run a `seed(market, cap, coin)` PTB transferring ~5–10 testnet USDC into `interest_buffer`.

- [ ] **Step 5: E2E.** From the dashboard (or a script): run `execute_split_with_yield` on a yield-configured config, wait a few seconds, call `redeem_yield`, confirm the redeemed amount exceeds the deposited yield slice (visible interest). Record both tx digests.

- [ ] **Step 6: Record + commit.**

```bash
git add web/creatorflow-web/src/lib/constants.ts move-notes.md
git commit -m "chore: record mock_lending testnet deploy (market/cap ids, e2e digests)"
```

---

## Notes for the executor

- The `router_tests.move` integration tests in Task 4 Step 1 are sketched against the file's existing config-builder helper — open `router_tests.move` first, reuse its setup (it already builds a config + vaults + caps and knows the starting `version`), and fill the asserts mirroring the existing dust-conservation test. Do NOT invent a new helper if one exists (Rule 11 / DRY).
- After Task 4, the whole suite must be green in ONE `sui move test` run — the three modules are interdependent; a green `mock_lending`-only run is necessary but not sufficient.
