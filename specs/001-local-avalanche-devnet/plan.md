# Implementation Plan: 本地可复现的 Avalanche L1 开发网络

**Branch**: `001-local-avalanche-devnet` | **Date**: 2026-09-01 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-local-avalanche-devnet/spec.md`

## Summary

用 **Avalanche CLI v1.9.6（Docker 封装）** 在单机启动一条 KarmaChain Avalanche L1 开发网络：2 个 Primary Network 节点 + **5 个 PoA L1 验证者**，Subnet-EVM v0.8.0 / AvalancheGo v1.14.1（协议 44），Chain ID **20189**（20188 预留主网）、Network ID 1337、原生代币 KarmaCoin/KARMA。`blockchain/protocol.json` 是全部协议参数的唯一事实来源，Genesis、文档、compose 配置、验证脚本均由其派生并有漂移测试。宿主机唯一依赖是 Docker（Windows/macOS/Linux 一致），入口为 `docker compose` 及薄封装脚本：启动 / 停止（保留状态）/ 重置 / 验证 / 状态 / 日志。Node 24 + viem 的验证器逐项输出 `[OK]/[FAIL]` 并按 FR-030 分类失败。研究结论与来源见 [research.md](research.md)。

## Technical Context

**Language/Version**: Bash（容器内编排，`docker/devnet/`）；Node.js 24 LTS（ESM，`tools/`、`tests/`）；Solidity 0.8.x（仅 1 个最小验证合约 `Counter.sol`，`evmVersion=cancun`）；PowerShell 7 / POSIX sh（宿主薄封装）

**Primary Dependencies**: Avalanche CLI v1.9.6（镜像 `avaplatform/avalanche-cli:v1.9.6`）；AvalancheGo v1.14.1；Subnet-EVM v0.8.0；Docker Engine/Desktop + Compose v2；viem 2.x；solc-js 0.8.36；jq、curl、socat（容器内）

**Storage**: Docker 命名卷 `karmachain-devnet-data`（→ `/root/.avalanche-cli`：节点数据库、快照、sidecar、日志）；无外部数据库

**Testing**: `node --test`（单元：schema/生成器/漂移）；`tools/verify`（集成：对运行中网络的 13 项检查）；`tests/e2e`（reset-recreate ×10、单节点故障、秘密扫描、fixture 漂移）；均在 `verify` 容器中运行

**Target Platform**: 开发机 Windows 10/11（Docker Desktop + WSL2）、macOS、Linux；容器为 linux/amd64 与 linux/arm64（avalanchego 二者均有发行包）

**Project Type**: 基础设施 / 开发者工具（无应用代码），单仓库

**Performance Goals**: 启动 ≤ 5 分钟（首次含构建 ≤ 15 分钟，SC-001）；验证 ≤ 3 分钟（SC-005）；转账确认 ≤ 10 秒（SC-006）

**Constraints**: 全部链侧逻辑必须在容器内运行（宿主不装 Go/Node/CLI）；协议参数零硬编码（SC-007）；不引入协议偏离（宪法第三条）；CLI 处于维护模式（风险，见 Complexity Tracking）；Subnet-EVM 无交易不出块（验证策略随之调整）

**Scale/Scope**: 7 个 avalanchego 进程 + 5 个 subnet-evm 插件进程，单机；6 个预置账户；1 条 L1；约 15 个脚本/模块文件、3 份 ADR、1 份开发者文档

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 条 | 要求 | 本计划如何满足 | 结果 |
|---|---|---|---|
| 一 区块链优先 | 共识状态只由链定义 | 本功能只交付链本身与只读验证；无链下状态存储 | ✅ |
| 二 链上/链下分工 | 每功能标注 | 链上：Genesis、L1、ValidatorManager（CLI 部署）。链下：编排脚本、验证器、文档生成。同步：链下仅读 RPC / sidecar | ✅ |
| 三 EVM 兼容 | 标准优先、偏离必须记录 | Subnet-EVM 默认 feeConfig，不改精编译/预编译；Cancun 限制记录在 rpc-endpoint.md | ✅ |
| 四 安全优先 | 无真实秘密入库；dev/prod 分离；安全分析 | 仅公开开发密钥且显著标记；秘密扫描测试；`environment=dev` 强制；生产参数另建目录（FR-025）；安全考虑写入 ADR-0003 | ✅ |
| 五 确定性 | 共识代码确定性 | 不编写任何共识/VM 代码；仅使用官方二进制 | ✅（不适用） |
| 六 合约安全 | 成熟库、测试 | ValidatorManager 为 CLI 内置官方合约（不自研）；`Counter.sol` 仅为验证探针、不上生产 | ✅ |
| 七 可复现 | Git → 环境 | 版本全部锁定 + sha256；Docker 镜像可重建；创世提交且漂移测试；快照/重置语义明确 | ✅ |
| 八 测试优先 | 先定义验证 | quickstart 场景 A–G 与 13 项检查在实现前已定义（本计划）；DoD = 实现 + 测试 + 验证 | ✅ |
| 九 可观测 | 日志/健康/分类 | `devnet-status`（health/bootstrapped/peers）、`devnet-logs` 按节点、失败 9 类（cli-interface.md） | ✅ |
| 十 API 明确 | 接口契约 | `contracts/`：RPC 端点、CLI 接口、protocol schema、报告 schema | ✅ |
| 十一 模块边界 | 层次清晰 | Blockchain（容器）→ RPC（8545）→ 后续组件；验证器只经 RPC/Info API 访问链 | ✅ |
| 十二 AI 治理 | 不臆测协议、记录不确定 | research.md 每条附源码/文档来源；10 项实现期验证清单显式列出 | ✅ |
| 十三 依赖选型 | 成熟稳定、有理由 | CLI（官方唯一可脚本化路径，维护模式风险已记录）、Node/viem/solc（成熟）；拒绝新增测试框架 | ✅（见 Complexity Tracking） |
| 十四 决策可追踪 | ADR + 参数记录 | ADR-0001 Avalanche L1/EVM、ADR-0002 工具链与版本、ADR-0003 链身份与安全边界、ADR-0004 拓扑；`docs/protocol-parameters.md` 由 protocol.json 生成 | ✅ |
| 十五 协议变更控制 | Spec→兼容→迁移→回归→Review | 本功能本身即协议产物，已有 spec；升级路径在 research R-12；`configVersion` 变更触发漂移测试 | ✅ |
| 十六 唯一事实来源 | 参数单点 | `blockchain/protocol.json` + 生成器 + 漂移测试 + git grep 检查（SC-007） | ✅ |
| 十七 DoD | 全项 | tasks 阶段按 DoD 8 项组织验收任务 | ✅ |

**Gate 结论（Phase 0 前）**：通过，无违规。
**Gate 复查（Phase 1 后）**：通过。新增的两处"额外复杂度"（socat 代理、ValidatorManager fixture）均有更简替代被否决的理由，登记于 Complexity Tracking，不构成宪法违规。

## Project Structure

### Documentation (this feature)

```text
specs/001-local-avalanche-devnet/
├── plan.md                              # 本文件
├── research.md                          # Phase 0：决策 + 来源 + 实现期验证清单
├── data-model.md                        # Phase 1：protocol.json 等实体、状态机
├── quickstart.md                        # Phase 1：验证场景 A–G
├── contracts/
│   ├── protocol-config.schema.json      # protocol.json 的 JSON Schema
│   ├── verification-report.schema.json  # 验证报告 schema
│   ├── rpc-endpoint.md                  # 公共 RPC 契约 + 10 个方法支持表
│   └── cli-interface.md                 # 命令、输出格式、退出码、失败类别
├── checklists/requirements.md
└── tasks.md                             # Phase 2（/speckit-tasks 生成）
```

### Source Code (repository root)

```text
blockchain/                              # 协议层（版本化，dev 专用）
├── protocol.json                        # ★ 唯一事实来源
├── genesis/
│   ├── karmachain.genesis.json          # 生成物（GENERATED 头标记），提交 + 漂移测试
│   └── validator-manager.alloc.json     # 从 CLI v1.9.6 提取的 ValidatorManager 合约分配 fixture
├── accounts/
│   └── dev-accounts.json                # DEVELOPMENT ONLY 公开开发私钥（ewoq + anvil #0-4）
└── validators/dev/node-{1..5}/          # DEVELOPMENT ONLY 验证者 TLS/BLS 密钥 + README

docker/
├── devnet/
│   ├── Dockerfile                       # FROM avaplatform/avalanche-cli:v1.9.6 + 预置 avalanchego/subnet-evm（sha256）+ bash/jq/curl/socat
│   ├── entrypoint.sh                    # 启动状态机：stamp 校验 → 首次 create+deploy / 恢复 → 别名确认 → socat → 就绪摘要；SIGTERM → network stop
│   ├── bin/                             # 容器内命令：devnet-status, devnet-logs, devnet-node, devnet-summary
│   └── lib/
│       ├── avalanche.sh                 # ★ 所有 avalanche CLI 调用集中于此（可替换层）
│       ├── protocol.sh                  # 用 jq 读取 protocol.json
│       ├── health.sh                    # /ext/health、info.*、peers
│       └── preflight.sh                 # 端口、内存、IPv6 检查 → 退出码 10/11/12
└── verify/Dockerfile                    # node:24-alpine + npm ci（tools/ + tests/）

docker-compose.yml                       # 服务：devnet（卷、8545 映射、sysctls ipv6）、verify（profile）
.env.example                             # KARMACHAIN_RPC_PORT 等覆盖项说明

tools/
├── protocol/
│   ├── load.mjs                         # 读取 + schema 校验 + 约束校验
│   ├── render-genesis.mjs               # protocol + fixture → genesis
│   ├── render-docs.mjs                  # → docs/protocol-parameters.md
│   ├── render-compose-env.mjs           # → .devnet/compose.env（端口等）
│   └── extract-vm-alloc.sh              # 容器内：CLI 参考创世 → fixture（一次性 + 漂移测试用）
└── verify/
    ├── verify-network.mjs               # 编排 13 项检查，输出 [OK] 行 + JSON 报告
    ├── checks/*.mjs                     # node, validator, rpc, network-id, chain-id, token, balance, transfer, receipt, block-production, contract, rpc-methods, protocol-consistency
    ├── lib/{rpc.mjs, avalanche-api.mjs, report.mjs, categories.mjs}
    └── contracts/Counter.sol            # 最小探针合约（solc-js 编译，evmVersion cancun）

tests/
├── unit/                                # node --test：schema、约束、genesis/docs 幂等与漂移、report schema
├── integration/                         # 对运行中网络：verify 全通过；停网后正确失败分类
└── e2e/
    ├── reset-recreate.test.mjs          # ×10 创世哈希一致（SC-003）
    ├── single-validator-down.test.mjs   # 停 1 个 L1 节点仍出块；status 报告 4/5
    ├── secret-scan.test.mjs             # 仓库 + 日志秘密扫描（SC-009）
    └── vm-alloc-drift.test.sh           # 重新提取 fixture 并 diff

scripts/                                 # 宿主薄封装（无业务逻辑）
├── devnet-start.ps1 / .sh
├── devnet-stop.ps1 / .sh
├── devnet-reset.ps1 / .sh
├── devnet-verify.ps1 / .sh
├── devnet-status.ps1 / .sh
└── devnet-logs.ps1 / .sh

docs/
├── devnet.md                            # 开发者手册：前置、命令、连接工具、账户、排障（按 9 类）
├── protocol-parameters.md               # 生成物（GENERATED 头标记）
└── adr/
    ├── 0001-avalanche-l1-and-evm.md
    ├── 0002-avalanche-cli-toolchain-and-versions.md
    ├── 0003-chain-identity-and-dev-security-boundary.md
    └── 0004-five-validator-local-topology.md

.gitignore                               # .devnet/、node_modules/、运行时数据
package.json                             # tools/tests 依赖（viem、solc、ajv）；scripts: protocol:render, verify, test, test:secrets
README.md                                # 指向 docs/devnet.md
```

**Structure Decision**: 单仓库、按"协议层 / 容器编排 / 工具 / 测试 / 文档"划分，不采用 src-models-services 模板（本功能无应用代码）。`blockchain/` 只放版本化协议产物，运行时数据只在 Docker 卷；`docker/devnet/lib/avalanche.sh` 是 CLI 的唯一调用点，为 research R-12 的迁移路径预留替换面；`tools/protocol/` 是 protocol.json 的唯一"派生"实现，任何新组件（后端/前端）需要参数时新增一个 render 或直接读 JSON，不得复制值。

## Phase 0 → Phase 1 产出摘要

- **research.md**：12 项决策（工具链、版本锁定、出块模式、拓扑、共识容错、网络标识、创世生成、费用参数、开发密钥、Docker 封装、验证工具链、迁移路径）+ 10 项实现期验证清单（V-1…V-10），每项含回退方案。
- **data-model.md**：protocol.json 字段级定义与派生映射、dev 密钥文件、fixture、Genesis 不变量、运行时节点属性、链数据状态机（含 FR-021 的 stamp 校验）、验证报告。
- **contracts/**：protocol schema、报告 schema、RPC 端点契约（10 方法支持表待实现期填写）、CLI 接口（命令 / 退出码 / 输出格式 / 失败类别 / 环境变量）。
- **quickstart.md**：场景 A–G 与 spec 的 US/FR/SC 映射。

## 实现阶段关键顺序（供 /speckit-tasks 参考）

1. `blockchain/protocol.json` + schema + `tools/protocol/load.mjs` + 单元测试（US3 基础，先于一切）。
2. `docker/devnet` 镜像与 `avalanche.sh`：先以 CLI `--test-defaults` 跑通 2+5 拓扑 **验证 V-1/V-2/V-4/V-5/V-6/V-8**（研究清单中高风险项，尽早实测），期间提取 fixture 与开发验证者密钥。
3. `render-genesis.mjs` + 提交创世 + 漂移测试 → 切换到 `--genesis` 路线 → 校验创世哈希确定性。
4. entrypoint 状态机（stamp、幂等、SIGTERM 快照）、socat、就绪摘要；宿主薄封装。
5. `tools/verify` 13 项检查 + 报告 + 分类 → 填写 rpc-endpoint.md 支持表（V-9）。
6. e2e：reset-recreate ×10、单节点故障、秘密扫描、fixture 漂移。
7. 文档：devnet.md、生成的 protocol-parameters.md、4 份 ADR；README。
8. DoD 核对（宪法第十七条 8 项）+ SC-001/005/006 实测数据回填 spec/plan。

## Complexity Tracking

> 仅记录需要论证的额外复杂度 / 依赖选择（宪法第十三条）。

| 项 | 为何需要 | 更简单替代为何被否决 |
|---|---|---|
| 依赖处于维护模式的 Avalanche CLI v1.9.6 | 唯一可脚本化、覆盖 ACP-77 L1 全流程（Subnet→Chain→ConvertToL1→PoA 初始化）的官方工具；Windows 需容器化 | tmpnetctl 不支持 L1 创建；Builder Console 是网页不可复现；手写 P-Chain 交易编排工作量与风险远超本功能。缓解：版本锁定、调用集中在 `avalanche.sh`、迁移路径已记录 |
| 容器内 socat 反向代理（0.0.0.0:8545 → 127.0.0.1:9660） | avalanchego 默认只监听 127.0.0.1，CLI 本地节点未见 http-host 配置项；Windows 无 host 网络模式 | 直接映射端口不可达；修改 CLI/tmpnet 代码不在范围。若 V-8 证实可配置 http-host，则删除 socat（已登记为简化项） |
| ValidatorManager 合约分配 fixture | CLI 对 `--genesis` 原样导入、不注入 PoA 合约；而多账户/自定义 feeConfig 只能通过 `--genesis` 表达 | 让 CLI 全权生成创世则无法满足 FR-016/FR-022（多账户、参数单点）；运行时 jq 覆盖不可单元测试且创世不能离线生成。缓解：漂移测试 |
| Node.js + viem + solc-js 作为验证/生成工具链 | 需要结构化输出、JSON 报告、单元测试、合约编译；后续 Vue 前端同生态可复用 protocol 读取逻辑 | bash+jq+cast 难以单元测试且需引入 Foundry 镜像；不新增测试框架（用 `node --test`） |
