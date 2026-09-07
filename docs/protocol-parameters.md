<!-- GENERATED FROM blockchain/protocol.json + blockchain/protocol-rationale.json by tools/protocol/render-docs.mjs — DO NOT EDIT.
     修改参数：编辑 protocol.json（走宪法第十五条流程）→ npm run protocol:render → 提交。 -->

# KarmaChain 协议参数（dev · configVersion 1.4.0）

宪法第十四条要求记录的全部区块链参数及其取值理由。唯一权威定义：[`blockchain/protocol.json`](../blockchain/protocol.json)。

### 链身份

| 参数 | 值 | 取值理由 |
|---|---|---|
| `chain.chainId` | 20189 | 20189：本地开发网专用。与主网预留值分离，钱包不可能把本地链误认为主网。2026-08-31 核实 ethereum-lists/chains 未被占用；正式发布前需再次核实并注册。 |
| `chain.reservedMainnetChainId` | 20188 | 20188：为 KarmaChain 未来主网预留，本地网络禁止使用（load.mjs 与 preflight 双重断言）。 |
| `chain.blockchainName` | "karmachain" | karmachain：Avalanche CLI 的链名，同时成为稳定的 RPC 别名路径 /ext/bc/karmachain/rpc（避免依赖随机的 BlockchainID）。 |
| `avalanche.networkId` | 1337 | 1337：Avalanche CLI 本地网络的固定 Network ID（区别于主网 1 / Fuji 5，防误连）。取值由 CLI 决定，此处记录并在验证中核对。 |
| `environment` | "dev" | 本文件只描述本地开发网络；生产/Staging 参数将另建文件与目录，禁止从 dev 复制（宪法第四条）。 |
| `configVersion` | "1.4.0" | 协议参数集的版本号；任何字段变更须递增并走宪法第十五条协议变更流程（stamp 机制会拒绝启动旧链数据）。1.1.0（2026-09-02）：调整开发账户创世分配，见 devAccounts。1.2.0（2026-09-04）：新增 endpoints.publishedHosts，把 RPC 主机名从代码提升为声明参数。 1.3.0（2026-09-06）：新增 topology，把节点身份、角色与故障边界从隐式部署方式提升为声明参数（功能 002）。 1.4.0（2026-09-06）：节点端口由 9650-9669 迁至 21650-21669，见 validators.nodes 与 topology。 |

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
| `validators.nodes` | 见下 | 端口 21660-21669（HTTP/staking 交替）：keyDir 指向仓库内 DEVELOPMENT ONLY 密钥，保证 NodeID 跨重建一致。【端口迁移，configVersion 1.4.0】原用 9660-9669，实测 Windows 的 Hyper-V 从动态端口范围（本机 1024-15000）中切走了 9617-9716 等多个区间，覆盖全部节点端口；而跨机 P2P 要求 staking 端口发布到宿主，且 avalanchego 对外通告的就是 public-ip:staking-port（通告端口必须等于宿主发布端口，没有内外不同端口的选项），因此这些端口在 Windows 故障边界上无法使用。迁到 21650-21669：该区段在动态端口范围之外，Hyper-V 不会再切走它。编号保持原有对应关系（9660→21660）以便对照。8545 未受影响，本就不在保留区间内。 |
| `validators.nodes[0]` | http 21660 / staking 21661，密钥 `blockchain/validators/dev/node-1/` | ↑ |
| `validators.nodes[1]` | http 21662 / staking 21663，密钥 `blockchain/validators/dev/node-2/` | ↑ |
| `validators.nodes[2]` | http 21664 / staking 21665，密钥 `blockchain/validators/dev/node-3/` | ↑ |
| `validators.nodes[3]` | http 21666 / staking 21667，密钥 `blockchain/validators/dev/node-4/` | ↑ |
| `validators.nodes[4]` | http 21668 / staking 21669，密钥 `blockchain/validators/dev/node-5/` | ↑ |

### 创世开发账户

| 参数 | 值 | 取值理由 |
|---|---|---|
| `devAccounts` | 共 6 个，初始供应 39500000 KARMA | ewoq + Foundry Anvil 默认账户 #0-#4，使用生态公开测试密钥，让 Foundry/Hardhat/MetaMask 零配置可用；密钥公开，仅限本地（宪法第四条 v1.1.0 例外条款）。分配（configVersion 1.1.0，2026-09-02 用户裁定）：ewoq 与 anvil-0 各 1,000,000（ewoq 只需支付 PoA 初始化与少量 P-Chain 手续费；anvil-0 作为常规小额账户）；anvil-1/3/4 各 10,000,000、anvil-2 7,500,000，为大额转账、合约资金池、gas 压测等场景提供充足余额，且 anvil-2 取不同数值便于在测试中区分账户。合计初始供应 39,500,000 KARMA —— 开发网络供应量不代表主网代币经济学，主网参数将另行规格化。 |
| `ewoq` | 0x8db97C7cEcE249c2b98bDC0226Cc4C2A57BF52FC（1000000 KARMA，avalanche-ewoq） | ↑ |
| `anvil-0` | 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266（1000000 KARMA，foundry-anvil-default-#0） | ↑ |
| `anvil-1` | 0x70997970C51812dc3A010C7d01b50e0d17dc79C8（10000000 KARMA，foundry-anvil-default-#1） | ↑ |
| `anvil-2` | 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC（7500000 KARMA，foundry-anvil-default-#2） | ↑ |
| `anvil-3` | 0x90F79bf6EB2c4f870365E785982E1f101E93b906（10000000 KARMA，foundry-anvil-default-#3） | ↑ |
| `anvil-4` | 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65（10000000 KARMA，foundry-anvil-default-#4） | ↑ |

### 端点

| 参数 | 值 | 取值理由 |
|---|---|---|
| `endpoints.hostRpcPort` | 8545 | 8545：EVM 生态惯例端口（Anvil/Hardhat/geth 同款），MetaMask 等工具默认友好；可被宿主 .env 覆盖而不影响链身份。 |
| `endpoints.rpcPath` | "/ext/bc/karmachain/rpc" | /ext/bc/karmachain/rpc：由 blockchainName 派生（load.mjs 断言），Avalanche 节点的标准链路径 + CLI 设置的别名。 |
| `endpoints.publishedHosts` | ["127.0.0.1","localhost"] | 本链对外发布 RPC 的主机名列表，按优先顺序排列；公开产物 chain-info.json 的 rpc.http/rpc.ws 由它逐一生成（第三方消费者应依次尝试）。开发网取 ["127.0.0.1", "localhost"]：两者在任何运行本链的机器上都成立，因而可安全提交、不因开发者而异。**不要**把局域网 IP 或某台机器专属地址写进来——那属于消费者侧的临时覆盖（如 karma-sc 的 KARMACHAIN_RPC_URL）。真实部署时此处列出实际域名；注意 avalanchego 只接受 Host 为 localhost 或 IP 字面量，其他域名需由反向代理改写 Host。 |

### 拓扑与故障边界

| 参数 | 值 | 取值理由 |
|---|---|---|
| `topology` | 见下 | 功能 002 引入。声明有哪些节点、各属哪个故障边界、部署在哪里 —— 此前这些是「单容器里跑 7 个进程」的隐含结果，既无法表达跨机部署，也无法校验容错约束。验证者的端口与 staking 材料目录不在此重复，唯一出处仍是 validators.nodes[]；Primary 节点的端口在仓库中无其他出处，故在此声明（21650/21651、21652/21653；原为 001 实测值 9650-9653，随 configVersion 1.4.0 的端口迁移一并改动）。故障边界 = 会同时失效的一组节点：容错上限 f ≤ ⌊n/4⌋ 由共识参数推导（001 研究 R-05），边界数 > 1 时任一边界内的验证者不得超过该上限。sharedFailureFactors 必填，因为「独立失效」无法由代码验证，只能要求部署者显式声明共享的供电、交换机与更新窗口（研究 R-12）。 |
| `topology.activeDeployment` | "local" | 当前生效的部署形态。它是**唯一**决定"节点用哪套地址启动"的开关：生成物按形态分目录（blockchain/nodes/<deployment>/），改这一个字段再重新生成即可切换，不必改动任何其他声明。取 local（单机全部节点）：阶段一形态，只有 1 个故障边界，不做整机失效容错承诺。 |
| `topology.nodes` | 共 7 个 | 声明有哪些节点及其角色。验证者的端口与 staking 材料目录不在此重复，唯一出处仍是 validators.nodes[]（此处只用 validatorIndex 引用）；Primary 节点的端口与 keyDir 在仓库中无其他出处，故在此声明。 |
| `topology.deployments` | 2 个形态：local、lan | 每个部署形态声明一套"节点 → 故障边界"的归属。故障边界 = 会同时失效的一组节点。容错上限 f ≤ ⌊n/4⌋ 由共识参数推导（001 研究 R-05）；边界数 > 1 时任一边界内的验证者不得超过该上限（约束 T-5，违规即退出码 13）。sharedFailureFactors 必填且可为空数组，但空必须是**有意识的**空："独立失效"无法由代码验证，只能要求部署者显式声明共享的供电、交换机、更新窗口与虚拟化宿主（研究 R-12）。共享同一因素的边界会被合并为一个**有效边界**，整域失效容忍按合并后判定 ——否则"5 个边界各 1 个验证者"这种声明会在真实宿主只有 2 台时依然显示绿灯（研究 R-12 的 2026-09-07 修正）。 |
| `topology.deployments.local.containerNetwork` | {"subnet":"172.28.0.0/24","firstHost":11} | 单机形态下 7 个容器需要**稳定且可预测**的地址：节点的 --public-ip 与 --bootstrap-ips 必须在容器启动前就能算出来，而 Docker 默认网络的地址分配不保证顺序。因此声明一个专用网段，按节点序号确定性地分配（firstHost 起）。跨机形态不声明本项 —— 那里用各机器的真实地址。 |

**节点**（端口与 keyDir 解析自 `validators.nodes[]` 与 `topology.nodes[]`，此处只是展示解析结果）

| 节点 | 角色 | 端口 | 身份材料 |
|---|---|---|---|
| `l1-1` | l1-validator | http 21660 / staking 21661 | `blockchain/validators/dev/node-1/` |
| `l1-2` | l1-validator | http 21662 / staking 21663 | `blockchain/validators/dev/node-2/` |
| `l1-3` | l1-validator | http 21664 / staking 21665 | `blockchain/validators/dev/node-3/` |
| `l1-4` | l1-validator | http 21666 / staking 21667 | `blockchain/validators/dev/node-4/` |
| `l1-5` | l1-validator | http 21668 / staking 21669 | `blockchain/validators/dev/node-5/` |
| `primary-1` | primary | http 21650 / staking 21651 | `blockchain/validators/dev/primary-1/` |
| `primary-2` | primary | http 21652 / staking 21653 | `blockchain/validators/dev/primary-2/` |

**部署形态**

#### `local`（**当前生效**）

单机全部节点（阶段一）。只有 1 个故障边界，不做整机失效容错承诺。

| 故障边界 | 平台 | 地址 | 节点 | 验证者数 | 共享失效因素 |
|---|---|---|---|---|---|
| `local` | linux | 127.0.0.1 | l1-1、l1-2、l1-3、l1-4、l1-5、primary-1、primary-2 | 5 | host:single-machine |

容错：5 个等权验证者，查询门槛 75% → 可容忍 1 个离线。单边界形态，不做整机失效容错承诺。

#### `lan`

5 个声明边界，但 2026-09-07 取证发现其中 3 个是虚拟机、宿主只有 2 台物理机：U22Node1/U22Node2 是 win-1 上的 VMware 客户机，U22Node3 是 win-2 上的。虚拟机的故障边界是它的虚拟化宿主，因此本形态当前只有 2 个真实边界（win-1 承载 3 个验证者 + 2 个 Primary，win-2 承载 2 个），远超容错上限 1 —— 任一台物理机失效都会使链安全停摆。sharedFailureFactors 已如实声明 hypervisor 因素，校验器据此告警。恢复整域容错需要 5 台物理机（n=5 时每边界至多 ⌊5/4⌋=1 个验证者）。详见 docs/adr/0007-failure-domain-independence.md。运维方 2026-09-06 已确认独立供电、交换机分开、两台 Windows 自动更新已关闭，那三项因素因此不再声明。

| 故障边界 | 平台 | 地址 | 节点 | 验证者数 | 共享失效因素 |
|---|---|---|---|---|---|
| `win-1` | windows | 192.168.1.3 | l1-1 | 1 | hypervisor:win-1 |
| `win-2` | windows | 192.168.1.13 | l1-2 | 1 | hypervisor:win-2 |
| `ubuntu-1` | linux | 192.168.1.21 | l1-3、primary-1 | 1 | hypervisor:win-1 |
| `ubuntu-2` | linux | 192.168.1.22 | l1-4、primary-2 | 1 | hypervisor:win-1 |
| `ubuntu-3` | linux | 192.168.1.23 | l1-5 | 1 | hypervisor:win-2 |

容错：5 个等权验证者，查询门槛 75% → 可容忍 1 个离线。每边界至多 1 个验证者 → **无法**容忍 1 个边界整体失效。

> 5 个声明边界因共享失效因素合并为 **2 个有效边界**（win-1+ubuntu-1+ubuntu-2：3 个验证者；win-2+ubuntu-3：2 个验证者）。上面的结论按合并后判定。

### 派生值（不存储，由 `tools/protocol/load.mjs derive()` 计算）

| 派生值 | 值 |
|---|---|
| Chain ID（十六进制） | `0x4edd` |
| 宿主 RPC URL | `http://127.0.0.1:8545/ext/bc/karmachain/rpc` |
| 宿主 WS URL | `ws://127.0.0.1:8545/ext/bc/karmachain/ws` |
| 初始供应 | 39500000 KARMA（39500000000000000000000000 wei） |
| 节点总数 | 7（2 主网 + 5 L1） |
| 创世区块哈希（实测基准） | `0x19cfde1f02e585020cdae83071bac33c7d81e411cacf7f306b82ceabe98892ed` |

### 创世配置

创世文件 [`blockchain/genesis/karmachain.genesis.json`](../blockchain/genesis/karmachain.genesis.json) 由本参数集 + ValidatorManager fixture 确定性生成（固定创世时间 2026-09-01T00:00:00Z），详见 [`blockchain/genesis/README.md`](../blockchain/genesis/README.md)。
