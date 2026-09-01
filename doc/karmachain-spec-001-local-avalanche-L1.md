# Spec 001：本地 Avalanche L1 基础网络

## 1. Spec 基本信息

**Spec ID：** 001

**名称：** 本地 Avalanche L1 基础网络

**状态：** Draft

**优先级：** P0

**类型：** Blockchain Infrastructure

**目标：**

基于 Avalanche L1 构建一个可以在本地开发环境中独立运行的 MyChain 区块链网络。

本 Spec 不实现完整的业务系统，而是建立 MyChain 后续所有功能依赖的区块链基础设施。

---

# 2. 背景

MyChain 是一个基于 Avalanche L1 构建的 EVM 兼容区块链项目。

后续系统将逐步加入：

- Native Token
- 钱包
- Token Transfer
- Smart Contract
- RPC
- Indexer
- Block Explorer
- Spring Boot Backend
- Vue DApp

这些功能都依赖一个稳定、可验证、可重复创建的 MyChain 区块链网络。

因此，第一阶段必须先解决：

```text
Avalanche L1
      ↓
MyChain Blockchain
      ↓
Validator
      ↓
Block Production
      ↓
EVM
      ↓
RPC
```

本 Spec 的目标就是完成这一基础链路。

---

# 3. 目标

本 Spec 必须实现以下目标：

1. 创建 MyChain Avalanche L1。
2. 配置 MyChain 的基础网络参数。
3. 创建本地开发 Genesis。
4. 创建至少一个 Validator。
5. 启动 MyChain 节点。
6. Validator 能够正常参与网络。
7. 网络能够持续产生区块。
8. EVM 能够正常执行交易。
9. RPC 能够正常访问。
10. 可以通过标准 EVM 工具查询区块和账户。
11. 整个网络能够通过脚本或自动化命令重复创建。
12. 删除本地环境后，可以重新创建完全一致的开发网络。

---

# 4. 非目标（Non-Goals）

本 Spec **不实现**以下功能：

- 生产环境部署
- 公网 Validator
- 钱包 UI
- MetaMask 集成 UI
- Block Explorer
- Token 浏览器
- Native Token 业务功能
- ERC-20 Token
- NFT
- Spring Boot 业务 API
- Vue 前端
- 用户注册
- 用户登录
- 用户数据库
- 交易索引系统
- 复杂智能合约
- 跨链功能
- Oracle
- DeFi
- DAO
- Staking 业务系统

这些功能将在后续 Spec 中实现。

---

# 5. 技术范围

本 Spec 涉及以下核心组件：

```text
                 MyChain
                    │
                    ▼
              Avalanche L1
                    │
             ┌──────┴──────┐
             │             │
             ▼             ▼
           Node         Validator
             │
             ▼
             VM
             │
             ▼
            EVM
             │
             ▼
            RPC
```

项目必须明确区分：

```text
Avalanche Network Layer
        ↓
Node
        ↓
Validator
        ↓
VM
        ↓
EVM
        ↓
RPC
```

---

# 6. 基础网络参数

MyChain 必须定义一组明确的开发网络参数。

至少包括：

| 参数 | 要求 |
|---|---|
| Chain Name | MyChain |
| Chain ID | 必须唯一 |
| Network ID | 必须明确 |
| VM | EVM |
| Native Token | MyChain 原生 Token |
| Token Symbol | 必须明确 |
| Decimals | 必须明确 |
| Genesis | 必须版本化 |
| Validator | 至少 1 个 |
| RPC | 必须启用 |
| P2P | 必须启用 |

具体数值必须集中定义，不允许散落在多个配置文件中。

---

# 7. Chain ID

MyChain 必须拥有明确的 Chain ID。

Chain ID 必须：

1. 在项目中唯一。
2. 在 Genesis 或网络配置中定义。
3. Backend 使用同一个 Chain ID。
4. Frontend 使用同一个 Chain ID。
5. 测试使用同一个 Chain ID。
6. 文档使用同一个 Chain ID。

不得出现：

```text
Genesis → Chain ID A
Backend  → Chain ID B
Frontend → Chain ID C
```

项目必须保证：

```text
Single Source of Truth
```

---

# 8. Genesis

MyChain 必须拥有独立的 Genesis 配置。

Genesis 至少需要定义：

- Chain ID
- 初始网络状态
- EVM 配置
- Gas 配置
- Native Token 初始状态
- Validator 初始配置
- 网络相关参数

Genesis 必须：

- 进入版本控制；
- 可以被自动生成；
- 可以被重复使用；
- 不依赖开发者本机的临时状态。

---

# 9. Validator

MyChain 本地开发网络至少运行一个 Validator。

Validator 必须能够：

1. 启动。
2. 加入 MyChain 网络。
3. 参与共识。
4. 验证网络状态。
5. 产生或参与区块处理。
6. 持续同步区块。

Validator 的密钥属于开发环境 Secret。

开发 Validator Key：

- 只能用于本地开发；
- 不得用于生产环境；
- 不得提交真实生产私钥。

如果项目提供开发用 Validator Key，则必须明确标记：

```text
DEVELOPMENT ONLY
```

---

# 10. Node

MyChain Node 必须能够：

- 启动；
- 加载 Genesis；
- 加载网络配置；
- 加入网络；
- 与其他节点通信；
- 同步区块；
- 执行 EVM；
- 提供 RPC；
- 查询链状态。

Node 启动失败时必须能够通过日志确定主要失败原因。

---

# 11. EVM

MyChain 必须提供 EVM 执行环境。

EVM 至少必须支持：

- 账户
- ETH-style 原生资产模型
- Nonce
- Gas
- Transaction
- Contract
- Contract Call
- Contract Deployment
- Event / Log
- Block
- Receipt

本阶段不要求实现复杂智能合约。

但是必须证明：

```text
Transaction
      ↓
EVM
      ↓
State Transition
      ↓
Block
      ↓
Receipt
```

能够正常完成。

---

# 12. RPC

MyChain 必须提供标准 EVM JSON-RPC 接口。

至少需要验证：

```text
eth_chainId
eth_blockNumber
eth_getBlockByNumber
eth_getBlockByHash
eth_getBalance
eth_getTransactionByHash
eth_getTransactionReceipt
eth_call
eth_sendRawTransaction
eth_getTransactionCount
```

具体支持情况必须以实际 Avalanche L1 / EVM 实现为准。

不允许 AI 自行假设 RPC 行为。

如果某个 RPC 方法不支持：

> 必须在文档和测试中明确说明。

---

# 13. RPC 验证

网络启动之后必须能够通过 RPC 获取：

- Chain ID
- Block Number
- Block
- Account Balance
- Transaction
- Transaction Receipt

例如：

```text
RPC
 ↓
eth_chainId
 ↓
MyChain Chain ID
```

以及：

```text
RPC
 ↓
eth_blockNumber
 ↓
Current Block Height
```

---

# 14. 区块生产

MyChain 启动后必须能够持续产生新区块。

系统必须验证：

```text
Block N
   ↓
Block N+1
   ↓
Block N+2
   ↓
Block N+3
```

区块高度必须能够正常增长。

测试不能只验证：

```text
Node Started
```

而必须验证：

```text
Node Started
+
Validator Healthy
+
Block Production
```

---

# 15. EVM 交易

本 Spec 必须至少完成一次真实 EVM 交易测试。

交易流程：

```text
Test Account A
      │
      │ signed transaction
      ▼
     RPC
      │
      ▼
   MyChain
      │
      ▼
     EVM
      │
      ▼
State Transition
      │
      ▼
    Block
      │
      ▼
Transaction Receipt
```

测试必须验证：

- Transaction Hash
- Block Number
- Transaction Status
- Gas Used
- Sender
- Receiver
- State Change

---

# 16. Native Token

MyChain 必须具备区块链原生资产。

本阶段只要求：

- 定义 Native Token；
- 在 Genesis 中配置开发环境初始余额；
- 可以查询余额；
- 可以进行基础转账；
- 可以通过 RPC 验证余额变化。

例如：

```text
Account A
Balance = 1000

      ↓
Transfer 100

Account A
Balance = 900

Account B
Balance = 100
```

本阶段不实现：

- Token Marketplace
- Staking
- Token Exchange
- Token UI

---

# 17. 开发环境

本地开发环境应该尽可能容器化。

推荐：

```text
Docker
Docker Compose
```

开发者应该能够执行类似：

```bash
./scripts/start-local-network.sh
```

启动：

```text
MyChain
   │
   ├── Node
   ├── Validator
   └── RPC
```

停止：

```bash
./scripts/stop-local-network.sh
```

清理：

```bash
./scripts/reset-local-network.sh
```

重新启动：

```bash
./scripts/start-local-network.sh
```

并得到一个干净、可预测的开发网络。

---

# 18. 自动化要求

必须提供自动化脚本完成：

```text
创建网络
 ↓
生成配置
 ↓
创建 Genesis
 ↓
初始化 Node
 ↓
启动 Node
 ↓
启动 Validator
 ↓
等待网络 Ready
 ↓
验证 RPC
 ↓
验证 Block Production
```

不能要求开发者执行大量无法记录的手工操作。

如果必须手工执行某一步：

> 必须记录原因，并尽可能在后续自动化。

---

# 19. 项目目录

推荐目录结构：

```text
mychain/
│
├── .specify/
│
├── specs/
│   └── 001-local-avalanche-l1/
│       └── spec.md
│
├── blockchain/
│   ├── genesis/
│   ├── network/
│   ├── validators/
│   └── config/
│
├── scripts/
│   ├── create-network
│   ├── start-network
│   ├── stop-network
│   ├── reset-network
│   └── verify-network
│
├── tests/
│   ├── blockchain/
│   ├── rpc/
│   └── e2e/
│
├── docker/
│
├── docs/
│
└── README.md
```

实际目录可以根据最终 Avalanche 工具链调整。

---

# 20. 配置管理

以下配置必须具有明确来源：

```text
Chain ID
Network ID
Genesis
RPC Port
P2P Port
Validator
Native Token
Gas
```

不得在代码中大量硬编码。

推荐：

```text
Configuration
      │
      ├── Genesis
      ├── Node
      ├── Validator
      ├── RPC
      └── Tests
```

---

# 21. 安全要求

本 Spec 虽然是本地开发网络，但必须从第一天建立正确的安全习惯。

禁止：

```text
Private Key → Git
Seed Phrase → Git
Production Key → Repository
```

开发环境和生产环境必须严格区分。

例如：

```text
config/dev/
config/test/
config/staging/
config/prod/
```

如果后续采用 Secret Manager：

> 生产环境必须通过 Secret Manager 或等效机制管理敏感信息。

---

# 22. 可观测性

Node 必须提供足够的日志。

至少可以观察：

```text
Node Started
Validator Started
Network Connected
Peer Connected
Block Produced
Block Imported
Transaction Processed
RPC Request
Error
```

日志不能泄露：

- Private Key
- Seed Phrase
- Secret
- Password

---

# 23. Health Check

MyChain 必须提供网络健康检查。

至少检查：

```text
Node Running
        ↓
Validator Running
        ↓
RPC Available
        ↓
Block Height Increasing
        ↓
Network Healthy
```

推荐提供一个自动化验证命令：

```bash
./scripts/verify-network.sh
```

最终输出类似：

```text
MyChain Network Check

[OK] Node
[OK] Validator
[OK] RPC
[OK] Chain ID
[OK] EVM
[OK] Block Production
[OK] Transaction
[OK] Native Token

MyChain is READY
```

---

# 24. 测试要求

本 Spec 至少包含以下测试。

## 24.1 网络启动测试

验证：

```text
Network Starts
```

---

## 24.2 Chain ID 测试

验证：

```text
RPC Chain ID
==
Configured Chain ID
```

---

## 24.3 Block Production 测试

验证：

```text
Block N
<
Block N+1
```

---

## 24.4 RPC 测试

验证主要 JSON-RPC 方法。

---

## 24.5 Native Token 测试

验证：

```text
Initial Balance
 ↓
Transfer
 ↓
Final Balance
```

---

## 24.6 EVM Transaction 测试

验证：

```text
Signed Transaction
 ↓
RPC
 ↓
Block
 ↓
Receipt
 ↓
State Change
```

---

## 24.7 Reset / Recreate 测试

验证：

```text
Start
 ↓
Stop
 ↓
Reset
 ↓
Start
```

仍然能够正常运行。

---

# 25. End-to-End 验证

必须完成至少一个完整 E2E 流程：

```text
Create Network
      ↓
Start Validator
      ↓
Start Node
      ↓
RPC Ready
      ↓
Block Produced
      ↓
Create/Use Test Account
      ↓
Send Transaction
      ↓
Transaction Included
      ↓
Receipt Confirmed
      ↓
Balance Updated
```

这个流程成功之后，才认为 Spec 001 的核心目标完成。

---

# 26. 验收标准（Acceptance Criteria）

## AC-001：网络能够创建

给定干净环境：

```text
运行网络创建命令
```

系统必须能够创建 MyChain 所需配置。

---

## AC-002：节点能够启动

Node 必须能够成功启动并加载 MyChain 配置。

---

## AC-003：Validator 能够运行

至少一个 Validator 必须成功加入 MyChain。

---

## AC-004：RPC 可用

调用 Chain ID RPC 必须返回正确 Chain ID。

---

## AC-005：区块能够产生

启动网络后，区块高度必须持续增长。

---

## AC-006：EVM 正常运行

必须能够执行至少一次 EVM 交易。

---

## AC-007：Native Token 可用

测试账户必须能够查询余额并完成基础转账。

---

## AC-008：交易能够确认

交易必须：

```text
Submitted
 ↓
Included
 ↓
Confirmed
```

并能够获取 Transaction Receipt。

---

## AC-009：网络能够重建

删除本地网络状态之后：

```text
Reset
 ↓
Create
 ↓
Start
```

必须重新获得可运行的 MyChain。

---

## AC-010：自动化验证通过

执行：

```bash
./scripts/verify-network.sh
```

必须全部通过。

---

# 27. Definition of Done

Spec 001 只有在以下条件全部满足后才能标记为完成：

- [ ] MyChain Avalanche L1 可以创建
- [ ] Genesis 可以生成
- [ ] Chain ID 已确定
- [ ] Network ID 已确定
- [ ] Validator 可以启动
- [ ] Node 可以启动
- [ ] EVM 正常运行
- [ ] RPC 正常运行
- [ ] 区块能够持续产生
- [ ] Native Token 可以查询
- [ ] Native Token 可以转账
- [ ] EVM Transaction 可以执行
- [ ] Transaction Receipt 可以查询
- [ ] 网络可以停止
- [ ] 网络可以 Reset
- [ ] 网络可以重新创建
- [ ] 自动化测试通过
- [ ] E2E 测试通过
- [ ] 没有 Secret 被提交到 Git
- [ ] 文档已经更新
- [ ] AI Agent 没有绕过 Constitution
- [ ] 所有协议参数具有唯一事实来源

---

# 28. 失败处理

如果网络无法启动，系统必须能够区分至少以下问题：

```text
Genesis Error
Configuration Error
Node Error
Validator Error
P2P Error
RPC Error
EVM Error
Transaction Error
Storage Error
```

不能简单输出：

```text
Network Failed
```

而没有进一步信息。

---

# 29. AI Agent 实现约束

AI Agent 在实现本 Spec 时：

### 必须

1. 首先读取项目 Constitution。
2. 阅读本 Spec。
3. 检查现有代码。
4. 确认 Avalanche L1 当前使用的实际工具和版本。
5. 使用官方文档或实际源码确认协议行为。
6. 编写测试。
7. 实现网络。
8. 运行测试。
9. 执行 E2E 验证。
10. 更新相关文档。

### 禁止

1. 自己实现 Avalanche Consensus。
2. 自己实现 Validator Consensus。
3. 自己伪造 Avalanche L1 行为。
4. 自己发明 RPC 协议。
5. 为了测试通过而删除测试。
6. 禁用安全检查。
7. 提交私钥。
8. 在没有 Specification 的情况下修改核心协议。
9. 为了方便开发而改变 Chain ID。
10. 将链上状态直接交给 MySQL 管理。

---

# 30. 技术决策约束

本 Spec 允许对具体工具进行选择，但必须优先使用 Avalanche 官方支持的 L1 创建、节点运行和 EVM 相关组件。

具体工具版本必须在 Plan 阶段确定。

如果不同版本的 Avalanche 工具存在架构差异：

> 必须以项目实际锁定版本的官方文档和源码为准。

不能根据旧版本教程推测当前行为。

---

# 31. 后续 Spec 依赖

Spec 001 完成后，后续功能可以建立在其基础上。

推荐：

```text
001 Local Avalanche L1
        │
        ▼
002 Validator & Network
        │
        ▼
003 Native Token
        │
        ▼
004 EVM RPC
        │
        ▼
005 Wallet & Transfer
        │
        ▼
006 Smart Contract
        │
        ▼
007 Indexer
        │
        ▼
008 Block Explorer
        │
        ▼
009 Spring Boot Backend
        │
        ▼
010 Vue DApp
```

其中部分功能可以根据实际架构合并。

---

# 32. 最终目标

Spec 001 完成后，开发者执行：

```bash
./scripts/create-network.sh
./scripts/start-network.sh
```

然后系统最终应该达到：

```text
                    MyChain
                       │
              ┌────────┴────────┐
              │                 │
           Validator           Node
              │                 │
              └────────┬────────┘
                       │
                    Consensus
                       │
                       ▼
                      VM
                       │
                       ▼
                      EVM
                       │
                       ▼
                     State
                       │
              ┌────────┴────────┐
              │                 │
            Blocks           Transactions
              │                 │
              └────────┬────────┘
                       │
                       ▼
                      RPC
                       │
             ┌─────────┴─────────┐
             │                   │
          CLI / Test          Future DApp
```

并且能够完成：

```text
启动网络
   ↓
产生区块
   ↓
查询 Chain ID
   ↓
查询账户余额
   ↓
发送交易
   ↓
交易进入区块
   ↓
获取 Receipt
   ↓
验证余额变化
```

当以上流程全部通过时：

> **MyChain 的第一层区块链基础设施才算真正建立完成。**
