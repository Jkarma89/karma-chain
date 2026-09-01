# Data Model: 本地可复现的 Avalanche L1 开发网络

**Feature**: `001-local-avalanche-devnet` | **Date**: 2026-09-01 | **Phase**: 1

本功能没有数据库；"数据"是**版本化的配置文件**与**运行时状态**。下面按 spec 的 Key Entities 展开字段、约束、关系与状态迁移。

## 1. Protocol Config（协议参数，唯一事实来源）

文件：`blockchain/protocol.json`（JSON Schema 见 `contracts/protocol-config.schema.json`）

| 字段 | 类型 | 值 / 约束 | 派生到 |
|---|---|---|---|
| `name` | string | `"KarmaChain"` | 文档 |
| `environment` | enum | `"dev"`（本功能只允许 dev） | 目录、标签、启动输出警告 |
| `configVersion` | semver | `"1.0.0"`；任何字段变更需递增并走宪法第十五条流程 | 创世漂移测试、ADR |
| `chain.chainId` | uint | **20189** | Genesis `config.chainId`、验证、文档、MetaMask 说明 |
| `chain.reservedMainnetChainId` | uint | **20188**；启动断言 `chainId != reservedMainnetChainId` | 文档、验证 |
| `chain.blockchainName` | string | `"karmachain"`（CLI blockchain 名 = RPC 别名） | CLI 命令、RPC 路径 |
| `avalanche.networkId` | uint | **1337**（CLI 本地网络） | 验证（`info.getNetworkID`）、文档 |
| `avalanche.avalanchegoVersion` | string | `"v1.14.1"` | Dockerfile、CLI 标志 |
| `avalanche.subnetEvmVersion` | string | `"v0.8.0"` | Dockerfile、CLI 标志 |
| `avalanche.avalancheCliVersion` | string | `"v1.9.6"` | Dockerfile 基础镜像标签 |
| `avalanche.rpcChainVmProtocol` | uint | `44`；断言与上两者兼容表一致 | 单元测试 |
| `nativeToken.name/symbol/decimals` | string/string/uint | `KarmaCoin` / `KARMA` / `18` | CLI `--evm-token`、文档、验证 |
| `feeConfig.*` | uint (8 个字段) | 见 research R-08 | Genesis `config.feeConfig` |
| `allowFeeRecipients` | bool | `false` | Genesis |
| `blockProduction.mode` | enum | `"on-demand"`（Subnet-EVM 行为，只读记录） | 文档、验证策略 |
| `blockProduction.targetBlockRateSeconds` | uint | `2`（= feeConfig.targetBlockRate，单元测试断言相等） | 文档 |
| `primaryNetwork.nodeCount` | uint | `2` | CLI `network start --num-nodes` |
| `validators.count` | uint | **5**；= `validators.nodes.length` | CLI `--num-bootstrap-validators` |
| `validators.management` | enum | `"proof-of-authority"` | CLI `--proof-of-authority` |
| `validators.ownerAccount` | string(label) | `"ewoq"`（引用 devAccounts.label） | CLI `--validator-manager-owner` |
| `validators.nodes[i]` | object | `{ index, httpPort, stakingPort, keyDir }`；端口两两互异且不与 primary/socat 冲突 | CLI `--http-port/--staking-port/--staking-*-key-path` |
| `devAccounts[i]` | object | `{ label, address, balanceWei, source }`；address 唯一、EIP-55 校验和；balanceWei 为 `0x` 十六进制 | Genesis `alloc`、启动输出、验证 |
| `endpoints.hostRpcPort` | uint | `8545` | compose 端口映射、socat、文档 |
| `endpoints.rpcPath` | string | `"/ext/bc/karmachain/rpc"`（= `/ext/bc/{blockchainName}/rpc`，测试断言） | 文档、验证、后续组件 |
| `endpoints.rpcUrl` | string（派生，不存储） | `http://127.0.0.1:{hostRpcPort}{rpcPath}` | 启动输出 |

**校验规则（单元测试）**：schema 合法；`chainId ≠ reservedMainnetChainId`；`networkId ∉ {1, 5}`；`validators.count == nodes.length == 5`；端口唯一；每个 devAccount 在 `blockchain/accounts/dev-accounts.json` 中有对应私钥条目；`sum(balanceWei)` 等于文档中的初始供应。

## 2. Dev Account Keys（开发账户密钥，公开、仅本地）

文件：`blockchain/accounts/dev-accounts.json`

| 字段 | 说明 |
|---|---|
| `warning` | 固定字串 `"DEVELOPMENT ONLY — publicly known keys, never use in production"` |
| `accounts[i].label` | 与 protocol.json `devAccounts[i].label` 一一对应 |
| `accounts[i].address` | EIP-55 |
| `accounts[i].privateKey` | `0x` 十六进制 |
| `accounts[i].source` | `"avalanche-ewoq"` 或 `"foundry-anvil-default-#n"` |

关系：`protocol.json.devAccounts` ⟷ `dev-accounts.json.accounts`（按 label 连接；单元测试断言地址一致）。

## 3. Dev Validator Keys（开发验证者密钥）

目录：`blockchain/validators/dev/node-{1..5}/`

| 文件 | 说明 |
|---|---|
| `staker.crt` / `staker.key` | TLS 证书与私钥 → 决定 NodeID |
| `signer.key` | BLS 签名密钥 |
| `README.md` | DEVELOPMENT ONLY 警告与 NodeID 记录 |

关系：`protocol.json.validators.nodes[i].keyDir` → 本目录。运行时 CLI 用其生成节点；NodeID 确定性见 research V-3。

## 4. Validator Manager Alloc Fixture

文件：`blockchain/genesis/validator-manager.alloc.json`

| 字段 | 说明 |
|---|---|
| `extractedFrom` | `{ avalancheCliVersion: "v1.9.6", command: "...", date }` |
| `alloc` | CLI 注入的合约账户：`{ address: { code, storage, balance: "0x0", nonce } }`（TransparentProxy、ProxyAdmin、ValidatorManager 逻辑合约、ValidatorMessages 库） |

约束：地址与 CLI `validatormanagerSDK` 常量一致；e2e 漂移测试重新提取并 diff。

## 5. Genesis（派生产物，版本化）

文件：`blockchain/genesis/karmachain.genesis.json` — 由 `tools/protocol/render-genesis.mjs` 从 (1)+(4) 生成，**提交到仓库**。

结构（Subnet-EVM 格式）：
```text
config.chainId                 ← protocol.chain.chainId
config.feeConfig.*             ← protocol.feeConfig
config.allowFeeRecipients      ← protocol.allowFeeRecipients
config.<hardfork>Block = 0     ← 生成器固定（homestead…istanbul, muirGlacier）
alloc                          ← devAccounts (balance) ∪ fixture.alloc (code/storage)
gasLimit, difficulty, timestamp, nonce, extraData, mixHash, coinbase, parentHash
                               ← 生成器固定常量（保证创世哈希确定性）
```
不变量：`render(protocol, fixture)` 幂等；`git diff` 为空（漂移测试 T-drift）；创世区块哈希跨环境一致（SC-002/003 通过 `eth_getBlockByNumber("0x0")` 核对）。

## 6. Validator Node（运行时）

| 属性 | 来源 |
|---|---|
| `nodeId` | `info.getNodeID` |
| `role` | `primary` (2) / `l1-validator` (5) |
| `httpPort` / `stakingPort` | protocol.json（L1）/ CLI 分配（primary） |
| `healthy` | `GET /ext/health` |
| `bootstrapped` | `info.isBootstrapped(chain)` |
| `peerCount` | `info.peers` |
| `logPath` | `~/.avalanche-cli/…`（V-10） |

## 7. Chain Data（运行时状态，不入版本库）

位置：Docker 命名卷 `karmachain-devnet-data` → 容器 `/root/.avalanche-cli`。

**状态机**：
```text
[absent] --start(首次: create+deploy)--> [running]
[running] --stop--> [stopped(snapshot)]
[stopped] --start--> [running]（高度延续，FR-005）
[running|stopped] --reset(down -v)--> [absent]
[absent|stopped] --start 且 protocol.configVersion/chainId ≠ 卷内记录--> [refused] （FR-021，提示 reset）
```
卷内记录：`/root/.avalanche-cli/karmachain.stamp.json` = `{ configVersion, chainId, genesisSha256 }`，由 entrypoint 在首次部署时写入，启动时比对。

## 8. Verification Report（验证报告）

Schema：`contracts/verification-report.schema.json`。

| 字段 | 说明 |
|---|---|
| `timestamp`, `rpcUrl`, `chainId`, `networkId`, `blockHeight` | 摘要 |
| `checks[i].id` | 如 `node`, `validator`, `rpc`, `chain-id`, `token`, `block-production`, `balance`, `transfer`, `contract`, `rpc-methods` |
| `checks[i].status` | `ok` / `fail` / `skip` / `unsupported` |
| `checks[i].category` | 失败类别枚举（FR-030）：`genesis` `configuration` `node` `validator` `p2p` `rpc` `evm` `transaction` `storage` |
| `checks[i].detail` | 人类可读 |
| `overall` | `ready` / `failed` |

控制台输出形态见 `contracts/cli-interface.md`。
