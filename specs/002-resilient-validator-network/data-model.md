# Phase 1 Data Model: 崩溃可恢复、可跨机部署的验证者网络

**Feature**: `002-resilient-validator-network` | **Date**: 2026-09-06

本文定义本特性引入的实体、字段、约束与状态迁移。所有结构最终落在两个位置：
**`blockchain/protocol.json`**（唯一事实来源，宪法第十六条）与
**`blockchain/chain-identity/`**（建链制品，第二类事实，见 plan.md Complexity Tracking）。

---

## 1. Topology（拓扑）

`protocol.json` 新增顶层键 `topology`。它声明**有哪些节点、节点属于哪个故障边界、部署在哪里**。

```jsonc
"topology": {
  "activeDeployment": "local",          // 当前生效的部署形态
  "nodes": [ /* Node[] */ ],
  "deployments": { /* name → Deployment */ }
}
```

### 约束

| 规则 | 判据 | 来源 |
|---|---|---|
| T-1 | `nodes` 中角色为 `l1-validator` 的数量 == `validators.count`（现为 5） | FR-024、避免与既有字段漂移 |
| T-2 | `nodes` 中角色为 `primary` 的数量 == `primaryNetwork.count`（现为 2） | 同上 |
| T-3 | `activeDeployment` 必须是 `deployments` 的一个键 | 配置完整性 |
| T-4 | 每个 Deployment 的故障边界成员并集 == `nodes` 的全集，且互不重叠 | 每个节点恰好属于一个边界 |
| T-5 | 任一故障边界内 `l1-validator` 数量 ≤ ⌊n/4⌋（n=5 时为 **1**） | **FR-021**，容错上限 |
| T-6 | 节点 `id` 全局唯一 | 引用完整性 |

> T-5 是本特性唯一一条会**拒绝启动**的拓扑约束。校验器必须报出：违规的边界 id、其中的验证者数量、允许上限，以及"把哪几个节点挪走"这一可执行的修正方向（FR-021）。

---

## 2. Node（节点）

网络的最小运行与故障单元。

| 字段 | 类型 | 说明 | 约束 |
|---|---|---|---|
| `id` | string | 稳定标识，如 `validator-1`、`primary-1` | 全局唯一；用作容器名与卷名的基底 |
| `role` | enum | `l1-validator` \| `primary` | 决定标志集合（见 §6） |
| `keyDir` | string | staking 材料目录，如 `blockchain/validators/dev/node-1/` | 仅 `l1-validator` 必填；须含 `staker.crt` / `staker.key` / `signer.key`（R-03） |
| `httpPort` | integer | 节点 HTTP API 端口 | 同一故障边界内不得重复 |
| `stakingPort` | integer | P2P staking 端口 | 同上 |

**身份不在此声明**：NodeID 由 `keyDir` 中的 `staker.crt` 唯一决定（R-03），不写进 `protocol.json`——写进去就成了第二份事实，且会与证书内容漂移。需要展示 NodeID 时由证书派生。

**端口的简化机会**：一节点一机器后，各机器上的节点可以共用同一组端口（9650/9651）。阶段一单机部署仍需逐节点错开。因此端口按**部署形态**取值：`local` 形态沿用 `protocol.json` 现有的 `validators.nodes[].httpPort/stakingPort`（9660…9669），`lan` 形态统一为 9650/9651。

---

## 3. FailureDomain（故障边界）

一组会同时失效的节点的边界。**这是本特性引入的核心新概念**：它不是部署方式的副产品，而是显式声明（FR-019）。

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 边界标识，如 `local`、`win-1`、`ubuntu-2` |
| `platform` | enum | `windows` \| `linux` —— 决定开机自启策略与健康检查差异（R-11） |
| `address` | string | 该边界对其他边界可达的地址（`public-ip` 与 `bootstrap-ips` 的取值来源） |
| `nodes` | string[] | 成员节点 `id` |
| `sharedFailureFactors` | string[] | **共享失效因素的显式声明**：供电分组、交换机、更新窗口等 |

### `sharedFailureFactors` 为什么必须存在

容错数学假设各边界独立失效。这个假设无法由代码验证（plan.md Complexity Tracking 已登记）。把它变成**必填的书面声明**，至少保证：

- 部署者被迫正面回答"这两台机器会不会一起挂"；
- 评审时可见（宪法第十四条）；
- 出事后能对照判断"是同时失效还是级联故障"（US6）。

典型取值：`"power:strip-A"`、`"switch:sw-1"`、`"update-window:patch-tuesday-0300"`。两个边界若共享同一因素且各含 1 个验证者，则该因素一旦触发即损失 2 个验证者——**超出上限**。校验器 SHOULD 就此告警（不阻断，因为共享交换机在 5 台开发机上通常无法避免）。

---

## 4. Deployment（部署形态）

```jsonc
"deployments": {
  "local": {
    "description": "单机全部节点，阶段一形态",
    "failureDomains": [
      { "id": "local", "platform": "linux", "address": "127.0.0.1",
        "nodes": ["validator-1","validator-2","validator-3","validator-4","validator-5","primary-1","primary-2"],
        "sharedFailureFactors": ["host:single-machine"] }
    ]
  },
  "lan": {
    "description": "5 台机器 5 个故障边界，阶段二形态",
    "failureDomains": [
      { "id": "win-1",    "platform": "windows", "nodes": ["validator-1"], "...": "..." },
      { "id": "win-2",    "platform": "windows", "nodes": ["validator-2"], "...": "..." },
      { "id": "ubuntu-1", "platform": "linux",   "nodes": ["validator-3","primary-1"], "...": "..." },
      { "id": "ubuntu-2", "platform": "linux",   "nodes": ["validator-4","primary-2"], "...": "..." },
      { "id": "ubuntu-3", "platform": "linux",   "nodes": ["validator-5"], "...": "..." }
    ]
  }
}
```

`local` 形态**故意违反不了 T-5**：它只有 1 个边界，含 5 个验证者。因此 T-5 只在边界数 > 1 时生效——阶段一不做容错承诺，spec Assumptions 已明确（"阶段一的故障边界数量为 1，不解决整机失效"）。校验器须据此区分，而不是让阶段一也报错。

### 地址的部署特异性

`address` 是**安装特有**的数据（`192.168.1.3` 只在这一套硬件上成立）。处理方式：

- 提交进 `protocol.json` 以满足 FR-022（跨机部署不得依赖手工步骤）；
- 允许每台机器以环境变量覆盖本边界的地址，用于 IP 变更或他人复用本仓库；
- **不得出现在任何面向第三方的公开制品中**（FR-028）——公开制品的 `publishedHosts` 规则不变，既有测试已强制禁止私网地址。

---

## 5. ChainIdentity（建链制品）

一次性建链的产出，运行期只读。落在 `blockchain/chain-identity/karmachain.identity.json`。

| 字段 | 实测值（2026-09-05 那次建链） | 运行期用途 |
|---|---|---|
| `subnetId` | `2W9boARgCWL25z6pMFNtkCfNA5v28VGg9PmBgUJfuKndEdhrvw` | 每个验证者的 `--track-subnets` |
| `blockchainId` | `Wd8yzG1cggbUi2nqKC5RzJM8Vz8w7CEisxcvMRJiWwRVLhTqd` | 链配置键、别名映射 |
| `chainAlias` | `karmachain` | `/ext/bc/karmachain/rpc` 的来源（R-05） |
| `vm` / `vmVersion` / `rpcVersion` | `Subnet-EVM` / `v0.8.0` / `44` | 与 `protocol.json` 版本锁定交叉校验 |
| `bootstrapValidators[5]` | 见下 | 初始验证者集合 |
| `createdAt` | 建链时间 | 溯源 |

### BootstrapValidator

| 字段 | 说明 | 约束 |
|---|---|---|
| `nodeId` | `NodeID-…` | **MUST** 等于对应 `keyDir/staker.crt` 派生出的 NodeID |
| `weight` | 权重，实测 `100` | 5 个验证者等权是容错计算的前提（[001] R-05） |
| `balance` | 实测 `100000000` | — |
| `blsPublicKey` / `blsProofOfPossession` | BLS 公钥与拥有证明 | **MUST** 与 `keyDir/signer.key` 一致 |
| `changeOwnerAddr` | `P-custom1…` | — |
| `validationId` | 链上验证记录标识 | — |

**交叉校验是本实体存在的意义**：`nodeId` ↔ `staker.crt`、`blsPublicKey` ↔ `signer.key` 这两条必须在启动早期校验。任一不符即说明"制品与密钥材料来自不同的两次建链"，须立即拒绝并说明（FR-017），而不是让节点带着错误身份去连网络，最后表现为难以诊断的"连不上"。

---

## 6. NodeFlags（派生物，不可手改）

由 `topology` + `chain-identity` + 既有 `protocol.json` 字段生成的每节点 avalanchego 标志集合。**生成物**，受漂移测试保护（FR-027）。

落盘位置 `blockchain/nodes/<deployment>/<nodeId>.flags.json` —— **逐部署形态各一份**。
表中 `--public-ip`、`--bootstrap-ips`、`--http-allowed-hosts` 三项取值随形态变化（单机形态用容器网段，
跨机形态用各机器的局域网地址），只渲染 `activeDeployment` 一份会导致把仓库拷到另一台机器跑跨机形态时，
节点仍在用那台机器上不存在的容器地址。与形态无关的伴生物（`<nodeId>.identity.json`、`aliases.json`、
`chain-config/`）留在 `blockchain/nodes/` 顶层。`rpc-proxy.conf` 同样逐形态生成（上游地址随形态变化）。

| 标志 | 取值来源 | 角色差异 |
|---|---|---|
| `--network-id` | `avalanche.networkId` = 1337 | 相同 |
| `--data-dir` | 容器内固定路径，映射到节点独占卷 | 相同 |
| `--db-type` | `leveldb`（默认，显式声明） | 相同 |
| `--staking-tls-cert-file` / `--staking-tls-key-file` / `--staking-signer-key-file` | `node.keyDir` 下三件（R-03） | 仅 `l1-validator` |
| `--track-subnets` | `chainIdentity.subnetId` | 仅 `l1-validator` |
| `--partial-sync-primary-network` | `true` | 仅 `l1-validator`（实测值） |
| `--sybil-protection-enabled` | `true` | 仅 `l1-validator`（实测值） |
| `--plugin-dir` | 镜像内固定路径（subnet-evm 所在） | 仅 `l1-validator` |
| `--chain-aliases-file` | 由 `render-aliases.mjs` 生成（R-05） | 仅 `l1-validator` |
| `--bootstrap-ips` / `--bootstrap-ids` | Primary 节点的 `address:stakingPort` 与其 NodeID | 验证者填；Primary 创世节点留空（实测值） |
| `--http-host` | `0.0.0.0`（R-07，socat 退役） | 相同 |
| `--http-allowed-hosts` | 显式声明，取值由部署形态决定 | 相同 |
| `--http-port` / `--staking-port` | `node.httpPort` / `node.stakingPort` | 相同 |
| `--public-ip` | 所属故障边界的 `address` | 相同 |
| `--network-allow-private-ips` | `true`（默认，显式声明） | 相同 |

对照 Phase 0 实测的 `flags.json`，本表覆盖了其中除 `chain-config-content` / `genesis-file-content`（改用文件形式）与若干调优项（`health-check-frequency`、`network-max-reconnect-delay` 等）之外的全部条目。调优项是否保留，在 tasks 阶段按"不改变行为的默认值不显式声明"的原则逐条决定。

---

## 7. RecoveryState（恢复状态）

单个节点在崩溃后的处境。US6 要求"追赶中"与"故障"可区分（FR-032），本实体是其数据基础。

```text
                    ┌──────────────────────────────────────┐
                    ↓                                      │
  stopped ──► starting ──► bootstrapping ──► catching-up ──┴──► healthy
                 │              │                 │                │
                 │              │                 │                ↓
                 │              │                 │           unreachable
                 │              │                 │          （边界缺席）
                 ↓              ↓                 ↓
          identity-mismatch  data-corrupt    stalled
             （终态·须修）   （终态·须重建）  （超时无进展）
```

| 状态 | 判据 | 运维含义 |
|---|---|---|
| `stopped` | 容器未运行 | 预期内，或边界缺席 |
| `starting` | 进程在跑，API 未响应 | 等待 |
| `bootstrapping` | `info.isBootstrapped = false` | 等待 |
| `catching-up` | 已引导，本地高度 < 网络高度且**在增长** | **等待**——须给出进度（FR-032） |
| `healthy` | 已引导、高度追平、peers 达标 | 正常 |
| `unreachable` | 容器运行状态未知（整个边界不可达） | **区别于节点故障**：去看那台机器 |
| `identity-mismatch` | NodeID 与制品中的 `bootstrapValidators` 不符 | 终态，须处置（FR-017） |
| `data-corrupt` | 数据库打不开 | 终态，重建该节点即可（FR-006），**不需全链重置** |
| `stalled` | 处于 `catching-up` 但高度在超时窗口内无进展 | 须处置 |

`catching-up` 与 `stalled` 的分界是本状态机唯一需要**时间窗口**的判定。窗口长度由 SC-004（单节点追平 ≤ 2 分钟）反推，具体取值在实现期由 V-01 实测确定，不在此预设。

---

## 实体关系

```text
protocol.json
  └─ topology
       ├─ nodes[]  ──────────────┐
       └─ deployments{}          │  (id 引用)
            └─ failureDomains[] ─┘
                 └─ sharedFailureFactors[]

chain-identity/karmachain.identity.json
  └─ bootstrapValidators[] ──(nodeId ↔ staker.crt, blsPublicKey ↔ signer.key)──► node.keyDir

topology + chainIdentity + protocol.json
  └─► NodeFlags（生成物，漂移测试保护）
       └─► 每台机器一份 compose（生成物）

运行期
  └─ Node ──► RecoveryState（观测得出，非配置）
```
