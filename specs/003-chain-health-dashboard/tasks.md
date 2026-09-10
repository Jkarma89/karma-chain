---
description: "任务清单 —— 链状态与验证者网络实时监控面板"
---

# Tasks: 链状态与验证者网络实时监控面板

**Input**: Design documents from `/specs/003-chain-health-dashboard/`

**Prerequisites**: [plan.md](./plan.md)、[spec.md](./spec.md)、[research.md](./research.md)、[data-model.md](./data-model.md)、[contracts/](./contracts/)

**Tests**: **包含**。宪法第八条要求实现前先定义验证方法；且本特性九个判定层中有两层（观察者失明、全员启动中）在活链上很难制造，只能靠纯函数单元测试守住。

**Organization**: 按用户故事分组，每组可独立实现与独立验证。

## Format: `[ID] [P?] [Story] Description`

- **[P]**：可并行（**不同文件**、无未完成依赖）
- **[Story]**：所属用户故事（US1…US6）；Setup / Foundational / Polish 阶段无故事标签
- 每条含确切文件路径
- **`[~]`** = 部分完成：自动化那一半已做完，剩下的部分需要多台机器配合或人工判断。剩余内容在该条目内就地注明，并汇总在 [checklists/dod.md](./checklists/dod.md) 第五节。**刻意不标成 `[X]`** —— 把待人工验收记成已完成，就等于把验收缺口藏起来。
- **带字母后缀的 ID**（如 `T013a`、`T032a`）是 2026-09-10 `/speckit-analyze` 之后**就地插入**的任务。刻意不重编号：重编号会打断本文件下半部依赖图与策略章节里的全部交叉引用，而后缀能保留执行顺序的可读性（spec.md 的 `FR-004a` 同一惯例）

## Path Conventions

沿用仓库既有布局（plan.md 的 Structure Decision）：判定与服务代码进 `tools/dashboard/`，入口脚本进 `scripts/` 并 `.sh`/`.ps1` 成对，测试按 `tests/{unit,integration,e2e}/` 三层分置。**不新建顶层目录。**

## 交付分期对照

| 阶段 | 内容 | 可独立交付 |
|---|---|---|
| Phase 1–2 | 目录骨架、入口脚本、**L1–L8 判定层**、观测层、服务骨架 | 否（阻塞全部故事） |
| Phase 3（US1） | 三档健康度与报警 + 人工探活 | **是 —— MVP** |
| Phase 4（US2） | 逐节点明细与 Primary 分组 | 是 |
| Phase 5（US3） | 10 秒发现 + 链路故障/失明的区分 | 是 |
| Phase 6（US4） | 边界视图与异常四类分类 | 是 |
| Phase 7（US5） | 链身份与分叉检测 | 是 |
| Phase 8（US6） | 对外精简视图 | 是 |
| Phase 9 | 文档、ADR、quickstart 实测回填、002 回归、DoD | 否（收尾） |

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: 目录骨架与入口脚本

- [X] T001 创建 `tools/dashboard/` 与 `tools/dashboard/public/`，各放一份 README 说明职责边界：判定层是纯函数、服务层负责采集与托管、前端**只渲染**（不做判定、不直连节点、不持有密钥）
- [X] T002 [P] `package.json` 增加 `dashboard` 脚本（`node tools/dashboard/server.mjs`），并在 `README.md` 命令表增加 `devnet-dashboard` 一行。**脚本先落位，被指向的文件由 T021 提供** —— 这中间 `npm run dashboard` 会报文件不存在，属预期
- [X] T003 [P] `scripts/devnet-dashboard.sh`：沿用 `scripts/devnet-status.sh` 第 87–90 行的 `docker run --rm --network "$(devnet_node_network "$DOMAIN")" -v "$(pwd):/workspace"` 模式并加 `-p`；参数 `--port`（默认 21680）/ `--interval`（默认 2）/ `--deployment`。网络名**必须**由 `devnet_node_network` 推导 —— 002 在此写死过两次
- [X] T004 `scripts/devnet-dashboard.ps1`：与 T003 等价。（**无 [P]**：末尾那条 `git update-index` 作用于 T003 创建的 `.sh`，须在其后）注意 002 的既有坑：`Set-StrictMode` 会泄漏进第三方 `.ps1`、`$ErrorActionPreference='Stop'` 会把原生 stderr 升级成终止性异常（用 `_devnet-common.ps1` 的 `Invoke-Quiet`）；并用 `git update-index --chmod=+x scripts/devnet-dashboard.sh` 保证 git 索引里是 100755（既有 `tests/unit/powershell-portability.test.mjs` 校验成对与索引模式，读的是 git 索引而非文件系统）

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: 判定层 **L1–L8**、观测层与服务骨架 —— 全部用户故事的共同前提。（研究 R-05 的第九层 **L9 人工探活**归 US1 的 T032a–T034；L5 逐节点创世哈希拆在 T014 与 T019）

**⚠️ CRITICAL**: 本阶段完成前任何用户故事都不能开工

### 契约先落成测试（宪法第八条）

> **这四个文件必须先写并确认全部失败**，再动实现。它们是 `contracts/health-tier.md` 与 `data-model.md` 的机械转录，不是事后补的。

- [X] T005 [P] `tests/unit/dashboard-tier.test.mjs`：把 `contracts/health-tier.md` 第 4 节的 **13 行真值表**逐行转成用例，外加第 9 节的**九条「坏了会变红吗」对照** —— 其中必须包含：P1 优先于 P3（0 可达 → `observer-blind` 而非 `stopped`）、P2 优先于 P3、**P4 不得越过 P3**（否则 `stopped` 永不触发，是一个永不变红的报警）、n=9/f=2 时档位整体移位（threshold=7；9/9 与 **8/9 都是 `normal`**、7/9 才是 `zero-margin`（78%）、6/9 是 `stopped`（67%）—— 要点是**百分比本身从来不是判据**，SC-016）、高度完全不变时档位逐字节相同
- [X] T006 [P] `tests/unit/dashboard-domain-margin.test.mjs`：`contracts/health-tier.md` 第 5 节的 **5 行边界余量表**，必须含"声明 5 边界但三台共享一路供电 → 并查集合成 3 组 → 边界余量 0"这一行 —— 它证明用的是 `effectiveDomains` 而非声明的 `failureDomains`（`load.mjs:259` 注释所说的「在现实里为假的绿灯」）
- [X] T007 [P] `tests/unit/dashboard-incident-class.test.mjs`：`data-model.md` 第 5 节的五类映射；断言 9 个 `state` 取值各自落进确定的分类、`healthy` 不产生异常条目、无取值落进未定义分类
- [X] T008 [P] `tests/unit/node-status-genesis.test.mjs`：R-07 回归 —— `probe.genesisHash` 为 `null` 时，`classify()` 对 9 个状态的判定与加字段前逐一相同；`readContainers` 加 `export` 后 `collect()` 的输出结构不变

### 判定层（纯函数，不读文件、不发请求、不看时钟）

- [X] T009 `tools/dashboard/snapshot.mjs` 实现 `participatesInConsensus(row)`：按 `data-model.md` 第 0 节的表。**不得**直接复用 `countsAsOffline` —— 它的 `NOT_OFFLINE` 含 `bootstrapping`，会把"1 个健康 + 4 个引导中"算成 100%（假绿灯）
- [X] T010 `tools/dashboard/snapshot.mjs` 实现 `deriveTier({ rows, faultTolerance, observer })`：P1…P5 严格优先级。`threshold = validatorCount - maxOfflineValidators`、`healthPercent = round(participating / validatorCount * 100)`，**零字面阈值**（75 / 0.75 / 80 / 60 / 5 一个都不许出现）
- [X] T011 `tools/dashboard/snapshot.mjs` 实现 `domainMargin`：`effectiveDomains` 按 `validators` **降序**贪心，并扣掉当前已不参与的数量。取最坏边界，不取平均
- [X] T012 `tools/dashboard/snapshot.mjs` 实现 `incidentClass(row)` 与 `buildIncidents(snapshot)`：产出机器可读的枚举（不是自由文本），每条带处置方向
- [X] T013 `tests/unit/dashboard-no-hardcode.test.mjs`：扫描 `tools/dashboard/**` 源码，禁止出现 75 / 0.75 / 80 / 60 与验证者总数 5 的字面量（沿用既有 `tests/unit/no-hardcode.test.mjs` 的做法）。**这道守卫本身要能变红** —— 加一条反向用例喂一段含 `0.75` 的假源码，断言扫描会报错。（**无 [P]**：它扫描 T009–T012 的产物，须在其后）
- [X] T013a `tests/unit/dashboard-boundaries.test.mjs`：三条**静态边界守卫**，扫描 `tools/dashboard/**` 源码禁止出现——
      ① `/ext/health` → 守住 **FR-013**（不得采用节点自报的综合健康位）。**这一条是补上的关键缺口**：FR-013 原先唯一的守卫是 T038，而它在跨机形态下**必然跳过**（两个 Primary 分处两台机器），于是实际部署上这条规则一个长期运行的守卫都没有。而 quickstart 场景 F 自己写着"这条免疫是继承来的，但必须由本场景守住" —— 恰好是会跳过的那个场景
      ② `child_process` / `execFile` / `spawn` / `docker` → 守住 **FR-030**（核心判据不得依赖 docker 访问）与 **FR-032**（不得对节点执行任何操作类动作）。这两条都是"不得有某能力"型要求，原先**零守卫**
      ③ 反向用例：分别喂含 `/ext/health` 与含 `spawn(` 的假源码，断言扫描会报错 —— 否则这道守卫本身就是个不会变红的守卫

### 观测层

- [X] T014 `tools/inspect/node-status.mjs`：`probeNode()` 增加 `eth_getBlockByNumber("0x0", false)` 子请求，产出 `probe.genesisHash`；沿用文件内既有的"子请求失败不影响其余判定"写法。**不改 `collect()`** —— `devnet-status` 仍需要它的一次性语义
- [X] T015 `tools/inspect/node-status.mjs`：给 `readContainers()` 加 `export`，并加一个**只为测试留的可选入参**（原始 JSON 文本，默认仍读 `.devnet/containers.json`）—— **TTL 与旧格式的判定行数一字不动**。加接缝的理由：那段判定恰好是 2026-09-09 咬过我们的逻辑（一份两天前的旧文件把停掉的本机节点误报成整域缺席），而它原先无法离线测试；仓库对此已有先例（`_devnet-common.ps1` 的 `KARMACHAIN_ENV_FILE` 注明只为测试留的接缝）。导出的理由见 R-07 改动二：面板拿不到容器事实时，在本机停掉唯一验证者会误报「整域缺席，去看那台机器」—— 而人正站在那台机器上
- [X] T016 `tools/dashboard/poll.mjs` 实现 `pollOnce({ nodes, blockchainId, prev, intervalSeconds })`：一轮并行 `probeNode` + `classify`，用**上一轮**高度当 `prevHeight`、真实间隔当 `sampleSeconds`。**无采样休眠**（`collect()` 的 3 秒 `setTimeout` 是一次性命令才需要的）
- [X] T017 `tools/dashboard/poll.mjs` 实现 `observerViewpoint()`：`reachableNodes` / `blind`（=== 0）/ 逐边界 `pathAlive` —— 对该边界已发布的 RPC 端口取**任何** HTTP 应答（含 502/504）即算路径通。`pathAlive` 只改措辞，**永不改档位**
- [X] T018 `tools/dashboard/snapshot.mjs` 组装 `Snapshot`（`data-model.md` 第 7 节全字段）；`collectedAt` 在**探测完成时**打戳，不是请求到达时
- [X] T019 `tools/dashboard/snapshot.mjs` 组装 `chainIdentity`：读 `blockchain/protocol.json` + `blockchain/chain-identity/karmachain.identity.json` + `blockchain/genesis/karmachain.genesis.hash`；`genesisMatchesBaseline` 保持**三值**（`null` ≠ `false` —— 取不到当成不匹配会虚报分叉，而虚报一次这条警报就再没人信）
- [X] T020 `tools/dashboard/snapshot.mjs`：容器事实降级的**快照侧标记** —— 无 / 旧格式 / 过期时，快照带一个显式字段说明"本机节点的 `stopped` 与 `unreachable` 已退化为后者"，**不静默接受**（FR-030 的"缺失不得使核心判据降级"要求它可见）。**呈现侧在 US1 的 T029a** —— Phase 2 不得渲染到 US1 才创建的 `view-health.mjs`

### 服务骨架

- [X] T021 `tools/dashboard/server.mjs`：`node:http` 服务；静态托管 `tools/dashboard/public/`；轮询循环；`GET /api/snapshot` **恒返回 200**（观测失败是快照的**内容**，不是 HTTP 错误）；间隔 > 6 秒时拒绝启动并说明理由（FR-018 的预算推导：间隔 + 4 秒探测超时 ≤ 10 秒）
- [X] T022 [P] `tests/integration/dashboard-server.test.mjs`：首轮未完成时返回 `collectedAt: null` / `tier: null`（而非一个看起来正常的空快照）；探测失败仍 200；`--interval 7` 被拒绝启动；静态资源可取；退出码 10 = 前置条件未满足（与 `devnet-status` 同码同义）

**Checkpoint**: 判定层与服务骨架就绪，用户故事可开工

---

## Phase 3: User Story 1 - 一眼判断"链现在还好吗" (Priority: P1) 🎯 MVP

**Goal**: 打开面板即可看到健康度百分比与三档，"已停止"档显目报警并说明成因与恢复所需；另有人工触发的"立即探活"。

**Independent Test**: 在活链上依次停 1 个、2 个 L1 验证者并恢复，观察百分比与档位，同时用实际交易确认链的真实出块能力与面板所报一致。

### Tests for User Story 1

- [X] T023 [P] [US1] `tests/e2e/dashboard-detection.test.mjs`：停本机 1 个验证者 → **≤10 秒**内快照 `tier === 'zero-margin'`、`healthPercent === 80`；同一时刻实际提交的交易**能**确认（SC-002）。恢复后 ≤10 秒回 `normal` / 100（SC-004）
- [X] T024 [US1] `tests/e2e/dashboard-detection.test.mjs`（**同文件，故无 [P]**）：`catching-up` 期间档位与百分比**不变**（SC-010 的档位部分）。恢复中的节点会短暂经过 `bootstrapping` → `catching-up`，断言这两个阶段都不触发档位下降
- [X] T025 [P] [US1] `tests/e2e/dashboard-idle.test.mjs`：空闲窗口内（默认 3 分钟，可由环境变量拉长）高度不变 → 档位、百分比、异常条目**逐字节相同**（SC-008 的自动化部分；10 分钟的完整判据在 quickstart 场景 G 手工执行）
- [X] T026 [P] [US1] `tests/e2e/dashboard-readonly.test.mjs`：面板运行一个窗口且**不点探活** → 高度零增长（SC-017 的自动化部分；30 分钟判据在 quickstart 场景 H 手工执行）
- [X] T026a [P] [US1] `tests/unit/dashboard-copy.test.mjs`：逐档位断言**必含短语与禁止短语** —— `zero-margin` 必含"仍在正常出块"且**禁含**"链已停止"及其同义表述；`stopped` 必含成因（查询门槛）、恢复所需、"安全停摆"，且**禁含**"数据可能丢失""需要重置"；`observer-blind` 必含"先检查本机"且**禁含**"链已停止"（SC-006 的文案部分）；`starting` **禁含**"已停止""须处置"。**这一条补的是一个原先完全没有守卫的缺口**：FR-008 / FR-020 / SC-006 的判据本质是"文案里不得出现某些话"，而原先只有 T030 / T048 两个**实现**任务，没有任何测试断言这些禁止词缺席 —— 正是 002 反复总结的"不会变红的守卫"形态。前提是文案先抽成纯模块（见 T030）
- [X] T026b [P] [US1] `tests/integration/dashboard-probe.test.mjs`：`POST /api/probe` 的判据（原先**零测试**，SC-018 无对应任务）—— 返回结构（`confirmed` / `blockNumber` / `elapsedMs` / `txHash` / `error`）；单飞并发保护（第二个请求返回"已有探活在进行中"而**不发第二笔**）；链处于 `stopped` 档时返回 `confirmed: false` 与超时原因而**不是** HTTP 错误；响应体与服务日志中**不含**任何私钥材料
- [X] T026c [P] [US1] `tests/e2e/dashboard-stopped-tier.test.mjs`：**SC-003 原先只有手工路径（T071 / T073），无自动化任务。** 停 2 个验证者 → ≤10 秒内 `tier === 'stopped'`、`healthPercent === 60`，且同一时刻实际提交的交易**确实无法确认**。跨机形态下每台机器仅 1 个验证者（T-5 保证），本机造不出 2 个离线 —— 复用 002 已建好的 `tests/e2e/lib/devnet.mjs` 的 `pickLocalVictims` / `localVictimSkip` / `MAX_OFFLINE_VALIDATORS`，**带说明跳过**（与 T038 同一形态），让缺口**可见**而非静默消失，并指向 quickstart 场景 C 的两机人工做法

### Implementation for User Story 1

- [X] T027 [US1] `tools/dashboard/public/index.html`：主视图骨架 —— 健康度百分比、档位、验证者级余量、边界级余量、新鲜度
- [X] T028 [US1] `tools/dashboard/public/style.css`：三档呈现。显目性走**文案 + 版式 + 图形符号**三通道，**不依赖颜色单通道**（FR-009）—— 色觉差异、投屏偏色、黑白截图三种常见情形都会让纯颜色编码失效
- [X] T029 [US1] `tools/dashboard/public/app.mjs`：**只做三件事** —— 轮询 `/api/snapshot`、按 `?view=` 路由到视图模块、装配 DOM。**不做任何判定**（档位、百分比、余量、分类全部取自快照），**也不做任何具体视图的渲染**（那些在 `view-*.mjs` 里）。这是 I3 的落地：原先 14 条任务横跨六个故事改同一个 `app.mjs`，与本文件"同一文件的任务必须串行"的规则直接冲突
- [X] T029a [US1] `tools/dashboard/public/view-health.mjs`：健康度主视图 —— 百分比、档位、两个余量、新鲜度、探活按钮；并呈现 T020 打在快照上的**容器事实降级标记**（呈现侧归此处，因为本文件到 US1 才存在）
- [X] T030 [US1] `tools/dashboard/public/copy.mjs`：把全部档位与状态文案抽成**纯模块**（零 import，Node 与浏览器都可 import），供 T026a 断言必含与禁止短语 —— 不抽出来就无法测，而这些判据的本质正是"文案里不得出现某些话"。判据来自 `contracts/health-tier.md` 第 6 节：`zero-margin` **必须**写"链仍在正常出块"且**不得**出现"链已停止"或同义表述；`stopped` 必须写成因（连接权益低于 α/k 查询门槛）+ 恢复所需（至少再恢复几个验证者）+ "安全停摆：不分叉、区块零回滚、恢复后自动继续"，且**不得**写"数据可能丢失""需要重置"
- [X] T031 [US1] **实现落在 `tools/dashboard/public/app.mjs` 的顶栏**（原计划 `view-health.mjs`）：新鲜度是**整页**的属性，不是健康度视图的一部分 —— 取不到快照时所有视图都陈旧，放进某一个视图会让其余视图静默显示旧值。`view-health.mjs` 只负责其中的容器事实降级告知。新鲜度呈现（`data-model.md` 第 7 节三档）：正常显示"N 秒前"；> 3 × 间隔 显目标为陈旧；取不到快照时显示上次成功时刻并标注 —— **不得**空白或静默保留旧画面
- [X] T032 [US1] `tools/dashboard/public/index.html` 常驻一句说明：本链**按需出块**，无交易即无区块，高度停滞不是活性信号（FR-015）
- [X] T032a [US1] `specs/003-chain-health-dashboard/security-probe-tx.md`：**宪法第四条要求的安全分析**（`/speckit-analyze` 判定的唯一 CRITICAL）。第四条明文：「任何涉及 **Key Management** 的修改都必须进行安全分析」「不能因为“只是改几行代码”就跳过安全审查」。本特性虽**不新增密钥**，却**新增一条密钥使用路径** —— 面板服务读取私钥并签名交易。须逐项分析：密钥读取时机与内存驻留时长；响应体 / 服务日志 / 快照 / 公开投影四个泄漏面各自如何封堵；签名失败与超时路径是否会带出密钥；为何宪法第四条 v1.1.0 例外的四项条件覆盖此用途（公开已知 + `DEVELOPMENT ONLY` 标记 + 秘密扫描白名单 + 生产技术上不可能接受）；以及「面板无鉴权 + 一个会写链的端点」这一组合在局域网内的风险边界。结论回写 plan.md 第四条那一行
- [X] T033 [US1] `tools/dashboard/probe-tx.mjs`：人工探活。复用 `tools/verify/checks/chain.mjs` 的 transfer 判据；私钥取自 `blockchain/accounts/dev-accounts.json` 且**只在服务端使用**，不得出现在响应、页面、快照或日志；单飞并发保护（第二个请求返回"已有探活在进行中"，避免 002 踩过的并行 nonce 间隙导致 `WaitForTransactionReceiptTimeoutError`）
- [X] T034 [US1] `tools/dashboard/server.mjs` 的 `POST /api/probe` 端点 + `view-health.mjs` 的按钮：点击先告知"这会向链写入：消耗开发账户余额、产生一个区块"，确认后才发（FR-035）。`stopped` 档时返回 `confirmed: false` 与超时原因，**不是** HTTP 错误
- [X] T035 [US1] `tools/dashboard/public/view-health.mjs` 明示两类活性判断的区别：由验证者计数**推断**的"应当能出块"（自动、持续、只读）vs 由探活交易**实测**的"确实能出块"（人工触发、一次性）。**不得**把前者表述为后者（FR-036）

**Checkpoint**: US1 可独立交付 —— 一个正确的三档健康度已能回答"要不要现在起床处理"

---

## Phase 4: User Story 2 - 看清每个节点是谁、在哪、什么状态 (Priority: P2)

**Goal**: 逐节点明细 + Primary 单独成组。

**Independent Test**: 对照 `blockchain/protocol.json` 与在五台机器上各自运行 `devnet-status` 的结果，逐节点核对身份、边界、状态、高度。

### Tests for User Story 2

- [X] T036 [P] [US2] `tests/integration/dashboard-nodes.test.mjs`：快照的 7 个节点、5 个边界、逐边界的平台与地址与 `blockchain/protocol.json` **逐项一致**；节点数、角色、地址均无硬编码（SC-009）
- [X] T037 [P] [US2] 同文件：把 `topology.activeDeployment` 切到 `local` 后**无需改代码**即得 1 个边界 / 7 个节点（SC-009 后半、FR-003）
- [X] T038 [P] [US2] `tests/e2e/dashboard-primary-loss.test.mjs`：两个 Primary 全停 → L1 健康度仍 100%、链正常出块、Primary 分组单独显示不可用、**不报**"全部节点不健康"（SC-007）。**跨机形态下必然跳过**（两个 Primary 分处 ubuntu-1/ubuntu-2，docker 只能操作本机容器）—— 跳过时须说明原因并指向 quickstart 场景 F 的人工做法，沿用 002 `tests/e2e/primary-network-loss.test.mjs` 的 skip 写法

### Implementation for User Story 2

- [X] T039 [US2] `tools/dashboard/public/view-nodes.mjs` 节点表：`id` / 角色 / 边界 / 平台 / 地址 / 状态 / 高度 / 落后量 / peers / `detail`
- [X] T040 [US2] `tools/dashboard/public/view-nodes.mjs` Primary 分组单独呈现，并注明它们不计入 L1 健康度百分比的原因（不参与 L1 出块，研究 R-09）（FR-014）
- [X] T041 [US2] `tools/dashboard/public/view-nodes.mjs` 的 `catching-up` 行显示落后量与追赶速率（既有 `classify` 的 `detail` 已给出 `落后 N 块，+M/min, ~Km`，前端只做呈现）
- [X] T042 [US2] `tools/dashboard/public/view-nodes.mjs` 节点间高度不一致时逐节点显示落后量（FR-016）

**Checkpoint**: US1 + US2 各自独立可用

---

## Phase 5: User Story 3 - 10 秒内发现下线，且不把链路故障误报成下线 (Priority: P2)

**Goal**: 「本机视角不可达」与「节点下线」在界面上明确区分；观察者失明时绝不报"链已停止"。

**Independent Test**: 只阻断观察者到某一个节点的连接（该节点继续运行、继续被其余节点看见），观察面板是否标为「本机视角不可达」且健康度不变；再真正停掉一个节点，观察是否判为下线并计入。

### Tests for User Story 3

- [X] T043 [P] [US3] `tests/unit/dashboard-blindness.test.mjs`：0 可达 → `observer-blind`；**0 可达且恰有节点停在 `bootstrapping`** → 仍是 `observer-blind`（专门守 P2 不得越过 P1 —— 否则会报"启动中"而掩盖"面板自己瞎了"）
- [X] T044 [US3] `tests/unit/dashboard-blindness.test.mjs`（**同文件，故无 [P]**）：`pathAlive` 的两种组合各自的措辞分支；断言 `pathAlive` **不改变**档位（它只改措辞）
- [X] T045 [P] [US3] `tests/e2e/dashboard-link-fault.test.mjs`：只阻断观察者到某节点 HTTP 端口（**不动** staking 端口，其余节点因此仍看得见它）→ 该节点为「本机视角不可达」、健康度保持 100%、余量保持 1、全程无报警（SC-005）。Windows 的 WFP 对被封端口静默丢弃（不回 RST），因此会等满 4 秒探测超时 —— 断言须容纳这个耗时
- [X] T046 [P] [US3] `tests/integration/dashboard-interval.test.mjs`：间隔 2 秒时快照 `age` 的上界；间隔 7 秒时启动被拒（守住 FR-018 的预算推导）

### Implementation for User Story 3

- [X] T047 [US3] `tools/dashboard/public/view-observer.mjs` 的「本机视角不可达」呈现：与「节点下线」**明显区别**，文案写"其余 N 个节点仍报告看得见它 —— 是本机到它的网络路径问题，不是节点故障"，处置方向指向"修本机的网络路径，别去动那台机器"
- [X] T048 [US3] `tools/dashboard/public/view-observer.mjs` 的 `observer-blind` 呈现（文案取自 T030 的 `copy.mjs`，由 T026a 断言禁止词缺席）：整幅提示 + "先检查本机网卡与交换机" + `pathAlive` 的佐证结论（"五台机器端口全无应答，更像本机网络问题" / "到 N 台机器的路径是通的，节点确实不应答"）。**全程不得**出现"链已停止"
- [X] T049 [US3] `tools/dashboard/public/view-observer.mjs`：各节点说法不一致时呈现"各节点各自的数值"，**不合并**为单一可能错误的结论（FR-023 / SC-021）
- [X] T050 [US3] `tools/dashboard/public/view-observer.mjs` 把 `starting` 档呈现为"启动中"并列出尚未就绪的边界 / "只看见 N/M 个对等验证者"（FR-017）—— 既有 `classify` 在 `bootstrapping` 分支已产出该口径的 `detail`

**Checkpoint**: 报警可信 —— 网络故障不再产生假报警

---

## Phase 6: User Story 4 - 边界级容错余量与异常分类 (Priority: P3)

**Goal**: 两个余量并列可见；异常按四类分组，每类给处置方向。

**Independent Test**: 与 `scripts/devnet-topology.sh` 的边界并查集与 T-5 判定逐项核对；构造两个验证者同边界的拓扑输入，确认边界余量降为 0。

### Tests for User Story 4

- [X] T051 [P] [US4] `tests/integration/dashboard-topology-parity.test.mjs`：面板的边界数、有效边界数、边界余量与 `scripts/devnet-topology.sh --deployment lan` 的判定逐项一致（当前应为 `[OK] 可容忍 1 个边界整体失效`）
- [X] T052 [P] [US4] `tests/unit/dashboard-incidents-complete.test.mjs`：任一异常条目都带四类之一的分类，**无未分类条目**（SC-020）

### Implementation for User Story 4

- [X] T053 [US4] `tools/dashboard/public/view-domains.mjs` 故障边界视图：5 个边界，各自的平台 / 地址 / 承载节点 / 验证者数 / 共享失效因素
- [X] T054 [US4] `tools/dashboard/public/view-domains.mjs` 两个余量并列显示；两者不同时说明成因（"该边界承载 2 个验证者，一旦整体失效将同时失去 2 个 > 可容忍的 1 个"）（FR-010）
- [X] T055 [US4] `tools/dashboard/public/view-domains.mjs` 异常按四类分组，每类给处置方向（观测故障 → 修本机网络；单节点基础设施 → 去那台机器；同步落后 → **等**，不是故障；共识余量不足 → 恢复验证者数量）（FR-022）
- [X] T056 [US4] `tools/dashboard/public/view-domains.mjs`：`local` 形态下边界余量显示 0，并明确说明"该形态不做整机失效容错承诺"（`contracts/health-tier.md` 第 5 节第 3 行）

---

## Phase 7: User Story 5 - 链身份与跨机一致性（分叉检测）(Priority: P3)

**Goal**: 链身份可见；逐节点校验创世哈希，不一致即显目报出，且该判定独立于健康度。

**Independent Test**: 五个节点创世一致时确认不报分叉；人为让一个节点使用不同创世后确认显目报出。

### Tests for User Story 5

- [X] T057 [P] [US5] `tests/unit/dashboard-fork.test.mjs`：某节点 `genesisMatchesBaseline === false` 而全部参与共识 → 档位仍 `normal`、`healthPercent` 仍 100、`forkDetected === true`（分叉不改健康度，FR-025）
- [X] T058 [US5] `tests/unit/dashboard-fork.test.mjs`（**同文件，故无 [P]**）：`genesisMatchesBaseline === null`（未取到）**不触发**分叉警报，只登记 `unknownGenesis`
- [X] T059 [P] [US5] `tests/e2e/dashboard-genesis-parity.test.mjs`：五个 L1 验证者自报创世哈希彼此一致且等于 `blockchain/genesis/karmachain.genesis.hash`（SC-011 正向）

### Implementation for User Story 5

- [X] T060 [US5] `tools/dashboard/public/view-identity.mjs` 链身份区：Chain ID、Network ID、L1 的 blockchainID、链别名、基准创世哈希（FR-024）
- [X] T061 [US5] `tools/dashboard/public/view-identity.mjs` 分叉警报：与档位**并列**的独立维度，显目列出与基准不一致的节点及其自报哈希（FR-025）

---

## Phase 8: User Story 6 - 对外精简视图 (Priority: P3)

**Goal**: 一份可以给第三方看而不泄漏内部事实的精简视图。

**Independent Test**: 自动化检查精简视图的全部输出，确认不含 NodeID、私网地址、内部路径、内部组件版本号等内部事实。

### Tests for User Story 6

> 三层守卫缺一不可（`contracts/dashboard-api.md` 第 4 节）。**第 3 层是关键** —— 只有前两层时，一个"看起来有白名单常量但白名单没被真正应用"的错误实现依然全绿。002 反复教过：静态守卫只证明了没用错写法，没证明用对了。

- [X] T062 [P] [US6] `tests/unit/dashboard-public-view.test.mjs` 第 1 层**结构断言**：投影输出的键集合**等于**白名单（`chainId` `networkId` `chainAlias` `rpcPath` `publishedHosts` `networkHeight` `tier` `healthPercent` `collectedAt`）。多一个键即失败，迫使新增字段时显式决定是否公开
- [X] T063 [US6] `tests/unit/dashboard-public-view.test.mjs`（**同文件，故无 [P]**）第 2 层**内容扫描**：对投影结果的 JSON 文本扫描禁止模式 —— `NodeID-` 前缀、私网地址段（`10.` / `172.16-31.` / `192.168.`）、仓库内路径（`blockchain/` / `tools/` / `/workspace`）、内部组件版本号
- [X] T064 [US6] `tests/unit/dashboard-public-view.test.mjs`（**同文件，故无 [P]**）第 3 层**行为探针**：喂一个刻意含 `nodeId: "NodeID-xxx"`、`address: "192.168.1.21"`、`detail: "/workspace/blockchain/..."` 的假快照，断言这些**值**不出现在输出里

### Implementation for User Story 6

- [X] T065 [US6] `tools/dashboard/public-view.mjs`：**显式字段白名单**投影 —— 挑出允许的，**不是**删掉不允许的。黑名单在有人给快照加字段时默认放行，而那正是泄漏发生的方式
- [X] T066 [US6] `GET /api/public` 端点，恒 200
- [X] T067 [US6] `tools/dashboard/public/view-public.mjs` 的 `?view=public` 精简渲染；链处于 `stopped` 档时**仍**正确显示档位（对外视图不隐瞒链的可用性）

**Checkpoint**: 六个用户故事全部独立可用

---

## Phase 9: Polish & Cross-Cutting Concerns

- [X] T068 [P] `docs/adr/0010-readonly-observability-dashboard.md`：面板作为链的只读旁观者的架构位置；四条"为何不"—— 为何端口不进 `protocol.json`（stamp / configVersion 的全链重置代价）、为何不走 nginx 反代（五台 `--force-recreate`）、为何不让浏览器直连（CORS 可行但判据必须复用）、为何不引前端框架
- [X] T069 [P] `docs/adr/README.md` 登记 ADR-0010
- [X] T070 [P] `docs/devnet.md` 新增一节：面板起法、三档判据表、10 个故障场景的读法，并交叉引用既有第 3.5 节的观测盲区
- [~] T071 逐条执行 `quickstart.md` 场景 A–J，把结果回填；其中场景 G（空闲 10 分钟）与 H（只读 30 分钟）是手工判据，自动化测试只覆盖较短窗口
- [ ] T072 **V-01** 五台机器逐台执行 `scripts/devnet-dashboard.sh` / `.ps1` 并确认 `-p 21680` 可从宿主浏览器访问 —— Windows 的 Docker Desktop 与 Linux 的 docker 端口发布路径不同，须逐台实测而非推断
- [~] T073 **V-02 / V-03 / V-04 / V-06** 实测并回填 `research.md`：观察者失明确实触发 P1（未被中间分支吃掉）、`docker kill` 到显示改变的实测时延、60% 档时交易确实无法确认、公开投影的行为探针确实会在故意泄漏时变红
- [X] T074 **V-05** 确认 `devnet-status` 无回归：对照基线（本会话实测 4.18 s、7 行、`--json` 结构），核对 T014/T015 改动后的输出与耗时
- [X] T075 002 回归全套（SC-015）：`npm test`、`npm run test:integration`、`npm run test:e2e`、`npm run test:secrets`、`npm run render:check`（应无变化 —— 003 不新增生成物）、`sh scripts/devnet-verify.sh`（14 项）
- [ ] T076 **SC-014** `tools/dashboard/public/` 的可用性核对：找一名此前未见过本面板的人，在打开后 1 分钟内正确回答"链现在能不能用"与"还能再掉几个验证者"，无需运行命令或查文档。答不上就改呈现，不改判据
- [X] T077 [P] `specs/003-chain-health-dashboard/checklists/dod.md`：按宪法第十七条八项 + 21 条 SC 逐条核对，记录未达成项及理由
- [X] T078 更新 `specs/003-chain-health-dashboard/spec.md` 的 Status 为已交付，并把实现期的修订就地记录（沿用 002 的做法）

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1（Setup）**：无依赖，可立即开始
- **Phase 2（Foundational）**：依赖 Phase 1；**阻塞全部用户故事**
- **Phase 3–8（用户故事）**：均依赖 Phase 2 完成；之后可并行，或按 P1 → P2 → P3 顺序推进
- **Phase 9（Polish）**：依赖所有拟交付的故事完成

### Phase 2 内部顺序（不可调换）

```
T005…T008（测试，先写先失败）
    ↓
T009（参与共识谓词）→ T010（档位）→ T011（边界余量）→ T012（异常分类）
    ↓                      ↑
T013（无硬编码守卫）     依赖 T009 的输出
T013a（静态边界守卫）    两者都扫描 T009–T012 的产物，故都无 [P]
    ↓
T014, T015（node-status 两处追加）→ T016（pollOnce）→ T017（观察者视角）
    ↓
T018, T019（快照组装）→ T020（容器事实降级告知）
    ↓
T021（服务）→ T022（服务集成测试）
```

**T009 必须在 T010 之前**：档位判定式的输入是"参与共识的验证者数"，而不是 `countsAsOffline` 的计数。顺序颠倒最容易写成后者 —— 那正是"1 个健康 + 4 个引导中显示 100%"这个假绿灯的来源。

**T014/T015 必须在 T016 之前**：`pollOnce` 要用到 `genesisHash` 与 `readContainers`。

### User Story Dependencies

- **US1（P1）**：Phase 2 完成后即可开始，不依赖其他故事 —— 独立交付即 MVP
- **US2（P2）**：仅依赖 Phase 2。视图落在自己的 `view-nodes.mjs`，与 US1 无文件冲突；只有 `index.html` 的挂载点需要一次性协调（T027 已建好骨架）
- **US3（P2）**：仅依赖 Phase 2。其核心判据（`unreachable` 双重含义）已在 Phase 2 由既有 `classify` 提供；US3 自身的工作是**呈现**与**证明**
- **US4 / US5 / US6（P3）**：仅依赖 Phase 2，三者互不依赖，**可完全并行** —— 这一条原先是**假的**：`/speckit-analyze` 查出 `app.mjs` 被 14 条任务横跨全部六个故事触及，与下面"同一文件的任务必须串行"的规则直接冲突。已把前端按视图拆成 `view-health` / `view-nodes` / `view-observer` / `view-domains` / `view-identity` / `view-public` 六个模块，每个故事只改自己那一个，并行声明这才成立

### Within Each User Story

- 测试先写并确认失败，再动实现（宪法第八条）
- 纯判定层 → 观测层 → 服务端点 → 前端呈现
- 同一文件的任务必须串行。当前多任务同文件的有：`snapshot.mjs`（T009–T012、T018–T020）、`server.mjs`（T021、T034、T066）、`node-status.mjs`（T014、T015）、`index.html`（T027、T032）、`dashboard-detection.test.mjs`（T023、T024）、`dashboard-blindness.test.mjs`（T043、T044）、`dashboard-fork.test.mjs`（T057、T058）、`dashboard-public-view.test.mjs`（T062–T064）—— 这些组内**均不得**标 [P]
- `app.mjs` 只做轮询、路由与装配。**任何具体视图的渲染都不许写进它** —— 否则六个故事又会回到抢同一个文件

### Parallel Opportunities

**可并行**：

- Phase 1 的 T002 / T003 / T004（三个不同文件）
- Phase 2 的四个契约测试 T005 / T006 / T007 / T008（四个不同文件）
- US1 测试组的 T023 / T025 / T026 / T026a / T026b / T026c（六个不同文件）
- US4 / US5 / US6 三个故事（前端已按视图分文件，见上）
- Phase 9 的 T068 / T069 / T070 / T077

**不可并行**（同文件，故均未标 [P]）：

- T013 与 T013a：都扫描 T009–T012 的产物，须在其后
- T014 与 T015：同为 `node-status.mjs` 的两处追加
- T023 与 T024：同为 `dashboard-detection.test.mjs`
- T043 与 T044：同为 `dashboard-blindness.test.mjs`
- T057 与 T058：同为 `dashboard-fork.test.mjs`
- T062 / T063 / T064：同为 `dashboard-public-view.test.mjs`（编号相邻是为了体现三层递进）
- T009–T012 与 T018–T020：同为 `snapshot.mjs`

---

## Parallel Example: Phase 2 的契约测试

```bash
# 四个文件互不相干，可同时开工。全部必须先失败。
Task: "tests/unit/dashboard-tier.test.mjs —— 13 行真值表 + 9 条变红对照"
Task: "tests/unit/dashboard-domain-margin.test.mjs —— 5 行边界余量表"
Task: "tests/unit/dashboard-incident-class.test.mjs —— 五类映射"
Task: "tests/unit/node-status-genesis.test.mjs —— R-07 两处改动的回归"
```

> **注意**：`npm test` 之外的 `test:integration` / `test:e2e` 在本仓库是 `--test-concurrency=1` 串行的（002 的既有决定：它们会改动共享状态）。新增的集成与 e2e 文件会自动落进该串行组，**不要**给它们加并行标记。

---

## Implementation Strategy

### MVP First（只做 US1）

1. Phase 1 Setup
2. Phase 2 Foundational（**关键，阻塞一切**）
3. Phase 3 US1
4. **停下来验证**：quickstart 场景 A / B / C / G / H（其中 C 现有自动化任务 T026c，跨机形态下会带说明跳过，仍须按场景 C 做两机人工验证）
5. 此时已有一个正确的三档健康度 —— 能回答"要不要现在起床处理"

### 增量交付

1. Setup + Foundational → 地基就绪
2. US1 → 独立验证 → **MVP**
3. US2 → 报警能指出"是谁"
4. US3 → 报警变得**可信**（不再有网络故障造成的假报警）
5. US4 / US5 / US6 → 边界余量、分叉检测、对外视图
6. 每个故事都不破坏前面的故事

### 风险最高的三个任务

| 任务 | 风险 | 缓解 |
|---|---|---|
| T010（档位判定） | 优先级写反会产生假红灯或假绿灯，且**假绿灯不会被任何活链测试发现** | T005 的 13 行真值表 + 9 条变红对照必须先写先失败 |
| T014 / T015（改 002 代码） | `devnet-status` 回归 | T008 的回归断言 + T074 的实测对照（基线 4.18 s / 7 行） |
| T065（公开投影） | 泄漏是静默的，不会报错 | T064 的行为探针 —— 不是断言"有白名单常量"，而是喂假快照断言值不出现 |
| T030（档位文案） | FR-008 / FR-020 / SC-006 的判据本质是"文案里不得出现某些话"，而这类要求**不会自己报错** | 文案抽成纯模块 `copy.mjs`，由 T026a 逐档位断言必含与禁止短语 |
| T033（探活密钥路径） | 私钥经由响应 / 日志 / 快照 / 公开投影四个面泄漏，且泄漏是静默的 | T032a 的安全分析（宪法第四条要求）+ T026b 断言响应与日志不含密钥材料 + T013a 的静态边界守卫 |

---

## Notes

- [P] = 不同文件、无未完成依赖
- 每完成一个任务或一组逻辑相关的任务就提交
- 可在任一 Checkpoint 停下来独立验证该故事
- **档位判定的每条分支都要能回答"它坏了会变红吗"** —— 这是 002 交付时总结的第一条教训，`contracts/health-tier.md` 第 9 节列了对照表
- 避免：含糊任务、同文件冲突、破坏故事独立性的跨故事依赖
