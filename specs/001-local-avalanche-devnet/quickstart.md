# Quickstart & Validation: 本地可复现的 Avalanche L1 开发网络

**Feature**: `001-local-avalanche-devnet` | **Date**: 2026-09-01

本文是**验证指南**：证明功能端到端可用的可运行场景及预期结果。命令契约见 [contracts/cli-interface.md](contracts/cli-interface.md)，RPC 契约见 [contracts/rpc-endpoint.md](contracts/rpc-endpoint.md)，参数定义见 [data-model.md](data-model.md)。

## 前置条件

| 项 | 要求 |
|---|---|
| Docker | Docker Desktop ≥ 4.x（Windows 需 WSL2 后端；macOS）或 Docker Engine 24+ 与 Compose v2（Linux） |
| 资源 | 分配给 Docker ≥ 8 GB 内存、≥ 10 GB 磁盘（7 节点；实测后修正，见 research V-6） |
| 端口 | 宿主机 8545 空闲（可用 `KARMACHAIN_RPC_PORT` 覆盖） |
| 网络 | 首次 `docker compose build` 需访问 GitHub Releases / Docker Hub 拉取锁定版本；之后离线可用 |
| 可选 | Foundry（`cast`）、MetaMask —— 仅用于 SC-004 的手工工具兼容性验证 |

不需要安装 Go、Node、Avalanche CLI 到宿主机。

## 场景 A — 首次启动（US1, SC-001）

```powershell
git clone <repo> && cd karma-chain
scripts/devnet-start.ps1      # macOS/Linux: scripts/devnet-start.sh
```
**预期**：≤ 5 分钟（首次含镜像构建 ≤ 15 分钟）打印 `KarmaChain local devnet is READY` 摘要，含 RPC URL、Chain ID 20189、KARMA、6 个开发账户及余额、DEVELOPMENT ONLY 警告。退出码 0。

## 场景 B — 标准工具连接（US1 场景 2, SC-004）

任选其一即可，三类都做则满足 SC-004：

```bash
# JS 客户端（自动化，包含在 verify 中）
scripts/devnet-verify.sh

# 合约框架（手工）
cast chain-id --rpc-url http://127.0.0.1:8545/ext/bc/karmachain/rpc          # → 20189
cast balance 0x8db97C7cEcE249c2b98bDC0226Cc4C2A57BF52FC --rpc-url ... --ether  # → 1000000
cast send --private-key 0x56289e99…8027 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 --value 1ether --rpc-url ...

# 钱包（手工）：MetaMask → 添加网络：RPC URL 同上，Chain ID 20189，符号 KARMA → 导入 ewoq 私钥 → 看到余额
```
**预期**：无需任何自定义适配；发送转账后在 ~2–10 秒内确认（SC-006）。

## 场景 C — 自动化验证（US4, SC-005, SC-010, SC-011）

```bash
scripts/devnet-verify.sh
```
**预期**：13 项全部 `[OK]`，`KarmaChain is READY`，总耗时 ≤ 3 分钟，退出码 0；`./.devnet/verify-report.json` 符合 `verification-report.schema.json`。
反向：`scripts/devnet-stop.sh` 后再运行 → `[FAIL] rpc [category: rpc] …`、`KarmaChain is NOT READY`、退出码 1。

## 场景 D — 状态保留与重置（US2, SC-002, SC-003）

```bash
# 1. 记录创世哈希与当前高度
cast block 0 --rpc-url $RPC --field hash        # → GENESIS_HASH_A
cast block-number --rpc-url $RPC                 # → N (>0，验证已发过交易)

# 2. 普通停止 / 启动 → 高度延续（FR-005）
scripts/devnet-stop.sh && scripts/devnet-start.sh
cast block-number --rpc-url $RPC                 # → ≥ N

# 3. 重置 → 回到创世（FR-004）
scripts/devnet-reset.sh && scripts/devnet-start.sh
cast block-number --rpc-url $RPC                 # → 0
cast block 0 --rpc-url $RPC --field hash         # → == GENESIS_HASH_A
```
**预期**：步骤 3 的创世哈希与步骤 1 完全一致。自动化版本：`tests/e2e/reset-recreate.test.mjs` 重复 10 次比较创世哈希（SC-003）；在第二台机器上执行步骤 1 应得到相同哈希（SC-002，人工记录于 PR）。

## 场景 E — 协议参数唯一来源（US3, SC-007）

```bash
# 单元测试：schema、约束、创世漂移、文档漂移
docker compose run --rm verify npm test

# 全库搜索：除 protocol.json 与生成物外不应出现独立硬编码
git grep -n "20189" -- ':!blockchain/protocol.json' ':!blockchain/genesis/*.json' ':!docs/protocol-parameters.md' ':!specs/**'
```
**预期**：测试通过；grep 命中项全部是"从 protocol.json 生成"的文件（生成物头部带 `GENERATED FROM blockchain/protocol.json` 标记）或读取该文件的代码，无字面硬编码。

改参数演练：把 `chain.chainId` 改为 20190（**仅演练，改回**）→ `npm test` 中漂移测试失败并提示重新生成 → `npm run protocol:render` → 生成物更新 → `devnet-start` 拒绝启动并报 `configuration: chain data was created for chainId 20189` → `devnet-reset` 后启动成功且 `eth_chainId` 为 20190。

## 场景 F — 可观测与故障分类（US5, SC-011）

```bash
scripts/devnet-status.sh                 # 7 行：NodeID / role / healthy / bootstrapped / peers
scripts/devnet-logs.sh l1-2 -f           # 单节点日志，含时间戳与级别

# 故障注入 1：端口占用
python -m http.server 8545 &  # 或任意占用 8545 的进程
scripts/devnet-start.sh                  # → 退出码 11，"port 8545 already in use by …"

# 故障注入 2：单个验证者停止（research R-05：5 节点容忍 1 个离线）
docker compose exec devnet devnet-node stop l1-3
scripts/devnet-verify.sh                 # → transfer/block-production 仍 OK；validator 项报告 4/5 healthy → 整体 NOT READY，类别 validator
docker compose exec devnet devnet-node start l1-3

# 故障注入 3：参数与链数据不一致（见场景 E）
```
**预期**：每种故障的输出归入 FR-030 正确类别；日志中不出现私钥/助记词（`tests/e2e/secret-scan.test.mjs` 对日志与仓库运行）。

## 场景 G — 安全边界（FR-023–026, SC-009）

```bash
docker compose run --rm verify npm run test:secrets
```
**预期**：仓库内私钥/助记词模式命中仅位于 `blockchain/accounts/dev-accounts.json` 与 `blockchain/validators/dev/**`，且这些文件含 `DEVELOPMENT ONLY` 标记；运行时日志 0 命中。

## 验收映射

| Spec 项 | 场景 |
|---|---|
| US1 / FR-001~008 | A, B |
| US2 / FR-003~005, FR-021 | D, E |
| US3 / FR-016~020 | E |
| US4 / FR-027~029, FR-012, FR-015 | C |
| US5 / FR-030~032 | F |
| FR-022~026 | A（输出警告）, G |
| SC-001 | A | SC-002/003 | D | SC-004 | B | SC-005/010 | C | SC-006 | B | SC-007 | E | SC-008 | 新成员按本文档执行 A→C | SC-009 | G | SC-011 | F |
