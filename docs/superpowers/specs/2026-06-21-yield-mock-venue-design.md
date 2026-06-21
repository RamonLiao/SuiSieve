# Mock Yield Venue + `yield_adapter` Real Wiring — Design Spec

> Date: 2026-06-21 · Status: draft (pre sui-architect review)
> Supersedes the `yield_adapter` MVP stub (CPI seam) with a working, type-compatible
> on-chain yield venue for the **testnet demo**.

## 1. Why

`yield_adapter` currently parks the yield slice as a raw `Balance<USDC>` in a
dynamic field (the "CPI seam" stub). The plan was to swap `supply_into` /
`redeem_from` for real Scallop calls. **Spike result (2026-06-21): blocked at the
type level.**

- Scallop's lending pools are keyed to **Wormhole wUSDC** (`0x5d4b30…::coin::COIN`,
  SDK name `wusdc`), wrapped as `reserve::MarketCoin<T>`.
- Our entire stack is hardwired to **Circle-native USDC** (`usdc::usdc::USDC`).
- Move's type system requires the `Balance<T>` supplied to a reserve to match the
  reserve's `T` **exactly**. `Balance<usdc::usdc::USDC>` cannot be supplied to a
  wUSDC reserve — this fails to compile, not at runtime. Even on mainnet this holds
  unless Scallop opens a native-USDC reserve.
- All Scallop SDK docs are mainnet-centric; no maintained testnet pool surfaced.

**Decision:** build a minimal in-house `mock_lending` venue that is type-compatible
with Circle USDC, accrues visible interest via `Clock`, and plugs into the existing
`yield_adapter` seam. This keeps the seam design's value (real venue wiring,
cap-gated accounting, principal tracking) while being demoable on testnet today.
Real Scallop integration becomes a v2 concern gated on a native-USDC reserve.

This is explicitly a **demo venue**, not a production protocol — see §8.

## 2. Constraints (the two that shape the design)

1. **We cannot mint Circle USDC.** Interest paid on redeem must come from a
   **pre-funded interest buffer** of real testnet USDC. The creator seeds the
   `MockMarket` from their own wallet (e.g. 5–10 USDC). **Principal liveness is
   absolute: a settle NEVER aborts on a dry buffer** (security-guard finding 5 — an
   abort there would brick an innocent creator's *principal* redeem, the opposite of
   the §3 segregation goal). Interest is therefore **best-effort**: settle realizes
   `min(accrued, buffer_value)` and resets the clock; if the buffer is dry it realizes
   0 and principal is still fully withdrawable. Buffer exhaustion is observable via the
   `buffer_value` getter (dashboard headroom), not via an abort.
2. **Demo must show yield live.** Sui testnet epochs are ~24h, so epoch-based
   accrual would read `elapsed = 0` during a demo. Interest is therefore
   **`Clock`-millisecond based**. Exact integer formula (pinned to avoid a 1000×/
   10000× unit bug — `rate` is *bps per second* but elapsed is in *ms*):

   ```
   interest = principal · rate_bps_per_sec · elapsed_ms / (BPS_DENOM · MS_PER_SEC)
            = principal · rate_bps_per_sec · elapsed_ms / (10000 · 1000)
   ```

   computed in u128, range-checked back to u64 (`assert result <= U64_MAX`, fail
   loud) before use. `elapsed_ms = now - deposited_at_ms` with `now >= deposited_at_ms`
   asserted (`EClockRewind`) so a raw underflow can't masquerade as an abort.

## 3. New module: `creatorflow::mock_lending`

Mirrors a real lending venue's shape (supply → receipt, redeem → underlying) but
keeps accounting trivial. **No fungible market-coin / exchange-rate model** (YAGNI);
principal + timestamp on the position is enough for a demo.

### Objects

```move
/// Shared. Funds are SEGREGATED into two balances (architect §1 fix — prevents
/// cross-creator principal stranding):
///   - `principal_pool` always holds exactly Σ all positions' settled principal.
///     A redeem draws principal from here; it is ALWAYS fully backed, so a
///     principal withdrawal can never be stranded by another creator's interest.
///   - `interest_buffer` is the seeded USDC that pays yield. On settle, realized
///     interest is MOVED buffer→principal_pool; if the buffer can't cover it the
///     settle aborts `EBufferDry` — fail-loud at the moment of accrual, on the
///     party accruing, not on a later innocent redeemer.
public struct MockMarket has key {
    id: UID,
    principal_pool: Balance<USDC>,
    interest_buffer: Balance<USDC>,
    rate_bps_per_sec: u64,   // interest in bps accrued per second, per unit principal
    total_supplied: u64,     // lifetime gross supplied (dashboard solvency headroom)
}

/// Admin cap for seeding the buffer and setting the rate. Minted to publisher at
/// init. Gates the only two privileged entry points.
public struct MockMarketCap has key, store { id: UID, market_id: ID }
```

### Functions

```move
// One-shot constructor. NOTE (security-guard finding 2): mock_lending is ADDED in a
// package UPGRADE, and Move `fun init` runs ONLY at original publish — it does NOT
// re-run on upgrade. So MockMarket cannot be created by a module initializer here; it
// is created by a cap-gated one-shot using the EXISTING deployed protocol AdminCap.
public fun create_market(&AdminCap, ctx): (already deployed AdminCap gates it; share MockMarket(rate=DEMO_RATE, balances=0), transfer fresh MockMarketCap to caller). Call once, record ids.
public fun seed(&mut MockMarket, &MockMarketCap, Coin<USDC>)   // cap-gated; interest_buffer.join(coin). `public` is intentional — deployer seeds via off-chain PTB (security-guard finding 1, cleared).
public fun set_rate(&mut MockMarket, &MockMarketCap, u64)      // cap-gated; assert rate <= MAX_RATE_BPS_PER_SEC (ERateTooHigh)
// CPI seam entry points (called by yield_adapter only):
public(package) fun supply(&mut MockMarket, Coin<USDC>): u64   // principal_pool.join(coin); total_supplied += v; returns v
public(package) fun realize_interest(&mut MockMarket, want: u64): u64  // move min(want, buffer) buffer→principal_pool; returns realized amount (NEVER aborts — best-effort)
public(package) fun redeem(&mut MockMarket, amount: u64, &mut TxContext): Coin<USDC>  // assert amount>0 (EZeroAmount); take from principal_pool (always backed post-settle); EReserveDry guards invariant
public fun accrue(principal: u64, rate_bps_per_sec: u64, elapsed_ms: u64): u64        // pure interest calc, u128 internally + u64 range-check
public fun rate(&MockMarket): u64
public fun buffer_value(&MockMarket): u64                      // remaining interest headroom (dashboard)
public fun principal_pool_value(&MockMarket): u64
```

- `DEMO_RATE` = **5 bps/sec** (~0.05% per second). Documented as *demo-unrealistic by
  design* — chosen so a few seconds of wait shows a visible delta. Adjustable via
  `set_rate`, **bounded** by `MAX_RATE_BPS_PER_SEC` (security-guard finding 7/8 — an
  unbounded rate lets the u128 `principal·rate·elapsed` product overflow → every settle
  aborts = full DoS; and drains the whole buffer in one settle). Pick `MAX_RATE` so the
  product can't overflow u128 at `principal = u64::MAX` over a plausible elapsed window.
  **Rate changes are NOT time-segmented**: settle-on-touch means `set_rate` retroactively
  reprices every position's *unsettled* interval. Demo-acceptable; stated so it's not a bug.
- `realize_interest` is **best-effort, never aborts** (finding 5): realizes `min(want,
  buffer_value)`, returns the amount actually realized so the caller folds only that into
  principal. Principal liveness never depends on buffer solvency.
- `accrue` is pure (no object/clock) → unit-testable in isolation; uses u128, range-checks
  back to u64 (fail loud on overflow), returns u64 interest.
- `supply` / `realize_interest` / `redeem` are `public(package)` — **only** `yield_adapter`
  reaches them, and `yield_adapter::redeem` is `SavingsCap`-gated, so there's no uncapped
  path to `coin::take` (asserted by test).
- **Flooring forfeit (finding 4, by design):** `accrue` floors each settle; high-frequency
  self-touches forfeit sub-threshold interest. A third party CANNOT force a settle (all
  paths are cap-/PTB-/owner-scoped), so this is not a griefing vector — only the owner can
  churn their own position. Documented, not defended.

### Errors

```move
#[error] const EWrongMarketCap: ... // cap.market_id != this market
#[error] const ERateTooHigh: ...    // set_rate above MAX_RATE_BPS_PER_SEC
#[error] const EZeroAmount: ...      // redeem amount == 0 (T6 zero-coin/event-poison guard)
#[error] const EReserveDry: ...     // defensive: principal_pool < redeem amount (invariant breach)
#[error] const EClockRewind: ...    // now < deposited_at_ms (Clock invariant breach)
```

## 4. `yield_adapter` changes (seam cashed in)

### Position shape

```move
public struct YieldPosition has store {
    strategy: StrategyRef,
    principal: u64,        // settled principal (interest folded in on each touch)
    deposited_at_ms: u64,  // last settle time; accrual base
}
```

`balance: Balance<USDC>` is **removed** — principal now lives in `MockMarket.reserve`.

### Settle-on-touch

Every deposit/redeem first realizes accrued interest into principal then resets the
clock, so repeated touches compound cleanly and there's no per-deposit lot tracking.
Realizing interest also MOVES that USDC buffer→principal_pool, keeping `principal_pool`
exactly backing Σ settled principal (architect §1):

```
now      = clock.timestamp_ms()
assert now >= deposited_at_ms                          // EClockRewind
accrued  = mock_lending::accrue(principal, market.rate(), now - deposited_at_ms)
realized = mock_lending::realize_interest(market, accrued)  // best-effort: min(accrued, buffer); NEVER aborts
principal = principal + realized                       // fold ONLY what was actually realized
deposited_at_ms = now
```

A position with `principal = 0` (just created) or `elapsed = 0` accrues 0 — no buffer
draw. A dry buffer realizes 0 — principal is untouched and stays fully withdrawable
(finding 5). Folding `realized` (not `accrued`) keeps `principal_pool` exactly backing
Σ settled principal.

### Functions (all gain `&mut MockMarket` + `&Clock`)

```move
public(package) fun deposit(&mut MockMarket, &mut SavingsVault, Coin<USDC>, StrategyRef, &Clock)
public(package) fun sweep  (&mut MockMarket, &mut SavingsVault, &SavingsCap, amount, StrategyRef, &Clock, &mut TxContext)
public(package) fun redeem (&mut MockMarket, &mut SavingsVault, &SavingsCap, amount, &Clock, &mut TxContext): Coin<USDC>
public fun position_value    (&SavingsVault, &MockMarket, &Clock): u64   // principal + live accrued interest
public fun position_principal(&SavingsVault): u64                        // settled principal only (no clock)
public fun has_position      (&SavingsVault): bool
```

- `deposit`: settle (if position exists) → `principal += mock_lending::supply(market, coin)` →
  update timestamp. Creates position on first use.
- `redeem`: cap-gated + cross-vault check (`EWrongCap` preserved) → `assert amount > 0`
  (`EZeroRedeem` — security-guard finding 3: a zero-amount redeem would mint a zero
  `Coin<USDC>` + emit a junk `VaultWithdrawn`, the same T6 object-bloat/event-poison
  vector `execute_split` guards) → settle (best-effort interest into principal) →
  `assert amount <= principal` (`EInsufficientYield`) → `principal -= amount` →
  `mock_lending::redeem(market, amount, ctx)` draws from principal_pool (always solvent
  post-settle). The returned coin includes the creator's realized yield.
- `position_value(vault, market, clock)` takes `&MockMarket` (immutable) — it does NOT
  mutate, so it parallelizes and avoids the §5 serialization bottleneck.
- The cross-vault cap defense (T4 / `EWrongCap`), `ENoPosition`, and fail-loud
  `EInsufficientYield` semantics are all preserved.

## 5. `router` changes (minimal blast radius)

`execute_split` already carries `&Clock` and already conditionally routes yield. The
only missing input for the real venue is `&mut MockMarket`. Adding it to
`execute_split` would force **every** split (even non-yield) to lock the MockMarket
shared object — needlessly serializing the hot path and invalidating the T10
contention result. So we use **two entry points**:

- **`execute_split` — signature UNCHANGED.** Its yield branch no longer routes to a
  venue (it has no `MockMarket`): the yield slice simply stays in the savings vault
  and `yield_included` is emitted `false`. `include_yield` param is retained for
  caller compatibility (documented: "no-venue path; use `execute_split_with_yield`").
  → **t10-load-test.mts, SplitForm PTB, cap-defense-demo are all untouched.**
- **New `execute_split_with_yield(config, protocol, tax_vault, savings_vault,
  market: &mut MockMarket, payment, expected_version, clock, ctx)`** — routes the yield
  sub-slice through `yield_adapter::deposit(market, …)`. The only path taking `MockMarket`.
- **No duplicated split math (security-guard finding 6 — `DES-FN`/drift risk):** the
  fee/tax/savings/recipient/dust-conservation body is extracted into one
  `public(package) fun split_core(config, protocol, tax_vault, savings_vault, payment,
  route_yield: bool, expected_version, clock, ctx): Option<Coin<USDC>>`. It does ALL of
  fee→treasury, tax→vault, recipient payouts, dust absorption, savings deposit (minus the
  yield slice), and emits `SplitExecuted` with `yield_included = route_yield` (matches the
  existing "constructed into PTB" semantics of that flag). It **returns** the carved yield
  `Coin<USDC>` as `some(coin)` when `route_yield` else `none` — references can't live in
  `Option` in Move, so the market is NOT threaded into `split_core`; the thin wrapper
  routes the returned coin. Both entries call it:
  - `execute_split` → `split_core(route_yield=false)` → `none` → done. Public signature
    unchanged (T10 preserved).
  - `execute_split_with_yield` → `split_core(route_yield=true)` → `some(yield_coin)` →
    `yield_adapter::deposit(market, savings_vault, yield_coin, strategy, clock)`.

  ONE copy of the conserved-gross/dust logic. §7 integration test asserts gross
  conservation holds **identically** on both paths.
- **`redeem_yield`** wrapper gains `&mut MockMarket` + `&Clock`. Only the redeem-yield
  demo uses it (today it aborts `ENoPosition` anyway), so no other caller breaks.

`sweep` (Mode B) signature updated for consistency but stays router-unreachable
(I1 unchanged — not in scope to add a wrapper).

**T10 scope carve-out (architect §2):** `MockMarket` is a single *global* shared
object mutated by every `execute_split_with_yield` and every `redeem` — strictly worse
than the vaults (which are per-creator). Two splits for *different* creators that
parallelize on the plain path will **serialize** on the yield path. This is acceptable
for a demo/cold-path venue and we deliberately do **not** shard (sharding reintroduces
the §3 per-shard solvency problem). The T10 "contention cleared" result covers ONLY the
plain `execute_split` path; **it does NOT extend to `execute_split_with_yield`**. Keeping
`execute_split`'s signature unchanged is precisely what preserves the T10 guarantee.

## 6. Frontend (TypeScript / dapp-kit PTB)

- **New** PTB builder `buildExecuteSplitWithYield(...)` — passes the shared
  `MockMarket` id + `0x6` Clock alongside existing split inputs.
- **Updated** redeem PTB builder — adds `MockMarket` + Clock.
- **Unchanged**: existing `buildExecuteSplit`, t10 harness, cap-defense script.
- Dashboard yield panel reads `position_value(vault, market, clock)` and
  `position_principal(vault)` via `SuiGrpcClient` (live accrued vs settled principal;
  the delta is the visible "yield"). No new events — consistent with the existing
  "events deferred" decision; the indexer is not extended in this task.
- Deployment artifacts: **`init` does NOT run on a package upgrade** (security-guard
  finding 2 — Move module initializers fire only at original publish). Since `mock_lending`
  is added via in-place upgrade, the shared `MockMarket` is created by a separate cap-gated
  one-shot `create_market(&AdminCap)` PTB after the upgrade, using the already-deployed
  protocol `AdminCap`. That call shares `MockMarket` + transfers `MockMarketCap` to the
  deployer. Record both ids in `.env` / move-notes; then seed the buffer with ~5–10 testnet
  USDC. (The earlier "publishing creates MockMarket" framing was wrong for in-place upgrade.)

### Upgrade / migration hazard (architect §3 — GATE before deploy)

Removing `Balance<USDC>` from `YieldPosition` changes the bytes serialized under the
`YieldKey` dynamic field. The package **upgrade itself is compatible** (Sui upgrade
rules constrain `key`/public-struct ABI, not bytes already stored in a DF). The hazard
is at **read time**: any deployed `SavingsVault` that already holds an OLD-shape
`YieldPosition` will **abort on `df::borrow` deserialization** under new code, and its
old `Balance<USDC>` becomes unreachable/stranded.

**Gate:** before upgrading, confirm **zero live `YieldPosition`s** exist on the deployed
package (the stub's redeem demo aborts `ENoPosition`, strongly implying none were ever
created). If clean → upgrade in place. If any exists → **fresh-deploy new vaults** and
abandon old-stub vaults (a one-shot migration entry is more work than this demo
warrants). This is a §10 DoD item, not optional.

## 7. Testing

**`mock_lending` unit/property:**
- `accrue` pure: zero elapsed → 0; `principal = 0` → 0; linear in elapsed and principal;
  exact formula `principal·rate·elapsed_ms/(10000·1000)` (pin a worked example, e.g.
  principal=1_000_000, rate=5, elapsed_ms=2000 → interest=1000). u128 no-overflow at
  `principal = u64::MAX` with a **bounded** `elapsed_ms` (pin the bound, e.g. 1e12 ms ≈
  31 yr — deterministic, no abort); confirm u64 range-check fires on a constructed
  overflow input.
- `supply` grows `principal_pool` + `total_supplied`; `redeem` shrinks `principal_pool`
  and returns exact coin.
- `realize_interest` best-effort: full buffer → realizes `accrued`; dry/partial buffer →
  realizes `min(accrued, buffer)`, returns that, **never aborts** (finding 5).
- `seed`/`set_rate` reject foreign cap → `EWrongMarketCap`; `set_rate` above
  `MAX_RATE_BPS_PER_SEC` → `ERateTooHigh`; extreme rate (`u64::MAX`) rejected, not
  overflow-aborting every settle (finding 7/8).
- `create_market` reachable only with the protocol `AdminCap`; no other constructor
  shares a `MockMarket` (finding 2 — assert single creation path).
- **no uncapped path to `coin::take`**: `supply`/`realize_interest`/`redeem` are
  `public(package)` (compile-level) — only `yield_adapter` reaches them.
- `redeem` with `amount = 0` → `EZeroAmount` (finding 3).

**`yield_adapter` (updated):**
- deposit creates position with timestamp; second deposit settles+compounds (interest
  realized buffer→pool, principal grows).
- `position_value` accrues with clock advance; equals principal when `elapsed = 0`.
- redeem cap-gated; cross-vault `SavingsCap` → `EWrongCap`; no position → `ENoPosition`.
- redeem > settled principal → `EInsufficientYield`; redeem `amount = 0` → `EZeroRedeem`.
- **shared-fate liveness (finding 5, the key test):** creator A's large accrual drains the
  buffer; then creator B — *with unsettled interest* — redeems → settle realizes 0 interest
  (best-effort) but B's **principal redeem still succeeds**. (The bug this guards: an
  abort-on-dry-buffer would brick B's principal.)

**Monkey (Rule: break it):**
- redeem the full value then redeem again (position drained → `EInsufficientYield`).
- supply 0-value coin; clock never advances (interest 0, value == principal, no buffer draw).
- compound: many small deposits over advancing clock; buffer drains mid-run → later
  accruals realize 0, no abort, no underflow; principal always withdrawable.
- `set_rate(u64::MAX)` → `ERateTooHigh`; confirm no settle overflows u128 at max allowed rate.

**Integration (router):**
- `execute_split_with_yield` routes the yield slice into the market; `position_value` after
  a clock bump exceeds the deposited slice.
- non-yield `execute_split` still parks the slice in savings (regression — t10 path intact).
- **gross conservation holds identically on BOTH entry points** (finding 6 — `split_core`
  shared body; assert payout+tax+savings+fee == amount_in, zero dust, on each path).
- **market-untouched regression (finding 7):** plain `execute_split` never mutates
  `MockMarket` — only `execute_split_with_yield` takes it as input.

## 8. Red team (core money flow → `sui-red-team` required)

Pre-listed attack vectors and defenses:

1. **Cross-creator principal theft / stranding / liveness DoS** — drain the buffer so
   another creator can't redeem. Defense: segregated `principal_pool` (always = Σ settled
   principal, never pays interest) vs `interest_buffer`; `realize_interest` is **best-effort
   and never aborts** (realizes `min(accrued, buffer)`), so a dry buffer denies *future
   yield* but never blocks a settle → principal is always withdrawable (security-guard
   finding 5). `coin::take` never underflows; `EReserveDry` is a defensive invariant guard.
2. **Rate manipulation** — attacker inflates `rate_bps_per_sec` to mint interest.
   Defense: `set_rate` is `MockMarketCap`-gated; cap bound to `market_id`
   (`EWrongMarketCap`). (Note: a legit cap-holder changing rate retroactively reprices
   unsettled intervals — documented §3, demo-acceptable, not an exploit.)
3. **Cross-vault cap reuse** — redeem another creator's position. Defense: `redeem`
   asserts `SavingsCap.vault_id == object::id(vault)` → `EWrongCap` (preserved T4).
4. **Interest overflow** — `principal · rate · elapsed` overflows u64. Defense:
   `accrue` computes in u128, range-checks `<= U64_MAX` (fail loud), returns u64.
5. **Clock spoofing / rewind** — forge elapsed time to over-accrue, or trigger a
   backwards subtraction. Defense: `&Clock` is the `0x6` system object (PTB cannot
   substitute a forged clock); `assert now >= deposited_at_ms` (`EClockRewind`).
6. **Uncapped reserve drain** — call `mock_lending::redeem` directly to pull USDC without
   a `SavingsCap`. Defense: `supply`/`realize_interest`/`redeem` are `public(package)`;
   the only caller is `yield_adapter`, whose `redeem` is `SavingsCap`-gated.
7. **Zero-amount redeem (T6 object-bloat/event-poison)** — redeem 0 to mint junk zero-coins
   + junk `VaultWithdrawn` events at gas cost. Defense: `yield_adapter::redeem` asserts
   `amount > 0` (`EZeroRedeem`); `mock_lending::redeem` re-asserts (`EZeroAmount`).
8. **Rate-overflow DoS** — set `rate_bps_per_sec` so high that `principal·rate·elapsed`
   overflows u128 → every settle aborts → all positions frozen. Defense: `set_rate` bounds
   `rate <= MAX_RATE_BPS_PER_SEC` (`ERateTooHigh`), chosen so the product can't overflow
   u128 at `principal = u64::MAX`.
9. **Second-market creation** — call a constructor twice to spawn a rogue `MockMarket`.
   Defense: only `create_market(&AdminCap)` constructs/shares one; gated by the protocol
   `AdminCap`; no module-init path on upgrade (finding 2).

## 9. Explicitly out of scope (YAGNI)

- Real Scallop integration (blocked on native-USDC reserve; v2).
- Fungible market-coin / exchange-rate share accounting.
- Yield events + indexer extension (dashboard reads live via gRPC getters).
- Router wrapper for `sweep` (Mode B stays unreachable, I1 unchanged).
- Multi-venue routing by `pool_id`.
- Client-side Mode A retry loop — separate TODO, unblocked once this lands but not
  built here.

## 10. Definition of done

- `mock_lending` + updated `yield_adapter` + `execute_split_with_yield` compile;
  `sui move test` green (existing 57+ suite plus new tests).
- `move-code-quality` 0 critical; `sui-red-team` 9 vectors (§8) DEFENDED with tests.
- Frontend new PTB builders typecheck; existing builders/tests untouched.
- **Migration gate (§3):** confirm zero live old-shape `YieldPosition`s on the deployed
  package before upgrade; if any exist, fresh-deploy vaults instead of in-place upgrade.
- Testnet: in-place upgrade → `create_market(&AdminCap)` one-shot → seed `interest_buffer`
  (~5–10 USDC) → run `execute_split_with_yield`, wait a few seconds → `redeem_yield`
  returns principal + visible interest; record tx digests + `MockMarket`/`MockMarketCap`
  ids in move-notes.
