# KarmaChain 本地开发网络 —— 开发者手册

> 本文档中的链参数（Chain ID、端口、代币…）以 [`blockchain/protocol.json`](../blockchain/protocol.json) 为唯一权威；
> 逐参数取值与理由见生成的 [`protocol-parameters.md`](protocol-parameters.md)；架构决策见 [`adr/`](adr/)。

**三步上手**

```bash
git clone <repo> && cd karma-chain
scripts/devnet-start.sh      # Windows: scripts\devnet-start.ps1（首次约 80 秒，含镜像构建约 5 分钟）
scripts/devnet-verify.sh     # 14 项自动化检查，应输出 "KarmaChain is READY"
```

得到：Chain ID **20189** 的 EVM 链，RPC `http://127.0.0.1:8545/ext/bc/karmachain/rpc`，
6 个预置账户（共 39,500,000 KARMA），5 个 PoA 验证者 + 2 个主网节点。

## 1. 前置条件

| 项 | 要求 |
|---|---|
| Docker | Docker Desktop（Windows 需 WSL2 后端 / macOS）或 Docker Engine 24+ 与 Compose v2 |
| 资源 | 给 Docker ≥ 4 GB 内存（7 节点实测总 RSS ≈ 1.1 GB）、≥ 5 GB 磁盘 |
| 端口 | 宿主 8545 空闲（可用 `.env` 中 `KARMACHAIN_RPC_PORT` 覆盖） |
| 首次构建 | 需访问 Docker Hub 与 GitHub Releases 下载锁定版本；之后**完全离线可用** |

宿主机**不需要**安装 Go、Node、Avalanche CLI。

## 2. 命令

| 动作 | Windows | macOS / Linux | 说明 |
|---|---|---|---|
| 建链 | `scripts\devnet-bootstrap.ps1` | `scripts/devnet-bootstrap.sh` | **一次性**，约 80 秒。唯一用到 Avalanche CLI 的地方 |
| 启动 | `scripts\devnet-start.ps1` | `scripts/devnet-start.sh` | 建链后每次约 5–15 秒。**没有"恢复快照"这条路径** —— 每个节点从自己的数据卷恢复，上次是否优雅停止与本次能否启动无关 |
| 停止 | `scripts\devnet-stop.ps1` | `scripts/devnet-stop.sh` | 仅停止容器，**不保存任何东西** —— 因为没有东西需要保存 |
| 重置 | `scripts\devnet-reset.ps1` | `scripts/devnet-reset.sh` | 删除链数据卷，下次启动回到创世 |
| 验证 | `scripts\devnet-verify.ps1` | `scripts/devnet-verify.sh` | 14 项自动化检查，约 15 秒；退出码 0 通过 / 1 失败 |
| 状态 | `scripts\devnet-status.ps1` | `scripts/devnet-status.sh` | 逐节点的恢复状态、高度、peers、所属故障边界；显示在线数与容错上限的关系 |
| 拓扑 | `scripts\devnet-topology.ps1` | `scripts/devnet-topology.sh` | 校验并展示故障边界与推导出的容错上限；退出码 13 = 违反容错约束 |
| 重新生成 | `scripts\devnet-render.ps1` | `scripts/devnet-render.sh` | 由 `protocol.json` 重新生成全部派生物；`--check` 只检查漂移 |

启动成功会打印 READY 摘要：RPC URL、Chain ID、代币、验证者数、出块模式、开发账户余额。退出码见 [`contracts/cli-interface.md`](../specs/001-local-avalanche-devnet/contracts/cli-interface.md)。

## 3. 连接工具

RPC：`http://127.0.0.1:8545/ext/bc/karmachain/rpc` · Chain ID **20189** · 符号 **KARMA** · 18 位

> **Host 头限制**：节点只接受 `Host` 为 `localhost` / IP 字面量的请求（avalanchego `--http-allowed-hosts` 默认值），用其他主机名访问会得到 403。宿主上用 `127.0.0.1` 或 `localhost` 即可。

### 3.1 JS/TS 客户端（viem）—— 已自动化验证 ✅

`tests/integration/start-stop.test.mjs` 用 viem 完成：读 chainId / networkId / 健康、区块 0 余额核对、转账并校验回执 6 个字段与余额守恒（确认耗时 ≈ 2 s）、按需出块。运行：

```bash
npm run test:integration                       # 宿主（需 Node ≥ 22）
docker compose run --rm verify npm run test:integration   # 无需宿主 Node
```

### 3.2 Foundry `cast` —— 已验证 ✅（2026-09-01，cast v1.8.1，零自定义参数）

| 命令 | 结果 |
|---|---|
| `cast chain-id` | `20189` |
| `cast balance anvil-0 --ether` | `1000000.000000000000000000` |
| `cast send anvil-0 → anvil-1 --value 1ether` | `status 1 (success)`、`gasUsed 21000`、`blockNumber 9`，**2 s** 确认（SC-006 ≤ 10 s） |
| 余额复核 | 发送方 −1 − 0.003675（fee），接收方 +1 |

无宿主 Foundry 时可用官方镜像（compose 内网需用 devnet 容器 IP，见 Host 头限制）：

```bash
IP=$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' karmachain-devnet)
docker run --rm --network karmachain-devnet_default ghcr.io/foundry-rs/foundry:v1.8.1 \
  "cast chain-id --rpc-url http://$IP:8545/ext/bc/karmachain/rpc"
```

宿主已安装 Foundry 时：

```bash
RPC=http://127.0.0.1:8545/ext/bc/karmachain/rpc
cast chain-id --rpc-url $RPC                                        # → 20189
cast balance 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 --rpc-url $RPC --ether   # anvil-0 → 1000000
cast send --rpc-url $RPC --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  0x70997970C51812dc3A010C7d01b50e0d17dc79C8 --value 1ether        # anvil-0 → anvil-1
cast block latest --rpc-url $RPC --field number
```

预期：无需任何自定义参数；`cast send` 在 ≤ 10 s 内返回含 `status 1` 的回执。

### 3.3 MetaMask —— 已验证 ✅（2026-09-01，手工）

添加网络时 MetaMask 自动校验 `eth_chainId` 通过；导入 `anvil-1` 后余额正确显示；向 `anvil-2` 转 1 KARMA，网络费估算 **0.0005 KARMA**（= 21,000 gas × 25 gwei `minBaseFee`，与 protocol.json 一致），**约 3 秒确认**。全程无需修改任何 gas / 网络参数。操作步骤如下：

1. 设置 → 网络 → 手动添加网络：
   - 网络名称 `KarmaChain Local`
   - RPC URL `http://127.0.0.1:8545/ext/bc/karmachain/rpc`
   - Chain ID `20189`
   - 货币符号 `KARMA`
2. 导入账户 → 私钥 → 粘贴 `blockchain/accounts/dev-accounts.json` 中 `anvil-0` 的私钥。
3. 预期：余额显示 1,000,000 KARMA（若已跑过集成测试则略少）；向 `anvil-1` 发送 1 KARMA，几秒内确认。

> 这些私钥是**公开的测试密钥**，MetaMask 里请使用单独的测试 Profile，绝不与真实资产账户混用。

## 3.4 自动化验证

```bash
scripts/devnet-verify.sh            # 14 项完整检查（约 15 秒）
scripts/devnet-verify.sh --quick    # 跳过合约编译与 RPC 方法探测（仅本地迭代，不可用于验收）
```

14 项检查：`rpc`、`chain-id`、`network-id`、`token`、`node`（7 个节点均在服务 —— 判据是"能否参与 L1 出块"，不是节点自报的综合健康位）、`validator`（5 个 L1 已 bootstrapped、peers ≥ 4、NodeID 与仓库密钥一致）、`balance`（区块 0 余额精确等于创世）、`transfer`、`receipt`（回执 6 个字段 + 余额守恒）、`block-production`（每笔交易产生新区块）、`contract`（编译部署 `Counter.sol` 并读写验证）、`rpc-methods`（FR-012 十个方法逐一探测）、`protocol-consistency`（运行中创世哈希 == 基准）、`fault-tolerance`（在线验证者数与容错上限的关系）。

输出为逐项 `[OK]/[FAIL]/[SKIP]/[UNSUPPORTED]` 行 + `.devnet/verify-report.json`（结构见 `contracts/verification-report.schema.json`）。**每个失败都带 FR-030 故障类别**，便于快速定位是配置、节点、共识、RPC 还是交易问题。

> **为什么要在容器里跑**：逐节点检查要直连每个节点的 HTTP 端口，而单机形态下那是容器网段（`172.28.0.0/24`）——
> 宿主到不了，只有对外的 RPC 代理端口发布到了宿主。`scripts/devnet-verify` 因此用
> `docker run --network karmachain` 起验证容器。在宿主直接跑 `node tools/verify/verify-network.mjs` 时，
> `node` / `validator` / `fault-tolerance` 三项会降级为 `[SKIP]` 并提示改用脚本；其余照常执行。
> 跨机形态下节点地址是各机器的局域网 IP，宿主上直接跑也能覆盖全部检查。

## 3.5 重置与状态保留

| 操作 | 效果 |
|---|---|
| `scripts/devnet-stop` → `scripts/devnet-start` | 各节点从自己的数据卷恢复，高度与余额延续 |
| **强制终止**（`docker kill` / 断电 / 强制重启 Docker）→ `scripts/devnet-start` | **同样延续**，实测 12–17 秒恢复。这是功能 002 的核心改变：崩溃不再需要重置（US1） |
| `scripts/devnet-reset` → `scripts/devnet-start` | 删除卷，从创世重新部署（≈ 80 s），高度回到 4（4 笔 PoA 初始化交易） |

首次部署成功时容器在卷内写入 `karmachain.stamp.json`（configVersion / chainId / networkId / 创世文件 sha256 / 实测创世区块哈希）。之后每次启动都会比对：**任一项与当前 `protocol.json` / 创世不一致即拒绝启动（退出 12）**并提示 reset —— 改了协议参数就必须换一条链，不会得到"半新半旧"的链（宪法第十五条）。

## 3.6 跨环境一致性核对（SC-002）

目标：证明两台机器（或两位开发者）从同一提交启动得到**同一条链**。

**基准（环境 A，configVersion 1.1.0，2026-09-02）**

| 项 | 值 |
|---|---|
| 提交 | 见 `git log`（创世文件 sha256 `a265d8d3f4eb…`，完整值 `sha256sum blockchain/genesis/karmachain.genesis.json`） |
| 创世区块哈希 | `0x19cfde1f02e585020cdae83071bac33c7d81e411cacf7f306b82ceabe98892ed`（亦记录于 `blockchain/genesis/karmachain.genesis.hash`） |
| Chain ID / Network ID | 20189 / 1337 |
| 环境 | Windows 10 Pro 19045，Docker Desktop 29.7.2，Compose v5.4.0，amd64 |
| 首次启动耗时 | 78–80 s |

**环境 B 操作步骤**

```bash
git clone <repo> && cd karma-chain
git log -1 --format=%H                      # 与环境 A 使用同一提交
scripts/devnet-start                        # 首次构建镜像会多花几分钟
# READY 摘要中的 "Genesis hash" 行应与上表完全一致；或用 RPC 核对：
curl -s -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":["0x0",false]}' \
  http://127.0.0.1:8545/ext/bc/karmachain/rpc | grep -o '"hash":"0x[0-9a-f]*"' | head -1
curl -s -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266","0x0"]}' \
  http://127.0.0.1:8545/ext/bc/karmachain/rpc      # → 0xd3c21bcecceda1000000（1,000,000 KARMA）
```

三项全等（创世哈希、链 ID、区块 0 余额）即通过。把环境 B 的结果（OS / Docker 版本 / 哈希 / 耗时）追加到上表。

**实测记录（SC-002 ✅ 通过，configVersion 1.0.0 时执行）**

| 项 | 环境 A | 环境 B |
|---|---|---|
| 日期 | 2026-09-01 | 2026-09-02 |
| 机器 | Windows 10 Pro 19045，Docker Desktop 29.7.2，amd64 | macOS（主机名 azmyMM），Docker Desktop |
| 创世区块哈希 | `0xcd807715…3efa` | `0xcd807715…3efa` **一致** |
| Chain ID / Network ID | 20189 / 1337 | 20189 / 1337 **一致** |
| 区块 0 账户余额 | 6/6 与创世一致 | READY 摘要 6/6 一致（含 ewoq 999999 的 PoA 扣费特征） |
| 启动后高度 | 4 | 4 **一致** |

两台机器、两套 Docker、独立构建的镜像得到同一条链——可复现性承诺（宪法第七条 / SC-002）成立。

> ⚠️ 上表在 **configVersion 1.0.0** 下取得。2026-09-02 的创世分配变更（1.1.0）使基准哈希变为 `0x19cfde1f…92ed`。环境 B 若要继续与环境 A 比对，需 `git pull` 到最新提交并执行 `scripts/devnet-reset && scripts/devnet-start`（旧链数据会被 stamp 守卫拒绝启动，退出 12）。跨环境结论本身不受影响——机制已验证过一次，换参数后重跑即可。

## 4. 开发账户

私钥见 [`blockchain/accounts/dev-accounts.json`](../blockchain/accounts/dev-accounts.json)，创世分配见 [`protocol-parameters.md`](protocol-parameters.md)。`anvil-*` 为 Foundry/Hardhat 默认账户（助记词 `test test … junk`），`ewoq` 是 Avalanche 官方测试账户，被 CLI 用作 PoA 管理员并支付初始化 gas，因此启动后余额略低于创世值。

| 账户 | 创世余额（KARMA） | 典型用途 |
|---|---|---|
| `ewoq` | 1,000,000 | PoA 管理员 / P-Chain 手续费（勿用于业务测试） |
| `anvil-0` | 1,000,000 | 常规小额测试 |
| `anvil-1` | 10,000,000 | 大额转账、资金池 |
| `anvil-2` | 7,500,000 | 大额转账（取不同数值便于区分账户） |
| `anvil-3` | 10,000,000 | 大额转账、gas 压测 |
| `anvil-4` | 10,000,000 | 大额转账、gas 压测 |

初始供应合计 **39,500,000 KARMA**（configVersion 1.1.0）。开发网络供应量不代表主网代币经济学。

## 5. 已知行为

- **链空闲时区块高度不增长**：Subnet-EVM 只在有待处理交易时出块（源码 `block_builder.go needToBuild`），不是故障。
- 部署完成时高度已为 4：Avalanche CLI 用 ewoq 发了 4 笔 PoA ValidatorManager 初始化交易。
- `docker compose logs` 会保留容器上一轮运行的输出；`scripts/devnet-start` 只解析本次启动之后的日志。

## 5.1 节点状态与日志

```bash
scripts/devnet-status.sh              # 7 个节点：角色/端口/running/healthy/bootstrapped/peers/NodeID
scripts/devnet-status.sh --json       # 机器可读，供脚本消费
scripts/devnet-logs.sh                # 列出可选节点与其日志文件
scripts/devnet-logs.sh l1-3           # 看 l1-3 的节点日志（main.log）末 200 行
scripts/devnet-logs.sh l1-3 --chain -f  # 跟随 L1 链日志
scripts/devnet-node.sh status l1-3    # 单节点进程状态
```

`devnet-status` 退出码：0 全部健康 / 1 存在不健康节点 / 2 网络未运行。健康节点的 `peers` 为 6（7 节点网络中各自看到其余 6 个）。

**日志脱敏（FR-026）**：avalanchego 启动时会把全部传入标志打进 `main.log`，其中包含
`staking-tls-key-file-content` 与 `staking-signer-key-file-content`（节点私钥的 base64）。
`devnet-logs` **默认屏蔽**这些字段与 PEM 私钥块；`--raw` 可关闭屏蔽（会打印密钥材料，仅在确有必要时使用）。
这些密钥就是仓库里 `blockchain/validators/dev/` 下已公开的 DEVELOPMENT ONLY 材料，因此对本开发网络不构成新的泄露；
但把日志贴到 issue/聊天时仍应使用默认（脱敏）输出。生产环境绝不可复用这些密钥（FR-025）。

## 5.1.1 链上合约清单

```bash
scripts/devnet-contracts.sh              # 创世内置 + 运行期部署的全部合约
scripts/devnet-contracts.sh --json       # 机器可读
scripts/devnet-contracts.sh --from 100   # 只扫 100 号之后的区块（链长了以后用）
scripts/devnet-contracts.sh --no-probe   # 跳过标准接口探测
```

每条给出地址、代码大小、来源（创世 / 哪个区块）、部署者，并标注：

| 标记 | 含义 |
|---|---|
| `[official]` | 在公开产物 `chain-info.json` 的 `contracts` 里列出 |
| `[internal]` | 创世合约集的内部实现细节（ValidatorMessages 库、ProxyAdmin） |
| `[unlisted]` | **不是官方合约** —— 示例与探针（Greeter、Counter 之类）都在这里 |

还会探测若干无参 view 函数（`name/symbol/decimals/totalSupply/owner`）作为合约类型提示。

> **本链目前没有区块浏览器**（记录在 `docs/adr/README.md` 待决策）。调试**单笔交易**用
> `cast run <txhash> --rpc-url <rpc>` 已经足够——它会重放交易并显示完整调用追踪与解码后的事件。
> 本命令填补的是另一个空缺：**浏览全链有哪些合约**。源码验证、诈骗标记、面向非开发者的界面
> 仍然需要真正的浏览器，那是主网前的必需项。

## 5.2 故障注入（演练与测试用）

```bash
scripts/devnet-node.sh stop l1-3      # 终止单个节点（模拟崩溃）
scripts/devnet-node.sh start l1-3     # 重新拉起（插件进程随之重建）
scripts/devnet-node.sh pause l1-3     # SIGSTOP 冻结（仅适合短时，见下）
scripts/devnet-node.sh resume l1-3    # SIGCONT
```

**实测结论（tests/e2e/single-validator-down.test.mjs）**：停掉 1 个 L1 验证者后网络**继续正常出块**，
转账确认时间保持约 4 秒不变——与 research R-05 的推算一致（默认 Snow 参数下法定门槛为
`alphaConfidence/K = 15/20 = 75%`，4/5 = 80% ≥ 75%）。`devnet-status` 会报 1/7 不健康并以 1 退出，
`devnet-verify` 的 `node`/`validator` 两项失败且带正确类别，而 `transfer`、`block-production` 仍通过。

> ⚠️ **`pause` 只适合短时（≲ 1 分钟）**：冻结过久会拆掉 avalanchego 与其 subnet-evm 插件之间的 gRPC 连接，
> `resume` 后链健康检查会持续报 `grpc: the client connection is closing` 且无法自愈——此时需 `stop` + `start` 恢复。
> 需要节点长时间离线时请直接用 `stop`。

## 6. 排障（按 FR-030 类别）

| 类别 | 现象 | 处理 |
|---|---|---|
| configuration | `PREFLIGHT FAILED … ports already in use`（退出 11） | 另一套 devnet 仍在容器内运行；`docker compose down` |
| configuration | `host port 8545 is already in use`（退出 11） | 停掉占用者，或在 `.env` 设置 `KARMACHAIN_RPC_PORT` |
| configuration | `existing chain data does not match…`（退出 12） | 协议参数变了，链数据是旧的；`scripts/devnet-reset` 后再启动 |
| genesis | `genesis chainId != protocol.json` / 创世文件损坏（退出 10） | `npm run protocol:render` 后重置 |
| node | `devnet-status` 报 N/7 不健康（退出 1） | `scripts/devnet-logs.sh <node>` 看日志；必要时 `devnet-node stop/start <node>` |
| validator | `devnet-verify` 报某节点未 bootstrapped | 同上；若长时间不恢复则 `scripts/devnet-reset` |
| p2p | 某节点 `peers` 明显低于其他节点 | 查该节点日志的对等连接相关条目 |
| rpc | 403 `invalid host specified` | 见 §3 Host 头限制 |
| rpc | `devnet-verify` 报 `connection refused` | 网络未启动或已停止；`scripts/devnet-start` |

上述每一类都有对应的自动化回归（`tests/e2e/failure-classification.test.mjs`，6/6 通过，SC-011），
因此"错误信息可操作、类别正确"这件事是被测试守住的，而不是靠人工检查。

### 其他常见问题

| 现象 | 处理 |
|---|---|
| `PREFLIGHT FAILED … missing tools in image` | 镜像过旧：`docker compose -f docker/compose/<deployment>-<domain>.yml build` |
| `image binary versions do not match protocol.json` | 改过 `protocol.json` 的版本字段但没重建镜像：删掉 `karmachain/node:local` 后重新 `scripts/devnet-start` |
| 非正常终止后启动失败 | **不应再发生**（002 已消除快照依赖）。若确有发生，请按"5.1 节点状态与日志"取证后记录 —— 这属于回归，不是预期行为 |
| 长时间 `pause` 后节点无法恢复（`grpc: the client connection is closing`） | `scripts/devnet-node.sh stop <node>` 再 `start <node>` |
| 磁盘空间不足 | 节点日志会报错；清理 Docker（`docker system prune`）或扩容后重启 |

## 7. 测试与验证

| 命令 | 内容 | 耗时 |
|---|---|---|
| `npm test` | 单元测试（协议参数约束、创世漂移、账户派生、报告 schema、硬编码扫描） | ~1 秒 |
| `npm run test:integration` | 集成测试（对运行中的链：链身份、创世余额、转账回执、按需出块） | ~15 秒 |
| `npm run test:secrets` | 秘密扫描（仓库 + 运行时日志） | ~4 秒 |
| `scripts/devnet-verify.sh` | 14 项网络验证 | ~15 秒 |
| `node --test tests/e2e/<name>.test.mjs` | 端到端（见下） | 分钟级 |

不带宿主 Node 时，前三项都可以在容器内跑：`docker compose run --rm verify npm test`。

**端到端测试**（长时，按需运行）

| 文件 | 覆盖 | 备注 |
|---|---|---|
| `reset-recreate.test.mjs` | 重置 → 启动 ×10，创世哈希全等（SC-003） | ~15 分钟；`KARMACHAIN_RESET_CYCLES=2` 可快速冒烟 |
| `param-change.test.mjs` | 改 Chain ID 的完整闭环（漂移 → 重渲 → 拒启 12 → 重置 → 新链） | ~85 秒 |
| `single-validator-down.test.mjs` | 停 1 个验证者后网络仍出块（R-05） | ~2 分钟 |
| `failure-classification.test.mjs` | 五类故障注入与分类（SC-011） | 需 `KARMACHAIN_ALLOW_DISRUPTIVE=1` |
| `verify-negative.test.mjs` | 停网后验证器失败且分类正确 | 需 `KARMACHAIN_ALLOW_DISRUPTIVE=1` |
| `secret-scan.test.mjs` | 私钥/助记词/日志泄露 | 见上 |
| `vm-alloc-drift.test.mjs` | CLI 注入的 ValidatorManager 合约是否漂移 | ~2 秒 |

## 8. 修改协议参数（宪法第十五条流程）

任何共识相关参数（Chain ID、代币、Gas、验证者数量、创世分配…）都只能这样改：

```bash
# 1. 编辑唯一事实来源
vi blockchain/protocol.json          # 同时递增 configVersion
vi blockchain/protocol-rationale.json  # 补充取值理由（缺理由会导致文档生成失败）

# 2. 重新生成全部派生物（创世、参数文档、compose.env）
npm run protocol:render

# 3. 单元测试会指出还有什么没同步
npm test

# 4. 重置并重新启动（旧链数据会被 stamp 守卫拒绝，退出 12）
scripts/devnet-reset.sh && scripts/devnet-start.sh

# 5. 若创世改变，更新哈希基准并重跑验证
#    新哈希见 READY 摘要的 "Genesis hash" 行 → 写入 blockchain/genesis/karmachain.genesis.hash
scripts/devnet-verify.sh
```

**不要**手改 `blockchain/genesis/karmachain.genesis.json`、`docs/protocol-parameters.md`、
`blockchain/compose.env` —— 它们都是生成物，漂移测试会拦下手改。

### 客户端缓存：reset 之后 MetaMask 显示旧余额 / nonce 报错

**每次 `scripts/devnet-reset` 之后都要做一次。** 重置换了创世但 Chain ID 不变，MetaMask 按 Chain ID 缓存余额、nonce 与交易历史，无法察觉底层链已被替换，因此会继续显示旧数据；更麻烦的是缓存的 nonce 比新链的真实值大，直接发交易会失败或卡在待处理。

1. 切到别的网络再切回 `KarmaChain Local` —— 强制重新拉取余额；
2. **设置 → 高级 → 清除活动标签数据** —— 清掉脏 nonce 与旧交易记录（不会删除账户或私钥）；
3. 仍不生效：锁定 MetaMask 再解锁；
4. 最后手段：删除该网络后按 §3.3 重新添加（私钥无需重新导入）。

同类问题也会出现在其他缓存 nonce 的客户端上；`cast` / viem 每次都现查 nonce，不受影响。用 RPC 确认链上真实值：

```bash
curl -s -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["0x70997970C51812dc3A010C7d01b50e0d17dc79C8","latest"]}' \
  http://127.0.0.1:8545/ext/bc/karmachain/rpc
```

## 9. 跨机部署（阶段二）

前面各节描述的是**单机形态**（`topology.activeDeployment = local`，7 个节点在一台机器上）。
本节是**跨机形态**：节点分布到多台机器，每台一个故障边界，机器之间只有链层面的 P2P 关系，
没有编排层面的依赖 —— 任一台机器的编排失效不影响其他机器。

### 9.1 当前承诺等级（先读这一段）

容错上限由共识参数决定：`minConnectedStakeToQuery = α/k = 15/20 = 75%`，
5 个等权验证者时可容忍 `f ≤ ⌊5/4⌋ = 1` 个离线。叠加故障边界后，
**每个边界至多 1 个验证者**才能扛住整域失效 —— 也就是需要 5 台**独立物理机**。

本项目当前的实际情况是 **2 台物理机**（3 个"边界"是这两台上的虚拟机），因此：

| 场景 | 结果 |
|---|---|
| 任一**单个验证者**故障 | 链继续出块，该节点重启后自动追平 |
| 任一**台物理机**失效 | 链**安全停摆** —— 不分叉、区块零回滚、数据不丢、恢复后自动继续 |
| 强制终止 / 断电 / `docker kill` | 各节点从自己的数据卷恢复，**不需要重置**，链从中断前高度继续 |

也就是说：**"崩溃后必须重置全链"这个缺陷已经消除**（与机器数量无关）；
**"整机失效不停摆"尚未达成**（需要 5 台独立物理机）。
`scripts/devnet-topology --deployment lan` 会如实打印这一点，
完整依据见 [ADR-0007](adr/0007-failure-domain-independence.md)。

### 9.2 前置条件（逐台核对，缺一项都会在部署后才暴露）

**① 确认各边界真的是独立物理机。** 这是最容易漏、也最致命的一项 ——
一个未声明的共享宿主会让容错承诺整体作废，而且**不会有任何测试失败**。清点方法：

```powershell
# 同一 MAC 出现在两个"不同机器"的地址上 ⇒ 它们共用一张网卡
1..254 | ForEach-Object -Parallel {
  Test-Connection "192.168.1.$_" -Count 1 -TimeoutSeconds 1 -EA 0 | Out-Null
} -ThrottleLimit 64
Get-NetNeighbor -AddressFamily IPv4 | Where-Object LinkLayerAddress |
  Group-Object LinkLayerAddress | Where-Object Count -gt 1

# 虚拟机 MAC 的厂商特征：VMware 00:0C:29 / 00:50:56，Hyper-V 00:15:5D，VirtualBox 08:00:27
# 逐台确认宿主上没有在跑别的"节点"
Get-CimInstance Win32_Process -Filter "Name='vmware-vmx.exe'" | Select-Object CommandLine
```

Linux 客户机内用 `systemd-detect-virt`（返回 `vmware`／`kvm`／`none`）。
发现共享宿主时，必须在 `blockchain/protocol.json` 的对应边界补上 `hypervisor:<宿主>` 因素。

**② 每台机器静态 IP 或 DHCP 保留。** 地址钉死在 `topology.deployments` 里，节点据此向对等节点通告自己。
租约一变，该机器上的节点就在通告一个不属于它的地址 —— 而节点对此**完全无声**：正常启动、日志无异常，
只是对等节点连不上它。`devnet-start` 会在**下次启动时**拦下（退出码 13），但**运行中**发生的租约变更拦不住。

**③ 承载虚拟机的边界不要用 Wi-Fi 桥接。** 802.11 一次关联只能带一个 MAC，虚拟化软件在 Wi-Fi 上桥接时
无法给客户机独立 MAC，只能复用宿主的 —— 宿主与客户机在同一 MAC 上靠 IP 解复用，是脆弱配置。
走有线即无此约束。顺带：验证者本身也不宜挂在 Wi-Fi 上，抖动与丢包会推高共识查询的超时率。

**④ 逐台确认节点端口未被系统保留。** Windows 的 Hyper-V 会从动态端口范围里切走若干区间：

```powershell
netsh interface ipv4 show excludedportrange protocol=tcp
```

输出中不应出现 21650–21669 中的任何端口。**保留区间每台机器不同**，必须逐台核对。

**⑤ 逐台放行入站端口。** 每台只需放行本边界节点用到的端口：

| 边界 | 需放行的入站 TCP |
|---|---|
| `win-1` | 21660、21661 |
| `win-2` | 21662、21663 |
| `ubuntu-1` | 21664、21665、21650、21651 |
| `ubuntu-2` | 21666、21667、21652、21653 |
| `ubuntu-3` | 21668、21669 |

```powershell
# Windows
New-NetFirewallRule -DisplayName "KarmaChain l1-1" -Direction Inbound `
  -Protocol TCP -LocalPort 21660,21661 -Action Allow
```

```bash
# Linux（ufw 未启用时无需操作）
sudo ufw allow 21664/tcp && sudo ufw allow 21665/tcp
```

准确的端口归属由拓扑决定，不要手抄 —— 用 `scripts/devnet-topology --deployment lan` 查看。

### 9.3 部署步骤

**第 1 步：切换生效形态（在任一台机器上做一次，改动进 git）**

```bash
# 把 blockchain/protocol.json 的 topology.activeDeployment 改为 "lan"
npm run node:render          # 重新生成每机 compose、每节点标志、RPC 代理配置
node tools/protocol/validate-topology.mjs   # 确认拓扑合法，并阅读它打印的告警
```

生成物按部署形态分目录（`blockchain/nodes/lan/`），所以两种形态的配置可以同时存在于仓库里，
切换形态只需改 `activeDeployment` 一个字段。

**第 2 步：建链（只做一次，在一台机器上）**

```bash
scripts/devnet-bootstrap        # 唯一会用到 Avalanche CLI 的地方
```

它在 P 链上创建 Subnet 与 Blockchain，产出 `blockchain/chain-identity/*.json`（进 git），
并把 7 个节点的数据库播种进**本机**的 7 个卷。

**第 3 步：分发**

仓库走 git。此外**只需把 2 个 Primary 节点的数据卷**拷到它们所属的机器（`ubuntu-1`、`ubuntu-2`）：

```bash
# 在建链的那台机器上导出
docker run --rm -v karmachain-primary-1-data:/data:ro -v "$PWD:/out" \
  alpine tar czf /out/primary-1.tgz -C /data .

# 在 ubuntu-1 上导入
docker volume create karmachain-primary-1-data
docker run --rm -v karmachain-primary-1-data:/data -v "$PWD:/in:ro" \
  alpine tar xzf /in/primary-1.tgz -C /data
```

**为什么只要这 2 个**：Subnet 与 Blockchain 是 P 链上的交易，只存在于持有 P 链的节点数据库里 ——
那就是这 2 个 Primary 节点。5 个验证者从**空卷**启动即可：它们按 `bootstrap-ips` 找到 Primary 同步 P 链，
L1 从仓库里的创世起链。已实测（research.md R-15）：删掉 5 个验证者卷后启动，6 秒就绪、
5/5 验证者引导完成、链身份与制品逐字一致、`devnet-verify` 14/14。

代价是 **L1 高度从创世重新开始**。若要把现有链的状态整体迁到跨机形态，
改为导出／导入**全部 7 个卷**（同样已实测：导入后高度精确回到原值）。

**第 4 步：每台机器两条命令**

```bash
KARMACHAIN_DOMAIN=<本机的边界 id> scripts/devnet-start      # Linux
```

```powershell
$env:KARMACHAIN_DOMAIN='<本机的边界 id>'; scripts\devnet-start.ps1   # Windows
```

边界 id 见 `scripts/devnet-topology --deployment lan`（`win-1`、`win-2`、`ubuntu-1`…）。
**填错会被拦下**：`devnet-start` 在启动节点之前核对该边界声明的地址是否属于本机网卡，
不符即以退出码 13 失败并给出修正方式 —— 这道检查必须在宿主侧做，因为容器在 NAT 之后看不到宿主地址。

启动顺序无所谓，机器之间没有编排依赖。先起来的验证者会等对等节点出现。

### 9.4 验证

```bash
# 1. 两两可达（在每台机器上各跑一次才覆盖完整矩阵）
npm run test:integration -- --test-name-pattern="V-06"

# 2. 全链 14 项检查（任一台机器上跑即可，RPC 经本机代理）
scripts/devnet-verify
```

可达性测试的判读需要注意一点：链未部署时对端没有进程监听，**Linux 会回 RST**（判为路径通），
而 **Windows 对无监听端口静默丢弃**，此时"防火墙已放行但节点没起来"与"防火墙在拦"产生完全相同的观测。
因此该测试对 Windows 目标会报"无法判定"并跳过。**节点起来之后复跑**，那时"连上"对每个平台都无歧义。

### 9.5 断电／重启后的恢复

**Linux 边界自动恢复**：`docker.service` 开机自启，容器由 `restart: unless-stopped` 拉起，无需人工介入。

**Windows 边界需要人工介入** —— 这是有意接受的取舍（[ADR-0006](adr/0006-windows-failure-domain-autostart.md)）：
Windows 上的容器运行时随用户会话启动，而开机计划任务运行在 LOCAL SYSTEM 上下文，
Windows **显式拒绝**从该账户启动 WSL（`Wsl/WSL_E_LOCAL_SYSTEM_NOT_SUPPORTED`，已实测）。
自动登录或在计划任务里存口令都能绕过，但都要在机器上留下一份可被滥用的凭据，
换来的只是省掉一次登录 —— 不划算。

登录后需手动做的事（**注意 Windows 宿主同时是虚拟化宿主，各自门控着不止一个节点**）：

| 宿主 | 手动步骤 | 随之恢复的节点 |
|---|---|---|
| `win-1` | ① 启动 Docker Desktop ② 启动 VMware 并开机 U22Node1、U22Node2 | `l1-1`；虚拟机内自动回来的 `l1-3`、`l1-4`、`primary-1`、`primary-2` |
| `win-2` | ① 启动 Docker Desktop ② 启动 VMware 并开机 U22Node3 | `l1-2`；虚拟机内自动回来的 `l1-5` |

虚拟机**内部**不需要人工介入。因此**停电后全链恢复需要有人登录 `win-1`**，在此之前链会停摆 ——
停摆是安全的（不分叉、零回滚），数据也不会丢。

`scripts/devnet-status` 会把"边界缺席"与"节点故障"区分开，用它判断该去登录哪台机器，
而不是去排查节点本身。

### 9.6 故障演练

```bash
# 单个验证者失效（应当：链继续出块）
scripts/devnet-node kill l1-3
scripts/devnet-verify              # fault-tolerance 应显示 4/5 online, 余量 0
scripts/devnet-node start l1-3     # 应当自动追平

# 整个边界失效（应当：按 9.1 的承诺等级，当前会安全停摆）
# 在目标机器上：scripts/devnet-stop
# 在其他机器上：scripts/devnet-status  —— 该边界应标记为缺席，而非节点故障

# 单节点数据丢失（应当：从对等节点重新同步，其余节点不受影响）
docker volume rm karmachain-l1-3-data   # 需先停掉该节点
scripts/devnet-start
```

### 9.7 排障

| 现象 | 原因与处理 |
|---|---|
| `devnet-start` 退出码 13，提示"本机不是故障边界 X 声明的那台机器" | `KARMACHAIN_DOMAIN` 填错，或本机地址变了。报错信息里列出了三种修正方式 |
| 某个边界的节点起来了但 peers 偏少 | 对端入站端口未放行（见 9.2 ⑤），或对端节点未启动。用 9.4 的可达性测试定位 |
| 节点启动即退出码 12 | 数据卷里的链与当前声明不一致（出生证明守卫）。跨机部署时最常见的原因是把**别的节点**的卷导入错了机器 |
| 节点启动即退出码 10 | 身份材料缺失 —— 检查 `blockchain/validators/dev/<node>/` 是否随仓库一起到位 |
| `ping` 不通但节点正常 | 正常。放行 TCP 端口不会放行 ICMP，`ping` 不能用来判断部署是否成功 |

---

（其余章节：跨环境一致性核对 / 状态与日志 / 参数说明 —— 后续阶段补全）

> **架构说明**：本文描述的是**一节点一容器**的形态 —— 每个节点一个容器、一个独占数据卷，
> 容器内直接运行 `avalanchego`，没有编排工具参与运行时。
> 001 的单容器形态（由 Avalanche CLI 编排 7 个进程、依赖快照保存状态）已退役，
> 理由与代价见 [ADR-0008](adr/0008-runtime-without-orchestration-cli.md)。
>
> 由此而来的最重要差别：**崩溃不再需要重置**。强制终止、断电、强制重启 Docker 之后
> `scripts/devnet-start` 即可，各节点从自己的数据卷恢复，链从中断前的高度继续。

