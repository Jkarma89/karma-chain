# Contract: KarmaChain Devnet JSON-RPC Endpoint

**Feature**: `001-local-avalanche-devnet` | **Status**: Draft | **Stability**: 长期公共接口（宪法第十条）——后续 backend / indexer / frontend / contracts 功能全部依赖本契约。

## 端点

| 项 | 值 | 来源 |
|---|---|---|
| 宿主机 RPC URL | `http://127.0.0.1:8545/ext/bc/karmachain/rpc` | `protocol.json` → `endpoints.hostRpcPort` + `endpoints.rpcPath` |
| WebSocket | `ws://127.0.0.1:8545/ext/bc/karmachain/ws` | Subnet-EVM 标准路径；实现期确认 socat 转发对 WS 透明（V-8） |
| EVM Chain ID | `20189` (`0x4edd`) | `protocol.json` → `chain.chainId` |
| Avalanche Network ID | `1337` | `protocol.json` → `avalanche.networkId` |
| 原生代币 | KarmaCoin / `KARMA` / 18 decimals | `protocol.json` → `nativeToken` |
| 节点直连（容器内） | L1 节点 i：`http://127.0.0.1:{validators.nodes[i].httpPort}/ext/bc/karmachain/rpc` | 仅用于验证脚本与排障 |
| 节点 Info / Health API | `…:{httpPort}/ext/info`、`…:{httpPort}/ext/health` | avalanchego 标准 |

任何组件 **MUST** 从 `blockchain/protocol.json` 读取或由构建步骤生成上述值，**MUST NOT** 硬编码（FR-017）。

## 必须验证的 JSON-RPC 方法（FR-012）

| 方法 | 验证方式 | 期望 | 支持状态 |
|---|---|---|---|
| `eth_chainId` | 调用 | `0x4edd` | 待实现期填写（V-9） |
| `eth_blockNumber` | 调用两次，中间发一笔交易 | 第二次 > 第一次 | 待填写 |
| `eth_getBlockByNumber` | `("0x0", false)` 与 `("latest", true)` | 创世哈希跨环境一致；latest 含交易 | 待填写 |
| `eth_getBlockByHash` | 用上一步的哈希 | 与 byNumber 结果一致 | 待填写 |
| `eth_getBalance` | 每个 devAccount `("latest")` | 首次启动等于创世 `balanceWei` | 待填写 |
| `eth_getTransactionCount` | 发送前后 | nonce +1 | 待填写 |
| `eth_sendRawTransaction` | 签名的 EIP-1559 转账 | 返回 32 字节哈希 | 待填写 |
| `eth_getTransactionByHash` | 上一步哈希 | `from/to/value/blockNumber` 正确 | 待填写 |
| `eth_getTransactionReceipt` | 上一步哈希 | `status=0x1`、`gasUsed>0`、`blockNumber` 匹配 | 待填写 |
| `eth_call` | 对 `Counter.sol` 的 `count()` | 与写入后的值一致 | 待填写 |

实现期每个方法的实际结果写入本表"支持状态"列（`supported` / `unsupported: <reason>`），并同步到 `docs/devnet.md`（SC-010：0 个"未知"）。

## 行为约定（源于 Subnet-EVM，非本项目自定义）

- **无交易不出块**：链空闲时 `eth_blockNumber` 不增长；这是 Subnet-EVM 的设计，不是故障。客户端不应以"高度是否增长"作为空闲期健康判据。
- **EVM 版本 = Cancun**：不支持 Pectra 指令；部署合约时 Solidity 需 `evmVersion: cancun`。
- 默认仅启用 `eth` 命名空间（`personal/txpool/debug` 未启用），与 Subnet-EVM 默认一致。
- 手续费销毁（`allowFeeRecipients=false`），EIP-1559 动态基础费，`minBaseFee` 25 gwei。

## 兼容性承诺

- URL、Chain ID、代币符号、方法语义在本功能范围内视为稳定；变更须走宪法第十五条协议变更流程并更新本文件。
- `hostRpcPort` 可由开发者通过环境变量覆盖（端口冲突场景），但**默认值**只在 `protocol.json` 定义。
