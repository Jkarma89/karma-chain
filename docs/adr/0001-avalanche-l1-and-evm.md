# ADR-0001：以 Avalanche L1 + EVM 作为 KarmaChain 的链层

**状态**：已接受 · **日期**：2026-09-01 · **相关**：宪法第一/三/十一条，功能 001

## 决定了什么

KarmaChain 的区块链层是一条 **Avalanche L1（原 Subnet）**，其虚拟机为 **Subnet-EVM**，即完整的
EVM 兼容执行环境；本地开发网络不复用 Avalanche 主网/测试网的 C-Chain，而是自建独立 L1
（`blockchain/protocol.json` → `chain.chainId = 20189`、`avalanche.networkId = 1337`）。

对外契约是标准 Ethereum JSON-RPC（`specs/001-local-avalanche-devnet/contracts/rpc-endpoint.md`），
合约用 Solidity 编写，账户模型、Gas、交易、事件、回执全部沿用以太坊语义，不做任何偏离。

## 为什么

1. **专有链 + 生态复用兼得**：Avalanche L1 让我们完全掌握链的参数、验证者集合与出块规则（宪法第十六条要求这些参数由项目自己定义），而 EVM 让我们直接继承 Ethereum 的工具链与标准。
2. **零适配的工具链**（宪法第三条明确要求）：实测 MetaMask、Foundry `cast`、viem 三类工具**无需任何自定义适配**即可连接、转账、部署合约（`docs/devnet.md` §3）。这一条自建 VM 或非 EVM 链都做不到。
3. **标准优先**：ERC-20/721、OpenZeppelin、Hardhat/Foundry、区块浏览器（Blockscout）等后续组件全部可以直接使用，不需要为 KarmaChain 单独造轮子。
4. **独立 L1 而非 C-Chain**：C-Chain 的参数由 Avalanche 主网治理，我们无法决定 Gas 规则与代币经济学；而这些正是 KarmaChain 需要自主的部分。

## 考虑过的替代方案

| 方案 | 否决理由 |
|---|---|
| 直接在 Avalanche C-Chain 上做智能合约 | 无法自主决定链参数、代币与验证者；不满足"专有链"目标 |
| 以太坊 L2（Rollup） | 依赖 L1 结算与排序器，主权与运维模型复杂度更高；本项目不需要继承以太坊安全性 |
| 自建非 EVM VM（如自研或 WASM VM） | 丧失全部 Ethereum 生态工具，违反宪法第三条；开发与审计成本高得多 |
| Cosmos SDK / 其他生态 | 需要另一套工具链与人才储备，且丧失 EVM 兼容 |

## 影响

- **正面**：工具链零成本、开发者上手快、合约可复用成熟审计库；链参数完全自主。
- **约束**：必须持续保持 EVM 兼容——任何偏离标准的行为都要在协议参数文档中显式记录并说明原因（宪法第三条）。目前**零偏离**。
- **已知限制**：Subnet-EVM 实现到 **Cancun** 硬分叉，尚不支持 Pectra；而 solc 0.8.30+ 默认目标是 Pectra。因此编译合约必须显式指定 `evmVersion: "cancun"`（已固化在 `tools/verify/lib/solc.mjs` 并写入 RPC 契约）。
- **依赖 Avalanche 生态**：节点软件、共识、VM 均来自 ava-labs；版本锁定与升级策略见 ADR-0002。

## 迁移 / 演进

- 换 VM 或放弃 EVM 兼容 = 协议变更，须走宪法第十五条流程（新规格 → 兼容性影响 → 迁移方案 → 回归测试 → Review）。
- 未来上主网时链层选型不变，仅协议参数（Chain ID 20188、验证者集合、代币经济学）另行规格化；本地开发网的参数**不得**直接复制到生产（FR-025）。
