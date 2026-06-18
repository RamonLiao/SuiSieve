# CreatorFlow — Business Specification

> Track 1: DeFi & Payments · Sui Overflow 2026
> One-liner: **Programmable creator income wallet — every incoming payment auto-splits into tax, collaborators, savings, and yield in a single PTB, with Capability-gated withdrawals.**

> Research caveat: Web2 platform fee/payout figures and Goldman Sachs creator-economy data verified via Gemini (2026-05) with sources cited inline. SUI-ecosystem claims previously flagged as unverified (MoveFlow capability-gated split, Endow chain, canonical Sui subscription standard, creator tax-shock stat) have been rewritten as documented honest statements — absence of a public source is now stated explicitly rather than tagged. Competitor URLs reproduced from `Tracks/1-DeFi-Payments/REPORT.md` (user-verified) are unflagged.

---

## 1. Executive Summary

CreatorFlow turns a creator's wallet into a **programmable revenue router**. A creator (YouTuber, indie SaaS founder, OnlyFans creator, musician) configures one on-chain `SplitConfig` object that describes how every incoming USDC payment should be carved up: X% to tax reserve, Y% to each collaborator wallet, Z% to a savings vault, W% deposited into a Sui-native yield protocol (Scallop / Navi / NAVI vaults). Every payment that hits the inbox triggers a single Programmable Transaction Block (PTB) that atomically performs receive → split → route → yield-deposit. Withdrawals from the tax and savings vaults are gated by `Capability` objects whose ownership is enforced by Move's type system, eliminating the "I gave my manager the password" attack surface that plagues Web2 creator finance.

The wedge is small and shippable in 6 weeks (one Move module + dashboard + one yield integration), the market is legible (creator economy + crypto payouts), and the technical story aligns with Sui's three judging differentiators: **novel use of PTBs**, **correct asset/ownership handling via objects + capabilities**, and **excellent UX for complex financial actions**. Target outcome: 2nd-place finish in Track 1 with a clear v1 path to a real B2B2C product serving MCNs and creator-collective DAOs.

---

## 2. Problem Statement

Creator income is **lumpy, multi-party, and tax-hostile**, but the financial plumbing creators use is built for salaried W-2 workers.

**Evidence (Web2 pain points)**:
- Patreon (post-Aug 2025) charges a flat **10% platform fee + Stripe processing (2.9% + $0.30 standard, 5% + $0.10 for ≤$3)**; monthly payouts on the 5th, 1–5 business days to bank; chargeback window 60 days; iOS-purchase funds held 75 days. [source: Patreon Pricing & Help Center, 2025–2026, https://www.patreon.com/pricing]
- OnlyFans takes a flat **20%** (creator keeps 80%); 7-day pending hold then daily/weekly/monthly auto-payout; international creators incur 3–7% FX/wire fees. [source: OnlyFans Terms of Service, 2026, https://onlyfans.com/terms]
- Twitch is contractually **net-45** but typically pays on the 15th of the following month (net-15 practical); revenue share is 50/50 default, 60/40 or 70/30 under the Plus program tiers. [source: Twitch Monetized Streamer Agreement, April 2026, https://www.twitch.tv/p/en/legal/monetized-streamer-agreement/]
- Substack takes **10% + Stripe 2.9% + $0.30 + 0.7% recurring billing fee**; revenue splits with co-writers must be done manually off-platform. [source: Substack Support + Stripe Pricing, 2026, https://support.substack.com/]
- A 2023 Goldman Sachs report projects the creator economy reaches **~$480B by 2027**; cross-source estimates put **30–50M creators earning meaningful income**, with **~2–4% earning >$100k/year**. Tax under-withholding is anecdotally the most-cited cash-flow shock among 6-figure creators — no rigorous industry survey quantifying this was found. [source: Goldman Sachs Research, 2023, https://www.goldmansachs.com/insights/pages/the-creator-economy-could-approach-half-a-trillion-dollars-by-2027.html; Influencer Marketing Hub Creator Earnings Report, 2025]

**Evidence (Web3 gaps)**:
- 0xSplits (EVM) handles revenue split but is **pull-based**: recipients must claim, gas is paid by the recipient, and splits do not compose with yield deposits in a single tx.
- Superfluid streams require pre-funded buckets and don't natively split a one-off incoming payment into N destinations.
- MoveFlow on Sui offers streaming; capability-gated multi-destination split is not documented in MoveFlow public docs as of 2026-05 [source: moveflow.xyz/docs accessed 2026-05].
- No mainstream tool combines **revenue split + automatic tax sequestration + yield deposit + capability-based withdrawal control** in one atomic transaction.

The underlying problem: creators outsource trust (to platforms, accountants, managers) because the tools to encode that trust in code are missing. CreatorFlow encodes it.

---

## 3. Target Users & Personas

### Persona A — "Maya the Music Creator" (Primary)
Indie musician, 120k monthly listeners, releases collaborative singles. Income arrives in 5–20 lumps/month from streaming aggregators, sync licenses, merch, and direct fan tips. Pain: every release she manually Venmos co-writers and producers their shares, and forgets to set aside ~30% for self-employment tax. **Wants**: paste a wallet address + %, get paid forever without thinking about it.

### Persona B — "Daniel the Indie SaaS Founder" (Primary)
Solo founder of a $12k MRR Stripe-billed SaaS. Has two contractor developers on 10%/5% revenue share. **Pain**: end-of-month reconciliation, contractor invoicing, quarterly estimated taxes, idle cash in Mercury earning 0.0%. **Wants**: incoming USDC → contractors paid + tax bucket filled + remainder deposited to a yield vault, all atomic.

### Persona C — "Lin the Collaborator/Ghostwriter" (Secondary)
Co-writes courses with creators; gets paid revenue-share but constantly chases creators for late payouts. **Wants**: protocol-level guarantee that her % is paid the instant the creator is paid, without trusting the creator's "I'll get to it Friday."

### Persona D — "Akira the Superfan" (Secondary)
Pays $20/mo to support 6 creators. **Pain**: doesn't know which creator gets how much (platform takes 10–20%). **Wants**: see on-chain proof that her sub went to the creator and collaborators, not the platform.

### Persona E — "MCN Operator" (v2 / B2B2C)
Manages 40 mid-tier creators. **Wants**: deploy CreatorFlow to each creator as a managed service; collect 2% routing fee; offer "instant advance" credit underwritten by the on-chain split history.

---

## 4. Use Cases

### UC-1 — Band Royalty Split (Maya)
4-person band. Maya configures one SplitConfig: 25% each to bandmates' wallets, 25% reserved for tax vault, 0% to yield (small balances). Spotify aggregator pays $4,200 USDC into the inbox. Single PTB fires: 4 transfers + 1 vault deposit, all atomic. Each bandmate's wallet ticks up in the same block. Demo screenshot: 5 object mutations in one tx.

### UC-2 — Subscription Creator (OnlyFans-style)
Maya runs a $20/mo paid Telegram. 350 fans subscribe via a Sui Pay link (zkLogin onboarding). Each $20 payment triggers a split: 70% Maya personal wallet, 20% savings vault, 10% Scallop USDC yield deposit. Fans see on-chain proof their full $20 went to the creator side (no 20% OnlyFans cut). Optional: the savings vault is a separate Move object whose `WithdrawCap` Maya can mail to her accountant for end-of-year tax filing without ever exposing the principal.

### UC-3 — Ghostwriter / Course Co-Author (Lin)
Daniel hires Lin to ghostwrite a $499 course. SplitConfig: 60% Daniel, 30% Lin, 10% tax. Every Stripe-on-Sui sale fires the split. Lin gets paid in the same transaction as Daniel — no trust required, no invoice chasing. Lin's share is enforced by Move's resource model: Daniel cannot mutate the SplitConfig's allocations without burning a co-signed `MutationCap` that Lin co-holds.

### UC-4 — Creator Collective DAO (v2)
A 12-person YouTube collective shares a brand sponsorship deal. Sponsor wires $50k USDC. The SplitConfig is a shared object whose mutation requires k-of-n multisig (Sui native multisig). PTB: 12 transfers + 1 DAO treasury deposit + 1 yield position open, atomic.

### UC-5 — Tax-Aware Auto-Save (Daniel)
Daniel's quarterly estimated taxes are calculated by a tiny off-chain helper that updates an oracle object with his current marginal rate. The SplitConfig reads the oracle, sets tax % dynamically (e.g. 28% in Q1, 32% in Q4 as he crosses brackets). PTB enforces the rate at execution time — no human override possible.

---

## 5. Market Analysis

### TAM / SAM / SOM

- **TAM (Creator Economy 2025)**: Goldman Sachs (2023) projected the creator economy reaches **$480B by 2027**. Of that, ~$150B is direct creator income flows (subs, tips, sponsorships, course sales) that a payment router could touch.
- **TAM (Crypto Payments 2025)**: Stablecoin annual settled volume crossed **~$10T in 2024** (Visa Onchain Analytics, Allium). Creator/SMB segment is **<1%** today but growing.
- **SAM**: Creators earning >$10k/year estimated **30–50M globally** (creator middle class, ~15–27% of monetized creators). [source: Influencer Marketing Hub Creator Earnings Report, 2025; Goldman Sachs, 2023]. Conservatively assume 2M are crypto-reachable in the next 3 years × $40k avg annual revenue routed ≈ **$80B/year** SAM of revenue flows.
- **SOM (3-year hackathon → product)**: 5,000 paying creators × $30k avg routed × 0.5% take rate = **$750k ARR** by year 3. Realistic for an indie team.

### Competitive Table

| Product | Chain | Split? | Yield? | Capability-gated? | Atomic in 1 tx? | Pull or push? | Fees |
|---|---|---|---|---|---|---|---|
| **CreatorFlow** | Sui | ✅ | ✅ (Scallop/Navi) | ✅ Move Cap | ✅ PTB | Push | 0.3–0.5% take rate (target) |
| 0xSplits | EVM | ✅ | ❌ | ❌ (allowlist) | ❌ (claim model) | Pull | Free, recipient pays gas |
| Superfluid | EVM | Partial (streams) | ❌ | ❌ | ✅ (stream-level) | Push (stream) | ~0.5% |
| Sablier | EVM | ❌ (single recipient) | ❌ | ❌ | ✅ | Push (stream) | Free |
| MoveFlow | Sui | Streaming only (multi-destination split not documented as of 2026-05) | ❌ | ❌ | ✅ | Push (stream) | n/a |
| Endow | Chain not publicly confirmed (no authoritative source found 2026-05) | ✅ + credit | ❌ | ❌ | ❌ | Push | n/a |
| Patreon | Web2 | Manual | ❌ | n/a | ❌ | Pull | 8–12% all-in |
| Stripe Connect | Web2 | ✅ (split charges) | ❌ | ❌ | ❌ | Push | 2.9% + $0.30 + 0.25%/recipient |

**Where CreatorFlow wins**: only product that combines **multi-recipient split + same-block yield deposit + capability-gated withdrawal**, and only one to push (not pull) so recipients pay no gas and need no on-chain action to receive.

---

## 6. Differentiation — Sui PTB & Capability Advantage

Three Sui-native primitives unlock features competitors structurally cannot replicate cheaply.

**(a) PTBs let one payment do N things atomically.** A creator's incoming USDC payment, in one transaction, can: (1) split into 5 recipient wallets, (2) deposit a slice into a Scallop USDC lending vault, (3) update an on-chain accounting object that fans can read, (4) mint a "thank-you receipt" NFT to the payer. On EVM this is 4–5 separate transactions or a complex relayer/multicall. PTBs make atomicity the default.

**(b) Capability objects encode "who may withdraw" at the type level.** The tax-reserve vault holds `Coin<USDC>` but exposes only `withdraw(cap: &TaxCap, amount): Coin<USDC>`. `TaxCap` is an owned object Maya keeps in cold storage; if her hot wallet is drained, the tax vault remains untouchable. EVM equivalents rely on EOA address checks, which are vulnerable to private-key compromise. This is the **"Correct asset/ownership handling"** judging criterion in concrete code.

**(c) Object-centric accounting = composable analytics.** Each SplitConfig and each historical execution emits structured events keyed by creator object ID. An MCN (v2 persona) can index these to underwrite creator credit advances without proprietary data. On Sui this is free; on EVM it requires The Graph + custom subgraph per creator.

Pair with **Sponsored Transactions** so the *creator pays gas for the entire flow* (fans send gasless), and **zkLogin** so a Substack creator can onboard via Google in 30 seconds without ever seeing a seed phrase. Both are documented Sui primitives [source: docs.sui.io sponsored-transactions, sui.io/zklogin]; integrated UX is design-stage.

---

## 7. Product Scope

### MVP (Hackathon, 6 weeks)
- Move module: `SplitConfig` (shared object), `TaxCap` / `SavingsCap` (owned objects), `execute_split(payment: Coin<USDC>, config: &SplitConfig): vector<TransferEvent>` PTB-friendly function.
- Web dashboard (Next.js + dApp Kit): connect wallet, create SplitConfig, view split history, simulate incoming payment.
- One real yield integration: Scallop USDC supply (testnet).
- Demo path: simulated subscription payment → 4-way atomic split → yield deposit → "unauthorized withdrawal" attempt rejected by Move type system.
- zkLogin onboarding for creator side.

### v1 (Post-hackathon, 3 months)
- Mainnet deployment + Sponsored Transactions for fan-side payments.
- Pay-link generator (`creatorflow.app/pay/maya`) — fan clicks, signs once.
- Mutation governance: k-of-n approvals for changing splits (protects collaborators).
- Fiat off-ramp via a partner (Bridge, Stripe Crypto, or Transak).
- Tax-rate oracle adapter (manual or accountant-signed).

### v2 (12 months)
- MCN/agency dashboard (B2B2C): manage N creators, charge 1–2% routing.
- On-chain credit / instant advance underwritten by historical split flow (PayFi narrative — pairs with Huma).
- Cross-chain inbox via Wormhole (accept ETH-USDC, settle on Sui).
- Subscription primitive (recurring pull authorization, EIP-5643-equivalent on Sui).
- Streaming hybrid: large lump payments stream-distribute over N days using MoveFlow integration.

### Explicit non-goals
- Building a creator content platform (we route money, not content).
- Custodying creator funds (non-custodial only).
- Issuing our own stablecoin or token at MVP.

---

## 8. User Flow

**Creator onboarding (Maya)**:
1. Visit dApp → "Sign in with Google" (zkLogin) → Sui address derived.
2. Wizard: "Add a collaborator" → paste address + %. Repeat. Allocate tax % and yield %.
3. Sign one transaction → `SplitConfig` shared object created, `TaxCap` + `SavingsCap` minted to creator.
4. dApp generates a payment link + QR code.

**Fan payment (Akira)**:
1. Click `creatorflow.app/pay/maya` → choose $5 / $20 / custom.
2. Connect wallet OR pay with credit card (v1 fiat ramp).
3. Sign one tx; PTB executes split. Receipt page shows: "Your $20 became: $4 → Producer Bob, $4 → Drummer Sue, $4 → Mixer Lin, $5 → Maya, $3 → Tax vault. View on Sui Explorer."

**Collaborator (Lin)**:
1. Receives notification (email via off-chain indexer or wallet push).
2. Sees USDC arrive — no action required. Pulls history from her wallet's tx log.

**Withdrawal (Maya, tax vault, end of year)**:
1. Open dashboard → "Withdraw from tax vault."
2. Sign with hot wallet → tx fails (no Cap). Plug in hardware wallet holding `TaxCap` → tx succeeds. UX message explains the Cap model in one sentence.

---

## 9. Technical Architecture Summary

**Move objects (3 core types)**:
- `SplitConfig` — shared object. Fields: `owner: address`, `recipients: vector<Recipient>`, `tax_vault_id: ID`, `savings_vault_id: ID`, `yield_strategy: Option<StrategyRef>`, `mutation_policy: MutationPolicy`. Mutation requires holding `OwnerCap` + (for collaborator-protective configs) k-of-n collaborator signatures.
- `TaxVault` / `SavingsVault` — shared objects holding `Balance<USDC>`. Withdraw functions require `&TaxCap` / `&SavingsCap` references; the caps are owned objects held by the creator (or delegated to accountant).
- `Recipient` — non-object struct: `address`, `bps` (basis points), `label`.

**PTB shape (execute_split)**:
1. Receive incoming `Coin<USDC>` (entry argument or programmable input).
2. Split coin into N+2 sub-coins by bps (recipients + tax + savings).
3. `transfer::public_transfer` each recipient slice to its address.
4. `tax_vault::deposit(&mut TaxVault, tax_coin)`.
5. `savings_vault::deposit(&mut SavingsVault, savings_coin)`.
6. If `yield_strategy` set: call into Scallop/Navi adapter, deposit the yield-slice.
7. Emit `SplitExecuted` event with full breakdown for indexers.

**Capability pattern**:
- `OwnerCap` — owner-only mutation of SplitConfig.
- `TaxCap` / `SavingsCap` — owner-only withdrawal from respective vaults.
- `RecipientLockCap` (v1) — co-held by collaborators; required to *decrease* any collaborator's bps. Move type system makes this unforgeable.

**Off-chain components**:
- Indexer (custom or Mysten's RPC + filtering): subscribe to `SplitExecuted` events for dashboard.
- Pay-link service: stateless URL → unsigned PTB → wallet redirect.
- Fiat ramp adapter (v1).

**Failure modes engineered out**:
- Reentrancy — Move resource model + Sui's PTB linearization makes classical reentrancy impossible.
- Recipient-list mutation race — `SplitConfig` mutation requires explicit cap + version increment; PTB takes immutable reference for the duration of split execution.
- Yield-protocol DoS — yield deposit is the *last* step; if Scallop reverts, the split itself succeeds (yield slice falls back to savings vault). Engineered via PTB ordering, not try/catch.

---

## 10. Business Model

**Take rate**: 0.3% of routed volume (vs 8–20% Web2 platforms). Charged in-PTB as one more split recipient (the protocol treasury). At target $30k/yr/creator × 5,000 creators × 0.3% = **$450k ARR**. Layer (v2) MCN B2B2C @ 1.5% on top.

**Secondary revenue**:
- Yield take: 10% of yield-protocol APY earned on savings vaults sitting in CreatorFlow-deployed vaults (pending negotiated rebate partnership with Scallop/Navi — not yet committed).
- Fiat off-ramp referral fee (50–100bps via Transak/Bridge).
- Premium dashboard / tax export tools at $19/mo for power users.

**Cost structure**:
- Sui gas (negligible at MVP, sponsored at v1 — eats into margin).
- Indexer infra (~$200/mo at MVP).
- Fiat ramp KYC pass-through (variable).

**Unit economics (steady-state, per creator/yr)**: revenue $90–$200, gross margin >80% after gas + indexer.

---

## 11. Go-to-Market

**Phase 1 (Hackathon → Demo Day)**: recruit 3 design-partner creators (1 musician, 1 SaaS founder, 1 course creator) before submission. Their on-chain demo TXs become the pitch.

**Phase 2 (Mainnet launch)**: target small creator collectives and Sui-native communities (Bluefin, Cetus power users who already hold USDC). Niche entry: **on-chain bands & collab podcasts** — small, vocal, network effects.

**Phase 3 (Wedge expansion)**: indie SaaS founders on IndieHackers — they have crypto-native contractors and tax pain. Distribution via Twitter/IH and a referral kickback (recipients also become users when they see incoming CreatorFlow tx).

**Phase 4 (B2B2C)**: pitch MCNs and creator unions a white-label dashboard. Long sales cycle but high TCV.

**Sui-native advantages**: zkLogin lowers Web2 creator onboarding to a Google login. Sponsored TXs let MCNs cover all gas for managed creators.

---

## 12. Hackathon Demo Plan + Judging Mapping

**Demo (4 minutes)**:
1. **Hook (30s)**: "Maya releases a single. Her band normally Venmos each other a week later. Watch this." Trigger a simulated $4,200 USDC payment.
2. **Atomic split (60s)**: Sui Explorer shows one tx, 5 transfers + 1 yield deposit + 1 event, sub-second finality. Mention PTB.
3. **Capability defense (45s)**: Try to withdraw from tax vault with the wrong cap → Move type system rejects. Switch to correct cap → succeeds. Highlight type-level security.
4. **Composability (45s)**: Show the same SplitConfig handling a $20 fan tip — atomic, gas-sponsored, fan sees an instant receipt.
5. **Real adoption (30s)**: show one design-partner creator's live testnet SplitConfig and recent splits.
6. **Close (30s)**: scope, business model, ask.

**Judging mapping (per REPORT.md weights: Real-World 50% / Product & UX 20% / Tech 20% / Presentation 10%)**:
- *Real-World (50%)*: legible market, named personas, design-partner traction, clear take-rate model. Target 45/50.
- *Product & UX (20%)*: zkLogin onboarding, gasless fan path, pay-links, single-tap split. Target 17/20.
- *Tech (20%)*: novel PTB depth (6+ ops atomic), Capability pattern as concrete Move type safety story, optional yield integration, optional Sponsored TX. Target 17/20.
- *Presentation (10%)*: live testnet demo with a real creator. Target 9/10.
- **Composite target: ~88/100**, consistent with REPORT.md's 86 baseline + design-partner upside.

---

## 13. Risks & Mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | MoveFlow / 0xSplits-clone on Sui ships first | Med | High | Wedge on **Cap-gated tax vault + yield deposit in same PTB** — neither competitor combines both. |
| R2 | Yield protocol (Scallop/Navi) testnet instability | Med | Med | Yield deposit is the *last* PTB step; failure does not block split. Fallback: deposit to local SavingsVault. |
| R3 | No real creator design partner by demo day | Med | High | Pre-recruit during weeks 1–2 (offer free service for 12 months + co-marketing). Backup: use real Twitter/IH creators via testnet faucet. |
| R4 | Regulatory: tax-vault feature could be construed as tax advice | Low | Med | Frame as "user-defined allocation," ship no tax-rate recommendations. Get a one-page legal opinion. |
| R5 | UX of Capability objects confuses non-crypto creators | Med | Med | Default policy hides Caps (held by zkLogin'd account); advanced users opt-in to hardware-wallet cap separation. |
| R6 | Chargeback / refund (fiat ramp) — funds already split | Med | Med | v1: hold incoming fiat-rail payments for 24h before triggering split (configurable). MVP: stablecoin-only, no chargebacks. |
| R7 | Take-rate (0.3%) feels invisible vs Patreon (10%), but also weak moat | Med | Med | Moat = capability-based security + on-chain credit underwriting (v2), not fees. |
| R8 | Sponsored TX gas costs eat margin at scale | Low | Med | Pass gas to creator (still <$0.01) until take rate covers it. |

---

## 14. Open Questions

1. **Mutation governance default**: should reducing a collaborator's bps *always* require their cosign, or should the creator have an unconditional "fire the band" override? Trade-off: trust-minimization vs creator autonomy.
2. **Tax-vault custody story**: do we ship a hardware-wallet Cap pattern at MVP, or hide it behind zkLogin until v1? Hiding it weakens the "type-safe ownership" demo.
3. **Yield protocol choice**: Scallop vs Navi vs Suilend at MVP — which has the cleanest integration surface and most stable testnet?
4. **Sponsored TX economics**: does creator-pays-fan-gas hurt creator NPS more than fan-pays-gas hurts fan conversion? Needs A/B test at v1.
5. **Pull-based subscription primitive (v2)**: build native on Sui, or wait for an ecosystem standard? No single canonical Sui subscription standard exists yet; emerging directions include Sui Payment Kit (`PaymentRegistry` / `PaymentIntents`) and x402-style HTTP-native payments. [source: Sui blog & community RFCs, 2025]
6. **B2B2C: who owns the SplitConfig in the MCN case?** Creator (best for trust) vs MCN (best for ops). Likely creator-owned with MCN-held mutation cap; needs validation.
7. **Cross-chain inbox (v2)**: Wormhole vs Sui's own bridges — depends on stablecoin liquidity story 12 months out.
8. **Indexer ownership**: do we run it or rely on a public Sui indexer? Affects margin and SLA.
9. **Fan privacy**: fan addresses appear on-chain alongside creator. For OnlyFans-style creators, is a privacy mode (Seal? zkLogin-derived stealth addresses?) a blocker for adoption?
10. **Pricing experiment**: 0.3% flat vs tiered (0.5% on first $5k/mo, 0.2% above) — which converts the SaaS founder persona better?

---

*Research note*: Web2 platform fees, payout schedules, and Goldman Sachs creator-economy figures verified via Gemini (2026-05). Previously-flagged unverified items (MoveFlow capability-split, Endow chain, Sui canonical subscription standard, creator tax-shock stat) have been rewritten to state the absence of authoritative public sources explicitly; before any external pitch, re-check moveflow.xyz/docs, the Endow project chain, and the latest Sui Payment Kit / SIP RFCs for updates. Competitor URLs and the 86/100 prior-art score are sourced from `Tracks/1-DeFi-Payments/REPORT.md` (user-verified).
