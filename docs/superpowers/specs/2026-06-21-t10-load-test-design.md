# T10 Contention Load Test — Design

> Date: 2026-06-21
> Validates threat **T10 / D3** (spec §9, §11; threat-model.md D3): every
> `execute_split` takes `&mut` on BOTH `TaxVault` and `SavingsVault`, so all
> concurrent payments to one creator serialize through Sui consensus on those
> two shared objects. UC-2 ("350 fans" burst) is the worst case. Spec marks this
> "acceptable for MVP, **must be load-tested**" — this is that test.

## Goal

Measure single-creator `execute_split` throughput and latency under a concurrent
burst, isolated to the shared-vault contention point, and decide the spec §15 v1
mitigation (sub-vault sharding vs fast-path owned-coin accumulation + sweep) or
record "MVP throughput acceptable".

## Success criteria

- Produces, for each tier N ∈ {10, 50, 150, 350}: wall-clock, throughput
  (N / wall), latency p50/p90/p99, and abort breakdown (success / retriable-locked
  / terminal-abort).
- Verifies split math conservation on a sampled successful tx
  (payout + tax + savings + fee == amountIn, zero dust).
- Writes a results table to `move-notes.md` plus a v1-mitigation verdict.

## Approach: testnet, single-key N-coin fan

Use the already-deployed testnet package + an existing owner config/vaults. From
**one** key (owner `0x1509…bcbc4c`), pre-split SUI into N gas coins and a USDC
coin into N input coins — both are *owned* objects, so the N txs never conflict
with each other on inputs. The **only** shared contention is
`SplitConfig` + `TaxVault` + `SavingsVault` — exactly what T10 measures. This
avoids funding 350 separate wallets while keeping the measured contention
identical (shared-object serialization is independent of sender identity).

**Rejected alternatives**:
- *Localnet republish + mint USDC* — cleaner isolated numbers but requires
  publishing the whole stack + the Circle USDC dep and minting via its
  TreasuryCap on localnet. Setup cost not worth it for MVP validation; real
  testnet numbers are more credible for judging.
- *350 distinct keypairs* — faucet rate limits make funding 350 wallets
  impractical; adds no measurement value over the single-key fan because the
  contention point is sender-independent.

## Harness

`web/creatorflow-web/scripts/t10-load-test.mts` (tsx, same style as
`cap-defense-demo.mts`). Uses `SuiGrpcClient` + the owner keypair for signing.
Reuses `buildExecuteSplit` from `src/lib/ptb.ts` and IDs from `src/lib/constants.ts`.

Config/vault IDs and the owner key are passed via env / args (not hardcoded), so
the script is re-runnable against any owner config.

### Per-tier flow (N)

1. **Prep (sequential, awaits finality)**
   - PTB `splitCoins` on a USDC coin → N coins of `AMOUNT_RAW` (10000 = 0.01 USDC
     each); collect the N created coin IDs from effects.
   - PTB `splitCoins` on the gas SUI coin → N gas coins; collect IDs.
   - `getObject(configId)` once → read `version` (→ `expectedVersion`) and
     `tax_vault_id` / `savings_vault_id`.
   - Pre-check: USDC balance ≥ N·AMOUNT_RAW and SUI ≥ N·gasBudget + buffer;
     abort loud otherwise.

2. **Burst (concurrent core)**
   - Build N `execute_split` txs. Each: input = one dedicated USDC coin
     (`usdcCoinIds=[coin]`, `amountIn=AMOUNT_RAW`), `expectedVersion` from prep,
     `tx.setSender(owner)`, `tx.setGasPayment([dedicated gas coin])`,
     `tx.setGasBudget(FIXED_BUDGET)` (skips gas estimation / dry-run so timing is
     not polluted and shared objects are not read pre-flight).
   - **Pre-build to bytes in prep, not in the burst.** `signAndExecuteTransaction`
     internally calls `transaction.build({client})`, which resolves every object
     ref (owned coin versions/digests + shared-object initial versions) via RPC
     reads. Doing that inside the timed burst measures the SDK's resolution reads,
     not vault serialization. So call `await tx.build({ client })` for all N txs
     during prep; in the burst only `signer.signTransaction(bytes)` +
     `client.executeTransaction({ transaction: bytes, signatures })` are timed.
   - Fire all N via `Promise.allSettled(...)`; record `submit→resolve` ms per tx
     (`performance.now()`). `resolve` = execution-acknowledged by the validator
     (gRPC execution path; Quorum Driver is disabled in Protocol 124), not
     checkpoint finality — documented in the report.
   - **No auto-retry** — retrying masks the throughput ceiling. Classify each
     result into explicit buckets: `success` / `congestion`
     (`ExecutionCancelledDueToSharedObjectCongestion` — Protocol 124 per-shared-
     object congestion control deferring the tx; **this is the T10 ceiling
     signal**) / `locked` (owned-object lock contention — should be ~0 given
     dedicated coins; a non-zero count means the isolation leaked) / `terminal`
     (Move abort, e.g. `EConfigChanged`).

3. **Measure & report**
   - Compute wall-clock (first submit → last resolve), throughput, latency
     percentiles, abort breakdown.
   - On one sampled success, read effects and assert
     `Σ recipient_payout + tax + savings + fee == AMOUNT_RAW` (zero dust).
   - Print a per-tier table; append the four-tier summary + verdict to `move-notes.md`.

### Constants

- `AMOUNT_RAW = 10000` (0.01 USDC; well above EZeroPayment, small enough that
  560 total txs cost ≈ 5.6 USDC).
- `FIXED_BUDGET` — a static gas budget (e.g. 20_000_000 MIST) sized from a single
  dry-run done once during harness bring-up, not per tx.
- Tiers run smallest→largest so a failure surfaces cheaply before the 350 burst.

## Harness threat model (defenses built in)

| Risk | Defense |
|---|---|
| gas-coin equivocation (two txs reuse one coin) | pre-split N dedicated gas coins, per-tx `setGasPayment` |
| config mutated mid-burst → all `EConfigChanged` | do not mutate during test; `version` read once and locked |
| dry-run pollutes timing + extra shared-object reads | fixed `gasBudget`, gas estimation disabled |
| insufficient coins / prep failure | prep awaits finality + balance pre-check, abort loud |
| false positives from retry masking the ceiling | no retry; classify retriable vs terminal |

## SDK / platform notes (verified against installed @mysten/sui 2.19.0, Protocol 124)

- `SuiGrpcClient` (`@mysten/sui/grpc`) exposes `signAndExecuteTransaction`,
  `executeTransaction`, `waitForTransaction`, `simulateTransaction`. JSON-RPC /
  Quorum Driver is deprecated/disabled — the gRPC execution path is primary.
- `signAndExecuteTransaction({ transaction, signer })` builds + signs + executes;
  the harness splits this into pre-built bytes (prep) + `executeTransaction`
  (burst) per the timing-isolation requirement above.
- Reuses `buildExecuteSplit` from `src/lib/ptb.ts` (splits exactly `amountIn` off
  the dedicated coin → compatible with one-coin-per-tx). Signer is an
  `Ed25519Keypair` loaded from env (never hardcoded).

## Known caveat

A single sender is not the same as 350 independent fans at the **network /
mempool** layer (no distributed client geography, one validator submission path).
But the **contention point is identical** — shared-object serialization does not
depend on sender identity. This caveat is recorded in the report; it does not
affect the vault-serialization measurement T10 targets.

## Out of scope

- Implementing the v1 mitigation (sharding / sweep) — this test only *decides*
  which one is needed, if any.
- Mutation/withdraw load (T10 is the `execute_split` hot path only).
