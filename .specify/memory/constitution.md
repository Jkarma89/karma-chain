# KarmaChain 项目宪法

## 序言（Preamble）

KarmaChain 是一个基于 **Avalanche L1** 构建的、兼容 **EVM** 的区块链系统。

项目旨在构建一个**可复现、安全、可观测、可扩展**的区块链基础设施。

整个系统包括：

- 区块链网络
- EVM 执行环境
- 原生代币
- 智能合约
- RPC 服务
- 后端服务
- 前端应用
- 区块链索引服务
- 监控与可观测性系统
- 自动化部署基础设施

所有实现都必须保证：

1. 区块链状态的完整性；
2. 链上与链下系统之间具有清晰的职责边界；
3. 开发环境和生产环境具有可复现性；
4. 人类开发者和 AI Agent 都必须遵守统一的工程规则。

以下原则属于 KarmaChain 项目的最高级别工程约束。

---

## 第一条：区块链优先原则

**区块链必须是所有共识相关状态的最终权威数据源。**

系统必须明确区分以下数据：

- 区块链状态
- 智能合约状态
- 链下业务状态
- 缓存数据
- 索引数据
- 前端展示数据

链下服务**不得直接修改区块链的共识状态**。

以下数据的变化：

- 账户余额
- Token 所有权
- Token 供应量
- 权限
- 链上资产
- 其他共识相关数据

必须通过区块链定义的交易和状态转换机制完成。

后端服务可以：

- 发起交易
- 查询区块链
- 对区块链数据进行索引
- 提供 REST API
- 保存业务数据
- 进行缓存
- 执行链下业务逻辑

但是：

> **后端数据库不能成为区块链状态的替代品。**

例如：

```text
错误：

Spring Boot
    ↓
MySQL
    ↓
UPDATE balance = balance + 100
```

正确：

```text
用户
 ↓
Wallet
 ↓
签名交易
 ↓
RPC
 ↓
Blockchain
 ↓
EVM
 ↓
State Change
 ↓
Indexer
 ↓
MySQL
```

MySQL 保存的是**区块链状态的派生数据**，而不是区块链本身的权威状态。

---

## 第二条：链上与链下必须明确分工

每一个功能在设计阶段都必须明确：

1. 链上
2. 链下
3. 链上 + 链下

如果一个功能同时涉及两个层面，必须明确规定两者如何同步。

### 应该放到链上的东西

通常包括：

- 资产所有权
- Token 余额
- Token 供应量
- 需要公开验证的状态
- 需要去信任化的逻辑
- 智能合约核心逻辑
- 共识相关状态

### 应该放到链下的东西

通常包括：

- 用户登录
- 用户界面状态
- 搜索
- 数据分析
- 通知
- 缓存
- 索引
- 非关键业务流程
- 长时间运行的异步任务

### 核心原则

不要为了“Web3”而把所有东西都放到区块链上。

应该遵循：

```text
需要去信任化
    ↓
  链上

普通业务逻辑
    ↓
  链下
```

---

## 第三条：EVM 兼容性原则

KarmaChain 默认必须保持 **EVM 兼容性**。

除非经过明确的架构决策，否则不能随意改变这一原则。

智能合约应该优先使用 Ethereum 生态已经形成的标准。

例如：

- Solidity
- ERC-20
- ERC-721
- ERC-1155
- OpenZeppelin
- JSON-RPC
- ABI
- EIP

如果需要设计自定义协议行为：

> 必须明确记录和说明。

不能悄悄修改标准行为，导致现有 EVM 工具无法使用。

在技术允许的情况下，KarmaChain 应尽可能兼容：

- MetaMask
- Foundry
- Hardhat
- viem
- ethers.js
- OpenZeppelin
- Remix

也就是说：

```text
KarmaChain
   ↓
EVM
   ↓
Ethereum Developer Ecosystem
```

应该尽可能复用成熟生态，而不是重新发明一套工具链。

---

## 第四条：安全优先原则

**安全性优先于开发速度。**

如果快速上线与安全设计发生冲突：

> 必须优先选择安全设计。

尤其以下代码必须进行更加严格的审查：

- Consensus
- Validator
- Transaction Processing
- Cryptography
- Wallet
- Smart Contract
- Token
- Permission
- State Transition

### 严禁提交敏感信息

以下内容绝对不能提交到 Git：

- Private Key
- Seed Phrase
- Validator Key
- Wallet Key
- RPC Credential
- API Secret
- Database Password
- 其他 Secret

### 例外：公开已知的本地开发密钥

同时满足以下全部条件的密钥，不属于本条所指的"敏感信息"，允许提交：

1. 密钥本身是公开已知的（如生态通用测试密钥 ewoq、Anvil/Hardhat 默认账户），
   或仅在本地开发网络（独立的 Chain ID / Network ID）中有效；
2. 所在文件与目录带有显著的 `DEVELOPMENT ONLY` 标记；
3. 自动化秘密扫描将其列入显式白名单，白名单之外的命中一律视为违规；
4. 生产与 Staging 环境在技术上不可能接受这些密钥
   （不同的 Genesis、Chain ID、验证者集合）。

例外仅覆盖上述密钥本身。真实私钥、助记词、生产/测试网凭据
仍然绝对禁止提交，即使"只是临时的"。

生产环境必须通过安全的 Secret 管理机制提供。

生产环境：

> **禁止使用开发环境的私钥、Genesis 或测试配置。**

### 需要安全分析的修改

任何涉及以下内容的修改，都必须进行安全分析：

- Consensus
- Validator
- Transaction Validation
- State Transition
- Cryptography
- Token Supply
- Smart Contract Permission
- Key Management

不能因为“只是改几行代码”就跳过安全审查。

---

## 第五条：区块链执行必须具有确定性

所有影响共识的执行逻辑必须是：

> **Deterministic（确定性的）**

也就是说：

```text
相同输入
   +
相同区块链状态
   ↓
所有节点
   ↓
必须得到相同结果
```

共识相关代码不能依赖：

- 本地时间
- 随机数
- 外部网络请求
- 本地文件
- 环境变量产生的随机行为
- 非确定性的并发行为
- 外部数据库

除非这些数据已经由协议明确提供。

例如不能：

```java
long result = System.currentTimeMillis();
```

然后把这个结果用于共识状态。

---

## 第六条：智能合约安全原则

智能合约必须被视为：

> **长期运行、不可轻易修改的金融基础设施。**

生产环境智能合约必须具备：

- Automated Tests
- Access Control
- Events
- Upgradeability Decision
- Token Supply Rules
- Failure Behavior

### 优先使用成熟库

不要自己重新实现：

- ERC20
- ERC721
- Cryptography
- Access Control
- Upgradeable Proxy

应该优先使用经过广泛使用和审查的成熟库，例如：

- OpenZeppelin Contracts

### 智能合约安全测试

根据具体场景测试：

- Reentrancy
- Access Control
- Arithmetic Errors
- Signature Replay
- Oracle Manipulation
- Unauthorized Mint
- Unauthorized Burn
- Flash Loan Attack
- Front-running
- MEV
- Initialization Attack
- Upgrade Authorization

---

## 第七条：基础设施必须可复现

整个 KarmaChain 的基础设施必须尽可能做到：

> **任何开发者或者 AI Agent，都可以根据 Git 仓库重新构建环境。**

开发环境、测试环境、Staging、生产环境都应该尽可能通过版本控制进行管理。

### 推荐技术

本地环境：

- Docker
- Docker Compose

云基础设施：

- Terraform

部署：

- Automated Deployment

配置：

- Version Controlled Configuration

区块链：

- Genesis
- Chain Configuration
- Validator Configuration

都应该可以被复现。

最终目标：

```text
Git Repository
      ↓
Clone
      ↓
Install Dependencies
      ↓
Run Setup
      ↓
KarmaChain Development Environment
```

而不是：

```text
“我电脑上有一堆手工改过的配置，
别人不知道怎么跑。”
```

---

## 第八条：测试和验证优先

每一个功能在开始实现之前：

> **必须先定义验证方法。**

测试应该根据功能分层。

### Unit Test

测试：

- 单个函数
- 业务逻辑
- 工具类
- 协议逻辑

### Integration Test

测试：

- Spring Boot
- RPC
- Database
- Blockchain Node

之间的协作。

### Smart Contract Test

测试：

- Contract
- Permission
- Event
- Token
- Security

### E2E Test

测试完整流程：

```text
Frontend
   ↓
Wallet
   ↓
Backend
   ↓
RPC
   ↓
Blockchain
   ↓
Smart Contract
```

特别是：

> **共识相关代码必须有回归测试。**

并且：

> **代码能够编译 ≠ 功能完成。**

真正的 Definition of Done 必须包括：

```text
Implementation
+
Tests
+
Verification
```

---

## 第九条：可观测性原则

生产环境中的每一个核心组件都必须能够被监控和诊断。

不能出现：

```text
系统挂了
 ↓
“我不知道为什么”
```

应该具备：

- Structured Logs
- Metrics
- Health Check
- Error Tracking
- Tracing

### 区块链节点监控

至少应该能够观察：

- Node Health
- Validator Health
- Block Production
- Block Synchronization
- Peer Connectivity
- RPC Availability
- Transaction Failure
- CPU
- Memory
- Disk
- Storage Growth

还必须区分：

- 普通应用错误
- Infrastructure Failure
- Blockchain Sync Failure
- Consensus Failure
- Security Incident

因为这些问题的处理方式完全不同。

---

## 第十条：API 与协议必须明确

不同模块之间的接口必须明确。

包括：

- JSON-RPC
- REST API
- Smart Contract ABI
- Event Schema
- Database Schema
- Message Format
- Configuration Schema

如果修改了公共 API：

> 必须考虑版本兼容。

尤其是：

- Smart Contract ABI
- JSON-RPC

它们应该被视为长期存在的公共接口。

---

## 第十一条：严格进行模块职责划分

整个系统应该保持清晰的架构边界：

```text
Blockchain
     ↓
EVM / Smart Contract
     ↓
RPC
     ↓
Indexer / Backend
     ↓
Frontend / DApp
```

每一层必须有明确职责。

### Frontend

不能直接：

```text
Vue → MySQL
```

应该：

```text
Vue
 ↓
Spring Boot
 ↓
Database
```

或者需要链上数据时：

```text
Vue
 ↓
RPC
 ↓
Blockchain
```

### Smart Contract

不能依赖：

- Spring Boot
- MySQL
- Redis

智能合约必须能够独立按照区块链规则执行。

### Backend

应该通过：

- RPC
- Blockchain Client

访问区块链。

### Indexer

必须被视为：

> **区块链数据的派生系统。**

而不是区块链的权威数据源。

---

## 第十二条：AI 辅助开发治理原则

这一条对于使用 **Spec Kit** 特别重要。

AI Agent 是项目中的正式开发工具，但：

> **AI Agent 不是架构真理的最终来源。**

AI 必须服从：

```text
Constitution
    ↓
Specification
    ↓
Plan
    ↓
Tasks
```

而不能：

```text
AI觉得这样比较好
       ↓
直接修改架构
```

### AI Agent 必须做到

1. 实现之前读取相关 Specification。
2. 遵守现有架构边界。
3. 没有理由不得增加新的依赖。
4. 不能偷偷改变协议行为。
5. 修改功能必须同步增加或修改测试。
6. 涉及安全的问题必须记录安全考虑。
7. 不知道的时候必须明确说“不确定”，不能自己编造 Avalanche 协议行为。
8. 优先使用项目已有模式，而不是重新发明另一套架构。

### AI Agent 明确禁止做的事情

AI：

- 不得未经 Specification 修改 Consensus。
- 不得自己创造协议。
- 不得自己猜 RPC 行为。
- 不得把 Secret 写进代码。
- 不得为了测试通过而关闭安全机制。
- 不得通过删除失败测试来让测试通过。

例如以下行为都是禁止的：

```text
AI
 ↓
“我觉得这个共识更好”
 ↓
修改 Consensus
```

或者：

```text
mvn test
 ↓
测试失败
 ↓
删除失败测试
```

---

## 第十三条：依赖和技术选型原则

引入新的依赖必须有明确价值。

优先选择：

- 成熟
- 稳定
- 广泛使用
- 维护活跃
- 安全审查充分

的开源项目。

特别是核心组件：

- Consensus
- Cryptography
- Blockchain
- Smart Contract
- Database
- Deployment

不要随便更换。

如果要替换核心技术：

> 必须进行明确的架构决策。

---

## 第十四条：文档与架构决策必须可追踪

任何重要架构决策都必须记录。

至少说明：

- 决定了什么？
- 为什么？
- 考虑过哪些替代方案？
- 有什么影响？
- 以后如何迁移？

例如：

- 为什么选择 Avalanche L1？
- 为什么使用 EVM？
- 为什么使用 Solidity？
- 为什么使用 Spring Boot？
- 为什么使用 PostgreSQL？
- 为什么使用 Blockscout？

这些都应该能够追溯。

### 区块链参数必须记录

例如：

- Chain ID
- Native Token Symbol
- Token Supply
- Gas Configuration
- Block Parameters
- Validator Configuration
- Genesis Configuration
- Network ID

并且：

> 文档必须与实际运行系统保持一致。

---

## 第十五条：协议变更控制原则

任何影响区块链协议行为的修改，都必须被视为：

> **Protocol Change（协议变更）**

包括：

- Genesis
- Chain ID
- Native Token Economics
- Gas Rules
- Block Production
- Transaction Validation
- State Transition
- Validator Behavior
- VM Behavior
- Consensus
- Precompiled Contracts
- RPC Semantics

协议变更必须：

```text
① 有明确 Specification
       ↓
② 说明兼容性影响
       ↓
③ 说明升级 / Migration 方法
       ↓
④ 增加 Regression Test
       ↓
⑤ Review
       ↓
⑥ Implementation
```

尤其重要：

> **不能在实现其他普通功能的时候，偷偷修改区块链协议。**

例如 AI 在做：

```text
用户余额查询
```

结果顺手修改：

```text
Gas calculation
```

这是禁止的。

---

## 第十六条：协议配置必须有唯一事实来源

区块链中有很多非常重要的参数：

- Chain ID
- Network ID
- Native Token
- Genesis
- Gas
- Validator

这些参数必须有：

> **Single Source of Truth（唯一事实来源）**

例如：

```text
Chain ID = 20260
```

不能出现：

```text
genesis.json     → 20260
application.yml  → 20261
frontend         → 20260
.env              → 99999
README            → 20260
```

应该设计成：

```text
Protocol Config
       │
       ├── Genesis
       ├── Backend
       ├── Frontend
       ├── Deployment
       └── Tests
```

其他系统尽可能读取或者生成配置，而不是自己硬编码。

---

## 第十七条：Definition of Done

一个功能只有同时满足以下条件，才能认为：

> **完成。**

### 1. Specification 满足

功能符合需求规格。

### 2. Constitution 满足

没有违反项目宪法。

### 3. 测试通过

相关自动化测试全部通过。

### 4. 安全评估完成

如果涉及安全，需要完成安全分析。

### 5. 文档更新

如果功能改变了架构或行为，必须更新文档。

### 6. 可观测性完成

需要监控的功能必须具备对应日志、Metrics、Health Check 等。

### 7. 部署配置完成

如果需要部署变更，则必须同步修改部署配置。

### 8. 没有已知的严重回归问题

特别是：

> **区块链协议修改不能以“代码编译成功”作为完成标准。**

---

## 第十八条：宪法治理规则

这份 Constitution 是：

> **KarmaChain 项目的最高级别工程规则。**

下面所有东西都必须服从它：

```text
Specification
     ↓
Plan
     ↓
Tasks
     ↓
Source Code
     ↓
Infrastructure
     ↓
AI-generated Code
```

如果代码与 Constitution 冲突：

> 必须修改代码。

或者：

> 正式修改 Constitution。

但是：

> **不能偷偷绕过 Constitution。**

---

## 第十九条：修改 Constitution 的规则

如果未来需要修改宪法，必须明确记录：

- 为什么修改？
- 修改了哪些原则？
- 影响哪些系统？
- 是否影响兼容性？
- 是否需要 Migration？
- 需要增加哪些测试？

然后同步更新：

```text
Constitution
Specification
Documentation
Tests
Implementation
```

---

## 第二十条：版本

```text
Constitution Version: 1.1.0

Status: Active
```

### 修订记录

| 版本 | 日期 | 修改 |
|---|---|---|
| 1.1.0 | 2026-09-01 | 第四条增补"公开已知的本地开发密钥"例外。**为什么**：功能 001 需要在仓库内提供 ewoq/Anvil 公开测试账户与本地验证者密钥以满足第七条可复现性；原条文绝对措辞与此冲突。**影响**：仅本地开发网络工件（`blockchain/accounts/`、`blockchain/validators/dev/`）；不影响生产安全边界。**兼容性**：无协议影响。**Migration**：无。**测试**：`tests/e2e/secret-scan.test.mjs` 的白名单机制即本例外的执行面。 |
| 1.0.0 | 2026-08-31 | Initial Draft |
