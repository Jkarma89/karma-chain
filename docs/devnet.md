# KarmaChain 本地开发网络 —— 开发者手册

> 本文档中的链参数（Chain ID、端口、代币…）以 [`blockchain/protocol.json`](../blockchain/protocol.json) 为唯一权威；
> 逐参数取值与理由见生成的 [`protocol-parameters.md`](protocol-parameters.md)；架构决策见 [`adr/`](adr/)。

**三步上手**

```bash
git clone <repo> && cd karma-chain
scripts/devnet-start.sh      # Windows: scripts\devnet-start.ps1（首次约 80 秒，含镜像构建约 5 分钟）
scripts/devnet-verify.sh     # 13 项自动化检查，应输出 "KarmaChain is READY"
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
| 启动 | `scripts\devnet-start.ps1` | `scripts/devnet-start.sh` | 首次约 80 秒（create + deploy）；之后从快照恢复约 15 秒，链状态保留 |
| 停止 | `scripts\devnet-stop.ps1` | `scripts/devnet-stop.sh` | 保存快照，无残余进程 |
| 重置 | `scripts\devnet-reset.ps1` | `scripts/devnet-reset.sh` | 删除链数据卷，下次启动回到创世 |
| 验证 | `scripts\devnet-verify.ps1` | `scripts/devnet-verify.sh` | 13 项自动化检查，约 22 秒；退出码 0 通过 / 1 失败 |

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
scripts/devnet-verify.sh            # 13 项完整检查（约 22 秒）
scripts/devnet-verify.sh --quick    # 跳过合约编译与 RPC 方法探测（仅本地迭代，不可用于验收）
```

13 项检查：`rpc`、`chain-id`、`network-id`、`token`、`node`（7 个节点健康）、`validator`（5 个 L1 已 bootstrapped、peers ≥ 4、NodeID 与仓库密钥一致）、`balance`（区块 0 余额精确等于创世）、`transfer`、`receipt`（回执 6 个字段 + 余额守恒）、`block-production`（每笔交易产生新区块）、`contract`（编译部署 `Counter.sol` 并读写验证）、`rpc-methods`（FR-012 十个方法逐一探测）、`protocol-consistency`（运行中创世哈希 == 基准）。

输出为逐项 `[OK]/[FAIL]/[SKIP]/[UNSUPPORTED]` 行 + `.devnet/verify-report.json`（结构见 `contracts/verification-report.schema.json`）。**每个失败都带 FR-030 故障类别**，便于快速定位是配置、节点、共识、RPC 还是交易问题。

> **为什么要在容器里跑**：节点只监听容器内回环（avalanchego 不可配置），devnet 容器为每个节点在容器 IP 上起了同端口代理，仅 compose 网络内可达。因此在宿主直接 `node tools/verify/verify-network.mjs` 时，`node` 与 `validator` 两项会降级为 `[SKIP]` 并提示改用 `scripts/devnet-verify`；其余 11 项照常执行。

## 3.5 重置与状态保留

| 操作 | 效果 |
|---|---|
| `scripts/devnet-stop` → `scripts/devnet-start` | 从快照恢复，区块高度与余额延续（FR-005） |
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
| `PREFLIGHT FAILED … missing tools in image` | 镜像过旧：`docker compose build devnet` |
| `image binary versions do not match protocol.json` | 改过 `protocol.json` 的版本字段但没重建镜像：`docker compose build devnet` |
| 非正常终止（断电 / 强杀容器）后启动失败，提示"snapshot is probably incomplete" | 快照未保存完整：`scripts/devnet-reset` 后重新启动 |
| 长时间 `pause` 后节点无法恢复（`grpc: the client connection is closing`） | `scripts/devnet-node.sh stop <node>` 再 `start <node>` |
| 磁盘空间不足 | 节点日志会报错；清理 Docker（`docker system prune`）或扩容后重启 |

## 7. 测试与验证

| 命令 | 内容 | 耗时 |
|---|---|---|
| `npm test` | 单元测试（协议参数约束、创世漂移、账户派生、报告 schema、硬编码扫描） | ~1 秒 |
| `npm run test:integration` | 集成测试（对运行中的链：链身份、创世余额、转账回执、按需出块） | ~15 秒 |
| `npm run test:secrets` | 秘密扫描（仓库 + 运行时日志） | ~4 秒 |
| `scripts/devnet-verify.sh` | 13 项网络验证 | ~22 秒 |
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

（其余章节：跨环境一致性核对 / 状态与日志 / 参数说明 —— 后续阶段补全）
