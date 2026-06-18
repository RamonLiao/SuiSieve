# CreatorFlow — Move Notes

> 鏈上設計決策與限制的長期記錄。對話結束也保留。
> 權威來源：`docs/specs/2026-05-28-creatorflow-architecture-spec.md`（架構書）。本檔只記「為什麼」與踩雷。

---

## 2026-05-30 — 架構書 review patch（5 點）

對既有架構書做 surgical patch，修正 5 個技術矛盾/缺口。companion 檔（threat-model、module-dependency.mmd、data-flow.mmd）同步。

### 1. Yield「fallback」是假的 —— Move 無 try/catch（最關鍵）
- **限制**：同一 PTB 內，跨 package 的 abort 無法被 catch。Scallop deposit abort → 整筆 PTB revert（含所有 recipient transfer）。「PTB ordering」給的是 all-or-nothing，**不是** graceful degradation。
- BUSINESS_SPEC §9 原文「yield slice falls back to savings vault, engineered via PTB ordering」**描述錯誤**。
- **兩種合法形態（沒有第三種）**：
  - **Mode A（MVP / demo 預設）**：`include_yield=true`，Scallop deposit 在 PTB 內。abort → 整筆 revert → **client 重試 `include_yield=false`**（yield slice 改進 SavingsVault）。所謂 fallback 是鏈下重試。
  - **Mode B（v1 production）**：`execute_split` 永遠把 yield slice 放進 SavingsVault；另開獨立排程 `yield_adapter::sweep` 把 savings→Scallop。payment path 完全不依賴 Scallop uptime。
- event 移除 dead 的 `yield_success: bool`（abort 時 event 根本不 emit，false 不可觀測），改 `yield_included: bool`（記錄 client construct-time 決策，可觀測）。
- **實作待決**：A→B 切換的量級門檻（§15 Q1）。

### 2. 協議 take-rate（0.3%）落地 object model
- BUSINESS_SPEC §10 說 take rate 當作「一個 split recipient」，但原 object model 沒有對應欄位。
- 新增 module `protocol_config`：shared `ProtocolConfig { treasury, min_fee_bps, max_fee_bps }` + owned `AdminCap`。
- `SplitConfig` 加 `protocol_fee_bps`。不變式：`sum(recipients)+tax+savings+protocol_fee == 10000`。
- `create`/`mutate` 斷言 `min_fee_bps <= protocol_fee_bps <= max_fee_bps` → 協議不能事後抬價、創作者不能設到 floor 以下。
- `ProtocolConfig` 在 hot path 只讀（immutable `&`）→ 無 shared-object contention。
- **威脅 E5**：AdminCap holder 抬 `max_fee_bps` 來 skim → 受 bound 限制 + 鏈上可觀測 + 創作者簽前可讀。

### 3. `Coin<USDC>` 寫死 = 泛型 break-point
- `execute_split(payment: Coin<USDC>)` 非泛型。v2 跨鏈/多幣別需 `execute_split<T>`，連帶 `TaxVault<T>`/`SavingsVault<T>` → **non-compatible upgrade**。
- **決策**：MVP 維持 monomorphic USDC；泛型化當成 v1→v2 deliberate redeploy，不做 hot upgrade。

### 4. 雙 shared-vault 寫入 → 單創作者付款序列化
- 每次 `execute_split` 同時 `&mut TaxVault` + `&mut SavingsVault`（皆 shared）→ 同一 creator 並發付款全在這兩物件上經 consensus 序列化（UC-2 350-fan burst 場景）。
- 上限約 Sui 單 shared-object commit rate（數百/s，非平行）。MVP 接受，但**必須 load-test**（架構書 §11 contention 列）。
- v1 mitigation（若量測到瓶頸）：per-vault 切 N 個 sub-vault round-robin，或 fast-path owned-coin 累積 + 定期 sweep。

### 5. Stale pay-link / version-refresh
- `execute_split` 對 `expected_version != config.version` abort（`EConfigChanged`）。pay-link 長壽 + permissionless push → 創作者一改 config，所有舊 link 失效。
- **解**（純 client，無合約改動）：pay-link 只編 `config_id`+金額；簽前用 gRPC 讀當前 `config.version` 注入。**禁止把 version 寫進 URL**（會重現大規模 stale revert）。

---

## 2026-05-30 — 實作 module 1/7：`protocol_config`

- Package 骨架建立：`move/creatorflow/`（`sui move new`，edition 2024，implicit deps）。spec §14 layout。
- `sources/protocol_config.move`：依賴圖最底層，**刻意不依賴 `events`**（否則反轉依賴方向）。Admin 動作靠物件 state 變更可觀測，不 emit event。
- 結構：`ProtocolConfig has key`（shared）`{ treasury, min_fee_bps, max_fee_bps }` + `AdminCap has key, store`。`init` publish 時 share config（treasury 預設 = publisher，window [30,100] bps）+ transfer AdminCap 給 publisher。
- **超出 spec 的硬化決策**：spec §3.5 只說 `max_fee_bps` 是 anti-abuse 卻沒 bound 它本身 → 加常數 `MAX_FEE_CEILING=1000`（10%），`set_bounds` 斷言 `min<=max<=ceiling`。這是 T11（AdminCap 抬價 skim）的真正防線，不靠「鏈上可觀測」這種軟保證。
- `set_treasury` 拒絕 `@0x0`（EZeroTreasury），fail loud 防誤燒手續費。
- Admin 函式用 `public`（非 `public(package)`）：部署者從 PTB 外部呼叫，`public(package)` 會鎖死 admin 操作。
- 校驗集中：`assert_fee_in_bounds(&config, fee_bps)` 給 `split_config` 在 create/mutate 時呼叫；hot path 只讀 `treasury()`。
- Test：8/8 PASS（含 monkey：min>max、>ceiling、=ceiling 邊界、treasury=0x0、fee 越界上下限）。用 `std::unit_test::assert_eq!`（`sui::test_utils::assert_eq` 已 deprecated）。
- Quality：`move-code-quality` 無 critical。

## 2026-05-30 — 實作 module 2/7：`capabilities`

- `sources/capabilities.move`：spec §3.1，**logic-free** 純資料 module（struct + package-only 構造子 + read-only getter）。把 Cap 定義從用它的模組隔開 → audit「誰能偽造 Cap」只需讀這一檔。
- 三個 MVP cap：`OwnerCap { config_id }`、`TaxCap { vault_id }`、`SavingsCap { vault_id }`，皆 `key, store`（可轉冷錢包/會計）。每個 cap 綁定單一 object `ID`。
- **access-control 防線（結構性，零 runtime 成本）**：
  1. 欄位私有 + 構造子 `public(package)` → 外部 package 無法用 struct literal 自鑄 cap（防偽造）。
  2. 每 cap 綁定特定 `ID`，getter 給消費端 assert 相符 → 偷一個 cap 只能動一個物件（blast radius = 單一 vault）。
  3. 不同 nominal type（`TaxCap` ≠ `SavingsCap`）→ 型別混淆 compile 就擋。
  4. 無 setter → 綁定 mint 時固定，不可事後 re-point。
- **決策：`RecipientLockCap`（spec §3.1 標 v1）延後**。MVP `mutation_policy` 預設 `OwnerOnly`，不會用到 lock cap；現在加只會是 speculative code + unused `public(package)` 構造子。等 v1 `OwnerPlusLockHolders` 落地再補。
- 構造子目前無 caller（`split_config`/`vaults` 尚未實作），`public(package)` 不報 unused warning，build clean。
- Test：4/4 PASS。重點測**綁定不變式**（getter 回傳 == mint 傳入的 ID，這就是 access-control 的 intent）+ monkey（同 vault_id 鑄兩個 cap → 獨立 UID、binding 不 alias）。用 `object::id_from_address` 造確定性 ID 免建真物件；`std::unit_test::destroy` 清 cap（`sui::test_utils::destroy` 已 deprecated）。
- Quality：`move-code-quality` 0 critical / 0 warning。red-team 留待 `vaults`/`router`（實際持 cap withdraw 處）。

## 2026-05-31 — 實作 module 3/7：`split_config`

- `sources/split_config.move`：shared `SplitConfig`（payment routing table）+ `Recipient`/`StrategyRef`/`MutationPolicy`。依賴**只有** `capabilities` + `protocol_config`（依 module-dependency.mmd 權威圖：`config → {cap, protocol}`）。
- **兩個與散文 spec 的矛盾，按 mmd（較新）裁決（Rule 7）**：
  1. spec §4.1/§4.4 把 `create_split_config` 與 `ConfigMutated` event emit 放進 `split_config`，但 mmd 無 `config → {vaults, events}` 邊。→ `create_split_config` 編排（建 vault + 連 ID + emit）移到 `router`；`update_recipients` **不 emit event**，沿用 module 1 先例（owner mutation 靠 `version` 欄位鏈上可觀測，不引入 events 依賴）。
  2. `StrategyRef` 在 mmd 無歸屬（`yield_adapter` 無 `→config` 邊，而 `config→yield_adapter` 會反轉順序）。→ `StrategyRef` 放 `split_config`（它是 config-time 資料）；`yield_adapter`(6) 反向依賴 `split_config`(3) 取型別 = 合法 backward edge。**已 patch mmd 補 `yield_adapter → config` 邊**。
- **circular ID 解法（router 待實作時用）**：vault 與 config 互指 ID。router 先 `object::new` 造兩個 vault UID → 取 ID → 傳給 `split_config::new`（自造 config UID）→ 再用預造 UID + config_id 組 vault。`new` 收 `tax_vault_id`/`savings_vault_id` 為純 `ID` 參數，故本 module 無 `vaults` 依賴。
- **invariant**：`sum(recipients.bps)+tax+savings+protocol_fee == 10000`；`yield_bps <= savings_bps`（yield 是 savings 的 sub-allocation，不進 sum）；recipients ≤ 16 且每個 bps > 0。`assert_fee_in_bounds` 在 create **與** mutate 都跑（T11 雙向）。
- **u16 overflow 陷阱（關鍵）**：16×10000=160000 爆 u16(65535)。bps sum **必須用 u64 累加**，否則惡意值可 wrap 回 10000 騙過 `==` 檢查 → execute 時切超過 100%。有 monkey test `new_rejects_u16_wraparound_sum`（8 recipients 湊 75536，mod 65536 == 10000）守這條。
- **enum vs struct 延後不對稱**：`MutationPolicy::OwnerPlusLockHolders { k }` **現在就宣告**（雖只構造 `OwnerOnly`）——對 stored enum 事後加 variant 是 non-compatible upgrade；對比 module 2 `RecipientLockCap`（新 struct 永遠 compatible，可安全延後）。
- `new` = `public(package)`（router-only，防外部偽造綁錯 vault 的 config）。`new_recipient`/`new_strategy_ref` = `public`（TS SDK 要在 PTB 內建這些 struct，欄位私有別無他法）。
- Test：10/10 PASS（happy + 6 abort path + foreign-cap + u16-wrap monkey）。全 suite 22/22。`move-code-quality` 0 critical / 0 warning（修了 merged-attr 一處對齊既有風格）。

## 2026-05-31 — 實作 module 4/7：`vaults`

- `sources/vaults.move`：shared `TaxVault` + `SavingsVault`（`Balance<USDC>` + `config_id` 反指 + `total_deposited`/`total_withdrawn` 單調計數器）。依賴**只有** `capabilities`（依 mmd `vault → cap`）。
- **GTM 決策：綁真實 Circle 原生 USDC**（非自鑄 demo token——對上市零價值、不能 onboard 真用戶）。Move.toml git dep `circlefin/stablecoin-sui` subdir `packages/usdc`，型別 `usdc::usdc::USDC`。
  - `releases/testnet` 分支**不存在**（context7 範例過時）；改 pin tag `release-2024-11-22T170906` + `override = true`（usdc 包 pin 了舊 Sui framework rev `a4185da`，不 override 會跟 testnet 框架衝突）。
  - 維持 monomorphic USDC（MVP，Stripe-style 單幣）；`Coin<T>` 泛型化是 v2 deliberate redeploy（spec §4.2）。mainnet 上線換 dep rev 即可（`dep-replacements.mainnet`），合約邏輯零改。
  - 測試用 `coin::mint_for_testing<USDC>`（任意型別免 treasury cap），不依賴實時網路。
- **兩處 spec↔mmd 矛盾，按 mmd 裁決（Rule 7，同 split_config 先例）**：
  1. spec §3.3 `SavingsVault.yield_position: Option<ScallopPositionRef>` → **不設此欄位**。mmd 邊是 `yield_adapter → vault`（不可反向），ScallopPositionRef 屬 module 6。`yield_adapter` 用 **dynamic field** 掛 position → vaults 保持 Scallop-agnostic + 規避「stored struct 加欄位 = non-compatible upgrade」成本。
  2. spec §4.3 `withdraw_tax` 內 emit `VaultWithdrawn` → **不在 vaults emit**。mmd 無 `vault → events` 邊。`withdraw_*`/`deposit_*` 全 `public(package)`，`router` 包裝時 emit（top 模組擁有 event emission，同 module 1/3 先例）。
- **access control（T4）**：`withdraw_*` 斷言 `cap.vault_id == object::id(vault)` → `EWrongCap`。每 cap 綁單一 vault，偷一個只能動一個。
- **ability 選擇**：vault `has key`（無 `store`）→ shared 後不可被 transfer 走或包進別 struct，型別系統保證恆 shared。
- **balance 模式**：deposit `vault.balance.join(coin.into_balance())`；withdraw `coin::take(&mut vault.balance, amount, ctx)`（`take` 定義在 coin、receiver 是 Balance，故不能 method syntax，維持 `coin::take`）。`amount > balance` → `EInsufficientBalance`（fail loud 不 silent cap）。
- Test：9/9 PASS（empty/bound、deposit-withdraw accounting invariant `balance==deposited-withdrawn`、full withdraw、overdraw abort、foreign-cap abort ×2、savings happy、monkey 8× interleave）。全 suite 31/31。`move-code-quality` 0 critical（修一處 `.join()` method idiom）。
- **Red Team（focused 4 vectors，全 DEFENDED / 0 exploit）**：counter u64 溢位→arithmetic abort；cross-vault cap 重用→EWrongCap；累積超額提領→EInsufficientBalance；withdraw 0→no-op。結構性：cap 偽造被 public(package) 擋、type confusion 被 nominal type 擋。attack test 跑完已刪（未 --keep-tests）。

## 2026-05-31 — module 5/7 `events`
- `sources/events.move`：**leaf module**，僅依賴 `sui::event`（mmd 中 events 無任何 outgoing 邊）。3 事件型別 `SplitExecuted`/`ConfigMutated`/`VaultWithdrawn` + `RecipientPayout`（過去式命名、皆 `copy, drop`、無 `key`/`store`）。
- **emit 函式 + `RecipientPayout` 建構子全 `public(package)`**：事件是 indexer 的真相來源。若外部能 emit `SplitExecuted` → 偽造付款史（毒化 analytics、假收據）。限制 package-internal（依 graph 只有 `router`）→ 每筆事件對應真實 state transition。
- **`yield_included` 語意（spec §3.4）**：記錄 yield-deposit call 是否被「構建進 PTB」（client `include_yield` AND strategy 存在），**非 runtime success flag**。Scallop abort 會 revert 整 PTB、事件根本不 emit；`false` = 沒接 yield path（可觀測），`yield_success:false` 則永遠觀測不到。
- **`kind: u8`（KIND_TAX=0 / KIND_SAVINGS=1）非 enum**：欄位跨 BCS 給 indexer，穩定整數 tag 比 enum variant 好解碼。spec §3.4 固定值。暴露 `kind_tax()`/`kind_savings()` getter 供 router 用具名常數。
- Test：6/6 PASS（全 suite 37/37）。事件無法讀回，改驗 (1) `RecipientPayout` 欄位 round-trip（跨 BCS 不可錯位）、(2) 每個 `emit_*` 經 `test_scenario::num_user_events` 斷言恰發 1 個 event（證明 wiring 有效非 no-op）；含 monkey（空 vector + 全零 amount 仍正常 emit）。`move-code-quality` 0 critical / 0 warning。

## 鏈上限制備忘（持續累積）
- Move 無 try/catch：跨 package abort 不可 catch；同 PTB 內失敗 = 全 revert。降級只能在鏈下或拆 tx。
- 非 compatible upgrade（改 struct 欄位型別、泛型化既有 type）→ 需 redeploy，testnet state 可丟。

## 已知風險 / 待測
- [ ] T10 contention：UC-2 burst load test 未跑。
- [ ] yield Mode A 的 client 重試邏輯（dashboard）未實作。
- [x] `vaults::withdraw_*` 已過 focused red-team（4 vectors，0 exploit）。`router::execute_split` 待實作後再跑完整 audit（deposit 側流程是它 gate 的）。
- [ ] 確認 Circle USDC dep 的真實 testnet/mainnet 部署地址（`published-at`）——deploy 時才需要，unit test 階段用 mint_for_testing 不涉及。

## 2026-06-14 — module 6/7 `yield_adapter` 完成

Scallop yield wrapper（spec §7）。依賴 `vaults` + `split_config`(StrategyRef，legal backward edge) + `capabilities`。

**決策 / 為什麼**
- **MVP 範圍 = Stub + CPI 接縫**（使用者確認）。非真接 Scallop testnet——真接是獨立後續 TODO。`Coin<USDC>` parked 在 dynamic-field position；真實 Scallop supply/redeem 隔離在兩個 private fn `supply_into`/`redeem_from`，加上 `YieldPosition.balance` 型別（MVP `Balance<USDC>` → 真接換 Scallop sCoin）。實接只動這 3 處，不碰 router/vaults/tests = 設計的縫而非技術債。
- **Position 存 dynamic field on `SavingsVault`**（非 struct 欄位）——兌現 vaults.move header + move-notes L91 的承諾：vaults 保持 Scallop-agnostic + 規避「stored struct 加欄位 = non-compatible upgrade」。`YieldKey()` positional struct（copy,drop,store）當 key。
- **vaults surgical patch**：新增 `savings_uid_mut`/`savings_uid`（皆 `public(package)`）——dynamic field 必須掛 UID，而 `SavingsVault.id` 對 yield_adapter 私有，故必須開接縫。package-only 保持 UID 不可從外部偽造。
- **三條路徑對應 §7 Mode**：`deposit`(Mode A，router in-PTB 呼叫，會 abort 的接縫，不需 cap——payment PTB 授權)；`sweep`(Mode B，cap-gated，savings free balance → position)；`redeem`(cap-gated 贖回，spec §5 "Drain yield only"，回 Coin 給 caller)。
- **principal accounting**：`redeem_from` 贖回時 draw down principal（`amount>=principal → 0`）；真接後超出 principal 的餘額 = 累積 yield，最後贖。
- **一個 vault 一個 position**（MVP）；多 venue 按 `pool_id` keying 是 v1。`StrategyRef.pool_id/kind` 記錄但未用於路由資金，真接 Scallop 才驗 pool。

**Red-team（核心金流，4 向量全 DEFENDED）**
1. 跨 vault cap 盜領 → `redeem`/`sweep`(經 withdraw_savings) 斷言 `savings_cap_vault_id==object::id(vault)` → `EWrongCap` ✅
2. 超額贖回 → `redeem_from` 斷言 `amount<=balance.value()` → `EInsufficientYield`（fail loud，非 silent-cap）✅
3. 無 position 就 redeem → `redeem` 斷言 dyn field 存在 → `ENoPosition` ✅
4. malicious StrategyRef → MVP 不依 strategy 路由資金（僅記錄），真接才驗 pool_id；已文件化 ✅
- principal u64 溢位：受 USDC 總量約束，非實際威脅。

**測試 / 品質**
- 9/9 PASS（全 suite 46/46）：deposit 建 position + accounting、accumulate、redeem partial/full(空 position 保留)、sweep、3 abort path、zero-value monkey。
- `move-code-quality` 0 critical / 0 warning；build 無 warning。

**未做（後續）**
- 真接 Scallop testnet（換 `supply_into`/`redeem_from` body + position 型別 + Scallop package dep）。
- `YieldReceipt`（spec §2 列為 key struct）刻意延後——MVP event 由 `events::SplitExecuted.yield_amount/yield_included` 覆蓋，避免 speculative code（同 RecipientLockCap 延後策略）。
- `router::execute_split` 串接 deposit（Mode A 第 7 步）。

## 2026-06-15 — module 7/7 `router` 完成（最後一個 Move module）

`execute_split` PTB 編排 + owner 端 wrapper（create/mutate/withdraw/redeem），串接全部 6 個 lower module，獨佔所有事件 emission。spec §4.2 / §4.4 / §5。

**踩到的鏈上限制（兩個 surgical patch，已確認設計）：**
1. **建立時的 ID 互指環**：`SplitConfig` 存 vault IDs、vaults 存 `config_id`，雙向不可變（T9）。Sui verifier **E01001** 禁止「跨 function 傳入 `UID` 再 build object」——`UID` 必須在 build 它的同一 function 內由 `object::new` 鑄造。所以無法 pre-derive 任一方 ID 傳給另一方的建構子。
   - **解法**：`split_config` 加 `new_unwired`（vault IDs 先填 `@0x0` sentinel）+ `wire_vaults`（一次性回填，assert 仍是 sentinel → `EAlreadyWired`，綁定永久不可變）。`new` 改成委派 `new_unwired` + `wire_vaults` → **既有 split_config_tests 零改動**。
   - router 流程：建 config（內部 `object::new`）→ `object::id` 得 config_id → 建兩 vault → `wire_vaults` 回填 vault IDs → share。
2. **跨 module 不能 share key-only object**：`SplitConfig`/`TaxVault`/`SavingsVault` 皆 `key` 無 `store` → Move private-transfer 規則只允許 defining module 呼 `transfer::share_object`。router 不行。
   - **解法**：各加 `public(package) fun share*`（不加 `store`，避免讓 shared 資金物件可被 wrap，比加 ability 安全）。

**split 數學**：每 slice = `floor(amount_in * bps / 10000)`，u128 中間值（無 u64 overflow）。**最後一個 recipient 吸收 rounding 餘額** → gross 完全守恆、不燒 dust；0-recipient config 餘額入 savings。yield sub-slice 從 savings slice 切出（`yield_bps <= savings_bps` 不變式保證內層 split 不 underflow）。

**T9 強化成雙向**：execute_split 同時斷言 `vault.config_id == config.id` **且** `config.{tax,savings}_vault_id == vault.id`，假 vault 或假 config 都擋。

**Red-team 5 向量全 DEFENDED（皆有測試）**：T2 stale version(`EConfigChanged`)、T9 fake vault(`EVaultMismatch`)、dust leak(守恆測試)、u64 overflow(u128 中間值)、T6 recipient 迴圈 gas grief(`MAX_RECIPIENTS=16` 建立時已擋)。

**測試**：router_tests 11 個（happy / yield on/off / no-strategy / stale / foreign-vault / dust / mutate / withdraw+redeem / wire one-time / monkey 10-amount 守恆）。全 suite **57/57 PASS**（46→57）。`move-code-quality` **0 critical / 0 warning**；唯一刻意偏離 = recipient 迴圈用 `while`（需順序 split coin + 末位吸 dust，macro 表達不了）。self_transfer lint 已 `#[allow]`（creator 提自己 vault 是 by design）。

**仍 open**：深度 `sui-red-team` + gas benchmark（inline red-team 已過，深度審計待跑）；T10 contention load test。

## 2026-06-15 — 深度安全審計（sui-security-guard + sui-red-team）

全 7 module 審計，焦點 `router::execute_split`。**無 critical / high。**

### 已修補
- **L1 / 威脅 T6b — 零值 spam griefing**：`execute_split` permissionless 且無金額下限，攻擊者可餵 `Coin<USDC>` value=0 → 對每個 recipient `public_transfer` 一個零值 coin object（object bloat）+ emit 垃圾 `SplitExecuted`（indexer 污染），成本僅 gas。
  - 修法：取得 `amount_in` 後 `assert!(amount_in > 0, EZeroPayment)`（`router.move`）。
  - 測試：`router_tests::execute_split_rejects_zero_payment`（expected_failure）。全 suite 57→**58 PASS**。
  - spec 同步：§4.2 加步驟 2b、威脅表加 T6b、頂部 rev. 2026-06-15。

### 接受為 informational（不修）
- **L2 — rounding 永遠偏 last recipient**：`amount*bps < 10000` 時該 slice floor=0，sub-threshold（fee 30bps → ≤333 units = 0.000333 USDC）金額會 100% 進 last recipient，繞過 fee/tax/savings。**已驗證非實用攻擊**：fragmentation 需數千筆 tx，gas 遠超省下的 fee。正常金額 dust ≤ (n+3) units 可忽略。若日後改 sponsored-tx / gas 大降需重評 → 改「dust 入 treasury」或加 min-amount。
- **L3 — recipient addr 未拒 `@0x0`**：owner-controlled 自損型，低風險。
- **I1 — `yield_adapter::sweep` 生產無 entry path**：`public(package)` 但 router 無 wrapper，鏈上不可達（Mode B = v1 設計）。實接 Scallop 時補 router wrapper。
- **I2 — yield 為 stub**：`StrategyRef` 未路由資金，CPI 接縫在 `supply_into`/`redeem_from`。

### PASSED（防線確認）
access control（cap per-object 綁定 + `public(package)` ctor + nominal type）、T2 version、T9 雙向 vault 綁定、u128 slice 無 overflow、u64 bps sum 防 u16 wrap、coin 無 leak（gross 守恆）、T6 MAX_RECIPIENTS=16、T11 MAX_FEE_CEILING、事件偽造（emit `public(package)`）、shared-object 熱路徑唯讀。

## 下一步
- 7 個 Move module 全部完成 + 審計過。建議開新 chat：①gas benchmark `execute_split` + T10 contention load test，或 ②前端 dashboard / indexer。

## 2026-06-15 — gas 分析 `router::execute_split`

**結論：對 fan-out splitter 已接近 gas-optimal，無高價值優化。**

- 真實 gas 主導項 = storage（不是 computation）：每個 recipient 一個新 `Coin<USDC>` owned object（N≤16）+ fee coin 0–1 + yield dynamic field 0–1。split loop 的 computation 可忽略（抽象 gas delta：monkey 10-amount=193 vs base 5M）。
- `deposit_tax/savings` 走 `Balance` merge 進既有 shared vault → 零新物件（最省）。能合併的已合併、必須 fan-out 的才 fan-out。
- `MAX_RECIPIENTS=16` 兼任 gas 上界守門：worst-case 可預測封頂（16 coin + 1 fee + 1 event）。
- 無 batch-transfer 優化空間：distinct payee = distinct owned-object transfer，不可合併。event 的 `vector<RecipientPayout>` 是 indexer 真相來源，不可砍。

**Fail-loud**：`sui move test` 是抽象 instruction gas（不含 storage），無法給真實鏈上數字。真數字需 publish 到 devnet 跑真實 PTB 讀 `effects.gasUsed`，對 N=1/4/8/16 量 storageCost 斜率。**Blocked on**：devnet 測試 USDC coin（Circle 原生 USDC devnet 地址未確認）→ 併入 deploy task。

---

## 2026-06-16 — Indexer Phase 1：`ConfigCreated` event

**目的**：補合約 gap — `router::create_config_and_vaults` 原本 event-silent，indexer 無法發現新 config，也無法把 `VaultWithdrawn`（只帶 `vault_id`）join 回 config。

**改動**：
- `events.move`：加 `ConfigCreated has copy, drop { config_id, tax_vault_id, savings_vault_id, owner }` + `public(package) fun emit_config_created(...)`。仍是 leaf module（只依賴 `sui::event`），不破 events-as-leaf 拓樸。
- `router.move`：`create_config_and_vaults` 在 `wire_vaults` 後 emit。

**為什麼不放 bps snapshot**：bps 可被 `mutate_config` 改動（bump version），create-time 快照會 stale。point-in-time bps 改由 `SplitExecuted.config_version` + `ConfigMutated` 歷史鏈下重建。

**為什麼 IDs 取自物件**：`object::id(&tax_vault)` / `object::id(&savings_vault)` 直接取自剛 build 的物件，非 config 存的 vault-id 欄位 → 與 `wire_vaults` 順序解耦，emit 恆正確（belt-and-suspenders）。

**為什麼 `public(package)`**：外部 package 無法偽造 `ConfigCreated`，與其他事件同個 indexer 信任保證。

**驗證**：suite 58→60 PASS（events_tests + router_tests 各加 1）。move-code-quality 0 critical / 0 warning；sui-security-guard 無 finding（密鑰掃描乾淨、emit package-internal）；red-team 略過（無新金流邏輯）。

**Cross-ref**：`docs/superpowers/specs/2026-06-15-indexer-design.md` →「Required contract change (Move)」；plan `docs/superpowers/plans/2026-06-16-indexer-phase1-config-created.md`。

---

## 2026-06-16 — Indexer Phase 2（Rust ingest, `sui-indexer-alt-framework`）

> 非 Move code（Rust crate `indexer/creatorflow-indexer/`），但鏈上 BCS layout 對應記在此檔以便與 `events.move` 對照。Plan：`docs/superpowers/plans/2026-06-16-indexer-phase2-rust-ingest.md`。

### 對實裝 crate 現查 API 的修正（plan 寫於驗證前，故有出入；dev-rules：不依賴過期文件）

**Resolved framework rev = `testnet-v1.72.2`**（非 plan 的 v1.66.2）。
- v1.66.2 拉到 yanked transitive dep `core2 0.4.0`（經 multihash 0.17→multiaddr→mysten-network）→ 無法 resolve。bump 到 v1.72.2 繞過。
- v1.72.2 強制 `diesel ^2.3` / `diesel-async 0.8`（workspace 版本）；我方原 pin diesel 2.2 / diesel-async 0.5/0.6 全衝突，對齊到 2.3 / 0.8 才解。
- **diesel features 用 `postgres_backend`（非 `postgres`）**：`postgres` 會連 libpq C lib（`ld: library 'pq' not found`）。實際執行走 diesel-async（tokio-postgres，純 Rust），只需 Pg query backend。framework 自己也只開 `diesel/chrono`，不連 libpq。

**真實 framework API（Task 1 source-dive 結果，全部 grep 自 `~/.cargo/git/checkouts/sui-*/.../sui-indexer-alt-framework/src`）：**
- `Args` / `IndexerCluster` 在 `cluster` module，**非 plan 的 `cli`**。`Args: clap::Parser`，flatten 了 `IndexerArgs`/`ClientArgs`/`MetricsArgs`（含 `--remote-store-url`/`--rpc-api-url`/`--first-checkpoint`/`--last-checkpoint`，多帶 env）。
- `Processor::process(&self, &Arc<Checkpoint>)`，`Checkpoint = types::full_checkpoint_content::Checkpoint`：`.summary.sequence_number` / `.summary.timestamp_ms`（透過 Deref）、`.transactions: Vec<ExecutedTransaction>`、`tx.events: Option<TransactionEvents>`、`events.data: Vec<Event>`。`Event` 欄位 `.package_id: ObjectID`、`.type_: StructTag`（`.module.as_str()` / `.name.as_str()`）、`.contents: Vec<u8>`。tx digest = `tx.transaction.digest().base58_encode()`。
- Handler 用 **`pipeline::sequential::Handler`**（非 plan 的 postgres::handler）：`type Store = Db; type Batch = Vec<Row>(Default); fn batch(&self, &mut Batch, IntoIter<Value>); async fn commit(&self, &Batch, &mut postgres::Connection)`。**sequential bound 只有 `Processor`，不需 `FieldCount`**（FieldCount 只被 postgres concurrent blanket impl 要求）。
- 選 sequential 的真正理由（兌現 round-2「單一 watermark + 跨表原子」）：framework 文件明載 **commit + watermark 更新在同一 transaction，且 sequential 不對資料分塊** → 5 表單交易原子提交、`recipient_payout`→`split_executed` FK 不會跨 batch 斷。
- 啟動 wiring：`IndexerCluster::builder().with_args(Args::parse()).with_database_url(Url).with_migrations(&MIGRATIONS).build()` → `cluster.sequential_pipeline(handler, SequentialConfig::default())` → `cluster.run()` 回 `Service` → `service.join().await`。migrations 用 `diesel_migrations::embed_migrations!`（framework 另跑自己的 watermark migration）。

### BCS layout 修正（最關鍵，會汙染每一列）

**`SplitExecuted.recipient_payouts: vector<RecipientPayout>` 是第 4 個欄位**（`amount_in` 之後、`tax_amount` 之前，見 `events.move:52-63`）。plan 把 payouts 當「結尾 TODO」——BCS 是順序敏感的，放錯位會解碼錯位。mirror struct 已把 `Vec<RecipientPayoutEvent>` 放回 position 4。
- `RecipientPayout` 是**內嵌 vector**（非獨立 event）→ 解一次 `SplitExecuted` 同時產出 `split_executed` row + 攤平的 `recipient_payout` rows（`payout_idx` = vector index）。`classify()` 不路由 `RecipientPayout`。
- 欄位名不影響 BCS（只看 order/type）：`RecipientPayout.addr`、`VaultWithdrawn.to` 與 Rust mirror 的 `recipient` 名稱不同但 order/type 對齊即可。
- `ID`/`address` 皆 BCS = 32 raw bytes → `ObjectID`/`SuiAddress` 解碼後 `.to_canonical_string(true)` 直接得 `0x`+64hex lowercase（免手動 normalize，比 plan 的 parsed_json u64-string parse 穩）。
- **tx_digest 用 base58**（Sui canonical digest），**非 0x-hex** → Phase 3 API / e2e 比對必須同編碼。

### 其他踩雷
- diesel-async `sql_query` 不能一次送多條 SQL（`cannot insert multiple commands into a prepared statement`）→ commit 測試 setup 把 `up.sql` 按 `;` 切開逐條執行。
- commit 整合測試各自 DROP+CREATE 同一 DB → 必須 `--test-threads=1` 序列化跑，否則互相清表 race。

### Code review（外部獨立 Rust review，2026-06-16）
- **High（已修）**：金額 `as i64` 對 u64∈[2^63,2^64) 靜默 wrap 成負值 → 汙染營收 fact table。改 `to_i64()` checked `try_from`、溢位 fail-loud（單一 pipeline watermark 停滯告警，勝過靜默負值）。加 monkey test `amount_exceeding_i64_errs_not_silently_negative`。
- **Medium（驗證為 non-issue，不改）**：質疑 `SuiAddress::to_string()` 縮寫、與 ID 的 `to_canonical_string` 不一致破 join。實查 base_types.rs：`Display = "0x{}", Hex::encode([u8;32])` = 全 64-hex lowercase，與 ID 同格式。
- 其餘（ON CONFLICT 全覆蓋、FK insert 順序、無 hot-path panic、event_seq 語義）判定 sound。

### 驗證
- `cargo test --test parse`：**7/7 PASS**（BCS round-trip 含 payouts 攤平、ID normalize、dispatch、monkey：截斷 bytes→Err、零值、bps=10000 邊界、u64>i64::MAX→Err）。
- `cargo test --test commit -- --test-threads=1`（Docker PG）：**4/4 PASS**（跨表冪等、replay 插 0 列、空 batch、FK 既存 parent、batch 內重複 PK ON CONFLICT 收斂）。
- `cargo build --bin`：完整 binary 對真實 v1.72.2 API 編譯乾淨。
- Smoke run vs testnet（`--first-checkpoint 0 --last-checkpoint 5`、`CREATORFLOW_PKG=0x0`）：embedded migration 建好 5 業務表 + `watermarks`；`creatorflow` sequential pipeline 處理真實 checkpoint 並原子推進 watermark；業務列=0（無匹配事件）。
- **e2e（真實 ConfigCreated/SplitExecuted 入庫）blocked on deploy**（需先部署 package 拿到 PKG + 觸發交易），併入 deploy task。

### Cross-ref
spec `docs/superpowers/specs/2026-06-15-indexer-design.md`（§ingest + shared Postgres schema）。下一步 Phase 3：TS Drizzle mirror + Hono REST（`drizzle-kit pull` 對 live schema，plan 待寫）。

---

## 2026-06-18 — Testnet 部署 + 全 stack e2e 入庫驗證（原 blocker 解除）

### 部署 artifacts（testnet）
| 物件 | ID |
|------|----|
| PackageID | `0x0fda0d5bd9f042460d8ed51eaeaf2fd21e9d4baa74de75b031096516e047a656` |
| UpgradeCap | `0x56bcc6623cfd9c8c2127c133707a998f9feb66af0f379c021fd616308f736d40` |
| ProtocolConfig (shared) | `0x695297e727cd5fa636deff6578b3e5f53aa496ecd323248c1d072b58d9891bcc` |
| AdminCap | `0x6a37ee3320a2a4bc6c7d66763e8cb2eff07372399882c15fbd70c6c79c3f5000` |
| publish tx digest | `4AP6cNTE9n3y8SHQ7tTxSkw6do3MxoMEu3ctPU3ACWqY`（checkpoint 349708352） |
| 部署者 | `0x1509b5fdf09296b2cf749a710e36da06f5693ccd5b2144ad643b3a895abcbc4c` |

- gas 實耗 ~0.11 SUI（dry-run 估 111294800 MIST）。`init` 自動 share ProtocolConfig + transfer AdminCap。
- **原 blocker（Circle USDC testnet 地址）非真 blocker**：Move.toml 既有 `rev = release-2024-11-22T170906` 直接解析成功，build/test/publish 全過，無需手動填地址。
- **UpgradeCap 尚未轉 multisig**（hackathon testnet，單人持有；mainnet 前必做）。

### Smoke：建一個 SplitConfig（不需 USDC）
- PTB：`split_config::new_recipient`(@me, 8970bps) → make-move-vec → `option::none<StrategyRef>` → `router::create_config_and_vaults`（tax 500 / savings 500 / fee 30 / yield 0；sum=10000）。
- **踩雷**：`protocol_fee_bps` 有下界 `min_fee_bps=30`（init 預設），fee=0 會 abort `EFeeOutOfBounds`。
- 產出 config `0x5d2830...aa1f5`、tax_vault `0x25105c...f126a`、savings_vault `0xac67fc...c375f`（tx `4gVjj7...DNes`，checkpoint 349708975），emit `ConfigCreated` ✓。

### E2E 入庫（全 stack 打通）
- Rust indexer：清 watermark（前次 PKG=0x0 卡在 0）+ TRUNCATE 業務表，bounded backfill `--first-checkpoint 349708975 --last-checkpoint 349708975`（單 checkpoint）。
  - watermark 推進到 349708975；`config_created` 1 列，四欄位（config_id/owner/tax_vault_id/savings_vault_id）與鏈上 event 完全一致。
- REST API（`api/creatorflow-api`，DATABASE_URL→5433）：`GET /configs?owner=` 正確回傳該 config（含 txDigest、checkpointTimestampMs）；`/summary` count=0（尚無 split）。
- **結論**：鏈上 event → checkpoint → Rust framework ingest（PKG filter）→ Postgres → Hono REST 全鏈路驗證 OK。

### 待辦（剩餘覆蓋，Rule 12 fail-loud）
- **`execute_split` 熱路徑（SplitExecuted + recipient_payout）尚未 e2e**：需 testnet USDC（Circle faucet `faucet.circle.com`）。拿到 USDC 後跑一筆 split → 驗 `split_executed` + `recipient_payout` 攤平入庫 + `/summary` 非零。
- gas 真實絕對數字仍待 `execute_split` 實跑（目前僅 publish 的 0.11 SUI）。
- 環境備忘：indexer `.env` 已寫好（PKG + START_CHECKPOINT=349708352）；main.rs 的 checkpoint 來源走 framework CLI flag（`--remote-store-url`/`--first/last-checkpoint`），不讀 .env 的 SUI_REMOTE_STORE/START_CHECKPOINT（那兩個僅備忘）。api `.env` 不被 tsx 自動載入，跑 server 需 export DATABASE_URL。

## 2026-06-18 — `execute_split` 熱路徑全 stack e2e 完成

**上一段「待辦」已清掉第一項。** USDC **非 blocker**：active address（`0x1509b5fd…bc4c`）早已持有 99.94 顆 Circle native USDC（type `0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC`，正是合約綁的 type），毋須 Circle faucet。

- **PTB**（`sui client ptb`）：`--split-coins @USDC "[1000000]"` → `router::execute_split @config @protocol @tax_vault @savings_vault paid.0 false 0u64 @0x6`。
  - args：config `0x5d2830f1…aa1f5`（version=0、1 recipient=owner 8970bps、tax/savings 各 500bps、fee 30bps、yield 0/無 strategy）、protocol `0x695297e7…d9891bcc`、tax_vault `0x25105cd3…f126a`、savings_vault `0xac67fca0…c375f`。
  - `include_yield=false`、`expected_version=0`、clock `0x6`。
- **tx** `5uBZ9ZtEVs7j4cS3JWSdxRHNyPaCtRTedPvMYsBTisqn` @ckpt **349723298**，success，gas ~0.0037 SUI（含一次 split-coins）。emit 1× `SplitExecuted`。
- **split 數學守恆驗證**（amount_in=1_000_000）：fee 3000 + tax 50000 + savings 50000 + recipient 897000 = 1_000_000，**零 dust**。balance change USDC −100000（= tax+savings 進 vault；fee 與 recipient 因 treasury=owner=自己而回流）。
- **入庫**：bounded run `--first-checkpoint 349723298 --last-checkpoint 349723298`，watermark 349708975→349723298。`split_executed` 1 row（欄位全對：amount_in/tax_amount/savings_amount/protocol_fee_amount/yield_amount=0/yield_included=f/config_version=0）+ `recipient_payout` 1 row（recipient=owner、amount=897000、bps=8970），FK 完整。
- **REST 讀回**（`/configs/:id/splits`、`/summary`、`/collaborators/:addr/earnings`）全部一致；payout 走 4-tuple cursor（含 payoutIdx，Phase 3 F1 修正）正確攤平。
- **結論**：鏈上 hot path → checkpoint → Rust ingest（含 SplitExecuted 內嵌 recipient_payouts 攤平）→ Postgres → Hono REST 全鏈路 e2e **PASS**。Phase 1–3 indexer 全覆蓋（ConfigCreated + SplitExecuted/recipient_payout 雙路徑皆實測入庫）。
- **剩餘**：gas 真實絕對數字 = 本 tx ~0.0037 SUI（單 recipient、無 yield 的最小 split）；UpgradeCap 仍單簽待轉 multisig（mainnet 前）。
