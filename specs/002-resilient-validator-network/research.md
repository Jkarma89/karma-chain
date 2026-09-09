# Phase 0 Research: 崩溃可恢复、可跨机部署的验证者网络

**Feature**: `002-resilient-validator-network` | **Date**: 2026-09-06 | **Spec**: [spec.md](./spec.md)

> 本文每条结论都附来源。来源分三类：
> **[实测]** 从本机 2026-09-05 那次故障后的数据卷中直接取证；
> **[文档]** Avalanche 官方文档；
> **[001]** 功能 001 的既有研究结论（`specs/001-local-avalanche-devnet/research.md`）。
> 研究阶段无法确证的，一律进入文末的**实现期验证清单**，不写成结论（宪法第十二条）。

## 取证基线

本次研究的一手证据来自故障后仍保留的数据卷 `karmachain-devnet-data`。关键取证：

| 取证项 | 结果 |
|---|---|
| L1 验证者的 `flags.json`（CLI 实际传给 avalanchego 的全部参数） | 完整保留，见 R-01 表 |
| `subnets/karmachain/sidecar.json`（建链产出） | 完整保留，含 SubnetID / BlockchainID / 5 个引导验证者 |
| 各节点 `db/network-1337/v1.4.5`、`chainData/<blockchainID>/db` | 完整保留 |
| `snapshots/` | **空** |
| 全卷搜索 `staker.crt` | **零命中** |

最后一条是对 spec 中故障描述的补充：不仅编排账本丢了，**节点身份材料在卷里也不存在**。CLI 在 deploy 时从仓库只读挂载点读取密钥并交给节点，但这些材料没有以节点自有文件的形式落在数据目录里。这使"重启即恢复"在当前架构下从一开始就不成立——即使快照还在，节点也拿不回自己的身份。R-03 针对此项设计。

---

## R-01 运行时形态：一节点一容器，直接运行 avalanchego

**Decision**: 放弃"单容器 + `avalanche network start/stop` 编排"，改为**每个节点一个容器，容器内直接以进程方式运行 avalanchego**。编排工具仅用于一次性建链（R-04）。

**Rationale**:

[实测] 从 L1 验证者的 `flags.json` 取到 CLI 实际传给 avalanchego 的全部参数——**没有任何一项是 CLI 私有的**，全部是 avalanchego 的公开配置标志：

| 标志 | 实测值 | 说明 |
|---|---|---|
| `network-id` | `1337` | 与 protocol.json 一致 |
| `track-subnets` | `2W9boARgCWL25z6pMFNtkCfNA5v28VGg9PmBgUJfuKndEdhrvw` | **SubnetID**，建链产出 |
| `bootstrap-ids` / `bootstrap-ips` | 2 个 Primary 节点 | 引导集合 |
| `data-dir` | 节点私有目录 | 数据与身份的根 |
| `plugin-dir` | 共享插件目录 | subnet-evm 所在 |
| `http-host` / `http-port` | `127.0.0.1` / `9662` | **可配置**——见 R-07 |
| `staking-host` / `staking-port` | `127.0.0.1` / `9663` | 同上 |
| `public-ip` | `127.0.0.1` | 跨机时须改，见 R-08 |
| `partial-sync-primary-network` | `true` | L1 验证者只部分同步主网络，见 R-09 |
| `sybil-protection-enabled` | `true` | 验证者必须开启 |
| `network-allow-private-ips` | `true` | 局域网必需 |
| `chain-config-content` / `genesis-file-content` | base64 内联 | 可改用 `--chain-config-dir` 等文件形式 |

结论：**CLI 在运行期没有提供任何不可替代的能力**，它只是把上述参数拼起来并记账。把这份参数由我们自己从唯一事实来源生成，编排工具就可以完全退出运行时路径，缺陷 A 随之消失。

**Alternatives considered**:

- *继续用 CLI，只是加自动重启* —— 不解决问题。缺陷 A 的根因是链状态存续依赖 CLI 的快照记账，重启只会重复触发同一条失败路径（本次故障即为实证：CLI 重启后确实自动跑了 `network start`，仍然失败）。
- *改用 `tmpnetctl` / avalanche-network-runner* —— 二者定位都是**临时测试网络**（tmpnet 的名字即 temporary network），生命周期语义与"长期存续的链"相反，且同样是外部编排层。
- *自研编排守护进程* —— 把 CLI 的问题原样重写一遍，额外承担维护成本。容器运行时本身（`restart` 策略 + 健康检查）已经是成熟的进程守护，不需要再造。

**Sources**: [实测] `flags.json`、`config.json`；[文档] [AvalancheGo Config Flags](https://build.avax.network/docs/nodes/configure/avalanchego-config-flags)

---

## R-02 运行时镜像：官方 avalanchego 镜像 + subnet-evm 插件

**Decision**: 节点镜像以 **`avaplatform/avalanchego:v1.14.1`** 为基底，仅叠加版本锁定的 `subnet-evm v0.8.0` 插件与少量诊断工具。**镜像内不包含 Avalanche CLI**。

**Rationale**:

- [实测] `docker manifest inspect avaplatform/avalanchego:v1.14.1` 成功，提供 `linux/amd64` 与 `linux/arm64`，与当前 Dockerfile 的 `TARGETARCH` 双架构策略一致。
- 当前 `docker/devnet/Dockerfile` 的基底是 `avaplatform/avalanche-cli:v1.9.6`，CLI 与节点混在同一镜像里。换成官方节点镜像后，**FR-015（能在不含编排工具的运行环境中启动全部节点）由镜像构成本身保证**，不需要额外的运行时检查就能被静态验证——这是把一条需求变成结构性事实，而不是靠测试去追。
- 版本锁定与 sha256 校验的既有做法（001 R-02）原样保留：subnet-evm 插件仍按 `protocol.json` 声明的版本下载并校验。

**Alternatives considered**:

- *沿用 avalanche-cli 镜像，只是不调用 CLI* —— CLI 仍在镜像里，FR-015 只能靠"我们保证不调用"这种约定来满足，无法静态验证；镜像也白白大出一截。
- *自行编译 avalanchego* —— 引入 Go 工具链与构建可复现性问题，违背宪法第十三条的选型克制，且官方发行二进制已有 sha256 锁定的既有流程。

**Sources**: [实测] `docker manifest inspect`；[文档] [Run a Node](https://build.avax.network/docs/nodes/run-a-node)

---

## R-03 节点身份：staking 密钥必须成为节点自有的持久文件

**Decision**: 每个节点通过 **三个显式标志**指定身份材料，材料从仓库以只读方式挂载：

| 标志 | 指向 | 默认值（不使用） |
|---|---|---|
| `--staking-tls-cert-file` | `blockchain/validators/dev/node-N/staker.crt` | `$HOME/.avalanchego/staking/staker.crt` |
| `--staking-tls-key-file` | `blockchain/validators/dev/node-N/staker.key` | `$HOME/.avalanchego/staking/staker.key` |
| `--staking-signer-key-file` | `blockchain/validators/dev/node-N/signer.key` | `$HOME/.avalanchego/staking/signer.key` |

**Rationale**:

- [实测] 当前架构下全卷搜索 `staker.crt` **零命中**。CLI 用它自己的 `--staking-cert-key-path` 等参数（`docker/lib/avalanche.sh:97`，注意这是 **CLI 的**标志，不是 avalanchego 的）在部署时读取仓库里的密钥，但节点数据目录中不保留副本。节点身份因而不是节点自有的持久属性，而是编排层每次注入的外部输入——这正是"重启回不来"的第二个根因。
- [文档] avalanchego 的 `--staking-tls-cert-file` / `--staking-tls-key-file` 默认落在 `$HOME/.avalanchego/staking/`；BLS 签名密钥标志为 `--staking-signer-key-file`（配置键 `StakingSignerKeyPathKey`），默认 `~/.avalanchego/staking/signer.key`。显式指向仓库路径后，NodeID 由版本控制下的材料唯一决定，满足 FR-016（重启后身份不变）与 US5 的可复现要求。
- 密钥材料已存在于仓库 `blockchain/validators/dev/node-{1..5}/`，且 `protocol.json` 的 `validators.nodes[].keyDir` 已声明其位置——**本项无需新增密钥，只需改变喂给节点的方式**。
- 宪法第四条 v1.1.0 例外条款的四项条件对这些材料继续适用（仅开发网有效、显著标记、纳入秘密扫描白名单、生产不可接受）。

**Alternatives considered**:

- *让 avalanchego 自行生成身份* —— NodeID 每次重建都会变，验证者集合（链上 PoA 合约管理）随即失配，与 FR-016、US5 直接冲突。
- *把密钥复制进节点数据卷* —— 数据卷是运行期产物，复制进去等于制造第二份事实来源（宪法第十六条），且卷被删就丢身份。只读挂载仓库材料没有这两个问题。

**Sources**: [实测] 全卷搜索、`docker/lib/avalanche.sh:93-97`；[文档] AvalancheGo Config Flags、[avalanchego config keys](https://github.com/ava-labs/avalanchego/blob/master/config/keys.go)

---

## R-04 建链制品：一次性产出，固化进仓库

**Decision**: 编排工具只负责**第一次建链**（P 链上的 CreateSubnetTx / CreateChainTx / ConvertSubnetToL1Tx 与 PoA 初始化）。其产出提取为版本控制下的制品，运行期只读消费。

[实测] `subnets/karmachain/sidecar.json` 中已有全部所需字段：

| 制品 | 实测值 | 运行期用途 |
|---|---|---|
| SubnetID | `2W9boARgCWL25z6pMFNtkCfNA5v28VGg9PmBgUJfuKndEdhrvw` | 每个验证者的 `--track-subnets` |
| BlockchainID | `Wd8yzG1cggbUi2nqKC5RzJM8Vz8w7CEisxcvMRJiWwRVLhTqd` | 链配置键、RPC 路径、别名映射（R-05） |
| BootstrapValidators[5] | NodeID / Weight 100 / Balance / BLS 公钥 / BLS 拥有证明 / ChangeOwnerAddr / ValidationID | 初始验证者集合，与 R-03 的身份材料一一对应 |
| VM / VMVersion / RPCVersion | Subnet-EVM / v0.8.0 / 44 | 与 protocol.json 的版本锁定交叉校验 |
| Primary Network 创世 | `flags.json` 的 `genesis-file-content`（base64，networkID 1337、2 个 initialStakers） | 主网络节点启动所需 |

**Rationale**: 这些值是 P 链交易的产物，**无法由 `protocol.json` 纯函数离线推导**（BlockchainID 是 CreateChainTx 的交易 ID）。因此它们是**第二类事实**：不是协议参数，而是建链动作的产物。处理方式与 `blockchain/genesis/karmachain.genesis.hash`（001 已有的做法）一致——由生成流程产出、提交进仓库、被漂移测试与启动期校验保护。

### 修正（2026-09-06 实测）：建链是**确定性**的

本文最初写的是"BlockchainID 每次建链都会变，所以只能靠链别名保证对外路径稳定"。**这一判断被实测推翻。**

在 T014 实施期间，卷被 `devnet-reset` 删除并重建了 3 次，其中一次相隔一天。把重建后的 `sidecar.json` 与故障前那份（`tests/fixtures/002/measured-sidecar.json`）逐字段比对：

| 字段 | 结果 |
|---|---|
| SubnetID | **一致** `2W9boARgCWL25z6pMFNtkCfNA5v28VGg9PmBgUJfuKndEdhrvw` |
| BlockchainID | **一致** `Wd8yzG1cggbUi2nqKC5RzJM8Vz8w7CEisxcvMRJiWwRVLhTqd` |
| 5 个 ValidationID | **全部一致** |
| 5 个 BLS 公钥 | **全部一致** |

原因是本地网络的输入全部固定：Primary Network 创世固定、staking 密钥提交在仓库里、建链步骤顺序固定，于是付手续费的 UTXO 与交易字节也固定，交易 ID 随之固定。

**两点影响**：

1. **制品可以被漂移测试保护**，而不只是"提交上去就不管了"。重新建链应当得到逐字节相同的制品；不同即说明有输入变了（版本、密钥、创世、步骤顺序），这正是需要被拦下的情况。
2. **R-05 的链别名依然要做，但理由变了**——不再是"补偿 BlockchainID 的不可复现"，而是"把对外路径与内部标识解耦"：即便将来某项输入变化导致 BlockchainID 改变，公开制品里的 `/ext/bc/karmachain/rpc` 也不受影响。

保持"制品固化 + 只读消费"的设计不变，因为**可复现不等于可离线推导**：拿到 BlockchainID 仍然必须真的跑一次建链，运行期不能现算。

**Alternatives considered**:

- *每次启动重新建链* —— 即便结果确定，也要多花一次完整建链的时间，且任何输入的意外变化都会静默产生一条新链而无人察觉。固化 + 漂移测试才能把这种变化变成可见的失败。
- *把 BlockchainID 写进 `protocol.json`* —— 它不是协议参数，而是建链产物；混进唯一事实来源会让"参数"与"产物"的边界失效（宪法第十六条）。

**Sources**: [实测] 故障前后两次独立建链的 `sidecar.json` 逐字段比对（2026-09-05 与 2026-09-06）

---

## R-05 链别名：保证对外 RPC 路径不随重建变化

**Decision**: 用 `--chain-aliases-file` 显式声明 `BlockchainID → ["karmachain"]`，保证公开制品中的 `/ext/bc/karmachain/rpc` 路径恒定。

**Rationale**:

- [实测] CLI 自己产出的 `RPCEndpoints` 用的是 BlockchainID 全串（`/ext/bc/Wd8yzG1c.../rpc`），而 `docs/public/chain-info.json` 与 `developer-quickstart.md` 对第三方公布的是 `/ext/bc/karmachain/rpc`，且**当前确实可用**——说明别名在当前部署下已生效（推测来自 CreateChainTx 的链名自动别名）。但这一机制是隐式的，卷里找不到 `aliases.json`。
- [文档] `--chain-aliases-file` 默认 `~/.avalanchego/configs/chains/aliases.json`。显式声明把隐式行为变成版本控制下的配置，同时使"BlockchainID 变了但对外路径不变"成为可能——这正是 R-04 放弃 BlockchainID 可复现性的补偿。
- FR-028（公开制品不得泄漏内部信息）与 FR-024（对外契约不回退）都依赖这条路径稳定。

### 修正（2026-09-06 实测）：`--chain-aliases-file` **不注册 HTTP 路由**

上述 Decision 是错的，实测推翻：

| 观测 | 结果 |
|---|---|
| 节点配置里是否读到别名 | **是** —— `"chainAliases":{"Wd8yzG1c…":["karmachain"]}` |
| `/ext/bc/<blockchainID>/rpc` | **200** |
| `/ext/bc/karmachain/rpc` | **404** |
| 注册的路由（日志） | 只有 blockchainID，没有别名 |

avalanchego v1.14.1 会把别名读进配置，但**不据此注册 HTTP 路由**；只有 `admin.aliasChain`（需 `--api-admin-enabled`）会。而 admin API 建的别名是内存态，节点一重启就没了。

**这揭穿了一件事：001 对第三方公布的那个地址，本身就依赖编排器。** CLI 每次 `network start` 都重新调 admin API 建别名——这正是 002 要消灭的隐式依赖，只是它藏在公开契约里，此前没人注意。

**修正后的方案（用户裁定，方案 C）**：在节点前面放一个**无状态的路径重写代理**（nginx，配置由 `tools/protocol/render-rpc-proxy.mjs` 生成）。它把 `/ext/bc/<alias>/…` 重写成 `/ext/bc/<blockchainID>/…`，并在该故障边界内的全部验证者之间做故障转移。

选它而不是另外两条路的理由：

- *启动后调 `admin.aliasChain`* —— 别名是内存态，**每次节点重启都要重调**，等于把编排放回恢复路径，与缺陷 A 的修复直接冲突。
- *改为公布 blockchainID 全路径* —— BlockchainID 确定性成立，地址是稳定的，但会改变已公布给第三方的地址（FR-024 不允许回退），且把对外路径与内部标识焊死。
- *无状态代理* —— 唯一同时满足"公开契约不变"与"恢复路径不含编排"的。代理不持有数据、不参与共识，崩了重启即可。

**三个顺带收益**（实测）：

1. **对外 RPC 不再随单个验证者一起挂掉** —— 上游是边界内的全部验证者，`ip_hash` 兼顾客户端亲和与故障转移。亲和性是必需的：轮询时出现过"receipt 已返回 block 1，紧接着的 `eth_blockNumber` 从另一个节点读到 0"。
2. **`403 invalid host specified` 彻底消失** —— 代理把 Host 统一改写为 `localhost`，客户端用任意主机名都通（实测 `Host: karmachain.local` → 200）。这使我们写给第三方的"必须用 IP 不能用域名"那条限制在经代理访问时不再适用。
3. 别名与 blockchainID 两条路径**结果完全一致**（V-10 实测：`eth_chainId` / `eth_blockNumber` / `net_version` 三项逐项相同）。

`--chain-aliases-file` 仍然照常生成与挂载：它对 avalanchego 内部的链查找有效，且一旦上游补上路由注册，代理就可以退役。

**Sources**: [实测] 2026-09-06 别名路径 404 / blockchainID 路径 200、节点配置转储、V-10 与 V-11 实测；[文档] [Admin API](https://build.avax.network/docs/api-reference/admin-api)、AvalancheGo Config Flags

---

## R-06 崩溃恢复：依赖节点数据库自身，不依赖快照

**Decision**: 每个节点独占一个持久卷承载 `--data-dir`；数据库类型沿用默认 `leveldb`；**不使用任何快照机制**。容器重启策略设为始终重启。

**Rationale**:

- [实测] 本次故障中，5 个 L1 验证者的 `db/network-1337/v1.4.5` 与 `chainData/<blockchainID>/db` **全部完好**。链数据从未丢失——丢的是编排账本（`snapshots/` 空）与身份材料（R-03）。把这两项分别由 R-01 与 R-03 解决后，恢复所需的一切都在节点自己的卷里。

### 空卷重建路径已确认（T047，2026-09-07）

卷被删除后的重建不需要任何特殊处理 —— `docker/node/entrypoint.sh` 里也**没有**为此写一行代码，
这正是要确认的点：节点身份取自只读挂载的 `/keys`（R-03 的直接收益），与数据卷无关，
因此空卷启动与首次启动走的是同一条路。实测两次：

| 实测 | 结果 |
|---|---|
| 删除**单个**验证者卷后启动（`tests/e2e/node-data-loss.test.mjs`） | 从对等节点全量同步，NodeID 不变，其余节点不受影响，5/5 通过 |
| 删除**全部 5 个**验证者卷、只留 2 个 Primary 卷后启动（R-15） | 6 秒就绪，5/5 验证者引导完成，链身份与制品逐字一致，`devnet-verify` 14/14 |

出生证明（stamp）在空卷上是**首次写入**而非比对，因此不会与"当前声明"冲突；
反之若卷里有旧链的 stamp，启动即退出 12 —— 两种情形都是预期行为，无需区分处理。
- [文档] `--db-type` 默认 `leveldb`。LevelDB 以预写日志保证崩溃一致性，这是"强制杀死后重启可恢复"的物理基础。
- 落后的节点通过对等节点补齐区块，这是共识协议的常规路径，不需要我们额外设计。

**未确证，列入验证清单**：avalanchego 在 `SIGKILL` 后重启的实际恢复行为（是否需要修复、耗时、是否有需要清理的半成品状态）必须实测，不能凭数据库特性推断 → **V-01 / V-02**。

**Alternatives considered**:

- *定期保存快照* —— 快照机制正是缺陷 A 的来源。而且 `avalanche network stop` 要求停止网络才能保存，无法周期化。
- *节点数据放宿主目录挂载而非命名卷* —— 跨 Windows / Linux 的路径与权限语义不一致（spec 边缘用例已列），命名卷由容器运行时统一管理，一致性更好。

**Sources**: [实测] 卷内数据库；[文档] AvalancheGo Config Flags

---

## R-07 端点暴露：socat 代理退役

**Decision**: 节点直接以 `--http-host=0.0.0.0` 监听，配合 `--http-allowed-hosts` 显式放行；**删除 001 引入的 socat 反向代理**。

**Rationale**:

- 001 的 Complexity Tracking 明确登记了这条待简化项：*"若 V-8 证实可配置 http-host，则删除 socat（已登记为简化项）"*。
- [实测] `flags.json` 中 `http-host = 127.0.0.1` 与 `staking-host = 127.0.0.1` 均由 CLI 显式设置——**它们本来就是可配置的 avalanchego 标志**，001 当时受限于 CLI 的本地节点封装无法改动，而非 avalanchego 不支持。直接运行节点后该限制消失。
- [文档] `--http-host` 默认 `127.0.0.1`，`--http-allowed-hosts` 默认 `localhost`。后者正是 001 记录的 `403 invalid host specified` 的来源，也是 `docs/public/developer-quickstart.md` 中"必须用 IP 不能用域名"那条说明的根据。显式配置后，该限制可按需放宽，且**放宽策略成为版本控制下的决策而非隐式默认**。
- 每个节点独立容器后，节点的 HTTP 端口天然可映射到宿主，`devnet-status` / 健康检查不再需要"绑定容器 IP 的同端口代理"这套变通（001 因 avalanchego 固定 127.0.0.1 而设计的机制）。

**Alternatives considered**: *保留 socat* —— 无必要的一层，且是 001 自己登记的待删项。删除它同时简化了跨机场景（代理会让 `public-ip` 与实际可达地址错位）。

**Sources**: [001] plan.md Complexity Tracking；[实测] `flags.json`；[文档] AvalancheGo Config Flags

---

## R-08 跨机寻址

**Decision**: 每个节点显式声明 `--public-ip=<所在机器的局域网 IP>`、`--staking-port`、`--network-allow-private-ips=true`；引导集合 `--bootstrap-ips` / `--bootstrap-ids` 由拓扑声明生成。

**Rationale**:

- [实测] 当前全部节点 `public-ip = 127.0.0.1`，这是单机部署的必然结果，也是跨机的第一个必改项。
- [文档] `--public-ip` 无默认值；`--network-allow-private-ips` 默认 `true`（局域网部署所需，无需改动但应显式声明以免上游默认变化）；`--staking-port` 默认 `9651`。
- 一节点一机器后，端口不再需要错开——每台机器上的节点都可以用同一组端口（HTTP 9650 / staking 9651），这**简化**了 `protocol.json` 中现有的 `validators.nodes[].httpPort/stakingPort` 逐节点端口分配。是否借此简化端口模型，留待 data-model 决定。

### 实测前提（2026-09-06）：节点端口必须避开 Windows 的保留区间

跨机 P2P 要求 staking 端口**发布到宿主**，而 avalanchego 对外通告的端点就是 `public-ip:staking-port` ——
通告端口必须等于宿主发布的端口，没有"内外不同端口"的选项。

在本机（Windows 10 Pro，Docker Desktop / WSL2）实测：

| 观测 | 结果 |
|---|---|
| 动态端口范围 | 起始 1024，共 13977 个（即 1024–15000） |
| `netsh interface ipv4 show excludedportrange` | 22 个保留区间，其中含 **9617–9716** |
| 原节点端口 9650–9669 | **全部 14 个落在该区间内**，宿主无法发布 |
| `endpoints.hostRpcPort` = 8545 | 不在任何保留区间 —— 这正是 RPC 代理一直能用的原因 |

Hyper-V 是从动态端口范围里切走这些区间的，因此**选在该范围之外就不会再被它碰**。
实测 20000 / 21000 / 22000 / 23000 / 30000 / 31000 起的连续 24 个端口在本机全部空闲。

**决定（用户裁定）**：节点端口迁至 **21650–21669**，编号保持与原先的对应关系（9660 → 21660）便于对照。
这是协议变更（端口位于 `protocol.json` 的 `validators.nodes[]` 与 `topology.nodes[]`），
`configVersion` 1.3.0 → 1.4.0，按 stamp 机制强制 reset + 重新建链。
创世哈希不受影响（端口不参与创世），已实测确认。

### 实测结果（2026-09-06）：五台机器的清点

保留区间每台机器不同，因此 21650–21669 必须逐台核对。五台机器的实测结果：

| 边界 id | 主机名 | 局域网地址 | 平台 | Docker | Compose | `netsh … excludedportrange` 命中 `21[0-9]{3}` |
|---|---|---|---|---|---|---|
| win-1 | DESKTOP-03LO74K | 192.168.1.3 | Windows 10 Pro | 29.7.2 | v5.5.0 | 无 |
| win-2 | DESKTOP-AZMY | 192.168.1.13 | Windows 10 Pro | 29.7.2 | v5.5.0 | 无 |
| ubuntu-1 | U22Node1 | 192.168.1.21 | Ubuntu 22.04 LTS | 29.6.1 | v5.3.1 | 不适用 |
| ubuntu-2 | U22Node2 | 192.168.1.22 | Ubuntu 22.04 LTS | 29.6.1 | v5.3.1 | 不适用 |
| ubuntu-3 | U22Node3 | 192.168.1.23 | Ubuntu 22.04 LTS | 29.6.1 | v5.3.1 | 不适用 |

**结论**：21650–21669 在两台 Windows 上都空闲，端口方案对五台机器均适用，无需逐机例外。

顺带核对的两点：

- 两台 Windows 上都存在多个虚拟网卡地址（Hyper-V / WSL / VMware：`172.18.*`、`172.23.*`、`172.27.*`、`172.31.*`、`192.168.9x.*` 等），
  以及一个 VPN 地址。**只有 `192.168.1.x` 是局域网地址**，`topology.deployments.lan[].address` 只能填这一组。
- 容器网段 `172.28.0.0/24`（单机形态用）与上述任何一个虚拟网卡地址都不冲突。跨机形态本就不声明 `containerNetwork`，不涉及。

### V-06 实测（2026-09-06，从 win-1 出发）

`tests/integration/cross-host-reachability.test.mjs`（T057）从本机去连其余 4 个边界上每个节点的
staking 与 HTTP 端口。判定与"节点是否在跑"解耦：**连上或被拒（ECONNREFUSED）都算路径通**
——被拒说明包到了对端并收到 RST；只有超时／`EHOSTUNREACH` 才是被拦。因此链还没部署就能先查防火墙。

| 目标边界 | 地址 | 平台 | staking | http | 判读 |
|---|---|---|---|---|---|
| ubuntu-1 | 192.168.1.21 | linux | 通（refused） | 通（refused） | 路径开放，尚无监听 |
| ubuntu-2 | 192.168.1.22 | linux | 通（refused） | 通（refused） | 同上 |
| ubuntu-3 | 192.168.1.23 | linux | 通（refused） | 通（refused） | 同上 |
| win-2 | 192.168.1.13 | windows | **3s 超时** | **3s 超时** | **被 Windows 防火墙丢包** |

**结论**：三台 Ubuntu 无需额外放行（ufw 未启用或已放行）；**Windows 默认丢弃入站，必须显式加规则**。
这正是 V-06 判据里"Windows 入站规则可用"那一半。测试失败信息直接给出待执行的命令：

```powershell
New-NetFirewallRule -DisplayName "KarmaChain <node> staking" -Direction Inbound -Protocol TCP -LocalPort <port> -Action Allow
```

### 加规则之后的复测（2026-09-06）：win-2 仍不通，且诊断信号需要分层看

运维方在两台 Windows 上加了入站规则（win-1 上已确认存在：`KarmaChain l1-1`，Allow，Profile=Any，21660/21661），
但从 win-1 复测 win-2 仍全部超时。分层取证把范围缩到了 win-2 自身：

| 层 | 观测 | 判读 |
|---|---|---|
| L2（ARP） | `Get-NetNeighbor 192.168.1.13` → `Reachable`，有 MAC | **win-2 在线，同一广播域，包能到它** |
| L3（ICMP ping） | 超时 | **不可作判据**：TCP 端口规则不放行 ICMP，ping 本就该失败 |
| L4（TCP 21660/21661/21662/21663/21668） | **全部**超时，无一被拒 | 包到达后被 win-2 自己丢弃 |

三点推论：

1. **不是端口写错**。若 win-2 上误加成了 win-1 那组端口，21660/21661 应当返回 `refused`（有 allow 规则、无监听 → TCP 栈回 RST）。实测五个端口无一被拒，说明是**全量丢弃**，与具体端口无关。
2. **ARP 通 + TCP 全丢**是"对端防火墙丢包"的标准指纹（ARP 在防火墙之下）。若是路由或交换机问题，ARP 也拿不到应答。
3. **ping 不能当判据**这一点值得单独记下：只加 TCP 端口规则时 ping 必然失败，用 ping 判断"防火墙配好了没有"会得出相反结论。

### 逐项排除（2026-09-07）：win-2 仍不通，且已排除的比剩下的多

初版把结论写成"被 win-2 的 Windows 防火墙拦下"。**对现象的判断成立，对原因的判断不成立** ——
逐项排除后，Windows 防火墙规则本身是正确的：

| 假设 | 取证 | 结论 |
|---|---|---|
| Windows 防火墙规则缺失/写错 | win-2 上 `KarmaChain l1-2`：Enabled / Inbound / Allow / Profile=Any / TCP 21662,21663；网络类别 Private；`BlockAllInboundConnections` 未启用 | **排除** |
| 端口写错（照抄了 win-1 那组） | 21660/21661/21662/21663/21668 五个端口**无一被拒**，是全量丢弃，与具体端口无关 | **排除** |
| 第三方安全软件（火绒） | win-2 未安装；win-1 侧关闭后复测结果不变 | **排除** |
| 网络路径 / AP 客户端隔离 | 同一张 Wi-Fi 网卡、同一个 MAC 上的客户机 `.23` **可达**（refused） | **排除** |
| ARP 过期或 DHCP 换址，`.13` 无人占用 | 清空 ARP 缓存后重新解析，`.13` 仍 `Reachable` 且 MAC 不变 | **排除** |
| VMware 在 Wi-Fi 上桥接吞掉发往宿主自身地址的帧 | **把客户机 U22Node3 完全关机**后复测：`.23` 转为 TIMEOUT（对照有效），`.13` **依然 TIMEOUT** | **排除** |
| win-2 防火墙丢包日志 | 开启 `LogBlocked` 后探测 6 次，`pfirewall.log` 中**无任何** `2166x` / `192.168.1.3` 条目 | **不是 Windows 防火墙规则拦的** |
| 优先级更高的 Block 规则 | win-2 上的入站 Block 规则只有三条（迅雷 ×2、tun2socks），均**按程序限定**；我们的端口无进程监听，匹配不上 | **排除** |
| VPN kill switch（TAP 网卡持有更优默认路由） | win-2：`0.0.0.0/0 → 10.7.0.1` via TAP（Disconnected），metric 1/1。**但 win-1 配置相同且更激进**（多一条 `0.0.0.0/1` metric 0，10.7.0.2 为 Deprecated） | **排除**（共有属性无法解释差异） |

### 判据本身是错的 —— 一次必须记下来的自我纠错

排到这里，"win-2 在丢包"这个前提本身站不住了。**问题在判据**：

Windows 的 WFP 默认对**无监听**端口静默丢弃而不回 RST（俗称 stealth mode），而 allow 规则只放行、
**并不产生监听者**。于是在 Windows 目标上，"防火墙已放行但节点没起来"与"防火墙在拦"产生**完全相同**的观测。
Linux 对关闭端口回 RST，所以 `.21`/`.22`/`.23` 给出 `refused`。
**`.13` 超时与 `.21` 被拒的差别，可能仅仅是 Windows 与 Linux 的差别，与防火墙无关。**

更该记的是我曾用一条**无效证据**去否证这个解释：从容器里探本机 `.3:21660`（有规则、无监听）得到 `refused`，
据此写下"stealth mode 已排除"。后来做对照才发现，那个 refused 是 **0ms** 的 ——
跨 Wi-Fi 不可能 0ms，它是 Docker Desktop 的 WSL2 NAT **就地拒绝**，包根本没出网；
对**没有任何规则**的端口（`.3:21670`、`.3:45671`）同样是 0ms refused，对 `.13` 也一样。
**跨主机可达性不能从容器里测。**

代价是对着一台配置完全正确的机器排查了七个假设。修正落在两处：

1. `tests/integration/cross-host-reachability.test.mjs` 的判定改为：`connected`／`refused` 判通；
   超时且目标为 **linux** 判失败（Linux 本会回 RST）；超时且目标为 **windows** 判**无法判定并跳过**，
   跳过信息里写明歧义来源与"节点起来后复跑"的判定办法。
2. 该测试在链未部署时只给出**部分**结论。决定性的一次是节点起来之后 —— 那时 `connected` 对每个平台都无歧义。

### 决定性实验的结果（2026-09-07）：win-2 从未损坏

在 win-1 的 21660（已有 allow 规则）上起真实监听（`docker run -d -p 21660:80 nginx:alpine`，
确认 `0.0.0.0:21660 LISTENING`），从 win-2 探测：

| 测量 | 结果 |
|---|---|
| win-2 → win-1 `:21660`（**有监听 + 有 allow 规则**） | **`TcpTestSucceeded: True`**，`SourceAddress 192.168.1.13`，`InterfaceAlias WLAN` |
| win-2 → win-1 `:21670`（无监听、无规则，对照） | 失败；`PingSucceeded: False`（ICMP 被阻断，预期如此） |

**结论**：

1. **win-1 ↔ win-2 的局域网路径是通的** —— 这是第一次**有效**的证明。此前 win-1 的入站从未被外部验证过
   （没有哪台机器能测自己的入站），而先前用来填这个空白的都是无效证据。
2. win-1 上的 allow 规则确实生效（有监听即连通）。
3. **两台 Windows 在无监听端口上的行为一致**（都不应答）。因此 `.13` 超时而 `.21`/`.22`/`.23` 被拒，
   差别就是 **Windows 与 Linux**，与 win-2 的配置无关。**"win-2 被防火墙拦下"是判据造成的假阳性。**

**剩余歧义（不影响任何决策）**：win-1 的 `21670` 是以 RST 快速失败还是静默超时，未被分离
（`Test-NetConnection` 不报耗时）。若为 RST，则两台 Windows 之间仍有细微差别。
需要时一条命令可分离：`Measure-Command { Test-NetConnection 192.168.1.3 -Port 21670 -InformationLevel Quiet -WarningAction SilentlyContinue }`
（<200ms 为 RST，~1s 以上为静默丢弃）。但**部署本身会给出无歧义的答案** ——
节点起来之后 `connected` 对每个平台都成立，届时复跑本测试即可，因此不再单独追查。

**V-06 的当前状态**：win-1 → 3 台 Ubuntu 已验证可达；win-1 ↔ win-2 路径已验证可达（有监听时）；
各机器**自身**端口的最终确认留到节点起来之后复跑。

**与部署的关系**：无论结论如何都不阻塞其余工作。win-2 宿主上跑的是 l1-2，一个验证者缺席在容错范围内；
且若采纳"win-2 换有线"的建议（见 R-08 的部署前置），这条排查可能连同 Wi-Fi 一起变得无关。

另：**win-1 自己的入站至今未被外部验证过** —— 没有哪台机器能测自己的入站。它会在这个测试于任一台 Ubuntu 上运行时被覆盖。

**矩阵只完成了一行。** 跨机可达性是每台机器各自的防火墙与路由状态，没有哪一台能代表别人 ——
两两矩阵要求这个测试在 5 台机器上各跑一次。本机（win-1）这一行已完成，其余 4 行待部署时补。
需要放行的端口按边界划分：win-1 → 21660/21661，win-2 → 21662/21663，
ubuntu-1 → 21664/21665 + 21650/21651，ubuntu-2 → 21666/21667 + 21652/21653，ubuntu-3 → 21668/21669。

### V-07 实测（2026-09-06）：配错 `public-ip` **完全无声**

把 l1-5 的 `public-ip` 从 `172.28.0.15` 改成同网段内未使用的 `172.28.0.99`，重启该容器后观察：

| 观测 | 结果 |
|---|---|
| 容器是否启动 | 正常启动，60 秒内 `healthy` |
| 日志中与地址相关的条目 | 只有 `WARN P2P IP is private, you will not be publicly discoverable {"ip":"172.28.0.99"}` |
| 该 WARN 是否可作为判据 | **不可**——对**正确**的私网地址 `172.28.0.15` 打的是同一条 WARN |
| 5 个验证者的 peers | 全部保持 6，与基线一致 |
| l1-1 记录的 l1-5 地址 | `172.28.0.15:21669`（**真实地址**，不是通告的 .99） |
| 链是否受影响 | 不受影响；随后 `devnet-verify` 14/14 |

**结论有两层。**

其一，**没有任何来自节点的信号可用于检测**：不报错、不退出，唯一相关的日志对配对与配错完全相同。

其二，**单机形态根本无法暴露该症状**。容器网内所有节点互相可拨号，而 `public-ip` 只影响"我告诉别人怎么找我"；
l1-5 主动向外拨号建立的连接照常工作，对端记下的还是观测到的真实地址。也就是说这个错误在阶段一是**惰性**的，
会一直潜伏到阶段二 —— 到那时对端只剩通告地址这一条路可走，而且只在**新建**对等关系时才失败
（已建立的连接不受影响），于是表现为"某个边界时而参与、时而不参与"。这正是 V-07 判据里要避免的"随机连接失败"。

**因此检测只能落在宿主侧、且必须在节点启动之前**：容器处在 NAT 之后，看不到宿主的局域网地址，
容器内无从判断通告出去的地址是不是本机的。T062 的实现是 `scripts/devnet-start.{sh,ps1}` 在
`KARMACHAIN_DOMAIN_COUNT > 1` 时，把该边界声明的地址与本机网卡地址逐一比对，不符即以**退出码 13**
（`configuration` 类，语义扩充自"拓扑违反容错约束"）失败，并给出三条可执行的修正方式。
单边界形态跳过该核对 —— 那时声明地址是 `127.0.0.1`，不是网卡地址，核对只会误报。

两个实现细节值得记下：

- 声明地址经 `active.env` 的 `KARMACHAIN_DOMAIN_ADDRESSES` 传给宿主脚本，而不是让脚本解析 `protocol.json`
  —— 宿主只装 Docker，没有 Node（见 contracts/cli-interface.md）。
- 取本机地址必须用**结构化**的方式（`ip -4 -o addr` / `ifconfig` / `Get-NetIPAddress`）。
  最初对 `ipconfig` 输出直接 grep 点分四段，把子网掩码（`255.255.255.0`）和默认网关一并当成了本机地址；
  掩码只要恰好等于某个声明地址，守卫就会误判通过。

### 由此暴露的部署前置：地址必须静态，承载虚拟机的边界不能走 Wi-Fi 桥接

`topology.deployments.lan` 把地址**钉死**在声明里，节点据此向对等节点通告自己。因此：

1. **每台机器都必须是静态 IP 或 DHCP 保留。** 租约一变，该机器上的节点就在通告一个不属于它的地址
   （症状即上文 V-07：完全无声）。T062 的守卫能在**下次启动时**拦下，但**运行中**发生的租约变更拦不住 ——
   节点不会重读配置，会一直用旧地址通告到下次重启。列为已知限制，不做运行期检测：
   代价（每个节点周期性自查宿主地址）与收益（静态地址下永不发生）不匹配。
2. **承载虚拟机的边界不要用 Wi-Fi 桥接。** 802.11 一次关联只能带一个 MAC，虚拟化软件在 Wi-Fi 上桥接时
   无法给客户机独立 MAC，只能复用宿主的（实测：win-2 与其客户机 U22Node3 共用 `9C-B6-D0-04-7A-E1`）。
   宿主与客户机在同一 MAC 上靠 IP 解复用，是脆弱配置 —— 实测中客户机 `.23` 可达而宿主自身 `.13`
   的 TCP 被黑洞：ARP 缓存清空后 `.13` 仍正常应答（说明有东西在应答它）、Windows 防火墙规则已逐项核实正确、
   第三方安全软件已排除（win-2 未安装，win-1 侧已关闭后复测不变）。最可能是桥接驱动吞掉了发往宿主自身地址的帧。
   **走有线即无此约束**：客户机获得独立 MAC，宿主与客户机不再共用。
3. 顺带：**验证者本身也不宜挂在 Wi-Fi 上** —— 抖动与丢包会推高共识查询的超时率。属可用性问题，
   不影响安全性，但没有理由主动引入。

前两条须写入 `docs/devnet.md` 的跨机部署前置条件（T066）。

**Sources**: [实测] `flags.json`、2026-09-07 局域网 ARP 清点与逐端口探测；[文档] AvalancheGo Config Flags

---

## R-09 Primary Network 节点的角色与归属

**Decision**: 保留 2 个 Primary Network 节点；**它们不计入 5 个故障边界的容错计算**，但其可用性影响 L1 的引导。归属方案：与 2 个验证者边界共处（每台一个），不新增机器；**落在两台 Ubuntu 上**（见下文"归属的最终选择"）。

**Rationale**:

- [实测] L1 验证者的 `bootstrap-ips/ids` 指向这 2 个 Primary 节点；L1 验证者自身带 `partial-sync-primary-network = true`，即**只部分同步主网络**。Primary 节点的 `flags.json` 显示它们 `bootstrap-ids` 为空（创世节点）、`index-enabled = true`、且**没有** `track-subnets`。
- 因此二者分工明确：Primary 节点承载 P/C/X 链与 L1 的注册信息；L1 验证者承载 karmachain 本身。
- 容错计算只针对 L1 验证者集合（5 个等权、门槛 75%，见 [001] R-05），Primary 节点不参与该计算。

### V-08 已实测（2026-09-06）：**Primary 节点不是单点**

在重建的 001 开发网上停掉 **两个 Primary 节点**，观察 L1 行为：

| 观测 | 结果 |
|---|---|
| 对照组（Primary 在线） | 交易 1.0s 确认，高度 9 → 10 |
| Primary 全停后连发 4 笔（跨约 1 分钟） | **全部 1.0s 确认**，高度 10 → 11 → 12 → 13 → 14，单调递增 |
| 5 个 L1 验证者的 `isBootstrapped` | 全程保持 `true` |
| peers | 7 → 5（正好少了那 2 个 Primary） |
| 恢复 Primary 后 | 5s 重启，25s 内 7/7 恢复健康，peers 回到 7，交易照常 |

**结论**：L1 引导完成后，出块不依赖 P 链在线。**Primary 节点不构成新的单点，5 个验证者边界的冗余不会被它抵消，无需追加 Primary 冗余设计。** plan.md 的 Complexity Tracking 相应条目已关闭。

### 但 V-08 暴露了一个必须处理的副作用：健康检查会集体误报

Primary 全停期间，链**完全正常出块**，然而 5 个 L1 验证者的健康检查**全部转为 `HEALTHY=false`**，`devnet-status` 报"7/7 nodes NOT healthy"。原因是 L1 验证者带 `partial-sync-primary-network=true`，其健康判定包含 P 链可达性。

这对 002 是**设计级**的影响，因为 002 用容器健康检查驱动重启策略：

- 若照搬"健康检查失败即重启"，Primary 一挂就会把 5 个**工作正常**的验证者反复重启 —— 把一次局部故障放大成全链抖动；
- `devnet-status` 会在链完全可用时告诉运维"全部节点不健康"，与 US6"可区分故障与非故障"的要求直接冲突。

因此 [`contracts/node-runtime.md`](./contracts/node-runtime.md) 中"`catching-up` 不得判为不健康"这条规则需要扩充出第二种情形：**"P 链不可达但 L1 正常出块"同样不得判为不健康，也不得触发重启**。判据应以"本节点能否参与 L1 出块"为准，而非节点自报的综合健康位。

### 同一类误报的第二个窗口（2026-09-06 实测）：启动后约 2 分钟内

重建全部 8 个容器后 20 秒，两个工具对同一条链给出相反结论：

| 工具 | 判据 | 结论 |
|---|---|---|
| `devnet-start` | RPC 是否应答 | **READY**（数据卷已在，数秒即通） |
| 手工 RPC | `eth_blockNumber`、转账、部署合约 | 全部正常，高度单调递增 |
| `devnet-verify` 的 `node` 检查 | 各节点 `/ext/health` 的综合健康位 | `7/7 unhealthy: HTTP 503` |
| `devnet-verify` 的 `fault-tolerance` 检查 | 同上 | `0/5 validators online … chain has stopped producing blocks` |

同一时刻在容器内直查 `/ext/health` 得 `200 healthy:true`（约 2 分钟后），可见 503 是启动期的**真实但短暂**状态：
`/ext/health` 含 P 链项，而节点的 P 链部分同步比 L1 恢复慢。容器健康检查用的是 blockchainID 路径，
所以 `docker ps` 早已 `healthy` —— 唯独 `devnet-verify` 读了综合位。

结论：这与 Primary 缺席那次是**同一个缺陷的两个窗口**，判据都应改为"本节点能否参与 L1 出块"。
记为 T094（US6）。运行时行为不受影响 —— 误报只出现在验证器的判断里，不驱动重启。

### 归属的最终选择（T058，2026-09-06）：两个 Primary 放在 Ubuntu 机器上

data-model 起初把 Primary 放在两台 Windows 上（与 `win-1`／`win-2` 共处）。落 `deployments.lan` 时改为
`ubuntu-1`／`ubuntu-2`，理由来自 V-08 的另一半结论与 R-11：

- V-08 证明 Primary 全停不影响**已引导**的 L1 出块，但**引导本身**仍依赖它们：验证者的 `bootstrap-ips` 只指向这两个节点。
  停机重启后若 Primary 长时间缺席，验证者会错过引导窗口（实测教训：局部形态下正是靠 `depends_on: service_healthy` 才避开）。
- R-11 记录：Windows 上的容器运行时**需要用户登录**才启动。也就是说断电恢复后，Windows 机器上的容器可能长时间不起来，
  而 Ubuntu 上 `docker.service` 是开机自启的系统服务。
- 把"引导锚点"放在会自动恢复的机器上，把"可被容忍缺席一个"的验证者放在需要人工登录的机器上，
  两类节点的可用性要求与两类机器的恢复特性方向一致。

这不改变容错计算（Primary 不计入 5 边界），也不改变每边界 1 个验证者的结论 —— `ubuntu-1`／`ubuntu-2`
各自仍只有 1 个 L1 验证者。

**Sources**: [实测] 2026-09-06 在重建的 001 开发网上执行 quickstart 场景 I；两类节点的 `flags.json`；[001] R-04、R-05

---

## R-15 跨机形态的建链状态如何到位（2026-09-07 实测）

**Decision**: 跨机部署只需分发**仓库 + 2 个 Primary 节点的数据卷**。5 个 L1 验证者从**空卷**启动，
按 `bootstrap-ips` 从 Primary 同步 P 链，L1 从仓库里的创世起链。要保住现有高度时改用全卷导出／导入。

**问题**：`docker/bootstrap` 用 CLI 在**一台**机器上建链，随后把 7 个节点的数据库播种进本机 7 个卷
（`seed_node_volumes`，要求 7/7）。跨机形态下这 7 个卷分散在 5 台机器上，而**没有任何一步把它们送过去**。
这个缺口在撰写部署文档（T066）时才暴露，此前无任务覆盖。

**实测**（本机，全程可逆：先把 7 个卷导出为 tar 备份，约 1 MB）：

| 步骤 | 观测 |
|---|---|
| 测前状态 | 高度 `0x2e`（46），`blockchainId` `Wd8yzG…WwRVLhTqd` |
| 删除 **5 个验证者卷**，保留 2 个 Primary 卷，`devnet-start` | **6 秒就绪**，高度 `0x0` |
| 稳定后 | 8/8 容器健康，**5/5 验证者已引导、peers 6** |
| 运行中的链身份 vs 制品 | `platform.getBlockchains` 返回的 `id` 与 `subnetID` **与制品逐字一致** |
| `devnet-verify` | **14/14**，创世哈希与基准一致 |
| 从 tar 备份重新导入 7 个卷后启动 | 高度回到 **`0x2e`**，与测前完全一致；`devnet-verify` 14/14 |

**两个候选都成立，用途不同**：

| 候选 | 需分发 | 结果 | 适用 |
|---|---|---|---|
| **A（默认）** | 仓库 + **2 个 Primary 卷** | 链身份不变，**L1 高度从创世重新开始** | 新建跨机部署 |
| **B** | 仓库 + **全部 7 个卷** | 高度与全部状态原样保留 | 迁移现有链到跨机形态 |

**为什么 A 够用**：Subnet 与 Blockchain 是 P 链上的交易，只存在于持有 P 链的节点数据库里 ——
而那正是 2 个 Primary 节点。验证者需要的不是"别人的历史"，而是"能找到 P 链"：
`bootstrap-ips` 指向 Primary，创世在仓库里，其余自己长出来。
这与 `tests/e2e/node-data-loss.test.mjs` 已证的单节点删卷自愈（V-04／FR-006）是同一机制，
只是这次同时对 5 个验证者成立。

**候选 A 把跨机部署的人工步骤压到很低**：仓库走 git，只有 2 个卷需要拷贝，且都落在两台 Ubuntu 上
（Primary 的归属见 R-09）。导出／导入命令：

```bash
# 在建链的那台机器上导出
docker run --rm -v karmachain-primary-1-data:/data:ro -v "$PWD:/out" alpine tar czf /out/primary-1.tgz -C /data .
# 在目标机器上导入
docker volume create karmachain-primary-1-data
docker run --rm -v karmachain-primary-1-data:/data -v "$PWD:/in:ro" alpine tar xzf /in/primary-1.tgz -C /data
```

**Sources**: [实测] 2026-09-07 在单机形态上删除 5 个验证者卷后启动并复原

---

## R-10 多机编排：每机一份 compose，拓扑单点声明

**Decision**: 拓扑（谁在哪台机器、用什么 IP、属于哪个故障边界）在**唯一事实来源**中声明一次，由生成器产出**每台机器一份的 compose 文件与节点配置**。不引入集群编排系统。

**Rationale**:

- Compose 是单宿主工具，跨机需要额外机制。可选项中：Docker Swarm 引入 manager 节点，manager 失效会影响整个集群的编排能力——**为了消除单点而引入一个新单点**，方向错误；Kubernetes 对 5 台开发机是数量级过重的依赖（宪法第十三条）。
- "每台机器跑自己那份 compose"最简单，且天然满足故障边界独立：一台机器的编排失效不影响其他机器，因为它们之间**只有链层面的 P2P 关系，没有编排层面的依赖**。
- 生成器保证一致性（宪法第七、十六条）：改拓扑声明 → 重新生成 → 全部机器的配置一致更新，漂移测试拦截手改。

**Alternatives considered**: Swarm（引入新单点）、Kubernetes（过重）、Ansible 等配置管理（额外依赖，且我们的分发单元是容器不是主机配置）。

---

## R-11 Windows 故障边界的开机自启

**Decision**（2026-09-07 已裁定，见 [ADR-0006](../../docs/adr/0006-windows-failure-domain-autostart.md)）：
**采纳候选 3 —— 不做开机自启，接受人工恢复。** 宿主重启后由人登录并手动启动 Docker，
节点随之由 `restart: unless-stopped` 恢复。Linux 边界不受影响（`docker.service` 是开机自启的系统服务）。

候选 2（WSL2 内直接跑 Docker Engine + 计划任务）在实测中被排除：Windows **显式拒绝**
从 LOCAL SYSTEM 账户启动 WSL（`Wsl/WSL_E_LOCAL_SYSTEM_NOT_SUPPORTED`）。候选 1 要求自动登录
或在计划任务里存口令，两者都会在机器上留下一份可被滥用的凭据，换来的只是省掉一次登录 —— 不划算。

> 本条原先停在"列为**待定实现方案**，在 tasks 阶段确定并记入 ADR"。ADR 已于 2026-09-07 写就，
> 但本处未同步，直到 2026-09-09 的一致性核查才发现。**决策记录停在"待定"会误导** ——
> 读者无从知道它已经有答案。

以下保留当时的约束与候选清单，作为该裁定的依据。

**约束**：Windows 上的 Docker Desktop 随用户会话启动，没有受支持的"开机即以服务运行"方式。宿主重启后若无人登录，该边界的节点不会回来（spec 边缘用例已列）。Linux 侧由系统服务在开机时拉起，无此问题。

**候选方案**（需实测取舍）：

1. 容器 `restart: always` + Docker Desktop 设为登录时启动 + 宿主启用自动登录。简单，但自动登录降低宿主安全性。
2. 在 WSL2 内直接运行 Docker Engine（而非 Docker Desktop），由计划任务在开机时启动 WSL 与服务。绕开会话依赖，但 WSL2 的开机自启本身需要验证。
3. 接受 Windows 边界的可用性较低，通过 US6 的可观测性让运维及时发现"边界缺席"。

**取舍原则**：无论选哪个，**都不能让链的正确性依赖它**。5 个边界容忍 1 个失效，Windows 边界晚回来只影响余量，不影响链继续出块。这是把一个运维问题限制在运维层面，而不是让它上升为架构问题。

### V-09 实测（2026-09-07，在 win-1 上）

**候选 2 被否决 —— 不是取舍问题，是技术上不可能。**

开机触发的计划任务运行在 LOCAL SYSTEM 上下文。实测该上下文下启动 WSL：

```
whoami=nt authority\system
exitcode=-1
错误代码: Wsl/WSL_E_LOCAL_SYSTEM_NOT_SUPPORTED
```

Windows **显式拒绝**从 SYSTEM 账户启动 WSL。同一脚本在交互用户下 `exitcode=0`、输出 `wsl-ok`，
对照成立。Docker Desktop 的引擎住在 `docker-desktop` 这个 WSL2 发行版里，即便换成 WSL 内的原生
Docker Engine 也一样要先有 WSL —— 所以"绕开会话依赖"这条路在 Windows 上走不通。

> 取证过程中踩到一个混淆项，值得记下：第一次测试用 `powershell -File <未签名 .ps1>`，
> 结果 `LastTaskResult=1` 且标记文件未生成，看起来像 WSL 失败。实际是
> `LocalMachine` 执行策略为 `RemoteSigned` 挡下了脚本（交互会话因 `Process=Bypass` 不受影响）。
> 改用 `-EncodedCommand` 后任务本身成功执行，才拿到真正的 WSL 错误码。
> **"任务失败"与"任务里的命令失败"必须分开验证**，否则会把结论归到错误的原因上。

**候选 1 的现状**：两个前提中一个已就位、一个未就位。

| 前提 | 状态 |
|---|---|
| 容器重启策略 | **已就位** `restart: unless-stopped`（由 `render-compose.mjs` 生成） |
| Docker Desktop 登录时启动 | **已就位** —— `HKCU:\...\CurrentVersion\Run` 存在 `Docker Desktop` 项 |
| 宿主自动登录 | **未启用** —— `AutoAdminLogon` 为空 |

注意 `%APPDATA%\Docker\settings-store.json` 里 `AutoStart: False` 与 Run 项**互相矛盾**，
实际生效的是 Run 项。判断"会不会随登录启动"要看 Run 项，不要看那个设置键。

关于重启策略的选择：`unless-stopped` 优于 `always`。两者在 Docker 守护进程启动时都会拉起容器，
差别在于操作者此前显式跑过 `devnet-stop` 的情况 —— `always` 会把它们又拉起来，`unless-stopped` 尊重那次显式停止。
后者才是正确语义。

**发现了候选 1 与 3 之外的第四种方案（未实测）**：计划任务用**开机触发 + 以该用户身份运行 + 勾选"不管用户是否登录都要运行"**。
这种任务跑在该用户的**批处理登录会话**里，不是 SYSTEM，因此不撞上 `WSL_E_LOCAL_SYSTEM_NOT_SUPPORTED`。
它比自动登录更克制：不会留下一个已解锁的交互桌面，代价是任务里保存该账户口令。
**未实测**，因为验证它需要账户口令 —— 那属于运维方自己执行的范畴。

**选型（2026-09-07，运维方裁定）：候选 3 —— 不做开机自启，自行登录并手动启动 Docker。**

理由是前两个方案都要在机器上留下一份可被滥用的凭据（解锁的交互桌面，或任务凭据里的口令），
而收益只是省掉一次登录。开发网没有随时可用的承诺，这个交换不划算。

需要写清的后果：两台 Windows 同时是**虚拟化宿主**（ADR-0007），因此各自门控着不止一个节点 ——
登录 win-1 后需手动启动 Docker Desktop 与 VMware（开机 U22Node1／U22Node2），
`l1-1`、`l1-3`、`l1-4`、`primary-1`、`primary-2` 才回来；win-2 同理门控 `l1-2`、`l1-5`。
**停电后全链恢复需要有人登录 win-1。** 虚拟机内部不需人工介入（`docker.service` 开机自启 +
容器 `unless-stopped`），人工步骤只在两台 Windows 宿主上。

链的正确性不依赖它：停摆是安全的（V-05：不分叉、零回滚），数据不会丢（US1：各自从卷恢复）。
人工步骤影响的是**可用性**。必要配套是 US6 的可观测性（T076）——
`devnet-status` 必须把"边界缺席"与"节点故障"区分开，运维才能一眼看出该去登录哪台机器。

完整依据、比较表与迁移路径（若人工恢复变得难以接受，优先切换到第四种方案而非自动登录）见
[`docs/adr/0006-windows-failure-domain-autostart.md`](../../docs/adr/0006-windows-failure-domain-autostart.md)。

→ **V-09 已完成**（候选 2 技术上不可能；候选 3 已选定）

---

## R-12 故障边界独立性的保障

**Decision**: 独立性不是自动成立的性质，必须显式保障并记入 ADR。本特性要求在部署文档中声明每个边界的**共享失效因素**。

**Rationale**: 容错数学（[001] R-05：5 个等权验证者容忍 1 个离线）假设各边界独立失效。已识别的破坏因素：

| 因素 | 影响 | 应对方向 |
|---|---|---|
| 操作系统统一更新重启窗口 | 2 台 Windows 很可能在同一补丁窗口重启 → 同时损失 2 个边界 → **超出容错上限，链停摆** | 错开维护窗口或关闭自动重启 |
| 共用供电 | 跳闸即多边界同时失效 | 部署文档声明供电分组 |
| 共用交换机 | 全部边界同时失联 | 记录为已知限制（5 台开发机通常无法避免） |

**这是本特性中唯一无法靠代码解决的风险**：代码可以校验"拓扑声明里每个边界不超过 1 个验证者"（FR-021），但无法验证"这两个边界真的会独立失效"。因此要求把保障手段写成显式声明，并由 US6 的可观测性提供事后判别（同时失效 vs 级联故障）。

### 实际确认（2026-09-06，运维方逐项答复）

| 上表因素 | 确认结果 | 落地 |
|---|---|---|
| 操作系统统一更新重启窗口 | **两台 Windows 的自动更新均已关闭** | 不声明该因素 |
| 共用供电 | **五台机器独立供电** | 不声明该因素 |
| 共用交换机 | **交换机分开** | 不声明该因素；残留的共同互联路径记为已知限制 |

于是 `topology.deployments.lan` 中 5 个边界的 `sharedFailureFactors` 全部为**空数组**，
`scripts/devnet-topology --deployment lan` 输出零告警。

上表"共用交换机 → 记录为已知限制"这一行的结论需要修正：交换机分开确实消除了"单台接入交换机即单点"，
但实测中 win-1 能直接从 win-2 取得 ARP 应答，且 5 台机器同处 `192.168.1.0/24` ——
多台交换机构成一个广播域必然存在互联路径（级联链路或共同上行设备）。该路径**消不掉**，
但其后果已被 V-05 界定为**安全停摆、区块零回滚**，属于可用性而非安全性问题。

因此它被记为"已知限制"而**不**声明为 `sharedFailureFactors` 条目：声明会让每次 `devnet-topology`
都产生一条无法执行修正的告警，而反复出现的无解告警会训练人忽略全部告警。

### 推翻（2026-09-07）：上面那三项确认是对的，但结论是错的

排查 win-2 端口不可达时对局域网做了 ARP 清点，发现声明的 5 个边界只对应 **2 台物理机**：

| 证据 | 观测 |
|---|---|
| `.13`（win-2）与 `.23`（U22Node3）的 MAC | **同一个** `9C-B6-D0-04-7A-E1` |
| `.21` / `.22` 的 MAC | `00-0C-29-*` = **VMware OUI** |
| win-1 上的进程 | `vmware-vmx` ×2 → `F:\VM\U2204_Node1\U22Node1.vmx`、`U22Node2.vmx` |

即 U22Node1／U22Node2 是 win-1 上的 VMware 客户机，U22Node3 是 win-2 上的
（VMware 在 Wi-Fi 上桥接无法给客户机独立 MAC —— 802.11 一次关联只能带一个 MAC，只能复用宿主的）。
**虚拟机的故障边界是它的虚拟化宿主**，于是 win-1 承载 3 个验证者 + 2 个 Primary，win-2 承载 2 个 ——
任一台物理机失效都会跌破 75% 查询门槛，链停摆。

**这暴露了模型本身的缺陷**，不只是数据填错：当时共享因素只产生 WARN，而 `tolerateWholeDomainLoss`
仍按**声明边界**计算，于是校验器一边告警"将同时损失 3 个验证者"、一边打印
"可容忍 1 个边界整体失效 **[OK]**"。告警与承诺各说各话，等于把最关键的判断交给读日志的人。

修正（T096）：引入**有效边界** —— 共享同一因素的声明边界用并查集合并（因素可传递：
A~B 共享 f1、B~C 共享 f2 ⇒ A/B/C 同生共死），承诺按合并后判定。`lan` 现在如实输出
`[FAIL] 无法容忍边界整体失效` 并列出 `5 → 2` 的合并过程。

**提问方式也有教训**：供电／交换机／更新窗口这三问都得到了正确答复，结论却仍然错了 ——
缺的是**先确认"这几台是不是各自独立的物理机"**。ADR-0007 的维护责任清单已把这一项列在首位，
并附上可执行的清点命令（同 MAC 分组、虚拟机厂商 OUI、宿主上的 `vmware-vmx` 进程）。

完整依据、维护责任清单（哪些物理变化必须回写声明）、恢复整域容错所需的硬件与替代方案见
[`docs/adr/0007-failure-domain-independence.md`](../../docs/adr/0007-failure-domain-independence.md)（T065）。

---

## R-13 迁移与退役

**Decision**: 分两阶段替换，**不与 001 的单容器模式并存**（spec Assumptions 已确立）。

| 阶段 | 交付 | 退役 |
|---|---|---|
| 一 | 单机、一节点一容器、崩溃自愈、运行时脱离 CLI | `docker/devnet/` 的单容器编排、`lib/avalanche.sh` 的运行期调用、socat 代理 |
| 二 | 5 台机器 5 个故障边界 | 阶段一的单边界拓扑声明（保留为本地开发形态） |

**链状态处理**：当前链已因本次故障不可用，且用户已决定不恢复。因此阶段一从创世重建，**没有需要迁移的存量状态**——这消除了本特性最大的一处迁移风险。创世哈希、Chain ID、账户余额均不变（FR-024），对第三方的公开契约不受影响。

**既有能力的保留**：001 的出生证明机制（stamp / 退出码 12）、13 项验证、九类失败分类、公开制品生成与漂移测试全部保留，由 FR-025 至 FR-028 约束。

---

## 实现期验证清单

研究阶段无法确证，**必须在实现中用真实运行验证**（宪法第十二条；沿用 001 的 V-编号惯例）。任何一项结果与预期不符，都要回到本文件更新结论。

| 编号 | 验证内容 | 判据 | 关联 |
|---|---|---|---|
| **V-01** | 单个验证者被 `SIGKILL` 后重启 | 无人工干预恢复、追平高度、重新参与共识 | FR-002、FR-010、SC-004 |
| **V-02** | 全部节点同时 `SIGKILL` 后重启 | 链从终止前高度继续，不回创世，无需重置 | FR-003、SC-001、SC-002 |
| **V-03** | 节点在**引导过程中途**被杀 | 重启后能继续或自行清理重来，不进入需人工干预的状态 | 边缘用例 |
| **V-04** | 删除单个节点的数据卷后重启该节点 | 从对等节点重新同步，不影响其余节点，不需全链重置 | FR-006、SC-011 |
| **V-05** | 停掉 2 个验证者（超出上限）再恢复 | 停摆期间不分叉；恢复后自动继续；**已确认区块零回滚** | FR-009、SC-006 |
| **V-06** | 跨机 staking 端口连通性与防火墙 | 5 台机器两两可达；Windows 入站规则可用 | FR-023。**2026-09-07 基本完成**：win-1 → 3 台 Ubuntu 全通；win-1 ↔ win-2 路径已验证可达（有监听时 `TcpTestSucceeded: True`），Windows allow 规则生效。**"win-2 被防火墙拦下"已证实为判据造成的假阳性** —— Windows 与 Linux 对无监听端口的应答方式不同。各机器自身端口的最终确认留到节点起来后复跑。详见 R-08 的"V-06 实测"与"判据本身是错的" |
| ~~**V-07**~~ | ~~`public-ip` 配置错误时的表现~~ | ✅ **2026-09-06 已实测：完全无声。** 节点正常启动、唯一相关日志对配对/配错完全相同、单机形态根本不暴露症状。检测只能落在宿主侧且须在节点启动前，已实现为退出码 13（T062）。详见 R-08 的"V-07 实测" | 边缘用例 |
| ~~**V-08**~~ | ~~2 个 Primary Network 节点全部停止时，已运行的 L1 能否继续出块~~ | ✅ **2026-09-06 已实测：能。** 4 笔交易全部 1.0s 确认，高度单调递增。Primary 不是单点，无需追加冗余设计。副产品：健康检查会集体误报，见 R-09 | R-09 |
| ~~**V-09**~~ | ~~Windows 宿主重启后节点是否自动回来~~ | ✅ **2026-09-07 已完成。** 候选 2（WSL + 开机计划任务）技术上不可能：SYSTEM 上下文下 `Wsl/WSL_E_LOCAL_SYSTEM_NOT_SUPPORTED`（交互用户下同一脚本成功，对照成立）。运维方选定**候选 3**：不做自启，自行登录并手动启动 Docker。见 ADR-0006 | R-11、边缘用例 |
| ~~**V-10**~~ | ~~链别名在显式 `aliases.json` 下可用~~ | ✅ **2026-09-06 已实测，且结论与预期相反**：`aliases.json` 被读进配置但**不注册 HTTP 路由**，别名路径 404。改由无状态代理重写后，两条路径 `eth_chainId`/`eth_blockNumber`/`net_version` 逐项相同。详见 R-05 的修正 | R-05、FR-024 |
| ~~**V-11**~~ | ~~`http-allowed-hosts` 放宽后跨机 RPC 可达~~ | ✅ **2026-09-06 已实测**：`127.0.0.1` / `localhost` / 任意主机名（`karmachain.local`）全部 200。代理统一改写 Host 后，"必须用 IP 不能用域名"这条限制对经代理访问的第三方不再适用 | R-07 |
| ~~**V-12**~~ | ~~官方镜像 + subnet-evm 插件能加载 VM~~ | ✅ **2026-09-06 已实测**：， 已 serving database / vm services | R-02 |

~~V-08 必须最先做~~ —— **已于 2026-09-06 完成，结论为"能继续出块"，设计无需改动。** 剩余 11 项按 tasks.md 的阶段推进。

V-08 的真正收获不是那个是/否答案，而是它顺带暴露的健康检查误报（见 R-09）：**链完全正常，但全部 5 个验证者自报不健康**。这类"指标说坏了、实际好着"的偏差，只有真跑一次才会露出来——这也正是宪法第十二条要求把未确证项列成实测清单、而不是从文档推断的理由。

---

## R-14 基线度量（2026-09-06，001 架构）

**Decision**: 记录 001 架构退役前的性能与操作基线，供 SC-007（启动耗时 ≤ 1.5 倍）与 FR-030（人工步骤不增）在 002 完成后做对比断言。

**采集方式**: 同一台机器（Windows 10 Pro 19045 / Docker Desktop 29.7.2 / amd64），冷启动与恢复各 3 次取中位数。

| 度量 | 三次观测 | **中位数** | 说明 |
|---|---|---|---|
| `devnet-reset` | 7s / 3s / 2s | **3s** | 删除卷 |
| **冷启动**（reset 后首次 `devnet-start`） | 85s / 80s / 80s | **80s** | 含 create + deploy L1，是 SC-007 的对比基准 |
| **恢复启动**（`devnet-stop` 后 `devnet-start`） | 16s / 16s / 16s | **16s** | 快照恢复，002 中该路径消失（改为各节点从自身卷恢复） |
| `devnet-stop` | 2s / 2s / 2s | **2s** | 含保存快照 |
| `devnet-verify`（13 项） | 17s | 17s | 参考值，非 SC-007 对象 |
| **人工步骤**（克隆 → 可用链） | 2 步 | **2 步** | `git clone` + `scripts/devnet-start`，FR-030 的对比基准 |

**创世可复现性旁证**：三次 reset + 冷启动得到的创世哈希完全一致，均为 `0x19cfde1f02e585020cdae83071bac33c7d81e411cacf7f306b82ceabe98892ed`。这是 SC-008 在单机形态下的实测证据（跨机形态待阶段二补齐）。

**002 的对比口径**：SC-007 要求"单边界启动耗时 ≤ 当前的 1.5 倍"，对应 **≤ 120s**。注意 002 取消了快照机制，因此"恢复启动 16s"这一档在 002 中没有对应物——002 的每次启动都是各节点从自身数据卷恢复，其耗时应与冷启动同量级或更快，届时按冷启动口径对比。

**Sources**: [实测] 2026-09-06 本机测量；`docs/devnet.md` §1 声明的环境
