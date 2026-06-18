# Indexer Phase 1 — `ConfigCreated` Event Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `ConfigCreated` event emitted by `router::create_config_and_vaults` so the off-chain indexer can discover new configs and map vault→config.

**Architecture:** New `ConfigCreated` struct + `public(package)` emit fn in the existing `events` leaf module (does not break events-as-leaf topology). `router::create_config_and_vaults` emits it after `wire_vaults`, sourcing all IDs **directly from the freshly-built objects** (not from the config's stored vault-id fields) so there is no dependency on wiring order. Fields: `{config_id, tax_vault_id, savings_vault_id, owner}` — no bps snapshot (bps are mutable via `mutate_config`; point-in-time bps is reconstructed from `SplitExecuted.config_version` + `config_mutated` history).

**Tech Stack:** Sui Move 2024 edition, `sui move test`.

**Spec:** `docs/superpowers/specs/2026-06-15-indexer-design.md` → "Required contract change (Move)".

**Prereq context:** Existing suite is 58/58 PASS. Move review rule: after coding, run `move-code-quality` → `sui-security-guard` (NOT generic reviewer) per `.claude/rules/skill-routing.md`. `ConfigCreated` is a small additive change to non-core data plumbing; `sui-red-team` optional (no new fund-moving logic).

---

### Task 1: Add `ConfigCreated` event + emit fn to `events` module

**Files:**
- Modify: `move/creatorflow/sources/events.move` (add struct after `VaultWithdrawn` ~line 83; add emit fn after `emit_vault_withdrawn` ~line 145)
- Test: `move/creatorflow/tests/events_tests.move`

- [ ] **Step 1: Write the failing test**

Add to `move/creatorflow/tests/events_tests.move` (after `emit_config_mutated_emits_one_event`):

```move
/// emit_config_created produces exactly one user event. Mints a throwaway UID
/// for each ID arg (we only need valid `ID`s, not live objects).
#[test]
fun emit_config_created_emits_one_event() {
    let mut scenario = ts::begin(CREATOR);
    ts::next_tx(&mut scenario, CREATOR);
    {
        let ctx = ts::ctx(&mut scenario);
        let u1 = object::new(ctx);
        let u2 = object::new(ctx);
        let u3 = object::new(ctx);
        events::emit_config_created(
            u1.to_inner(),  // config_id
            u2.to_inner(),  // tax_vault_id
            u3.to_inner(),  // savings_vault_id
            CREATOR,        // owner
        );
        u1.delete();
        u2.delete();
        u3.delete();
    };
    let effects = ts::next_tx(&mut scenario, CREATOR);
    assert!(ts::num_user_events(&effects) == 1, 0);
    ts::end(scenario);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd move/creatorflow && sui move test emit_config_created`
Expected: FAIL — compile error, `emit_config_created` is unbound.

- [ ] **Step 3: Add struct + emit fn to `events.move`**

Add the struct after the `VaultWithdrawn` struct (after ~line 83):

```move
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
```

Add the emit fn after `emit_vault_withdrawn` (after ~line 145):

```move
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd move/creatorflow && sui move test emit_config_created`
Expected: PASS (1 test).

- [ ] **Step 5: Commit** (skip if not a git repo — see note at end)

```bash
git add move/creatorflow/sources/events.move move/creatorflow/tests/events_tests.move
git commit -m "feat(events): add ConfigCreated event for indexer config discovery"
```

---

### Task 2: Emit `ConfigCreated` from `router::create_config_and_vaults`

**Files:**
- Modify: `move/creatorflow/sources/router.move:75-87` (inside `create_config_and_vaults`, after `wire_vaults`, before/around the transfers & shares)
- Test: `move/creatorflow/tests/router_tests.move`

- [ ] **Step 1: Write the failing test**

Add to `move/creatorflow/tests/router_tests.move` (after `create_wires_everything_and_binds_caps`, ~line 101). This inlines the create call (the `create` helper swallows the create-tx effects) to capture and assert the event count:

```move
/// create_config_and_vaults emits exactly one user event: the ConfigCreated the
/// indexer needs to register the config. (Protocol init + set_treasury are
/// event-silent, so a clean create tx has exactly one emitted event.)
#[test]
fun create_emits_config_created_once() {
    let mut sc = ts::begin(CREATOR);
    init_protocol(&mut sc);

    let protocol = sc.take_shared<ProtocolConfig>();
    router::create_config_and_vaults(
        &protocol,
        standard_recipients(),
        500, 450, 50, 400,
        strategy(),
        sc.ctx(),
    );
    ts::return_shared(protocol);
    let eff = sc.next_tx(CREATOR);

    assert_eq!(ts::num_user_events(&eff), 1);
    sc.end();
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd move/creatorflow && sui move test create_emits_config_created_once`
Expected: FAIL — `assert_eq!` fires, `num_user_events == 0` (router does not emit yet).

- [ ] **Step 3: Add the emit call in `router.move`**

In `create_config_and_vaults`, the block currently reads (lines ~73-87):

```move
    let (tax_vault, tax_cap) = vaults::new_tax_vault(config_id, ctx);
    let (savings_vault, savings_cap) = vaults::new_savings_vault(config_id, ctx);
    split_config::wire_vaults(
        &mut config,
        object::id(&tax_vault),
        object::id(&savings_vault),
    );

    let creator = ctx.sender();
    transfer::public_transfer(owner_cap, creator);
    transfer::public_transfer(tax_cap, creator);
    transfer::public_transfer(savings_cap, creator);
    split_config::share(config);
    vaults::share_tax(tax_vault);
    vaults::share_savings(savings_vault);
```

Insert the emit immediately after `wire_vaults` (IDs sourced directly from the
objects, so wiring order is irrelevant to correctness — placed here as belt-and-
suspenders):

```move
    let (tax_vault, tax_cap) = vaults::new_tax_vault(config_id, ctx);
    let (savings_vault, savings_cap) = vaults::new_savings_vault(config_id, ctx);
    split_config::wire_vaults(
        &mut config,
        object::id(&tax_vault),
        object::id(&savings_vault),
    );

    let creator = ctx.sender();
    events::emit_config_created(
        config_id,
        object::id(&tax_vault),
        object::id(&savings_vault),
        creator,
    );
    transfer::public_transfer(owner_cap, creator);
    transfer::public_transfer(tax_cap, creator);
    transfer::public_transfer(savings_cap, creator);
    split_config::share(config);
    vaults::share_tax(tax_vault);
    vaults::share_savings(savings_vault);
```

Note: `events` is already imported in `router.move` (line 20) — no new `use` needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd move/creatorflow && sui move test create_emits_config_created_once`
Expected: PASS.

- [ ] **Step 5: Run the FULL suite to confirm no regression**

Run: `cd move/creatorflow && sui move test`
Expected: `Test result: OK. Total tests: 60; passed: 60` (58 prior + 2 new).

Note: `create_wires_everything_and_binds_caps` does NOT assert event count, so the
added emission does not break it. If any execute_split test asserted
`num_user_events` on a *create* tx it would break — none do (they assert on the
execute_split tx, a separate tx boundary).

- [ ] **Step 6: Commit** (skip if not a git repo)

```bash
git add move/creatorflow/sources/router.move move/creatorflow/tests/router_tests.move
git commit -m "feat(router): emit ConfigCreated on config provisioning"
```

---

### Task 3: Move code review (mandatory, per skill-routing)

**Files:** none (review only)

- [ ] **Step 1: Run move-code-quality**

Invoke the `move-code-quality` skill against the diff (events.move + router.move).
Expected: 0 critical / 0 warning. The change is additive `copy,drop` event + one
emit call — no new abilities, no storage struct, no fund movement.

- [ ] **Step 2: Run sui-security-guard**

Invoke `sui-security-guard` on the same diff.
Expected: no findings. Verify specifically: emit is `public(package)` (not `public`)
so external forgery of `ConfigCreated` is impossible (same guarantee as the other
events — indexer trust depends on it).

- [ ] **Step 3: Fix any findings, re-run `sui move test`, confirm 60/60**

If either skill flags something, fix inline and re-run `cd move/creatorflow && sui move test`.
Expected: 60/60 PASS.

---

### Task 4: Update notes

**Files:**
- Modify: `move-notes.md`
- Modify: `tasks/progress.md`

- [ ] **Step 1: Append to `move-notes.md`**

Add a dated section recording: ConfigCreated added (fields, why no bps snapshot,
why IDs sourced from objects = no wiring-order dependency, public(package) emit),
suite 58→60, the indexer-design.md cross-reference.

- [ ] **Step 2: Update `tasks/progress.md`**

Mark the Move-side prereq for the indexer done; note Rust ingest + TS API are the
next two plans (authored against the installed `sui-indexer-alt-framework` crate).

- [ ] **Step 3: Commit** (skip if not a git repo)

```bash
git add move-notes.md tasks/progress.md
git commit -m "docs: record ConfigCreated event + indexer phase-1 progress"
```

---

## Self-Review (completed by plan author)

- **Spec coverage:** "Required contract change (Move)" section of the design →
  Tasks 1-2 (struct, emit fn, router wiring, no-bps-snapshot, emit-after-wire).
  Testing strategy "Move" bullet → Tasks 1-2 tests + Task 3 review. ✓
- **Placeholder scan:** All steps carry real Move code + exact commands. ✓
- **Type consistency:** `emit_config_created(config_id, tax_vault_id,
  savings_vault_id, owner)` signature identical across Task 1 (definition + test)
  and Task 2 (call site). `ConfigCreated` field names match the struct in Task 1. ✓

## Git note

This directory is currently NOT a git repository (`git rev-parse` fails). Skip all
`git commit` steps, OR run `git init` first if version control is wanted. Commits
are not required for the tasks to be verifiable (`sui move test` is the gate).
