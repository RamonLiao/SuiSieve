# CreatorFlow Web Dashboard (Wallet MVP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a wallet-authenticated creator dashboard for CreatorFlow with full CRUD over the on-chain revenue router (create/edit config, execute split, withdraw/redeem) plus read views (configs, vault balances, split history, earnings).

**Architecture:** Next.js 15 App Router app. Reads go through the existing Hono REST indexer (`api/creatorflow-api`) for history/aggregates and `SuiGrpcClient` for live config/vault state. Writes are PTBs built by pure builder functions and signed via `@mysten/dapp-kit-react` (`useDAppKit().signAndExecuteTransaction`). UI presentational components are delegated to gemini cli against locked prop contracts; all logic (PTB builders, REST client, validators, error mapping, wiring hooks) is authored in-repo.

**Tech Stack:** Next.js 15, TypeScript 5.6 (ESM), pnpm, Tailwind, vitest, `@mysten/sui` (`/transactions`, `/grpc`), `@mysten/dapp-kit-react` + `@mysten/dapp-kit-core`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-18-web-dashboard-design.md` (authoritative).
- App lives at `web/creatorflow-web/`. Package manager: **pnpm**; `package.json` must include `"pnpm": { "onlyBuiltDependencies": ["esbuild"] }` (mirrors api, required for tsx/vitest).
- ESM only (`"type": "module"`). Test runner: **vitest** (`vitest run`). Typecheck: `tsc --noEmit`.
- Chain reads use **`SuiGrpcClient`** from `@mysten/sui/grpc` (JSON-RPC is deprecated); `network: 'testnet'` is **required** on the constructor.
- dApp Kit is **`@mysten/dapp-kit-react`** (`DAppKitProvider`, `useDAppKit`, `useCurrentAccount`, `ConnectButton`) — NOT legacy `@mysten/dapp-kit`/`WalletProvider`.
- `signAndExecuteTransaction` returns a discriminated union: check `result.FailedTransaction` before `result.Transaction`. Never assume try/catch alone surfaces aborts.
- u64 values from REST arrive as **JSON strings**; parse to `bigint`, never `Number`.
- On-chain constants (testnet), centralized in `src/lib/constants.ts`:
  - `PACKAGE_ID = "0x0fda0d5bd9f042460d8ed51eaeaf2fd21e9d4baa74de75b031096516e047a656"`
  - `PROTOCOL_CONFIG_ID = "0x695297e727cd5fa636deff6578b3e5f53aa496ecd323248c1d072b58d9891bcc"`
  - `USDC_TYPE = "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC"`
  - `CLOCK_ID = "0x6"`
  - `MAX_RECIPIENTS = 16`, `BPS_TOTAL = 10000`
- REST base URL from `NEXT_PUBLIC_API_BASE_URL` (default `http://localhost:3001`). REST envelope is `{ data, cursor }` for lists, bare object for detail, `{ error: { code, message } }` for failures.
- gemini-authored files: presentational components under `src/components/ui/` only. Every logic file (builders, hooks, lib) is authored in-repo and reviewed via `/dual-review`.

---

## File Structure

- `web/creatorflow-web/src/lib/constants.ts` — on-chain IDs, types, limits.
- `web/creatorflow-web/src/lib/bps.ts` — bps validation (mirrors contract invariants).
- `web/creatorflow-web/src/lib/abort.ts` — Move abort-code → human message.
- `web/creatorflow-web/src/lib/rest.ts` — typed REST client for the 7 endpoints.
- `web/creatorflow-web/src/lib/chain.ts` — `SuiGrpcClient` read helpers (getConfig, getVault, getUsdcCoins, getOwnerCaps).
- `web/creatorflow-web/src/lib/ptb.ts` — pure PTB builder functions (return `Transaction`).
- `web/creatorflow-web/src/dapp-kit.ts` — `createDAppKit` instance.
- `web/creatorflow-web/src/hooks/useWrite.ts` — write hooks wrapping builders + sign + error map + REST poll.
- `web/creatorflow-web/src/components/ui/*` — gemini presentational components.
- `web/creatorflow-web/src/app/*` — routes (`/`, `/dashboard`, `/config/new`, `/config/[id]`, `/config/[id]/edit`).

---

## Task 1: Scaffold app + constants

**Files:**
- Create: `web/creatorflow-web/package.json`, `tsconfig.json`, `vitest.config.ts`, `next.config.ts`, `tailwind.config.ts`, `postcss.config.mjs`, `src/app/globals.css`, `src/app/layout.tsx`, `src/app/page.tsx`
- Create: `web/creatorflow-web/src/lib/constants.ts`
- Test: `web/creatorflow-web/src/lib/constants.test.ts`

**Interfaces:**
- Produces: all exports from `constants.ts` (`PACKAGE_ID`, `PROTOCOL_CONFIG_ID`, `USDC_TYPE`, `CLOCK_ID`, `MAX_RECIPIENTS`, `BPS_TOTAL`, `API_BASE_URL`, `NETWORK`).

- [ ] **Step 1: Scaffold Next.js + install deps**

```bash
cd web && pnpm create next-app@latest creatorflow-web --ts --tailwind --app --src-dir --no-eslint --use-pnpm --import-alias "@/*"
cd creatorflow-web
pnpm add @mysten/sui @mysten/dapp-kit-react @mysten/dapp-kit-core @tanstack/react-query
pnpm add -D vitest @types/node
```

Then add to `package.json`: `"pnpm": { "onlyBuiltDependencies": ["esbuild"] }`, and scripts `"test": "vitest run"`, `"typecheck": "tsc --noEmit"`.

- [ ] **Step 2: Write constants + failing test**

`src/lib/constants.ts`:

```typescript
export const NETWORK = "testnet" as const;
export const PACKAGE_ID =
  "0x0fda0d5bd9f042460d8ed51eaeaf2fd21e9d4baa74de75b031096516e047a656";
export const PROTOCOL_CONFIG_ID =
  "0x695297e727cd5fa636deff6578b3e5f53aa496ecd323248c1d072b58d9891bcc";
export const USDC_TYPE =
  "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC";
export const CLOCK_ID = "0x6";
export const MAX_RECIPIENTS = 16;
export const BPS_TOTAL = 10_000;
export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";
```

`src/lib/constants.test.ts`:

```typescript
import { expect, test } from "vitest";
import { PACKAGE_ID, USDC_TYPE, BPS_TOTAL } from "./constants";

test("package id is a 0x 32-byte hex", () => {
  expect(PACKAGE_ID).toMatch(/^0x[0-9a-f]{64}$/);
});
test("usdc type is fully-qualified", () => {
  expect(USDC_TYPE).toMatch(/^0x[0-9a-f]{64}::usdc::USDC$/);
});
test("bps total is 10000", () => {
  expect(BPS_TOTAL).toBe(10_000);
});
```

- [ ] **Step 3: Run tests + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS, no type errors.

- [ ] **Step 4: Commit**

```bash
git add web/creatorflow-web && git commit -m "feat(web): scaffold dashboard app + on-chain constants"
```

---

## Task 2: bps validator (mirrors contract invariants)

**Files:**
- Create: `web/creatorflow-web/src/lib/bps.ts`
- Test: `web/creatorflow-web/src/lib/bps.test.ts`

**Interfaces:**
- Consumes: `MAX_RECIPIENTS`, `BPS_TOTAL` from `constants.ts`.
- Produces:
  - `type RecipientInput = { addr: string; bps: number; label: string }`
  - `type SplitDraft = { recipients: RecipientInput[]; taxBps: number; savingsBps: number; feeBps: number; yieldBps: number }`
  - `validateSplit(d: SplitDraft): { ok: true } | { ok: false; error: string }`

- [ ] **Step 1: Write failing tests**

`src/lib/bps.test.ts`:

```typescript
import { expect, test } from "vitest";
import { validateSplit, type SplitDraft } from "./bps";

const base: SplitDraft = {
  recipients: [{ addr: "0x" + "1".repeat(64), bps: 8970, label: "me" }],
  taxBps: 500, savingsBps: 500, feeBps: 30, yieldBps: 0,
};

test("accepts a draft summing to 10000", () => {
  expect(validateSplit(base)).toEqual({ ok: true });
});
test("rejects sum != 10000", () => {
  const r = validateSplit({ ...base, taxBps: 600 });
  expect(r.ok).toBe(false);
});
test("rejects a recipient with 0 bps", () => {
  const r = validateSplit({ ...base, recipients: [{ addr: "0x" + "1".repeat(64), bps: 0, label: "x" }], taxBps: 9470 });
  expect(r.ok).toBe(false);
});
test("rejects > MAX_RECIPIENTS recipients", () => {
  const many = Array.from({ length: 17 }, () => ({ addr: "0x" + "1".repeat(64), bps: 100, label: "x" }));
  const r = validateSplit({ ...base, recipients: many, taxBps: 0, savingsBps: 0, feeBps: 0, yieldBps: 0 });
  expect(r.ok).toBe(false);
});
test("rejects yield > savings", () => {
  const r = validateSplit({ ...base, yieldBps: 600 });
  expect(r.ok).toBe(false);
});
test("monkey: u16 wrap (sum 75536 mod 65536 == 10000) still rejected", () => {
  const r = validateSplit({ ...base, recipients: [{ addr: "0x" + "1".repeat(64), bps: 65536 + 8970 - 1030 - 30, label: "x" }] });
  expect(r.ok).toBe(false); // bps field individually out of u16 range -> rejected
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm test src/lib/bps.test.ts`
Expected: FAIL (validateSplit not defined).

- [ ] **Step 3: Implement**

`src/lib/bps.ts`:

```typescript
import { BPS_TOTAL, MAX_RECIPIENTS } from "./constants";

export type RecipientInput = { addr: string; bps: number; label: string };
export type SplitDraft = {
  recipients: RecipientInput[];
  taxBps: number; savingsBps: number; feeBps: number; yieldBps: number;
};
type Result = { ok: true } | { ok: false; error: string };

const U16_MAX = 65_535;
const isU16 = (n: number) => Number.isInteger(n) && n >= 0 && n <= U16_MAX;

export function validateSplit(d: SplitDraft): Result {
  if (d.recipients.length > MAX_RECIPIENTS)
    return { ok: false, error: `At most ${MAX_RECIPIENTS} recipients` };
  for (const r of d.recipients) {
    if (!/^0x[0-9a-f]{64}$/.test(r.addr))
      return { ok: false, error: `Invalid address: ${r.addr}` };
    if (!isU16(r.bps) || r.bps === 0)
      return { ok: false, error: `Each recipient bps must be 1..${U16_MAX}` };
  }
  for (const [k, v] of Object.entries({ taxBps: d.taxBps, savingsBps: d.savingsBps, feeBps: d.feeBps, yieldBps: d.yieldBps }))
    if (!isU16(v)) return { ok: false, error: `${k} must be 0..${U16_MAX}` };
  if (d.yieldBps > d.savingsBps)
    return { ok: false, error: "yield bps cannot exceed savings bps" };
  const sum = d.recipients.reduce((a, r) => a + r.bps, 0) + d.taxBps + d.savingsBps + d.feeBps;
  if (sum !== BPS_TOTAL)
    return { ok: false, error: `bps must sum to ${BPS_TOTAL} (got ${sum})` };
  return { ok: true };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test src/lib/bps.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add web/creatorflow-web/src/lib/bps.ts web/creatorflow-web/src/lib/bps.test.ts
git commit -m "feat(web): bps validator mirroring contract invariants"
```

---

## Task 3: abort-code → human message mapper

**Files:**
- Create: `web/creatorflow-web/src/lib/abort.ts`
- Test: `web/creatorflow-web/src/lib/abort.test.ts`

**Interfaces:**
- Produces: `mapAbort(rawError: string | null | undefined): string`

- [ ] **Step 1: Write failing tests**

`src/lib/abort.test.ts`:

```typescript
import { expect, test } from "vitest";
import { mapAbort } from "./abort";

test("maps EConfigChanged abort", () => {
  // Move aborts surface as: "...MoveAbort(... router) , 1) ..." or named in newer effects.
  expect(mapAbort("MoveAbort(... ::router::execute_split, EConfigChanged)")).toMatch(/refresh/i);
});
test("maps zero payment", () => {
  expect(mapAbort("... EZeroPayment ...")).toMatch(/greater than 0|> 0/i);
});
test("maps vault mismatch", () => {
  expect(mapAbort("EVaultMismatch")).toMatch(/mismatch/i);
});
test("unknown error passes through trimmed", () => {
  expect(mapAbort("some network error")).toBe("some network error");
});
test("null -> generic", () => {
  expect(mapAbort(null)).toMatch(/failed/i);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm test src/lib/abort.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/lib/abort.ts`:

```typescript
const RULES: Array<[RegExp, string]> = [
  [/EConfigChanged/, "Config changed since you loaded it — refresh and retry."],
  [/EVaultMismatch/, "Vault/config mismatch — wrong vault for this config."],
  [/EZeroPayment/, "Amount must be greater than 0."],
  [/EWrongCap|ETreasury|cap/i, "You are not authorized (missing capability)."],
];

export function mapAbort(rawError: string | null | undefined): string {
  if (!rawError) return "Transaction failed.";
  for (const [re, msg] of RULES) if (re.test(rawError)) return msg;
  return rawError.trim();
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test src/lib/abort.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add web/creatorflow-web/src/lib/abort.ts web/creatorflow-web/src/lib/abort.test.ts
git commit -m "feat(web): Move abort-code to human-message mapper"
```

---

## Task 4: REST client

**Files:**
- Create: `web/creatorflow-web/src/lib/rest.ts`
- Test: `web/creatorflow-web/src/lib/rest.test.ts`

**Interfaces:**
- Consumes: `API_BASE_URL`.
- Produces:
  - `type Page<T> = { data: T[]; cursor: string | null }`
  - `listConfigs(owner: string, cursor?: string): Promise<Page<ConfigRow>>`
  - `getConfigSummary(id: string): Promise<SummaryRow>`
  - `listSplits(id: string, cursor?: string): Promise<Page<SplitRow>>`
  - `listMutations(id: string, cursor?: string): Promise<Page<MutationRow>>`
  - `listEarnings(addr: string, cursor?: string): Promise<Page<EarningRow>>`
  - `listWithdrawals(vaultId: string, cursor?: string): Promise<Page<WithdrawalRow>>`
  - Row types are `Record<string, unknown>` aliases for MVP (REST already serializes u64→string); refine as screens consume them.

- [ ] **Step 1: Write failing test (with fetch mock)**

`src/lib/rest.test.ts`:

```typescript
import { afterEach, expect, test, vi } from "vitest";
import { listConfigs } from "./rest";

afterEach(() => vi.restoreAllMocks());

test("listConfigs hits /configs?owner= and returns the envelope", async () => {
  const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ data: [{ configId: "0xabc" }], cursor: "c1" }), { status: 200 }),
  );
  const page = await listConfigs("0x" + "1".repeat(64));
  expect(page.cursor).toBe("c1");
  expect(page.data[0].configId).toBe("0xabc");
  expect(spy.mock.calls[0][0]).toContain("/configs?owner=0x");
});

test("non-2xx throws with the server error message", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ error: { code: "BAD_OWNER", message: "owner required" } }), { status: 400 }),
  );
  await expect(listConfigs("bad")).rejects.toThrow(/owner required/);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm test src/lib/rest.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/lib/rest.ts`:

```typescript
import { API_BASE_URL } from "./constants";

export type Page<T> = { data: T[]; cursor: string | null };
type Row = Record<string, unknown>;

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `REST ${res.status}`);
  }
  return (await res.json()) as T;
}

const q = (cursor?: string) => (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
const enc = encodeURIComponent;

export const listConfigs = (owner: string, cursor?: string) =>
  get<Page<Row>>(`/configs?owner=${enc(owner)}${q(cursor)}`);
export const getConfigSummary = (id: string) => get<Row>(`/configs/${enc(id)}/summary`);
export const listSplits = (id: string, cursor?: string) =>
  get<Page<Row>>(`/configs/${enc(id)}/splits?${q(cursor).slice(1)}`);
export const listMutations = (id: string, cursor?: string) =>
  get<Page<Row>>(`/configs/${enc(id)}/mutations?${q(cursor).slice(1)}`);
export const listEarnings = (addr: string, cursor?: string) =>
  get<Page<Row>>(`/collaborators/${enc(addr)}/earnings?${q(cursor).slice(1)}`);
export const listWithdrawals = (vaultId: string, cursor?: string) =>
  get<Page<Row>>(`/vaults/${enc(vaultId)}/withdrawals?${q(cursor).slice(1)}`);
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test src/lib/rest.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add web/creatorflow-web/src/lib/rest.ts web/creatorflow-web/src/lib/rest.test.ts
git commit -m "feat(web): typed REST client for indexer endpoints"
```

---

## Task 5: chain read helpers (SuiGrpcClient)

**Files:**
- Create: `web/creatorflow-web/src/lib/chain.ts`
- Test: `web/creatorflow-web/src/lib/chain.test.ts`

**Interfaces:**
- Consumes: `PACKAGE_ID`, `USDC_TYPE`, `NETWORK`.
- Produces:
  - `getClient(): SuiGrpcClient` (singleton)
  - `getConfigVersion(configId: string): Promise<bigint>` — reads `version` field from the config object's content.
  - `getUsdcCoinIds(owner: string): Promise<string[]>` — coin object ids for split input.
  - `getOwnerCapId(owner: string, capKind: "OwnerCap" | "TaxCap" | "SavingsCap"): Promise<string | null>` — finds the owned cap for a config.

- [ ] **Step 1: Write failing test (mock the client)**

`src/lib/chain.test.ts`:

```typescript
import { expect, test, vi } from "vitest";
import { extractVersion } from "./chain";

test("extractVersion reads the version field as bigint", () => {
  const content = { dataType: "moveObject", fields: { version: "7" } };
  expect(extractVersion(content)).toBe(7n);
});
test("extractVersion throws on missing field (fail-loud)", () => {
  expect(() => extractVersion({ dataType: "moveObject", fields: {} })).toThrow();
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm test src/lib/chain.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/lib/chain.ts` (note: confirm `SuiGrpcClient` content shape during impl via a live `getObject` call; `extractVersion` is isolated so it stays unit-testable):

```typescript
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { NETWORK, PACKAGE_ID, USDC_TYPE } from "./constants";

let client: SuiGrpcClient | null = null;
export function getClient(): SuiGrpcClient {
  if (!client)
    client = new SuiGrpcClient({ network: NETWORK, baseUrl: "https://fullnode.testnet.sui.io:443" });
  return client;
}

export function extractVersion(content: unknown): bigint {
  const fields = (content as { fields?: Record<string, unknown> })?.fields;
  const v = fields?.version;
  if (v === undefined || v === null) throw new Error("config object missing `version` field");
  return BigInt(v as string);
}

export async function getConfigVersion(configId: string): Promise<bigint> {
  const obj = await getClient().getObject({ id: configId, options: { showContent: true } });
  return extractVersion((obj as { data?: { content?: unknown } }).data?.content);
}

export async function getUsdcCoinIds(owner: string): Promise<string[]> {
  const { data } = await getClient().getCoins({ owner, coinType: USDC_TYPE });
  return data.map((c: { coinObjectId: string }) => c.coinObjectId);
}

export async function getOwnerCapId(
  owner: string,
  capKind: "OwnerCap" | "TaxCap" | "SavingsCap",
): Promise<string | null> {
  const type = `${PACKAGE_ID}::capabilities::${capKind}`;
  const { data } = await getClient().getOwnedObjects({ owner });
  const hit = data.find((o: { data?: { type?: string } }) => o.data?.type === type);
  return hit?.data?.objectId ?? null;
}
```

> Impl note: the exact gRPC method names (`getCoins`/`getOwnedObjects`/`getObject`) and field access (`coinObjectId`, `data.content.fields`) are per `@mysten/sui/grpc` 2.x; verify against the installed version's types and adjust the response destructuring. Keep `extractVersion` pure so the contract stays tested regardless.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test src/lib/chain.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add web/creatorflow-web/src/lib/chain.ts web/creatorflow-web/src/lib/chain.test.ts
git commit -m "feat(web): SuiGrpcClient read helpers (version, usdc coins, caps)"
```

---

## Task 6: PTB builders (pure)

**Files:**
- Create: `web/creatorflow-web/src/lib/ptb.ts`
- Test: `web/creatorflow-web/src/lib/ptb.test.ts`

**Interfaces:**
- Consumes: `PACKAGE_ID`, `PROTOCOL_CONFIG_ID`, `USDC_TYPE`, `CLOCK_ID` from constants; `RecipientInput` from `bps.ts`.
- Produces (all return `Transaction` from `@mysten/sui/transactions`):
  - `buildCreateConfig(d: { recipients: RecipientInput[]; taxBps: number; savingsBps: number; feeBps: number; yieldBps: number }): Transaction`
  - `buildExecuteSplit(p: { configId: string; taxVaultId: string; savingsVaultId: string; amountIn: bigint; expectedVersion: bigint }): Transaction`
  - `buildMutateConfig(p: { configId: string; ownerCapId: string; recipients: RecipientInput[]; taxBps: number; savingsBps: number }): Transaction`
  - `buildWithdraw(p: { vaultId: string; capId: string; amount: bigint; kind: "tax" | "savings" }): Transaction`
  - `buildRedeemYield(p: { savingsVaultId: string; savingsCapId: string; amount: bigint }): Transaction`

- [ ] **Step 1: Write failing tests**

`src/lib/ptb.test.ts`:

```typescript
import { expect, test } from "vitest";
import { buildExecuteSplit, buildCreateConfig } from "./ptb";
import { PACKAGE_ID } from "./constants";

test("execute_split targets router::execute_split with the right package", () => {
  const tx = buildExecuteSplit({
    configId: "0x" + "a".repeat(64), taxVaultId: "0x" + "b".repeat(64),
    savingsVaultId: "0x" + "c".repeat(64), amountIn: 1_000_000n, expectedVersion: 0n,
  });
  const data = tx.getData();
  const calls = data.commands.filter((c) => c.$kind === "MoveCall");
  const target = calls.map((c) => `${c.MoveCall!.package}::${c.MoveCall!.module}::${c.MoveCall!.function}`);
  expect(target).toContain(`${PACKAGE_ID}::router::execute_split`);
});

test("create_config assembles a makeMoveVec of recipients", () => {
  const tx = buildCreateConfig({
    recipients: [{ addr: "0x" + "1".repeat(64), bps: 10000, label: "me" }],
    taxBps: 0, savingsBps: 0, feeBps: 0, yieldBps: 0,
  });
  const data = tx.getData();
  const hasNewRecipient = data.commands.some(
    (c) => c.$kind === "MoveCall" && c.MoveCall!.function === "new_recipient",
  );
  expect(hasNewRecipient).toBe(true);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm test src/lib/ptb.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/lib/ptb.ts`:

```typescript
import { Transaction } from "@mysten/sui/transactions";
import { bcs } from "@mysten/sui/bcs";
import { CLOCK_ID, PACKAGE_ID, PROTOCOL_CONFIG_ID, USDC_TYPE } from "./constants";
import type { RecipientInput } from "./bps";

const R = `${PACKAGE_ID}::router`;
const SC = `${PACKAGE_ID}::split_config`;

function recipientVec(tx: Transaction, recipients: RecipientInput[]) {
  const items = recipients.map((r) =>
    tx.moveCall({
      target: `${SC}::new_recipient`,
      arguments: [
        tx.pure.address(r.addr),
        tx.pure.u16(r.bps),
        tx.pure(bcs.vector(bcs.u8()).serialize(Array.from(new TextEncoder().encode(r.label)))),
      ],
    }),
  );
  return tx.makeMoveVec({ type: `${SC}::Recipient`, elements: items });
}

export function buildCreateConfig(d: {
  recipients: RecipientInput[]; taxBps: number; savingsBps: number; feeBps: number; yieldBps: number;
}): Transaction {
  const tx = new Transaction();
  const recipients = recipientVec(tx, d.recipients);
  const noneStrategy = tx.moveCall({
    target: "0x1::option::none",
    typeArguments: [`${SC}::StrategyRef`],
    arguments: [],
  });
  tx.moveCall({
    target: `${R}::create_config_and_vaults`,
    arguments: [
      tx.object(PROTOCOL_CONFIG_ID), recipients,
      tx.pure.u16(d.taxBps), tx.pure.u16(d.savingsBps),
      tx.pure.u16(d.feeBps), tx.pure.u16(d.yieldBps), noneStrategy,
    ],
  });
  return tx;
}

export function buildExecuteSplit(p: {
  configId: string; taxVaultId: string; savingsVaultId: string; amountIn: bigint; expectedVersion: bigint;
}): Transaction {
  const tx = new Transaction();
  const [payment] = tx.splitCoins(tx.gas, [tx.pure.u64(0)]); // placeholder; replaced below
  // Build the USDC payment from the caller's USDC coins (merged) — wired in the hook,
  // which passes a coin argument. For the pure builder we accept the coin via a
  // primary coin object id is NOT known here; see hook. To keep this pure+testable,
  // the split coin is created from a USDC coin the hook sets as the gas-independent input.
  tx.moveCall({
    target: `${R}::execute_split`,
    arguments: [
      tx.object(p.configId), tx.object(PROTOCOL_CONFIG_ID),
      tx.object(p.taxVaultId), tx.object(p.savingsVaultId),
      payment, tx.pure.bool(false), tx.pure.u64(p.expectedVersion), tx.object(CLOCK_ID),
    ],
  });
  return tx;
}

export function buildMutateConfig(p: {
  configId: string; ownerCapId: string; recipients: RecipientInput[]; taxBps: number; savingsBps: number;
}): Transaction {
  const tx = new Transaction();
  const recipients = recipientVec(tx, p.recipients);
  tx.moveCall({
    target: `${R}::mutate_config`,
    arguments: [
      tx.object(p.configId), tx.object(p.ownerCapId), tx.object(PROTOCOL_CONFIG_ID),
      recipients, tx.pure.u16(p.taxBps), tx.pure.u16(p.savingsBps),
    ],
  });
  return tx;
}

export function buildWithdraw(p: {
  vaultId: string; capId: string; amount: bigint; kind: "tax" | "savings";
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${R}::withdraw_${p.kind}`,
    arguments: [tx.object(p.vaultId), tx.object(p.capId), tx.pure.u64(p.amount)],
  });
  return tx;
}

export function buildRedeemYield(p: {
  savingsVaultId: string; savingsCapId: string; amount: bigint;
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${R}::redeem_yield`,
    arguments: [tx.object(p.savingsVaultId), tx.object(p.savingsCapId), tx.pure.u64(p.amount)],
  });
  return tx;
}
```

> Impl note (execute_split coin input): `execute_split` consumes a `Coin<USDC>` of exactly `amountIn`. The pure builder above leaves a placeholder split; the **hook** (Task 8) supplies the USDC coin: fetch coin ids via `getUsdcCoinIds`, `tx.mergeCoins` the tail into the first, then `tx.splitCoins(firstCoin, [amountIn])` → pass that result as `payment`. Refactor `buildExecuteSplit` to accept `usdcCoinIds: string[]` and do the merge/split internally so it stays a single pure builder. Update the test to pass `usdcCoinIds: ["0x"+"d".repeat(64)]` and assert a `SplitCoins` command exists. Make this refactor part of Step 3 before committing.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test src/lib/ptb.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/creatorflow-web/src/lib/ptb.ts web/creatorflow-web/src/lib/ptb.test.ts
git commit -m "feat(web): pure PTB builders for all router entry points"
```

---

## Task 7: dApp Kit provider + connect

**Files:**
- Create: `web/creatorflow-web/src/dapp-kit.ts`, `src/app/providers.tsx`
- Modify: `web/creatorflow-web/src/app/layout.tsx` (wrap children in providers), `src/app/page.tsx` (login screen with `ConnectButton`)

**Interfaces:**
- Produces: `dAppKit` instance (export); `<Providers>` wrapper; `useDAppKit()`/`useCurrentAccount()` available app-wide.

- [ ] **Step 1: Create dapp-kit instance**

`src/dapp-kit.ts`:

```typescript
import { createDAppKit } from "@mysten/dapp-kit-core";
import { NETWORK } from "./lib/constants";

export const dAppKit = createDAppKit({
  networks: [NETWORK],
  defaultNetwork: NETWORK,
});
```

> Impl note: confirm `createDAppKit` option names against installed `@mysten/dapp-kit-core` types (network config may be `createNetworkConfig`-style). Adjust to compile.

- [ ] **Step 2: Providers + layout + login**

`src/app/providers.tsx`:

```tsx
"use client";
import { DAppKitProvider } from "@mysten/dapp-kit-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { dAppKit } from "@/dapp-kit";

const qc = new QueryClient();
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={qc}>
      <DAppKitProvider dAppKit={dAppKit}>{children}</DAppKitProvider>
    </QueryClientProvider>
  );
}
```

Wrap `{children}` in `layout.tsx` with `<Providers>`. In `page.tsx`, render `<ConnectButton />` from `@mysten/dapp-kit-react/ui`; when `useCurrentAccount()` is set, redirect to `/dashboard`.

- [ ] **Step 3: Verify it boots**

Run: `pnpm dev` then load `http://localhost:3000` — connect a testnet wallet, confirm address shows. Run `pnpm typecheck`.
Expected: wallet connects, no type errors.

- [ ] **Step 4: Commit**

```bash
git add web/creatorflow-web/src/dapp-kit.ts web/creatorflow-web/src/app
git commit -m "feat(web): dApp Kit provider + wallet connect login"
```

---

## Task 8: write hooks (wire builders + sign + error map + REST poll)

**Files:**
- Create: `web/creatorflow-web/src/hooks/useWrite.ts`
- Test: `web/creatorflow-web/src/hooks/useWrite.test.ts` (test the pure helpers; hooks themselves verified in-app)

**Interfaces:**
- Consumes: builders from `ptb.ts`, `getConfigVersion`/`getUsdcCoinIds`/`getOwnerCapId` from `chain.ts`, `mapAbort` from `abort.ts`.
- Produces:
  - `signResultToOutcome(result): { ok: true; digest: string } | { ok: false; error: string }` (pure, tested)
  - `pollUntil<T>(fn: () => Promise<T>, done: (t: T) => boolean, opts?): Promise<T>` (pure, tested — exponential backoff, ~30s cap)
  - Hooks: `useExecuteSplit()`, `useCreateConfig()`, `useMutateConfig()`, `useWithdraw()`, `useRedeemYield()` — each returns `{ run, pending, error }`.

- [ ] **Step 1: Write failing tests for the pure helpers**

`src/hooks/useWrite.test.ts`:

```typescript
import { expect, test, vi } from "vitest";
import { signResultToOutcome, pollUntil } from "./useWrite";

test("signResultToOutcome maps FailedTransaction via mapAbort", () => {
  const r = { FailedTransaction: { status: { error: "...EConfigChanged..." } } } as any;
  const o = signResultToOutcome(r);
  expect(o).toEqual({ ok: false, error: expect.stringMatching(/refresh/i) });
});
test("signResultToOutcome maps success to digest", () => {
  const r = { Transaction: { digest: "abc" } } as any;
  expect(signResultToOutcome(r)).toEqual({ ok: true, digest: "abc" });
});
test("pollUntil resolves when predicate passes", async () => {
  let n = 0;
  const out = await pollUntil(async () => ++n, (v) => v >= 3, { baseMs: 1, capMs: 5, maxMs: 1000 });
  expect(out).toBe(3);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm test src/hooks/useWrite.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement helpers + hooks**

`src/hooks/useWrite.ts` (helpers shown in full; hooks wire them):

```typescript
import { useState } from "react";
import { useDAppKit } from "@mysten/dapp-kit-react";
import { mapAbort } from "@/lib/abort";

export type Outcome = { ok: true; digest: string } | { ok: false; error: string };

export function signResultToOutcome(result: any): Outcome {
  if (result?.FailedTransaction)
    return { ok: false, error: mapAbort(result.FailedTransaction.status?.error) };
  if (result?.Transaction?.digest) return { ok: true, digest: result.Transaction.digest };
  return { ok: false, error: "Unknown transaction result" };
}

export async function pollUntil<T>(
  fn: () => Promise<T>,
  done: (t: T) => boolean,
  opts: { baseMs?: number; capMs?: number; maxMs?: number } = {},
): Promise<T> {
  const { baseMs = 500, capMs = 4000, maxMs = 30_000 } = opts;
  const start = Date.now();
  let delay = baseMs;
  for (;;) {
    const v = await fn();
    if (done(v)) return v;
    if (Date.now() - start > maxMs) return v;
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, capMs);
  }
}

function useTx(build: (kit: ReturnType<typeof useDAppKit>) => Promise<Outcome>) {
  const kit = useDAppKit();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(): Promise<Outcome> {
    setPending(true); setError(null);
    try { const o = await build(kit); if (!o.ok) setError(o.error); return o; }
    finally { setPending(false); }
  }
  return { run, pending, error };
}
// useExecuteSplit/useCreateConfig/... each call useTx with the matching builder:
//  1. read expectedVersion via getConfigVersion (execute_split / no version for others)
//  2. resolve usdc coin ids / cap ids via chain helpers
//  3. tx = build...(...)
//  4. const result = await kit.signAndExecuteTransaction({ transaction: tx })
//  5. return signResultToOutcome(result)
```

Implement each of the 5 hooks following the numbered recipe in the comment. `useExecuteSplit({ configId, taxVaultId, savingsVaultId })` returns `run(amountIn: bigint)`; it reads `expectedVersion` immediately before building (T2 guard), fetches USDC coin ids, builds, signs, maps. After a successful split, callers `pollUntil` on `listSplits(configId)` until the new digest appears.

- [ ] **Step 4: Run to verify pass + typecheck**

Run: `pnpm test src/hooks/useWrite.test.ts && pnpm typecheck`
Expected: PASS (3 tests), no type errors.

- [ ] **Step 5: Commit**

```bash
git add web/creatorflow-web/src/hooks
git commit -m "feat(web): write hooks (sign outcome mapping, poll, 5 router actions)"
```

---

## Task 9: gemini-authored presentational components

**Files:**
- Create: `web/creatorflow-web/src/components/ui/*` (gemini)

**Interfaces (LOCKED — gemini must match these prop contracts exactly, no data fetching, no PTB logic):**
- `<ConfigCard config={{ id: string; recipientCount: number; taxBps: number; savingsBps: number; createdAtMs: string }} onClick={() => void} />`
- `<VaultBalance label="Tax" | "Savings" amount={bigint} symbol="USDC" loading={boolean} />`
- `<SplitForm value={SplitDraft} onChange={(d: SplitDraft) => void} error={string | null} onSubmit={() => void} submitting={boolean} />`
- `<HistoryTable columns={string[]} rows={Array<Record<string,string>>} onLoadMore={() => void} hasMore={boolean} />`
- `<AmountInput value={string} onChange={(s: string) => void} max={string} symbol="USDC" />`
- `<TxButton label={string} onClick={() => void} pending={boolean} disabled={boolean} />`
- `<Toast kind="error" | "success" message={string} />`

- [ ] **Step 1: Delegate to gemini cli**

```bash
cd web/creatorflow-web
gemini --skip-trust -p "Build production-grade, distinctive React + Tailwind presentational components in src/components/ui/ for a Sui creator-finance dashboard (CreatorFlow). STRICT RULES: presentational only — no fetch, no @mysten/* imports, no business logic, props are the ONLY data source. Implement exactly these components with these prop signatures: [paste the LOCKED interface block above]. TypeScript, named exports, one file per component. Aesthetic: fintech, trustworthy, high-contrast, not generic AI dashboard."
```

- [ ] **Step 2: Typecheck + dual-review the gemini output**

Run: `pnpm typecheck`
Then run `/dual-review` on the diff (per project rules; these are non-Move TS → generic codex + project-rules round). Fix any prop-contract drift or logic leakage (a `fetch`/`@mysten` import in `ui/` is an automatic reject).

- [ ] **Step 3: Commit**

```bash
git add web/creatorflow-web/src/components/ui
git commit -m "feat(web): presentational UI components (gemini, dual-reviewed)"
```

---

## Task 10: dashboard + config-form pages (wire data → UI)

**Files:**
- Create: `web/creatorflow-web/src/app/dashboard/page.tsx`, `src/app/config/new/page.tsx`, `src/app/config/[id]/edit/page.tsx`

**Interfaces:**
- Consumes: `listConfigs`, `getConfigVersion`-fed vault reads, `validateSplit`, `useCreateConfig`, `useMutateConfig`, gemini `ConfigCard`/`SplitForm`/`VaultBalance`/`TxButton`/`Toast`.

- [ ] **Step 1: Dashboard page**

`/dashboard`: `useCurrentAccount()` → `listConfigs(account.address)` (react-query). Render `<ConfigCard>` per config (click → `/config/[id]`). For each config read tax/savings vault balances from chain (`getObject` balance field) and show `<VaultBalance>`. "New config" button → `/config/new`.

- [ ] **Step 2: New/edit config pages**

`/config/new`: local `SplitDraft` state → `<SplitForm>`; on change run `validateSplit` → pass `error`; submit calls `useCreateConfig().run()`; on success `pollUntil(listConfigs)` for the new config then route to it. `/config/[id]/edit`: prefill draft from chain config read; submit calls `useMutateConfig().run()`.

- [ ] **Step 3: Verify in-app**

Run: `pnpm dev` — connect wallet, create a config with 1 recipient (8970) + tax 500 + savings 500 + fee 30, confirm it appears in `/dashboard` after poll. Edit it, confirm version bumps. `pnpm typecheck`.
Expected: config created on testnet, visible after indexer catch-up.

- [ ] **Step 4: Commit**

```bash
git add web/creatorflow-web/src/app/dashboard web/creatorflow-web/src/app/config
git commit -m "feat(web): dashboard + config create/edit pages"
```

---

## Task 11: config detail page (history + trigger split + withdraw)

**Files:**
- Create: `web/creatorflow-web/src/app/config/[id]/page.tsx`

**Interfaces:**
- Consumes: `getConfigSummary`/`listSplits`/`listMutations`/`listEarnings`/`listWithdrawals`, `useExecuteSplit`/`useWithdraw`/`useRedeemYield`, gemini `HistoryTable`/`AmountInput`/`TxButton`/`Toast`/`VaultBalance`.

- [ ] **Step 1: Detail page**

`/config/[id]`: show summary + vault balances; tabs/sections for split history (`listSplits`), mutations (`listMutations`), collaborator earnings (`listEarnings`) — each via `<HistoryTable>` with `onLoadMore` paging the REST cursor. "Trigger split" panel: `<AmountInput>` (max = wallet USDC balance from chain) + `<TxButton>` → `useExecuteSplit().run(amountIn)` → on success `pollUntil(listSplits)` until digest shows, then refresh. Withdraw tax/savings + redeem yield panels gated on the user holding the matching cap (`getOwnerCapId`); hide if null.

- [ ] **Step 2: Verify in-app (the demo centerpiece)**

Run: `pnpm dev` — on the config created in Task 10, enter `1` USDC, trigger split, confirm: wallet signs, tx succeeds, the new split row appears in the history table after poll, vault balances increase. Try a withdraw with the TaxCap. `pnpm typecheck`.
Expected: end-to-end split visible in the UI.

- [ ] **Step 3: Commit**

```bash
git add web/creatorflow-web/src/app/config/[id]/page.tsx
git commit -m "feat(web): config detail — history, trigger split, withdraw/redeem"
```

---

## Task 12: E2E smoke + monkey

**Files:**
- Create: `web/creatorflow-web/src/lib/ptb.monkey.test.ts`

**Interfaces:**
- Consumes: builders + validator.

- [ ] **Step 1: Monkey tests (pure)**

`src/lib/ptb.monkey.test.ts`: assert `validateSplit` rejects bps edges (sum 9999/10001, recipient bps 0, 17 recipients, yield>savings); assert `buildExecuteSplit` with `amountIn: 0n` still builds a tx (contract rejects 0 via `EZeroPayment` — UI prevents 0 earlier, but the builder must not crash); assert `buildCreateConfig` with exactly 16 recipients builds (boundary).

- [ ] **Step 2: Run full suite + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all green.

- [ ] **Step 3: Manual E2E checklist (reuse 2026-06-18 verified path)**

Start REST (`cd api/creatorflow-api && DATABASE_URL=... pnpm start`, Docker `creatorflow-pg` up) + indexer. In the app: connect wallet → create config → trigger 1 USDC split → confirm REST `/configs/:id/splits` returns the row and the UI shows it. This mirrors the contract-level e2e already validated on testnet.

- [ ] **Step 4: Commit**

```bash
git add web/creatorflow-web/src/lib/ptb.monkey.test.ts
git commit -m "test(web): monkey tests for builders + validator boundaries"
```

---

## Deferred (separate plan, gated on Enoki API key)

zkLogin via `@mysten/enoki` (login + sponsored gas) is **out of this plan**. It is a follow-up plan written once the Enoki testnet API key is provisioned. The wallet path above is fully independent and demo-complete without it.

## Self-Review

- **Spec coverage:** §3 stack (T1,T7), §5 screens — login (T7), dashboard (T10), new/edit (T10), detail (T11); §6 PTB builders (T6) + version read (T5/T8); §7 data flow REST+poll+chain (T4,T5,T8,T10,T11); §8 two-layer error handling (T3,T8); §9 testing — builders/validator/mapper (T2,T3,T6), e2e (T12), monkey (T12). zkLogin §3/§10-risk-1 explicitly deferred. Reads via SuiGrpcClient (T5) per review F1; dapp-kit-react per F2 (T7); FailedTransaction union per F3 (T3,T8). **No gaps for the wallet MVP.**
- **Placeholder scan:** the only "placeholder" is the documented `buildExecuteSplit` coin-input refactor (Task 6 impl note) — it has explicit instructions and a follow-up test, not a TODO. No bare TODOs.
- **Type consistency:** `SplitDraft`/`RecipientInput` defined in T2, reused T6/T10; `Outcome` defined T8; builder signatures in T6 match hook usage in T8; `Page<T>` envelope T4 matches REST usage T10/T11.
