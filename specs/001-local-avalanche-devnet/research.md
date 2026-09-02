# Research: 本地可复现的 Avalanche L1 开发网络

**Feature**: `001-local-avalanche-devnet` | **Date**: 2026-09-01 | **Phase**: 0

所有结论均来自官方仓库源码 / 发行页 / 官方文档（引用于每条末尾），依宪法第十二条不臆测 Avalanche 行为。核实日期 2026-08-31 ~ 2026-09-01。无法在本阶段确证、需在实现阶段用真实运行验证的事项集中列在末尾"实现期验证清单"。

---

## R-01 工具链选型：如何在本地跑一条 Avalanche L1

**Decision**: 使用 **Avalanche CLI v1.9.6**（官方 CLI，最新正式版）编排本地网络与 L1 部署；运行在 Docker 容器内。

**Rationale**:
- 它是唯一"一条命令创建 Subnet → CreateChainTx → ConvertSubnetToL1Tx → 部署 PoA ValidatorManager"的官方工具，覆盖 ACP-77 时代的 L1 全流程，也是官方文档全部示例所用工具。
- v1.9.6 的本地网络底层已改用 **tmpnet**（`pkg/localnet/tmpnet.go`），而非过时的 avalanche-network-runner。
- 提供本功能需要的全部非交互标志：`blockchain create --evm --genesis --vm-version --proof-of-authority --validator-manager-owner --evm-token --force`；`blockchain deploy --local --use-local-machine --num-bootstrap-validators N --http-port --staking-port --staking-cert-key-path/--staking-tls-key-path/--staking-signer-key-path --avalanchego-version/--avalanchego-path`；`network start/stop/clean/status --num-nodes --snapshot-name`。
- 部署后自动为 L1 设置 `blockchainName → blockchainID` 别名，RPC 路径可稳定为 `/ext/bc/karmachain/rpc`（`pkg/localnet/localnetHelpers.go`、`TmpNetSetDefaultAliases`）。
- 机器可读输出：`~/.avalanche-cli/subnets/<name>/sidecar.json` 含 `Networks["Local Network"].RPCEndpoints / BlockchainID / SubnetID / ValidatorManagerAddress`（`pkg/models/sidecar.go`）。

**⚠️ 风险（必须写入 ADR）**: CLI 自 2025-12 进入**维护模式**（"No new features… Only security patches and critical bug fixes"），官方文档页标记 *Deprecated*，推荐替代为 Platform CLI（P-Chain 操作）与 Builder Console（Web 控制台）。两者均不满足本功能："Builder Console" 是网页 UI，不可脚本化、不可复现；Platform CLI 只覆盖 P-Chain 交易，不编排本地节点。因此当前 CLI 仍是本地开发网络的**唯一可脚本化官方路径**。缓解：版本严格锁定 v1.9.6；所有 CLI 调用集中在一个 shell 库（`docker/devnet/lib/avalanche.sh`）中，替换成本可控；记录迁移路径（R-12）。

**Alternatives considered**:
| 方案 | 结论 |
|---|---|
| tmpnet（avalanchego 内置测试网络工具，`tmpnetctl`） | 原生进程、2–50 节点、无 Docker；但 `tmpnetctl` **不支持**创建 Subnet/L1（README："that usage has been supplanted by the `--reuse-network` flag defined for the e2e suite… easier to support defining subnet configuration in the e2e suite in code"），需写 Go 代码；不支持 Windows。作为 CLI 的底层被间接使用。 |
| avalanche-network-runner | 最后发行 v1.8.3（2024-09），CLI 已不再用它做本地网络；不选。 |
| 手工 Docker Compose 跑 5 个 `avaplatform/avalanchego` 容器 + 自写 P-Chain 交易脚本（avalanchejs） | 最透明、无弃用风险，但需自行实现 CreateSubnet/CreateChain/ConvertSubnetToL1、ValidatorManager 部署与初始化、节点跟踪重启——工作量与出错面远超本功能范围；列为 CLI 不可用时的迁移路径（R-12）。 |
| Builder Console / L1 Launcher（Web） | 不可脚本化，违反宪法第七条可复现性。 |

**Sources**: [avalanche-cli README](https://github.com/ava-labs/avalanche-cli) · [CLI 文档（Deprecated 标记）](https://build.avax.network/docs/tooling/avalanche-cli) · [CLI 命令参考](https://build.avax.network/docs/tooling/avalanche-cli/cli-commands) · [本地部署文档](https://build.avax.network/docs/tooling/avalanche-cli/create-deploy-avalanche-l1s/deploy-locally) · [tmpnet 文档](https://build.avax.network/docs/tooling/tmpnet) · avalanchego `tests/fixture/tmpnet/README.md` · [ANR releases](https://github.com/ava-labs/avalanche-network-runner/releases)

---

## R-02 版本锁定：AvalancheGo × Subnet-EVM 协议兼容

**Decision**: **AvalancheGo v1.14.1** + **Subnet-EVM v0.8.0**（RPCChainVM 协议版本 **44**）+ **Avalanche CLI v1.9.6**。

**Rationale**:
- `ava-labs/subnet-evm` 仓库已于 2025-12 **归档**，代码并入 `ava-labs/avalanchego/graft/subnet-evm`；独立发行的最后版本是 v0.8.0（协议 44），对应 AvalancheGo v1.14.0（`README` 兼容表）。
- avalanchego `version/compatibility.json`：协议 44 = `v1.14.0, v1.14.1`；协议 **45 = v1.14.2**。v1.14.2 发行包内含 `subnet-evm-linux-amd64-v1.14.2.tar.gz`（Subnet-EVM 此后随 avalanchego 同版本发布）。
- CLI v1.9.6 通过 `--evm --vm-version` 从 `ava-labs/subnet-evm` releases 下载 VM 并按 `subnet-evm/master/compatibility.json` 校验（`SubnetEVMReleaseURL`、`SubnetEVMRPCCompatibilityURL` 常量），因此它能直接使用的最新 EVM 是 v0.8.0 → 匹配的 AvalancheGo 只能是 v1.14.0 / v1.14.1；取二者中较新的 **v1.14.1**（2026-01-06）。
- 使用 v1.14.2（协议 45）需走 CLI 的 `--custom --vm <path>` 路线并自带 subnet-evm 二进制，脱离 CLI 的兼容性校验；收益（Granite.2 Benchlist 改动）与本地开发无关，不值得。作为升级路径记录（R-12）。

**Alternatives considered**: v1.14.2 + custom VM（见上，推后）；v1.13.5 + v0.7.9（协议 43，更旧，无理由）。

**Sources**: [subnet-evm README（归档说明与兼容表）](https://github.com/ava-labs/subnet-evm) · [avalanchego compatibility.json](https://raw.githubusercontent.com/ava-labs/avalanchego/master/version/compatibility.json) · [avalanchego v1.14.2 release assets](https://github.com/ava-labs/avalanchego/releases/tag/v1.14.2) · avalanche-cli `pkg/constants/constants.go`

---

## R-03 出块模式：Subnet-EVM 无交易不出块

**Decision**: 协议参数记录 `blockProduction.mode = "on-demand"`；FR-011 的"区块高度持续增长"在验证中实现为"发送交易后高度递增（N → N+1 → N+2）"，而非空闲期定时出块。

**Rationale**（源码确证，avalanchego v1.14.2 `graft/subnet-evm/plugin/evm/block_builder.go`）:
- L75-77：`// needToBuild returns true if there are outstanding transactions to be issued`
- L154-159：`waitForNeedToBuild` 循环等待 `needToBuild()` 为真才返回 `PendingTxs` 信号。
- 即：**没有待处理交易就不会构建区块**。`feeConfig.targetBlockRate=2` 只是费率算法的目标节拍，不代表定时出块。

**Impact**: 健康检查中"出块"一项必须由验证脚本主动发交易触发；文档需向开发者说明"链空闲时高度不动是正常现象"。

**Sources**: avalanchego v1.14.2 `graft/subnet-evm/plugin/evm/block_builder.go`

---

## R-04 网络拓扑：2 个主网节点 + 5 个 L1 验证者

**Decision**: `avalanche network start --num-nodes 2`（本地 Primary Network，P/C/X 链）+ `avalanche blockchain deploy karmachain --local --use-local-machine --num-bootstrap-validators 5`（5 个 L1 主权验证者节点）。共 7 个 avalanchego 进程，全部在一个 Docker 容器内。

**Rationale**:
- ACP-77 之后 L1 验证者与 Primary Network 验证者是**不同的节点**：官方本地部署文档默认创建 "two nodes to act as primary validators… and one node to act as sovereign validator for the new L1"。用户裁定 Q1 = 5 验证者，故 L1 节点数为 5；Primary Network 节点保持 CLI 默认 2（`constants.LocalNetworkNumNodes = 2`），其存在对开发者透明。
- 5 个 L1 节点使用固定端口（`--http-port 9660,9662,9664,9666,9668 --staking-port 9661,9663,9665,9667,9669`）避免动态端口（文档示例中 RPC 出现在随机端口 60172）。
- 使用 `--staking-cert-key-path / --staking-tls-key-path / --staking-signer-key-path` 传入仓库内的 5 组开发验证者密钥 → NodeID 确定、跨重建一致（DEVELOPMENT ONLY）。

**资源估算**: 7 个 avalanchego 进程 + 5 个 subnet-evm 插件进程；预计 4–6 GB 内存。**未实测**，SC-001（5 分钟）与内存要求列入实现期验证清单，文档前置条件写"Docker Desktop 分配 ≥ 8 GB 内存"待实测修正。

**Sources**: [本地部署文档](https://build.avax.network/docs/tooling/avalanche-cli/create-deploy-avalanche-l1s/deploy-locally) · [CLI 命令参考](https://build.avax.network/docs/tooling/avalanche-cli/cli-commands) · avalanche-cli `pkg/constants/constants.go`

---

## R-05 共识参数与 5 节点容错

**Decision**: 使用 avalanchego 默认 Snow 参数（k=20, α=15, β=20），不自定义；文档记录容错结论：**5 个等权验证者中允许 1 个离线，2 个离线即停止出块**。

**Rationale**（源码）:
- 默认：`--snow-sample-size`=20、`--snow-quorum-size`=15、`--snow-commit-threshold`=20（节点配置文档）。
- `chains/manager.go` L847-850：`sampleK := consensusParams.K; if uint64(sampleK) > bootstrapWeight { sampleK = int(bootstrapWeight) }` → 采样数以总权重为上限，采样按权重有放回于验证者集合（`snow/validators/set.go` 加权采样），5 个节点不会因 k=20 而失败。
- `snow/engine/snowman/engine.go` L926：`minConnectedStakeToQuery := AlphaConfidence / K` = 15/20 = **75%**。5 等权节点：1 个离线 → 80% ≥ 75% 继续；2 个离线 → 60% < 75% 停止发起查询。
- 因此 spec 边缘用例"单个验证者宕机"的预期结论为"继续出块"，而"两个宕机停止"写入文档作为已知行为。

**Sources**: [节点配置标志](https://build.avax.network/docs/nodes/configure/configs-flags) · avalanchego v1.14.2 `chains/manager.go`、`snow/engine/snowman/engine.go`、`snow/validators/set.go`

---

## R-06 网络标识：Network ID 与 Chain ID

**Decision**:
- **Network ID = 1337**（Avalanche CLI 本地网络常量 `LocalNetworkID = 1337`）。注意：avalanchego 的 `constants.LocalID = 12345`，tmpnet 默认 `defaultNetworkID = 88888`，三者不同；本项目以 CLI 实际启动的网络为准，并在验证中用 `info.getNetworkID` 核对。
- **EVM Chain ID = 20189**（本地开发），**20188 预留主网**（用户裁定 Q2）；2026-08-31 核实 ethereum-lists/chains 两者均未注册（相邻 20261 已占用）。
- 主网 Chain ID 与本地不同 + Network ID 1337 与 Avalanche 主网(1)/Fuji(5) 不同 → 钱包无法误连（spec 边缘用例）。

**Sources**: avalanche-cli `pkg/constants/constants.go` · avalanchego `utils/constants/network_ids.go` · avalanchego `tests/fixture/tmpnet/network.go` · [ethereum-lists/chains](https://github.com/ethereum-lists/chains)

---

## R-07 Genesis 生成与"唯一事实来源"

**Decision**: `blockchain/protocol.json` 为唯一权威；**Genesis 由生成器派生**并提交到仓库，附漂移测试。生成器输入 = `protocol.json` + `blockchain/genesis/validator-manager.alloc.json`（CLI 注入的 ValidatorManager 合约账户固定分配，一次提取、版本化、漂移测试）。

**Rationale**:
- `blockchain create --evm --genesis <file>` 时 CLI **原样导入**创世（`create.go` L316-331 "importing genesis for blockchain"），**不**再注入 ValidatorManager；而主权 L1 的 PoA 初始化依赖创世中位于固定地址的 TransparentProxy / ProxyAdmin / ValidatorManager 合约账户（`pkg/vm/create_evm.go` L135-139 `AddValidatorTransparentProxyContractToAllocations` 等；地址来自 `validatormanagerSDK.*ContractAddress` 常量）。
- 若不带 `--genesis` 让 CLI 自行生成，则只能通过 `--evm-chain-id/--evm-token/--test-defaults` 控制，无法表达多个预置账户与自定义 feeConfig（且 `--genesis` 与 `--evm-chain-id/--*-defaults` 互斥，`create.go` L217）。
- 折中：一次性用 CLI `create --evm --test-defaults --proof-of-authority …` 生成参考创世 → 提取其中带 `code` 的合约账户为固定 fixture；生成器把 protocol.json 的 chainId / feeConfig / 开发账户 alloc 与 fixture 合成完整 Genesis。CLI 版本变化时由漂移测试（e2e 内重新提取并 diff）发现。
- Subnet-EVM 创世格式（`config.chainId`、`config.feeConfig.*`、`alloc[addr].balance` 十六进制 wei、`allowFeeRecipients`）来自官方文档。

**Alternatives considered**: 运行时 jq 覆盖 CLI 生成的创世（无需 fixture，但生成逻辑落在容器 shell 里、不可单元测试、创世不可离线生成）；完全手写创世含合约字节码（等价于 fixture 但无来源追溯）。

**Sources**: avalanche-cli v1.9.6 `cmd/blockchaincmd/create.go`、`pkg/vm/create_evm.go`、`pkg/validatormanager/validatormanager.go` · [Customize Avalanche L1（创世字段）](https://build.avax.network/docs/avalanche-l1s/upgrade/customize-avalanche-l1)

---

## R-08 费用与代币经济参数

**Decision**: 采用 Subnet-EVM 官方默认 feeConfig，不做偏离（宪法第三条）；`allowFeeRecipients=false`（手续费销毁）；原生代币 KarmaCoin / KARMA / 18。

| 字段 | 值 | 来源 |
|---|---|---|
| gasLimit | 15,000,000 | 官方默认 |
| targetBlockRate | 2 | 官方默认（L1） |
| minBaseFee | 25,000,000,000 (25 gwei) | 官方默认 |
| targetGas | 15,000,000 | 官方默认 |
| baseFeeChangeDenominator | 36 | 官方默认 |
| minBlockGasCost | 0 | 官方默认 |
| maxBlockGasCost | 1,000,000 | 官方默认 |
| blockGasCostStep | 200,000 | 官方默认 |

**Rationale**: 本功能不引入任何协议偏离；参数的"理由"即"官方默认、经主网 L1 广泛使用"。后续若要调参属于协议变更（宪法第十五条）。

**Sources**: [Customize Avalanche L1](https://build.avax.network/docs/avalanche-l1s/upgrade/customize-avalanche-l1)

---

## R-09 开发账户与开发验证者密钥

**Decision**:
- **ewoq**（Avalanche 官方公开测试密钥）：地址 `0x8db97C7cEcE249c2b98bDC0226Cc4C2A57BF52FC`，私钥 `56289e99c94b6912bfc12adc093c9b51124f0dc54ac7a766b2bc5ccf558d8027`。CLI 本地网络在 P/C 链为其预置资金，`deploy --local` 用它支付 P-Chain 交易；同时作为 `--validator-manager-owner`（PoA 管理者）。
- 另加 **5 个 EVM 生态公认的本地测试账户**（Foundry Anvil / Hardhat 默认账户 #0–#4，助记词 `test test … junk`），使 Foundry/Hardhat/viem 的默认配置零改动可用。地址与私钥在实现期从 Foundry 官方文档逐字核对后写入 `blockchain/accounts/dev-accounts.json`（实现期验证清单）。
- 每账户创世余额 1,000,000 KARMA（`0xD3C21BCECCEDA1000000` wei）；6 账户合计初始供应 6,000,000 KARMA；合约账户余额 0。
- **开发验证者密钥**：5 组（TLS cert/key + BLS signer key）由 CLI 首次运行生成后提取到 `blockchain/validators/dev/node-{1..5}/`，提交仓库，目录名与每个文件头注释均标 `DEVELOPMENT ONLY`。
- 安全边界（宪法第四条）：这些密钥公开已知、仅本地有效（Network ID 1337 / Chain ID 20189）；`.gitignore` 排除运行时数据；秘密扫描测试对**非** `blockchain/{accounts,validators}/dev/` 路径下的私钥/助记词模式零命中。

**Sources**: [本地部署文档（ewoq）](https://build.avax.network/docs/tooling/avalanche-cli/create-deploy-avalanche-l1s/deploy-locally) · [CLI 命令参考（`--ewoq`、`--staking-*-key-path`）](https://build.avax.network/docs/tooling/avalanche-cli/cli-commands)

---

## R-10 跨平台运行：Docker 封装

**Decision**: 全部链侧逻辑在 Linux 容器内运行；宿主机唯一前置依赖 **Docker Desktop（Windows 需 WSL2 后端）/ Docker Engine + Compose v2**。宿主入口为 `docker compose` 子命令及等价薄封装脚本（`scripts/*.ps1` 与 `scripts/*.sh`，仅转调 compose）。

**Rationale**:
- CLI README："The tool has been tested on Linux and Mac. **Windows is currently not supported.**" 用户当前开发机为 Windows。
- 镜像 `docker/devnet/Dockerfile`：`FROM avaplatform/avalanche-cli:v1.9.6`（官方镜像，Debian trixie-slim）+ 预置 avalanchego v1.14.1 与 subnet-evm v0.8.0 发行二进制到 CLI 缓存目录（`~/.avalanche-cli/bin/avalanchego/avalanchego-v1.14.1/`、`~/.avalanche-cli/bin/subnet-evm/subnet-evm-v0.8.0/`，`binutils.ExistsWithVersion` 以 `binPrefix+version` glob 判定已安装）+ bash/curl/jq/socat；下载物按 sha256 校验并把校验值写入 Dockerfile。运行时加 `--skip-update-check`。
- 链数据持久化于命名卷 `karmachain-devnet-data`（挂载 `/root/.avalanche-cli`）：`stop` 保留、`reset` 删除卷。
- **IPv6**：CLI README 要求 Docker 守护进程开启 IPv6（"ipv6 is used to resolve local bootstrap IPs, and it is not enabled on a docker container by default"）。计划用容器级 `sysctls: net.ipv6.conf.all.disable_ipv6=0` 启用容器内 `::1` 回环；若不足则文档给出 Docker Desktop `daemon.json` 方案。**列入实现期验证清单（高优先级）**。
- **RPC 对外暴露**：avalanchego 默认 `--http-host 127.0.0.1`，容器内回环不可被端口映射直达；CLI 本地节点未见 http-host 标志。方案：容器内 `socat` 把 `0.0.0.0:8545` 转发至 L1 节点 1 的 `127.0.0.1:9660`，compose 映射 `8545:8545`。宿主 RPC 契约固定为 `http://127.0.0.1:8545/ext/bc/karmachain/rpc`（8545 为 EVM 生态惯例端口，MetaMask/Foundry 默认友好）。若实现期发现 CLI/tmpnet 可配置 `http-host`，则移除 socat（简化项）。
- 容器 `stop` 信号处理：entrypoint 捕获 SIGTERM → `avalanche network stop`（保存快照）→ 退出，保证 FR-005 状态保留。

**Alternatives considered**: WSL2 内原生安装 CLI（仅 Windows 可用、macOS/Linux 路径不同，环境不一致）；每节点一个容器的 Compose（见 R-01，需重写编排）。

**Sources**: [avalanche-cli README](https://github.com/ava-labs/avalanche-cli) · avalanche-cli `Dockerfile`、`pkg/binutils/*.go`、`pkg/constants/constants.go` · [Docker Hub avaplatform/avalanche-cli](https://hub.docker.com/r/avaplatform/avalanche-cli/tags)（存在 `v1.9.6` 标签）

---

## R-11 验证与测试工具链

**Decision**: **Node.js 24 LTS**（"Krypton"，当前 Active LTS）+ **viem 2.x**（当前 2.56.1）+ **solc-js 0.8.x**（当前 0.8.36，编译时显式 `evmVersion: "cancun"`），运行于 `node:24-alpine` 容器（compose 服务 `verify`）；单元测试用 Node 内置 `node --test`，不引入额外测试框架。

**Rationale**:
- 一套运行时同时承担：协议配置 → 创世/文档生成（`tools/protocol/`）、网络验证（`tools/verify/`）、单元/集成/E2E 测试。后续 Vue 前端亦是 JS 生态，protocol.json 读取逻辑可复用；Java 后端直接读 JSON。
- Subnet-EVM README 明示："Subnet-EVM and Avalanche C-Chain currently implement the Ethereum **Cancun** fork and do not yet support newer hardforks (such as Pectra). Since Solidity v0.8.30 switched its default target EVM version to Pectra… explicitly set the Solidity compiler's `evmVersion` to `cancun`." → 最小合约 `Counter.sol` 编译必须指定 cancun，写入验证脚本与文档。
- Foundry `cast`/MetaMask 属 SC-004 的"另两类工具"手工验证项，写在 quickstart，不作为构建依赖。
- 宪法第十三条：Node/viem/solc 皆成熟、活跃、广泛使用。

**Alternatives considered**: bash + jq + Foundry `cast`（结构化输出与单元测试困难；需引入 Foundry 镜像）；Python（项目后续技术栈无 Python）。

**Sources**: [Node.js 发行索引](https://nodejs.org/dist/index.json) · [npm viem](https://registry.npmjs.org/viem/latest) · [npm solc](https://registry.npmjs.org/solc/latest) · [subnet-evm README（Cancun 说明）](https://github.com/ava-labs/subnet-evm)

---

## R-12 升级 / 迁移路径（宪法第十四、十五条）

1. **AvalancheGo ≥ v1.14.2（协议 45+）**：Subnet-EVM 二进制改自 avalanchego 发行包获取；CLI 需走 `--custom --vm <path>` 或等待社区维护版 CLI 支持。视为协议变更：先更新 protocol.json 版本字段 → 重新生成创世（fixture 需重提取）→ 跑全部回归 → ADR。
2. **CLI 不可用**：迁移到"Compose 多容器 + avalanchejs 脚本"方案；所有 CLI 调用已封装在 `docker/devnet/lib/avalanche.sh`，对外契约（`contracts/cli-interface.md`）不变。
3. **主网 20188**：本功能的 protocol.json 为 `environment: "dev"`；生产参数另建独立文件与独立 Genesis（不同目录、不同验证者密钥、不同账户），禁止复制 dev 文件（FR-025）。

---

## 实现期验证清单（研究阶段无法确证，必须在实现中用真实运行验证）

| # | 事项 | 若不成立的回退 | **T011 实测结论（2026-09-01）** |
|---|---|---|---|
| V-1 | 容器级 `sysctl net.ipv6.conf.all.disable_ipv6=0` 是否足以满足 CLI 的 IPv6 需求 | 文档要求 Docker Desktop 开启 IPv6（`daemon.json`），或验证 `--public-ip 127.0.0.1` 是否绕过 | ✅ **成立**。容器内 `::1` 可用，`network start` 7 秒就绪，无需改宿主 daemon.json |
| V-2 | 预置到 `~/.avalanche-cli/bin/**` 的二进制能否让 CLI 跳过下载（含 `compatibility.json` 远程拉取是否仍发生） | 改用 `--avalanchego-path`；若 `--evm` 路线仍强制联网则改 `--custom --vm` | ✅ avalanchego / subnet-evm 走软链，零下载。⚠️ **新发现**：deploy 期间 CLI 仍下载了 `signature-aggregator-v0.5.3`（版本来自 GitHub "latest"，`DefaultSignatureAggregatorVersion = latest`）与 `icm-contracts v1.0.0` 4 个文本文件，并写入 `download-cache/latest.json`（缓存 3 小时，`DownloadCacheExpiration`）。→ 处置：Dockerfile 预置两者（sha256 锁定）+ 预置 `latest.json`/`min_cli_version.json` 并在 entrypoint 刷新 mtime，使 CLI 视为缓存有效；T018/T049 用屏蔽 github.com 的方式验证离线启动 |
| V-3 | `--staking-*-key-path` 切片对 5 个本地节点的绑定顺序与 NodeID 确定性 | 放弃固定 NodeID（不影响 SC-002/003），每次重置由 CLI 生成 | ✅ **成立**。密钥从节点 `flags.json`（`staking-tls-cert/key-file-content`、`staking-signer-key-file-content`，base64）提取到 `blockchain/validators/dev/node-{1..5}/`；在全新卷上用 `--staking-*-key-path` 重新部署，5 个 NodeID 与 README **全部一致**，绑定顺序 = `--http-port` 列表顺序 = protocol.json `validators.nodes[]` 顺序 |
| V-4 | `network stop`（快照）/`start` 是否同时恢复 5 个 L1 本地节点与链状态（FR-005） | 在 entrypoint 中显式 `blockchain deploy --local` 的重连逻辑或使用 CLI `node local start` | ✅ **成立**。stop → start 后 5 个 L1 节点全部重启，RPC 可用，高度 0x4 → 0x4 保持 |
| V-5 | `blockchain create` 非交互性：`--icm=false` 是否被识别为显式关闭；PoA owner 通过 `--validator-manager-owner` 后是否仍有提示 | 记录必需标志组合；必要时用 `yes`/expect 兜底并记录原因（FR-002） | ✅ **成立**。`create --evm --test-defaults --evm-chain-id --evm-token --proof-of-authority --validator-manager-owner --proxy-contract-owner --icm=false --force` 与 `deploy --local --ewoq --use-local-machine --num-bootstrap-validators 5 --http-port … --staking-port … --avalanchego-version --skip-icm-deploy --skip-relayer` 全程零提示 |
| V-6 | 7 节点内存占用与 SC-001（5 分钟）达成情况 | 调整文档前置条件；若不可达则向用户提出拓扑复议（不得私自改 5） | ✅ **远优于预期**。network 7s + create 3s + deploy 70s ≈ **80 秒**；7 avalanchego + 5 VM 插件 + 1 aggregator 进程总 RSS ≈ **1.1 GB**。文档前置条件定为 Docker ≥ 4 GB 内存 |
| V-7 | Anvil/Hardhat 默认账户 #0–#4 的地址/私钥逐字核对 | 以 Foundry 官方文档为准修正 `dev-accounts.json` | ✅ **成立**（比查文档更强）：`tests/unit/accounts.test.mjs` 用 viem 从公开助记词 `test … junk` 按 `m/44'/60'/0'/0/i` 重新推导，地址与私钥与 `dev-accounts.json` 逐字一致；ewoq 私钥推导出 `0x8db97C7c…52FC` |
| V-8 | CLI 本地节点是否可配置 `http-host`（若可则去掉 socat） | 保留 socat | ❌ **不可配置**：L1 节点 `flags.json` 固定 `http-host=127.0.0.1`、`public-ip=127.0.0.1`，全部监听回环 → **保留 socat** |
| V-9 | FR-012 十个 RPC 方法在 Subnet-EVM v0.8.0 上的实际支持情况 | 不支持者在文档与验证输出中标注 | ✅ **10/10 全部支持**（`rpc-methods` 检查实测，2026-09-02），零"未知"状态（SC-010）。判定规则：`-32601` 判 unsupported；`-32602/-32000/-32603` 说明方法存在。另确认 `anvil_/hardhat_setBalance`、`evm_setAccountBalance`、`debug_setHead` 均 `-32601` —— 无法直接改写余额 |
| V-10 | `avalanche network status` / `~/.avalanche-cli` 下日志路径与 `info.peers`、`/ext/health` 在 L1 节点上的可用性 | 调整 `status`/`logs` 命令实现 | ✅ **完全确认**（T039/T040 实现并实测）。`/ext/health`、`info.peers`、`info.isBootstrapped`、`info.getNodeID` 在全部 7 个节点可用；**observed peers = 6**（7 节点网络中各自看到其余 6 个，与 spec 修正后的"≥ 4"一致）。节点清单可从 `process.json`/`flags.json` 完整发现（后者在节点停止后仍存在，故实现改用它）。日志：主网 `~/.avalanche-cli/runs/network_<ts>/<NodeID>/logs`，L1 `~/.avalanche-cli/local/<chain>-local-node-local-network/<NodeID>/logs`，含 `main.log`（节点自身）与 `<BlockchainID>.log`（链）。**⚠️ `main.log` 含 staking 私钥的 base64**（avalanchego 启动时转储全部标志）→ `devnet-logs` 默认脱敏（FR-026） |

**T014 实测（2026-09-01，自有创世 + 固定密钥 + GitHub 全域名屏蔽）**：`network start` → `create --genesis blockchain/genesis/karmachain.genesis.json` → `deploy`（5 个 `--staking-*-key-path`）全程 **73 秒、零联网**（`bin/` 下无任何非软链条目，`download-cache` 无新文件）；CLI 接受生成的创世并识别出 4 个 ValidatorManager 合约；`eth_chainId=0x4edd`、创世 `timestamp=0x6a961580`（1788220800）、`gasLimit=0xe4e1c0`（15,000,000）；**创世区块哈希基准 = `0xcd807715b50b5eaba52dd332cce379da66704b443b1439e881e11751b88d3efa`**（SC-002/003 的比对值）；5 个 Anvil 账户余额精确等于 `balanceWei`；**ewoq 在 latest 的余额低于创世值**——因为 CLI 用它支付 PoA ValidatorManager 初始化交易（部署后高度已为 4），所以验证器的"余额 == 创世"检查必须以 `eth_getBalance(addr, "0x0")` 为基准，latest 只做 `≤` 检查（写入 T033）。

**T026 实测（2026-09-01/02，SC-003）**：`docker compose down -v` → `up` 连续 **10 轮**，创世区块哈希 10/10 = `0xcd807715…3efa`，首启耗时 76/75/75/75/75/75/77/75/75/75 s（max 77 s，SC-001 ✅）。**竞态发现**：若在 READY 摘要仍在打印时收到 SIGTERM，信号会打断正在执行的命令替换，`avalanche network stop` 未运行、快照不含 L1 节点，恢复后只剩主网节点（RPC 300 s 超时）。修法：启动期把 SIGTERM 记为"已请求"，`run` 完整结束后再有序停止（实测：20 s 时 stop → 56 s 后完成并保存快照 → 恢复成功）；compose `stop_grace_period` 提高到 180 s 以覆盖"启动 + 停止"。另：avalanchego `--http-allowed-hosts` 默认仅放行 localhost / IP 字面量，compose 内以服务名访问得 403，验证器需解析为 IP（已记入 rpc-endpoint.md）。

**T011 其他实测事实**：链别名 `/ext/bc/<name>/rpc` 在 L1 节点上可用（RPC 路径稳定性成立）；CLI `--test-defaults` 的 feeConfig 为 gasLimit 8,000,000 / targetGas 40,000,000（测试默认，不同于官方 L1 默认），本项目创世由生成器决定，不受影响；CLI 创世含 `warpConfig{blockTimestamp=<创世时间>, quorumNumerator=67, requirePrimaryNetworkSigners=true}` 与顶层 `timestamp`——**生成器必须固定这两个时间值**否则创世哈希不可复现；ValidatorManager 相关合约账户共 4 个（`0x0c0deba5…` 逻辑合约 15459B、`0x0feedc0de…` TransparentProxy、`0x9c00629c…` 库、`0xa0affe12…` ProxyAdmin），已提取为 fixture；L1 节点默认 `partial-sync-primary-network=true`。
