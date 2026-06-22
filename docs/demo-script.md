# SuiSieve — Demo Script (5 min)

> Track: DeFi-Payments · Network: Sui testnet (real Circle USDC) · Package `0xe16643b1…`
> Timing: **1 min slides → 3 min live demo → 1 min future vision**. British English throughout.

---

## Part 1 — Slides (1 minute)

> One slide, three beats. Speak to the slide; don't read it.

**Slide title: SuiSieve — programmable revenue splitting for creators**

**Beat 1 — The problem (~20s)**
"Every creator with collaborators has the same monthly chore. A payment lands, and now
someone has to manually split it — pay the editor, the co-writer, set aside tax, move a
bit into savings. It's spreadsheets, trust, and human error. And idle savings just sit
there earning nothing."

**Beat 2 — The solution (~25s)**
"SuiSieve turns that whole routine into one on-chain rule. A creator defines a *split
config* once — recipients, a tax set-aside, a savings pot, the protocol fee, and an
optional yield strategy. After that, any incoming USDC payment is split **atomically in a
single transaction**: every collaborator paid, tax and savings vaulted, fee taken — with
the maths fully conserved, down to zero dust. Savings can then earn yield on-chain and be
redeemed on demand."

**Beat 3 — Why Sui (~15s)**
"This is built the Sui way. Each vault is guarded by its own *capability* object, so a
compromise of one never cascades — and reusing the wrong capability is rejected at the
**type level**, before execution. It's a full stack: Move contracts, a Rust indexer, a
REST API, and a Next.js dashboard. All of it is live on testnet with real Circle USDC."

---

## Part 2 — Live Demo (3 minutes)

> Pre-flight (before you start screen-sharing — do NOT show this):
> - `docker start creatorflow-pg` (Postgres :5433)
> - indexer: `cd indexer/creatorflow-indexer && ./target/release/creatorflow-indexer --remote-store-url https://checkpoints.testnet.sui.io`
>   (bump the watermark to tip-1 first so the dashboard updates live)
> - api: `cd api/creatorflow-api && node --env-file=.env --import tsx src/server.ts` (:3101)
> - web: `cd web/creatorflow-web && pnpm exec next dev -p 3100` (:3100)
> - Wallet (Slush) on the demo owner address, with testnet Circle USDC.
> - Have a second terminal ready for the capability-defence script.

### Scene 1 — Connect & the config (~35s)
1. Open the dashboard at `http://localhost:3100`, connect the wallet.
2. "Here's a creator's account. This split config pays two collaborators, sets aside tax
   and savings, and takes a 30 bps protocol fee." Point at the recipients and the vaults.
3. "Everything you see is read back through our own indexer — not the explorer. Chain →
   Rust indexer → Postgres → REST → this dashboard."

### Scene 2 — Atomic split (~50s) ⭐ headline
1. Enter a **1 USDC** payment, run the split. Sign in the wallet.
2. While it confirms: "One transaction. The contract floors each share by basis points in
   u128 to avoid overflow, and the **last recipient absorbs the rounding dust** — so the
   gross is conserved exactly. No leftover, no leak."
3. Show the vault balances tick up in real time as the indexer ingests the event.
   "8970 bps to payouts, 50000 to tax, 50000 to savings, 3000 fee — sums to exactly
   1,000,000. Zero dust."

### Scene 3 — Capability defence (~45s) ⭐ the Sui moment
1. Switch to the terminal: `cd web/creatorflow-web && npx -y tsx scripts/cap-defense-demo.mts`
2. "This is read-only — it *simulates* transactions, no gas, no signing. It takes this
   creator's TaxCap and tries to drain a **different** config's TaxVault."
3. Show the result: `EWrongCap` — rejected. "Cross-vault capability reuse is impossible.
   The contract checks `cap.vault_id == vault.id`, and Sui's type system makes the
   capability un-forgeable. The cap's own vault? Accepted. This is access control that an
   account-based chain simply can't express this cleanly."

### Scene 4 — Yield round-trip (~50s)
1. Switch to the config that holds a live yield position (Task 7 config `0x367fe45…`).
2. "Savings don't sit idle. They're deposited into an on-chain lending venue, accruing
   interest by the clock." Show the position value.
3. Trigger redeem (or show the verified result): "We deposited **8.9 USDC** and redeemed
   **8.95** — the interest was paid on-chain, verified. And critically: principal liveness
   is absolute. Interest is best-effort; your principal redemption can never be bricked by
   an empty interest buffer."

> Fallback if anything is flaky live: every one of these is a confirmed testnet
> transaction — show the digest on the explorer instead. Split `4tDa2oma…`,
> yield deposit→redeem in move-notes. Never claim a step that didn't run.

---

## Part 3 — Future Vision (1 minute)

"What you saw is the MVP, and it's already a full stack on testnet. Three directions from here.

**One — real yield, real partners.** Today savings earn through our own lending venue.
Next is plugging into native protocols like Scallop the moment they expose a Circle-USDC
reserve, so creators earn at market rates without changing a thing.

**Two — frictionless onboarding.** zkLogin and sponsored gas, so a creator signs in with
Google and never sees a seed phrase or a gas prompt. The architecture already accounts for
both paths — wallet and zkLogin.

**Three — payments that come to you.** Stateless pay-links and Stripe-on-Sui, so a fan or a
platform pays a URL and the split just happens. Combine that with stronger custody —
multi-sig on the admin and upgrade capabilities before mainnet — and you have programmable,
trust-minimised revenue infrastructure for the entire creator economy.

SuiSieve: define the rule once, and let every payment split itself. Thank you."

---

## Cheat-sheet (numbers to have memorised)
- Split conservation: payout 897000 + tax 50000 + savings 50000 + fee 3000 = **1,000,000**, zero dust.
- Fee window: **[30, 100] bps** (enforced on-chain; fee=0 aborts `EFeeOutOfBounds`).
- Yield round-trip: deposit **8.9** → redeem **8.95** USDC.
- Max recipients: **16** (gas-grief guard).
- Load test: 10/50/150/350 fan — **0 congestion, 0 lock leakage**; plateau was RPC throttling, not the contract.
- Move tests: **76/76**, 0 warnings. Frontend: 52 vitest, tsc clean.
- Stack: Move → Rust indexer (`sui-indexer-alt-framework`) → Postgres → Hono REST → Next.js + dApp Kit.
