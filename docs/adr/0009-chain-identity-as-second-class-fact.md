# ADR-0009：建链制品是"第二类事实"，不由 protocol.json 派生

**状态**：已接受 · **日期**：2026-09-07 · **决策者**：项目负责人 · **相关**：宪法第十二/十四/十六条 · **来源**：功能 002（研究 R-04、R-05、R-15）

## 决定了什么

`blockchain/chain-identity/` 下的建链产物（SubnetID、BlockchainID、5 个引导验证者的 ValidationID 与 BLS 材料、
Primary Network 创世）**不放进 `blockchain/protocol.json`**，而是作为一类**独立的、被提交进仓库的制品**存在。

| | 第一类事实：协议参数 | 第二类事实：建链制品 |
|---|---|---|
| 载体 | `blockchain/protocol.json` | `blockchain/chain-identity/*.json` |
| 来源 | 人的**决定**（Chain ID 取 20189、代币 18 位小数…） | 一次真实建链动作的**产物**（P 链交易 ID） |
| 能否离线推导 | 是 —— 生成物都是它的纯函数 | **否**。BlockchainID 是 CreateChainTx 的交易 ID |
| 改动方式 | 编辑 + 走宪法第十五条流程 | 重新建链 |
| 保护手段 | schema + 约束校验 + 漂移测试 | schema + **交叉校验** + 漂移测试 + 启动期比对 |

## 为什么不塞进唯一事实来源

宪法第十六条要求协议参数只有一个出处，容易由此推出"那把 BlockchainID 也写进去"。这是错的，
因为它混淆了两件不同性质的事：

**协议参数是输入，建链制品是输出。** `protocol.json` 的定义性质是"我们决定链长什么样"，
它的每一个生成物都是它的纯函数（改 Chain ID → 重新生成创世 → 哈希随之改变，可离线复算）。
BlockchainID 不是任何人决定的，它是一次 P 链交易的哈希 —— 把它写进 `protocol.json`
会让"参数"与"产物"的边界失效：读者再也分不清哪些字段是可以改的决定，哪些是不可改的既成事实。

反过来的诱惑是"既然是产物，那就每次启动重新建链"。这条也不行，见下文。

## 关键实测：建链是确定性的，但这不改变结论

研究阶段最初写的是"BlockchainID 每次建链都会变"。**这一判断被实测推翻。**

卷被 `devnet-reset` 删除并重建 3 次（其中一次相隔一天），逐字段比对：

| 字段 | 结果 |
|---|---|
| SubnetID | **一致** |
| BlockchainID | **一致** |
| 5 个 ValidationID | **全部一致** |
| 5 个 BLS 公钥 | **全部一致** |

原因是本地网络的输入全部固定：Primary Network 创世固定、staking 密钥提交在仓库里、
建链步骤顺序固定，于是付手续费的 UTXO 与交易字节也固定，交易 ID 随之固定。

**但"可复现"不等于"可离线推导"**：拿到 BlockchainID 仍然必须真的跑一次建链。因此结论不变 ——
制品固化 + 只读消费。可复现带来的是另外两个收益：

1. **制品可以被漂移测试保护**，而不只是"提交上去就不管了"。重新建链应当得到逐字节相同的制品；
   不同即说明有输入变了（版本、密钥、创世、步骤顺序），这正是需要被拦下的情况。
2. **链别名的理由变了**（见 ADR-0008 的代价表）：不再是"补偿 BlockchainID 的不可复现"，
   而是"把对外路径与内部标识解耦" —— 即便将来某项输入变化导致 BlockchainID 改变，
   公开制品里的 `/ext/bc/karmachain/rpc` 也不受影响。

有一个例外必须记住：**Primary Network 创世不是确定性的**，它内嵌了建链时的挂钟时间
（`startTime`）。因此它必须**随每次建链重新提取**；沿用旧的会让节点以
`db contains invalid genesis hash` 拒绝启动（实测踩过）。

## 补偿手段：三层，因为无法离线复算

制品既然不能由纯函数校验，就必须用别的方式确保它与仓库其余部分同源：

1. **交叉校验**（`tests/unit/chain-identity.test.mjs`、`identity-crosscheck.test.mjs`）：
   制品符合 schema；`vmVersion`/`rpcVersion`/`networkId` 与 `protocol.json` 一致；
   `bootstrapValidators` 数量等于 `validators.count` 且权重全相等；
   **5 个 `keyDir` 派生出的 NodeID 与 BLS 公钥逐一匹配制品中的条目** ——
   这一条把"制品"与"仓库里的密钥"绑在一起，任一方被换掉都会被发现。
2. **启动期比对**：每个节点容器启动时比对挂载密钥的 sha256 与身份伴生文件声明的值，
   不符即退出 12（FR-017）。重活留在渲染期（Node 环境算 BLS 公钥），
   运行期只做一次摘要比对 —— 官方 avalanchego 镜像里没有 Node，shell 也算不出 BLS 公钥。
3. **漂移测试**：制品参与 `devnet-render --check`，手改即失败。

## 由此确定的分发方式（R-15 实测）

制品是"第二类事实"这一定性，直接决定了跨机部署要分发什么。实测（可逆验证）：
**只需分发仓库 + 2 个 Primary 节点的数据卷**。

Subnet 与 Blockchain 是 P 链上的交易，只存在于持有 P 链的节点数据库里 —— 那就是 2 个 Primary 节点。
5 个验证者从**空卷**启动即可：按 `bootstrap-ips` 找到 Primary 同步 P 链，L1 从仓库里的创世起链。
实测删掉 5 个验证者卷后启动：6 秒就绪、5/5 验证者引导完成、运行中的 `blockchainId`/`subnetID`
与制品逐字一致、`devnet-verify` 14/14。代价是 L1 高度从创世重新开始。

换言之：**JSON 制品走 git，P 链状态走 2 个卷。** 要保住现有高度则导出／导入全部 7 个卷
（同样已实测：导入后高度精确回到原值）。

## 考虑过的替代方案

| 方案 | 否决理由 |
|---|---|
| **把 BlockchainID 写进 `protocol.json`** | 混淆输入与产物，让"哪些字段可以改"变得无法判断（见上文） |
| **每次启动重新建链** | 即便结果确定，也要多花一次完整建链的时间（实测约 80 秒）；更要紧的是任何输入的意外变化都会**静默**产生一条新链而无人察觉。固化 + 漂移测试才能把这种变化变成可见的失败 |
| **不提交制品，让每个开发者自己建链** | 每人一条链，NodeID 与 BlockchainID 各不相同，公开制品失去意义，"从克隆到可用链两步"也不再成立 |
| **只提交 JSON 制品，P 链状态每次现建** | 空 P 链上没有那个 Subnet —— 实测：`platform.getSubnets` 只返回 Primary Network，`/ext/bc/<alias>/rpc` 返回 404。制品里的 ID 指向一条不存在的链 |
| **把 Primary Network 创世也当作确定性制品** | 它内嵌挂钟时间，沿用旧的会导致 `db contains invalid genesis hash`。必须随每次建链重新提取 |

## 影响

- `blockchain/chain-identity/` 下的制品提交进仓库，运行期只读消费
- `blockchain/chain-identity.schema.json` 约束其结构；三层补偿手段见上
- `scripts/devnet-bootstrap` 是唯一产出它们的路径，默认拒绝覆盖已有制品（需 `--force`）
- 跨机部署只分发仓库 + 2 个 Primary 卷（`docs/devnet.md` §9.3）
- **Primary Network 创世必须随每次建链重新提取** —— 这是最容易漏的一步

## 迁移

制品变更（重新建链）等价于换一条链：`configVersion` 未变但 `blockchainId` 变了，
出生证明守卫会以退出码 12 拒绝旧卷。流程是 `devnet-reset` → `devnet-bootstrap` → `devnet-start`，
并更新 `docs/public/chain-info.json`（生成物，`npm run protocol:render` 自动处理）。
第三方消费者只依赖公开的链别名路径，因此不受 BlockchainID 变化影响 —— 这正是 ADR-0008 代价表里
那个无状态代理换来的。
