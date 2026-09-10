# 数据模型：链状态与验证者网络实时监控面板（功能 003）

本文件定义面板的实体与判定规则。**所有判定必须是纯函数** —— 其中两条最重要的分支（观察者失明、全员启动中）在活链上很难制造，不能只靠跑一遍来验证。这沿用 002 `classify()` 的做法（源码注释：「纯函数 —— 状态机分支太多，必须能不靠活链测」）。

---

## 0. 一条必须先讲清的分歧：`countsAsOffline` **不能**直接用来算健康度

002 的 `classify()` 输出 `countsAsOffline`，其 `NOT_OFFLINE` 集合是：

```
healthy, catching-up, bootstrapping, starting
```

`bootstrapping` 在里面，因为 `devnet-status` 回答的问题是「**这个节点须不须要处置**」—— 引导中是"要等"，不是故障。这是对的。

但健康度回答的是**另一个问题**：「**链还能再掉几个验证者**」。引导中的验证者**尚未提供连接权益**，它对 α/k = 75% 的查询门槛毫无贡献。若直接复用 `countsAsOffline` 算健康度：

> 1 个 healthy + 4 个 bootstrapping → 离线数 0 → 显示 **100% 正常** —— 而链一个块都出不了。

这正是 002 实测过的处境（ubuntu-1 单独启动，其余四台未起）。因此本模型引入**第二个谓词**：

### 参与共识（`participatesInConsensus`）

| 状态 | 参与共识？ | 理由 |
|---|---|---|
| `healthy` | **是** | 已引导、已追平、在服务 L1 |
| `catching-up` | **是** | 已引导、**在服务 L1**，只是本地高度落后一个传播尾巴。FR-011 |
| `unreachable` 且 `countsAsOffline === false` | **是** | 其余节点的对等列表里有它 —— 链里有它，断的是本机到它的路径。FR-012 / FR-004a |
| `bootstrapping` | **否** | 尚未服务 L1，不提供连接权益 |
| `starting` | **否** | 进程在跑、API 未响应 |
| `stopped` | 否 | |
| `stalled` | 否 | |
| `unreachable` 且 `countsAsOffline === true` | 否 | 整域缺席，链里没有它 |
| `identity-mismatch` | 否 | |
| `data-corrupt` | 否 | |
| 非 `l1-validator`（Primary） | **不参与计数** | `countsTowardTolerance === false`。FR-014 |

**两个谓词各自服务一个问题，都要保留，互不替代：**

| 问题 | 谓词 | 用在哪 |
|---|---|---|
| 这个节点须不须要处置？ | `countsAsOffline`（既有） | 「须处置」清单、退出码 |
| 链还能再掉几个？ | `participatesInConsensus`（新增） | 健康度百分比、档位 |

这**不是**判据漂移（FR-004 所禁止的那种）：`participatesInConsensus` 是从既有 `state` + `countsAsOffline` **派生**的纯函数，不重新观测、不重新判断节点状态。它没有第二个事实来源。

---

## 1. NodeObservation（节点观测）

对单个节点在某一时刻的观测。前七个字段直接来自既有 `collect()` 的行结构，不改名。

| 字段 | 类型 | 来源 | 说明 |
|---|---|---|---|
| `id` | string | protocol.json | 如 `l1-3` |
| `role` | `"l1-validator" \| "primary"` | protocol.json | |
| `domain` | string | protocol.json | 所属故障边界 id |
| `address` | string | `deriveTopology`（可被 `KARMACHAIN_ADDRESS_OVERRIDE` 覆盖） | |
| `state` | 见下 | 既有 `classify()` | 9 个取值之一 |
| `detail` | string | 既有 `classify()` | 自由文本，给人读 |
| `countsAsOffline` | boolean | 既有 `classify()` | **须处置**语义 |
| `countsTowardTolerance` | boolean | 既有 `classify()` | 仅 l1-validator 为 true |
| `height` | number \| null | 既有 `probeNode` | |
| `peers` | number \| null | 既有 `probeNode` | |
| `genesisHash` | string \| null | **新增**（研究 R-07） | 该节点自报的创世区块哈希 |
| `participatesInConsensus` | boolean | **新增**，第 0 节派生 | |
| `behindBlocks` | number \| null | **新增**，`networkHeight - height` | FR-016 |
| `genesisMatchesBaseline` | boolean \| null | **新增** | `null` = 未取到，**不等于**不匹配 |
| `incidentClass` | 见第 5 节 \| null | **新增** | FR-022 |

`state` 取值（既有 `ALL_STATES`，不得增删）：
`stopped` `starting` `bootstrapping` `catching-up` `healthy` `unreachable` `identity-mismatch` `data-corrupt` `stalled`

**`genesisMatchesBaseline` 的三值语义是刻意的。** `null`（未取到）必须与 `false`（不匹配）分开：把取不到当成不匹配会在链路抖动时虚报分叉，而分叉是比节点下线严重得多的警报 —— 虚报它一次，之后就没人信它了。

---

## 2. ObserverViewpoint（观察者视角）

**这是一个独立于链的实体。** 「面板连不上」与「节点坏了」是两件事；把它们混为一谈是 002 实测过的假报警来源（ubuntu-1 的线缆丢包）。

| 字段 | 类型 | 说明 |
|---|---|---|
| `reachableNodes` | number | 本轮探测中 `probe.reachable === true` 的节点数 |
| `totalNodes` | number | 拓扑声明的节点数 |
| `blind` | boolean | `reachableNodes === 0` |
| `pathAlive` | `{ domain: string, alive: boolean }[]` | **佐证信号**：能否从该边界的已发布 RPC 端口取得**任何** HTTP 应答（含 502/504）。任何应答都证明到那台机器的网络路径是通的 |

### `pathAlive` 为什么值得多发 5 个请求

`blind` 为真时，面板**在原理上无法**区分两件事：全网真的停机了，还是本机失去了观测能力 —— 两者的网络表征完全相同。`pathAlive` 提供一个独立通道：nginx 代理与节点是**不同的进程、不同的端口**。节点全停而机器活着时，代理会回 502/504 —— 而一个 502 就足以证明"路径通、机器活着"。

**它只改变措辞，永不改变档位**（见第 4 节的优先级 P1）：

| `blind` | 有任一 `pathAlive` | 面板措辞 |
|---|---|---|
| 是 | 是 | 「失去观测能力 —— 但到 N 台机器的网络路径是通的，节点确实不应答。请到机器上确认节点进程」 |
| 是 | 否 | 「失去观测能力 —— 五台机器的端口全部无应答，更像本机网络问题。请先检查本机网卡与交换机」 |
| 否 | — | 不适用 |

---

## 3. FaultToleranceView（容错视图）

前七项直接取既有 `faultTolerance()` 的输出，**不重算**。后两项为本特性派生。

| 字段 | 来源 |
|---|---|
| `validatorCount` (n) | 既有 |
| `maxOfflineValidators` (f) | 既有，由 f ≤ ⌊n/4⌋ 推出 |
| `domainCount` | 既有 |
| `maxValidatorsPerDomain` | 既有 |
| `declaredWithinLimit` | 既有（T-5 校验） |
| `effectiveDomainCount` | 既有（并查集后的有效边界数） |
| `effectiveDomains[]` | 既有：`{ ids, factors, validators }` |
| `tolerateWholeDomainLoss` | 既有（布尔） |
| **`validatorMargin`** | 新增：`max(0, f - notParticipatingCount)` |
| **`domainMargin`** | 新增：见下 |

### `domainMargin`（边界级余量，FR-010）

> 最大的 k，使得**任意** k 个有效边界同时整体失效后，不参与共识的验证者数仍 ≤ f。

计算：把 `effectiveDomains` 按 `validators` **降序**排列，从当前已不参与的数量开始累加，能加进几个而不超过 f，就是 k。取最坏情况（降序）而非平均 —— 容错承诺必须按最坏边界给。

必须用 **`effectiveDomains`**（并查集后）而非声明的 `failureDomains`。002 的 `load.mjs:259` 就此留了一条注释：按声明边界判会得到「可容忍 1 个边界整体失效 [OK]」这样**在现实里为假的绿灯**，因为共享失效因素（同一路供电、同一台交换机）会被绿灯掩盖。

**为什么必须与 `validatorMargin` 分开显示**：两者可以不同。若两个验证者挤到同一台机器，`validatorMargin` 仍是 1（还能掉一个验证者），但 `domainMargin` 变成 0（那台机器一挂就同时掉两个）。只看前者会高估冗余。

---

## 4. HealthTier（健康度档位）

### 档位取值

| 档位 | 含义 | 呈现 |
|---|---|---|
| `observer-blind` | 面板失去观测能力 | 醒目但**不是**链故障色；文案指向本机网络 |
| `starting` | 尚未达到查询门槛，且缺口全部由启动中的节点造成 | 中性"等待"色 |
| `normal` | 参与数 ≥ 门槛，且 `validatorMargin` ≥ 1 | 正常色 |
| `zero-margin` | 参与数 ≥ 门槛，但 `validatorMargin` === 0 | **高危色**，文案必须写明**链仍在出块** |
| `stopped` | 参与数 < 门槛，且缺口含真实故障 | **显目报警**，说明成因与恢复所需 |

### 判定顺序（严格优先级，不得调换）

```
P1  observer.blind                          → observer-blind
P2  participating < threshold
      且全部未参与者 ∈ {bootstrapping, starting}   → starting
P3  participating < threshold                → stopped
P4  validatorMargin === 0                    → zero-margin
P5  否则                                     → normal
```

其中：

```
participating = 计数验证者中 participatesInConsensus 为真的个数
threshold     = validatorCount - maxOfflineValidators        // n=5, f=1 → 4
healthPercent = round(participating / validatorCount * 100)
```

**`threshold` 与 `healthPercent` 都不含任何字面阈值。** 75 / 80 / 60 / 5 一个都不出现在代码里（FR-006）。80% 与 60% 是 n=5, f=1 时的**算出结果**，不是输入。

### 为什么优先级必须是这个顺序

| 若调换 | 后果 |
|---|---|
| P1 放到 P3 之后 | 观察者本机断网 → 7 个节点全不可达 → `seenByPeers` 为空、每边界 `domainAllUnreachable` → 5 个验证者全判不参与 → 落进 P3 报「**链已停止**」。**这正是既有代码孤立使用时的默认行为，也正是 FR-020 明令禁止的假报警。** 002 已实测过这类误报的代价 |
| P2 放到 P3 之后 | 跨机分批启动期间报「链已停止」，而正确结论是"还在等其余边界"。002 实测：ubuntu-1 单独启动时既有健康检查报 `stalled — 需要处置`，而真正成因是 ubuntu-2 未启动，本机无任何可处置之处 |
| P2 放到 P1 之前 | 观察者失明时，若恰好有节点停在 bootstrapping，会报「启动中」而掩盖掉"面板自己瞎了"这个真相 |
| P4 放到 P3 之前 | 逻辑上不可达（`margin===0` 时 participating 必 ≥ threshold），但写反了会让 `stopped` 永不触发 —— 一个**永不变红的报警**。必须有测试专门覆盖 |

### 档位**不得**如何（FR-008 / FR-015 / FR-020）

- `zero-margin` 的文案**不得**出现"链已停止"或同义表述。它是"最后一格仍在工作"。
- **不得**因高度长时间不变而改变档位。高度完全不参与档位判定 —— 本链无交易不出块。
- **不得**从 `observer.blind` 推出 `stopped`。0/7 可达在原理上无法区分全网停机与本机失明；面板选择**永不**在这种观测下报"链已停止"，理由是：一个因为自己网络坏了就喊"链停了"的面板，会摧毁报警的可信度，而报警不可信就等于没有报警。代价是"全网真停机"这一情形会被表述为"失去观测能力（到机器的路径通/不通）"，由 `pathAlive` 把话说到能指路的程度。

---

## 5. IncidentClass（异常分类，FR-022）

宪法第九条要求区分故障类别，因为**处置方式完全不同**。分类由 `state` + `countsAsOffline` 派生：

| 分类 | 触发状态 | 处置方向 |
|---|---|---|
| `observation` | `unreachable` 且 `countsAsOffline === false`；或整体 `observer-blind` | **修本机的网络路径。链是好的，别去动那台机器** |
| `node-infra` | `stopped`、`unreachable`(整域)、`data-corrupt`、`identity-mismatch` | 去那台机器看节点进程/卷/密钥 |
| `sync-lag` | `catching-up`、`bootstrapping`、`starting` | **等**。不是故障，不得触发处置 |
| `consensus-margin` | 档位为 `zero-margin` 或 `stopped` | 恢复验证者数量，不是修单个节点 |
| `chain-identity` | `genesisMatchesBaseline === false` | 该机器跑在另一条链上 —— 比下线严重，**且不表现为健康度下降** |

`healthy` 状态不产生异常条目。`incidentClass` 为 `null` 表示无异常。

**分类必须机器可读**（枚举），不能只靠既有 `detail` 自由文本 —— 页面要按分类分组，测试要按分类断言（SC-020：无未分类异常）。

---

## 6. ChainIdentityView（链身份与分叉判定）

| 字段 | 来源 | 说明 |
|---|---|---|
| `chainId` | protocol.json | 20189 |
| `networkId` | protocol.json | 1337 |
| `blockchainId` | `blockchain/chain-identity/karmachain.identity.json` | |
| `chainAlias` | protocol.json | `karmachain` |
| `baselineGenesisHash` | `blockchain/genesis/karmachain.genesis.hash` | `0x19cfde1f…92ed` |
| `forkDetected` | 派生 | 存在任一节点 `genesisMatchesBaseline === false` |
| `unknownGenesis` | 派生 | 存在任一**可达**节点 `genesisHash === null` |

**`forkDetected` 独立于健康度与档位**（FR-025）。一个创世不一致的节点自己活得很好，健康度可以是 100% —— 它只是不在同一条链上。因此分叉是一条**并列**的警报，不是健康度的一个档位。

---

## 7. Snapshot（快照）

服务端每轮产出、页面消费的完整对象。

| 字段 | 类型 |
|---|---|
| `collectedAt` | number（epoch 毫秒，服务端时钟） |
| `pollIntervalMs` | number |
| `deployment` | string（`lan` / `local`） |
| `networkHeight` | number \| null（全部可达节点高度的最大值） |
| `tier` | HealthTier |
| `healthPercent` | number |
| `participating` / `threshold` | number |
| `faultTolerance` | FaultToleranceView（含两个 margin） |
| `observer` | ObserverViewpoint |
| `chainIdentity` | ChainIdentityView |
| `nodes` | NodeObservation[] |
| `incidents` | `{ nodeId?, class, message }[]` |
| `summaryLine` | string（既有 `summarize().line`，原样保留供对照） |

### 新鲜度（FR-021）

页面按 `age = now - collectedAt` 呈现：

| age | 呈现 |
|---|---|
| ≤ 2 × `pollIntervalMs` | 正常，显示"N 秒前" |
| > 3 × `pollIntervalMs` | **显目标为陈旧**，并保留最后已知值但明确标注它不是当前状态 |
| 取不到快照 | 显示上一次成功的时刻与陈旧标注，**不得**空白或静默保留旧画面 |

`collectedAt` 用服务端时钟，`age` 用浏览器时钟 —— 两者同在一台机器上，因此不做跨机时间比较（假设已记在规格里）。

**为什么这条必须显式**：既有 `readContainers()` 的注释把理由说到位了 —— 「**过期的事实比没有事实更坏**：它看起来像证据，而且恰好把判定推向错误的分支」。面板同理：一张静静停在"100% 正常"的画面，比一张明说"数据已陈旧 47 秒"的画面危险得多。

---

## 8. PublicProjection（公开投影，FR-026/027）

**显式字段白名单**，方向是"挑出允许的"而非"删掉不允许的"：

```
chainId, networkId, chainAlias, rpcPath, publishedHosts,
networkHeight, tier, healthPercent, collectedAt
```

**禁止出现**（FR-027）：`nodeId` / `NodeID-` 前缀、`address` 与任何私网地址段、`domain`、`detail`、容器名、宿主主机名、仓库内路径、内部组件版本号、`genesisHash`、`peers`。

`publishedHosts` 取自 `endpoints.publishedHosts`（当前仅 `127.0.0.1` / `localhost`），既有测试已禁止该字段含私网地址 —— 因此它是安全的，且**不得**在此处替换成 `failureDomains[].address`。

白名单方向是唯一能随快照结构演进而保持安全的方向：黑名单在有人给快照加字段时**默认放行**，而那正是泄漏发生的方式。

守卫见 `contracts/dashboard-api.md`，含一条**行为探针** —— 喂一个刻意含 `nodeId`/`address`/内部路径的假快照，断言这些值不出现在输出里。只断言"代码里有个白名单常量"是 002 反复教过的那种**不会变红的守卫**。
