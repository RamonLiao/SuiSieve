# CreatorFlow

**One-line pitch**: Subscription/creator income wallet that auto-splits every incoming payment into tax, team, savings, and yield via a single PTB.

**Problem it solves**: Creators and indie SaaS founders receive lumpy revenue and manually juggle tax reserves, team payouts, and savings/investing across banks and protocols.

**Core mechanism**:
- Creator configures a Split object: % rules per destination (tax vault, team wallets, savings, yield vault).
- Every incoming stablecoin payment triggers a PTB: receive → split → route to vault / wallet / DeFi position atomically.
- Capability (`Cap`) objects gate withdrawals — Move type system prevents unauthorized drains.
- One-tap fiat off-ramp for personal slice.

**Why this track**:
- Textbook "payment that auto-invests" + "salary that streams and earns yield" from HANDBOOK.
- Strong "Novel use of PTBs" and "Composability across components" (top-tier add).
- "Correct asset/ownership handling" via Cap objects — showcases Move type safety.
- Clear "Real-world applicability" — creator economy is a legible market.

**Win probability**: 85/100. Smallest feasible scope with maximum protocol depth. Loses a few points to RedPacket on viral demo punch.

**Key risks**:
- 0xSplits / MoveFlow exist — must differentiate via Cap-based security + yield integration.
- Yield integration (Scallop/Navi) adds dependency risk during hackathon.
- B2C creator acquisition story is hand-wavy without a design partner.

**Required Sui primitives**: PTB, Move objects + Capability pattern, stablecoin, Scallop/Navi vaults (optional), zkLogin for creator onboarding, optional MoveFlow-style streaming.

**MVP scope**:
1. Move module: SplitConfig + Cap + execute_split PTB.
2. Web dashboard: configure splits, view history.
3. Demo flow: simulated subscription payment → atomic 4-way split → yield deposit.
4. Show Cap object preventing unauthorized withdrawal attempt.
5. Bonus: integrate one real yield protocol (Scallop) on testnet.
