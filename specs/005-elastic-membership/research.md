# Phase 0 · 研究与决策：弹性成员管理

**日期**：2026-09-11
**规格**：[spec.md](./spec.md)

---

## 一、范围 A 最有力的论据来自本仓库自己的历史

`configVersion` 至今递增过四次，每一次都让七个节点的出生证明失配、**逼出一次全链重置**：

| 版本 | 日期 | 改了什么 | 这是协议变更吗 |
|---|---|---|---|
| 1.1.0 | 2026-09-02 | 调整开发账户的**创世分配** | ✅ **是** —— 动了创世 |
| 1.2.0 | 2026-09-04 | 新增 `endpoints.publishedHosts` | ❌ 不是 —— RPC 主机名 |
| 1.3.0 | 2026-09-06 | 新增 `topology` | ❌ 不是 —— 机器与边界 |
| 1.4.0 | 2026-09-06 | 节点端口 9650–9669 → 21650–21669 | ❌ 不是 —— 端口 |

**四次里三次是部署变更。** 每一次都丢掉了当时的全部链上状态，
而丢弃的理由是"配置版本变了"—— 可链的身份一个字节都没动。

> 这不是事后诸葛。1.2.0 到 1.4.0 那三次发生在建链初期，重置的代价近乎为零，
> 所以没人觉得不对。**代价是现在才显现的**：链上已经有 890 多个区块与合约状态，
> 而用户想加一台机器。

---

## 二、决策

### R-01 · 分家的切法：按「改了它要不要换一条链」分，不按字段名分

**决策**：判据是**一个问题**，不是一张字段清单 ——

> 改了这个字段，**已经存在的链上状态还有没有意义**？

| 类别 | 字段 | 改了之后 |
|---|---|---|
| **协议参数**（留下，stamp 保护） | `chain`、`avalanche.networkId`、`nativeToken`、`feeConfig`、`allowFeeRecipients`、`blockProduction`、`devAccounts`、`validators.management` / `ownerAccount`、`environment`、`name` | **是另一条链** —— 旧状态无意义，必须重置 |
| **部署描述**（移出，不进 stamp） | `topology`、`endpoints`、`validators.nodes[]`（端口 / keyDir）、`validators.count`、`primaryNetwork.nodeCount` | **同一条链换了部署** —— 旧状态照常有效 |

**三个需要在 plan 阶段确认的边界情形**：

1. **`avalanche.avalanchegoVersion` / `subnetEvmVersion` / `avalancheCliVersion`** ——
   它们是**组件版本**，不是链身份。但换 VM 版本可能改变执行语义（宪法第十五条列了 "VM Behavior"）。
   **倾向：留在协议参数侧**，理由是"换 VM 可能改变状态转移"比"它是不是部署描述"更重要。
2. **`endpoints.rpcPath`** —— 形如 `/ext/bc/<别名>/rpc`，由 `blockchainName` 派生。
   它是**访问路径**（部署），但取值依赖协议参数。**倾向：移出，并加一条守卫比对它与 `blockchainName` 的一致性。**
3. **`validators.count`** —— 按 spec 的 Assumption 降级为**期望成员数**。
   它仍用于建链与 T-5 校验，但不再是"现在有几个验证者"的答案（那在链上）。

### R-02 · 爆炸半径：37 个文件 203 处，但**真正要改的远少于此**

实测统计（`grep -rn topology`）：

| | 数量 |
|---|---|
| 提到 `topology` 的文件 | **37** |
| 提及总数 | **203** |
| 其中 `tools/protocol/load.mjs` | 14 |

**但绝大多数消费者用的是 `deriveTopology()` 的输出**（`d.topologyNodes`、`faultTolerance`），
**不是**原始的 `protocol.topology`。

**因此本期的核心约束是：`deriveTopology()` 的输出形状逐字段不变。**
做到这一点，下列文件**一行都不用改**：
`render-compose.mjs`、`render-node-flags.mjs`、`render-rpc-proxy.mjs`、
`tools/dashboard/poll.mjs`、`tools/inspect/node-status.mjs`、
`tools/verify/lib/avalanche-api.mjs` 等等。

**真正要改的三类**：

| 类 | 清单 | 数量 |
|---|---|---|
| ① 装载层 | `tools/protocol/load.mjs`（读新文件）、JSON schema（拆成两份） | 2 |
| ② 直接读 `protocol.topology` 的测试 | `cross-host-reachability`、`dashboard-nodes`、`dashboard-topology-parity`、`node-runtime`、`public-ip-guard`、`status-recovery-states`、`topology-cli`、`docs-drift`、`identity-crosscheck`、`proxy-health-boundaries`、`render-compose`、`render-node-flags` 等 | **约 12** |
| ③ shell 侧直接 `jq` | `docker/bootstrap/entrypoint.sh`（`jq '.topology.nodes[]'`） | 1 |

**这也给出了本期最强的一条不回归判据**：分家前后**全部生成物逐字节相同**（FR-007 / SC-003）。
生成物一共 10 项，由 `npm run render:check` 核对 —— 它会把任何遗漏抓出来。

### R-03 · 验证者注册：合约在，**ABI 不在**

**已核实**：`blockchain/genesis/validator-manager.alloc.json` 预部署了**四个**合约，
由 Avalanche CLI **v1.9.6** 的 `avalanche blockchain create --evm --test-defaults --proof-of-authority`
注入（`extractedFrom` 字段有完整记录）：

| 地址 | code 长度 | 有 storage |
|---|---|---|
| `0c0deba5e0…` | 30920 字符 | — |
| `0feedc0de0…` | 4378 字符 | ✅ |
| `9c00629ce7…` | 17062 字符 | — |
| `a0affe1234…` | 3370 字符 | ✅ |

两个带 `storage` 的是已初始化的**代理**与 **owner/admin**。

**缺的是 ABI。** ADR 索引已经记着这件事：「`chain-info.json` 的 `contracts` 目前只有地址、
**没有 ABI**」。本期要调用 `ValidatorManager` 的注册接口，就必须先有 ABI。

**三条取得途径，plan 阶段选**：

| 途径 | 代价 |
|---|---|
| 从 Avalanche 的 `icm-contracts` 仓库取对应版本的 ABI，**vendor 成一个 JSON 文件** | 不是运行时依赖（只是一份数据），但要锁版本并说明它与 CLI v1.9.6 的对应关系 |
| 从链上反推（`eth_getCode` + 已知选择器） | 不需要外部来源，但脆弱且难核对 —— **不推荐** |
| 只用 Avalanche CLI 的命令（`avalanche blockchain addValidator`） | **与 ADR-0008 冲突** —— CLI 已退出运行时，请回来要推翻那条 ADR |

**倾向：vendor ABI**。它是数据不是依赖，且能被漂移测试锁住（ABI 与 `avalancheCliVersion` 必须对得上）。

**已有可复用的合约调用能力**：`scripts/devnet-contracts` + `tools/verify/` 已经能编译并部署合约
（solc 在 verify 镜像里、调用走 `viem`）。范围 B 不需要从零建工具链。

### R-03 的结论（T004，2026-09-14 定）

**都不选那三条，用第四条：手写最小 ABI，每一项对着字节码离线核验。**

方法：**提出候选签名，用 keccak 命中来确认** —— 不是从字节码反推签名（R-03 标了"不推荐"），
而是我给出候选、由字节码裁决：

- 函数：`keccak256(sig).slice(0,10)` 必须出现在实现字节码的某个 `PUSH4` 操作数里
- 事件：`keccak256(sig)` 必须出现在某个 `PUSH32` 操作数里

命中即确认，**未命中的一律不写进 ABI**。为什么这比 vendor 外部 ABI 好：
vendor 要引入一份外部数据并**自行论证它与 CLI v1.9.6 对得上**，而那份论证
只能靠人读版本号 —— 正是本项目反复栽过的"自述式合规"。现在合约一变守卫就红。

制品：`tools/membership/abi/validator-manager.json`（11 个函数 / 5 个事件，带出处）
守卫：`tests/unit/validator-manager-abi.test.mjs`（**离线**，24 条，5 条变红检查全过）

能离线是因为 `blockchain/genesis/validator-manager.alloc.json` 里存着创世注入的完整字节码
（实现 30920 字符），而那正是链上跑着的那份 —— 对活链 `eth_getCode` 核对过长度一致。

**这条守卫不证明什么**：选择器只证明**签名存在**，不证明语义。参数含义与返回布局
它都说不了 —— 那部分见下面 V-24，是在活链上逐字段解码核实的。

---

## 三之二、US2 的实测（2026-09-14，全部对活链）

- **V-20** ✅ **实现合约的接口全部确认**。我提出的 15 个候选签名**全部命中**，
  正是 ACP-77 v2 的 `ValidatorManager`：

  | 选择器 | 签名 | 用途 |
  |---|---|---|
  | `0x9cb7624e` | `initiateValidatorRegistration(bytes,bytes,(uint32,address[]),(uint32,address[]),uint64)` | 加入第 1 步 |
  | `0xa3a65e48` | `completeValidatorRegistration(uint32)` | 加入第 4 步 |
  | `0xb6e6a2ca` | `initiateValidatorRemoval(bytes32)` | 退出第 1 步 |
  | `0x9681d940` | `completeValidatorRemoval(uint32)` | 退出第 4 步 |
  | `0xbee0a03f` | `resendRegisterValidatorMessage(bytes32)` | **重试**（FR-016） |
  | `0xfd7ac5e7` | `registeredValidators(bytes)` | NodeID → validationID |
  | `0xd5f20ff6` | `getValidator(bytes32)` | 读单个成员 |
  | `0xbb0b1938` | `l1TotalWeight()` | 总权重 |
  | `0x5dc1f535` | `subnetID()` | 子网 id |
  | `0x09c1df66` | `getChurnPeriodSeconds()` | churn 限制 |
  | `0x8da5cb5b` / `0xf2fde38b` / `0x715018a6` | `owner()` / `transferOwnership` / `renounceOwnership` | PoA 治理主体 |
  | `0x66109669` / `0xce161f14` | `initiateValidatorWeightUpdate` / `completeValidatorWeightUpdate` | 改权重（本期不用） |

  `PUSH4` 扫描会捞到非选择器的 4 字节常量（`0x4e487b71` 是 `Panic()`，
  `0x616c6c20` 是 ASCII `"all "`），所以**只用正向命中**，"未命中"那 61 个是噪声、不作结论。

- **V-21** ✅ **链上成员集合可以从事件重建，而且只能这么做。**
  实现合约**没有任何枚举函数** —— 选择器里只有按 NodeID 查的 `registeredValidators(bytes)`。
  这一点决定了实现路径：**按声明的 NodeID 逐个查，查不出"你不知道的成员"**，
  而那正是 data-model 第 2 节的第一种漂移（「链上有、声明里没有 —— 有人绕过工具加了一个」）。

  实测：代理地址上共 7 条日志 —— 区块 3 的 `OwnershipTransferred` 与 `Initialized(1)`，
  区块 4 的 **5 条 `RegisteredInitialValidator(bytes32,bytes20,uint64)`**，每个创世验证者一条。
  从事件重建出的 5 个 NodeID 与 `validators.nodes[]` 的证书派生结果**逐个对上**。

  九个候选事件签名（含注册/退出/改权重那几个至今未发生过的）**全部在字节码的
  `PUSH32` 常量里命中** —— 所以事件签名是离线可证的，不必等到第一次注册才知道写对没写对。

- **V-22** ✅ **五个验证者完全等权**：各 `weight = 100`，`l1TotalWeight() = 500`。
  这是 `f(n) = ⌊n/4⌋` 那套推导的前提（等权），现在在链上得到确认，不再是假设。

- **V-23** ✅ `owner()` = `0x8db97C7cEcE249c2b98bDC0226Cc4C2A57BF52FC`，
  即 `validators.ownerAccount` 声明的 `ewoq`。PoA 的治理主体与声明一致，签名密钥可用。

- **V-24** ✅ **`getValidator(bytes32)` 的返回布局逐字段解码确认**（352 字节）：

  ```
  status=2（Active）  nodeID=0x46967f15…  startingWeight=100
  sentNonce=0  receivedNonce=0  weight=100  startTime=1788857838  endTime=0
  ```

  选择器证明不了返回布局，所以这一条必须实测。同理 `owner()` / `subnetID()` /
  `l1TotalWeight()` / `getChurnPeriodSeconds()` 的返回类型也是这样核实的。

- **V-25** ⚠ **`getChurnPeriodSeconds() = 0` —— 成员变更没有速率限制。**
  少一个故障模式（不必处理"改得太频繁被拒"），但也说明这条链**没有**生产环境
  该有的 churn 保护。本期不改它（那是协议参数，属宪法第十五条），但要写进文档：
  **谁把这套流程搬去生产，churn period 必须先设起来。**

---

### R-04 · 成员的事实来源在链上 —— 并且要有一条漂移守卫

**决策**：链上是事实来源；部署描述只声明**期望成员**。两者不一致 **MUST 可见**（FR-030）。

**理由**：本期之后成员是**运行期可变**的。文件回答不了"现在有几个验证者" ——
它只能回答"我们打算有几个"。

**这与宪法第十六条不冲突**：第十六条要的是**协议参数**的唯一事实来源，
而成员集合在本期之后不再是协议参数。

**形状沿用 003/004 已有的做法**：面板已经在做"声明 vs 观测"的比对
（`declaredNodeId(n.id)` 与节点自报的 NodeID 对不上就报 `identity-mismatch`）。
成员漂移是同一个形状 —— **不新建一套呈现，扩既有的那套。**

### R-05 · 容错函数要对任意 n 正确，而这正是本仓库栽过的地方

**决策**：`f(n) = ` 最大的 f 使 `(n-f)/n ≥ 0.75`，对 n = 4…12 **逐行**写成测试。

| n | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
|---|---|---|---|---|---|---|---|---|---|
| f | 1 | 1 | 1 | 1 | 2 | 2 | 2 | 2 | 3 |

**为什么不能只测 n=5 和 n=8**：003 的 `contracts/health-tier.md` 第 4b 节记着一次
**错误外推** —— 从 n=5 的"4/5 = 80% 是零余量"推出"n=9 时 8/9 是零余量"，**推错了**
（n=9 的 f 是 2，掉 1 个仍有余量）。那次是自己写的测试抓出来的。

**本期扩容缩容都会走遍这些 n，所以每一格都要有。**

### R-06 · 缩容的代价必须在**动手之前**说出来

**决策**：退出操作在执行前打印 `n: A → B，可离线数: f(A) → f(B)`，
且 `f` 下降时要求显式确认（FR-011）。

**理由**：这是整条判据里**最反直觉**的一格。名册少一个看着无关紧要，
而 8 → 7 会把可离线数**从 2 砍到 1** —— 容错砍半，且事后从面板上只看得到"余量少了"，
看不到"是刚才那一步造成的"。

**与 004 的一致**：004 的 `recovery-blocked` 提示存在的全部理由，
就是"事实可见、后果不可见，是最容易出事的组合"。这里是同一件事的操作侧。

### R-07 · Primary 侧：**不预选**，由实测定

> ✅ **已定：取 F-7，但只让 4 个 L1 验证者兼任**（2026-09-16，见 **R-07b**）。
> 本节与下面的候选表保留为**当时的判断**，其中两处已被 R-07a 的取数证伪。

spec 的 FR-020 要求决定必须有实测数据。两条候选：

| | F-6 加到 ≥5 个 Primary | F-7 让 L1 验证者兼任 P 链验证者 |
|---|---|---|
| 要加机器吗 | 要（至少 3 台） | 不要 |
| 改什么 | Primary 数与权益分布 | 去掉 `partial-sync-primary-network` |
| 代价 | 机器、电、维护 | 每个 L1 节点多同步 X/C 链（磁盘 + 带宽） |
| 风险 | 无未知 | **未知**：完整同步对节点资源与启动时间的影响没量过 |

> ⚠ **这张表有两处已被 2026-09-16 的取数证伪，读表前先看 R-07a：**
> F-7 的「不要加机器」漏了「**要加质押**」（按最小质押执行买到零提升）；
> 「代价是磁盘 + 带宽」在这条开发网上**接近于零**（C/X 链高度都是 0），
> 真正的代价是一个操作顺序约束。表保留原样，因为它记录的是**当时的判断**。

**必须实测的四个数**（V-13…V-16）：
① 去掉 `partial-sync` 后单节点的磁盘增量与稳定后的带宽；
② 启动到 P 链引导完成的时间变化；
③ 把 L1 验证者加入 P 链验证者集合的实际流程与耗时；
④ 完成后掉 1 个权益持有者，被重启的验证者**能否**加入。

**在拿到这四个数之前不写任何实现。**

### R-07a · T043 的取数（2026-09-16，对活链只读观测）

**上面那张表里有两处是错的，而且错得关键。** 逐条给出证据。

#### ① F-7 的算术隐含了一个不成立的前提

spec 的 F-7 写着「若让这 5 个节点同时成为 P 链验证者，P 链就有 7 个验证者、
每个约 14%，掉 1 个还剩 86% ≥ 80%」。**「每个约 14%」是个假设，不是事实。**

实测的 P 链权益分布（`platform.getCurrentValidators`，经 primary-1）：

| NodeID | 权益 | 占比 |
|---|---|---|
| `NodeID-MFrZFVCXPv5iCn6M9K6XduxGTYp891xXZ` | 1,000,000 AVAX | 50% |
| `NodeID-7Xhw2mDxuDS44j42TCB6U5579esbSt3Lg` | 1,000,000 AVAX | 50% |

而 `platform.getMinStake` 给出 `minValidatorStake = 2,000,000,000,000` nAVAX
= **2000 AVAX**。也就是说新加的验证者**默认只有 Primary 的两千分之一**：

| 形态 | 总权益 | 各自占比 | 掉 1 个 Primary 后 |
|---|---|---|---|
| 现状：2 个 Primary | 2,000,000 | 各 50% | **50%** ❌ |
| F-7 按最小质押 + 6 个 × 2000 | 2,012,000 | Primary 各 49.7%、新增各 0.09% | **50.29%** ❌ |
| F-7 等权 + 6 个 × 1,000,000 | 8,000,000 | 各 12.5% | **87.5%** ✅ |
| F-7 折中 + 6 个 × 500,000 | 5,000,000 | Primary 各 20%、新增各 10% | **80%**（贴线）⚠ |
| F-6 加到 5 个 Primary（各 1,000,000） | 5,000,000 | 各 20% | **80%**（贴线）⚠ |
| F-6 加到 6 个 Primary | 6,000,000 | 各 16.7% | **83.3%** ✅ |

**按最小质押做 F-7 买到的是零提升**（50% → 50.29%）。要让 F-7 成立，
每个新增验证者得质押约 100 万 AVAX。

钱够：L1 成员的 `remainingBalanceOwner`
（`P-custom18jma8ppw3nhx5r4ap8clazz0dps7rv5u9xde7p`）P 链余额
**21,999,999.4 AVAX，全部 unlocked**。两条路都付得起。

**贴线的两格（恰好 80%）不建议选。** V-08 的实测结论是「引导要求连上 ≥ 80%」，
恰好等于门槛在实现上可能取 `>` 而非 `>=`，而这条判据的失败形态是
「节点起不来」—— 不值得为省一份质押去赌一个不等号。

#### ② F-7 的代价不是磁盘与带宽 —— 在这条开发网上它接近于零

那张表写着 F-7 的代价是「每个 L1 节点多同步 X/C 链（磁盘 + 带宽）」，
风险是「完整同步对节点资源与启动时间的影响没量过」。量了：

| 观测 | 值 |
|---|---|
| l1-1 数据目录总计（带 `partial-sync`） | **4.69 MB**（`du -sb /data` = 4,689,504） |
| ├ `db/network-1337/v1.4.5` | 2.1 MB |
| ├ `chainData/<karmachain>` | 2.4 MB |
| └ `chainData/…LpoYY`（P 链） | 4 KB |
| P 链高度 | **5** |
| **C 链高度** | **0** |
| **X 链高度** | **0** |

**C 链与 X 链从建链起没出过一个区块，而且没人用它们。**
去掉 `partial-sync` 之后要多同步的，是两条各有零个区块的链。

启动计时基线（l1-1 于 11:49:41 那次重启，`docker logs`）：

```
11:49:42.392  initializing node
11:49:42.480  <P Chain> starting bootstrapper（lastAcceptedHeight 5）
11:49:42.605  <P Chain> 1 个缺失区块 → executed 0 个，耗时 134µs
11:49:42.681  <karmachain Chain> starting bootstrapper（height 1257）
11:49:47.078  <karmachain Chain> executed 3 个区块，耗时 13.3ms
11:50:12.475  health check "bootstrapped" 开始通过
```

→ **初始化到引导完成 30.08 秒**，其中真正的引导工作在 **4.7 秒**内做完；
剩下的 25 秒是 `healthCheckFreq: 30s` 那个心跳节拍，不是工作量。

**所以 V-13 / V-14 的增量预期接近于零，而 R-07 把它列为 F-7 的主要代价与主要未知
——那个判断建立在一条"像主网"的直觉上，而这条开发网不是主网。**

> ⚠ **这个结论不可外推。** 它成立的前提是 C/X 链为空且保持为空。
> 主网或 Fuji 上完整同步的代价是数百 GB 与持续带宽，那时 F-7 的代价评估完全不同。
> 结论只对"本仓库这条 networkID 1337 的开发网"有效。

#### ②b 对照实测：l1-1 去掉 flag 跑了一轮（2026-09-16，用户授权）

做法：临时改 `render-node-flags.mjs` 只对 l1-1 不设 flag → `npm run render`
（确认**只有** `l1-1.flags.json` 变，且只差那一行）→ `up -d --force-recreate l1-1`
→ 量 → 还原渲染器 → 重新渲染（生成物逐字节还原）→ 再 recreate 一次。
前提先查过：两个 Primary 都在线（那是 ③ 那条鸡生蛋约束的另一面）。
全程 l1-1 离线十几秒，落在 f=1 之内；事后 `devnet-verify` **14/14 READY**。

**启动到引导完成：两者相同，都是 30.08 秒。**

| | 带 flag | 去掉 flag |
|---|---|---|
| init → `bootstrapped` 通过 | 30.08 s | **30.08 s** |
| 其中真正的引导工作 | 4.7 s（含约 4 s 等对等） | **0.305 s** |
| 引导的链数 | 2（P、karmachain） | **4**（P、X、C、karmachain） |
| X / C 执行的区块数 | —— | **各 0 个**（47µs / 67µs） |

两次都被 `healthCheckFreq: 30s` 那个心跳节拍支配 —— **真正的工作差不到 5 秒，
而它被一个固定的 30 秒完全盖住。** V-14 的答案是"没有可测的变化"。

**磁盘：增量约 20 KB，小于运行间噪声。**

第一次对比是错的，记下来：直接拿"改动前 4,689,969"去比"改动后 3,374,903"
会得出**磁盘减少 1.3 MB**的荒谬结论 —— 那是 leveldb 在重建时做了压实。
干净的对比必须**重启后比重启后**，而还原那一步正好提供了它：

| | 满同步（重启后） | 带 flag（重启后） | 差 |
|---|---|---|---|
| 总计 | 3,374,903 | 3,384,519 | −9,616（噪声） |
| `db/` | 1,138,817 | 1,126,727 | **+12,090** |
| X 与 C 的 chainData 目录 | 4096 + 4096 | 4096 + 4096（还原后仍在） | **+8,192**（一次性） |
| `logs/` | 205,214 | 243,550 | −38,336（噪声） |

归到 X/C 名下的是 **db 里约 12 KB（两条链的创世状态）+ 两个 4096 字节的空目录**，
合计 **约 20 KB**，对 3.4 MB 的基线是 0.6%。而 `logs/` 一项的运行间差就有 38 KB ——
**增量比噪声还小**。另记一条：X 与 C 的 chainData 目录在还原之后**不会被删掉**。

**带宽：约 +50%，绝对值约 +5 kB/s。**

两组都是重启后、各取 120 秒窗口；满同步取了两个窗口确认已稳定。

| | 入 | 出 |
|---|---|---|
| 带 flag（重启前，长跑容器） | 10.7 kB/s | 8.2 kB/s |
| 带 flag（重启后） | 11.3 kB/s | 8.4 kB/s |
| 满同步（窗口一） | 16.8 kB/s | 12.8 kB/s |
| 满同步（窗口二） | 16.6 kB/s | 12.7 kB/s |
| **差** | **+5.4 kB/s（+48%）** | **+4.35 kB/s（+52%）** |

**相对值听着不小，绝对值在局域网上无关紧要**：每节点约 5 kB/s，六个节点合计约
32 kB/s。折成月量约 14 GB 入 —— 若哪天这些节点要走计量带宽，这个数才需要重新算。

多出来的流量不是"同步区块"（X/C 各 0 个区块），而是**多两条链的共识与
gossip 心跳**。所以它不随链上活动增长，是个常量底噪。

#### ②c 途中查实的一件无关但要记的事

实测时发现 `http://<节点>:<port>/ext/bc/karmachain/rpc` 返回 **404**，
一度怀疑是去 flag 造成的。**不是** —— 另外三个仍带 flag 的节点
（l1-2 / l1-3 / l1-6）同样 404。查节点日志里的 `adding route`：

```
/ext/bc/Wd8yzG1cggbUi2nqKC5RzJM8Vz8w7CEisxcvMRJiWwRVLhTqd  /rpc  ✅
/ext/bc/karmachain/…                                              ❌ 不存在
```

**avalanchego 只按 blockchainID 注册 HTTP 路由，不按 `chain-aliases-file` 里的别名。**
别名只用于链的内部查找（节点自报的 config 里 `chainAliases` 确实有它）。
`/ext/bc/karmachain/rpc` 这个路径**只在 nginx 代理那一层存在** ——
是代理的 `rewrite ^/ext/bc/karmachain/(.*)$ /ext/bc/<blockchainID>/$1` 造出来的。

这解释了今天早先一次误判：devnet-member 冒烟时经代理拿到 404，我归因给
"并发的 e2e 正在清空某个节点的卷"。方向是对的，机制现在清楚了：代理 rewrite 之后
`proxy_pass` 到一个正在引导的上游，上游返回 404，而 `proxy_next_upstream`
的重试清单里**没有 404**（只有 error / timeout / http_503），所以它被原样透传。

对仓库没有实际损害（面板用 blockchainID、`devnet-verify` 走代理），
但对照着 `endpoints.rpcPath` 去直连节点端口的人会踩到。

#### ③ 真正的代价是一个操作顺序约束（此前没人提到）

avalanchego 的二进制里有这个**错误常量**（`grep -a` 于
`/avalanchego/build/avalanchego`，与 TLS、质押时长那些 `errors.New` 排在同一字符串池）：

```
partial sync should not be configured for a validator
```

**带 `partial-sync-primary-network` 的节点不能是 Primary 网络验证者。**
于是 F-7 的步骤顺序被强制，且与直觉相反：

1. **先**去掉 flag 并**重建容器**（`up -d --force-recreate`，不用 `restart` —— 见 §5.3）
2. 确认它引导完成（此时它开始同步 C/X）
3. **再**发 `AddPermissionlessValidatorTx` 把它加进 P 链验证者集合

反过来做（先加验证者再改 flag）会让那个节点在**下一次重启时启动失败**。

而第 1 步的重启**要求当时两个 Primary 都在线** —— 那正是本条要消掉的依赖。
**这是一个先后次序上的鸡生蛋**：改造过程本身必须在旧的脆弱状态下进行。
好在每次只重建一个节点，落在 L1 的 f=1 之内；代价是改造窗口内不能有 Primary 掉线。

`partial-sync-primary-network` 写死在 `tools/protocol/render-node-flags.mjs:137`
按 `isValidator` 判，**不在两份声明里**。所以 T045 改的是那个渲染器，
产出每个节点的 `flags.json` 变字节 —— 按 ADR-0012 的判据这是**部署变更**，
不碰 stamp 六项，不重置链。

#### ④ V-15 的流程已经清楚，耗时仍未测

`AddPermissionlessValidatorTx` 需要的参数，以及从节点自报 config 里读到的约束：

| 参数 | 值 / 约束 | 出处 |
|---|---|---|
| nodeID + BLS 公钥 + proof of possession | 已有（声明里就是公开材料） | `deployment.json` / 节点日志的 `nodePOP` |
| 质押额 | ≥ 2000 AVAX，≤ 3,000,000 AVAX；按 ① 要约 1,000,000 | `minValidatorStake` / `maxValidatorStake` |
| 质押时长 | ≥ 24 小时，≤ 365 天 | `minStakeDuration` 86400s / `maxStakeDuration` 31536000s |
| `delegationFee` | ≥ 20000（2%） | `minDelegationFee` |
| uptime 要求 | 0.8 | `uptimeRequirement` |

#### ④b 实测耗时（2026-09-16，用户授权，l1-1，质押取最小、时长取最短）

做法：质押 **2000 AVAX**（耗时与质押额无关，取 `minValidatorStake` 以减少暴露）、
时长 **24 小时 + 600 秒余量**（到期自己退出，不需要人工收拾）。
`txID = 4ayzeAFWtprzoWwidsARm6V8qpr1WPKcioBZEHbTQrjc494NU`。
手续费 **0.000013691 AVAX**。

| 阶段 | 耗时 |
|---|---|
| 签名 + 提交 | 0.05 s |
| 提交 → `Committed` | **0.53 s** |
| `Committed` → 出现在 `getCurrentValidators` | 0.02 s |
| → **节点自己承认**（health 的 `bls` 项翻成 `"node has the correct BLS key"`） | **20.09 s** |
| **合计** | **20.69 s** |

**链上那一段只花 0.6 秒，96% 的时间在等节点自己发现。** 那 20 秒与
`healthCheckFreq: 30s` 同量级 —— 是下一个心跳落下来的时间，不是工作量。
这与 V-14 是同一个形状：**这条链上的成员操作，耗时几乎都由心跳节拍决定，不由链决定。**

BLS 公钥与 proof of possession **问节点自己要**（`info.getNodeID` 的 `nodePOP`）——
`identityOf()` 对创世验证者只从密钥派生 nodeId 与 blsPublicKey，**不给 PoP**；
而 PoP 必须与那台机器上真实的 signer key 对得上。脚本同时交叉核对了
"节点自报的 BLS 公钥 == 声明派生出来的"，不一致就拒绝动链。

**顺带对 T046 做了一次活链验证。** 这一下把 P 链变成三个持有者
（1,000,000 / 1,000,000 / 2,000 = 49.95% / 49.95% / 0.0999%），
`assessRejoinCapability()` 的四种情形逐一对上：

| 情形 | 判定 | 已连权益 |
|---|---|---|
| 全部在服务 | `ok` | 100% |
| 掉那个小的（l1-1，0.0999%） | `ok` | 99.9% |
| 掉一个大的（Primary，49.95%） | `blocked` | 50.04% |
| 两个大的都掉 | `blocked` | 0.09% |

这个分布下"按权益算"与 004 的"数个数"给出**相同结论**，但前者多给了理由
（`50.04% < 80%`），而且**它把 l1-1 的权益算进去了，旧代码不会** ——
旧代码只数 `role === 'primary'` 的行。l1-1 现在只握 0.1% 所以不影响结论；
若它握的是大份，旧代码就会漏掉。这正是 T046 修的那个"有到期日的代理"。

> ⚠ 核对时我一度把结果读反了：`getCurrentValidators` 的返回序是 l1-1 在前，
> 而我按位置假定了"第一个是 Primary"，于是报出"掉一个 Primary → ok 99.9%"。
> **判定本身是对的，错在我假设了顺序。** 改成按实际权重分类后才对上。
> 记在这里是因为这类错误在读链上数据时反复出现（bitset 位序那次同源）。

**仍未测**：无。V-15 完成。

> ⚠ **这一项是单向门，不能像 ②b 那样"量完改回去"。**
> `minStakeDuration = 86400s`，即**质押最少 24 小时** —— 把一个 L1 验证者加进
> P 链验证者集合之后，24 小时内没有办法撤回它（P 链没有提前解除质押的交易）。
> 而它一旦成为 Primary 验证者，那个节点就**再也不能带 `partial-sync` 启动**
>（见 ③ 的错误常量），也就是说 ②b 那条已经验证过的还原路径对它同时失效。
>
> 所以 ③ 的耗时**不该为了取一个数去做** —— 它实际上就是 T045 的第一步。
> 正确的次序是：先由 T044 在两条路里做决定，选定 F-7 才去做它，
> 并且**事先接受 24 小时不可逆**这个代价。

**顺带解掉一个原本列为未知的风险**：`index-enabled=false` 在完整同步之后
**仍然成立**。②b 那一轮 l1-1 带着 `index-enabled=false` + `index-allow-incomplete=true`
完整同步了 P/X/C/karmachain 四条链，日志里没有那句
`running would cause index to become incomplete but incomplete indices are disabled`，
节点正常 healthy。（`render-node-flags.mjs` 的注释记着那条 FATAL 是 Primary 节点
沿用 avalanchego 默认索引设置时踩到的，与 partial-sync 无关 —— 现在有实测为证。）

#### 这次取数把 R-07 的那张表改成了什么

| | F-6 加 Primary | F-7 L1 验证者兼任 |
|---|---|---|
| 要加机器吗 | **不一定** —— 可在既有机器上多起 Primary 容器（ubuntu-1/2 已是一机两角） | 不要 |
| 要加质押吗 | 要：每个约 100 万 AVAX（余额 2200 万，够） | **要**（这是原表漏掉的） |
| 磁盘 | 每台多一个完整节点 | **+20 KB / 节点**（已实测，见 ②b） |
| 带宽 | 每台多一个完整节点 | **+5.4 kB/s 入 / +4.35 kB/s 出 / 节点**（已实测） |
| 启动时间 | 不变 | **不变**（已实测：两者都是 30.08 秒） |
| 要重启既有节点吗 | 不要 | **要，每个 L1 节点一次**，且窗口内两个 Primary 必须在线 |
| 一机失效的耦合 | 新 Primary 与 L1 验证者同机时，一次失效同时损失两者 | **同上，且必然如此** —— L1 验证者就是权益持有者 |
| 掉 1 台后能否引导 | 6 个 Primary 时 83.3% ✅ | 8 个等权时 87.5% ✅ |
| 掉 2 台后能否引导 | 6 个时 66.7% ❌ | 8 个时 75% ❌ |

**两条路都把"必须是那两台特定机器"换成"任意 1 台都能掉"，且都到不了容忍 2 台。**
F-7 不需要新容器但需要逐个重启 L1 节点；F-6 不碰 L1 节点但多 4 个 Primary 容器。

**决定留给 T044**，因为还缺 V-15 的耗时与 V-16 的最终验证，而那两项都要动链。

### R-07b · 决定（T044 / FR-020 / FR-021）：**取 F-7，但只让 4 个 L1 验证者兼任**

**选定方案**：把 **l1-1 / l1-2 / l1-5 / l1-6** 四个 L1 验证者加入 P 链验证者集合，
各质押 100 万 AVAX（与两个 Primary 等权）。结果是 **6 个权益持有者、每台机器恰好 1 个、
各 16.67%**。

| 机器 | 权益持有者 | 该机权益 |
|---|---|---|
| win-1 | l1-1 | 16.67% |
| win-2 | l1-2 | 16.67% |
| ubuntu-1 | primary-1（l1-3 **不**兼任） | 16.67% |
| ubuntu-2 | primary-2（l1-4 **不**兼任） | 16.67% |
| ubuntu-3 | l1-5 | 16.67% |
| ubuntu-4 | l1-6 | 16.67% |

**掉任意 1 台 → 83.33% ≥ 80% ✅**（掉 2 台 → 66.67% ❌，与 L1 的 f=1 同时失效）。
质押合计 400 万 AVAX，可用 2200 万。

#### 为什么不是"全部 6 个 L1 验证者都兼任"

那是 spec 里 F-7 的字面写法，而它**达不到目标**：ubuntu-1 与 ubuntu-2 各承载
一个 Primary **加**一个 L1 验证者，8 个持有者等权时这两台各握 **25%** ——
掉其中任意一台就剩 75% < 80%，**引导照旧失败**。

这一点暴露了 FR-022 措辞上的一处歧义，值得写下来：

> FR-022 说的是「掉任意 1 个**权益持有者**」。按字面读，8 个各 12.5% 时掉 1 个
> 剩 87.5%，**满足**。但这个部署里的失效单位是**机器**（ADR-0007 的整个由来），
> 而一台机器可以承载两个持有者。**按机器读才是运维上成立的那个读法**，
> 所以设计对准后者 —— 它同时更省：只要改 4 个节点，不是 6 个。

#### 被否方案 F-6（加到 ≥5 个 Primary）与它的代价

**① 它绕不开 Primary 网络的创世。** `render-node-flags.mjs:88` 把 Primary 的
NodeID 从 `blockchain/chain-identity/primary-network.genesis.json` 的
`initialStakers`（**恰好 2 条**）里按数组位置取，数量不符**直接抛**：

```
primary genesis has N initial stakers but topology declares M primary nodes
```

而那份创世是节点的 `genesis-file`。**重新生成它就换了一个 Primary 网络** ——
现有 P 链状态（含 L1 的 subnet 与全部 ACP-77 注册）随之全部失效。
所以 F-6 必须先改渲染器，让 Primary 的 NodeID 改从**声明**里取
（就是 T069 给"创世后加入的 L1 验证者"用的那套），再把新 Primary 作为
**创世后**的 P 链验证者加进去。这是一处真实的管道改造，不是加几行配置。

**② 爆炸半径差一个数量级 —— 今天实测对比过。**
`targets = primaries`（同文件第 101 行），所以每个 L1 验证者的
`bootstrap-ids` / `bootstrap-ips` 都是从 Primary 集合派生的：

| | 改哪些 `flags.json` | 要重建哪些容器 |
|---|---|---|
| F-7（去一个节点的 `partial-sync`） | **只有那一个**（②b 实测：只有 `l1-1.flags.json` 变，且只差那一行） | **只有那一个** |
| F-6（加一个 Primary） | **全部 L1 验证者**（引导清单变了） | **整个机群** |

在一条以"加节点不要重启既有节点"为主张的网络上，F-6 的**改造过程本身**
就违反那个主张。而每次重建又要求当时连上 ≥80% 的 P 链权益 ——
在权益分布正在改变的过程中滚动重建整个机群，次序上极难说清。

**③ 还要 4 套新密钥与 4 个新容器。** 新 Primary 的 staking 证书与 BLS 私钥
**必须在目标机器上生成**（宪法第四条 / FR-019），而 F-7 复用的是既有节点身份 ——
它们的 NodeID 与 proof of possession 早就在声明里。

**④ 质押的 24 小时锁定两条路都有**，不是区分项：加 Primary 同样走
`AddPermissionlessValidatorTx`，同样受 `minStakeDuration = 86400s` 约束。

#### 选定方案的代价（全部已实测，见 ②b / ③）

| 代价 | 值 |
|---|---|
| 磁盘 | **+20 KB / 节点**（比运行间噪声还小） |
| 带宽 | **+5.4 kB/s 入 / +4.35 kB/s 出 / 节点**（+48% / +52%，常量底噪，不随链上活动增长） |
| 启动时间 | **无可测变化**（两者都是 30.08 秒） |
| 质押 | 4 × 100 万 AVAX（可用 2200 万） |
| 要重建的容器 | **4 个，逐个来**，每次一个，落在 L1 的 f=1 之内 |
| 不可逆 | **24 小时**（`minStakeDuration`），且那 4 个节点从此不能再带 `partial-sync` 启动 |
| 顺序约束 | **先去 flag 重建、再加进 P 链集合**；且改造窗口内两个 Primary 必须在线 |

#### 它**买不到**什么 —— 必须说清，否则这个决定会被过度解读

**停电后的自动恢复仍然需要一次 Windows 登录。** 两台 Windows 机器不做开机自启
（ADR-0006，`WSL_E_LOCAL_SYSTEM_NOT_SUPPORTED`），停电后只有 4 台 Linux 自动回来，
它们持有 4/6 = **66.67% < 80%** —— P 链引导照旧被挡，直到有人登录任意一台 Windows。

而且这不是选错了方案：**当前硬件下"掉任意 1 台"与"停电后零人工"两个目标
无法同时达到。** 自动恢复的机器只有 4 台，要它们合计 ≥80% 就意味着每台 ≥20%，
而"掉任意 1 台仍 ≥80%"要求每台 ≤20% —— 两者只在**恰好 20%** 那一点相交，
而那是条贴线（见 ②a 里"不要把拓扑设计在恰好 80% 上"）。

**要同时达到，需要第 5 台会自动恢复的机器**，或者让 Windows 边界开机自启
（ADR-0006 已否决，理由是要在机器上留一份可被滥用的凭据）。
这条留给未来的特性，不在 005 范围内。

#### 落地次序（留给 T045，**执行前须再次确认**）

对 l1-1 / l1-2 / l1-5 / l1-6 **逐个**做，每个做完确认链仍出块再做下一个：

1. 确认两个 Primary 都在线（否则第 2 步的重建会卡在引导上）
2. 改 `render-node-flags.mjs`：这 4 个不再设 `partial-sync-primary-network`
   —— 这是**部署变更**（ADR-0012），不碰 stamp 六项
3. `npm run render` → 确认**只有这 4 份 `flags.json`** 变化
4. 对该节点 `up -d --force-recreate`，等它 healthy
5. 发 `AddPermissionlessValidatorTx`（质押 100 万 AVAX、时长在 24h…365d 之间、
   `delegationFee` ≥ 2%）
6. `npm run membership:status` 与面板确认权益分布，`devnet-verify` 14/14

**第 5 步起不可逆 24 小时。** 因此 2–4 步可以先对一个节点走完并观察，
第 5 步再单独决定 —— 前四步与今天的 ②b 实测完全同形，已经验证过可还原。

### R-08 · 优雅退出与紧急摘除是两条路径

**决策**：两条都要，且文档分开写。

| | 优雅退出 | 紧急摘除 |
|---|---|---|
| 前提 | 那台机器还活着、能配合 | 机器已损坏/失联 |
| 过程 | 先从集合移除 → 等确认 → 再停进程 | 直接从集合移除 |
| 风险 | 低 | 移除期间集合与实际不一致的窗口更长 |

**顺序不能反**：先停进程再移除，等于制造一段"集合里有一个死节点"的时间 ——
而那正是容错余量被白白吃掉的窗口。

### R-09 · 本期**不**碰的东西

- **权限去中心化** —— PoA owner 仍是单一账户（ADR 索引已归入未来的治理规格）
- **Avalanche CLI 不请回来**（ADR-0008）
- **自动伸缩** —— 加机器仍需要人去那台机器起进程、放密钥。
  本期的目标是"不重置、不重启既有节点、步骤可照抄"，不是全自动

### R-10 · `docs/protocol-parameters.md` 随分家一起走，**文档保持逐字节相同**

**这条是 `/speckit-analyze` 查出来的，而且是一处规格内在张力。**

`docs/protocol-parameters.md` 是 10 项生成物之一，它**逐字段文档化** `protocol.json` ——
有一整节「拓扑与故障边界」，而 `render-docs.mjs` **直接读** `p.topology.deployments`
（第 62–65、101–102 行），还维护着一份"每个字段都必须被文档化"的完整性清单（第 31–32 行）。

于是两条判据打架：

| | |
|---|---|
| FR-007 / SC-003 | **全部**生成物分家前后**逐字节相同** |
| 现实 | 那份文档按定义会跟着 `protocol.json` 变 |

**决策：选 (a) —— `render-docs.mjs` 读两个文件，文档保持逐字节相同。**

**理由**：它虽然叫"协议参数"，实际是一份**参数参考** ——
读它的人想知道的是"这条链是怎么配的"，而不是"哪些字段住在哪个文件里"。
把部署描述一并文档化并不违和，而且**保住了 SC-003 这条判据的完整性**。

**被否的 (b)**：让文档也跟着分家。那样 SC-003 就需要一条显式豁免 ——
而 SC-003 是本期**最强的不回归判据**（"只搬家、不改行为"的机械证明）。
为一份文档的归属去在它身上开一个口子，不划算。

> **这条如果留到实施时才发现，最可能的结果是把 SC-003 悄悄放宽** ——
> 因为那时"让它通过"的最短路径就是加一条例外。

---

## 三、待实测项（V）

> **三值，2026-09-17 由 T001 的回填引入。** 原先只有 ✅ / ❌ 两档，
> 而本期大量判据是**属性在离线用例里被穷举验证、但没在活链上走过一遍** ——
> 把它们记 ✅ 是谎，记 ❌ 是丢掉真做过的功。所以分三档：
>
> | 档 | 含义 |
> |---|---|
> | ✅ | **已实测**（活链，或该判据本身就只能离线验证 —— 那种会注明） |
> | ⚠ | **仅离线验证**：属性有断言且做过变红检查，但**没有在活链上走过** |
> | ❌ | 未做 |
>
> **⚠ 不许在验收里当成 ✅。** 离线验证证明的是"代码在这个输入下这么答"，
> 不是"链在现实里这么表现" —— 本期已经踩到过三次两者不等（见下面的"离线绿灯"一节）。

**范围 A**

- **V-01** ✅ **已实测**（T014）：分家前后全部 10 项生成物**逐字节相同**，
  对着 `baseline.md` 的 sha256 清单核过；`render:check` 现在仍 10/10。
- **V-02** ⚠ **一半实测、一半判据本身要改**：l1-6 加入时**stamp 六项逐字节不变、
  零个节点退出 12、创世哈希不变**都在活链上核过（`devnet-verify` 的
  `protocol-consistency` 至今 OK）。
  但「既有节点容器 `Created`/`StartedAt` 逐字符不变」这一半**按现在的写法达不到** ——
  `flags.json` 里的 `http-allowed-hosts` 是一份全局清单，加一台机器会改到
  每一个既有节点的 flags，要生效必须全部重建（见 tasks T010 的"顺带发现"）。
  **重启 ≠ 重置**，但判据得重写。留给 T021。
- **V-03** ❌ 该过程中链持续可用（每 30 秒一笔，连续 10 分钟，全部确认、零 5xx）—— T022
- **V-04** ✅ **已实测**（T016）：把 `topology` 写回协议参数文件 → `deployment-split` 守卫失败
- **V-05** ✅ **已实测**（T017）：改 `chain.chainId` → 节点**确实退出 12**，随后改回。
  这一条与 V-04 同等重要 —— 只做 V-04 会得到一个什么都不拦的守卫。

**范围 B**

- **V-06** ✅ **已实测**（2026-09-15/16，l1-6 走完 ACP-77 四步）：链上集合数
  **5 → 6**，合约侧与 P 链侧一致、零漂移，stamp 六项不变、创世哈希不变，
  链全程未重置。引导完成后 `devnet-verify` 报 **6/6 L1 验证者已引导**、
  容错 `6/6 validators online`。
  *（"面板参与共识数 +1"这一半是由 `devnet-verify` 与 `membership:status` 核的，
  不是由面板页面核的 —— 面板的同一判据有离线用例，见 V-18。）*
- **V-07** ⚠ **仅离线验证**（T048③）：`membership-presentation.test.mjs` 断言
  名册从 5 长到 6 而新成员仍在引导时，健康百分比**必须低于** 100%，
  且分母取声明的 n 而非观测行数。**活链上那一段（引导窗口内实时观察）属 T034，未做。**
- **V-08** ❌ 退出一个验证者后集合数 −1、链持续出块、该节点**不被**报成故障。
  **刻意未做**：用户明确要求不退 l1-6，而现在没有别的可退目标（T041）。
  流程本身（`remove-validator.mjs` 四步 + 两条路径）已实现并有离线用例。
- **V-09** ⚠ **仅离线验证**：`tolerance.mjs` 的 `removalImpact()` 把
  「f 下降 → 要确认」与「跌破门槛 → 拦下」**刻意分成两件事**，
  `membership-removal.test.mjs` 逐格断言。活链未走（依赖 V-08）。
- **V-10** ⚠ **一半离线验证、一半在活链上间接成立**：
  离线（`membership-step-resume.test.mjs`）逐格钉住「链上状态 → 停在第几步」的映射，
  并穷举断言 **step 的值域恰好是 {0,1,3,4}、永不为 2** —— 第二步不写链。
  活链上这个机制**反复用对过**：l1-6 的四步分四次跑完，中间夹着一次停电与一次
  P 链拒绝（`NumFilteredValidators (0)`），每次重跑都自己找对了位置，
  因为它不读状态文件、只读链。
  **缺的是"人为注入失败"那一轮**（T031）：合约 revert / P 链拒绝 / 聚合器超时
  各长什么样，是外部系统的真实行为 —— 离线造出来的只是我对它们的想象。
- **V-11** ⚠ **仅离线验证**（T023 / FR-014）：`membership-preflight.test.mjs`
  断言创世哈希不一致、chainId 不一致、**以及读不到**三种情形都被拦下。
  **注意这条判定在 2026-09-16 之前根本不存在** —— 函数头写着 FR-014 而实现里没有。
  活链未造过一个"跑在另一条链上的节点"。
- **V-12** ⚠ **仅离线验证**（T023 / FR-013）：同一个文件里构造 T-5 越界的拓扑
  并断言被拦下，且先核实了构造真的违反 T-5（否则测的是别的东西）。

**范围 C**（四个数，见 R-07）

- **V-13** ✅ **已实测（2026-09-16，l1-1 去 flag 跑了一轮后还原，见 R-07a②b）**：
  **磁盘增量约 20 KB**（db 里约 12 KB 的 X/C 创世状态 + 两个 4096 字节的空 chainData
  目录），对 3.4 MB 的基线是 0.6%，**比运行间噪声还小**（`logs/` 一项的运行间差就有 38 KB）。
  **带宽增量约 +5.4 kB/s 入 / +4.35 kB/s 出**（+48% / +52%），两个窗口一致；
  多出来的不是区块同步（X/C 各 0 个区块），是多两条链的共识与 gossip 底噪，
  **不随链上活动增长**。
  ⚠ 结论不可外推到主网（那里完整同步是数百 GB）。
  ⚠ 记一条方法论教训：第一次拿"改动前"比"改动后"得出**磁盘减少 1.3 MB**的
  荒谬结论 —— leveldb 在重建时做了压实。**这类对比必须"重启后比重启后"。**
- **V-14** ✅ **已实测（同上）**：**没有可测的变化** —— 两者都是
  初始化到 `bootstrapped` **30.08 秒**。真正的引导工作从 4.7 秒降到 **0.305 秒**
  （带 flag 那次含约 4 秒等对等），而两次都被 `healthCheckFreq: 30s` 的心跳节拍盖住。
  去掉 flag 后引导 **4 条链**（P、X、C、karmachain），X 与 C 各执行 **0 个区块**。
- **V-15** ✅ **已实测（2026-09-16，l1-1，见 R-07a④b）**：**合计 20.69 秒**，
  而其中**链上那一段只有 0.6 秒**（提交→`Committed` 0.53 s、→ 出现在集合 0.02 s），
  剩下 **20.09 秒是等节点自己发现**（与 `healthCheckFreq: 30s` 同量级）。
  手续费 0.000013691 AVAX。**与 V-14 同一个形状：这条链上的成员操作，
  耗时几乎都由心跳节拍决定，不由链决定。**
  取数用最小质押（2000 AVAX）与最短时长（24 小时 + 600 秒余量），
  **到期自动退出**，`endTime = 2026-09-17T14:58:39Z`。
  ⚠ 仍要记住它是单向门：`minStakeDuration = 24 小时`，期间那个节点
  不能再带 `partial-sync` 启动。真正实施（T045）时时长要设长，并接受"到期要续"。
  顺序被 avalanchego 的错误常量 `partial sync should not be configured for a validator`
  强制 —— **必须先去 flag 重建、再加进 P 链验证者集合**，反过来会让节点下次启动失败。
  `AddPermissionlessValidatorTx` 的参数与约束（质押 2000…3,000,000 AVAX、
  时长 24h…365d、`delegationFee` ≥ 2%）已记在 R-07a④。**仍缺实际耗时。**
- **V-15a** ✅ **已实测**：P 链权益分布为 **2 个验证者各 1,000,000 AVAX（各 50%）**，
  `minValidatorStake` = **2000 AVAX**。因此**按最小质押执行 F-7 买到零提升**
  （50% → 50.29%）—— spec 里 F-7「每个约 14%」那句是假设而非事实。
  可用余额 **21,999,999.4 AVAX 全部 unlocked**，两条路都付得起。
- **V-16** ❌ 掉 1 个权益持有者后，被重启的验证者**能否**加入（≤120 秒）。
  依赖 T045 把 F-7 实施到位（现在只有 l1-1 是持有者，且只握 0.0999%，
  掉任一个 Primary 仍然 `blocked` —— 这一点在 ④b 里实测确认过）。

**范围 D**

- **V-17** ✅ **已实测（离线，而这一条离线就是正确的验证层）**：
  `fault-tolerance-range.test.mjs` 对 n = 4…12 **逐格**断言，且用
  **定义式**（最大的 f 使 `(n-f)/n ≥ 0.75`）与 data-model 那张表**互为对照** ——
  两边各算一次，而不是拿实现去比实现。`membership-presentation.test.mjs`
  再对同一区间逐格断言**门槛与两个余量**（那是 `fault-tolerance-range` 没覆盖的一半：
  它只管 `maxOfflineValidators`）。
  变红检查：把 ⌈⌉ 改成 ⌊⌋ → 六格红（0.8×4 = 3.2 向下取整得 3，而 3/4 = 75% 是假绿灯）。
  *这条判据是纯算术，活链给不出比逐格断言更强的证据 —— 所以离线即已实测。*
- **V-18** ⚠ **仅离线验证**（T049）：`dashboard-views.test.mjs` 断言
  `view-domains` 渲染出的文字里**明说"仍然是"**（加一个成员不改变上限时）、
  并说清"要到几才变"；变红检查是把"节点更多了更抗"的暗示放回文案 → 断言立刻红。
  **活链上没有观察过面板页面本身**（那要起面板并在一次真实成员变更中截取）。

**范围 A（实施期追加）**

- **V-19** ✅ **2026-09-14 已实测**：avalanchego 对 **IP 字面量的 Host 头无条件放行**，
  对**名字**才查 `--http-allowed-hosts`。活节点 l1-1（清单为
  `127.0.0.1 / localhost / 五台机器地址`）实测：

  | Host 头 | 在清单里 | 状态码 |
  |---|---|---|
  | `localhost:21660` | 是（名字） | **200** |
  | `127.0.0.1:21660` | 是（IP） | **200** |
  | `192.168.1.3:21660` | 是（本机 IP） | **200** |
  | `192.168.1.251:21660` | **否**，同网段 | **200** |
  | `10.251.251.251:21660` | **否**，另一私网段 | **200** |
  | `203.0.113.251:21660` | **否**，公网 | **200** |
  | `not-allowed.example.com` | **否**，名字 | **403** |
  | `karmachain.invalid` | **否**，名字 | **403** |

  **这不是新发现**：001 的 `acceptance.md` 第 76 行原话已是「默认只放行 localhost
  **与 IP 字面量**」。002 的渲染器把五台机器的地址列进清单，因此从一开始就是多余的。

  **结论与动作**：那些地址在清单里**不产生任何约束**，却让清单随机器列表变 ——
  离线模拟证实，加一台只跑 L1 验证者的机器时，既有七个节点的 flags.json 里
  **只有 `http-allowed-hosts` 一个键会变**。去掉之后为**零改动**，
  T021 的判据 ④（既有节点容器不重启）由此立得住。
  渲染器只滤掉 IP 字面量、保留名字 —— 若日后用主机名当边界地址，那时它确实需要被列。

  **这条是上游行为，不是我们的代码**，因此钉成一条对活节点的断言：
  `tests/integration/host-header-policy.test.mjs`。哪天某个版本开始对 IP 也查清单，
  那条会先红，而不是等到面板直连与跨机 RPC 一起断。

  **测量过程本身栽过一次**：第一版探针用 `fetch` 写的，而 undici 把 `Host` 当禁止头
  **直接丢掉** —— 发出去的仍是真实的 `<ip>:<port>`，于是"未列出的 IP → 200"这条
  纯属空跑。是同一套件里那条「未列出的名字 → 403」**对照组**把整套测量顶了回来。
  改用 `node:http` 后 Host 才真的发出去。
  **没有对照组的测量，"全都通过"与"什么都没测"长得一模一样。**

---

- **V-26** ⚠ **`npm test` 通过不等于每个套件都跑了**（2026-09-14，Node v22.19.0 实测）。

  Node 的测试运行器在 `describe` 体**求值时抛异常**的情况下，TAP 里报 `not ok`，
  但**不计入 `# fail`，进程退出码仍是 0**。最小复现：

  ```
  describe('setup 抛异常的套件', () => { throw new Error('boom'); });
  describe('正常套件', () => { test('一条真断言', () => assert.equal(1, 1)); });

  not ok 1 - setup 抛异常的套件
  # tests 1   # pass 1   # fail 0      ← 退出码 0
  ```

  后果：任何测试文件的夹具计算一坏，**那个文件的全部断言会悄悄消失**，
  而总数只少几条 —— 没人会盯着总数。这个仓库有 155 个套件，其中不少在
  `describe` 求值期构造夹具（跨形态渲染、读链上制品、解析字节码），所以不是理论风险。

  **本期撞到三次**：加机器守卫的模拟违反 T-5（两次，分配方式先后写错）、
  身份渲染按不存在的键查验证者导致 ENOENT。**第三次是我把 `# pass 12 / # fail 0`
  读成"通过"之后才被发现的** —— 那个套件里有 4 条断言一次都没执行。

  修法：`tools/test/run-tests.mjs` —— 原样透传 `node --test` 的输出，同时扫**列首**的
  `not ok`（`# TODO` 标记的不算），有任何一条且退出码为 0 就以 1 退出并复列那几行。
  零新增依赖（FR-035），四个 npm 测试脚本都走它。**它第一次跑就抓到了上面那个 bug。**

  全仓库审计（换上运行器之后）：单元 910 项 / 155 套件、集成 124 项 / 30 套件，
  **没有任何套件是静默跳过的**。

---

- **V-27** ✅ **子网已转成 L1，ACP-77 是对的路**（2026-09-14，P 链实测）。
  `platform.getSubnet` 返回：

  ```
  isPermissioned: false                                   ← 已转换
  conversionID:   2DYRwZMNcobLRCYMtxYVgmH3MLWEn9DNWGZ1aAFNfT6ZjKPry
  managerChainID: Wd8yzG1cggbUi2nqKC5RzJM8Vz8w7CEisxcvMRJiWwRVLhTqd   ← karmachain 自己
  managerAddress: 0x0feedc0de0000000000000000000000000000000            ← 那个代理
  ```

  `managerAddress` 正是 V-20 核验过 ABI 的那个合约。
  `getSubnets` 里仍有 `controlKeys`，那是**转换前的遗留**，不代表还受控制密钥管理 ——
  只看 `getSubnets` 会得出"这是个许可子网"的错误结论，必须看 `getSubnet` 的 `isPermissioned`。

- **V-28** ✅ **P 链能枚举 L1 验证者，而合约不能。**
  `platform.getCurrentValidators({subnetID})` 返回每个成员的
  nodeID / weight / validationID / publicKey / remainingBalanceOwner / deactivationOwner。

  **这不是与 V-21 重复，而是第二个事实来源**：合约侧是「PoA owner 注册了谁」，
  P 链侧是「谁真的在共识里带权重」。两者**可以不一致** —— ACP-77 第三步做完、
  第四步没做完时就是那个状态。所以 T026 应把 P 链作为交叉验证的第二个来源
  （记为 T070）。注意两侧的 validationID **编码不同**：P 链是 CB58
  （`jbVejeab5dHj…`），合约是 hex（`0x60b76e92…`），同一个值两种表示。

- **V-29** ✅ P 链上有钱。控制密钥地址 `P-custom18jma8pp…` 未锁定余额约
  2000 万 AVAX，足够支付新验证者的持续费用；它的私钥就是 `ewoq`（按宪法第四条例外在仓库里）。

- **V-30** ⚠ **节点上没有 Warp API**（`/ext/bc/<id>/warp` 与 `/ext/warp` 都是 404）。
  subnet-evm 要在**链配置**里开（`warp-api-enabled`），而 `blockchain/nodes/chain-config/`
  现在只有 `pruning-enabled` / `database-type` / `log-level` / `eth-apis`。

  两条路：**开 Warp API**（生成器加一行 + 各机器 `docker restart` 节点；链配置是**目录挂载**，
  内容变更不需要重建容器，但 avalanchego 在启动时读它，所以要重启；**不进 stamp，不重置链**），
  或**跑 signature-aggregator 服务**（v0.5.3 已在 bootstrap 镜像里，走 P2P 收签名，
  不需要动节点，但多一个要配置与运维的进程）。
  倾向前者：一行配置 + 一次重启，比多养一个服务简单得多。

- **V-30 更正**（2026-09-15）：Warp API 的路径**不是** `/ext/bc/<id>/warp`（那是 404），
  而是 EVM JSON-RPC 上的一个命名空间：`POST /ext/bc/<blockchainID>/rpc`，
  方法名 `warp_getMessageAggregateSignature` / `warp_getMessage`，**消息 ID 用 CB58**。
  开启方式确认为链配置里的 `warp-api-enabled`（subnet-evm 内部字段 `WarpAPIEnabled`，
  可在节点日志的 `Initializing Subnet EVM VM` 那一行看到当前值）。
  一开始我按 avalanchego 级的路径去试，得到 404 —— **而 404 看起来像"路径写错"，
  也确实是路径写错，但同时功能也真没开**，两个原因叠在一起，先排哪个都会被误导。
  判据应当先看日志里的 `WarpAPIEnabled`，那是功能有没有开的直接证据。

- **V-32** ❌ **作废**（原文：第四步的确认消息必须由 Primary Network 验证者签名）。
  当时的依据是节点日志里的 warpConfig `{quorumNumerator: 67, requirePrimaryNetworkSigners: true}`
  —— **那是从配置项的名字推出来的，不是实测**。见下面的 V-34。
  （结论"两个 Primary 都必须在线"本身仍然成立，但**理由换了**：不是为了第四步的签名，
  而是 004 的 V-08 —— P 链引导要求连上 ≥ 80% 权益，而它们各握 50%。）

- **V-34** ✅ **第四步的确认消息由 L1 自己的验证者签，不是 Primary**（2026-09-16，
  节点 debug 日志实测）。

  按 V-32 做了一轮：聚合器收齐**两个 Primary** 的签名（100% 的 Primary 权重），
  交易上链后仍然 revert。`debug_traceTransaction` 显示合约 STATICCALL Warp 预编译
  拿回 `valid = false`。把 l1-1 的链配置临时调到 `log-level: debug`，抓到了唯一说得清的证据：

  ```
  failed to verify warp signature
  err="signature weight is insufficient: 67*600 > 100*200"
  ```

  `totalWeight = 600` 是 **L1 六个验证者**的总权重（每个 100，含第三步刚进 P 链的 l1-6）。
  也就是说验证用的是 L1 自己的集合，Primary 的签名在那里只折算出 200。
  改成向本 subnet 要签名后：**5/6 签名者（bitset 0x3d）= 83% ≥ 67%**，交易在区块 995 成功。

  **两条教训**：

  1. `requirePrimaryNetworkSigners` 这个名字与它在本链上的实际效果不一致。
     从配置项名字推断行为，推错了，而且推错之后的表现是"签名收齐了、交易照样失败"。
  2. 这一步的失败在 `log-level: info` 下**完全静默** —— 合约只回一个自定义错误选择器，
     预编译只回 `valid = false`。权重那句报错只在 debug 级出现。
     排查这类问题应当**先把日志级别调上去**，而不是先猜。

  另：`eth_call`（`simulateContract`）会自行为调用准备谓词结果，**模拟通过不能证明会成功**。
  同一条消息模拟通过、真实出块 revert，两次都是这样。

- **V-35** ✅ **退出第四步的 `registered: false` 必须带 justification**，而加入那步不需要
  （2026-09-16，全部在链外验证，**一步都没动链**）。

  **为什么"不存在"需要额外材料。** 加入断言 `registered: true`，节点从 P 链状态
  直接读得出。退出断言 `registered: false` —— 而"不存在"读不出来：
  节点无法区分"这个 validationID 被摘除了"与"它从来没有过"。
  justification 提供的正是"它本来是什么"，节点据此重算 validationID 再确认它不在集合里。

  **格式是一路问出来的**，每一步都有节点给的确切回答（签名请求只读，所以可以放心试）：

  | 传什么 | 节点回什么 |
  |---|---|
  | 不给 | `invalid justification type: <nil>` |
  | 裸 warp 字节 | `proto: cannot parse invalid wire-format data` ⇒ **是 protobuf** |
  | 字段 2 ← 216B AddressedCall | `packer has insufficient length for input` |
  | 字段 2 ← 258B 整条消息 | `unknown type ID 1337` ⇒ 它把 networkID 当成了 typeID |
  | **字段 2 ← 182B 内层注册消息** | **解析通过**，改报 `validation "…" exists` |

  最后那句才是应有的拒签理由：l1-6 确实还是成员，`registered: false` 是假陈述。
  等第三步真把它从 P 链摘掉，同一个请求就会成功。

  **两个变体，按证据选支：**

  - 后加入成员 → protobuf 字段 2 = 当初那条 `RegisterL1Validator` 的 **182 字节内层**
  - 创世成员 → 字段 1 = `SubnetIDIndex{subnet_id, index}`

  创世那一支的 validationID 派生公式由节点自己的报错反推：拿
  `SubnetIDIndex{subnetID, index:5}` 去问，它回
  `validationID "…" != justificationID "y9QvYNhviCvVPHVkSDQKqrTD1k9DfRqjB383kTPc7yanQrtE7"`
  —— 那个 justificationID 就是它算出的值。四种候选写法里只有
  **`sha256(subnetID ‖ uint32BE(index))`** 命中。

  随后五个创世成员的真实 validationID 逐一命中，公式被独立验证，
  并顺带定出各自的 index（**与 l1-N 编号不一致**，是转换交易里验证者数组的顺序）：

  | 成员 | l1-1 | l1-4 | l1-5 | l1-3 | l1-2 |
  |---|---|---|---|---|---|
  | index | 0 | 1 | 2 | 3 | 4 |

  所以选哪一支**不能读声明里的 `origin`** —— 拿 validationID 去试公式，
  命中就是创世成员。声明可以写错，公式对得上就是对得上。

- **V-33** ✅ T072 滚动完成后，**五个注册验证者全部开启 Warp API**（逐台实测）。
  签名聚合的 quorum 够了：5/5 = 100% ≥ 67%。
  滚动中 win-2 有一次误判：面板报 unreachable 而 `curl` 200 —— 那是我跑得太早，
  节点当时还在引导。**ping 不通只是 Windows 防火墙挡 ICMP，不代表机器或端口不可达**，
  两个 staking/http 端口的 TCP 都是通的。排查顺序应是 TCP → HTTP → 面板，不是先信 ping。

- **V-31** ⚠ **声明多于链上时，面板会给出「链已停止出块」的假警报**（2026-09-15 实测）。

  当时状态：声明 6 个验证者（l1-6 已声明、未注册、未启动），链上注册 5 个，
  win-2 整机离线导致 l1-2 缺席。面板按**声明的 6 个**算：4 在线、
  超出 ⌊6/4⌋ = 1 的上限 → 判定「超出上限，链已停止出块」。

  **而链一直在出块**：一笔探测交易在**区块 975 确认，耗时 8.7 秒**。
  真实账是 5 个注册成员掉 1 个 = 80% ≥ 75%，仍在门槛之上。

  **这纠正了我先前的判断。** 我当时说这种账目不实"偏保守、不危险" ——
  不隐藏真故障这一点是对的，但它会**产生假警报**，而假警报不是无害的：
  它让人去排查一个不存在的故障，而反复的假警报会训练人忽略面板。

  结论：**面板的容错判据必须用链上成员集合，不能用声明**。记为 T073。
  这也说明 T026 不只是"让漂移可见"，它是面板结论正确性的前提。

- **V-36** ✅ **ACP-77 第一步已在真链上执行**（2026-09-15）。

  > 📝 **本条原编号为 V-34，2026-09-17 由 T001 的回填改号。** 2026-09-16 另有一条
  > 也写了 V-34（"第四步的确认消息由 L1 自己的验证者签"），两条撞号。
  > 改这一条而不是那一条，因为**那一条有三处外部引用**
  > （`docs/devnet.md`、`tools/membership/remove-validator.mjs`、
  > 那条 justification 的测试），而本条一处都没有 —— 按"改动面最小"选。

  ```
  交易          0x18d799a2c4dc92793b5b6d638ef4326907cfe9d438d9b57dc7b46883b70e9e9d（区块 976）
  validationID  0xaa37ee1613092654f3a42007d471762698fe64e55a8a34f4a828fd064d6c15fc
  Warp 消息 ID  0x61299911275d6348354bdb292475c8b6a04e723ca527e8f96cae054e1ec298c2
  权重 100（与既有 5 个一致）  P 链 owner 沿用既有成员的
  ```

  三条由此得到印证：

  **① `status = 1` 就是 `pending-added`。** 此前只实测过 `2 = active`（V-24），
  枚举里其余取值都是按 icm-contracts 推的。现在 1 也确认了。

  **② 「进度从链上读」经住了检验。** 执行后另起一个进程再跑一次 —— 没有任何状态文件，
  它自己看出第一步已完成，并**从事件里恢复了 validationID**，报出"接下来是第 2 步"。
  这正是 FR-016 想要的形状：中断、换机器、隔一天再来，结论都一样。

  **③ 「只有 Initiated 没有 Completed → 不算成员」在真实事件上成立。**
  这条是 T026 离线写下的断言（tests/unit/member-set.test.mjs），
  现在有了一条真的 `InitiatedValidatorRegistration` 事件来验它：
  `membership:status` 仍报 5 个注册成员、漂移仍是 `member-missing`、
  面板仍是 `normal`（链上 5 / 声明 6）。

  若把 Initiated 也算成成员，此刻面板会显示 6 个成员、余量 1，
  而链上真正带权重的仍是 5 个 —— 又一次账目不实（对照 V-31）。

- **V-37** ✅ **第二步（签名聚合）已跑通**（2026-09-15）。

  > 📝 **本条原编号为 V-35，2026-09-17 由 T001 的回填改号**，理由同 V-36：
  > 2026-09-16 另有一条 V-35（退出第四步的 justification）且被测试引用，本条无引用。
  `4/5 签名者（80%，门槛 67%），bitset 0x1d`，消息 258 → 363 字节。

  **但过程中有三件事值得记下，两件是我自己的错：**

  **① `quorumNum` 参数不是硬门槛。** 传 67，它照样返回只有 3 个签名者的消息
  （3/5 = 60%）。**返回成功不代表达到门槛** —— 所以门槛必须在调用方自己验
  （`meetsQuorum`）。没有这条，一条 60% 的消息会被带到花钱的第三步再被 P 链拒绝。

  **② 我先前"五个全部开启 Warp API"的结论是错的。** 探测脚本把响应截断到 90 字符，
  而要匹配的 `does not exist` 恰好被截掉，于是落进"有 error 就算 API 在"那个分支。
  实际当时是 4 个有、win-2 没有（那台起回来后没 `git pull`，磁盘上的链配置还是旧的）。
  **教训：拿截断过的输出做模式匹配，等于在猜。** 判据要么读完整响应，要么按结构取字段。

  **③ win-1 的容器网络问题第四次。** 这次表现是这个调用**挂住 45 秒**
  （前三次：入站端口空回复两次、出站连不上一次）。`up -d --force-recreate` 后
  同一调用 31 毫秒返回。所以第二步设计成**逐个验证者试**，不钉在单个节点上。

  修好两台之后五个节点全部 9–31 毫秒应答，聚合到 4/5。

  **仍是 4/5 而不是 5/5** —— bitset `0x1d` 里第 1 位空着，有一个验证者一直没签。
  过门槛所以不阻塞，但这是个**未查明的观察**，不是"全好了"。
  若哪天门槛提到 80% 以上，它会变成阻塞项。

### V-34 P 链验证 warp 消息用的是**前一格**的成员集合（2026-09-17，T033 实测）

**这一条把上面 V-33 那句"若哪天门槛提到 80% 以上，它会变成阻塞项"变成了现实。**

把 l1-2 加回来（T041 刚把它退掉）时，第三步被 P 链拒绝：

```
couldn't issue tx: failed verifying warp messages:
  signature weight is insufficient: 67*600 > 100*400
```

而工具同一屏上刚打印过「签名者 4/5（80%，门槛 67%）」。**两句话都对，分母不同**：

| | 集合 | 合计权重 | 4 个签名 |
|---|---|---|---|
| 聚合器（工具） | 当前 5 个成员 | 500 | 400 = 80% ≥ 67% ✅ |
| P 链（验证方） | 6 个成员 | 600 | 400 < 402 ❌ |

分母的来源查实了（`platform.getValidatorsAt`，subnetID = 本链）：

| 高度 | 成员 | 合计权重 |
|---|---|---|
| 8 | 6（含 l1-2） | 600 |
| **9（= `platform.getHeight`，退成员那一格）** | 5 | 500 |

**P 链验证 warp 消息时用的是「当前高度**之前一格**」的集合。** 它比成员变更落后一格。

#### 后果：退完成员紧接着的那次加入是**零容错**的

门槛 67% × 600 = 402，而能签的只有 5 个 × 100 = 500 —— **必须五个全签**
（4 个只有 400）。也就是那一次加入不容许任何一个节点的 P2P 签名不通。
而 P2P 签名恰恰是本项目反复观察到会飘的那一环（见 V-33 与下面一段）。

推进一格 P 链之后分母变成 500，门槛 335，**4/5 就够** —— 恢复到 f=1。

#### P 链不会自己出块

没有交易就没有新高度，所以"等一会儿"不管用。要推进得真发一笔。
最无害的一种是 `BaseTx` 把一点 AVAX 转给**自己**：不碰任何成员、权益与合约，
代价只有一笔手续费（实测 **5179 nAVAX = 0.0000052 AVAX**）。
实现见 `tools/membership/add-validator.mjs` 的 `nudgePChainHeight`。

#### 工具的改法：**跟链学，不猜**

三处，都在 `add-validator.mjs`：

1. `readVerificationWeights()` —— 事前把**两个分母**都读出来（当前高度与前一格），
   `lagging` 是算出来的而不是常量。
2. `quorumForChainTotal()` —— 按链的分母折算出该向聚合器要多少百分比：
   `⌈quorumNum × chainTotal / localTotal⌉`。**向上取整是要害** ——
   向下取整会得到 80%，而 80% × 500 = 400 正是被拒的那个数：
   "门槛提高了却一点用没有"。`tests/unit/membership-quorum-denominator.test.mjs`
   用穷举守这条性质，两次变红检查都过。
3. `parseInsufficientWeight()` —— 万一事前那两个读数还是对不上（比如链换了
   quorumDenominator），就**从报错里解出链用的分母**再重试一次。
   分母不是 100 时返回 `null` 走原来的失败路径，不算出一个错的门槛。

原先的门槛 `67` 现在是 `BASE_QUORUM_NUM`，并写明它**不是**读创世来的：
创世 `warpConfig.quorumNumerator` 管的是 subnet-evm 预编译那一侧，
而这里是 P 链验证 `RegisterL1ValidatorTx`，那个数在 avalanchego 里是常量。
两边此刻都是 67，但工具不靠它。

#### 实测推翻了"多收签名就能过"（2026-09-17 当晚）

先按"零容错"理解处置了一轮：重启节点把 P2P 签名凑齐到 **5/5（100%）**，再提交第三步。
链换了一句话拒绝：

```
couldn't issue tx: failed verification: failed verifying warp messages:
  signature is invalid
```

两次并排看，根因就露出来了：

| 签名者 | 链的回话 |
|---|---|
| 4/5 | `signature weight is insufficient: 67*600 > 100*400` |
| 5/5 | `signature is invalid` |

第二条才是根本：**BitSetSignature 的位索引是对「验证高度那个集合」编号的**，
而聚合方（L1 节点的 `warp_getMessageAggregateSignature`）是按**当前**集合建位图的。
两个集合不同 → 按位图还原出的聚合公钥不等于实际签名者的公钥之和 → 签名不合法。

`identifySigners` 对同一条聚合消息做密码学判定是 **5/5 全签**，
也就是说那条聚合消息**对当前集合是有效的**，只对落后那一格无效。

**所以推进一格不是"更省的做法"，是唯一的路。** 只要验证集合落后一格，
收多少签名都过不去 —— 这一条把上面"这一次零容错"的说法纠正了。

两次提交都在**验证阶段**被拒（`failed verification`），没有进块，没有花钱。

### V-34② 第四步也有同一个"差一格"，但它会自愈（2026-09-17）

推进 P 链一格之后第三步一次就过了（4/5 = 400 ≥ 67% × 500 = 335，位图也对得上）：

```
✓ 交易 dmM4gDey6E28JumUZbLgTmcKTGzia91Lb2G4v5qyh7FRwjxfN（推进，手续费 5179 nAVAX）
✓ 高度 9 → 10，验证分母 600 → 500
✅ 第三步完成  P 链交易 JbmhwyUMN4o6qZC5oPiBRUpxEEf3XYqTHmF4jmXUytZswcE9k
```

**紧接着的第四步 revert 了一次**（`0x2f53a7b7…`），干跑里的"模拟不能证明会成功"
那句话又一次成立。第二次重试就过了（`0x4247f586…`，区块 1304），中间什么都没改。

差别只有一个：`platform.getHeight` 此时是 11，而各 L1 节点**刚**把它接受下来。
第一次提交时区块带的 P 链高度还是 10（那时 L1 集合是 5 个），而聚合器已按 6 个建位图 ——
和第三步那次是**同一个"差一格"，方向相反**：

| 谁在落后 | 症状 | 处置 |
|---|---|---|
| 第三步：**P 链**的验证集合落后一格 | `weight is insufficient` / `signature is invalid` | **必须推进一格**（P 链不自己出块，等没用） |
| 第四步：**subnet-evm 侧**节点的 P 链视图落后 | 交易 revert（预编译 valid = false） | **等一下重试**（节点会自己接受新高度） |

所以两边的处置**恰好相反**：一个等不来，一个等就好。工具当前对第四步的建议
（"可以直接重跑本命令重试"）是对的；对第三步的旧建议（"多收签名"）是错的，已改。

实操判据：重试第四步之前先核一下各 L1 节点的 P 链高度是否已等于 `platform.getHeight`：

```
curl -s -XPOST -d '{"jsonrpc":"2.0","id":1,"method":"platform.getHeight","params":{}}' \
  http://<primary>:21650/ext/bc/P
curl -s http://<l1>:2166x/ext/health   # checks.P.message.engine.consensus.lastAcceptedHeight
```

### V-35 P2P 签名会飘，而且**轮换**（2026-09-17）

同一条消息，五个节点全都能用 HTTP `warp_getMessageSignature` 签出来 ——
**经 P2P 就要不齐**：

| 时刻 | 签到 | 没签 |
|---|---|---|
| 首次尝试 | 4/5 | l1-1 |
| 20 分钟后（没动任何东西） | 3/5 | l1-1、l1-3 |
| l1-1 真重启后 | 4/5 | **l1-3** |

所以：**不是某个坏节点**，而且"HTTP 能签"不代表"P2P 能要到"。
V-33 里那个"一直没签的第 1 位"是同一个现象，当时不阻塞所以只记了一句。

**这也是为什么 V-34 那个零容错窗口非关不可**：把容错交给一个已知会飘的环节，
等于把"能不能加成员"变成一次抽签。

### V-36 `devnet-node.ps1 restart` 报了一次假成功（2026-09-17）

`.\scripts\devnet-node.ps1 restart l1-1` 打印「l1-1 已重启」，而容器的
`StartedAt` **一字未变**（`RestartCount = 0`）。随后在 `docker/compose/` 目录里
手动跑 `docker compose -f lan-win-1.yml restart l1-1`，`StartedAt` 立刻变了。

两处都退出 0，所以 `Invoke-NodeCompose` 的退出码检查（`a9718cb` 加的那个）拦不住它 ——
**compose 自己"什么都没做"也算成功**。差别不在 project 名（两边都是 `compose`，
从仓库根跑 `ps` 也能看见 l1-1 running），根因**尚未查明**。

危害与 `a9718cb` 修掉的那条同级：这是一条会让人以为"我已经重启过了、问题不在这儿"
的假成功 —— 我自己就被它误导了一轮，把签名者从 4 掉到 3 错算成"重启弄坏了"。

**待办**：给 `stop/start/restart` 加一条真正的事后判定（比对 `StartedAt` /
`State.Status`），而不是只看 compose 的退出码。一条不会变红的守卫比没有守卫更坏。

### V-37 面板的 /api/snapshot 崩在 BigInt，而 263 个单元测试一个都没红（2026-09-17）

T033 走完后起面板核判据，**第一个请求就把进程打掉**：

```
TypeError: Do not know how to serialize a BigInt
  at JSON.stringify (<anonymous>)
  at json (tools/dashboard/server.mjs:80)
```

来源是 `member-set.mjs` 里**刻意**用的 BigInt：P 链成员权重，以及 Primary 的质押
（10^15 量级，用 Number 在别的部署里会丢精度）。那个选择是对的。错的是
**没人问过"这个对象能不能变成 JSON"**。

已有的面板测试全都断言 `buildSnapshot` 返回的**对象** —— tier 对不对、余量算得对不对、
文案里有没有那句话。一条都没经过序列化，而序列化恰恰是这个对象存在的理由：
它是一个 HTTP API 的响应体。**检查器自己没有被检查。**

它此前不显，是因为 `readPrimaryNetworkStake` 读不到时回 `source: 'unknown'`（不带
BigInt）—— 也就是说**只有在一切正常时才崩**。这比总是崩更坏。

修法：`server.mjs` 的 `json()` 加一个 replacer，BigInt 按**十进制字符串**出
（与 P 链 API 自己的表示一致；转 Number 会静默丢精度，比崩溃更难发现）。
守卫 `tests/unit/dashboard-snapshot-serializable.test.mjs` 同时钉两件事：
①快照里**确实**有 BigInt（否则这条守卫恒绿）、②那条路径能序列化它。

写这条守卫时自己也踩了一次同类错：先按 `"weight":"100"` 断言，红了 ——
BigInt 全在 `rejoin` 下（成员权重并不进快照）。**按查到的字段断言，别按猜的字段。**

### V-38 devnet-dashboard 的容器没有名字（2026-09-17，小）

> **2026-09-21 已修**：两版都加上 `--name karmachain-dashboard`。
> 实测：起来之后 `docker ps` 按名字找得到、`docker rm -f karmachain-dashboard` 停得掉、无残留。
> 名字不带边界后缀 —— 一台机器上只该有一个面板，重名时 docker 直接报错，那正是想要的。

`scripts/devnet-dashboard.sh` 的 `docker run` 没有 `--name`，于是容器叫
`interesting_booth` 这类随机名。脚本自己说"Ctrl-C 停止" —— 而终端一旦不在，
就只能靠端口或镜像名去认它。`devnet-verify` 是 `--rm` 的短命进程，无所谓；
面板是长驻的。**待办**：给它一个 `karmachain-dashboard` 的名字。

### V-39 变红检查扫出三条**没人验过**的前置判定（2026-09-17，T032）

T032 的做法是逐条把 `precheck` 里的一条判定换成恒假，看对应用例是否变红。
三条命名判定（FR-013 / FR-014 三个分支 / FR-015）**全部如期变红**。

而同一次扫描发现另外三条判定**拿掉之后一条测试都不红**：

| 判定 | 拿掉的后果 |
|---|---|
| 公开材料拿不到 | 去注册一个没有 BLS 公钥的成员：链上多一个永远出不了有效签名的名字，而容错判据把它算成"该在线但掉了" |
| `precheck` 缺 `chainIdentity` 不再抛 | 创世那批的材料来源静默消失 —— 与当初漏 `subnetId` 同形 |
| 已经是链上成员 | 重复注册：第一步再发一次 `initiateValidatorRegistration` |

三条在代码里都真实存在，也都有注释写明为什么必须有 —— **但没人验过它们会不会变红**。
这正是本项目反复撞到的那一类：一条不会变红的守卫比没有守卫更坏，
因为它让读注释的人以为已经守住了。三组用例已补齐，重扫后 8 条全红。

#### 做成脚本而不是做一遍

手工做一遍**不留下可核对的东西**：半年后有人重构 `precheck`、顺手把某条判定
写成恒假，测试照旧全绿 —— 而"T032 做过了"已经写在 tasks.md 里。
所以落成 `tools/test/redcheck-preflight.mjs`（`npm run redcheck:preflight`）。

两个刻意的设计：

- **锚点过期不静默跳过**，报 `MUTATION-NOT-APPLIED` 并以 3 退出 ——
  一个"锚点过期就跳过"的变异器本身就是一条不会变红的守卫。
  这条失败路径验过：把一个锚点改成不存在的 → 如期退 3，且源文件还原干净。
- **每条变异都独立核对是否落进文件**（比对锚点出现次数是否恰好少一处）。
  本期两次踩过"假变红"：变异脚本因引号/转义没生效，而测试照旧全绿，
  被误读成"守卫有效"。

#### 顺带记一条我自己反复踩的坑

本期用 heredoc 往脚本里写代码时，**反斜杠被吃掉**了四次
（`s` → `s`、`d` → `d`、`
` → 真换行），每次都要靠 `node --check` 或
`cat -A` 才看出来。往文件里写含转义的内容时，改用 `String.fromCharCode(92)`
拼反斜杠，或者干脆按索引切片替换 —— 别让转义穿过两层引号。
### V-40 那一问**只有第一问能被听见**（2026-09-17，T033 实测）

走第三步要连着答两问（推进 P 链、提交交易）。管道里喂进 `y / n / y`，输出是：

```
执行第 2 步？ [y/N]                  ← 读到了 y
**先把 P 链推进一格？** [y/N]
（标准输入已关闭 —— 按「否」处理）      ← 管道里明明还有两行
```

形状很坏：**默认否让它看起来像一次正常的拒绝**。人会以为自己答错了，或者以为
工具问过了 —— 而那一问从来没被听见。交互式确认是这套工具唯一的安全闸，
而它只有第一道闩。

#### 我第一次归因错了，而且"改完没验就以为修好了"

第一版判断是 `finally` 里的 `rl.close()` 把底层 stdin 一起收掉，于是改成
共享一个 readline、问完只 `pause()`。**没修好** —— 子进程用例实测仍是
`false,false,false`。

真正的原因：管道会把 `n
y
n
` 一次交完，readline 立刻为每一行发一个
`line` 事件，而 `rl.question()` **只听一次**。后两行发出来没人接就丢了；
随后 stdin 到尽头、`close` 触发，于是后面每一问都是 EOF。

改法：自己攒一个**行队列** —— `line` 一律入队，`ask()` 从队里取，队空才去等
下一行或 EOF。这样"输入一次到齐"与"人一行一行敲"走同一条路。

#### 为什么旧的 16 条用例一条都没红

它们全都注入自己的 `input`/`output`，**测不到 `process.stdin` 的生命周期** ——
而缺陷恰恰在那条默认路径上。补的四条用例**起子进程**、往它 stdin 喂管道，
这是唯一能测到的方式。

其中第一条刻意把第一问设成 `n`：若第一问答 `y`，旧实现"后面全按否"会与
正确答案 `y,n,n` 的后两项巧合相同 —— 那样用例就抓不住缺陷。
**中间那一问必须是 `y`**，它是唯一能区分"听见了"与"按否兜底"的位置。

变红检查（两条，各自确认变异落地）：关掉队列取用 → 红；`line` 事件丢弃不入队 → 红。

### V-41 `add` 在"已经注册完成"时也要求聚合器（2026-09-17，小）

`devnet-member add` 一进来就检查 `karmachain-aggregator` 在不在，缺了以 10 退出。
对一个**已经四步走完**的 nodeID 来说那一步用不上聚合器 —— 工具本可以先读链上
进度、直接回一句"已经注册完成"。

不改：前置依赖**早报**是刻意的（在动任何东西之前失败），而这点代价只是多打一行。
记在这里，免得下次有人把它当成缺陷去"修"成延迟检查 —— 那会把失败点挪到
已经开始做事之后。
---

### V-42 重新入集的节点**可能**留在网络之外 —— 要**查**，不是必须重启（2026-09-18 起，2026-09-21 修正）

> **2026-09-21 修正**：本条原来写的是「**必须重启**，否则它留在网络之外」。
> T031 那一轮（同一条链、同一个节点、同样的退出→加回）**没有发生隔离** ——
> 半小时后复核仍是 8 peers、与其余节点同高。
>
> **那不是规则，是会飘的现象**（与 V-35 同族）。我从一两次观察里写出了一条「必须」。
> 三轮的实际结果：隔离、隔离、**没隔离**。流程完全相同。
>
> 正确的说法在下面「处置」那一节：**加完之后要查，查到隔离再重启** ——
> 而不是把重启写成流程的一步。

**这一条是规程性的，不是缺陷记录。** T033 四步全部成功、三个事实来源一致、
`devnet-verify` 当场 14/14 READY —— 而大约半小时后 l1-2 卡在落后 24 块，
与**五个 L1 验证者全断**，只连着两个 Primary。

#### 为什么会这样

每个 L1 验证者的 `bootstrap-ips` 只有两个 Primary
（`blockchain/nodes/lan/l1-*.flags.json`：`192.168.1.21:21651,192.168.1.22:21653`）。
L1 之间互相发现靠**按验证者身份 gossip 的 IP 声明**。

l1-2 退出集合时（T041），各节点把它的 IP 声明丢掉了；T033 把它加回来之后，
那份声明**没有重新传播开** —— 链上它是成员，网络里它不在。

排除项（都查过）：

- **不是网络路径**：从 win-1 到 `192.168.1.13:21663` TCP 通；到其余五个成员的
  staking 端口也全通。
- **不是机器级**：l1-2 连得上 ubuntu-1/ubuntu-2 上的两个 Primary，
  却连不上**同机不同端口**的 l1-3 / l1-4。
- **不是时钟**：两侧都在同一分钟内应答 HTTP。

#### 处置：**先查，查到隔离再**重启那个节点

```powershell
$env:KARMACHAIN_DOMAIN='win-2'; .scriptsdevnet-node.ps1 restart l1-2
```

重启后它重新与 bootstrap 握手并重新宣告自己的 IP 声明，其余节点随之重新学到它。
实测：几十秒内八个节点全部 7 peers、同在高度 1343，`devnet-verify` 回到 14/14。

#### 这条要进规程（FR-037 的加入一节）

「四步走完」**不等于**「节点回到网络里」。加回一个**曾经退出过**的成员之后，
**必须核对**（重启只在核对不过时才做）：

1. 它的 peer 数与其余节点相同
2. 它的高度追平
3. `devnet-verify` 的 `node` 与 `validator` 两项都绿

三轮里有两轮要重启，一轮不用 —— 所以**核对是必需的，重启不是**。

只看"合约与 P 链一致"会给出一个**当时为真、半小时后为假**的结论 ——
T033 那次 14/14 READY 就是在 l1-2 尚未掉线的那个窗口里跑的。
#### 修法（2026-09-19）

核心性质定成一句话：**没有恢复路径时就不要动手。**

1. `tests/e2e/lib/devnet.mjs` 加 `SHELL = findPosixShell()` 与 `script(name, …)`，
   所有仓库脚本都经它跑；`start()` 不再用裸 `sh`。
2. **`killAll()` 在没有 shell 时拒绝执行** —— `docker kill` 能跑不代表我们能起回来。
3. 13 个会改状态的套件全部加上闸门（`SHELL_SKIP`，或沿用它们自己更严的开关），
   收不了场就整套跳过，而不是动手之后失败。
4. 12 个会打掉节点的套件加 `after(() => restoreOrReport(SUITE_LABEL))` ——
   断言在"毁坏之后、恢复之前"抛出时也会把节点放回去。它自己不抛：
   在 `after` 里抛会盖掉真正的失败原因，而那个原因才是人要看的。
5. `restoreOrReport` 认 `KARMACHAIN_EXPECT_STOPPED=1` —— 那是唯一"停着才对"的场景，
   那时候把它拉起来才是破坏。

守卫 `tests/unit/e2e-destructive-gated.test.mjs`：按源码逐文件断言"有闸门"与
"有兜底恢复"，外加对 `killAll` / `script` / `restoreOrReport` 三个入口的断言。

**这条守卫第一版是假绿的。** 它查的是 `s.includes('SHELL_SKIP')` —— 而导入行里就有
这个名字，于是把 describe 选项里的 skip 整个拿掉，守卫照旧全绿（变红检查抓到）。
改成只看**顶层 describe 的选项那一段**。判定放得太宽，等于没判。

实测：把 shell 解析改成恒失败 → 三个破坏性套件带理由跳过，而容器**动都没动**
（前后同为 `Up 10 minutes`）。恢复正常后真跑两套 → 7/7 过，l1-1 被打掉后自动回来。

#### 我在同一件事上又犯了一次过程错误

为了赶时间，我把完整 e2e 放到后台跑，**然后在同一条链上又跑了别的破坏性套件** ——
两轮故障注入并发。后台那轮被我掐掉时，win-1 的容器停在 `Exited(0)`。

链一直没事（5/6 在高度 1417 继续出块），但这不是它安全的理由 ——
**它安全是因为容错刚好够，不是因为我做得对。** 破坏性套件必须串行、
而且跑的时候不要在同一条链上做别的事。
#### 修完之后的第一次完整 e2e（2026-09-19，串行）

`KARMACHAIN_CRASH_ROUNDS=5`，21 套件 / 49 条：**43 通过 / 12 跳过 / 2 条 not ok**，
而**恢复失败 0 次** —— 跑完容器健康、链在出块。V-44 的兜底在一次真实运行里成立了。

两条 not ok 里只有一条计入 `# fail`（另一条是 hook 失败 —— 正是 `run-tests.mjs`
存在的理由）。两条都**不是**产品缺陷，但都值得记：

**① `SC-003 —— 单验证者离线，30 分钟观测窗口`（计入 fail）**

30 笔交易全部确认，而第 8 分钟**三台不同机器同时报"不可达"一次**：
l1-2（win-2）、l1-3（ubuntu-1）、l1-4（ubuntu-2）。三台同时挂的概率远低于
**观测方（win-1）抖了一下**。

004 早就记过这个形状：「本机连不上它，但网络里其他节点与它有连接 ——
是本机到它的网络路径问题，不是节点故障」。而这条 e2e 用**单点、单次**探测就断言
"故障扩散了"，既不重探也不向对等节点求证 —— 面板那侧的 `unreachable` 谓词是会
求证的（`countsAsOffline === false` 那一支）。

**待办**：把这条断言的观测做到与它的说法一样强 —— 重探一次，或按对等列表求证，
再决定叫不叫"故障扩散"。**不是放宽断言**：一个从单点单次观测得出的"故障扩散"
结论本来就不成立，而它会在每次网络抖动时把一次成功的 30 分钟窗口判成失败。

**② `面板 —— 跨机创世一致性`（hook 失败，不计入 fail）**

`before` 里 `waitForSnapshot` 报 `fetch failed`。**单独跑这一套 5/5 通过** ——
所以是全量运行的上下文造成的：它紧接在杀节点的套件之后。

面板在这些 e2e 里是**进程内**起的（`server.listen(0)`），所以连接级失败最可能的
解释是**轮询循环里一个未捕获的异常把进程打掉了**，而那恰恰发生在链降级的时候 ——
也就是最需要面板的时候。

**这只是假设，没有验证。** 记成假设而不是结论 —— 今天已经两次从报错的样子猜机制
而猜错（V-40、V-43）。要验它得在链降级时观察面板进程的存活，属独立一项。
### V-43 那 5 条集成断言在 Windows 上一直是红的，而 DoD 写着"125 通过"（2026-09-18）

回填 DoD 时从 PowerShell 跑 `npm run test:integration`，**5 条红**：

```
应当退出 10，实际 127        stderr:（空）
期望退出码 13，实际 -1
```

#### 我第一次归因错了

报错里的路径长这样 —— `C:UsersADMINI~1AppDataLocalTempkm-oldfmt-AatJBMscripts…` ——
反斜杠全没了，于是我判断是"Windows 路径交给 POSIX shell 时被 MSYS 吃掉"，并改成正斜杠。

**验了一下：撤掉那个改动、从 Git Bash 跑，照样 12/12 通过。** 所以那不是原因。
（这是同一天同一形状的第二次 —— 见 V-40：从报错的样子猜机制，猜错了。）

#### 真因：`bash` 可能是 WSL

```
PowerShell> Get-Command bash → C:Windowssystem32ash.exe   ← WSL 的启动器
PowerShell> Get-Command sh   → (不在 PATH 里)
```

从 PowerShell 启动时，`spawnSync('bash', …)` 起的是 **WSL** —— 另一个操作系统、
另一套文件系统视图（仓库在它眼里是 `/mnt/f/…`），拿到 `C:/…` 的脚本路径必然 127。
而 `sh` 根本不在 PATH 里，`execFileSync` 直接起不来（-1）。

**测试结果取决于你从哪个 shell 敲的 npm test。** 从 Git Bash 跑 12/12，
从 PowerShell 跑 5 红 —— 而一条永远红的测试和一条永远不会红的一样坏：
它让整套集成失去信号。这 5 条红了多久没人知道。

#### 修法：问那个 shell 看不看得见这个仓库

`tools/test/posix-shell.mjs`：不去认"哪个 bash 是对的"（路径、版本、发行名都会变），
而是问它一句 `test -d <仓库路径>`。看得见就能跑仓库里的 `.sh`，看不见就不能 ——
WSL 那个因此被自然排除，不需要专门认它。候选里优先用 `git --exec-path` 推出来的
Git Bash。找不到时**带理由跳过**，并在理由里写明"**这不是通过**"。

顺带补上 `run-tests.mjs` 的另一半：它的文件头写着"不放过被静默跳过的套件"，
而那句话此前只覆盖了「`not ok` 却退出 0」那一种。**跳过是另一种"断言消失"** ——
node 对 `describe(…, {skip})` 报 `ok N - … # SKIP`，而 `# skipped` 仍是 0。
现在末尾会把跳过的套件逐条列出来。

### V-44 `npm run test:e2e` 会**真的打掉节点**，而且中止时不恢复（2026-09-18，我的错）

为了给 DoD 取一个数字，我跑了 `npm run test:e2e` —— **当成测量跑的**。
它不是测量：场景 A/B/C/E 与 V-03 做的是强制终止、数据卷擦除这类故障注入。
结果是 win-1 上的 `l1-1` 与 `rpc-win-1` 被 SIGKILL（退出 137），
套件随后因"开发网不可用"中止，**没有恢复它们**。

链本身没事：5/6 个验证者在高度 1383 继续出块（1 个离线 ≤ 容错 1）。
用 `devnet-start.ps1` 恢复后 8/8 节点、6/6 验证者、full margin、创世哈希与基准一致，零残留。

**这是我的错**：跑一个会改变系统状态的命令之前没有先问它会做什么。

#### 它暴露的真问题：闸门只装了一半

同一套 e2e 里，两类破坏性测试待遇不同：

| 测试 | 破坏性动作 | 闸门 |
|---|---|---|
| `verifier negative path` | 停开发网 | 要 `KARMACHAIN_ALLOW_DISRUPTIVE=1` |
| `after devnet-stop …` | 需要已停的网 | 要 `KARMACHAIN_EXPECT_STOPPED=1` |
| **场景 A/B/C/E、V-03** | **SIGKILL 节点、擦数据卷** | **没有** |

而后者破坏性更强。更要紧的是**中止时不恢复** —— 一个把节点打掉又中途退出的套件，
留下的是一个需要人工收拾的状态，而它给出的报告是"失败"，不是"我改了什么"。

**待办**：给那几个场景补上"无论如何都恢复"的收尾（与 `--emergency` 那种双向闸门同一条
道理：会改状态的动作必须自己负责把状态放回去），并统一闸门 ——
要么都要显式开关，要么都不要，但不能一半有一半没有。
### V-45…V-49 「退出→加回→再退出」逼出来的五条（2026-09-19，T034 准备期）

> **2026-09-21：另一半也补上了。** 此前「破坏性套件必须串行」只写在这里，
> 而 `--test-concurrency=1` 只保证**一次运行内**文件串行 ——
> 挡不住"把一次完整 e2e 放后台跑、同时又在同一条链上跑别的破坏性套件"，
> 也就是我 2026-09-19 干的那件事。
>
> `acquireDestructiveLock()`：12 个破坏性套件在 `before` 里取一把文件锁。
> 已被占用时**说清是谁在跑**（pid / 标签 / 起始时刻）并拒绝；
> 持有者进程已死时接管并**打印一行**（静默接管等于没有锁）；退出时释放。
> 挡得住同一台机器上的并发；**挡不住两台机器对同一条链做注入** —— 锁在 `.devnet/` 里，
> 是本机的。这一点写出来，免得有人以为有了锁就万无一失。
>
> 验锁时顺带查到：`killAll()` 的过滤 `name=karmachain-` **把聚合器也杀了**，
> 而它是按需容器、`devnet-start` 不会带它回来 —— 于是下一次成员变更以退出码 10 失败，
> 而这一轮从没打算动它。函数自己的注释写的是"全部**节点**容器"，过滤比说法宽。已排除。

为了给 T034 造一个真正的引导窗口，要先把 l1-2 退出再加回。**这一趟走不下去** ——
每一步都撞上一个此前没显形的缺陷。五条有一个共同形状：
**代码里那个「要么 A 要么 B」的分支，遇到了「先 A 后 B 再 A」的东西。**

#### V-45 退出侧完全没有 `--nudge`，而落后一格在这个方向表现为**位图越界**

```
unknown validator: NumIndices (5) >= NumFilteredValidators (5)
```

当前 6 个成员，而链按 `getHeight()-1 = 10` 那格的 **5 个**验 —— T033 的注册正是
把高度推到 11 的那一块，此后 P 链没再前进。位图按 6 个编号，第 6 个位置在链看来不存在。

**所以 V-34 要推广**：落后一格影响的不只是**分母**（门槛算不对），
是**整个集合** —— 位序也会错，而位序错了报的是完全不同的一句话。
两个函数因此搬到 `tools/membership/pchain-verification-set.mjs`，加入与退出共用一份。

#### V-46 第四步的 justification 要**内层 182 字节**，而工具传了整条 258 字节

`step4Remove` 从第一版就有 `registerMessage` 参数，而命令行**从来没传过它** ——
没显形是因为在此之前退的每一个都是**创世派生**的（走 `SubnetIDIndex` 那一支）。
l1-2 现在是「创世出身 + ACP-77 重注册」的混合身份，两支都取不到材料。

补上之后仍不行：`warp_getMessage` 给的是**整条未签名 warp 消息**，而 justification
要的是最内层那段。传整条的后果**不报错** —— 每个节点静默拒签，聚合器只报
`accumulatedWeight: 0`，与"网络连不上"长得一模一样。

偏移是**穷举子串撞哈希**定下来的：258 字节里只有 `[76, 258)` 的 sha256 等于
validationID。回头对结构正好是 warp 头 42 + AddressedCall 头 34。
与 `genesisValidationIndex` 同一条方法 —— **公式对得上就是对得上**，不靠文档。
并且加了 `sha256(载荷) === validationID` 的**自校验**：布局哪天变了，
剥出来的还是一段"看起来像载荷"的字节，而后果又是静默拒签。

#### V-47 `assessProgress` 取到了**上一轮**的注册事件

事件是追加的：加入、退出、再加入，历史里会有两条 `InitiatedValidatorRegistration`。
工具取到第一条，报"已完成 1/4 步"并直接去发第三步 —— 而那条注册消息 11 小时前就过期：

```
warp message expired at 1789747643 and it is currently 1789787980
```

真实进度是 **0/4**。判据取自链上：validationID 有过 `CompletedValidatorRemoval` 的，
那一轮已经结束 —— 与 `classifyDrift` 里"退出已经走完"用的是同一条证据。

#### V-48 聚合器 `/health` 报 `up` 时，它**一个验证者都还没连上**

> **2026-09-21 已修。** 判据取自它自己的指标（端口 8647，与 API 同主机）：
>
> ```
> signature_aggregator_connected_stake_weight_percentage{subnetID="…"} 100
> ```
>
> 刚起来是 0，连齐了是 100。`aggregatorConnectedStake()` 读它，**读不到返回 `null`** ——
>「没读到」与「是 0」是两件事：前者说不出它连没连上，后者说它确实没连上。
>
> 收不齐签名时的诊断现在会先问这个数，据此把两种成因分开说：
> 低于门槛 → **「它多半是刚起来还没连上，等一会儿」**；已达门槛 → 「某个验证者不签」。
> 而 `allow-private-ips` 被降级成「**长期停在 0 才去查**」—— 它此前是首要建议，
> 于是 2026-09-19 我照着它查了一轮，而真因是起来才 13 秒。
>
> `docs/devnet.md` 里那句「`curl /health` 必须是 up」改成了这条可判的判据，
> 并给了一条**逐字跑得通**的命令（跑过一遍，输出就是那个百分比）。

重启聚合器后 13 秒就用它 → `accumulatedWeight: 0`、`Failed to connect to a threshold of stake`。
而文档现在只教人 `curl /health` 必须是 `"up"` —— 那时它**已经是** `up`。

**`up` 不等于「可用」**：它要先与两个 Primary 握手、再经 gossip 学到各 L1 验证者的
IP 声明，才谈得上收签名。等约 90 秒后同一条命令就过了。
而工具当时的提示把这个症状指向 `allow-private-ips`（那是另一个成因，同样的症状）。

**待办**：文档里那句"必须是 up"要改成"起来之后等它真的连上"，并给一个可判的判据。

#### V-49 面板那条 `canQuery` 判定有盲区 —— 我自己修的那一条

2026-09-18 修的是"**落后且无进展**"那一支：连不上足够成员 → `stalled`。
而 2026-09-19 撞到的是另一种：l1-1 **高度没落后**（和大家都在 1503），
它自己却报 `not connected to enough stake: 66.666667%`，投不了票 ——
**面板照报 `100% / 参与 6`**。

判定被我挂在"落后"这个前提上，而"连不上 quorum"与"落后"是两件事：
一个跟得上高度的节点同样可能发不起查询。

#### 修法（2026-09-21）：两半，而第二半是我原来就漏的

**前一半**：把判定从"落后且无进展"那一支里提出来，追平那一支也算一次。

**后一半**：加上 002 的 data-model §7 给 `stalled` 定的那个条件 ——

> 未在服务 L1 且超过窗口，**且其余验证者全部在场**。后一个条件是必需的：
> 跨机分批启动时先起来的机器无法服务 L1，成因在别的机器未启动
>（未达 α/k=75% 查询门槛），**本机无可处置之处**。

2026-09-18 那版只算"连上了几个"，**没问那些没连上的是不是本来就不在**。
后果是：三台机器真的下线时，每个幸存节点都会"连不上 75%"而被逐个判成 `stalled` ——
一屋子假红灯，而容错那边已经把下线的那几个算过一次了（双重计数）。

它此前没显形，**正是因为判定被锁在"落后"那一支里**。
也就是说：**只修前一半会把后一半激活。** 两半必须一起修。

"不在"怎么判沿用 004 那条区分：**本机探不到 + 其余节点的对等列表里也没有**
才算真的缺席；只是本机探不到的，是本机到它的路径问题（链里还有它）。

文案把三样都说出来：连上几个、**看不见哪几个而它们活着**、另有几个本来就不在。

变红检查三条：拿掉追平那一支的判定 → 3 红；拿掉"其余全在场"条件 → 红；
让"谁不在"恒为空 → 红。活链复核：健康网络上八个节点全 `healthy`，**零误报**。

#### 一条关于我自己的

这是同一条判定**第二次**被记成缺陷：第一次（V-49）是它挂错了前提，
第二次是它漏了数据模型里白纸黑字的一个条件 —— 而那个条件就写在 002 的 §7 里，
我写第一版时没去读它。**仓库里已经有的答案，比我现场想出来的可靠。**

### V-50 `devnet-node.ps1` 在 Windows PowerShell 5.1 下**整个解析不了**（2026-09-20）

维护者在 win-2 上跑 `.scriptsdevnet-node.ps1 restart l1-2`：

```
所在位置 …devnet-node.ps1:26 字符: 5
+     | Where-Object { $_ -and $_.ToString().Trim() } | ForEach-Object …
不允许使用空管道元素。
+ FullyQualifiedErrorId : EmptyPipeElement
```

**不是某一行失败，是整个脚本没开始跑。** 5.1 不接受以 `|` 开头的续行，
PowerShell 7 接受 —— 而两台 Windows 机器上装的是 5.1。

#### 我见过这个报错，然后放过去了

两天前（V-36 那一轮）我用 5.1 做语法检查时，它报的就是同一行同一句。
我当时判断成「5.1 对 `@(…)` 里的换行管道更严」，换 `pwsh`（7.x）通过就继续了。

**那不是"更严"，那是真的语法错。** 与 DoD 第 15 条同族：
**拿到一个「你的前提可能不成立」的信号，然后没去验。**
这已经是本期第四次 —— 前三次是 V-40、V-43，以及 V-34 把"落后一格"误判成"零容错"。

#### 守卫：让 5.1 自己去解析，而不是扫几个模式

5.1 与 7 的差异不止一条：行首 `|` 续行、`&&` / `||` 管道链、`??`、三元 `? :`
都是 7 才有的。列一张模式表只能守住**想得到**的那几条，
而想不到的那条恰恰是会出事的那条。

`tools/test/parse-ps51.ps1` + `tests/unit/powershell-51-parses.test.mjs`：
拿本机的 `powershell.exe` 逐个 `ParseFile`，零语法错才算过。
两条附加断言各有用处 ——

- **确认用的确实是 5.x**：用 7.x 验等于没验，而那正是我犯的错
- 没有 `powershell.exe` 的机器**带理由跳过**，理由里写明「这一轮没有验过 5.1」

扫全仓库只有这一处（14 个 `.ps1` 全部复查）。变红检查：把 `|` 挪回行首 → 红。
### V-51 T034 实测：引导窗口 24.4 秒，面板在其中恒为 83%（2026-09-20）

#### 为什么非得先退再加

T033 那次没有窗口：l1-2 的数据卷一直在，重新入网是"恢复"不是"引导"，秒级追平。
要造出窗口只能 `wipe` 数据卷 —— 而**时机受两条硬约束**：

1. **工具会拒绝给一个正在引导的节点注册。** `precheck` 的 FR-014 要向新节点自己读
   创世区块，而引导中那条 RPC 还没起来 → "读不到创世信息，**不核对就不注册**"。
   而 CLI **每次调用都跑一遍前置检查**。所以 wipe 必须在集合变长**之后**。
2. **窗口只有几十秒**，眼睛看不到，得按 200ms 采样。

于是顺序定成：退出（记基线 n=5）→ 完整加回（n=6）→ wipe + start → 采样。
把 wipe 放在第四步**完成之后**也是有意的：l1-2 一旦成为成员，第四步的签名门槛
分母就含它，而 V-35 说 P2P 签名会飘 —— 让它先走完，就不用在零容错下收签名。

#### 实测

| 时刻 | 面板读数 |
|---|---|
| 基线 A（加入之前，n=5） | 参与 5 / **100%** / 余量 1 / normal |
| 加回之后、wipe 之前 | n=6 / 参与 6 / 100% / 余量 1 / normal |
| wipe（容器停） | n=6 / 参与 5 / 83% / 余量 0 / zero-margin / `unreachable` |
| **引导期间（24.4 秒，5 个样本）** | **n=6 / 参与 5 / 83% / 余量 0 / zero-margin / `bootstrapping`** |
| 追平之后 | n=6 / 参与 6 / 100% / 余量 1 / normal |

**判据成立：83% ≤ 100%。** 名册从 5 变长到 6，而结论**变保守了**，没有变乐观。

附带一并验到（都只看窗口内那 5 个样本）：

- **FR-026** 引导中不计入参与共识 —— 参与恒为 5，那个在引导的没被算进去
- **FR-027** 分母取声明的成员数 —— 恒为 6，没有因为"少看见一行"就变小
- **不被报成故障** —— 状态是 `bootstrapping`，文案是「引导中 —— 要等，不是故障」
- 链始终在门槛内：5/6 = 83% ≥ 75%

#### 一处我自己差点读错

第一遍取样本时我给窗口加了 `+6 秒` 的宽限（想容下面板 5 秒的轮询滞后），
结果把**引导结束之后**那个 100% 的样本也算了进来，于是"引导期间最高 100%"。
数字仍然满足判据，但那是**巧合**：它比的其实是窗口外的读数。

改成按**面板自己看到的状态**取样本（`targetState === "bootstrapping"`）——
判据问的正是"面板在那时候说什么"，那就按面板的说法划窗口。
**宽限是我加的，而它把结论悄悄换成了另一件事的结论。**
### V-52 T031 活链注入：四步各一次，四次都说得清（2026-09-21）

场景 N 的判据是「四步各注入一次，四次都能说清；**没有一次只回『失败了』**」。
走了一整个来回（退出 + 加回），四个注入点都**便宜且真实** ——
没有一个需要改代码，也没有一个把链推过门槛。

| 步 | 注入方式 | 工具的回答 | 退出码 |
|---|---|---|---|
| ① 合约调用 | 停掉入口代理 | 「连不上 L1 RPC …**一步都没动链** —— 本命令在读到链上进度之前就停了」 | **30** |
| ② Warp 聚合 | 停一个验证者，使门槛凑不齐 | 「只聚合到 4/5 个签名者（80%），低于 quorum 门槛 81% …**没签的是：l1-1/win-1**…**这一步不写链，修好之后直接重跑即可**」 | 31 |
| ③ P 链交易 | 不带 `--nudge`（验证集合落后一格） | 「**必须先把 P 链推进一格** …位图的索引会越界…要推进就带 --nudge 重跑」—— **拦在花钱之前** | 31 |
| ④ 确认 | 聚合器指向死端口 | 「**停在第四步**：P 链已摘除、合约还没认」+「第四步的**准备**阶段失败（还没发交易）」 | 31 |

四次之后各自清理重试，**最终都成功**：退出走完（区块 1517）、加回走完（区块 1519），
三个事实来源一致、零漂移，`devnet-verify` 14/14。

#### 注入 ① 当场抓到一个缺陷

停掉入口代理第一次跑，拿到的不是一句话，是**一段崩溃**：

```
[TypeError: fetch failed]
  [cause]: Error: getaddrinfo ENOTFOUND karmachain-rpc-win-1
Node.js v24.21.0
exit=1
```

而本仓库的成员工具用的是 30/31/32/33 那一套 —— **1 在这里没有任何含义**，
靠退出码分流的调用方读不出发生了什么。**比「只回失败了」更糟**。

成因：三个工具的命令行主体都是**顶层 await，没有 try/catch 包得住**。
修法 `tools/membership/cli-failure.mjs`：

- `assertChainReachable()` 在动任何东西之前问一次链 —— 不可达时退 **30**，
  因为那个码的含义正是「一步都没动链」，而此刻这句话确定为真
- 进程级 `unhandledRejection` / `uncaughtException` 兜底，退 31，
  **不说「链没动」**（那时不知道），只说「再跑一次，它从链上读真实进度」

#### 两条顺带查实的事

**退出的第二步不用外部聚合器。** 我原以为 `KARMACHAIN_AGGREGATOR_URL` 指死端口能命中
第二步，实际它照常走完 —— 第二步走的是**节点自己的** `warp_getMessageAggregateSignature`，
外部聚合器只在**第四步**用。这解释了为什么第二步"失败可无代价重做"：它连外部依赖都没有。

**5/5 全签也过不去。** 注入 ② 的第一次尝试里，5 个成员全签、门槛 81% 满足，
而第三步仍被链以 `signature is invalid` 拒绝 —— 这是 V-34 那条主张
（落后一格时多收签名没用，因为位图按另一个集合编号）在活链上的**又一次独立复现**。
### V-53 「一次读失败不是判决」—— 同一个形状，本期撞到三次（2026-09-21）

起点是去查 e2e 那条 `面板 —— 跨机创世一致性`：全量运行里 hook `fetch failed`，
而**单独跑它 5/5 通过**。我先前把它记成一个**假设**：
「轮询循环里未捕获的异常打掉了进程」。

#### 假设被代码直接证伪

轮询循环有 try/catch，注释还专门写着「采集本身出错也不能让服务倒下 ——
那会让"面板挂了"与"链挂了"无法分辨」。所以不是那个原因。**记成假设是对的。**

#### 复现之后，形状变了

按原顺序连跑两套：第一次红在**另一套**上，第二次两套全过 —— **间歇性**。
再跑三轮，失败变成一条实质的：

```
l1-6（ubuntu-4）的创世哈希与基准不符 —— 它跑在另一条链上
null !== true
```

而同一时刻直接问 l1-6 `eth_getBlockByNumber("0x0")`，**它答得好好的**。
那个 `null` 是一次瞬时读失败 —— 而 `probeNode` 的注释里写着
「取不到就留 null —— null（未知）与"不匹配"是两件事，**不得混淆**」。
**这个测试把它们混了**，还用上了本仓库最重的那个词：分叉。

#### 于是看清了：同一个形状，三处

| 哪里 | 一次读失败被当成了什么 |
|---|---|
| `spreadProblems` | 第 8 分钟三台机器各"不可达"一次 → **「故障扩散了」**，而那 30 笔交易全部确认 |
| `dashboard-genesis-parity` | 某一轮 `genesisHash` 为 `null` → **「它跑在另一条链上」** |
| `waitForSnapshot` | 一次 `fetch failed` → 整个套件 hookFailed |

三处的结论都很重（故障扩散 / 分叉 / 服务挂了），而**从一次读失败得不出它们**。
004 早就记过这个形状（「是本机到它的网络路径问题，不是节点故障」），三处都没照着做。

#### 修法：把观测做到与说法一样强

不是放宽断言 —— 放宽会让真故障也溜过去。

- `spreadProblems`：只对**看起来不好的那几个**复核一次，两次都不成才算。
  正常路径上一次复核都不会发生（没有可疑对象就直接返回）。结论里写明"复核仍然如此"。
- `dashboard-genesis-parity`：**等到每个可达验证者都读到创世**再判；
  并把 `null`（读不到）与 `false`（不符）分成两条断言、两句话。
- `waitForSnapshot`：读失败**接住并记下根因**（`err.cause.code` —— `fetch failed`
  把它藏在里面），照旧计入超时窗口；**一直读不到仍然抛**，报错里带上那些根因。
  容忍一次抖动，不等于永远不报。

实测：修前三轮三红，修后三轮全绿。

#### 守卫自己第一版也太松

`tests/unit/one-read-is-not-a-verdict.test.mjs` 第一版只要求
「`waitForSnapshot(dash, withGenesis` **出现过**」—— 而那个文件里有两处判据都依赖它，
于是把其中一处的等待拿掉，守卫照旧全绿（变红检查抓到）。
改成**按出现次数**断言。**一个只要求"某处做了"的守卫，挡不住"另一处没做"。**
## 依赖偏离记录：`@avalabs/avalanchejs@5.1.0`（2026-09-14）

**FR-035 要求零新增依赖，本期有且只有这一处偏离，由维护者拍板。**

原因：ACP-77 的第三步是一笔 **P 链** `RegisterL1ValidatorTx` —— 不是 EVM 交易，
`viem` 做不了。三条路各自的代价摆出来之后选了这条：

| 路 | 代价 |
|---|---|
| **加 avalanchejs**（选定） | 违反"零新增依赖"，但它是**官方库**、是数据与编码库不是框架 |
| 用 Avalanche CLI 跑这一步 | 要改 ADR-0008 与 no-cli-in-runtime 守卫；而且 CLI 靠自己的账本认链，那个账本在临时网络里早没了 |
| 手写 P 链交易序列化 | 零新增依赖，但要自己实现 Avalanche 的 codec、UTXO 选择与费用计算 —— **几百行共识关键代码，错了不是报错而是发出一笔「合法但不对」的交易** |

**实际引入**：`@avalabs/avalanchejs`、`@ethereumjs/rlp`、`@noble/secp256k1`、
`micro-eth-signer`、`micro-packed`，外加 `@noble/*` 与 `@scure/base` 的嵌套副本 ——
都是 noble/micro 那套小型加密与编码库。`npm audit` **没有新增任何漏洞**
（既有的两条来自 `solc 0.8.36 → tmp`，与本次无关）。版本用 `--save-exact` 锁死。

**边界**：它只许出现在 `tools/membership/` 里。守卫见 T071 ——
少了那条守卫，这个例外会慢慢渗进运行时路径，而 ADR-0008 的结构性保证
（节点镜像不含编排工具、运行时路径无此类调用）正是靠"边界写下来并被机械检查"维持的。

---

## 四、当前环境

五台机器在线，链健康（7/7 节点、`normal/100%`、高度 890+）。
004 刚交付，五台的代理都已换成新配置。

**范围 C 的实测会改动 Primary 的配置甚至重启节点** ——
到那一步必须先问用户，不自行动手。

### V-54 T021 离线测量：加一台承载验证者的机器，会改到哪些文件（2026-09-21）

T021 的四条判据里，①创世哈希不变、②stamp 六项逐字节不变、③零个节点退出 12、
④既有节点容器 `Created`/`StartedAt` 逐字符相同 —— 后两条都取决于一件事：
**重新生成之后，既有节点的声明有没有变**。所以动手之前先离线量它，
不碰任何机器。做法是往 `blockchain/deployment.json` 加第 7 台（`ubuntu-5` /
192.168.1.32 / `l1-7`），跑 `npm run render`，再 `git status`。

#### T010 记下的那个拦路石已经过期

T010 的备注说：`http-allowed-hosts` 是一份全局清单，加机器会迫使五台机器的
容器全部重建，判据 ④ 因此不成立，并写着「T021 动手前必须先定这件事怎么办」。
**这条已经不适用了。** `render-node-flags.mjs` 里 `allowedHosts` 经 `namesOnly()`
过滤，IP 字面量根本不进清单（V-19 的实测结论：avalanchego 无条件接受 IP 字面量
Host 头），当前值是 `["127.0.0.1","localhost"]`。按 IP 加机器对它零影响。

**真正的拦路石是另一件事**，校验器直接报了出来：

```
constraint: topology has 7 l1-validator nodes but validators.count is 6
constraint: topology l1-validator nodes must reference validators.nodes
            indices 1,2,3,4,5,6 exactly once each (got 1,2,3,4,5,6,7)
constraint: deployment "local": node(s) not assigned to any failure domain: l1-7
```

即"加一台机器"不是加一个故障边界就完了，还要 `validators.count`、
`validators.nodes[]` 的端口条目、以及 **`local` 形态也要安置** l1-7 ——
`local` 不在跑，但它是同一份声明里的另一个形态，漏了就不通过。

#### 关键：`validators.count` 在哪个文件里

这决定判据 ② 成不成立。核对结果：`protocol.json.validators` 只有
`management` / `ownerAccount` / `nodes: []`（空壳），真正的 `count` 与
`nodes[]` 住在 `deployment.json`。**A 块的分家已经把它挪出去了** ——
所以加验证者不碰 `protocol.json`、不碰 `configVersion`、不碰 stamp 六项。
判据 ② 在结构上成立，不是靠运气。

#### 补全三条约束之后，实测的文件改动面

| 生成物 | 加第 7 台后 |
|---|---|
| `blockchain/genesis/` | **零改动** |
| `blockchain/nodes/lan/*.flags.json`（既有 8 个节点） | **零改动** |
| `blockchain/nodes/*.identity.json`（既有 8 个节点） | **零改动** |
| `docker/compose/lan-{win-1,win-2,ubuntu-1..4}.yml` | **零改动** |
| `blockchain/nodes/aliases.json`、`chain-config/` | 零改动 |
| `docker/compose/lan-ubuntu-5.yml` | 新增 |
| `blockchain/nodes/{lan,local}/l1-7.flags.json`、`l1-7.identity.json` | 新增 |
| `blockchain/nodes/{lan,local}/rpc-proxy.conf` | 改（加 upstream、`proxy_next_upstream_tries` 6→7） |
| `docker/compose/active.env` | 改（`KARMACHAIN_*_IDS`、`DOMAIN_COUNT` 6→7、`DOMAIN_ADDRESSES`） |
| `docker/compose/{bootstrap,local-local}.yml` | 改（都不在跑） |
| `docs/protocol-parameters.md` | 改（生成物） |

**既有节点的 flags 零改动不是读代码读出来的，是生成出来比对的。**
读代码只能得到"应该不变"：L1 验证者的 `bootstrap-ids`/`bootstrap-ips` 恒为
全部 Primary，Primary 的恒为它之前的 Primary，都与 L1 集合无关。
实测确认了这一点 —— 判据 ④ 在**文件层面**成立。

#### `MAX_OFFLINE_VALIDATORS` 从 6 台到 7 台仍然是 1

`active.env` 里 `KARMACHAIN_MAX_OFFLINE_VALIDATORS=1` 在 diff 里**没有出现** ——
生成器把 F-5 的真值守住了。这是"加了机器并不更抗"的一条直接证据，
且 `tests/unit/tolerance-after-add.test.mjs:101` 的表里 `[7, 1]` 已经在守着它。

#### 冒出来的一条顺序约束

`rpc-proxy.conf` 会把 l1-7 加进 upstream。若在 l1-7 真正能服务**之前**就同步代理，
就等于往负载池里放进一个必然连不上的成员：nginx 会 `proxy_connect_timeout 2s`
之后转下一个，客户端拿到的是**延迟**而不是 5xx（`proxy_next_upstream_tries` 已
随之变成 7）—— 但 T022 要连续 10 分钟每 30 秒一笔、零 5xx，不该拿这个去赌。
**代理的同步应排在新节点可服务之后。**

#### 还有一件绕不过去的事：新节点的身份必须先有

`render-node-flags.mjs` 走 `identityFromKeyDir(n.keyDir)` 时会去读
`blockchain/validators/dev/node-7/staker.crt`：

```
Error: ENOENT: no such file or directory, open
  '…\blockchain\validators\dev\node-7\staker.crt'
```

而 005 的约束是**新验证者私钥必须在目标机生成、不得经过仓库**。
l1-6 给出了先例：`validators.nodes[5].identity` 带 `origin: "joined"`，
只装公开材料（NodeID、BLS 公钥、PoP、三个 sha256 指纹、谁在何时回报的），
`identityOf(declared)` 优先于 `identityFromKeyDir`。
所以 **l1-7 必须先由目标机生成密钥并回报公开材料，`render` 才跑得通** ——
这不是一个可以先跳过后补的步骤，它卡在生成链的最前面。

（本次测量为验证"既有节点 flags 是否随之变化"，临时借用了 l1-6 的公开身份
材料填进 l1-7 的 `identity`，`reportedBy` 标为 `MEASUREMENT-ONLY`；
测完整棵工作树已回滚，未接触任何机器。）

#### 顺带查实的一处过期值

`protocol-rationale.json` 的理由列惯例是"复述当前值再说为什么"
（`primaryNetwork.nodeCount` → `"2：…"`）。`validators.count` 的理由写着
`"5：…"` 而实际已是 6 —— 加第 7 台会让它变成 `"5："` 挨着值 7。
已改成不复述当前值，并把 F-5 写进去；`validators.nodes` 的
"迁到 21650-21669" 同理改成不写上界（node-7 的 21672/21673 落在区间外）。

**没有给整张理由表加通用守卫。** 探针量过：29 行里 7 行的"不符"是千分位与
单位造成的假阳性（`"15,000,000"` vs `15000000`、`"25 gwei"` vs `25000000000`）——
恒定非空的告警等于没有告警。只给 `validators.count` 加了一条
（理由不得以数字开头），变红检查已过：注入 `"5：…"` 后 `not ok 5`，还原后 29/29。

### V-55 守卫声称的性质比它查的范围宽 —— 在第七台机器上现场打穿（2026-09-21）

ubuntu-5 上照 `docs/devnet.md` §11.2 执行：

```
$ KARMACHAIN_DOMAIN=ubuntu-5 tools/membership/gen-node-keys.sh 7
bash: tools/membership/gen-node-keys.sh: 权限不够
```

`tools/membership/gen-node-keys.sh` 以 **100644** 进了仓库。

#### 这件事本该被守住，而守卫在那儿

`tests/unit/powershell-portability.test.mjs` 早有一条专门的守卫，注释里连措辞陷阱
都写清楚了（「`command not found` 会把人引向 PATH 而不是权限」），
判据也对（只看 git 索引的模式位，因为在 Windows 上 stat 权限没有意义），
`_` 开头的库还做了反向断言。它 2026-09-08 就是被 ubuntu-1 上一次真实失败逼出来的。

**它唯一的问题是作用域**：`git ls-files -s -- scripts`。
而这条守卫的标题声称的是「宿主直接执行的 .sh」这个**性质** ——
`tools/membership/gen-node-keys.sh` 与 `tools/protocol/extract-vm-alloc.sh`
都是宿主直接执行的，都住在 `tools/`，都从它下面漏了过去。

这是本期第二次遇到同一个形状。上一次是「检查器自己没有被检查」；
这一次更精确：**守卫声称的性质比它实际查的范围宽**。
一条写得很好、注释很完备、当初确实由真实失败逼出来的守卫，
可以因为 pathspec 写窄了一格而对同类问题完全无感 ——
而且它一直是绿的，所以没有任何信号。

#### 修法

范围扩到全仓库 `*.sh`，排除 `docker/`（那些或被 `.` source，或拷进镜像后由各自
Dockerfile 的 `RUN chmod +x` 兜住），`_` 前缀的反向断言保留。
然后 `git update-index --chmod=+x` 那两个文件。

**变红检查不需要注入**：扩范围之后它当场红在恰好那两个真缺陷上，
修完转绿。单元测试数不变（1536）—— 改的是既有那条的作用域，没有新增断言，
这一点值得如实写出来，否则「又加了一条守卫」会显得比实际做的更多。

#### 顺带

`tests/e2e/vm-alloc-drift.test.sh` 被 `blockchain/genesis/README.md` 引用，
但 `git ls-files -- '*.sh'` 里没有它 —— 那是一处过期引用，与本条无关，记下待查。

### V-56 第七台机器上的三个连环问题：报错指错方向、身份不能推断、以及一个会把机器卡死的收尾（2026-09-21）

ubuntu-5 上跑 `gen-node-keys.sh 7`，一共暴露出三件事。**它们都只在一台陌生的
新机器上才显形** —— 而这个脚本的全部用途就是在陌生的新机器上跑第一次。

#### 一、报错指向 avalanchego，而 avalanchego 根本没被启动过

第一次的现场：

```
avalanchego 没有生成 staker.crt —— 日志尾部：
tail: 无法以读模式打开 '/tmp/tmp.4SID6KZXSx/avago.log': 没有那个文件或目录
```

连 `avago.log` 都不存在 —— 那个重定向在 avalanchego 启动之前就失败了。
根因是 `docker run` 整条带着 `>/dev/null 2>&1`，证据全扔了。
本脚本前面为「docker 不可用」与「镜像不存在」写了整段分辨（那一条也是实测逼出来的），
**这一步却把同样的分辨丢了**。

改成三种结局各说自己：容器没跑起来（带 docker 原始输出，退出 10）／
容器跑完了但宿主看不见它写的东西（bind mount 没生效，退出 10）／
挂载通了但 avalanchego 没出日志（退出 13）。容器里同时打 `id` 与 `ls -ld /out` ——
「谁在写」与「写不进去」是两个不同的根因。

#### 二、容器该以什么身份跑，两种 docker 装法要的**恰好相反**

改完之后的现场，根因立刻出来了：

```
uid=1000 gid=1000 groups=1000
sh: 4: cannot create /out/mount-check: Permission denied
```

容器以 uid 1000 跑起来了，却写不进 `mktemp -d` 建出来的、属主为 uid 1000、
mode 700 的目录。普通 rootful docker 下这不可能 —— 除非 uid 被命名空间重映射
（rootless daemon，或 daemon 开了 `userns-remap`），那时容器里的 1000
在宿主侧是另一个 subuid。

而 `--user` 这个参数**在两种装法下的正确取值相反**：

| | 带 `--user` | 不带 |
|---|---|---|
| rootful | 对：文件属主是调用者 | 错：属主 root，后面 `cp` 读不出来 |
| rootless / userns-remap | 错：写不进宿主目录 | 对：容器 root 映射到本用户 |

所以**现场探一次再定**，不靠推断。判据是**往返**的：容器写得进去，
而且宿主读得回来、删得掉。只验「容器写成功」会漏掉 userns-remap ——
那时容器写得很好，而文件属主是宿主读不了的 subuid，
失败会推迟到 `cp` 那一步才暴露，而那已经在密钥生成之后了。

#### 三、最严重的一条：收尾里有一句会把机器卡死的命令

用桩在 win-1 上走**完整成功路径**时撞到（前两条都是在 ubuntu-5 上，这条不是）：

```
ADDR="$(hostname -I 2>/dev/null | awk '{print $1}')"
```

`2>/dev/null` 只吞掉 stderr，而 `set -o pipefail` 让 `hostname -I` 的非零状态
成为整个管道的状态，`set -e` 于是把脚本打掉 —— **就在 `cp` 之后**。

后果不是"少一行地址注记"：

1. 密钥已经生成并拷进 `keyDir`
2. 公开材料**一个字没打印**
3. 重跑被上面那条「`staker.key` 已存在 —— **不覆盖**」拦住

机器卡在一个既没拿到材料、又不能重来的状态，只能手工移走目录、重新生成一份身份。
而 Linux 上 `hostname -I` 好用，所以这条可以一直躺着不响。

修法有两层：地址取不到就留空（再退一步试 `ip -4 -o addr`），并写明原则 ——
**密钥一旦落盘，任何事都不许阻止那段公开材料被打印出来**。

#### 顺带：一句朝错误方向的提示

「两种身份都不通」那一支原先无条件劝人去设 `KARMACHAIN_WORKDIR`。
用桩验出口时当场看到：**已经设过它还失败时，它仍在劝你去设它**。
改成按是否已设分开说 —— 已设的那一支转而指向 daemon 的挂载/映射本身，
并指出若是远程 daemon，密钥必须在它所在的那台机器上生成。

#### 验证方式

win-1 没装 `jq`，真脚本跑不到这些行，所以用 PATH 前置的 `docker`/`jq` 桩
把四种情形各跑一遍：`rootful` → 退出 0 并打印材料；`remap` → 提示后退出 0 并打印；
`neither` → 退出 10 并给出出口；`KARMACHAIN_WORKDIR` 已设 → 提示改口。
失败路径都在 `mkdir keyDir` 之前退出，不会留下半个密钥目录（已核对仓库未被污染）。
**只做 `bash -n` 是不够的** —— 前两条缺陷都在语法上完全正确。

#### 根因确认：daemon 是 snap 装的（同日追加）

上面「两种身份都不通」那一支真的出现了，于是把两件事分开测：

```
$ docker run --rm --entrypoint sh -v "$D:/out" karmachain/node:local \
    -c 'id; (echo hello > /out/x && echo 容器写成功) || echo 容器写失败; ls -la /out'
uid=0(root) gid=0(root) groups=0(root)
→ 容器写成功
-rw-r--r-- 1 root root    6 Sep 21 15:22 x

$ ls -la "$D"          # 宿主
drwx------  2 azmy azmy 4096  9月 22 00:22 .
drwxrwxrwt 21 root root 4096  9月 22 00:22 ..     ← **空的**
```

容器那一侧写成功、文件也在；宿主这一侧什么都没有。**挂载根本没生效。**

```
$ snap list | grep docker
docker    29.8.0    3613    latest/stable    canonical**
$ docker info -f '{{.DockerRootDir}}'
/var/snap/docker/common/var-lib-docker
```

**daemon 是 snap 装的**，严格约束挂不了 `$HOME` 之外的路径。`-v /tmp/tmp.XXXX:/out`
被静默换成一个容器侧的空目录、属主 root —— 这一次解释了前面两次的全部现象：

| 身份 | 现象 | 为什么 |
|---|---|---|
| 带 `--user 1000` | `cannot create /out/mount-check: Permission denied` | 以 uid 1000 写一个属主 root 的目录 |
| 不带（容器 root） | 写成功，宿主看不到 | 写进了容器自己那一侧 |

而 `which -a docker` 第一个是 `/usr/bin/docker`（apt 装的**客户端**），它连的却是
snap 的 daemon。**客户端与服务端来自两套装法** —— 所以 `docker build` 一切正常，
镜像摘要还与 win-1 逐字相同，只有 bind mount 会露馅。

修法不是再加一条提示，而是**换掉默认值**：工作目录默认放 `$HOME`（两种装法都能挂），
`KARMACHAIN_WORKDIR` 仍作为出口。同时让失败分支从 `DockerRootDir` 认出 snap 并**直接点名**，
不再让人从三种成因里自己猜 —— 顺带提醒仓库也必须在 `$HOME` 之下，否则起节点时同一个问题会再来。

**这条留给后面的账**：ubuntu-5 上 `docker compose` 未必可用 ——
apt 的 `docker.io` 不带 compose v2 插件。起 l1-7 之前要先确认，
`docker compose version` 不通就装 `docker-compose-v2`（或改用 snap 的 `docker.compose`）。

四种情形都用桩验过：snap 点名 / 非 snap 泛化提示 / 已设 WORKDIR 时转向 daemon 本身 /
成功路径工作目录落在 `$HOME` 下并退出 0。

### V-57 `devnet-start` 的就绪判据静默依赖 curl —— 缺包被报成"链未就绪"（2026-09-22）

l1-7 在 ubuntu-5 上起来了，而 `devnet-start.sh` **连续两次**报：

```
devnet-start: FAILED [category: node] 300s 内未就绪（KARMACHAIN_STARTUP_TIMEOUT）
  l1-7: healthy — serving L1 at height 1606

  跨机形态：声明了 7 个等权验证者，发起查询需已连接权重 >= 75%，
  因此至少 6 个在线，链才推得动、RPC 才会应答。
  分批启动时先起来的机器必然走到这里 —— 把其余边界起完，再对本机重跑一次…
```

**它自己下一行就说了节点 healthy、在 1606 高度服务。** 而那段解释指向法定人数与分批启动 ——
当时其余六个验证者全部在线、链在出块（soak 每 30 秒一笔都在确认）。

#### 我的第一次判断也是错的

我先说这是"超时卡边"（从零同步 1558 个区块超过了 300 秒）。**第二次运行同样失败**，
证伪了它：这是确定性的，与时间无关。

#### 从外部测，把范围压到一处

```
从 win-1 问 ubuntu-5 的代理：
  http://192.168.1.32:8545/ext/bc/karmachain/rpc → {"jsonrpc":"2.0","id":1,"result":"0x4edd"}
```

代理**好的**，节点**好的**，链**好的**。于是失败只可能在**发起请求的那一端**。

```sh
RPC="http://127.0.0.1:${KARMACHAIN_RPC_PORT}${KARMACHAIN_RPC_PATH}"
got="$(curl -s -m 5 ... "$RPC" 2>/dev/null | sed -n '…')"
```

整个就绪判据压在 `curl` 上，而每处调用都带 `2>/dev/null`。
**ubuntu-5 上没有 curl** —— 那台机器按 `apt-get install docker.io jq git` 装的，
Ubuntu Server 的精简安装不带它。于是 `chain_id()` 静默返回空字符串，
轮询永远不匹配，等满 300 秒，最后伪装成一个关于链的结论。

#### 为什么这是一个必须修的类，而不是一次运气不好

退出码 **10「前置依赖缺失」本来就在这个脚本的退出码表里**。这一路失败该走那条路。
脚本检查了 `docker`（还专门把"连不上守护进程"与"没权限"分开说，那也是实测逼出来的），
**却没检查它的判据所依赖的那个命令**。

- 一句朝错误方向的提示比没有提示更坏 —— 它让人去查链和法定人数，而真正缺的是一个包
- 而且它把"我问不到"说成了"它没就绪"：**无法测量**与**测量结果为否**是两件事，
  本仓库为这条分辨改过面板的三个谓词、改过 e2e 的创世比对（V-53），这里又是同一条

`.ps1` 那一侧没有这个洞：它用 `Invoke-RestMethod`（PowerShell 内置）。
所以这不是契约破口，是同一判据在两个平台上依赖不同 —— 而只有一侧的依赖是外部的。

#### 修法与验证

`devnet-start.sh` 在 docker 检查旁边加 `command -v curl || exit 10`，并说明缺了它的**症状**。
守卫钉的是类不是那一个文件：`用到 curl 的 scripts/*.sh 必须先检查 curl`
（挂在 `powershell-portability.test.mjs` —— 它守的正是"这些薄封装在别人的机器上跑不跑得起来"）。

两级变红检查都做了：
- 脚本级：构造一个**有 docker、没有 curl** 的 PATH 真跑一遍 → 退出 10 并说清缺依赖，
  不再等满 300 秒（`dirname` 也得用 shell shim 顶上，精简 PATH 里那个 exe 跑不起来）
- 守卫级：把那行检查改名注入 → `not ok`，还原后 9/9

### V-58 守卫在那儿，是我的流程把它绕开了 —— inode 陈旧挂载（2026-09-22）

T021 现场执行时，四台 Linux 机器 `git pull` 之后 `nginx -s reload`，
三个信号全说成功：`nginx -t` 通过、`signal process started`、入口返回 200 且 `0x4edd`。

而 `grep -c max_fails` 在容器里数出的是 **6**，不是 7。**l1-7 不在它们的 upstream 池里。**

```
宿主   blockchain/nodes/lan/rpc-proxy.conf     md5 ccca0efa…
容器内 /etc/nginx/conf.d/karmachain.conf       md5 b187e731…    ← 四台完全一样的旧内容
```

#### 这件事仓库早就记着，而且是在同一台机器上

`scripts/devnet-start.sh` 的 `warn_stale_mounts`（T020）注释写得完整：

> Docker 对**单个文件**的 bind mount 绑的是 **inode**，不是路径。而 `git pull`／重新渲染
> 都是"写临时文件 + rename"的原子替换 —— inode 变了，容器的挂载仍指向**旧 inode**……
> 而 `nginx -s reload` 打印了 `signal process started`，看着像成功 —— **重载的是旧配置**。
> **这个坑只在 Linux 宿主上存在**：Docker Desktop 按**路径**解析，替换能被看到。

2026-09-09 的实测就在 ubuntu-1 上。这次也是 ubuntu-1 先暴露。
而"只在 Linux 上存在"这条也再次兑现：**win-1 与 win-2 的容器直接看到了新文件**
（md5 与宿主逐字节相同、`grep -c` = 7），两台 Windows 一个都不用重建。
在 Windows 上开发、在 Linux 上部署 —— 正是那段注释说的最坏组合。

#### 真正的缺陷是我的流程

我给出的现场步骤是「六台**只** `git pull`，**不要跑** `devnet-start`」——
理由是保住判据④（既有容器不重启）。而 `warn_stale_mounts` 就长在 `devnet-start` 里，
并且**刻意放在幂等分支之前**，注释还专门写了为什么：

> 否则"已在运行"时直接 exit 0，而那恰好是最需要提醒的情形：
> `git pull` 之后跑一次 devnet-start，它说"无需操作"，你就以为新配置生效了。

**我为了一条判据，把专门为这条路写的检查从路径上摘掉了。**
补跑 `devnet-start` 之后它一字不差地报了出来，并给出确切的、已填好本机路径的修法。

#### 这是本期第三次同一形状，三次都不是"没有守卫"

| | 形状 |
|---|---|
| V-55 | 守卫**声称的性质**比它实际查的范围宽（pathspec 只写了 `scripts/`） |
| V-57 | 判据**依赖的外部命令**没有被检查（缺 curl 报成"链未就绪"） |
| V-58 | 守卫在那儿、位置也对，**是执行流程绕开了它** |

前两条改代码能修。第三条改代码修不了 —— 它说明**现场步骤本身需要被审**：
一条"为了保住判据而跳过某个命令"的指令，必须同时说清那个命令里还带着什么别的判定。

#### 修法与代价

`docker compose -f <compose> up -d --force-recreate rpc` —— 仓库给的这条修法**范围是对的**。
我先担心带服务名时 `depends_on` 会把节点也重建掉、当场作废判据④，用 `--dry-run` 验了：

```
不带 --no-deps：  karmachain-l1-1 Running        ← 只报状态，未重建
                  karmachain-rpc-win-1 Recreate  ← 只有代理
```

**担心不成立**（Compose 5.5.1），`--no-deps` 加不加都行。四台执行后实测印证：
`l1-3`/`primary-1`、`l1-4`/`primary-2`、`l1-5`、`l1-6` 的时刻全部逐字符不变。

代价量出来了：重建一台的代理，**它自己的入口不可用数秒**
（ubuntu-2 实测 4 秒 `ECONNREFUSED`；ubuntu-3/ubuntu-4 的重建只花 1.1/0.7 秒，
短于 2 秒采样间隔，**未采到失败 ≠ 无中断**）。链与其余六个入口全程无感。

#### 一条可以考虑的根治（未做）

把代理的挂载从**单文件**改成**目录**（`blockchain/nodes/lan/:/etc/nginx/karmachain/:ro`
再在容器内 include），inode 替换就不再有影响。代价是改生成的 compose 与 nginx 配置布局，
且**这一次改动本身**需要重建一次所有代理容器。留作后续 —— 本条先把现象与修法钉住。

### V-59 l1-7 注册上链：四步全过，并撞出第四处「手写的数会过期」（2026-09-22）

T021 结束时链上 6 / 声明 7。走 ACP-77 四步把 l1-7 注册完。

#### 四步的实际数字

| 步 | 结果 |
|---|---|
| ① `initiateValidatorRegistration` | 区块 1681，validationID `0x232a22a9…`，权重 100（与既有成员一致） |
| ② Warp 聚合（不写链） | 4/6 签名，66% ≥ 门槛 56% |
| ③ P 链 `RegisterL1ValidatorTx` | 先推进一格，再提交 `MFDjgJUUSu6…`，花 0.1 AVAX 余额 + 46870 nAVAX 手续费 |
| ④ `completeValidatorRegistration` | 区块 1682，交易 `0xf0074cf4…` |

结果：**链上 7 / 声明 7，零漂移**，`membership:status` 报"两侧一致"，
`devnet-verify` 14/14 READY（`9/9 nodes serving`、`7/7 validators bootstrapped`）。

#### V-44 那条滞后在真实操作里又出现了一次，而且工具说得比我清楚

第三步干跑时工具拦下来：

```
当前集合    高度 19：6 个，合计权重 600
验证用集合  高度 18：5 个，合计权重 500
→ 位图按当前 6 个编号，而链按 5 个验，聚合公钥对不上
  （实测：4 个报权重不够，5 个报 signature is invalid）
```

带 `--nudge` 后一步到位：

```
✓ 交易 LjM7qCFvGgg…，手续费 8140 nAVAX
✓ 高度 19 → 20，验证分母 500 → 600
✓ 门槛降到 67%，要 5/6 个签名
  签名者 5/6（83%）
```

**顺带解掉一个我原以为是问题的现象**：推进之前只聚到 4/6，我担心是聚合器联不上
l1-2 与 l1-4。推进之后聚到 5/6，而**没签的换成了 l1-1** ——
所以它是"**达到门槛就停**"，不是可达性问题。差点因此多查一轮。

#### 第四处「手写的数会过期」，而这一处在**工具输出**里

第四步的提示说：

```
**这一步做完，成员才算真正生效** …… （n 从 5 到 6，可离线数仍是 1，见 F-5）
```

实际是 **6 → 7**。而**同一次运行的开头那句是算出来的**（`容错：n = 6 → 7，可离线数 1 → 1`）——
只有这一行写死。一处算对、一处写死并列时，**过期的那处看起来同样权威**。

本期第四次撞上这个类，前三次都在文档里：

| | 写着 | 实际 |
|---|---|---|
| `protocol-rationale.json` 的 `validators.count` 理由（V-54） | 5 | 6（加第七台后 7） |
| `lan.description`「5 台独立物理机」 | 5 台 | 6 台（现在 7） |
| dod 摘要「剩下那 8 条」 | 8 | 7（6 ⚠ + 1 ❌） |
| **add-validator 第四步提示** | n 从 5 到 6 | **n 从 6 到 7** |

**只有这一处在工具输出里 —— 而工具输出正是操作者当场据以决策的东西。**
文档过期要读者去核；工具输出过期，人会直接信。

修法是复用上面已经算好的 `t`，不另算。守卫加在
`membership-presentation.test.mjs`（它管的正是"呈现"）：剥掉注释行之后，
`add-validator.mjs` 与 `remove-validator.mjs` 的输出里不许出现
`n 从 <数> 到 <数>` / `n = <数> → <数>` 这样的字面量。注释里的引述保留 ——
它记录了曾经是什么。变红检查：注入写死的那句 → `not ok` 并点出行号与原文，还原后 37/37。

**一句限定**：第四步已经走完，新文案我**没法再跑一次**去看实际输出。
但那几个字段正是同一次运行开头那句用的，而它打出的 `n = 6 → 7` 是对的 ——
字段名由那次运行证实，文案的拼接由 `node --check` 与守卫覆盖。这不等于"看它打印过一次"。

#### F-5 第一次拿到 n=7 的链上证据

`devnet-verify`：`7/7 validators online, tolerance 1 (75% query threshold), full margin`。
从 5 个到 7 个，**可离线数全程是 1**。要抬到 2 必须到 n=8 —— 还差一台机器。

### V-60 面板对着一条正在出块的链宣布它停了 —— 容错的**输入**被写死成 0（2026-09-22）

注册完 l1-7 后起面板查看状态，`summaryLine` 是这样的：

```
-1/0 验证者在线（上限：可容忍 0 个离线） [注意：只观测到 7 个计入容错的验证者，基准为 0 个]
—— **超出上限**：l1-1 离线，按共识参数**推断已停止出块**（安全停摆：不分叉、区块零回滚…）
```

而**同一份快照的结构化字段**说的是另一回事：

```
tier "zero-margin" / participating 6 / threshold 6 / validatorMargin 0 / faultTolerance {7, 1}
```

即"达到门槛、余量 0、链继续出块"—— 而链确实在出块（高度 1687，几分钟前 soak 还在确认交易）。
**文案与它自己的字段互相矛盾，而文案是人真正会读的那一行。**

#### 根因：一处写死

```js
// tools/dashboard/poll.mjs:227
summaryLine: summarize(rows, { validatorCount: 0, maxOfflineValidators: 0 }).line,
```

`summarize()` 用 `total = validatorCount`、`max = maxOfflineValidators` 算：

| 表达式 | 传 0 时 | 症状 |
|---|---|---|
| `online = total - offline.length` | `0 - 1 = -1` | `-1/0 验证者在线` |
| `withinTolerance = offline.length <= max` | `1 <= 0` → 假 | `超出上限…推断已停止出块` |
| `counted.length !== total` | `7 !== 0` → 真 | `基准为 0 个` |

全部症状都由这一处解释。注释写的用意是"原样保留既有 summarize 的那句话，
**供人对照面板的档位是否与它一致**"——而传 0 之后，那句话与档位**永远**不一致。
一个为了对照而存在的东西，自己是错的。

#### 同一个函数，`node-status` 喂对了、面板喂了 0

`tools/inspect/node-status.mjs:540` 调的是 `summarize(scoped.rows, scoped.faultTolerance, …)`
—— 按 P 链收窄过的那份，旁边还记着"退回声明是 V-31 那个假警报的成因"。
所以判据本身是对的，错的只是面板这一路的**入参**。

#### 为什么它长期不响

`pollOnce()` 这一层**拿不到**容错基准：n 要取 P 链上带权重的成员数，
而那是 `buildSnapshot()` 里 `scopeToChainMembers()` 才算出来的。
写死 0 是"先让它编译过去"的痕迹，而它产出的是一句**语法正确、语义完全错误**的话。

修法不是把 0 换成 `ctx.faultTolerance`（那是**声明**侧的数，V-31 的假警报正是退回声明造成的），
而是**让文案与字段同源**：在 `server.mjs` 里用**快照自己的** `faultTolerance` 与 `nodes` 算它。
修后实测：

```
6/7 验证者在线（上限：可容忍 1 个离线） —— 链继续出块，但**余量为 0**：再有一个验证者离线即停摆
```

与 `tier=zero-margin`、`participating 6/threshold 6`、`margin 0` 一致。

#### 守卫在那儿，作用域第三次比它声称的性质窄

`tests/unit/dashboard-no-hardcode.test.mjs` 的标题就是「面板内不得写死档位阈值」，
而它的 `FORBIDDEN` 只列了 `0.75 / 75 / 80 / 60` —— **百分比阈值**。
这次写死的是档位判定的**输入**，落在模式之外。
而且它更严重：阈值写死要等 n 变了才错，输入写死是**一直**错。

已加规则 `/(?:validatorCount|maxOfflineValidators)\s*:\s*\d/`，
全仓扫描**零假阳性**（唯一命中就是那个缺陷）。变红检查：把那句塞回 `poll.mjs`
→ 守卫点出 `poll.mjs:198` 与原文；还原后 13/13。

#### 顺带：这道守卫自己的变红检查有一条一直在空转

自检那节写的是：

```js
for (const { re, why } of FORBIDDEN) {
  if (!re.test(stripNonCode(bad))) continue;      // ← 没有样本就静默跳过
```

而 `bad` 样本里 **没有 60** —— 于是 `/\b60\b/` 那条规则的变红检查**从未真的跑过**。
一条"没配样本"的规则被无声放过，正是本仓库反复栽的那个坑的元层版本：
**检查器的检查器也会空转**。已补齐样本并把 `continue` 换成断言 ——
从此"没有样本"本身就是失败。

#### 这一条真实存在的告警不是虚警

`notParticipatingIds: ["l1-1"]` 是**对的**。实测：l1-1 只有 4 个对等
（两个 Primary + l1-7 + 本机聚合器），而 l1-2/l1-5 也看不见它 —— 双向断开。
其余 6 个互相连通 = 6/7 = 85.7% ≥ 75%，所以链照常出块，l1-1 也经 l1-7 与 Primary 收到区块、
高度一致。**但余量为 0：再掉一个就停。**

l1-1 的日志显示这在 win-1 上**一整天都在反复**（09:49、10:17、11:08、13:53、
13:57 一度 0 个对等、14:01、17:15、20:07、20:11），与注册无关。
avalanchego 自己的健康检查要求 80% 连接权重，而节点的 `healthcheck.sh` 判的是
"在服务、高度对" —— 两者分歧正是面板补上的那一格。

### V-61 聚合器的就绪判据在最需要它的时刻是空的，而"空"不是 0（2026-09-22）

Docker daemon 在 win-1 上重启，把两个带 `--rm` 的容器清掉了 ——
面板与**签名聚合器**。重起聚合器时顺手把 V-48 那条判据真正走了一遍。

#### `/health` 依旧在 20 秒就说 `up`

V-48 说过它不是就绪信号。这次复现得很干净：t=20/40/60/90 秒四次采样，全是 `up`。

#### 而文档给的那条真判据，此刻**是空的**

```
$ grep connected_stake <8647 的 metrics>
signature_aggregator_failures_to_connect_to_sufficient_stake 0
```

只有那个失败计数器。`signature_aggregator_connected_stake_weight_percentage`
**根本不存在** —— 那条带 `subnetID` 标签的指标要到**首次聚合之后**才出现。

而 `docs/devnet.md` 的示例写着 `… 100`，紧接着说"只有它**长期停在 0** 才去查那个配置"。
于是照文档做的人在刚起来时看到**空输出**，而文档预设的两种情形（100 或 0）都不是空。
**把空当成 0 会把人推去查 `allow-private-ips`** —— 而那时根本还没有任何证据指向配置。
这是"无法测量 ≠ 测量结果为否"在本期的第四次现身
（面板的三个谓词、e2e 的创世比对 V-53、devnet-start 缺 curl 的 V-57，加这一条）。

#### 随时可用的判据：真聚合一次、数签名者

聚合**不写链、可无代价重做** —— 工具自己的注释就是这么解释第二步为什么能随时重试的。
所以拿 l1-7 那条已完成注册的 validationID 构造确认消息，交给聚合器：

```
未签消息 95 字节，签名集合 2W9boARgCWL25z…
✅ 聚合成功：5 个签名者，耗时 545ms       # 7 个等权成员、门槛 67% → 需要 5 个
```

**然后**指标才出现：

```
signature_aggregator_connected_stake_weight_percentage{subnetID="2W9boARg…"} 100
signature_aggregator_failures_to_connect_to_sufficient_stake 1
```

**先有可用的证据，后有指标 —— 顺序是反的。**
（那个失败计数器从 0 变成 1：聚合总体成功了，但其中某一轮失败过。
所以它也不是"有没有问题"的判据，只是一个累计值。）

#### 两处修

1. 文档的 `docker run` 只发布 8646，而 `aggregatorConnectedStake()` 走的是**宿主**的
   8647 —— 于是那条代码路径在按文档启动时永远返回 null，
   它的错误分支也只能打出"（读不到聚合器的连通性指标 —— 端口 8647 没发布…）"。
   加上 `-p 8647:8647`，那句诊断就能真的报出数字。
2. 文档补上"指标不存在 ≠ 为 0"，并把"真聚合一次"写成随时可用的那条判据。

#### 顺带记下 daemon 重启的影响面

`karmachain-l1-1` 与 `karmachain-rpc-win-1` 的 `StartedAt` **相差 13 毫秒** ——
这是判断"重启的是 daemon 而不是某个容器"的依据（单独 `docker restart` 一个节点
不会碰同机的代理）。两者 `Created` 未变，是重启不是重建。
而**按需容器（`--rm`）会消失**：面板与聚合器都得手动起回来。
聚合器只在增删成员时需要，日常出块与 RPC 不依赖它 —— 但要记得它不会自己回来。

### V-62 「故障扩散了」这个结论现在被求证过了（2026-09-22）

dod 第六节第 27 条① 的待办：2026-09-19 的 SC-003 三十分钟窗口里，
**30 笔交易全部确认**，而第 8 分钟三台不同机器同时报一次"不可达"，
整轮被判成「故障扩散了」。那条待办写得很清楚：
**把观测做到与说法一样强，不是放宽断言。**

#### 第一步只做了一半

V-53 那轮加了"3 秒后复核"，挡住了**瞬时**抖动。但挡不住**持续**的观测方问题 ——
路径坏五秒，两次探测都失败，照样宣布扩散。而 004 那条判据本来就是两半：

> 本机探不到 **且** 其余节点的对等列表里也没有，才算它真的缺席；
> 只是本机探不到的，是本机到它的路径问题，链里还有它。

#### 补上求证那一半，四路分开

复核之后向**还在服务的那些节点**求证（证人），看它们的对等列表里有没有可疑对象：

| 求证结果 | 处置 |
|---|---|
| 证人**看得见**它 | 诊断，**不算失败** —— 观测方到它的路径问题 |
| 证人**也看不见** | **失败**：这才是故障扩散 |
| 一个证人都没有 | **失败**，但报的是"全部验证者都不在服务"——那不是求证不了，是真的全倒了 |
| 拿不到它的 NodeID | 诊断，**求证不了就不宣布扩散** |

最后一路是刻意的：「故障扩散」是很重的结论，**求证不了不等于确认**。
把不确定当成定论正是这条 e2e 原先的毛病。
不可达的节点探不到自报 NodeID，所以回落到生成物里声明的那个
（`expectedNodeId`，面板同一做法 —— 为此把它从 `node-status.mjs` 导出，没有复制第二份）。

诊断走 `onNote`，默认打到 stderr 并以 `#` 开头（TAP 当注释）——
**调用方没传也看得见**，不会被静默丢掉。这一点要紧：调用方是
`failures.push(...await spreadProblems(...))`，返回什么都算失败，
所以"不是扩散"的那两类必须走另一条出口，而不是塞进返回值。

#### 为可测加了注入点，因为这四路判定原先无法单测

`spreadProblems` 内部直接调 `validatorsServing`。加一个 `probe` 参数（默认就是它），
于是四路各有一条单测（`e2e-spread-corroboration.test.mjs`，7 条）。
**这四路判定是那个函数的全部价值，而它原先一条测试都没有** ——
又是"存在而不会变红"。

变红检查：把求证一步废掉（`seenByPeers.has(id)` 恒假）→ 第一条立刻红，还原后 7/7。

#### 顺带：一条既有守卫的**前提**被我改过期了，修前提而不是放宽它

`one-read-is-not-a-verdict.test.mjs` 断言源码里出现两次
`await validatorsServing(excludeIds)`。改名成 `probe(excludeIds)` 之后它红了 ——
**行为没变，是它的前提过期了**。所以改前提。

但更要紧的是：那条是**文本**匹配，它只能证明"写着两次"，数不出真的调了几次。
有了注入点就能真数 —— 新测试里加了一条用计数 `probe` 的行为断言（`calls === 2`）。
两条一起才算把这条性质守住：文本那条守"写法没被改掉"，行为那条守"真的发生了"。

#### SC-015 还差什么，如实写出来

第 26、27 条至此全部修完。但 SC-015 说的是
"002/003/004 的**全部**判据保持通过"—— 那要跑一遍完整 e2e，
而它是**破坏性的**（会真打掉节点，第 26 条记着我为此栽过一次）。
所以挡住 SC-015 的只剩这一次运行，需要挑一个能承受的时间窗并事先说明，不能顺手跑。

另外把那一格里"逐类可核 ——"后面**什么都没有**的悬空承诺补实了：
本轮的逐次记录散在 V-34…V-62 与各次提交说明里，本表不复述。

### V-63 n 第一次跨过 ⌊n/4⌋ 的台阶，四条测试当场作废 —— 其中一条从未测过它名字说的事（2026-09-22）

加第 8 台机器（`ubuntu-6` / `l1-8` / 192.168.1.33）之后，**这是本期第一次**
`maxOfflineValidators` 真的变了：

```
-KARMACHAIN_MAX_OFFLINE_VALIDATORS=1
+KARMACHAIN_MAX_OFFLINE_VALIDATORS=2
```

n=5→6→7 三次加机器它都是 1（⌊n/4⌋），到 8 才成 2。而这一跨把**四条测试**打红了，
全部不是产品缺陷 —— 是夹具**绑在 f=1 上**。

#### 一条从未测过它名字说的那件事

```js
test('f ≤ ⌊n/4⌋：n=5 时可容忍 1 个', () => {
  assert.equal(deriveTopology(BASE).faultTolerance.maxOfflineValidators, 1);
});
```

名字说 n=5，断言读的是**活的声明**。声明从 5 长到 6、7 时它一直绿 ——
因为 ⌊6/4⌋ 与 ⌊7/4⌋ 恰好也等于 1。**它的绿色来自巧合，不是正确。**
到第 8 个才暴露。改成断言 `⌊n/4⌋` 并改名；n=4…12 的整张表另有
`fault-tolerance-range` 守着，那条是"定义式 vs 表、两边各算一次"。

#### 另外三条：越界的份量也必须派生

| 测试 | 原先的假定 | 修法 |
|---|---|---|
| T-5 违规消息（topology） | 写死"2 个 > 上限 1"，且只枚举 l1-1…l1-5 | 取 `limit+1` 个验证者，并用 `restDomains` 安置其余 |
| 共享失效因素告警（topology） | 两个边界各 1 个、合计 2 才越界 | 合并组取 `limit+1` 个 |
| FR-013 拦下（preflight） | 固定"并两个边界" | 一直并下去，直到真的越界 |

第一条同时被两件事打红：上限变了**以及** l1-6/7/8 落在边界外触发 T-4。
本文件开头早就记过第二类（"2026-09-14 加第六个验证者时六条断言同时红"），
这次补上第一类：**上限本身也要派生，否则 n 每跨过一个 4 的倍数就废一次。**

#### 有一条自检救了场

preflight 那条里写着：

```js
assert.equal(ft.declaredWithinLimit, false, '构造没有真的违反 T-5 —— 用例失去意义');
```

它让一个**失去意义的用例变红**，而不是悄悄变成恒真 —— 否则"塞两个进同一边界仍被拦下"
会在上限变成 2 之后静默通过，而它测的东西已经不存在了。
**这正是本期反复说的那件事的正面例子**：先断言"构造真的违规"，再断言"它被拦下"。

#### 我的红检第一版设计错了，记下来

我先想"把声明临时推到 n=12 与降到 n=5，两个文件必须照样绿"。
结果两轮各红十几条 —— 因为伪造的验证者**没有 identity 制品**、链身份里也没有它们，
于是 preflight 的基线、`readInventory`、有效边界等等全被连带打破。
**那些红大部分是附带损害，分辨不出我关心的性质。**

换成能隔离的工具：把三处派生改回写死 `1`（preflight 那条改回假定上限 1）——
恰好那 4 条红，还原后 36/36。判据要能**只对被测性质变红**，否则读不出结论。

### V-64 新机器上的 READY 说的是"入口通了"，不是"本机的节点好了"（2026-09-22）

第八台（ubuntu-6 / l1-8）起节点，`devnet-start` **4 秒**就打印：

```
KarmaChain is READY   (deployment lan, failure domain ubuntu-6, 4s)
  Height    : 0x6a3
  容错      : 2 个验证者可离线（按声明的 8 个算）
```

l1-8 确实好了（直接问它：`isBootstrapped: true`、高度 1701、9 个对等）。
**但那是我直接问它才知道的，不是这条横幅证明的。**

就绪判据问的是 `127.0.0.1:<入口端口>` —— **本机的代理**，而它的 upstream 里有
**全部八个**节点，nginx 轮询。所以那一声应答很可能来自 win-1 上的 l1-1。
反过来说：**l1-8 若压根没同步成功，这里照样会打印 `READY (failure domain ubuntu-6)`。**

在一条以"加机器"为主题的特性里，新机器上最该确认的恰恰是这一条。
而脚本的**失败**分支里本来就有"问本机节点自己"的能力
（上次 l1-7 那轮它打出过 `l1-7: healthy — serving L1 at height 1585`）——
成功分支却没用它。

#### 修法：只报不拦

把本机节点自己的判断（`healthcheck --state`，与失败分支同一路径，不重算第二份逻辑）
打进 READY 横幅：

```
  本机节点  : （自报，与上面那条入口应答是两件事）
              l1-1: healthy — serving L1 at height 1707
```

**刻意不阻断 READY** —— 沿用既有教训："打在正常路径上的诊断守卫必须保守"。
分批启动时本机节点可能仍在引导，那不是故障；问不到就说"问不到自报状态"，
而不是把 READY 变成失败。

#### 顺带补上一处 `.sh` / `.ps1` 的既有差异

`.sh` 的横幅注明「按声明的 N 个算」并指向 `membership:status`；
**`.ps1` 只打印数字、没有这两句限定**。于是两台 Windows 边界上看到的是
一个**没有限定的乐观数字** —— 而此刻它恰好偏乐观：声明 8 个给出"可离线 2"，
而链上只有 7 个成员、真实可离线数是 1。已对齐（属 .sh/.ps1 等价契约）。

PowerShell 那一侧不套 `sh -c` 里再套 jq 的转义（5.1 上那层嵌套引号很容易出错），
改为直接调容器里的 healthcheck 拿 JSON、在 PowerShell 侧 `ConvertFrom-Json`。

#### 验证

- `.sh` 那段循环单独跑过：只列出本机真有的容器（win-1 上只有 l1-1），远端全部跳过
- `.ps1` 那段在真 PowerShell 里跑过，输出同形
- `powershell-51-parses` 这一轮 `skipped 0` —— 它**显式用 `powershell.exe`**、
  拒绝 `pwsh`，并且里面还有一条「**确认用的确实是 5.1 那一支**（用 7.x 验等于没验）」。
  **守卫检查了自己的量具** —— 这是本期少见的正面例子，记下来。

### V-65 T042 —— 本期第一次 f 真的提升，也第一次真的下降（2026-09-22）

F-5 那张表（`f = ⌊n/4⌋`）从 002 起就写在规格里，而**这条链上它一直是 1**：
n=5、6、7 三次加机器，可离线数一次都没动。T042 要的正是它第一次动的那一刻。

#### 加第八台：f 第一次从 1 变 2

`ubuntu-6` / `l1-8`（192.168.1.33）注册上链，四步的数字：

| 步 | 结果 |
|---|---|
| ① | 区块 1749，validationID `0x175a2f6f…` |
| ② | 聚合 5/7（71% ≥ 门槛 58%），不写链 |
| ③ | 先推进一格（`s9r1C9jjv4z…` 之前那笔，手续费 5179 nAVAX，高度 21 → 22，验证分母 600 → 700），再提交，花 0.1 AVAX + 46870 nAVAX |
| ④ | 区块 1751 |

两侧一致（P 链 8 / 合约 8、零漂移），`devnet-verify` 14/14：

```
[OK] fault-tolerance   8/8 validators online, tolerance 2 (75% query threshold), full margin
```

而工具在第一步就把这件事说出来了 —— **本期第一次说"提高了"**：

```
容错：n = 7 → 8，可离线数 1 → 2（**提高了**）
```

前七次它说的都是"没有变化 —— 加这个成员买不到任何容错提升，见 F-5"。
**同一句判定，两个方向都验过了。**

顺带印证 V-59 那处修：第四步的提示现在打出 `n 7 → 8，可离线数 1 → 2`，
而它原先是写死的「n 从 5 到 6」。改成复用算好的 `t` 之后，第一次在真实运行里
落在**不同于写死值**的数上 —— 如果没改，这里会显示 5 → 6，而实际是 7 → 8。

#### 然后在 n=8 上执行退出：f 第一次真的下降

```
这次退出的代价：n = 8 → 7，可离线数 2 → 1（**下降了**）
  可离线数下降意味着：退出之后，这条链能承受的同时离线数变少了。

知道这个代价，继续？ [y/N]
（标准输入已关闭 —— 按「否」处理，链未改动）
已中止 —— 链未改动。                                退出码 32
```

三项判据齐了：打印 `2 → 1`、要求确认、拒绝时零链上改动。

**"链未改动"这句话本身不是证据**，所以去核了：链上成员仍 8 / 声明 8、零漂移、
P 链侧 8 与合约侧 8 两侧一致、**合约事件里没有任何退出相关事件**、
容错仍报"可容忍 2 个离线，余量 2"。

#### 加入过程的四条判据（与 T021 同形，第二次成立）

| 判据 | 结果 |
|---|---|
| ① stamp 六项 | 与 T002 基线逐字节相同 |
| ② 创世哈希 | 从链上取，逐字符相同 |
| ③ 零个退出 12 | `l1-1` RestartCount=0；其余八个既有节点 `StartedAt` 逐字符未变 ⇒ 从未退出 |
| ④ 既有节点容器 | **9/9 逐字符相同**（l1-1…l1-7 + 两个 primary），零个变化 |

30 分钟 soak：**61/61 全部确认、零次 5xx、零 busy、零迟到**，覆盖八台 `git pull`、
l1-8 从零入网、五台代理重建、以及整个四步注册。

代价如实记：五台 Linux 的**代理**容器被重建（inode，V-58），
两台 Windows 只需 reload（Docker Desktop 按路径解析，V-58 里那条"只在 Linux 上存在"
第三次兑现）。代理不是节点容器，不在判据④ 范围内。

#### 一处我自己的分类错，记下来

做 diff 的脚本里 `isNode()` 写成"不是 `rpc-` 前缀、不是 aggregator"就算节点 ——
于是 `karmachain-dashboard` 被算进"节点容器"，报成了 10 个。
它确实也没变，但它不是节点。**判据的措辞是"既有节点容器"，那 10 这个数就是错的**，
准确的是 **9**。一次性脚本也会把判据算错，而错法是**把范围放宽**。

### V-66 完整 e2e 第一次真跑：10 条失败，没有一条是产品缺陷（2026-09-23）

52 条断言、42 通过、10 失败（21 个套件，4 个带理由跳过）。
链完好：创世哈希不变，高度 1756 → 1851 全程出块，成员 8/8 两侧一致。

#### 失败分三类

**A 类 · 前提被破坏。** 开跑时 `l1-2`（win-2）就已经卡在起始高度 1756、只剩 3 个对等
（`isBootstrapped: true`，进程好好的 —— 与 V-60 里 l1-1 那次同一形状，两台都是 Windows）。
于是第 13 条停掉 win-1 整个边界时，链上同时缺了两个：**6/8 = 75%，正好卡在查询门槛上**。
后果：两条 30 分钟窗口报 `27/30`、`28/30` 次交易未确认；
`dashboard-link-fault` 报「余量不得被虚报为 0」与「节点从未被动过」。
**四条看起来都像产品缺陷，全是回声。**

**B 类 · 断言绑在 n=7 / f=1 上。** 与 V-63 那四条单元测试同一家族，只是这次在 e2e。

**C 类 · 观测机会不存在。** SC-012 要在活链上目击 catching-up，而节点一直正常。

#### 一条测试**预先**说出了它该怎么改

`dashboard-detection` 顶上写着：

```js
assert.equal(maxOffline(served), 1,
  `现在 n = ${served}，⌊n/4⌋ = ${maxOffline(served)} —— 停 1 个不再是"用尽余量"。`
  + ' 本用例要改成停 ⌊n/4⌋ 个，或把这一档交给 dashboard-stopped-tier 那套跨机构造。');
```

它的注释解释得很清楚：**先把前提说出来，而不是让 waitForSnapshot 超时** ——
超时读起来像面板坏了，其实是用例的前提不再成立。这是本期"先断言构造成立、再断言结论"
的又一个正面例子。

但它给的第一个选项（改成停 ⌊n/4⌋ 个）会让本用例在**只承载 1 个验证者的机器上永远跳过**，
而 T-5 保证跨机形态下每台至多 1 个 —— 那等于再也不跑。
所以改成：**发现时延**这一半任意 n 都验（那才是 FR-018 的正题），
**档位与余量**按 f 派生（f=1 时仍要求 zero-margin，f>1 时要求 normal 且参与数**高于**门槛）。

#### `dashboard-idle`：断言比它声称的性质强

```js
assert.deepEqual([...percents], [100], '空闲期间百分比不得变化');
```

消息说"不得变化"，断言说"必须是 100" —— **两件事焊在了一起**。
那一轮 60 个样本全是 88%、档位全程 normal、不报警 ——
它名字里那个性质完全成立，却因为一个它没声称的条件而红。
改成断言不变性（`percents.size === 1`），并在不是 100 时**如实打一行诊断**
说明这一轮不是在满员前提下量的 —— 不满员不是失败，但读结果的人有权知道。

#### 真缺陷一个：面板容器被 `killAll()` 连带移除

`NOT_A_NODE` 是**黑名单**，排除了聚合器、漏了面板。面板是 `--rm` 起的：
杀掉即移除，`start()` 不会带它回来。

**我第一次的判断被一条通过的断言误导过**：`crash-recovery` 断言
`killed === 本机节点数 + 1 个代理`，而它是绿的，我据此一度以为面板没被杀。
查了顺序才明白：`crash-recovery-repeat`（50 轮）在它**之前**跑且**不断言数量** ——
第一轮就把面板清掉了，等 `crash-recovery` 跑到时只剩 2 个，计数自然对。
**缺陷被一条通过的断言掩盖了，因为破坏发生在断言之前的另一个套件里。**

修法不是往黑名单里补一个，而是换成**白名单**（节点 + RPC 代理，其余一律不碰）——
契约本来就是 crash-recovery 那条断言定的"节点数 + 1 个代理"。
黑名单的毛病在于**每加一个辅助容器就要有人记得去补**；白名单反过来，新容器默认安全。
守卫也从查字面量改成**行为断言**（直接问 `isKillTarget` 那个谓词）——
它原先的注释就写着"断言'提到过'，而不是断言'做了'"，而查字符串仍然是文本。

#### 补上一道姊妹前提：动手之前，链必须是满的

那把串行锁管的是"现在只有我在动节点"（V-44）。这一轮暴露出它缺一个同伴：
**"我动手之前，别人没先把它弄坏"**。两者缺一，判据都不成立。

`requireFullMargin()` 加在 12 个取锁套件的同一个 `before` 里，
并由守卫强制（凡取锁者必须也核满额）。它**停住并说清楚**，而不是跑出一份读不出结论的红。
这与"打在正常路径上的诊断守卫必须保守"不冲突 —— 那说的是正常路径，
而这里是破坏性路径的入口，它本来就该挑剔。

### V-67 第二轮 e2e：A 类归因被证实，白名单在现场验到，又挖出两处 f=1（2026-09-23）

修完 ①②③④ 之后重跑：**52 条断言，50 通过，2 失败**（第一轮是 42/10），耗时 81 分钟。

#### A 类那个归因是对的 —— 三条大用例没改一行断言就转绿

| 套件 | 第一轮 | 第二轮 |
|---|---|---|
| 场景 F —— 边界整体失效，30 分钟窗口 | ✗ 27/30 交易未确认 | **ok** |
| SC-003 —— 单验证者离线，30 分钟窗口 | ✗ 28/30 交易未确认 | **ok** |
| 场景 C —— 单个验证者挂掉 | ✗ | **ok** |
| SC-012 —— 目击 catching-up | ✗ 节点从未被动过 | **ok** |

**一行断言都没改。** 变的只是前提：l1-2 归队、链满额（8/8、余量 2）。
这证实了第一轮那个判断 —— 那几条失败是**别人的故障加上我的故障**，不是产品缺陷。

而这也正是 `requireFullMargin()` 存在的理由：**下一次前提不成立时，它会在开跑前停住**，
而不是让人对着一份读不出结论的红去猜。

#### `killAll` 白名单在现场验到了

```
动手前  /karmachain-dashboard 2026-09-23T03:01:31.07746566Z 2026-09-23T03:01:31.17831308Z
跑完后  /karmachain-dashboard 2026-09-23T03:01:31.07746566Z 2026-09-23T03:01:31.17831308Z
```

**逐字符不变。** 第一轮同一个容器被 `killAll` 移除（`--rm`，回不来），
这一轮白名单把它挡在外面。聚合器同样没动；`l1-1` 与代理照常被重建（那是它们该有的命运）。

#### 又挖出两处 f=1 硬编码 —— 而我先前把其中一条归错了类

剩下的两条失败，**都不是环境问题**：

```
dashboard-link-fault:85   assert.equal(s.validatorMargin, 1, '余量不得被虚报为 0 ——…')
dashboard-detection:158   assert.equal(s.validatorMargin, 1);            ← 裸的，连消息都没有
```

第一条我在第一轮把它归进了 **A 类（前提被破坏的回声）**。**那是错的。**
当时的证据不足以分辨：链退化时余量确实也会掉，两种成因指向同一个现象。
**是重跑把它们分开的** —— 链满额之后它照样红，而且红在同一个 `2 !== 1` 上。

这条值得记：**当两个成因能产出同一个现象时，不要在只观察到那个现象时就定性。**
我当时可以说"待分辨"，而我说的是"是回声"。

两处的共同毛病与 V-63 那四条一样：消息说的是一回事（"不得为 0"、"恢复后回到满额"），
断言写的是另一回事（`=== 1`，而 1 只是 n=5…7 时的 ⌊n/4⌋）。改成当场算 ⌊n/4⌋，
且**不取快照自己的 faultTolerance** —— 那样就成了自证，两边各算一次才有交叉验证的意义。

修完单独重跑那两个套件：**9/9 通过**。

#### 还差什么

**一次从头到尾全绿的完整运行还没发生过。** 第二轮是 50/52，两处修好之后只单独验了那两个
套件。把"两轮拼起来"当成"一轮全绿"，正是本期反复在防的那种说法 ——
所以 SC-015 要等第三轮跑完再判。

### V-68 第三轮 e2e：51/52，最后一条是"零异常"与"不产生异常"的差别（2026-09-23）

修完前两轮的全部问题后重跑：**52 条断言，51 通过，1 失败**（10 → 2 → 1）。
链完好（创世哈希不变，1979 → 2105），面板容器**第二次**逐字符不变 —— 白名单稳定生效。

#### 唯一那条失败：断言"零异常"，而性质是"不产生异常"

```
空闲不得产生异常条目，实际有 6 个样本带异常
  [{ at: 2, height: 2037, incidents: 5, percent: 100, tier: 'normal' }, …]
```

窗口开始时就带着 **5 条异常**，持续 6 个样本后清掉；其间档位 normal、百分比 100%、
高度不变 —— **空闲本身什么都没产生**，它照样红。

等待条件只等到 `tier === 'normal'`，而 normal 并不意味着异常清单已空；
上一条套件（刚杀过又起过节点）的余波还在。

修法**不是**把等待条件改成"等到零异常"——真有一条常驻异常时那会超时，
而超时读起来像面板坏了。改成**以窗口开始时的那一份为基线，断言不新增**，
已有的那些如实打一行诊断说明"这一轮是在什么前提下绿的"。

#### 同一条测试，三轮红在三个不同的地方

| 轮次 | 红在哪 | 性质 |
|---|---|---|
| 一 | `[88] !== [100]` | 断言比它声称的性质**强**（把"不得变化"和"必须是 100"焊在一起） |
| 二 | — 通过 | |
| 三 | 6 个样本带异常 | 断言比它声称的性质**强**（把"不产生"写成了"零"） |

两次是同一个毛病的两个面：**测试名说的是一回事，断言写的是另一回事。**
而第二轮之所以绿，只是因为那一轮恰好满员、恰好没有余波 —— **绿得侥幸**。

#### 它还缺一样东西：失败时说不出是什么

原先只记异常的**个数**。第三轮报"6 个样本带异常"，而那 5 条异常是什么、属哪一类、
指向哪个节点 —— 一个字都没有，无从判。现在记 `class:nodeId`。
**一条报不出细节的断言，失败时等于只告诉你"有问题"。**

#### 一处如实的限定

修完按原顺序重跑（detection → genesis-parity → idle）：11/11 通过。
但那一轮**基线是空的** —— 新加的"已有异常"那条分支没有被走到。
按逻辑它本可以挡住第三轮那次失败（5 条从第 0 个样本就在、全程无新增 → 通过），
但**那是推理不是实测**，按后者记。

#### 三轮下来的收敛与尚缺的一件事

失败数 10 → 2 → 1，三轮都不是产品缺陷。但**一次从头到尾全绿的完整运行仍未发生**：
第三轮 51/52，那一处修好之后只按顺序验了三个套件。SC-015 仍不改。

### V-69 第四轮 e2e：50/52，两条都是"观测方自己抖了一下"（2026-09-23）

四轮下来：**10 → 2 → 1 → 2**。第四轮那两条都不是产品缺陷，而且都由
**win-1 自己的网络抖动**造成 —— 今天第三次撞到同一件事。

#### 那条空闲用例：上一轮加的"记身份"当场兑现了价值

```
51485ms 出现 observation:l1-2、observation:l1-3、observation:l1-4、
        observation:primary-1、observation:primary-2      （持续约 4 秒后消失）
```

**五个节点、分布在三台不同机器上，同一瞬间一起不可达。** 三台同时挂的概率远低于
观测方抖了一下 —— 而面板把它们全归为 `observation`，那一类的含义正是
"本机连不上它，但其他节点与它有连接 —— 是本机到它的路径问题"。**面板判对了。**

若还是上一轮那版（只记个数），报出来的只会是"6 个样本带异常"，无从判。
**改成记 `class:nodeId` 的那一处，在下一轮就付清了成本。**

#### 同一条用例四轮红了三次，每次红在不同地方 —— 而三次是同一个毛病

| 轮 | 红在哪 | 断言说的 | 用例声称的 |
|---|---|---|---|
| 一 | `[88] !== [100]` | 必须是 100 | 不得**变化** |
| 三 | 6 个样本带异常 | **零**异常 | 不得**产生**异常 |
| 四 | 新增 5 条 observation | 不得新增**任何**异常 | **空闲**不得报警 |

三次都是**测试名说的是一回事、断言写的是另一回事**。第二轮那次绿是侥幸
（恰好满员、恰好没余波、恰好没抖动）。

最终改成三条分开：
- 链侧新增（非 observation）→ **失败**，那才是 SC-008 要防的"空闲被报成故障"
- 观测侧新增且窗口末已恢复 → **诊断**，不算失败
- 观测侧新增到窗口末仍在 → **失败，但措辞是"此轮不作数"** ——
  那时后半段样本本来就测不准，与产品有没有问题是两回事

第三条沿用本文件对高度已有的说法（"高度变了说明链上有活动，此轮结果不作数"）。
分支 2、3 都造出来验过（黑洞地址 + 基线清空两种注入）；分支 4 没单独造，按未验记。

#### win-1 的网络是个环境事实，不是推测

| | 现象 |
|---|---|
| V-60 | l1-1 的 P2P 一天抖九次 |
| 第四轮 idle | 五个节点（三台机器）同时 observation，4 秒后恢复 |
| 第四轮 场景 F | win-1 → win-2 的 HTTP 一次失败（第 30 分钟） |

三次都指向同一台机器的网络层。**根因仍未查清** —— 重启只是复位。

#### 剩下那条（场景 F）我没有擅自改

30 分钟里 **29 分钟全部确认**，只有第 30 分钟那一笔报 `HTTP request failed` ——
**不是 5xx，是根本没有应答**，而链一直在出块（高度 2165 → 2184 → …）。
测试是在 win-1 上发起、经 **win-2** 的入口（win-1 整域被它自己停着），
所以断的是 win-1 → win-2 那条链路。

把"传输失败"从判据里摘出去等于动 SC-003 的测量口径，**不该由我单方面决定**。
我自己写的 soak 工具已经把这三类分开（确认 / 5xx / 无 HTTP 应答），
并写明"无应答是**我到代理这条路**的问题"—— 口径是现成的，但用不用要由维护者定。

### V-70 A+B：传输层重试一次并单独计数，链侧仍然零容忍（2026-09-23）

第四轮那条"场景 F"的失败要不要算，取决于一个口径问题，而口径不该由我单方面定 ——
维护者选了 **A+B**：传输层失败重试一次；两类分开计；传输层超预算判"此轮不作数"。

#### 它没有推翻既有那条决定，而是把它的边界说清了

两条 30 分钟用例里原先写着：

> SC-003 / SC-005 要的是 100%，因此这里**不重试** —— 重试会把"第一次失败"藏起来，
> 而那恰恰是判据要抓的。

**那条对链给出的判决成立**（5xx、回执没来），而 `attemptTx` 确实一次都不重试它们。
它覆盖不到的是"根本没有应答"：那不是关于链的结论，而真实客户端遇到它就会重试。

为免这条边界日后被悄悄抹掉，单测里专门有一条：
**「链侧失败一次都不重试」—— 这条是既有决定，不得被悄悄推翻**，
断言 `calls === 1`。变红检查：把 `if (!isTransportFailure(first)) return …` 去掉
（即链侧也重试）→ 它立刻红并打出"那会把第一次失败藏起来"。

#### 分类的依据是现成的，不是新立的

`isTransportFailure()` 沿用 `probe-tx.mjs` 那条线：

| 判据 | 归类 |
|---|---|
| cause 链里有状态码（502/503/504） | **链侧** —— 代理活着，是它背后没有健康上游 |
| 回执超时 / 回执非 success | **链侧** —— 交易进去了，只是没被确认 |
| 既无状态码、也不是链上的判决 | **传输层** —— 连接被拒或超时，我到入口这条路 |

状态码必须沿 `cause` 链找：viem 把传输层错误包一层再抛，外层 `shortMessage` 一样而
`status` 丢了 —— 只看顶层会把 502 误判成"没有应答"，那正是 probe-tx 记着的坑。
单测里有一条专门造三层 cause 来守它。

#### 预算是 1，而且这个数本身被守着

一次"重试后仍无应答"≈ 观测方抖了几秒，是环境噪声；两次及以上说明
**本机到入口的链路**才是主角，那时这一轮量到的不是被测性质 —— 判**此轮不作数**。
与空闲用例对观测侧异常的处置同构。

`TRANSPORT_BUDGET` 有一条单测钉着它的值，消息写明"改这个数等于改'多少次算环境噪声'
的口径，要改就连同两条窗口用例的说法一起改" —— 免得有人把它悄悄调大来让红转绿。

### V-71 查 win-1 的网络，查出一条会让未来清点出错的事实（2026-09-23）

四轮 e2e 里三次失败都由 win-1 的网络抖动造成，于是单独查了一次。

#### 先排除的

| 检查 | 结果 |
|---|---|
| 网卡（Intel I226-V，1 Gbps） | 收发错误与丢弃**全为 0** |
| 网卡省电 | `AllowComputerToTurnOffDevice: Unsupported` |
| 系统事件日志（26 小时） | **零条**网络事件 —— 无链路断开、无 DHCP 续约、无 NDIS 重置 |
| 临时端口池 | 1024–15000 减 24 段排除 ≈ 12374 可用；TIME_WAIT 全程 500–560 **平稳** |

#### 抓到五次，形状很具体

43 分钟里五次，**每一次都只打同样三台**：`192.168.1.13`（win-2）、`.21`（ubuntu-1）、
`.22`（ubuntu-2），断 2–19 秒后自愈。而 `.23`/`.31`/`.32`/`.33` **一次都没有**。

所以先前那句"三台同时挂的概率远低于观测方抖了一下"要修正：确实是观测方，
但**不是随机抖动，是有选择的** —— 固定打同样三个目标。

其中 10:04 那次**宿主路径与容器路径同时断**（我同时盯着两条），
所以它既不是 Docker NAT，也不是临时端口耗尽。

按维护者的判断，这不是链本身的缺陷，不再追。数据留在 `netwatch.log`。

#### 但顺带查出一条必须记下的事实

读邻居表时看到后三台的 MAC：

```
ubuntu-4 .31   00-50-56-3D-59-A6      ← VMware OUI
ubuntu-5 .32   00-0C-29-66-60-E7      ← VMware OUI
ubuntu-6 .33   00-0C-29-52-34-9B      ← VMware OUI
```

而主机名恰好是连号的 `VMU22Node1/2/3`。两条线索合起来非常像
"同一台宿主上的三台虚拟机" —— 若属实，`sharedFailureFactors: []` 就是一句假声明：
合并后一个有效边界装 3 个验证者，超过 n=8 时的上限 2，
`tolerateWholeDomainLoss` 应当是 false，而面板会一直显示 true、余量 2。
**那正是 ADR-0007 与 R-12 立起来防的洞。**

向部署者求证后确认：**它们确实是物理机，MAC 是手工设进 VMware 段的。**
所以声明不用改。但这条实测已经写进 `lan.description` ——
否则下一个人按 ADR-0007 做 MAC/OUI 清点时会看到三段 VMware OUI，
得出"这三台是虚拟机"的结论，**而那会是一次由正确方法产生的假警报**。
清点要用别的证据（机箱、供电、交换机端口、`systemd-detect-virt`），不要只看 OUI。

#### 这一条之所以能被接住，是因为当初那句限定

descriptor 里写的是"ubuntu-4/5/6 由部署者**声明**为独立物理机，**未经** MAC/OUI 清点：
「声明为独立」与「清点过」是两件事"。

如果当初图省事写成"六台/八台独立物理机，MAC 互不相同、无虚拟机厂商 OUI"
（沿用 2026-09-08 那次清点的措辞），今天读到这三段 VMware OUI 时，
**文档会与事实直接矛盾，而没人知道该信哪个**。
把"声明"与"清点"分开写，代价是一句话，收益是这次不必推翻任何结论。

### V-72 T056：观察机零改动成立，而它暴露的三个文档缺口比结果本身更值钱（2026-09-23）

新机器 192.168.1.41，**不在部署描述里**，只起 nginx 代理 + 面板。

| 判据 | 结果 |
|---|---|
| `git status` 干净 | **空** —— 克隆后、建镜像后、起容器后各查一次，三次都空 |
| 经它的入口能确认交易 | 从 win-1 指向它发一笔真交易 → 块 2232，551ms，零 5xx |
| 高度与全网一致 | 2231 = 2231 |
| 面板可用 | `tier normal`、8/8、余量 2、`observer.blind=false` 且**可达 10/10** |

**F-8 的两条理由在一台完全不在声明里的机器上成立**：它的 IP 不在任何节点的
`http-allowed-hosts` 里（那份清单只有 `127.0.0.1` 与 `localhost`），节点却照样应答 ——
代理把 Host 改写成 `localhost`，面板直连时用 IP 字面量而 avalanchego 对它无条件放行（V-19）。

`containerFacts.available=false` 是**正确降级**：那台机器上本就没有节点容器。

#### 但真正的收获是三个文档缺口，而且它们互为因果

**① `scripts/devnet-dashboard.sh` 在观察机上跑不了。**
它的前置里要找本机运行中的 `karmachain-rpc-<边界>`，好把面板接到节点所在的容器网络上。
而观察机没有边界 id，文档让起的代理又叫 `karmachain-rpc`（无后缀）——
于是必然失败，并给出一句指向 `KARMACHAIN_DOMAIN` 的提示。
那句提示在别的机器上是对的（2026-09-10 在 win-2 上就是它救的场），
**在这台机器上却是误导**：它根本不该有边界 id。

**② 于是文档 §13.2 退而写了 `npm ci && npm run dashboard`** ——
而那要求这台机器装 Node，与 README 承诺的"宿主唯一前置依赖是 Docker"矛盾。
① 是因，② 是果：**一条走不通的路把文档逼去了一条违背自己承诺的路。**

**③ `devnet_require_verify_image` 的提示给的是 `docker compose --profile verify build verify`。**
apt 的 `docker.io` 不带 compose v2，于是那条命令报

```
unknown flag: --profile
```

**那句话指向参数，而真正缺的是插件。** 第一次读到它的人会去查 `--profile` 怎么写。

#### 三处都修了

- §13.2 改成**只用 Docker** 的两条 `docker run`（代理 + 面板），并写明为什么不用
  `devnet-dashboard.sh`，以及那句提示在观察机上为何是误导的
- §13.3 去掉 `npm run render:check`（它同样要 Node），改成从观察机自己的入口验链，
  并说明生成物漂移由承载节点的机器与 CI 守着 —— 观察机**连改都改不到**
- `devnet_require_verify_image` 的提示改成先给 `docker build`（无前提），
  compose 那条退居其次并注明它需要插件、缺了会报一句指向参数的错

#### 一句方法上的话

这一条的判据是"照文档做一遍"。**照做而顺利，只能证明文档在那条路上是对的；
照做而卡住，才能证明它在哪里不对。** 三个缺口都是卡住之后才看见的，
而其中两个（① 与 ③）的错误提示**本身指向了错误的方向** ——
那正是本期反复在修的那一类：一句朝错误方向的提示，比没有提示更坏。

### V-73 T061 的两半：判据那半我做不了，补救那半不必等人（2026-09-23）

SC-016 要的是"一名**未参与本期**的人，只给文档，**不问人、不读源码**，
独立完成一次加验证者机器"。

**写这套东西的人与全程参与的人都不具备那个独立性。** 让其中任何一方扮演新人，
得到的是一个假绿灯 —— 而这一条恰恰是为了防它才存在的。所以 T061 仍未打勾。

但它的补救条款是"**卡住就改文档，不改判据**"，那一半不必等人：
把文档那条路与**真实走过两遍**的路逐步对照（加第七台 ubuntu-5 / l1-7、
加第八台 ubuntu-6 / l1-8），找出四个缺口。

#### 四个缺口

**① 没写目标机器的前置依赖，也没警告 snap 版 docker。**
`gen-node-keys.sh` 自己会检查 jq / sha256sum（退出 10，自助得了），
但 snap 版 docker 是另一回事：它挂不了 `$HOME` 之外的路径，`-v /tmp/xxx:/out`
被换成容器侧的空目录 —— **容器写得很好，宿主什么也看不到**，
而报错指向 avalanchego（V-56 / V-61）。文档里现在有两条判据式的检查。

**② "改声明"写的是三处，实际是五处。**
文档说"贴 `identity` 到 `validators.nodes[]`，在 `topology.nodes` 与对应形态的
`failureDomains` 里补上节点"。漏了：`validators.count` 要加一；新条目还需要
`httpPort`/`stakingPort`/`keyDir`（不只是 identity 块）；而且 **`local` 形态也要安置**
——"对应形态"读起来像"你在用的那个"。
好在校验器把这两处说得很清楚，不会静默通过。

**③ 完全没有"同步到其余机器"这一步 —— 四个里最危险的一个。**
文档从 `git push` 直接跳到聚合器与四步。而实际上：各机器要 `git pull`；
**Linux 上代理必须重建**（单文件 bind mount 绑 inode，`git pull` 的原子替换换了 inode，
`restart`/`up -d` 都无效，`nginx -s reload` 还会打印 `signal process started`
**看着像成功而重载的是旧配置**）；Windows 只需 reload；以及要把新节点起来。
**漏了这一步不会报任何错**，新节点却永远进不了负载池。

**④ 没提 P 链高度滞后与 `--nudge`。** 两次真实注册都在第三步撞上（V-44 / V-65）。
工具自己说得很清楚并给出命令，所以是自助的 —— 但文档一个字没有，
而"必然发生一次"的事写进去成本很低。

#### 这件事的方法

T056 与这一条是同一个方法的两种强度：**照文档走一遍**。
T056 是我真的走了（在一台新机器上），卡住三次，找出三个缺口；
这一条我走不了"新人"那一版，于是退而求其次 —— 拿**文档**与**两次真实操作的记录**
逐步对照。后者弱一些：它找得到"文档没写的步骤"，找不到"文档写了但新人读不懂的地方"。
**这个差别正是 SC-016 仍需要一个真人的原因**，也是我没把它打勾的原因。

#### 真跑时的记录办法

已写进 tasks.md 的 T061 条目：给什么（仓库、机器、`docs/devnet.md`）、
不给什么（任何口头补充）、记什么（停在哪一步／读没读源码／问了什么／有没有独立完成）。
其中一条容易被绕过：**他问了就记下来，答完再记也不迟** ——
判据是"不需要问人"，而一次被回答过的提问已经证明了文档不足。
改完文档之后**要换一个人重来**，同一个人第二次已经不是"未参与"了。

---

### V-74 T061 真跑：第一条发现出现在第 0 分钟，而且是我发现不了的那一类（2026-09-25）

**现场。** 一名未参与本期的人接手，目标机器 `192.168.1.42`（第 9 台）。
给的是仓库地址 + 那台机器 + `docs/devnet.md`，不作任何口头补充。
**他没能开始。** 反馈是一句话：文档内容太多、信息太杂，
他要的是"从头到尾怎么把一台新机器加成第 9 个验证者"。

**这不是"少写了什么"，是"形态不对"。** V-73 补上的四个缺口都是缺失的内容；
这一条缺的是**呈现**：`docs/devnet.md` 1697 行，是一本手册（这张网络的全部知识），
不是一张单子（一件事照着敲）。加验证者这件事的步骤分散在四节里 ——
§11.2 是主线，§9.2 是目标机器的前置，§5.4 是退出码与坑，§11.1 是"f 可能不变"——
而且主线里还留着 `<边界名>`、`<节点序号>`、端口这些要读者自己算的占位符。

**为什么只有真人能发现这一条。** 我在 V-73 里把 §11.2 逐步对照过两次真实操作，
结论是"四个缺口已补齐"。那个结论**在内容上是对的**，在形态上是错的 ——
因为我（以及任何参与过的人）读 §11.2 时**已经知道**剩下的部分在哪几节，
于是感觉不到"要在四节之间跳"这件事本身就是成本。
**V-73 里写的"后者弱一些：它找得到文档没写的步骤，找不到文档写了但新人读不懂的地方"
在这一轮兑现了** —— 而且兑现在第 0 分钟，比任何一步的失败都早。

这也是"无法测量 ≠ 测量结果为否"的一个正例：
我当时测不了"新人读不读得懂"，于是明确地**没有**把 SC-016 打勾。
如果当时按"四个缺口都补了"就打勾，今天这一条就永远不会出现。

**补救。** 新增 `docs/add-validator.md`：⓪…⑩ 十一步，线性、无分支、每步一个判据，
**不解释为什么**（为什么仍留在 §11.2，单子引它而不复制它 —— 复制就会漂移）。
指路加在三处：README、§11 抬头、§11.2 抬头。

两个设计决定值得记：

- **序号与端口让读者当场从 `deployment.json` 算**（最后一项的 `index+1`、`httpPort+2`、
  `stakingPort+2`），不写死。写死"第 9 个用 21676/21677"的话，这张单子在第 9 个加完的
  那一刻就过期 —— 而一张过期的单子比没有单子更坏，因为它看起来仍然可信。
  实跑核过：那一行输出 `序号 9 / l1-9 / 21676 / 21677 / n=9`，与实际相符。
- **⓪ 加了"抓基线"这一步，而 §11.2 里没有。** ⑩ 的验收要证明"既有节点没重启"，
  判据是 `Created`/`StartedAt` 逐字符相同 —— 那份基线**事后补不回来**。
  §11.2 没有这一步，是因为写它的时候基线已经在我手里了。

顺带修掉 §11.2 里一处被 heredoc 吃掉的反斜杠（`scriptsdevnet-member.ps1`）。

**这一轮的效力。** 判据的对象变了（从 `devnet.md` 变成 `add-validator.md`），
而且他已经读过旧文档、文档又在他手上改过，所以**这一轮不再是干净的独立性测试**。
T061 因此仍不打勾：要么把这一轮当作"改后的一次自测"，
要么换第二个人从零跑新单子才算数。

---

### V-75 T061 第二轮：第 9 个验证者真的加上了，而判据仍然没过（2026-09-25）

换了第二个人 —— 未参与本期、没读过旧文档、拿到的是 `f6fee58` 的
`docs/add-validator.md`。目标 `192.168.1.42`。

**结果：任务达成。** 链上成员 8 → 9，声明 / 合约 / P 链三侧一致，
`devnet-verify` 14/14、`9/9 validators online, tolerance 2, full margin`，
创世哈希与基线一致，高度 2232 → 2247，win-1 的 `l1-1` 与 `rpc-win-1` 的
`Created`/`StartedAt` 与基线**逐字符相同**。

**而 SC-016 仍然不成立** —— 它要的是"不需要问人"。他问了两次，
还撞上一个会让人无限循环的工具缺陷。**没读源码**，那一半成立。

#### 这一轮买到七条，其中两条是产品缺陷

| # | 缺口 | 类别 | 发现方式 |
|---|---|---|---|
| 1 | 手册不是单子（1697 行，步骤散在四节） | 文档形态 | 第一轮，第 0 分钟 |
| 2 | `--node-id NodeID-…` 的省略号意义不明 | 文档 | **他卡住** |
| 3 | `git commit -am` 收不到 render 新建的文件 | 文档 | 他推了两次才对 |
| 4 | ⑦ 之后处处显示 9 而链上是 8，无分界 | 文档 | **他一度自认完成** |
| 5 | `devnet-verify` 对"注册未完成"判 `[OK] / READY / 0 failed` | **产品** | 同上 |
| 6 | 单子没说 ⑧⑨ 在哪台机器上做 | 文档 | **他提问** |
| 7 | P 链落后一格时，工具说完"走不通"又请人上路 | **产品** | **他连按三次 y** |

第 2 条与第 1 条同源：`NodeID-…` 是**手册**的行文约定（省略其余部分），
搬进一张让人照着敲的单子就成了不明符号。**同一个病根的第二次发作。**

第 5、7 两条只有走到"花钱那一步"才暴露得出来 ——
第一轮那位停在 ⑦ 就自认完成了，所以这两条他一条也碰不到。
**走得越深，买到的越贵。**

#### 第 7 条值得单独记：一个自己说走不通、然后又请你上路的工具

工具**正确地**检测到 P 链验证集合落后一格，**正确地**说明了位图按当前成员编号、
链按上一格的集合验、聚合公钥对不上、**多收签名也过不去**、P 链不会自己出块。
然后它继续往下走：收签名、算干跑、弹出「**提交这笔 P 链交易？** [y/N]」。

他按了三次 y，三次都必然失败（`NumIndices (7) >= NumFilteredValidators (7)`、
`signature is invalid` ×2）。而每次的签名者名单都不同（都是 5/8，但换人），
这更像"再试一次说不定就成了"。

**问题不在他身上。** 一个 y/N 提示本身就在暗示"这是可以走的一步"。
不说话的工具他还会去查为什么；说了"走不通"又请他上路的工具，
把他的注意力从"为什么"引到了"再试一次"。

修法：`needsNudgeFirst()` —— 落后一格 + 没带 `--nudge` + 推进那条路可用 ⇒
打印命令后**到此为止**，退出 30（一步都没动链）。
唯一放行的例外是推进本身构造不出来：那时拦下等于把人堵死。
退出前多说一句"第 ① 步的成果仍在链上，不会重做" ——
停下来最容易引起的误解是"我是不是要从头来"。守卫 6 条，变红检查做了。

#### 一处会让人怀疑工具认错状态的措辞

那条警告原本写的是落后一格"是刚**退**过成员的正常状态"，
而这次是刚**加**完 l1-8 之后又来加 l1-9，没有人退过成员。
增、删都会让集合变化，落后与方向无关。已改成"刚增或删过成员之后"。
**一句多余的因果解释，会让读者去排查一件根本没发生的事。**

#### 判据怎么记

`T061` 这件**事**做完了（找了人、跑了两轮、卡住就改文档不改判据），标 `[X]`。
`SC-016` 这条**判据**没过，由 ❌ 转 ⚠ 而**不是** ✅ ——
"任务达成"与"不需要问人"是两件事，混起来就等于给自己发一张假绿灯。

要转 ✅ 需要**第三个人**照现在的文档从零跑通、全程不问。
前两位都已经不再"未参与"了。
