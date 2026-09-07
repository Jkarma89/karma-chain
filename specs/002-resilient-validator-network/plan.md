# Implementation Plan: 崩溃可恢复、可跨机部署的验证者网络

**Branch**: `002-resilient-validator-network` | **Date**: 2026-09-06 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-resilient-validator-network/spec.md`

## Summary

把 7 个节点从"单容器内由 Avalanche CLI 编排的进程"改为"**一节点一容器、直接运行 avalanchego**"，并把编排工具从运行时路径上彻底摘除——它只保留一次性建链的角色，产出固化进仓库。

这一改动同时消除 spec 的两个缺陷：链状态不再依赖"停止时成功写出快照"（缺陷 A），节点成为可独立启停、独立恢复的单元（缺陷 B 的前提）。在此基础上，阶段二把 5 个验证者分布到 5 台机器、5 个故障边界，任一边界整体失效时链继续出块。

**技术路径的关键依据**（Phase 0 取证）：CLI 传给 avalanchego 的全部参数都是公开配置标志，没有任何一项不可替代——`flags.json` 逐项可读。因此"脱离 CLI"不是重写它的能力，而是**把它拼参数的那一步交给我们自己的生成器**，参数源仍是 `blockchain/protocol.json`。

Phase 0 还补上了故障诊断缺失的一块：卷内**全局搜不到 `staker.crt`**。节点身份不是节点自有的持久属性，而是编排层每次注入的外部输入——即使快照没丢，节点也拿不回身份。R-03 用三个显式的 avalanchego 标志把身份变成版本控制下的持久材料。

## Technical Context

**Language/Version**: Bash（容器入口与节点脚本，沿用 001 惯例）；Node.js ≥ 22.12.0（生成器、验证器、测试，`package.json` 已声明）；JSON（声明与制品）

**Primary Dependencies**: `avaplatform/avalanchego:v1.14.1`（官方节点镜像，已实测 amd64/arm64 均可用）；`subnet-evm v0.8.0` 插件（RPCChainVM 协议 44）；Docker Engine 24+ 与 Compose v2；**Avalanche CLI v1.9.6 仅用于一次性建链，不进入运行时镜像**

**Storage**: 每个节点独占一个 Docker 命名卷承载 `--data-dir`；数据库类型为 avalanchego 默认 `leveldb`（预写日志保证崩溃一致性）。不使用任何快照机制

**Testing**: `node --test`（单元 + 集成，沿用 001）；既有 13 项 `devnet-verify` 全部保留；新增故障注入 e2e（`SIGKILL` 单节点 / 全部节点 / 超出容错上限 / 单节点数据卷删除）

**Target Platform**: 运行时为 Linux 容器。宿主：Windows 10+（Docker Desktop，WSL2 后端）× 2、Ubuntu 22.04 LTS（Docker Engine）× 3

**Project Type**: 区块链基础设施 —— 容器编排 + 由唯一事实来源驱动的配置生成 + 验证工具链。无应用代码、无链下持久状态

**Performance Goals**: 崩溃后恢复到中断前高度 ≤ 5 分钟（SC-001）；单验证者重启追平 ≤ 2 分钟（SC-004）；单边界启动耗时 ≤ 当前的 1.5 倍（SC-007）

**Constraints**: 创世哈希 `0x19cfde1f02e5…92ed`、Chain ID 20189、Network ID 1337、6 个开发账户余额均不得变（FR-024）；13 项验证保持 100% 通过（FR-025）；容错上限 f ≤ ⌊n/4⌋，n=5 时 f=1（[001] R-05）；每个故障边界至多 1 个验证者（FR-021）

**Scale/Scope**: 7 个节点（5 个 L1 验证者 + 2 个 Primary Network 节点）；阶段一 1 个故障边界，阶段二 5 个故障边界 / 5 台机器

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 条 | 要求 | 本计划如何满足 | 结果 |
|---|---|---|---|
| 一 区块链优先 | 共识状态只由链定义 | 恢复能力完全落在节点自身数据库上；不引入任何链下状态副本或影子记账 | ✅ |
| 二 链上/链下分工 | 每功能标注 | 链上：验证者集合（PoA 合约，不改）。链下：拓扑声明、配置生成、容器编排、验证。同步：链下只读 RPC / Info API | ✅ |
| 三 EVM 兼容 | 标准优先、偏离必须记录 | 不触碰 EVM 层；Subnet-EVM 版本与 feeConfig 一律不变，创世哈希受 FR-024 保护 | ✅（不适用） |
| 四 安全优先 | 无真实秘密入库；dev/prod 分离 | 不新增任何密钥；既有开发 staking 材料继续受 v1.1.0 例外四条件约束（FR-029）；`http-allowed-hosts` 的放宽成为显式的版本控制决策而非隐式默认（R-07） | ✅ |
| 五 确定性 | 共识代码确定性 | 不编写共识/VM 代码；只改节点如何被启动与配置 | ✅（不适用） |
| 六 合约安全 | 成熟库、测试 | 不新增、不修改任何合约 | ✅（不适用） |
| 七 可复现 | Git → 环境 | 拓扑声明单点 + 生成全部节点配置与每机 compose；版本与 sha256 锁定沿用；跨机部署禁止手工步骤（FR-022） | ✅ |
| 八 测试优先 | 先定义验证 | quickstart 的故障场景与 12 项实现期验证（V-01…V-12）在实现前已定义；13 项既有验证不得回退 | ✅ |
| 九 可观测 | 日志/健康/分类 | US6：逐节点运行/健康/引导/高度/peers/故障边界；"追赶中"与"故障"可区分；沿用九类失败分类（FR-034） | ✅ |
| 十 API 明确 | 接口契约 | `contracts/`：节点运行时契约、拓扑声明 schema、建链制品 schema、部署契约 | ✅ |
| 十一 模块边界 | 层次清晰 | 节点（容器）↔ 拓扑生成器 ↔ 验证器，三者单向依赖；验证器只经 RPC / Info API 访问链 | ✅ |
| 十二 AI 治理 | 不臆测协议、记录不确定 | research.md 每条附 [实测]/[文档]/[001] 来源；12 项实现期验证清单显式列出；V-08 标记为"答案为否即需改设计" | ✅ |
| 十三 依赖选型 | 成熟稳定、有理由 | **净减少依赖**：运行时移除 Avalanche CLI 与 socat；不引入 Swarm / Kubernetes / 配置管理工具（R-10） | ✅ |
| 十四 决策可追踪 | ADR + 参数记录 | 本特性关闭 ADR 待决项 "validator decentralisation path"；新增 ADR 覆盖运行时脱离 CLI、建链制品固化、Windows 边界自启、故障边界独立性 | ✅ |
| 十五 协议变更控制 | Spec→兼容→迁移→回归→Review | 验证者数量与全部共识参数不变，**不构成协议变更**；拓扑与寻址参数纳入 `configVersion` 管理，变更触发漂移测试 | ✅ |
| 十六 唯一事实来源 | 参数单点 | 拓扑、寻址、故障边界全部由 `blockchain/protocol.json` 派生（FR-027）；建链制品作为第二类事实单独登记（见 Complexity Tracking） | ✅ |
| 十七 DoD | 全项 | tasks 阶段按 DoD 组织；阶段一与阶段二各有独立验收边界 | ✅ |

**Gate 结论（Phase 0 前）**：通过，无违规。

**Gate 复查（Phase 1 后）**：通过。本特性相对 001 **净减少**了两处已登记的复杂度（Avalanche CLI 的运行期调用、socat 代理），新增的三处（建链制品作为第二类事实、Windows 边界可用性差异、Primary 节点冗余未决）均登记于 Complexity Tracking 并附否决理由或验证出口。

## Project Structure

### Documentation (this feature)

```text
specs/002-resilient-validator-network/
├── plan.md              # 本文件
├── research.md          # Phase 0：R-01…R-13 + 实现期验证清单 V-01…V-12
├── data-model.md        # Phase 1：拓扑、节点、故障边界、建链制品、恢复状态
├── quickstart.md        # Phase 1：故障与恢复的可运行验证场景
├── contracts/           # Phase 1：节点运行时、拓扑 schema、建链制品 schema、部署契约
├── checklists/
│   └── requirements.md  # 规格质量清单（已 15/15）
└── tasks.md             # Phase 2 输出（/speckit-tasks，本命令不产出）
```

### Source Code (repository root)

```text
blockchain/
├── protocol.json                    # 唯一事实来源 —— 扩充 topology / failureDomains / endpoints
├── protocol.schema.json             # 同步扩充
├── chain-identity/                  # 新增：建链制品（第二类事实，见 Complexity Tracking）
│   ├── karmachain.identity.json     #   SubnetID / BlockchainID / 引导验证者集合
│   └── primary-network.genesis.json #   Primary Network 创世
├── genesis/                         # 不变（创世哈希受 FR-024 保护）
├── accounts/                        # 不变
└── validators/dev/node-{1..5}/      # 不变 —— 改为由节点以显式标志直接消费（R-03）

docker/
├── node/                            # 新增：单节点运行时镜像
│   ├── Dockerfile                   #   FROM avaplatform/avalanchego:v1.14.1 + subnet-evm 插件
│   ├── entrypoint.sh                #   组装标志 → exec avalanchego（无编排逻辑）
│   └── healthcheck.sh               #   /ext/health + 引导状态 + 追赶进度
├── bootstrap/                       # 新增：一次性建链（含 Avalanche CLI，仅此处）
│   └── Dockerfile                   #   由 001 的 docker/devnet/ 收缩而来
├── verify/                          # 保留，扩充故障注入与多机检查
└── devnet/                          # 阶段一完成后退役（R-13）

tools/
├── protocol/
│   ├── render-node-flags.mjs        # 新增：拓扑 → 每节点 avalanchego 标志
│   ├── render-compose.mjs           # 新增：拓扑 → 每台机器一份 compose
│   ├── render-aliases.mjs           # 新增：BlockchainID → ["karmachain"]（R-05）
│   └── validate-topology.mjs        # 新增：容错约束校验（FR-021）
├── inspect/                         # 保留（list-contracts 等）
└── verify/                          # 保留，新增恢复与容错检查项

scripts/                             # 薄封装，新增按节点/按机器的启停
tests/{unit,integration,e2e}/        # 新增崩溃恢复、容错、拓扑校验、漂移
docs/adr/                            # 新增 ADR：脱离 CLI、制品固化、Windows 自启、边界独立性
```

**Structure Decision**: 沿用 001 已确立的分层——`blockchain/` 事实来源、`tools/protocol/` 生成器、`docker/` 运行时、`tools/verify/` 验证、`scripts/` 薄封装。本特性把 `docker/devnet/`（单容器 + CLI 编排）**拆成两个职责单一的镜像**：`docker/node/`（运行时，不含 CLI）与 `docker/bootstrap/`（一次性建链，含 CLI）。这个拆分正是"编排工具退出运行时路径"在目录结构上的体现，也使 FR-015 可由镜像构成静态验证。

## Complexity Tracking

> 仅记录需要论证的额外复杂度 / 依赖选择（宪法第十三条）。
> 本特性相对 001 **净减少**两项：Avalanche CLI 的运行期调用、socat 反向代理。

| 项 | 为何需要 | 更简单替代为何被否决 |
|---|---|---|
| 建链制品（SubnetID / BlockchainID / 引导验证者集合）作为"第二类事实"提交进仓库，而非由 `protocol.json` 派生 | 这些值是 P 链交易的产物：BlockchainID 取决于 CreateChainTx 的交易 ID，而交易 ID 取决于 P 链彼时的状态，无法由协议参数纯函数推导 | *每次启动重新建链* → BlockchainID 与 ValidationID 都变，等于每次都是新链，与"状态延续"直接冲突。*要求 BlockchainID 可复现* → 需要 P 链交易完全确定性，代价远超收益。缓解：与 001 已有的 `karmachain.genesis.hash` 同类处理——生成、提交、漂移测试、启动期校验；并用链别名（R-05）保证对外路径不受其变化影响 |
| 保留 Avalanche CLI 用于一次性建链 | ACP-77 的 L1 建链全流程（CreateSubnet → CreateChain → ConvertSubnetToL1 → PoA 初始化）没有其他可脚本化的官方路径（[001] R-01 结论未变） | *手写 P 链交易编排* → 工作量与风险远超本特性范围。缓解：**它已不在运行时路径上**——装在独立的 `docker/bootstrap/` 镜像里，运行时镜像不含它，FR-015 因此可由构成静态验证。维护模式风险从"每次启动都踩"降级为"只在重新建链时踩" |
| 两台 Windows 故障边界的可用性弱于 Linux 边界 | 硬件给定（2 Windows + 3 Ubuntu）。Docker Desktop 随用户会话启动，无受支持的开机服务方式 | *要求全部换成 Linux* → 用户硬件决策，不由本计划裁定。缓解：容错设计不依赖它——5 个边界容忍 1 个失效，Windows 边界晚回来只消耗余量；US6 的可观测性把"边界缺席"与"节点故障"区分开，使其停留在运维层面。候选方案见 R-11，由 V-09 实测选定并记入 ADR |
| ~~2 个 Primary Network 节点的冗余暂未设计~~ **已关闭（2026-09-06）** | ~~需先由 V-08 确定~~ | **V-08 实测结论：Primary 全停时 L1 照常出块**（4 笔交易全部 1.0s 确认，高度单调递增，验证者全程保持已引导）。Primary 节点不是单点，不会抵消 5 个验证者边界的冗余，**无需追加冗余设计**。当初不预先堆冗余的判断成立——那会是无谓复杂度。详见 research.md R-09 |
| 健康检查不能直接驱动重启（V-08 副产品） | 实测发现：Primary 全停期间链**完全正常出块**，但 5 个 L1 验证者的健康位**全部转为 false**（因其健康判定含 P 链可达性）。若照搬"不健康即重启"，一次局部故障会被放大成全链抖动 | *直接用节点自报的健康位* → 已被实测否决。判据必须改为"本节点能否参与 L1 出块"。这使 node-runtime 契约中"不得判为不健康"的情形从 1 种（追赶中）增加到 2 种，是本特性中唯一一处由实测倒逼的契约修订 |
| 故障边界的"独立性"无法由代码验证 | 代码能校验拓扑声明（每边界 ≤1 个验证者，FR-021），但无法验证两台机器真的会独立失效——共用供电、共用交换机、统一更新重启窗口都会让声明失真 | *忽略它* → 容错数学的前提被悄悄破坏，最典型的是两台 Windows 在同一补丁窗口重启 = 同时损失 2 个边界 = 链停摆。缓解：要求把共享失效因素写成显式声明并记入 ADR（R-12），由 US6 提供事后判别（同时失效 vs 级联故障） |
