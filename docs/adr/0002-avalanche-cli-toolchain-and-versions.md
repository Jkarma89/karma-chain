# ADR-0002：用（已进入维护模式的）Avalanche CLI 编排本地网络，并锁定全部组件版本

**状态**：**运行时部分已被 [ADR-0008](0008-runtime-without-orchestration-cli.md) 取代（2026-09-07）**；版本锁定部分仍然有效 · **日期**：2026-09-01 · **相关**：宪法第七/十三/十五条，research R-01/R-02/R-12

> **2026-09-07 更新 —— 请先读这段再读下文。**
>
> 本文的"由 CLI 编排本地网络"这一半**已不再成立**。功能 002 把运行时改为**一节点一容器、
> 容器内直接运行 `avalanchego`**，CLI 只保留在一次性建链这一步；`docker/devnet/`（本文描述的
> 单容器编排）已删除。原因是本文自己记下的技术债兑现了：2026-09-05 强制重启 Docker 后，
> 7 个节点的数据库全部完好，而 CLI 的编排账本丢失，导致唯一出路是丢弃全链状态。
> 完整的根因、代价与替代方案见 [ADR-0008](0008-runtime-without-orchestration-cli.md)；
> 建链制品为何单独成类见 [ADR-0009](0009-chain-identity-as-second-class-fact.md)。
>
> 下文中**仍然有效**的部分：全部组件的版本锁定与 sha256 校验策略（现落在
> `docker/binaries.env`，由 `docker/node/Dockerfile` 与 `docker/bootstrap/Dockerfile` 共用）。
> 下文中**已失效**的部分：单容器形态、`avalanche network start/stop` 的运行期编排、
> 以及依赖快照的停止／恢复语义。

## 决定了什么

本地开发网络由 **Avalanche CLI v1.9.6** 编排，运行在 Docker 容器内。容器镜像预置并以 **sha256 锁定**五个组件：

| 组件 | 版本 | 作用 |
|---|---|---|
| avalanche-cli | v1.9.6 | 编排（基础镜像 `avaplatform/avalanche-cli:v1.9.6`） |
| avalanchego | v1.14.1 | 节点软件（RPCChainVM 协议 44） |
| subnet-evm | v0.8.0 | EVM 虚拟机（协议 44） |
| signature-aggregator | v0.5.3 | CLI 在 deploy 时会拉取（版本无标志可锁，故预置） |
| icm-contracts | v1.0.0 | 同上，4 个文本资产 |

版本的唯一权威定义在 `blockchain/protocol.json` → `avalanche.*`，`tools/protocol/load.mjs` 内置
avalanchego ↔ subnet-evm 的协议版本兼容表并断言两者匹配。所有 CLI 调用集中在
**`docker/devnet/lib/avalanche.sh` 这一个文件**。

## 为什么

- **CLI 是唯一可脚本化的官方路径**：一条 `avalanche blockchain deploy --local` 完成
  CreateSubnetTx → CreateChainTx → ConvertSubnetToL1Tx（ACP-77）→ 拉起 5 个验证者 → 部署并初始化 PoA
  ValidatorManager。没有第二个官方工具能脚本化地走完这条链路。
- **容器化是跨平台的前提**：CLI 官方声明"tested on Linux and Mac，**Windows is currently not supported**"，而团队主力开发机是 Windows。容器让三平台行为一致（宪法第七条）。
- **版本锁定 + 离线可用**：实测在**屏蔽全部 GitHub 域名**的容器中，从 `network start` 到 5 验证者 L1 部署完成 **73 秒、零下载**。首次构建后不再依赖外网。
- **v1.14.1 + v0.8.0 是协议 44 的最新稳定组合**：v1.14.2 已是协议 45，而独立发行的 subnet-evm 最后版本 v0.8.0 只到协议 44（该仓库 2025-12 归档并并入 avalanchego）。

## ⚠️ 已知技术债

**Avalanche CLI 自 2025-12 进入维护模式**（"No new features… Only security patches and critical bug fixes"），官方文档页标记 *Deprecated*，推荐替代品为 Platform CLI 与 Builder Console。但：

- **Builder Console** 是网页控制台 —— 不可脚本化，无法保证可复现（违反宪法第七条）；
- **Platform CLI** 只覆盖 P-Chain 交易 —— 不编排本地节点、不生成创世、不部署 PoA 合约。

两者都无法替代当前用途，因此**继续使用 CLI 是当前唯一满足"可脚本化 + 可复现"的选择**。

### 缓解措施（已落实）

1. 版本锁死在 v1.9.6，官方停更反而意味着行为不会突变；
2. 全部 CLI 调用收敛到 `docker/devnet/lib/avalanche.sh`，对外只暴露 start/stop/reset/status 契约（`contracts/cli-interface.md`），替换成本被限制在一个文件；
3. `tests/e2e/vm-alloc-drift.test.mjs` 监控 CLI 注入的合约是否变化，防止升级时悄悄漂移；
4. 迁移路径已预研（见下）。

## 考虑过的替代方案

| 方案 | 否决理由 |
|---|---|
| tmpnet（`tmpnetctl`，avalanchego 内置） | 不支持创建 Subnet/L1（README 明示该用法已被 e2e 套件内的代码取代），需自写 Go 代码；不支持 Windows。当前作为 CLI 的底层被间接使用 |
| avalanche-network-runner | 最后发行 v1.8.3（2024-09），CLI 已不再用它做本地网络 |
| 手写 Docker Compose 多容器 + avalanchejs 发 P-Chain 交易 | 最透明、无弃用风险，但需自行实现 Subnet/Chain 创建、L1 转换、ValidatorManager 部署与初始化、节点跟踪重启——工作量与出错面远超本功能范围 |
| Builder Console / L1 Launcher（网页） | 不可脚本化 |

## 影响

- 依赖一个不再演进的工具；新 Avalanche 特性无法通过 CLI 获得。
- 组件升级（尤其跨 RPCChainVM 协议版本）属于协议变更：须同步修改 `protocol.json`、Dockerfile 的 ARG/SHA、`load.mjs` 兼容表、`docker/devnet/cache/latest.json`，重新提取 fixture，重生成创世，更新创世哈希基准，跑全部回归（宪法第十五条）。
- CLI 在 deploy 时会向 GitHub 查询若干组件的 "latest"（signature-aggregator 无标志可锁）；已通过预置 `download-cache/latest.json` 并在启动时刷新 mtime 使其视缓存为有效。

## 迁移 / 演进

1. **升级到 avalanchego ≥ v1.14.2（协议 45+）**：subnet-evm 已随 avalanchego 同版本发布，需走 CLI 的 `--custom --vm <path>` 路线或等待社区维护版 CLI 支持。
2. **CLI 彻底不可用**：迁移到"Compose 多容器 + avalanchejs"方案。对外契约（`contracts/cli-interface.md`、RPC 端点、protocol.json）保持不变，只重写 `lib/avalanche.sh`。
3. 触发条件：CLI 出现无法修复的阻塞性缺陷，或需要 CLI 不支持的 Avalanche 新特性。
