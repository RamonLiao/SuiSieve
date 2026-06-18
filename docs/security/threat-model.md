# CreatorFlow — Threat Model (STRIDE)

Scope: MVP Move package + dashboard. Off-chain indexer treated as untrusted read-only.

## Assets
- A1: Creator's USDC balance (in-flight payments).
- A2: TaxVault / SavingsVault balances.
- A3: SplitConfig integrity (recipient list + bps).
- A4: Capability objects (OwnerCap / TaxCap / SavingsCap).
- A5: Yield position in Scallop.

## Adversaries
- Adv1: Phisher who obtains creator's hot-wallet key (zkLogin session compromise).
- Adv2: Malicious collaborator wanting to inflate own bps.
- Adv3: Malicious payer / fan crafting hostile PTB.
- Adv4: Compromised yield protocol (Scallop bug).
- Adv5: Indexer operator (us, in MVP) — passive observation.
- Adv6: Protocol/`AdminCap` holder acting against creators (fee inflation).

## STRIDE

| ID | Threat | Asset | Adv | Mitigation | Status |
|----|--------|-------|-----|-----------|--------|
| S1 | Spoofed `SplitConfig` impersonating real one | A1 | Adv3 | Vault.config_id ↔ Config.{tax,savings}_vault_id cross-checked on every split; payer signs `expected_version` | designed |
| S2 | Forged Cap object | A2 | Adv1 | Cap creation is module-private (`create_split_config` only); type system prevents construction elsewhere | designed |
| T1 | Mid-flight tampering of recipient bps | A3 | Adv1 | `&SplitConfig` immutable for PTB; `version` bump + `expected_version` assertion | designed |
| T2 | Cap held by hot wallet → tampering on withdraw | A2 | Adv1 | Convention: TaxCap/SavingsCap transferred to cold wallet at setup; dashboard warns if held with OwnerCap | UX-level |
| R1 | Deniability of who mutated config | A3 | Adv2 | `ConfigMutated` event records `mutator: tx_context::sender` | designed |
| I1 | Fan addresses on-chain leak audience | A1 | Adv5 | Documented limitation; Seal integration in v2 | accepted (MVP) |
| D1 | DoS via 10k-recipient config | A1 | Adv1 | `MAX_RECIPIENTS = 16` constant; assert on create + mutate | designed |
| D2 | DoS via Scallop revert blocking splits | A1 | Adv4 | **No in-Move fallback** (Move has no try/catch) — Scallop abort reverts the whole PTB. Mode A: client retries with `include_yield=false`. Mode B (v1): yield decoupled to a sweep tx, off the payment path. See spec §7. | designed |
| D3 | Shared-object contention on hot vaults | A1 | — | Per-creator vaults aren't globally hot, but every `execute_split` takes `&mut` on both TaxVault+SavingsVault → single-creator payments serialize. Must load-test (spec §11); shard/fast-path mitigation deferred to v1. | accepted, pending load test |
| E1 | Cap reuse across vaults to drain wrong vault | A2 | Adv1 | Each Cap stores target `vault_id`; asserted on use | designed |
| E2 | Integer overflow in bps × amount | A1 | Adv3 | Compute in `u128`, downcast with assert | designed |
| E3 | Recipient list mutation to add attacker before split | A1 | Adv1 | Requires OwnerCap; mitigated by Cap separation + version check | designed |
| E4 | Collab bps cut to 0 without consent | A3 | Adv1 | v1: `RecipientLockCap` k-of-n required to decrease | v1 |
| E5 | Protocol skims creators via inflated `protocol_fee_bps` | A1 | Adv6 (protocol/AdminCap holder) | `protocol_fee_bps` bounded by `ProtocolConfig.[min,max]_fee_bps`; bound changes need `AdminCap`, are on-chain observable; creators read before signing | designed |

## Open security work
- Run `sui-security-guard` static scan post-implementation.
- Run `sui-red-team` adversarial test generation on `router::execute_split` and `vaults::withdraw_*`.
- External audit before mainnet (post-hackathon).

## Accepted risks (MVP)
- Fan-address leakage (mitigated by Seal in v2).
- Single-deployer UpgradeCap (mitigated by multisig before mainnet).
- Indexer is centralized (us).
