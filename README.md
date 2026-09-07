# KarmaChain

基于 **Avalanche L1** 构建的 **EVM 兼容**区块链。项目最高工程规则见 [`.specify/memory/constitution.md`](.specify/memory/constitution.md)（v1.1.0）。

## 快速开始

宿主机唯一前置依赖是 **Docker**（Windows 需 WSL2 后端）；不需要安装 Go、Node 或 Avalanche CLI。

```bash
git clone <repo> && cd karma-chain
scripts/devnet-bootstrap.sh  # 一次性建链（约 80 秒）；Windows: scripts\devnet-bootstrap.ps1
scripts/devnet-start.sh      # 之后每次启动约 5–15 秒
scripts/devnet-verify.sh     # 应输出 "KarmaChain is READY"
```

**崩溃后不需要重置。** 强制终止、断电、强制重启 Docker 之后，再跑一次 `devnet-start` 即可 ——
每个节点从自己的数据卷恢复，链从中断前的高度继续（实测 12–17 秒）。

启动后得到一条本地 EVM 链：

| | |
|---|---|
| RPC | `http://127.0.0.1:8545/ext/bc/karmachain/rpc` |
| Chain ID | **20189**（未来主网预留 20188） |
| 原生代币 | KarmaCoin（**KARMA**，18 位） |
| 拓扑 | 5 个 PoA L1 验证者 + 2 个 Primary Network 节点 |
| 预置账户 | 6 个公开测试账户，共 39,500,000 KARMA |

MetaMask、Foundry `cast`、viem 均可**零配置**连接。完整手册见 **[`docs/devnet.md`](docs/devnet.md)**。

## 命令

| 动作 | 命令（`.sh` / `.ps1`） |
|---|---|
| **一次性建链** | `scripts/devnet-bootstrap` |
| 启动 / 停止 | `scripts/devnet-start` · `scripts/devnet-stop`（**崩溃后直接 start 即可，无需重置**） |
| 重置到创世 | `scripts/devnet-reset` |
| 14 项自动化验证 | `scripts/devnet-verify` |
| 拓扑与容错校验 | `scripts/devnet-topology`（退出码 13 = 违反容错约束） |
| 重新生成全部派生物 | `scripts/devnet-render`（`--check` 只查漂移） |
| 节点状态 / 日志 | `scripts/devnet-status` · `scripts/devnet-logs <node>` |
| 链上合约清单 | `scripts/devnet-contracts`（`--json` 可机器读） |
| 故障注入（演练） | `scripts/devnet-node <stop\|start\|kill\|pause\|resume> <node>` |

> 跨机部署（多台机器各承载一个故障边界）见 [`docs/devnet.md` §9](docs/devnet.md)。
> 每台机器执行相同的命令，区别只在 `KARMACHAIN_DOMAIN=<边界 id>`；机器之间**没有编排层面的依赖**。

## 目录

| 目录 | 内容 |
|---|---|
| `blockchain/` | **`protocol.json`（协议参数唯一事实来源）**、生成的 Genesis、DEVELOPMENT ONLY 开发密钥 |
| `docker/` | `node/` 节点镜像（官方 avalanchego + subnet-evm，**不含 CLI**）、`bootstrap/` 建链镜像（唯一含 CLI）、`compose/` 每故障边界一份的生成物、`verify/` 工具镜像 |
| `tools/protocol/` | 由 `protocol.json` 派生创世、参数文档、**每节点标志与每边界 compose**、拓扑校验 |
| `tools/verify/` | 14 项网络验证器（逐项 `[OK]/[FAIL]` + JSON 报告） |
| `tools/inspect/` | 逐节点恢复状态、链上合约清单 |
| `tests/` | 单元 / 集成 / 端到端测试 |
| `scripts/` | 宿主机薄封装（PowerShell + sh，无业务逻辑） |
| `docs/` | 开发者手册、生成的参数文档、[ADR](docs/adr/) |
| `specs/` | Spec Kit 规格、计划、任务、契约 |

## 两条必须知道的规则

1. **协议参数只有一个出处**：全部共识相关参数定义在 `blockchain/protocol.json`；创世、文档、compose 默认值都由它生成。改参数请走 [`docs/devnet.md` §8](docs/devnet.md) 的流程（宪法第十五条），并且**不要手改生成物**——漂移测试会拦下来。
2. **仓库内的私钥都是公开测试密钥**：`blockchain/accounts/` 与 `blockchain/validators/dev/` 下的密钥全网已知，仅在本地链（Chain ID 20189 / Network ID 1337）有效，**绝不可用于任何真实网络**（宪法第四条 v1.1.0 例外条款，见 [ADR-0003](docs/adr/0003-chain-identity-and-dev-security-boundary.md)）。

## 功能状态

| 功能 | 状态 |
|---|---|
| 001 本地可复现的 Avalanche L1 开发网络 | ✅ 已完成（[规格](specs/001-local-avalanche-devnet/spec.md) · [计划](specs/001-local-avalanche-devnet/plan.md) · [任务](specs/001-local-avalanche-devnet/tasks.md)） |
| 002 崩溃可恢复、可跨机部署的验证者网络 | ✅ 单机形态已完成（崩溃自愈、运行时脱离编排工具、拓扑单一事实来源、恢复可观测）；跨机形态的部署待硬件到位，见 [ADR-0007](docs/adr/0007-failure-domain-independence.md)（[规格](specs/002-resilient-validator-network/spec.md) · [计划](specs/002-resilient-validator-network/plan.md) · [任务](specs/002-resilient-validator-network/tasks.md)） |

后续规划（智能合约、索引器、后端、前端、监控）将各自建立独立规格，全部复用本功能提供的 RPC 端点、预置账户与协议参数出处。
