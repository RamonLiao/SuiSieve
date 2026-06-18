# CreatorFlow Web Dashboard — Design Spec

> Date: 2026-06-18 · Track 1 DeFi & Payments · Sui Overflow 2026
> Status: approved (brainstorming) → sui-architect reviewed → pending writing-plans
> Authoritative contract source: `docs/specs/2026-05-28-creatorflow-architecture-spec.md`. PTB/why → `move-notes.md`.

## 1. Goal

Creator-facing web dashboard for CreatorFlow: full CRUD over the on-chain revenue
router (`SplitConfig` + vaults), plus the demo centerpiece — **one incoming USDC
payment → atomic 4-way split**, visualized end to end. Reads the already-built
Hono REST indexer; writes via PTBs signed by wallet or zkLogin.

## 2. Decisions (locked in brainstorming)

| Topic | Decision |
|---|---|
| Scope | Full CRUD: read + create/edit config, vaults, withdraw, redeem, execute_split |
| Auth | Dual: `@mysten/dapp-kit` (browser wallet) **and** `@mysten/enoki` (zkLogin + sponsored tx) |
| Data read | REST API primary (history/aggregates/earnings) + chain SDK supplement (config/vault current state, avoids indexer lag) |
| zkLogin depth | Enoki full suite (zkLogin auth + sponsored gas — zkLogin addresses start with no SUI) |
| execute_split input | UI amount field; PTB splits `amount_in` out of the user's own USDC coin |
| UI implementation | Delegated to gemini cli — presentational components only. Logic hooks (PTB builders, REST client, validators) authored in-repo and locked. |

## 3. Stack

- Next.js 15 (App Router) + TypeScript + Tailwind, at `web/creatorflow-web/`
- **`@mysten/dapp-kit-react` + `@mysten/dapp-kit-core`** (SDK 2.0 API: `createDAppKit` /
  `DAppKitProvider` / `useDAppKit` / `useCurrentAccount` — NOT the legacy `@mysten/dapp-kit`
  `WalletProvider`/`useSignAndExecuteTransaction`), `@mysten/enoki` (zkLogin + sponsor),
  `@mysten/sui` (Transaction / PTB construction).
- **Chain reads via `SuiGrpcClient`** (`@mysten/sui/grpc`, recommended; JSON-RPC is deprecated).
  `network` param is required on the constructor. Reads: existing Hono REST
  (`api/creatorflow-api`) primary; `SuiGrpcClient.getObject({id, options:{showContent:true}})`
  for live config/vault state; `getCoins({owner, coinType})` to select the user's USDC for
  the split payment input.

## 4. On-chain constants (testnet, deployed 2026-06-18)

- Package: `0x0fda0d5bd9f042460d8ed51eaeaf2fd21e9d4baa74de75b031096516e047a656`
- ProtocolConfig (shared): `0x695297e727cd5fa636deff6578b3e5f53aa496ecd323248c1d072b58d9891bcc`
- USDC type: `0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC`
- Clock: `0x6`
- All router calls target `<pkg>::router::*`.
- Smoke-test config (owner = deployer): config `0x5d2830f1…aa1f5`, tax_vault `0x25105cd3…f126a`, savings_vault `0xac67fca0…c375f`.

## 5. Screens

| Route | Content | Reads | Writes |
|---|---|---|---|
| `/` login | Wallet connect OR Google (zkLogin), pick one | — | — |
| `/dashboard` | My configs list, each vault balance, recent splits | REST `/configs?owner=` + chain vault read | — |
| `/config/new` | Form: recipients (addr/bps/label), tax/savings/fee/yield bps, live `sum==10000` validation | — | `create_config_and_vaults` |
| `/config/[id]/edit` | Same form, prefilled | chain config | `mutate_config` |
| `/config/[id]` detail | Split history, collaborator earnings, mutation history; **Trigger split** (amount → own USDC); tax/savings withdraw; redeem yield | REST all endpoints | `execute_split`, `withdraw_tax`, `withdraw_savings`, `redeem_yield` |

## 6. PTB construction (locked hooks — gemini does not touch)

Router signatures (verified against `move/creatorflow/sources/router.move`):

- `create_config_and_vaults(protocol: &ProtocolConfig, recipients: vector<Recipient>, tax_bps: u16, savings_bps: u16, protocol_fee_bps: u16, yield_bps: u16, yield_strategy: Option<StrategyRef>, ctx)`
  - `Recipient` built via `split_config::new_recipient(addr, bps, label: vector<u8>)`; assemble `vector<Recipient>` with per-item moveCall results + `tx.makeMoveVec`.
  - `StrategyRef` via `split_config::new_strategy_ref(kind: u8, pool_id: ID)`; MVP passes `Option::none` (no yield strategy).
- `execute_split(config, protocol, tax_vault: &mut, savings_vault: &mut, payment: Coin<USDC>, include_yield: bool, expected_version: u64, clock, ctx)`
  - Resolve the user's USDC coins via `SuiGrpcClient.getCoins({owner, coinType})`; split `amount_in` out (`coinWithBalance` / `splitCoins`) → `payment`.
  - **`expected_version` MUST be read from chain (`split_config::version`) immediately before signing** (T2 stale-config guard).
  - MVP `include_yield = false` (no strategy wired).
- `mutate_config(config: &mut, owner_cap: &OwnerCap, protocol, new_recipients, new_tax_bps, new_savings_bps, ctx)`
- `withdraw_tax(vault: &mut, cap: &TaxCap, amount, ctx)` / `withdraw_savings(vault: &mut, cap: &SavingsCap, amount, ctx)` / `redeem_yield(savings_vault: &mut, cap: &SavingsCap, amount, ctx)`
  - Caps are owned objects in the user's wallet; resolve via `getOwnedObjects` by type.

PTB builders live as pure functions returning a `Transaction` — unit-testable without a wallet.

## 7. Data flow

- After a write: optimistic update + short-poll REST (exponential backoff, ~30s cap) until the new row appears; config/vault balances re-read from chain for immediate reflection.
- splits/earnings pagination uses the REST keyset cursor (4-tuple, already verified 2026-06-17).

## 8. Error handling (fail-loud, Rule 12)

Two layers (both must be handled):
1. **dapp-kit result** is a discriminated union — check `result.FailedTransaction` (not just
   try/catch); read `result.FailedTransaction.status.error?.message` for the raw abort string.
2. **Map the Move abort code** out of that error string → human message:
   - `EConfigChanged` → "Config changed, refresh and retry"
   - `EVaultMismatch` → "Vault/config mismatch"
   - `EZeroPayment` → "Amount must be > 0"
   - missing cap → "You are not the owner of this config"
- REST 400/500 surfaced as toast; no silent swallow.

## 9. Testing

- PTB builders (pure) → vitest: arg order, `vector<Recipient>` assembly, version injection, `Option` strategy.
- bps validator (sum==10000, ≤16 recipients, each > 0, yield ≤ savings) → vitest, mirrors contract invariants (Rule 9).
- E2E: reuse smoke config `0x5d2830…aa1f5`, run one `execute_split` on testnet → assert REST read-back (reuses 2026-06-18 verified path).
- Monkey: bps edges (0 / 10000 / u16 wrap), empty recipients, tampered version.

## 10. Open risks

1. **Enoki API key** — must be obtained from the Enoki portal (testnet) by the user; cannot be self-provisioned. Without it the zkLogin path is non-functional. **Mitigation: build the wallet path fully first; zkLogin path gated behind key availability.**
2. **REST API hosting** — currently local (`PORT` env, default `:3001` + local Docker PG `creatorflow-pg` @5433, db `creatorflow_indexer`). Demo requires same-host run or a deployed API (API deployment out of scope this round).
3. **gemini-produced UI** — passes dual-review. Strictly limited to presentational components; logic hooks authored in-repo.
4. **Enoki × new dapp-kit wiring** — `@mysten/enoki` registering as a wallet into the SDK 2.0
   `createDAppKit` flow must be verified against current Enoki docs during impl (the integration
   surface changed with the dapp-kit-core split). Wallet path is independent and unblocked.

## 12. Review trail

- 2026-06-18 `sui-architect` review (Protocol 124 / SDK 2.0 checklist). Findings folded in:
  - F1: chain reads → `SuiGrpcClient` (`@mysten/sui/grpc`), JSON-RPC deprecated; `network` required; USDC via `getCoins`.
  - F2: dApp Kit → `@mysten/dapp-kit-react` + `@mysten/dapp-kit-core` (`createDAppKit`/`useDAppKit`), not legacy `@mysten/dapp-kit`/`WalletProvider`.
  - F3: error handling is two-layer (dapp-kit `FailedTransaction` union → Move abort-code mapping).
  - Confirmed already-correct: `Transaction` (not `TransactionBlock`), `@mysten/sui` package name.

## 11. Out of scope (this round)

- API deployment / hosting.
- Real Scallop yield wiring (adapter is stub + CPI seam; `include_yield=false`).
- UpgradeCap → multisig.
- T10 contention load test.
