<!-- GENERATED FROM blockchain/protocol.json + blockchain/protocol-rationale.json by tools/protocol/render-docs.mjs — DO NOT EDIT.
     修改参数：编辑 protocol.json（走宪法第十五条流程）→ npm run protocol:render → 提交。 -->

# KarmaChain 协议参数（dev · configVersion 1.0.0）

宪法第十四条要求记录的全部区块链参数及其取值理由。唯一权威定义：[`blockchain/protocol.json`](../blockchain/protocol.json)。

### 链身份

| 参数 | 值 | 取值理由 |
|---|---|---|
| `chain.chainId` | 20189 | 20189：本地开发网专用。与主网预留值分离，钱包不可能把本地链误认为主网。2026-08-31 核实 ethereum-lists/chains 未被占用；正式发布前需再次核实并注册。 |
| `chain.reservedMainnetChainId` | 20188 | 20188：为 KarmaChain 未来主网预留，本地网络禁止使用（load.mjs 与 preflight 双重断言）。 |
| `chain.blockchainName` | "karmachain" | karmachain：Avalanche CLI 的链名，同时成为稳定的 RPC 别名路径 /ext/bc/karmachain/rpc（避免依赖随机的 BlockchainID）。 |
| `avalanche.networkId` | 1337 | 1337：Avalanche CLI 本地网络的固定 Network ID（区别于主网 1 / Fuji 5，防误连）。取值由 CLI 决定，此处记录并在验证中核对。 |
| `environment` | "dev" | 本文件只描述本地开发网络；生产/Staging 参数将另建文件与目录，禁止从 dev 复制（宪法第四条）。 |
| `configVersion` | "1.0.0" | 协议参数集的版本号；任何字段变更须递增并走宪法第十五条协议变更流程（stamp 机制会拒绝启动旧链数据）。 |

### Avalanche 组件版本（锁定）

| 参数 | 值 | 取值理由 |
|---|---|---|
| `avalanche.avalanchegoVersion` | "v1.14.1" | v1.14.1：与 Subnet-EVM v0.8.0 同为 RPCChainVM 协议 44 的最新稳定组合（v1.14.2 已是协议 45，CLI 无法直接搭配独立发行的 Subnet-EVM）。 |
| `avalanche.subnetEvmVersion` | "v0.8.0" | v0.8.0：subnet-evm 独立仓库归档前的最后版本（其后并入 avalanchego 同版本发布）；协议 44。 |
| `avalanche.avalancheCliVersion` | "v1.9.6" | v1.9.6：Avalanche CLI 最后一个正式版（2025-12 起维护模式）；唯一可脚本化编排本地 L1 全流程的官方工具。风险与迁移路径见 ADR-0002。 |
| `avalanche.rpcChainVmProtocol` | 44 | 44：avalanchego 与 subnet-evm 之间的 gRPC 协议版本；load.mjs 依内置兼容表断言两者匹配。 |

### 原生代币

| 参数 | 值 | 取值理由 |
|---|---|---|
| `nativeToken.name` | "KarmaCoin" | KarmaCoin：项目命名决策（2026-08-31 用户裁定）。 |
| `nativeToken.symbol` | "KARMA" | KARMA：项目命名决策；钱包与工具显示用。 |
| `nativeToken.decimals` | 18 | 18：以太坊生态事实标准，保证 ethers/viem/钱包的默认单位换算全部适用。 |
| `allowFeeRecipients` | false | false：手续费销毁（官方默认）。改为 true 属代币经济学变更，须走协议变更流程。 |

### Gas / 费用（Subnet-EVM feeConfig）

| 参数 | 值 | 取值理由 |
|---|---|---|
| `feeConfig.gasLimit` | 15000000 | 15,000,000：Subnet-EVM 官方默认（宪法第三条：不引入偏离）。 |
| `feeConfig.targetBlockRate` | 2 | 2 秒：Subnet-EVM 官方默认目标出块节拍（费率算法用；实际无交易不出块）。 |
| `feeConfig.minBaseFee` | 25000000000 | 25 gwei：Subnet-EVM 官方默认基础费下限。 |
| `feeConfig.targetGas` | 15000000 | 15,000,000：官方默认的 10 秒滚动窗口目标 gas。 |
| `feeConfig.baseFeeChangeDenominator` | 36 | 36：官方默认的基础费调整分母。 |
| `feeConfig.minBlockGasCost` | 0 | 0：官方默认。 |
| `feeConfig.maxBlockGasCost` | 1000000 | 1,000,000：官方默认。 |
| `feeConfig.blockGasCostStep` | 200000 | 200,000：官方默认。 |

### 出块

| 参数 | 值 | 取值理由 |
|---|---|---|
| `blockProduction.mode` | "on-demand" | on-demand：Subnet-EVM 的固有行为（无待处理交易不构建区块，源码 block_builder.go 证实）；此字段为记录性质，提醒工具与文档不要把空闲期高度不增长当故障。 |
| `blockProduction.targetBlockRateSeconds` | 2 | 2：与 feeConfig.targetBlockRate 相同（load.mjs 断言相等），冗余存放便于非 Gas 语境引用。 |

### 拓扑与验证者

| 参数 | 值 | 取值理由 |
|---|---|---|
| `primaryNetwork.nodeCount` | 2 | 2：Avalanche CLI 本地 Primary Network 默认规模；对开发者透明，无需更多。 |
| `validators.count` | 5 | 5：2026-08-31 用户裁定（Q1=B）。可在本地暴露多验证者共识/同步行为；默认 Snow 参数下容忍 1 个离线（research R-05）。 |
| `validators.management` | "proof-of-authority" | proof-of-authority：本地开发无质押经济需求；ValidatorManager 由 Avalanche CLI 部署（官方合约）。 |
| `validators.ownerAccount` | "ewoq" | ewoq：Avalanche 官方公开测试账户，CLI 在本地网络为其预置 P/C 链资金，可直接支付 P-Chain 交易并担任 PoA 管理员。 |
| `validators.nodes` | 见下 | 端口 9660-9669（HTTP/staking 交替）：避开 CLI 主网节点默认区间 9650-9653 与对外 RPC 端口；keyDir 指向仓库内 DEVELOPMENT ONLY 密钥，保证 NodeID 跨重建一致。 |
| `validators.nodes[0]` | http 9660 / staking 9661，密钥 `blockchain/validators/dev/node-1/` | ↑ |
| `validators.nodes[1]` | http 9662 / staking 9663，密钥 `blockchain/validators/dev/node-2/` | ↑ |
| `validators.nodes[2]` | http 9664 / staking 9665，密钥 `blockchain/validators/dev/node-3/` | ↑ |
| `validators.nodes[3]` | http 9666 / staking 9667，密钥 `blockchain/validators/dev/node-4/` | ↑ |
| `validators.nodes[4]` | http 9668 / staking 9669，密钥 `blockchain/validators/dev/node-5/` | ↑ |

### 创世开发账户

| 参数 | 值 | 取值理由 |
|---|---|---|
| `devAccounts` | 共 6 个，初始供应 6000000 KARMA | ewoq + Foundry Anvil 默认账户 #0-#4，各 1,000,000 KARMA（合计 6,000,000 初始供应）：让 Foundry/Hardhat/MetaMask 零配置可用；密钥公开，仅限本地（宪法第四条 v1.1.0 例外条款）。 |
| `ewoq` | 0x8db97C7cEcE249c2b98bDC0226Cc4C2A57BF52FC（1000000 KARMA，avalanche-ewoq） | ↑ |
| `anvil-0` | 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266（1000000 KARMA，foundry-anvil-default-#0） | ↑ |
| `anvil-1` | 0x70997970C51812dc3A010C7d01b50e0d17dc79C8（1000000 KARMA，foundry-anvil-default-#1） | ↑ |
| `anvil-2` | 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC（1000000 KARMA，foundry-anvil-default-#2） | ↑ |
| `anvil-3` | 0x90F79bf6EB2c4f870365E785982E1f101E93b906（1000000 KARMA，foundry-anvil-default-#3） | ↑ |
| `anvil-4` | 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65（1000000 KARMA，foundry-anvil-default-#4） | ↑ |

### 端点

| 参数 | 值 | 取值理由 |
|---|---|---|
| `endpoints.hostRpcPort` | 8545 | 8545：EVM 生态惯例端口（Anvil/Hardhat/geth 同款），MetaMask 等工具默认友好；可被宿主 .env 覆盖而不影响链身份。 |
| `endpoints.rpcPath` | "/ext/bc/karmachain/rpc" | /ext/bc/karmachain/rpc：由 blockchainName 派生（load.mjs 断言），Avalanche 节点的标准链路径 + CLI 设置的别名。 |

### 派生值（不存储，由 `tools/protocol/load.mjs derive()` 计算）

| 派生值 | 值 |
|---|---|
| Chain ID（十六进制） | `0x4edd` |
| 宿主 RPC URL | `http://127.0.0.1:8545/ext/bc/karmachain/rpc` |
| 宿主 WS URL | `ws://127.0.0.1:8545/ext/bc/karmachain/ws` |
| 初始供应 | 6000000 KARMA（6000000000000000000000000 wei） |
| 节点总数 | 7（2 主网 + 5 L1） |
| 创世区块哈希（实测基准） | `0xcd807715b50b5eaba52dd332cce379da66704b443b1439e881e11751b88d3efa` |

### 创世配置

创世文件 [`blockchain/genesis/karmachain.genesis.json`](../blockchain/genesis/karmachain.genesis.json) 由本参数集 + ValidatorManager fixture 确定性生成（固定创世时间 2026-09-01T00:00:00Z），详见 [`blockchain/genesis/README.md`](../blockchain/genesis/README.md)。
