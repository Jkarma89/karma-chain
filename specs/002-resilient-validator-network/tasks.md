---

description: "Task list for 002-resilient-validator-network"
---

# Tasks: 崩溃可恢复、可跨机部署的验证者网络

**Input**: Design documents from `/specs/002-resilient-validator-network/`

**Prerequisites**: [plan.md](./plan.md)、[spec.md](./spec.md)、[research.md](./research.md)、[data-model.md](./data-model.md)、[contracts/](./contracts/)、[quickstart.md](./quickstart.md)

**Tests**: **包含**。宪法第八条要求测试与验证优先，001 已确立 `node --test` + 13 项 `devnet-verify` 的做法，本特性沿用并扩充。

**Organization**: 按用户故事分组，每个故事可独立实现与验证。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行（不同文件、不依赖未完成任务）
- **[Story]**: 所属用户故事（US1…US6）；Setup / Foundational / Polish 阶段无故事标签

## Path Conventions

仓库根为 `F:\Blockchain\SRC\karma-chain`。沿用 001 的分层：`blockchain/` 事实来源 · `tools/` 生成器与验证器 · `docker/` 运行时 · `scripts/` 薄封装 · `tests/` 测试 · `docs/` 文档与 ADR。

## 交付分期对照

| spec 分期 | 覆盖的故事 | 任务阶段 |
|---|---|---|
| **阶段一**（单机，解决缺陷 A） | US1、US2、US3、US5、US6 | Phase 1–5、7–8 |
| **阶段二**（跨机，解决缺陷 B） | US4 | Phase 6 |

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: 目录骨架与 schema 落地，后续所有阶段的前提

- [X] T001 创建目录骨架 `docker/node/`、`docker/bootstrap/`、`blockchain/chain-identity/`，各放 `.gitkeep` 与 README 说明其职责边界
- [X] T002 [P] 把 `specs/002-resilient-validator-network/contracts/chain-identity.schema.json` 落到 `blockchain/chain-identity.schema.json`，并在 `tests/unit/` 加字节一致性测试（沿用 001 对 `protocol.schema.json` 的做法）
- [X] T003 [P] 把 `specs/002-resilient-validator-network/contracts/topology.schema.json` 的内容并入 `blockchain/protocol.schema.json` 的 `topology` 段（保持 draft 2020-12 与 `additionalProperties:false`）
- [X] T004 [P] 在 `package.json` 增加脚本占位：`topology:validate`、`node:render`、`bootstrap`，并更新 `README.md` 的命令表
- [X] T005 [P] ⏳ **时间敏感**：在退役 001 架构之前采集基线并记入 `specs/002-resilient-validator-network/research.md` 新增小节「R-14 基线度量」——`scripts/devnet-start` 的冷启动与恢复耗时（各 3 次取中位数）、从克隆到可用链的人工步骤数。供 SC-007（≤ 1.5 倍）与 FR-030（人工步骤不增）的对比断言使用。**T080 一旦退役旧架构，此基线永远无法再采集**（需先 `scripts/devnet-reset` 重建一条可用链）

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: 所有用户故事的共同前提。**本阶段未完成前，任何故事都无法开工。**

**⚠️ CRITICAL**: T006 是唯一一个"结果为否就要改设计"的任务，必须最先做。

### 决定性验证（先于一切设计落地）

- [X] T006 **执行 V-08 / quickstart 场景 I**：停掉 2 个 Primary Network 节点，观察已运行的 L1 是否继续出块。可在**现有 001 架构**上完成（需先 `scripts/devnet-reset` 重建一条可用链），不必等 002 建成。把结论写进 `specs/002-resilient-validator-network/research.md` 的 R-09，并据此决定是否需要追加 Primary 节点冗余设计
- [X] T007 依 T006 结论更新 `specs/002-resilient-validator-network/plan.md` 的 Complexity Tracking 与 `data-model.md` 的 Deployment 定义；若结论为"L1 停止出块"，追加 Primary 冗余的设计任务并回到 `/speckit-plan` 复审

### 建链制品

- [X] T008 编写 `docker/bootstrap/Dockerfile`：由现 `docker/devnet/Dockerfile` 收缩而来，**保留 Avalanche CLI**，去掉运行期编排脚本；这是仓库中唯一含 CLI 的镜像
- [X] T009 编写 `docker/bootstrap/extract-identity.sh`：建链后从 CLI 的 `subnets/karmachain/sidecar.json` 提取 SubnetID / BlockchainID / 5 个引导验证者，产出符合 schema 的 `blockchain/chain-identity/karmachain.identity.json`
- [X] T010 编写 `docker/bootstrap/extract-primary-genesis.sh`：从节点 `flags.json` 的 `genesis-file-content` 解出 Primary Network 创世，产出 `blockchain/chain-identity/primary-network.genesis.json`
- [X] T011 [P] `tests/unit/chain-identity.test.mjs`：制品符合 schema；`vmVersion`/`rpcVersion`/`networkId` 与 `protocol.json` 交叉一致；`bootstrapValidators` 数量 == `validators.count`；权重全部相等
- [X] T012 `tools/verify/lib/identity.mjs`：由 `staker.crt` 派生 NodeID、由 `signer.key` 派生 BLS 公钥，供启动期校验与测试共用
- [X] T013 [P] `tests/unit/identity-crosscheck.test.mjs`：5 个 `keyDir` 派生出的 NodeID 与 BLS 公钥逐一匹配制品中的条目（data-model §5 的交叉校验）

### 唯一事实来源扩充

- [X] T014 在 `blockchain/protocol.json` 增加 `topology` 段：`nodes[]`（5 validator + 2 primary）与 `deployments.local`（单边界）；`configVersion` 升到 1.3.0
- [X] T015 `tools/protocol/load.mjs`：加载并校验 `topology`，实现约束 T-1…T-6（data-model §1），`derive()` 导出每节点的解析结果
- [X] T016 `tools/protocol/validate-topology.mjs`：容错上限推导（f ≤ ⌊n/4⌋）、每边界验证者数校验、`sharedFailureFactors` 重叠告警；违规以**退出码 13** 报出边界 id / 实际数量 / 上限 / 修正方向
- [X] T017 [P] `tests/unit/topology.test.mjs`：合法拓扑通过；单边界 5 验证者（阶段一）不报错；多边界下任一边界 2 个验证者报退出码 13；成员并集不等于节点全集报错；共享失效因素重叠产生告警而不阻断

### 生成器

- [X] T018 `tools/protocol/render-node-flags.mjs`：由 `topology` + 建链制品 + `protocol.json` 生成每节点 avalanchego 标志（data-model §6 全表），按角色区分 validator / primary
- [X] T019 `tools/protocol/render-aliases.mjs`：生成 `chain-aliases-file` 内容，映射 `blockchainId → ["karmachain"]`
- [X] T020 `tools/protocol/render-compose.mjs`：由拓扑生成每个故障边界一份 compose 文件，含每节点独占命名卷、`restart` 策略、健康检查、端口映射
- [X] T021 [P] `tests/unit/render-node-flags.test.mjs`：标志集合与实测基准 `tests/fixtures/002/measured-node-flags.json` 逐项对照（该 fixture 已于 Phase 1 从卷中取证固化，不依赖活链）；`http-host` 为 `0.0.0.0`；validator 带 `track-subnets`/`partial-sync-primary-network`/三个 staking 文件标志，primary 不带；与基准的每一处差异都须能指出理由（如 `http-host` 之变来自 R-07）
- [X] T022 [P] `tests/unit/render-compose.test.mjs`：节点数 == 拓扑声明；每节点一个独占卷；卷名稳定且与节点 id 对应
- [X] T023 [P] `tests/unit/drift.test.mjs` 扩充：全部新生成物（节点标志、compose、aliases）纳入 `--check` 漂移检查

### 节点运行时镜像

- [X] T024 编写 `docker/node/Dockerfile`：`FROM avaplatform/avalanchego:v1.14.1`，叠加 sha256 校验的 `subnet-evm v0.8.0` 插件；**不得包含 Avalanche CLI**
- [X] T025 编写 `docker/node/entrypoint.sh`：只做标志组装与 `exec avalanchego`，**不含任何重试 / 快照 / 状态判断逻辑**（contracts/node-runtime.md）
- [X] T026 在 `docker/node/entrypoint.sh` 实现启动期四项校验：身份材料可读（退出 10）、NodeID 匹配制品、BLS 公钥匹配、制品版本相容（后三项退出 12）
- [X] T027 在 `docker/node/entrypoint.sh` 迁移 001 的出生证明机制：把 `docker/lib/runtime.sh` 的 `rt_write_stamp` / `rt_check_stamp` / `rt_check_runtime_genesis_hash` 下沉到**每个节点自己的数据卷**（`/data/karmachain.stamp.json`，字段沿用 `configVersion`/`chainId`/`networkId`/`blockchainName`/`genesisSha256`/`genesisBlockHash`）；启动时比对不符即退出 12 并列出具体不符项。001 FR-021 的语义不得改变（FR-026）
- [X] T028 编写 `docker/node/healthcheck.sh`：产出 `RecoveryState`（data-model §7）。判据必须以「本节点能否参与 L1 出块」为准，**不得直接采用节点自报的综合健康位**——两种情形不得判为不健康：`catching-up`（正在追赶）、**P 链不可达但 L1 正常出块**（V-08 实测：Primary 全停时 5 个验证者健康位全为 false 而链完全可用）
- [X] T029 [P] `tests/integration/node-image.test.mjs`：镜像内 `avalanche` 可执行文件不存在；subnet-evm 插件存在且版本正确
- [X] T030 [P] `tests/integration/node-startup-guards.test.mjs`：篡改制品中的 `nodeId` → 退出 12；移除 `signer.key` → 退出 10；均在数秒内失败而非等待超时
- [X] T031 [P] `tests/integration/stamp.test.mjs`：改 `blockchain/protocol.json` 的 `configVersion` 后重启 → 退出 12 且指出不符项；节点卷内 stamp 缺失 → 退出 12；stamp 一致 → 正常启动。断言 001 的退出码 12 语义未回退（FR-026）

**Checkpoint**: 单个节点容器可独立启动、通过启动期校验、报告健康状态

---

## Phase 3: User Story 1 - 强制终止后链自己回来 (Priority: P1) 🎯 MVP

**Goal**: 全部节点被强制杀死或宿主崩溃后，重启即从各自数据卷恢复，链从中断前高度继续，无需重置。

**Independent Test**: quickstart 场景 A —— 制造高度 H 与一个合约 → `docker kill` 全部容器 → `devnet-start` → 断言高度 ≥ H、创世哈希不变、合约可读、重置次数 0。

### Tests for User Story 1

- [X] T032 [P] [US1] `tests/e2e/crash-recovery.test.mjs`：实现场景 A 的完整断言（高度、创世哈希、合约代码与存储、账户余额、重置次数为 0、耗时 ≤ 5 分钟）
- [X] T033 [P] [US1] `tests/e2e/crash-recovery-repeat.test.mjs`：实现场景 B，50 轮"强制终止 → 重启 → 发交易"，断言状态丢失与重置次数均为 0
- [X] T034 [P] [US1] `tests/e2e/crash-during-bootstrap.test.mjs`：实现 V-03，节点在引导中途被杀后重启，断言不进入需人工干预的状态

### Implementation for User Story 1

- [X] T035 [US1] 改写 `scripts/devnet-start.{sh,ps1}`：生成配置 → `compose up` 当前边界的全部节点；**删除"恢复快照"路径**；已运行时保持幂等
- [X] T036 [US1] 改写 `scripts/devnet-stop.{sh,ps1}`：仅 `compose stop`，不保存任何状态
- [X] T037 [US1] 更新 `scripts/devnet-reset.{sh,ps1}`：语义降级为"显式要求从创世重建"，删除全部节点卷；启动时不再把它作为崩溃后的建议出路
- [X] T038 [US1] 在 `docker/node/entrypoint.sh` 与启动摘要中实现崩溃恢复告知（FR-033）：识别为崩溃恢复时明确输出该结论与恢复到的高度
- [X] T039 [US1] 在 `tools/protocol/render-compose.mjs` 中为每个节点设置重启策略与 `stop_grace_period`，确保宿主重启后 Linux 边界自动拉起
- [X] T040 [US1] 运行 `scripts/devnet-verify` 全部 13 项，确认基线不回退（FR-025）

**Checkpoint**: 场景 A、B、V-03 通过。**这是 MVP —— 单独交付即已消灭本次故障的数据丢失路径。**

---

## Phase 4: User Story 2 - 一个验证者挂掉链照常出块 (Priority: P1)

**Goal**: 任一验证者被强制终止时链继续出块；该节点重启后自动追平；超出容错上限时安全停摆而非分叉。

**Independent Test**: quickstart 场景 C —— 杀死 1 个验证者 → 持续发交易断言链继续 → 重启 → 断言 2 分钟内追平。

### Tests for User Story 2

- [X] T041 [P] [US2] `tests/e2e/single-validator-failure.test.mjs`：实现场景 C（V-01），含追平耗时 ≤ 2 分钟与"追赶期间不被健康检查反复重启"
- [X] T042 [P] [US2] `tests/e2e/beyond-tolerance.test.mjs`：实现场景 D（V-05），断言 2 个离线时停止出块、恢复后自动继续、**已确认区块零回滚**
- [X] T043 [P] [US2] `tests/e2e/node-data-loss.test.mjs`：实现场景 E（V-04），删除单节点数据卷后重启，断言其余节点不受影响、该节点重新同步、NodeID 不变

### Implementation for User Story 2

- [X] T044 [US2] 扩充 `scripts/devnet-node.{sh,ps1}`：新增 `kill` 子命令（`SIGKILL`），保留 001 已记录的 `pause`/`resume` 限制说明
- [X] T045 [US2] 在 `tools/verify/checks/chain.mjs` 增加容错检查项：当前在线验证者数、推导出的容错上限、两者关系
- [X] T046 [US2] 在 `docker/node/healthcheck.sh` 实现 `catching-up` 与 `stalled` 的时间窗口判定，窗口取值由 T041 实测反推（SC-004）；并回归 T028 的第二条规则——P 链不可达时不得把正常出块的验证者判为不健康
- [X] T047 [US2] 在 `docker/node/entrypoint.sh` 确认单节点卷删除后的重建路径：卷为空时正常全量同步，身份仍取自只读挂载的 `/keys`（R-03 的直接收益）；结论记入 `specs/002-resilient-validator-network/research.md` R-06

**Checkpoint**: 场景 C、D、E 通过。冗余从纸面变成事实。

---

## Phase 5: User Story 3 - 运行时不再依赖编排工具 (Priority: P2)

**Goal**: 启动、停止、重启全过程不调用 Avalanche CLI；它只在一次性建链时出现。

**Independent Test**: quickstart 场景 H —— 运行时镜像内无 `avalanche` 可执行文件；运行时代码路径无 CLI 调用；全部节点仍能正常起来且 13 项验证通过。

### Tests for User Story 3

- [X] T048 [P] [US3] `tests/integration/no-cli-in-runtime.test.mjs`：实现场景 H 的两项断言（镜像内不存在、代码路径无调用，`docker/bootstrap/` 除外）
- [X] T049 [P] [US3] `tests/unit/bootstrap-idempotence.test.mjs`：`devnet-bootstrap` 在已有制品时拒绝覆盖，`--force` 才允许

### Implementation for User Story 3

- [X] T050 [US3] 新增 `scripts/devnet-bootstrap.{sh,ps1}`：调用 `docker/bootstrap/` 镜像完成一次性建链并产出制品，默认拒绝覆盖
- [X] T051 [US3] 从运行时路径移除对 `docker/lib/avalanche.sh` 的全部调用；该文件仅保留给 bootstrap 镜像使用
- [X] T052 [US3] 删除 socat 反向代理相关实现（`docker/lib/runtime.sh` 的 `rt_start_proxy`/`rt_stop_proxy` 及其调用），改由节点自身 `--http-host=0.0.0.0` 暴露（R-07）
- [X] T053 [US3] 执行 V-11：确认 `tools/protocol/render-node-flags.mjs` 生成的 `http-allowed-hosts` 放宽后跨边界 RPC 可达，不再出现 `403 invalid host specified`；结论记入 `specs/002-resilient-validator-network/research.md` R-07
- [X] T054 [US3] 执行 V-10：确认 `/ext/bc/karmachain/rpc` 在显式 `aliases.json` 下与 BlockchainID 全路径等价（对第三方公布的地址不得失效）
- [X] T055 [US3] 执行 V-12：确认 `docker/node/Dockerfile` 产出的镜像中 subnet-evm 插件的 RPCChainVM 协议 44 握手成功；结论记入 `specs/002-resilient-validator-network/research.md` R-02

**Checkpoint**: 场景 H 通过，FR-015 由镜像构成静态成立。**阶段一功能完整。**

---

## Phase 6: User Story 4 - 一整台机器挂掉链继续出块 (Priority: P2) — 阶段二

**Goal**: 5 个验证者分布在 5 台机器 5 个故障边界，任一边界整体失效时链继续出块。

**Independent Test**: quickstart 场景 F —— 对任意一台机器关机或拔网线，断言链连续 30 分钟继续出块；恢复后其上节点 2 分钟内自动追平。

**⚠️ 前置**: Phase 3–5 完成；5 台机器就绪（2 × Windows、3 × Ubuntu 22.04 LTS）；T006 的 V-08 结论已落实。

### Tests for User Story 4

- [ ] T056 [P] [US4] `tests/e2e/domain-failure.test.mjs`：实现场景 F，断言整域失效时链继续出块、缺席节点标记为 `unreachable` 而非节点故障、恢复后自动追平
- [X] T057 [P] [US4] `tests/integration/cross-host-reachability.test.mjs`：实现 V-06，5 台机器两两 staking 端口可达

### Implementation for User Story 4

- [X] T058 [US4] 在 `blockchain/protocol.json` 增加 `deployments.lan`：5 个故障边界、每边界 1 个验证者、`platform` 与 `sharedFailureFactors` 如实填写
- [X] T059 [US4] 在 `render-node-flags.mjs` 实现跨机寻址：`--public-ip` 取所属边界的 `address`，`--bootstrap-ips` 由 Primary 节点边界地址与端口生成，`--network-allow-private-ips` 显式声明（R-08）
- [X] T060 [US4] 在 `tools/protocol/load.mjs` 与 `tools/protocol/render-node-flags.mjs` 支持以环境变量覆盖本机所属边界的 `address`，应对 IP 变更与他人复用本仓库（data-model §4）
- [X] T061 [US4] 在 `scripts/devnet-start.{sh,ps1}` 支持 `KARMACHAIN_DOMAIN=<边界 id>`，每台机器只启动本边界的节点
- [X] T062 [US4] 执行 V-07 并实现相应报错：`public-ip` 与本机实际地址不符时明确失败，而非表现为随机连接失败；结论记入 `specs/002-resilient-validator-network/research.md` R-08。**落点与原计划不同**：原文写"在 `docker/node/entrypoint.sh` 实现"，但 V-07 实测证明容器内做不到 —— 容器处在 NAT 之后，看不到宿主的局域网地址，无从判断通告出去的地址是不是本机的；且节点对配错完全无声（唯一相关日志与配对时一模一样）。因此检查落在宿主侧的 `scripts/devnet-start.{sh,ps1}`，在节点启动**之前**比对，退出码 13；声明地址经 `active.env` 的 `KARMACHAIN_DOMAIN_ADDRESSES` 传入，宿主无需 Node。测试 `tests/integration/public-ip-guard.test.mjs`
- [X] T063 [US4] 执行 V-09：实测 `specs/002-resilient-validator-network/research.md` R-11 的三个 Windows 开机自启候选方案并选定其一，结论回写该文件
- [X] T064 [US4] 撰写 `docs/adr/0006-windows-failure-domain-autostart.md`：记录 V-09 的选型与理由
- [X] T065 [US4] 撰写 `docs/adr/0007-failure-domain-independence.md`：记录 5 个边界的共享失效因素、两台 Windows 的更新窗口错开方案、供电与交换机的已知限制（R-12）
- [X] T098 [US4] **跨机形态的建链状态如何到位** —— 写 T066 时发现的缺口，此前无任务覆盖：`docker/bootstrap` 只把 7 个节点的数据库播种进**本机** 7 个卷，跨机形态下没有任何一步把它们送到其他机器。**2026-09-07 实测结论（可逆验证，先备份 7 个卷约 1 MB）**：只需分发**仓库 + 2 个 Primary 卷**——删掉 5 个验证者卷、保留 2 个 Primary 卷后启动，6 秒就绪、5/5 验证者引导完成（peers 6）、运行中的 `blockchainId`／`subnetID` 与制品逐字一致、`devnet-verify` 14/14；代价是 L1 高度从创世重新开始。要保住现有高度则导出／导入全部 7 个卷（同样已实测：导入后高度精确回到 `0x2e`，14/14）。两条路径与命令记入 research.md 新增小节 R-15

- [X] T066 [US4] 更新 `docs/devnet.md`：新增跨机部署章节（前置条件、每台机器的两条命令、防火墙要求、故障演练步骤）。前置条件必须含：① 用 ADR-0007 的清点命令确认各边界是**独立物理机**；② 每台**静态 IP 或 DHCP 保留**（地址钉死在声明里，运行中租约变更拦不住）；③ 承载虚拟机的边界**不走 Wi-Fi 桥接**（802.11 使宿主与客户机共用 MAC，实测导致宿主自身地址被黑洞）；④ 逐台 `netsh interface ipv4 show excludedportrange` 确认 21650–21669 空闲；⑤ 每台按边界放行入站端口

**Checkpoint**: 场景 F 通过。**缺陷 B 消除，用户诉求完整达成。**

---

## Phase 7: User Story 5 - 拓扑参数有唯一出处并可复现 (Priority: P3)

**Goal**: 改拓扑声明即可一致更新全部派生配置；手改生成物被漂移测试拦下。

**Independent Test**: quickstart 场景 G —— 合法拓扑通过并展示容错上限；违规拓扑退出 13；手改生成物后 `devnet-render --check` 失败。

### Tests for User Story 5

- [X] T067 [P] [US5] `tests/integration/topology-cli.test.mjs`：实现场景 G 的四项断言（合法、违规退 13、共享因素告警不阻断、漂移检出）
- [X] T068 [P] [US5] `tests/unit/no-hardcode.test.mjs` 扩充：新增的拓扑、端口、地址不得在脚本或生成器中写死，一律由 `protocol.json` 派生（FR-027）

### Implementation for User Story 5

- [X] T069 [US5] 新增 `scripts/devnet-topology.{sh,ps1}`，输出格式依 contracts/cli-interface.md
- [X] T070 [US5] 新增 `scripts/devnet-render.{sh,ps1}`，含 `--check` 漂移模式
- [X] T071 [US5] 在 `tools/protocol/render-docs.mjs` 的 `REQUIRED_RATIONALE_KEYS` 增加 `topology` 相关键，使新参数必须附理由（沿用 001 做法）
- [X] T072 [US5] 更新 `docs/protocol-parameters.md` 生成逻辑，纳入拓扑与故障边界

**Checkpoint**: 场景 G 通过，宪法第七、十六条不因分布式而退化。

---

## Phase 8: User Story 6 - 恢复过程对运维可见 (Priority: P3)

**Goal**: 逐节点可见运行状态、健康、引导、高度、peers、故障边界；"追赶中""边界缺席""故障"三者可区分。

**Independent Test**: 制造单节点故障与恢复，断言状态输出在每个阶段给出全部字段且三种状态可区分。

### Tests for User Story 6

- [X] T073 [P] [US6] `tests/integration/status-recovery-states.test.mjs`：断言状态机（data-model §7）各状态可达且可区分，`catching-up` 带进度且不计为故障
- [X] T074 [P] [US6] `tests/unit/status-format.test.mjs`：输出含在线数与容错上限的关系行

### Implementation for User Story 6

- [X] T075 [US6] 把 `docker/devnet/bin/devnet-status` 改写为 `tools/inspect/node-status.mjs`：逐节点报告 `RecoveryState`、高度、peers、所属故障边界
- [X] T076 [US6] 在 `tools/inspect/node-status.mjs` 实现 `unreachable`（边界缺席）与节点故障的区分：整个边界不可达时不逐节点报"故障"
- [X] T077 [US6] 在 `tools/inspect/node-status.mjs` 的输出中显示"在线验证者数 / 容错上限"的关系，使剩余余量一眼可见
- [X] T078 [US6] 更新 `scripts/devnet-logs.{sh,ps1}` 适配一节点一容器；保留 001 的密钥材料脱敏默认与 `--raw` 开关
- [X] T079 [US6] 校对本特性引入的故障是否都能归入既有九类分类（FR-034）；若需新增类别，在 `specs/001-local-avalanche-devnet/contracts/cli-interface.md` 与本特性文档中显式声明
- [X] T094 [US6] 消除 `devnet-start` 与 `devnet-verify` 两套"就绪"判据的不一致：`devnet-start` 等的是 RPC 应答（数据卷已在时数秒即通），而 `devnet-verify` 的 `node` 检查读 `/ext/health` 的综合健康位（含 P 链，重启后约 2 分钟才转 healthy）。实测：重建全部容器后 20 秒，`devnet-start` 报 READY、链正常出块建合约，同一时刻 `devnet-verify` 报 `7/7 unhealthy: HTTP 503` 且 `fault-tolerance` 报"0/5 validators online, chain has stopped producing blocks"—— 一个**完全健康的链**被报成越过容错上限。这正是 US6"追赶中不得判为故障"要求的同一类误报（见 research.md R-09），只是发生在启动窗口而非 Primary 缺席时。判据应以"本节点能否参与 L1 出块"为准
- [X] T095 [US6] 修 `tools/verify/lib/avalanche-api.mjs` 的节点清单字段名：拓扑来源给 `name`、001 的 `.devnet/nodes.json` 给 `label`，而 `node`／`validator` 两个检查只读 `label`，于是切到拓扑优先之后报错信息里的节点名一直是 `undefined`（实测：`7/7 unhealthy: undefined (health: HTTP 503)`——恰好在最需要知道是哪个节点时失效）。检查通过时不走这条路径，所以一直没暴露。`readInventory()` 现在统一补齐两个字段名，`tests/unit/topology.test.mjs` 加断言锁定

**Checkpoint**: 运维能判断"该等还是该动手"。

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: 退役旧路径、补齐文档与决策记录、回归基线

- [X] T080 退役 `docker/devnet/`：删除单容器编排、entrypoint 的快照逻辑与相关脚本；确认无任何运行时路径仍引用它（R-13）
- [X] T081 [P] 撰写 `docs/adr/0005+` 系列：`0008-runtime-without-orchestration-cli.md`（运行时脱离 CLI 的决策与代价）
- [X] T082 [P] 撰写 `docs/adr/0009-chain-identity-as-second-class-fact.md`：建链制品为何不由 `protocol.json` 派生，以及漂移与校验如何补偿
- [X] T083 [P] 关闭 `docs/adr/README.md` 中的待决事项 "validator decentralisation path"，并链接到本特性
- [X] T084 [P] 更新 `README.md`：命令表、目录表、拓扑说明、功能状态表新增 002
- [X] T085 [P] 更新 `docs/devnet.md`：崩溃恢复行为、一节点一容器模型、故障演练、以及"不再需要 reset"的明确说明
- [X] T086 回归公开制品：确认 `docs/public/chain-info.json` 与 `developer-quickstart.md` 内容不变或仅作必要更新，且不含内部路径、密钥材料、内部版本、私网地址（FR-028）
- [X] T087 在 `F:/Blockchain/SRC/karma-sc` 重新 vendor `chain-info.json`（`npm run chain:fetch`）并跑 `npm run chain:verify`，确认第三方视角的契约未回退
- [X] T088 完整回归：`npm test`、`scripts/devnet-verify`（13/13）、quickstart 场景 A–I 全部执行并留档；并与 T005 采集的基线对比，断言启动耗时 ≤ 1.5 倍、从克隆到可用链的人工步骤仍为 2 步（SC-007、FR-030）
- [X] T090 [P] 补回 001 退役 e2e 丢失的覆盖之一：`scripts/devnet-start` 的**退出码 11（宿主端口冲突）与 20（超时）**。001 的 `tests/e2e/failure-classification.test.mjs` 覆盖过，但它驱动的是单容器架构，已于 T052 退役；002 的 `tests/integration/node-runtime.test.mjs` 只覆盖了节点级的 10 与 12
- [X] T091 [P] 补回覆盖之二：**reset → bootstrap → start 的完整往返**（001 `tests/e2e/reset-recreate.test.mjs` 的等价物）。002 的 reset 语义已变（删卷后必须重新建链，T037），需要新写而非移植
- [X] T092 [P] 补回覆盖之三：**创世 fixture 漂移**（001 `tests/e2e/vm-alloc-drift.test.mjs`）—— `blockchain/genesis/validator-manager.alloc.json` 与 CLI 实际产出的一致性。它属于建链路径，可在 `scripts/devnet-bootstrap` 之后校验
- [X] T093 节点标志与 RPC 代理配置按**部署形态**分目录落盘（`blockchain/nodes/<deployment>/`），而非只渲染 `activeDeployment` 一份。T058 落 `deployments.lan` 时暴露：`public-ip`／`bootstrap-ips`／`http-allowed-hosts` 与 nginx upstream 都是形态相关的，单目录形态下把仓库拷到另一台机器跑 lan，节点仍在用那台机器上不存在的容器地址（`172.28.0.x`）。改动涉及 `render-node-flags.mjs`、`render-rpc-proxy.mjs`、`render-compose.mjs` 的挂载路径与 `docs-drift` 漂移测试（两个形态各自锁定）

- [X] T096 [US4] 容错推导引入**有效边界**：共享同一失效因素的声明边界用并查集合并（因素可传递），`tolerateWholeDomainLoss` 改按合并后判定。此前共享因素只产生 WARN 而承诺仍按声明边界算 —— 2026-09-07 取证发现 `lan` 声明的 5 个边界里有 3 个是虚拟机、真实宿主只有 2 台物理机（win-1 承载 3 个验证者），而校验器仍打印"可容忍 1 个边界整体失效 [OK]"：**一个在现实里为假的绿灯**，正是 ADR-0007 自己警告过的缺陷形态。改动涉及 `load.mjs`（新增 `effectiveDomains()` 与 `effectiveDomainCount`/`effectiveDomains`/`declaredWithinLimit`）、`validate-topology.mjs`（输出合并结果）、`tests/unit/topology.test.mjs`（6 条断言，含一条显式禁止 `lan` 的承诺悄悄变绿）

- [ ] T097 [US4] **已裁定并暂缓，等硬件**：恢复整域失效容忍需要 5 台独立物理机（n=5 ⇒ 每有效边界至多 ⌊5/4⌋=1 个）。当前 2 台，缺 3 台。运维方 2026-09-07 裁定：**按 5 台使用、保持 5 个验证者、接受当前可用性等级**（安全性不受影响 —— V-05 已证超限时安全停摆、区块零回滚；受影响的是可用性）。`hypervisor:` 因素保留声明（物理事实，不阻塞部署），`[FAIL]` 行的含义为"已知并接受的限制"。降到 4 验证者 + 4 台物理机的替代路径未采纳（要改 ADR-0004、重新建链）。见 `docs/adr/0007-failure-domain-independence.md` 的"决定（2026-09-07）"与"恢复整域容错需要什么"

- [X] T099 修 `devnet-start` 在"卷已 reset 但制品仍在"时的诊断：此前会**等满 300 秒**才给一句"未就绪"，毫无指向性。T091 的往返测试抓到。判据只能是"问 P 链"，不能看文件系统 —— 空卷上的 avalanchego 会为**它自己那条全新的 P 链**建出 `/data/db`，"db 目录存在"区分不了"已建链"与"全新空链"（先按文件系统写过一版，实测无效）。现改为 compose up 之后向本机 Primary 查 `platform.getBlockchains`，实测 **3 秒**明确失败并给出 stop → bootstrap → start 的顺序

- [X] T100 修 `devnet-bootstrap` 对"仍有节点在运行"误用退出码 **11** 的问题：契约里 11 专指**宿主端口冲突**，两件毫不相干的事映射到同一个码上，调用方无法据码分流。改为 10（前置条件未满足），`.sh` 与 `.ps1` 同步。**根因在测试里**：`bootstrap-idempotence.test.mjs` 原本断言 `exit 11` 并注明"端口/状态冲突应使用 11"—— 它把误用写进了断言，因此从未拦住

- [X] T101 修 T099 那道守卫引入的**假阳性**：崩溃恢复时（`docker kill` 全部容器后重启）Primary 的 P 链仍在引导，`platform.getBlockchains` 此刻只返回 C/X-Chain，守卫据此判定"链不存在"，把 US1 的恢复路径直接拦死 —— 50 轮重复崩溃测试第一轮就被打断。改为先查 `info.isBootstrapped`（chain P），未引导完成即放行。**教训：打在正常路径上的诊断守卫必须保守 —— 拿不准就放行，交给后面的就绪轮询**；原判据是"未证明存在即失败"，在慢启动时会反转成误报

- [X] T089 依 DoD（宪法第十七条）逐项核对并在 `specs/002-resilient-validator-network/checklists/` 记录验收结论

---

## Dependencies & Execution Order

### Phase Dependencies

```text
Phase 1 (Setup)
   ↓
Phase 2 (Foundational) ← T006 必须最先完成，结论可能回退到 /speckit-plan
   ↓
   ├─→ Phase 3 (US1, P1) 🎯 MVP ─┐
   ├─→ Phase 4 (US2, P1) ────────┤ 阶段一
   ├─→ Phase 5 (US3, P2) ────────┤
   ├─→ Phase 7 (US5, P3) ────────┤
   └─→ Phase 8 (US6, P3) ────────┘
                                  ↓
                        Phase 6 (US4, P2) 阶段二 ← 需 5 台机器
                                  ↓
                        Phase 9 (Polish)
```

### User Story Dependencies

| 故事 | 依赖 | 说明 |
|---|---|---|
| US1 | Phase 2 | 独立可交付，即 MVP |
| US2 | Phase 2 | 与 US1 独立，可并行 |
| US3 | Phase 2 | 其实现主体在 Phase 2（节点镜像），本阶段做验证与旧路径清理 |
| US4 | US1 + US2 + US3 | 跨机需要节点能独立启停与自愈；且需硬件就绪 |
| US5 | Phase 2 | 与功能故事独立 |
| US6 | US1 或 US2 之一 | 需要有可观测的恢复过程 |

### Within Each User Story

测试任务先写（宪法第八条），再实现，最后跑对应的 quickstart 场景。

### Parallel Opportunities

- **Phase 1**: T002、T003、T004、T005 四者并行（T005 需要一条可用链，与其余三项互不阻塞）
- **Phase 2**: T011、T013、T017、T021、T022、T023、T029、T030、T031 可并行（不同测试文件）；T008–T010 与 T014–T016 分属两条独立链，可并行推进
- **Phase 3–5、7–8**: 五个故事在 Phase 2 完成后可并行开工，唯一约束是共享文件（`scripts/devnet-*`、`docker/node/healthcheck.sh`）需协调
- **Phase 9**: T081–T085 全部并行

## Parallel Example: Phase 2 建链制品链

```text
并行组 A（制品）: T008 → T009 → T010 → [T011, T013]
并行组 B（拓扑）: T014 → T015 → T016 → T017
并行组 C（镜像）: T024 → T025 → T026 → T027 → T028 → [T029, T030, T031]
汇合: T018（需 A 的制品 + B 的拓扑）→ T019、T020 → [T021, T022, T023]
```

## Implementation Strategy

### MVP First (User Story 1 Only)

Phase 1 + Phase 2 + Phase 3 = **可交付的 MVP**。单独完成即消灭本次故障的数据丢失路径：强制重启 Docker 后链自己回来，不再需要 reset。这是用户诉求中最紧迫的一半。

### Incremental Delivery

1. **MVP**（Phase 1–3）：崩溃自愈 —— 缺陷 A 消除
2. **+ US2**（Phase 4）：单验证者容错验证 —— 冗余成为事实
3. **+ US3**（Phase 5）：脱离已弃用依赖 —— 长期风险消除，**阶段一完整**
4. **+ US5、US6**（Phase 7–8）：可复现与可观测 —— 宪法要求不退化
5. **+ US4**（Phase 6）：跨机部署 —— 缺陷 B 消除，**阶段二完整**
6. **Polish**（Phase 9）：旧路径退役与决策记录

### Notes

- **T006 是全局最高优先级**。它是唯一一个结论为否就要回到 `/speckit-plan` 的任务：若 L1 出块持续依赖 P 链在线，2 个 Primary 节点即新的单点，会抵消 5 个验证者边界的冗余。**不要把它拖到阶段二**。
- 阶段一不做容错承诺（单边界含 5 个验证者），拓扑校验器须据此放行，而不是让阶段一也报退出码 13。
- 故障边界的"独立性"无法由代码验证。T065 的 ADR 是唯一的补偿手段，不可省略。
- **T005 有时间窗口**：它采集的是 001 架构的启动耗时与人工步骤基线，而 T080 会退役 001 架构。**T005 必须在 T080 之前完成**，否则 SC-007 与 FR-030 永远无法验证。它是全 89 个任务里唯一一个"过期作废"的。
- **T027 是"既有能力不得回退"的唯一落点**。001 的出生证明机制（参数与链数据不一致时退出 12）在 002 里从"单卷一个 stamp"改为"每节点一个 stamp"，语义不得变（FR-026）。漏掉它，宪法第十五条的运行期防线会静默消失。
- 创世哈希、Chain ID、Network ID、6 个账户余额在全过程中不得变（FR-024）；T088 是最后一道闸。
