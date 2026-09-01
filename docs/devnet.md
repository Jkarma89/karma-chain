# KarmaChain 本地开发网络 —— 开发者手册（草稿，随功能 001 各阶段补全）

> 本文档中的链参数（Chain ID、端口、代币…）以 [`blockchain/protocol.json`](../blockchain/protocol.json) 为唯一权威；如有出入以该文件为准并修正本文。

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
| 重置 | （阶段 4） | （阶段 4） | 回到创世 |
| 验证 | （阶段 6） | （阶段 6） | 13 项自动化检查 |

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

## 3.5 重置与状态保留

| 操作 | 效果 |
|---|---|
| `scripts/devnet-stop` → `scripts/devnet-start` | 从快照恢复，区块高度与余额延续（FR-005） |
| `scripts/devnet-reset` → `scripts/devnet-start` | 删除卷，从创世重新部署（≈ 80 s），高度回到 4（4 笔 PoA 初始化交易） |

首次部署成功时容器在卷内写入 `karmachain.stamp.json`（configVersion / chainId / networkId / 创世文件 sha256 / 实测创世区块哈希）。之后每次启动都会比对：**任一项与当前 `protocol.json` / 创世不一致即拒绝启动（退出 12）**并提示 reset —— 改了协议参数就必须换一条链，不会得到"半新半旧"的链（宪法第十五条）。

## 3.6 跨环境一致性核对（SC-002）

目标：证明两台机器（或两位开发者）从同一提交启动得到**同一条链**。

**基准（环境 A，2026-09-01）**

| 项 | 值 |
|---|---|
| 提交 | 见 `git log`（创世文件 sha256 `19723726a78f6953e82f8eed74b9891f5534f0176c3aed8103b72196f1ea34ef`） |
| 创世区块哈希 | `0xcd807715b50b5eaba52dd332cce379da66704b443b1439e881e11751b88d3efa`（亦记录于 `blockchain/genesis/karmachain.genesis.hash`） |
| Chain ID / Network ID | 20189 / 1337 |
| 环境 | Windows 10 Pro 19045，Docker Desktop 29.7.2，Compose v5.4.0，amd64 |
| 首次启动耗时 | 78–79 s |

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

> 实测记录：环境 B —— **待执行**（需第二台机器；arm64 机器尤其有价值，可同时验证多架构镜像）。

## 4. 开发账户

见 [`blockchain/accounts/dev-accounts.json`](../blockchain/accounts/dev-accounts.json)。6 个账户在创世各有 1,000,000 KARMA：`ewoq`（Avalanche 官方测试账户，被 CLI 用作 PoA 管理员并支付初始化 gas，因此启动后余额略低于创世值）与 `anvil-0..4`（Foundry/Hardhat 默认账户，助记词 `test test … junk`）。

## 5. 已知行为

- **链空闲时区块高度不增长**：Subnet-EVM 只在有待处理交易时出块（源码 `block_builder.go needToBuild`），不是故障。
- 部署完成时高度已为 4：Avalanche CLI 用 ewoq 发了 4 笔 PoA ValidatorManager 初始化交易。
- `docker compose logs` 会保留容器上一轮运行的输出；`scripts/devnet-start` 只解析本次启动之后的日志。

## 6. 排障（按 FR-030 类别，阶段 7 补全）

| 类别 | 现象 | 处理 |
|---|---|---|
| configuration | `PREFLIGHT FAILED … ports already in use`（退出 11） | 另一套 devnet 仍在容器内运行；`docker compose down` |
| configuration | `host port 8545 is already in use`（退出 11） | 停掉占用者，或在 `.env` 设置 `KARMACHAIN_RPC_PORT` |
| genesis | `genesis chainId != protocol.json`（退出 10） | `npm run protocol:render` 后重置 |
| rpc | 403 `invalid host specified` | 见 §3 Host 头限制 |

（其余章节：跨环境一致性核对 / 状态与日志 / 参数说明 —— 后续阶段补全）
