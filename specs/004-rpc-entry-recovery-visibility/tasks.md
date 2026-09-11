---

description: "任务清单：RPC 入口可用性修复与「恢复能力」呈现"
---

# Tasks: RPC 入口可用性修复与「恢复能力」呈现

**Input**: `specs/004-rpc-entry-recovery-visibility/` 的设计文档

**Prerequisites**: [plan.md](./plan.md) · [spec.md](./spec.md) · [research.md](./research.md) · [data-model.md](./data-model.md) · [contracts/](./contracts/) · [quickstart.md](./quickstart.md)

**Tests**: **包含**。规格明确要求（FR-024…FR-027），且每条新守卫都要做**变红检查**。

**Organization**: 按用户故事分组。**US1（范围 A）与 US2（范围 B）没有共享代码**，
两条都是 P1，可各自独立实现、独立验收、独立交付。

## Format: `[ID] [P?] [Story] Description`

- **[P]**：可并行（不同文件、不依赖未完成的任务）
- **[Story]**：所属用户故事（US1…US4）
- 每条都带确切文件路径

---

## ⛔ 本期的显式禁止项（实施前先读）

> 来自 [plan.md](./plan.md) 的 Gate 一。违反任一条的代价是**五台机器全链重置**。

1. **不得**把探测位置、探测间隔或任何 healthcheck 取值写进 `blockchain/protocol.json`。
   加字段 ⇒ `configVersion` 递增 ⇒ stamp 守卫 ⇒ **七个节点退出 12 ⇒ 全链重置**。
   它们应当与既有 healthcheck 取值**同一处**：硬编码在生成器里。
2. **不得**改动 `max_fails` / `fail_timeout` / `proxy_next_upstream` / `zone` / `ip_hash` /
   三项超时（[R-02](./research.md)）。它们是 002 在 2026-09-09 **实测后**定下的。
   **T004 是这条的守卫** —— 没有它，"不动"只是一句承诺。
3. **不得**手改生成物（`blockchain/nodes/{local,lan}/rpc-proxy.conf`、
   `docker/compose/*.yml` 六份）。改生成器。
4. **不得**为了让新代码通过而放宽 002 / 003 的任何既有断言（FR-029）。
5. **不得**让恢复能力影响健康档位（FR-013）。**T020 是这条的守卫。**

---

## Phase 1: Setup

**Purpose**: 验收清单就位

- [X] T001 建 `specs/004-rpc-entry-recovery-visibility/checklists/dod.md`：宪法第十七条八项、
      **并在建表时逐条补齐编号标注**（`/speckit-analyze` 的 L1：24/34 条 FR、2/12 条 SC、
      V-06、C-3/C-4 在 tasks.md 里没有编号引用 —— 语义上基本都被覆盖，
      但本项目的 dod 是**按编号逐条核**的，编号断链会让回填时漏项）、
      12 条 SC 逐条、[recovery-capability 契约 §8](./contracts/recovery-capability.md) 的变红核对表 8 行、
      V-01…V-10（含 V-02b）、以及一节留给实施期缺陷（003 的 dod 记了 15 条，本期照办）

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: 两条 P1 都依赖的那一件事 —— **基线**。

- [X] T002 建 `specs/004-rpc-entry-recovery-visibility/baseline.md`，记下本期**开始前**的：
      `blockchain/protocol.json` 的 sha256 与 `configVersion`、创世哈希、
      两份 `rpc-proxy.conf` 的 sha256、六份 compose 里 healthcheck 那一行的原文、
      公开投影（`tools/dashboard/public-view.mjs`）的**字段集合**、
      七个节点容器的创建时刻

> **为什么这是 blocking 的**：SC-008（`protocol.json` 逐字节不变）、
> SC-011（公开投影字段集合逐字段相同）、FR-032（节点容器未重启）
> 全部是**与改动前比对**的判据。事后再抓，就只剩下推断 ——
> 而这个项目已经反复证明"推得出"不等于"验过"。

---

## Phase 3: US1 — 两个 Primary 全停时入口仍然可用 (Priority: P1)

**Goal**: 修掉「链好着但门坏了」。让代理的健康判定只回答"代理自己"。

**Independent Test**: 停两个 Primary，从每台机器经本机入口发 ≥10 笔交易，
全部确认、零次 5xx（SC-001）。**不需要 US2 的任何改动。**

### 守卫先行（TDD）

- [X] T003 [P] [US1] `tests/unit/proxy-health-boundaries.test.mjs`：静态守卫 ——
      ① `/ext/health` **不得**出现在 `render-compose.mjs` 的代理健康判定处，
      也不得出现在六份生成的 compose 里；
      ② 探测位置的配置块**不得**含 `proxy_pass`（C-1 的静态一半）。
      **扫源码前先剥注释** —— 003 期间这一条栽过三次，解释性注释里的字符串被当成了真配置
- [X] T004 [P] [US1] 扩 `tests/unit/rpc-proxy-failover.test.mjs`：断言
      `max_fails=1` / `fail_timeout=60s` / `proxy_next_upstream error timeout http_502 http_503 http_504` /
      `zone karmachain_rpc 64k` / `ip_hash` / `proxy_connect_timeout 2s` /
      `proxy_next_upstream_tries` / `proxy_next_upstream_timeout 15s` **逐字符不变**（R-02 / FR-010）

> T004 看着像"测试一个没改的东西"，但它正是**禁止项第 2 条**的守卫。
> 本期最容易做错的事，就是顺手把 `max_fails=1 fail_timeout=60s` 放宽 ——
> 那会把 002 已经解决的另一个问题放回来。

### 实现

- [X] T005 [US1] 改 `tools/protocol/render-rpc-proxy.mjs`：新增一个由 nginx **自己应答**的位置
      （`location = /_alive`，`return 200`），**不 `proxy_pass`**。
      注释里写明为什么它不碰上游（否则下一个人会"顺手"给它加个 `proxy_pass` 让它"更有意义"）
- [X] T006 [US1] 改 `tools/protocol/render-compose.mjs`（约 208 行）：代理的 healthcheck
      由 `/ext/health` 改指新位置。**六份 compose 的唯一来源** ——
      `local-local` 与 `lan-{win-1,win-2,ubuntu-1,ubuntu-2,ubuntu-3}` 一并生效（FR-009）
- [X] T007 [US1] `npm run render` 重新生成，`npm run render:check` 必须 10/10；
      逐份 diff 六个 compose 与两份 `rpc-proxy.conf`，确认**只有**预期的两处变化

### 行为判据

- [X] T008 [P] [US1] `tests/integration/proxy-health.test.mjs`：起一个最小 nginx + 假上游，
      让上游对探测路径回 503，断言**真实请求路径**不受影响（C-2 的可自动化一半）
- [!] T009 [P] [US1] `tests/e2e/proxy-entry-availability.test.mjs`：单机形态 ——
      上游综合健康位不健康时，① 入口仍能确认交易；② 代理健康位**保持 healthy**（C-5）

### 变红检查（每一条都要真做，结果记进 dod）

- [X] T010 [US1] 变红 ①：把配置改坏到无法加载 → 代理健康位转 `unhealthy`（V-02，quickstart D①）
- [X] T011 [US1] 变红 ②：杀掉 nginx 进程 → 转 `unhealthy`（V-02，quickstart D②）
- [X] T012 [US1] **反向确认**：全部上游不可服务 → **保持 `healthy`**（V-02b / C-5，quickstart D2）
- [X] T013 [US1] 变红 ③：把 `/ext/health` 加回生成器 → T003 必须失败
- [X] T014 [US1] 变红 ④：把 `max_fails=1` 改成 `max_fails=2` → T004 必须失败

> **T012 与 T010/T011 同等重要。** T010/T011 证明判据会变红，
> T012 证明它**不会在错误的时候变红** —— 两条合起来才说明职责划分真的落地了。
> 只做前者会漏掉本期最核心的那个纠正。

### 现场验收

- [X] T015 [US1] quickstart 场景 B：探测跑满数个 `fail_timeout` 周期后，
      上游日志里**没有**探测条目、代理日志里**没有** `no live upstreams` /
      `upstream server temporarily disabled`（C-1 / C-2）
- [X] T016 [US1] quickstart 场景 F：单个 L1 验证者失效时入口仍能确认交易（SC-006 / V-04）——
      **002 不回归**。这是本期最容易越界伤到的地方
- [~] T017 [US1] quickstart 场景 J：`git diff blockchain/protocol.json` 为空、
      `configVersion` 未递增、创世哈希不变、无节点因 stamp 退出 12（SC-008 / V-08）；
      对着 T002 的基线核对**节点容器未被重启**（FR-032）
- [X] T018 [US1] quickstart 场景 E（**需五台**）：两个 Primary 全停的 10 分钟窗口内，
      **每一台**机器各经本机入口发 ≥10 笔交易，全部确认、**零次 5xx**（SC-001 / V-03）。
      *（`/speckit-analyze` 的 I2：原先写"需三台"—— 三台只够**造出**场景
      （两台停 Primary + 一台发交易），而 SC-001 的判据是**每一台**都要发，
      因为"入口可用"是逐边界的性质，不是全局的。）*

**Checkpoint**: US1 到此可独立交付 —— 一个真实的可用性缺陷已修，且有会变红的守卫。

---

## Phase 4: US2 — 面板说出「现在别重启任何东西」 (Priority: P1)

**Goal**: 把「这张网还能不能自我恢复」说出来，且**不碰健康档位**。

**Independent Test**: 停两个 Primary → 档位仍 `normal/100%`，另有恢复能力提示；
只起回一个 → 提示仍在。**不依赖 US1 的任何改动。**

### 守卫先行（TDD）

- [X] T019 [P] [US2] `tests/unit/recovery-capability.test.mjs`：
      ① `servesPChain` 真值表**10 行逐行**（[data-model §1](./data-model.md)）；
      ② 门槛 `< 2`，含「只有一个在服务」这一格；
      ③ 传入 L1 验证者的行时**显式拒绝**（抛错或 `null`），**不得静默返回 `false`**
- [X] T020 [P] [US2] `tests/unit/recovery-tier-isolation.test.mjs`：恢复能力为 `blocked` 时，
      `tier` / `healthPercent` / `validatorMargin` / `domainMargin` / `participating` /
      `threshold` **逐字段**与 `ok` 时相同（FR-013 / V-07）
- [X] T021 [P] [US2] `tests/unit/recovery-copy.test.mjs`：文案必含「两个」与
      「不要重启」的意思、必含恢复顺序；**禁含**「数据可能丢失」「需要重置」「需要重建」
      「需要重新部署」。**文案本身不要写否定句** ——
      003 期间 `starting` 的文案写了「也不是"须处置"」，那个词触发了子串守卫；
      **当时的处理是改文案，不是改守卫**
- [X] T022 [P] [US2] `tests/unit/recovery-docs-parity.test.mjs`：面板文案与
      `docs/devnet.md` §9.5「恢复顺序」的**结论、门槛数字、顺序**一致（FR-023 / SC-010）
- [X] T023 [P] [US2] 改 `tests/unit/dashboard-public-view.test.mjs`：把断言改成
      **「字段集合与 T002 的基线逐字段相同」**（SC-011 / R-07）。
      不用「不含 recovery 字段」那种否定式 —— 它漏掉下一个新增字段

### 实现

- [X] T024 [US2] 改 `tools/dashboard/snapshot.mjs`：新增 `servesPChain(row)`，
      从既有 `state` + `countsAsOffline` 派生。注释里**并排**写清三个谓词的分工
      （[data-model §0](./data-model.md)）—— 这是同一个坑的第三种踩法，注释要挡住第四次
- [X] T025 [US2] 改 `tools/dashboard/snapshot.mjs`：新增 `recoveryCapability` 字段
      （`ok` / `blocked` / `unknown`）、第六类异常 `recovery-blocked`、
      以及 `ACTIONS` 表里对应的一行处置方向。
      门槛写**常量 `2`** 并注明它来自**权益门槛**而非"Primary 总数"（R-06 / data-model §2）
- [X] T026 [US2] 改 `tools/dashboard/public/copy.mjs`：恢复能力的文案（**零 import 纯函数**，
      沿用 003 的约定）。三个必含成分见 [recovery-capability 契约 §5](./contracts/recovery-capability.md)
- [X] T027 [US2] 改 `tools/dashboard/public/view-*.mjs`：呈现恢复能力。
      版式与「链已停止出块」的报警**可区分**（FR-021），遵守 003 的 FR-009 三通道
      （文案 + 版式 + 字形，**不只靠颜色**）；对比度满足 WCAG AA
- [X] T028 [US2] 扩 `tests/unit/dashboard-views.test.mjs`：六个视图 × 新增形态
      （`blocked` / `unknown` / 与 `stopped` 并存）都能 `render()` 而不抛。
      **003 的 456 个单元测试没有一个执行过 `render()`**，代价是用户在浏览器里
      看到「此视图渲染失败」—— 那个 DOM 桩已经在，接着用

- [X] T046 [P] [US2] `tests/unit/recovery-blind.test.mjs`：**观察者失明时不作任何断言**
      （FR-019）—— 断言 `observer.blind === true` 时 `recoveryCapability === 'unknown'`，
      且**不产生** `recovery-blocked` 异常；无论那一刻有几个 Primary 看起来在服务。

  *（编号在后：本条是 `/speckit-analyze` 的 C1 补上的，既有编号引用一律不动。）*

> **为什么这条不能省。** `unknown` 那个分支原先只在 T025 被实现、在 T028 被渲染，
> **没有任何一条测试断言它的行为** —— 而失明恰好是面板**知道得最少**的时刻。
> 一个在本机网线松了的时候仍然断言「别重启任何东西」的面板，
> 会把一次局部链路故障变成一次不必要的停手。003 把 `observer-blind` 定为
> **P1 优先级**就是为这个；本期差点把它漏掉。

### 行为判据

- [ ] T029 [P] [US2] `tests/e2e/recovery-capability.test.mjs`：单机形态下
      停 Primary → 提示出现；恢复 → 一个探测周期内消失

### 变红检查（每一条都要真做）

- [X] T030 [US2] 变红 ①：门槛改成 `= 0` → T019 的「只有一个在服务」那格必须失败。
      **这是本期最重要的一条变红检查** —— `= 0` 是从"两个都停了"这个现场最自然的错误归纳
- [X] T031 [US2] 变红 ②：让 `blocked` 时把 `tier` 降一档 → T020 必须失败
- [X] T032 [US2] 变红 ③：去掉 `unreachable` 的 `countsAsOffline === false` 分支 →
      真值表第 9 / 10 行必须失败（否则"一根网线松了就叫人别重启"）
- [X] T033 [US2] 变红 ④：文案去掉「两个」，或加入「需要重置」→ T021 必须失败
- [X] T034 [US2] 变红 ⑤：往公开投影加一个字段 → T023 必须失败
- [X] T035 [US2] 变红 ⑥：改动 `docs/devnet.md` §9.5 里的门槛数字 → T022 必须失败
- [X] T047 [US2] 变红 ⑦：让失明时**照常按 Primary 数判**（即删掉 `unknown` 那一支）→
      T046 必须失败。**这一条尤其要做** —— 判据从"五态之一"退化成"数个数"是最容易
      发生的简化，而它恰好在面板最不该说话的时候让面板说话

  *（编号在后：同 T046，来自 `/speckit-analyze` 的 C1。）*

### 现场验收

- [X] T036 [US2] quickstart 场景 G（**需三台**）分三步看**五份**面板：
      停两个 → 提示出现且档位不变；**只起回一个 → 提示仍在**；再起回另一个 → 自行消失
      （SC-002 / SC-003 / SC-004 / V-05）

> **第 2 步是整个场景的要点。** 它是 `< 2` 与 `= 0` 唯一能在**现场**区分的一步 ——
> 少了它，一个写错成 `= 0` 的实现会全程看起来正确。

**Checkpoint**: US2 到此可独立交付。

---

## Phase 5: US3 — 恢复后两者都自行清除 (Priority: P2)

**Goal**: 恢复路径不需要人工干预。

- [X] T037 [US3] quickstart 场景 G 第 1 步之后重启一个 L1 验证者；第 3 步之后它应在
      **≤60 秒**自行回到健康（SC-005 / 2026-09-10 基线约 36 秒），全程无人工干预
- [X] T038 [US3] 两个 Primary 恢复后，RPC 入口**立即**正常，
      **不需要**重建或重启代理容器（US3 场景 3）

---

## Phase 6: US4 — 照着面板就能按正确顺序恢复 (Priority: P3)

- [X] T039 [US4] 改 `docs/devnet.md` §10（面板）：加一节讲恢复能力，与 §9.5「恢复顺序」互指。
      两处的门槛数字与顺序由 T022 守着
- [ ] T040 [US4] quickstart 场景 M（SC-009）：请一名**未参与本期**的人，
      在两个 Primary 停着时打开面板、**不许查文档**，说出他要做的第一件事。
      期望「把两个 Primary 都启动」。**答错就改呈现，不改判据**

---

## Phase 7: Polish & Cross-Cutting

- [X] T041 [P] 建 `docs/adr/0011-proxy-health-answers-only-for-itself.md`（宪法第十四条）：
      记「代理健康位只回答代理自己」这个决定、**四条被否方案**
      （POST `eth_chainId` / 删 `http_503` / 拉长间隔 / 直接删掉 healthcheck）、
      以及**「`zone` 这个正确修复放大了另一个缺陷」**这条观察 ——
      它说明"每个改动单独都对"不等于"合起来也对"。进 `docs/adr/README.md` 索引
- [X] T042 [P] 改 `docs/devnet.md` 的部署步骤：说明本次变更**不需要重置链**（FR-033），
      只重建代理容器（`docker compose … up -d rpc`），节点数据卷不动。
      **写明这一点是为了防止有人出于谨慎去做一次不必要的重置**
- [ ] T043 quickstart 场景 K（R-08 / V-09）：`local` 与 `lan` **两种形态各验一次**。
      「在一台机器上验过」不等于「验过」—— 本期要修的缺陷当初能活下来正是因为这个
- [ ] T044 全套复跑：`npm test`（单元，应 ≥600 且**无既有断言被放宽**）、
      `npm run test:integration`、`npm run test:e2e`、`npm run render:check`、
      `npm run test:secrets`、`scripts/devnet-verify`；
      **另加一条机械判据**：`git diff --exit-code package.json package-lock.json`
      必须为空（**FR-030** 零新增依赖）。
      *（`/speckit-analyze` 的 C2：这一条此前在**任何**制品里都没有判据，只靠人记得 ——
      而它本来就该是机械的。）*
- [ ] T045 回填 `checklists/dod.md`：12 条 SC 逐条、变红核对表 8 行的**实际结果**、
      V-01…V-10 的实测数据、以及实施期缺陷一节。
      **凡未实测的一律不写"已达成"** —— 003 的 spec 里那句「不写"已交付"」照搬

---

## Dependencies

```
T001 (dod)
  └─ T002 (基线) ─── blocking ───┬─→ Phase 3 (US1)
                                  └─→ Phase 4 (US2)

Phase 3 (US1)：T003/T004 [P] → T005 → T006 → T007 → T008/T009 [P]
               → T010…T014（变红）→ T015…T018（现场）

Phase 4 (US2)：T019…T023 [P] → T024 → T025 → T026 → T027 → T028
               → T046 [P] → T029 → T030…T035 + T047（变红）→ T036（现场）

Phase 5 (US3)：依赖 US1 与 US2 都完成（它验的是两者的自愈）
Phase 6 (US4)：依赖 US2（要有东西可看）
Phase 7       ：T041/T042 [P] 随时可做；T043…T045 收尾
```

**US1 与 US2 相互独立** —— 没有共享文件，可并行推进，也可只交付其中一条。

---

## Parallel Execution Examples

**Phase 3 起手**（两条守卫不同文件）：

```
T003  tests/unit/proxy-health-boundaries.test.mjs
T004  tests/unit/rpc-proxy-failover.test.mjs
```

**Phase 4 起手**（五条守卫各自独立文件）：

```
T019  tests/unit/recovery-capability.test.mjs
T020  tests/unit/recovery-tier-isolation.test.mjs
T021  tests/unit/recovery-copy.test.mjs
T022  tests/unit/recovery-docs-parity.test.mjs
T023  tests/unit/dashboard-public-view.test.mjs（改）
T046  tests/unit/recovery-blind.test.mjs
```

**两条 P1 并行**：T003…T018（US1）与 T019…T036 + T046/T047（US2）之间无文件冲突。

**Polish 的文档两条**：T041（ADR）与 T042（devnet.md 部署步骤）。

---

## Implementation Strategy

**MVP = US1 单独交付**。它修的是一个**真实的可用性缺陷**：002 承诺过的容错场景下，
文档写明的 RPC 入口会间歇性 502。这一条修完就有完整价值，且不需要面板做任何改动。

**US2 同为 P1 但独立**。它修的是一个**信息缺口**，而那个缺口会让人做出破坏性动作
（在"看着健康"的时候重启验证者，把一个好着的节点变成一个永远起不来的节点）。
两条谁先做都行；若资源只够一条，先做 US1（功能缺陷优先于呈现缺口）。

**增量交付顺序**：Phase 1–2（基线）→ US1 → US2 → US3（自愈）→ US4（可用性）→ Polish。

**四处现场验收需要多台机器**：T018、T036、T037、T043 的 `lan` 一半。
当前（2026-09-11）五台机器均不可达 —— **代码与守卫可以先写完**
（它们跑在单元层与 `local` 形态），但**不得把"测试全绿"当成"缺陷已修"**：
范围 A 的缺陷当初能活下来，正是因为它只在跨机形态、只在两个 Primary 全停时才显形。

---

## 任务统计

| 阶段 | 任务数 | 其中变红检查 | 需要多台机器 |
|---|---|---|---|
| Phase 1 Setup | 1 | — | — |
| Phase 2 Foundational | 1 | — | — |
| Phase 3 US1（P1） | 16 | 5 | T018（**五台**） |
| Phase 4 US2（P1） | 20 | 7 | T036 |
| Phase 5 US3（P2） | 2 | — | T037 |
| Phase 6 US4（P3） | 2 | — | — |
| Phase 7 Polish | 5 | — | T043 |
| **合计** | **47** | **12** | **4** |
