# Contract: 开发网络命令接口

**Feature**: `001-local-avalanche-devnet` | **Status**: Draft

宿主机唯一前置依赖：Docker Desktop（Windows: WSL2 后端；macOS）或 Docker Engine + Compose v2（Linux）。所有命令在仓库根目录执行。`scripts/*.ps1`（Windows）与 `scripts/*.sh`（macOS/Linux）是**等价薄封装**，仅转调下表的 compose 命令并做前置检查（FR-007）；不得包含业务逻辑。

## 命令

| 动作 | 封装脚本 | 底层 compose 命令 | 语义 | 退出码 |
|---|---|---|---|---|
| 启动 | `scripts/devnet-start.{ps1,sh}` | `docker compose up -d devnet` 然后等待就绪并打印摘要 | 首次：create + deploy；之后：`network start` 恢复快照（高度延续）。已运行时幂等（FR-006）。 | 0 就绪；10 前置依赖缺失；11 端口冲突；12 链数据与 protocol.json 不一致（需 reset）；20 启动超时/失败（附类别） |
| 停止 | `scripts/devnet-stop.{ps1,sh}` | `docker compose stop devnet` | 容器收到 SIGTERM → `avalanche network stop`（保存快照）→ 退出；无残留进程/端口 | 0 |
| 重置 | `scripts/devnet-reset.{ps1,sh}` | `docker compose down -v` | 删除卷（全部链数据与快照）；下次启动回到创世 | 0 |
| 验证 | `scripts/devnet-verify.{ps1,sh}` | `docker compose run --rm verify` | 运行 FR-027 全部检查；输出逐项结果 + JSON 报告到 `./.devnet/verify-report.json` | 0 全部通过；1 任一失败 |
| 状态 | `scripts/devnet-status.{ps1,sh}` | `docker compose exec devnet devnet-status` | 每个节点：NodeID、角色、healthy、bootstrapped、peers | 0 / 1（存在不健康节点） |
| 日志 | `scripts/devnet-logs.{ps1,sh} [node]` | `docker compose exec devnet devnet-logs [node]` | 按节点区分的日志（`-f` 跟随） | 0 |
| 合约清单 | `scripts/devnet-contracts.{ps1,sh}` | `docker compose run --rm verify node tools/inspect/list-contracts.mjs` | 列出创世内置 + 运行期部署的全部合约，标注 official / internal / unlisted（`--json`、`--from <block>`、`--no-probe`） | 0 成功；1 链不可达 |

## 启动成功输出（FR-008）

```text
KarmaChain local devnet is READY  (environment: dev — DEVELOPMENT ONLY)

  RPC URL      : http://127.0.0.1:8545/ext/bc/karmachain/rpc
  Chain ID     : 20189   (Network ID 1337; mainnet 20188 is RESERVED, not this network)
  Native token : KarmaCoin (KARMA, 18 decimals)
  Validators   : 5 L1 validators (PoA) + 2 primary-network nodes
  Block mode   : on-demand (blocks are produced only when there are transactions)

  Dev accounts (publicly known keys — NEVER use outside this local network):
    ewoq              0x8db97C7cEcE249c2b98bDC0226Cc4C2A57BF52FC   1000000 KARMA
    anvil-0           0x…                                          1000000 KARMA
    …

  Next: scripts/devnet-verify  |  scripts/devnet-status  |  scripts/devnet-logs
```

所有数值来自 `protocol.json`（容器内读取同一文件），不得在脚本中写死。

## 验证输出（FR-028）

```text
KarmaChain Network Check  (rpc: http://127.0.0.1:8545/ext/bc/karmachain/rpc)

[OK]   node                7/7 nodes healthy
[OK]   validator           5/5 L1 validators bootstrapped, peers>=4 each
[OK]   rpc                 eth_chainId responded in 12 ms
[OK]   network-id          1337 == protocol.json
[OK]   chain-id            20189 == protocol.json
[OK]   token               KARMA / 18 == protocol.json
[OK]   balance             6/6 dev accounts match genesis
[OK]   transfer            0x… confirmed in block 3 (2.1 s)
[OK]   receipt             status=1 gasUsed=21000 from/to/value verified
[OK]   block-production    height 2 -> 3 -> 4 after 2 txs
[OK]   contract            Counter deployed at 0x…, increment() -> count()==1
[OK]   rpc-methods         10/10 supported
[OK]   protocol-consistency genesis sha256 matches committed file

KarmaChain is READY   (13 checks, 0 failed, 0 unsupported, 41.7 s)
```

失败示例（FR-030 类别必现）：
```text
[FAIL] rpc                 [category: rpc] connection refused at 127.0.0.1:8545 — is the devnet running? (scripts/devnet-start)
…
KarmaChain is NOT READY   (13 checks, 1 failed)
```

行格式：`[STATUS]<space>id<padding>detail`；STATUS ∈ `OK | FAIL | SKIP | UNSUPPORTED`。机器可读版本见 `verification-report.schema.json`。

## 失败类别 → 典型判据（FR-030）

| 类别 | 判据 |
|---|---|
| `configuration` | protocol.json schema 不合法、端口冲突、前置依赖缺失、卷内 stamp 与 protocol 不一致 |
| `genesis` | CLI 拒绝创世文件、生成的创世与提交文件 sha256 不同、创世哈希与预期不同 |
| `node` | 进程未运行 / `/ext/health` 非 healthy / 启动超时 |
| `validator` | L1 节点未 bootstrapped、PoA 初始化失败、`info.isBootstrapped=false` |
| `p2p` | `info.peers` 数量低于期望下限（L1 验证者 peers < 4；精确阈值由 V-10 实测定入派生常量） |
| `rpc` | HTTP 不可达 / JSON-RPC 错误响应 / 方法不存在 |
| `evm` | 合约部署或调用失败、`eth_call` 结果不符 |
| `transaction` | 交易未在超时内确认、receipt status=0、余额不符 |
| `storage` | 磁盘不足、数据库打开失败（日志关键字） |

## 环境变量（可覆盖，仅用于本机冲突场景）

| 变量 | 默认（来自 protocol.json） | 说明 |
|---|---|---|
| `KARMACHAIN_RPC_PORT` | 8545 | 宿主机映射端口 |
| `KARMACHAIN_STARTUP_TIMEOUT` | 300 (s) | 启动就绪超时（SC-001） |

覆盖不改变链身份，仅改变宿主映射；启动摘要打印实际生效值。
