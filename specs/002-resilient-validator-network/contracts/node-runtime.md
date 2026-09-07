# Contract: 节点运行时

**Feature**: `002-resilient-validator-network` | **Status**: Draft

定义**单个节点容器**的对外契约。本契约取代 001 的"单容器承载 7 个进程 + socat 代理"模型。

## 镜像

| | |
|---|---|
| 基底 | `avaplatform/avalanchego:v1.14.1`（官方，已实测 `linux/amd64` + `linux/arm64`） |
| 叠加 | `subnet-evm v0.8.0` 插件（sha256 校验，版本源自 `protocol.json`）、健康检查脚本 |
| **不得包含** | **Avalanche CLI** —— FR-015 由镜像构成静态保证 |

镜像不含任何编排逻辑。入口脚本只做一件事：把生成好的标志组装成命令行，然后 `exec avalanchego`。**入口脚本中不得出现重试、快照、状态判断等编排行为**——那些属于容器运行时的 `restart` 策略与共识协议本身。

## 生命周期

| 事件 | 行为 | 退出码 |
|---|---|---|
| 启动 | 校验身份材料与建链制品一致（见下）→ `exec avalanchego` | — |
| `SIGTERM` | 转发给 avalanchego，等待其自行退出 | 0 |
| `SIGKILL` / 宿主断电 | 无优雅路径 —— **这正是本特性要求能恢复的场景** | — |
| 重启 | 从自身 `--data-dir` 恢复，从对等节点补齐区块 | — |
| 身份/制品不一致 | 启动早期拒绝，不等待超时 | `12`（沿用 001 的"链数据与声明不一致"语义） |
| 身份材料缺失 | 启动早期拒绝 | `10`（沿用 001 的前置依赖缺失语义） |

**关键性质**：`SIGKILL` 后重启不需要任何外部记账。节点恢复所需的一切——数据库、身份材料、配置——都在它自己的卷与只读挂载里。

## 启动期校验（在 `exec` 之前）

| 校验 | 判据 | 失败 |
|---|---|---|
| 身份材料存在 | `keyDir` 下 `staker.crt` / `staker.key` / `signer.key` 均可读 | 退出 10，category `configuration` |
| NodeID 匹配 | 由 `staker.crt` 派生的 NodeID ∈ 制品的 `bootstrapValidators[].nodeId` | 退出 12，category `validator` |
| BLS 公钥匹配 | 由 `signer.key` 派生的公钥 == 该条目的 `blsPublicKey` | 退出 12，category `validator` |
| 制品版本相容 | 制品的 `vmVersion` / `rpcVersion` == `protocol.json` 声明 | 退出 12，category `configuration` |

这四项把"制品与密钥来自不同两次建链"这类错误拦在启动早期（FR-017），而不是让它表现为几分钟后的连接超时。

## 卷

| 挂载点 | 类型 | 模式 | 内容 |
|---|---|---|---|
| `/data` | 每节点独占命名卷 | 读写 | `--data-dir`：数据库、chainData、日志 |
| `/keys` | 仓库 `blockchain/validators/dev/node-N/` | **只读** | staking 身份材料 |
| `/config` | 生成的节点配置 | **只读** | 标志文件、链配置、`aliases.json` |

**卷即故障单元**：删除某个节点的 `/data` 卷并重启，该节点从对等节点重新同步，其余节点不受影响（FR-006）。这是"单节点数据损坏不需要全链重置"的实现基础。

## 端点

| 端口 | 用途 | 监听 |
|---|---|---|
| `httpPort` | JSON-RPC / Info / Health API | `--http-host=0.0.0.0` |
| `stakingPort` | P2P | 由 `--staking-port` 声明 |

`--http-allowed-hosts` 必须**显式声明**，不依赖默认值 `localhost`。001 记录的 `403 invalid host specified` 与公开文档中"必须用 IP 不能用域名"那条说明都源自该默认值；显式声明后，放宽与否成为版本控制下的决策（R-07）。

**socat 代理已退役**：001 因 avalanchego 被 CLI 固定在 `127.0.0.1` 而引入的反向代理不再需要（[001] plan.md 已将其登记为待简化项）。

## 健康检查

容器健康检查须能产出 data-model §7 的 `RecoveryState`，至少区分：

| 输出 | 判据 |
|---|---|
| `bootstrapping` | `/ext/health` 可达但 `info.isBootstrapped = false` |
| `catching-up` + 进度 | 已引导、本地高度 < 网络高度且**在增长** |
| `healthy` | 已引导、高度追平、peers 达标 |
| `stalled` | 处于追赶但高度在窗口内无进展 |

### 两种"看起来坏了、实际好着"的情形，都不得判为不健康

| 情形 | 若误判的后果 |
|---|---|
| **`catching-up`（正在追赶）** | 容器运行时会在节点正常追赶时反复重启它，把恢复变成死循环 |
| **P 链不可达但 L1 正常出块** | Primary 节点一挂，5 个**工作正常**的验证者会被同时重启，一次局部故障放大成全链抖动 |

第二条来自 **V-08 的实测**（2026-09-06）：停掉两个 Primary 节点后，链 4 笔交易全部 1.0s 确认、高度单调递增，但 5 个 L1 验证者的健康位**全部转为 false**——因为它们带 `partial-sync-primary-network=true`，健康判定包含 P 链可达性。`devnet-status` 当时报的是"7/7 nodes NOT healthy"，而链完全可用。

**因此健康判据必须以"本节点能否参与 L1 出块"为准，不得直接采用节点自报的综合健康位。** 这是本契约中最容易实现错的一条，也是唯一一处由实测倒逼修订的规则。

## 与容器运行时的分工

| 职责 | 归属 |
|---|---|
| 进程存活与重启 | 容器运行时（`restart` 策略） |
| 崩溃后的数据恢复 | avalanchego 自身（LevelDB 预写日志） |
| 缺失区块的补齐 | 共识协议（从对等节点同步） |
| 身份与配置的供给 | 只读挂载（仓库 + 生成物） |
| 编排、记账、快照 | **无人负责——本特性取消了这个角色** |

最后一行是本契约的要点：缺陷 A 的修复方式不是把编排做得更可靠，而是**让它不再是恢复路径的必经环节**。
