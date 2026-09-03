<!-- GENERATED FROM blockchain/protocol.json by tools/protocol/render-developer-quickstart.mjs — DO NOT EDIT. -->

# 在 KarmaChain 上开发智能合约

面向**外部合约开发者**。你不需要访问链的基础设施仓库——本文加上链本身的 RPC 就是全部所需。
机器可读版本：[`chain-info.json`](chain-info.json)。

> 当前环境是 **dev（开发网）**。链上无真实价值，随时可能被重置。

## 1. 连接信息

| 项 | 值 |
|---|---|
| 网络名称 | KarmaChain Local |
| RPC (HTTP) | `http://127.0.0.1:8545/ext/bc/karmachain/rpc` |
| RPC (WebSocket) | `ws://127.0.0.1:8545/ext/bc/karmachain/ws` |
| Chain ID | **20189**（`0x4edd`） |
| 原生代币 | KarmaCoin（**KARMA**，18 位小数） |
| 区块浏览器 | 暂未提供 |

自检（应返回 `0x4edd`）：

```bash
curl -s -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
  http://127.0.0.1:8545/ext/bc/karmachain/rpc
```

确认连的是同一条链实例（创世哈希应完全一致）：

```bash
curl -s -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":["0x0",false]}' \
  http://127.0.0.1:8545/ext/bc/karmachain/rpc | grep -o '"hash":"0x[0-9a-f]*"' | head -1
# 期望: 0x19cfde1f02e585020cdae83071bac33c7d81e411cacf7f306b82ceabe98892ed
```

## 2. ⚠️ 必须设置 `evmVersion = cancun`

**这是本链最容易踩的坑，请先读这一节。**

KarmaChain 的 EVM 实现到 **Cancun** 分叉，**不支持 Pectra**；而 Solidity 0.8.30 起默认编译目标已是 Pectra。
不显式指定 `cancun`，编译出的字节码可能包含本链无法执行的指令——**测试全绿、部署即失败**。

| 工具 | 配置 |
|---|---|
| Foundry | `foundry.toml` → `evm_version = "cancun"` |
| Hardhat | `solidity: { settings: { evmVersion: "cancun" } }` |
| solc (JSON) | `{ "settings": { "evmVersion": "cancun" } }` |

可向链求证（`cancunTime` 有值、且**不存在** `prague`/`pectra` 字段）：

```bash
curl -s -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_getChainConfig","params":[]}' \
  http://127.0.0.1:8545/ext/bc/karmachain/rpc
```

## 3. 获取测试代币

开发网使用**生态公开的测试账户**，与 Foundry Anvil / Hardhat 默认账户一致，因此多数工具的默认配置可直接使用。

> ⚠️ 这些私钥**全网公开**。仅在本开发网有效（Chain ID 20189 / Network ID 1337）。
> **绝不可用于任何真实网络，也不要向这些地址转入任何有价值的资产。** 建议在钱包里使用独立的测试 Profile。

助记词：`test test test test test test test test test test test junk`（派生路径 `m/44'/60'/0'/0/{index}`）

| 账户 | 地址 | 创世余额 |
|---|---|---|
| `ewoq` | `0x8db97C7cEcE249c2b98bDC0226Cc4C2A57BF52FC` | 1,000,000 KARMA |
| `anvil-0` | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` | 1,000,000 KARMA |
| `anvil-1` | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` | 10,000,000 KARMA |
| `anvil-2` | `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC` | 7,500,000 KARMA |
| `anvil-3` | `0x90F79bf6EB2c4f870365E785982E1f101E93b906` | 10,000,000 KARMA |
| `anvil-4` | `0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65` | 10,000,000 KARMA |

完整私钥见 [`chain-info.json`](chain-info.json) 的 `testAccounts`。

## 4. 用 Foundry 部署一个合约

```bash
forge init my-karmachain-project && cd my-karmachain-project
```

在 `foundry.toml` 里加上（**`evm_version` 不可省略**）：

```toml
[profile.default]
evm_version = "cancun"
chain_id = 20189
```

部署：

```bash
export KARMACHAIN_RPC=http://127.0.0.1:8545/ext/bc/karmachain/rpc
export PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # anvil-0（公开测试账户）

forge create src/Counter.sol:Counter \
  --rpc-url $KARMACHAIN_RPC --private-key $PRIVATE_KEY --broadcast
```

交互：

```bash
cast call <合约地址> "number()(uint256)" --rpc-url $KARMACHAIN_RPC
cast send <合约地址> "increment()" --rpc-url $KARMACHAIN_RPC --private-key $PRIVATE_KEY
```

## 5. 连接钱包（MetaMask 等）

手动添加网络，或用 `chain-info.json` 的 `wallet` 字段调用 EIP-3085 `wallet_addEthereumChain`：

| 字段 | 值 |
|---|---|
| 网络名称 | KarmaChain Local |
| RPC URL | `http://127.0.0.1:8545/ext/bc/karmachain/rpc` |
| 链 ID | 20189 |
| 货币符号 | KARMA |

导入上表任一账户的私钥即可看到余额。

## 6. 你需要知道的链行为

| 行为 | 说明 |
|---|---|
| **无交易不出块** | 链空闲时区块高度不增长（`on-demand`）。这是正常的，不要把静止的高度当作故障 |
| **手续费销毁** | 手续费被销毁，不归任何人 |
| **基础费下限** | 25 gwei（EIP-1559 动态费的下限） |
| **单区块 gas 上限** | 15,000,000 |
| **无许可** | 任何人都可以部署合约、发送交易 |
| **原生代币不可增发** | 包括链的运营方在内，没有任何人能凭空铸造 KARMA |
| **Host 头限制** | RPC 只接受 `Host` 为 `localhost` 或 **IP 字面量** 的请求；用其他主机名会得到 `403 invalid host specified`。容器/代理场景请先把主机名解析成 IP |

## 7. 常见问题

**部署交易失败，或合约行为异常**
先确认 `evmVersion = cancun`（见第 2 节）。这是最常见的原因。

**`403 invalid host specified`**
你的 `Host` 头是主机名。改用 `127.0.0.1`、`localhost` 或直接用 IP。

**区块高度不动**
链空闲时的正常表现，见第 6 节。发一笔交易即会出块。

**余额为 0**
确认导入的是第 3 节表中的账户；开发网被重置后钱包可能缓存旧状态，切换网络再切回可刷新。

**交易 nonce 报错**
开发网重置后钱包缓存的 nonce 会失效。MetaMask：设置 → 高级 → 清除活动标签数据。
