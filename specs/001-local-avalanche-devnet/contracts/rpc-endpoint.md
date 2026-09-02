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

**实测结论（2026-09-02，AvalancheGo v1.14.1 + Subnet-EVM v0.8.0，`scripts/devnet-verify` 的 `rpc-methods` 检查）：10/10 全部支持，无"未知"状态（SC-010 ✅）。**

| 方法 | 验证方式 | 期望 | 支持状态 |
|---|---|---|---|
| `eth_chainId` | 调用 | `0x4edd` | ✅ supported |
| `eth_blockNumber` | 调用两次，中间发一笔交易 | 第二次 > 第一次 | ✅ supported |
| `eth_getBlockByNumber` | `("0x0", false)` 与 `("latest", true)` | 创世哈希跨环境一致；latest 含交易 | ✅ supported |
| `eth_getBlockByHash` | 用上一步的哈希 | 与 byNumber 结果一致 | ✅ supported |
| `eth_getBalance` | 每个 devAccount `("0x0")` 与 `("latest")` | 区块 0 等于创世 `balanceWei` | ✅ supported |
| `eth_getTransactionCount` | 发送前后 | nonce +1 | ✅ supported |
| `eth_sendRawTransaction` | 签名的 EIP-1559 转账 | 返回 32 字节哈希 | ✅ supported（畸形负载探测返回 `-32000`，即方法存在但拒绝该负载；真实转账在 `transfer` 检查中通过） |
| `eth_getTransactionByHash` | 上一步哈希 | `from/to/value/blockNumber` 正确 | ✅ supported |
| `eth_getTransactionReceipt` | 上一步哈希 | `status=0x1`、`gasUsed=21000`、`blockNumber` 匹配 | ✅ supported |
| `eth_call` | 对 `Counter.sol` 的 `count()` | 与写入后的值一致 | ✅ supported |

判定规则（`tools/verify/checks/chain.mjs`）：JSON-RPC 错误码 `-32601`（method not found）判为 **unsupported**；`-32602 / -32000 / -32603`（参数/执行错误）说明方法存在，判为 **supported**。任何 unsupported 都会让验证输出 `[UNSUPPORTED]` 行并要求写入文档。

### 已确认不可用的方法（作弊类，Subnet-EVM 默认只启用 `eth` 命名空间）

`anvil_setBalance`、`hardhat_setBalance`、`evm_setAccountBalance`、`debug_setHead` 均返回 `-32601`。因此**无法直接改写账户余额**——余额只能通过创世分配或链上交易改变（宪法第一条）。

## Host 头约束（源于 avalanchego，实现期确认）

avalanchego 的 `--http-allowed-hosts` 默认仅放行 HTTP `Host` 为 `localhost` 或 **IP 字面量** 的请求，其余返回 **403 "invalid host specified"**（`api/server/allowed_hosts.go`）。socat 代理只转发 TCP，不改写 Host。因此：

- 宿主机：`http://127.0.0.1:8545/...` 与 `http://localhost:8545/...` 均可用；
- Docker Compose 内网：**不要**用服务名 `http://devnet:8545/...`，要先解析为 IP（`tools/verify/lib/rpc.mjs` 已自动处理），或显式发送 `Host: localhost`；
- 通过其他域名反向代理接入时需改写 Host 或另行配置节点 allowed-hosts（不在本功能范围）。

## 行为约定（源于 Subnet-EVM，非本项目自定义）

- **无交易不出块**：链空闲时 `eth_blockNumber` 不增长；这是 Subnet-EVM 的设计，不是故障。客户端不应以"高度是否增长"作为空闲期健康判据。
- **EVM 版本 = Cancun**：不支持 Pectra 指令；部署合约时 Solidity 需 `evmVersion: cancun`。
- 默认仅启用 `eth` 命名空间（`personal/txpool/debug` 未启用），与 Subnet-EVM 默认一致。
- 手续费销毁（`allowFeeRecipients=false`），EIP-1559 动态基础费，`minBaseFee` 25 gwei。

## 兼容性承诺

- URL、Chain ID、代币符号、方法语义在本功能范围内视为稳定；变更须走宪法第十五条协议变更流程并更新本文件。
- `hostRpcPort` 可由开发者通过环境变量覆盖（端口冲突场景），但**默认值**只在 `protocol.json` 定义。
