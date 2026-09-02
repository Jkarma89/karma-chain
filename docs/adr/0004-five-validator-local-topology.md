# ADR-0004：本地网络采用 5 个 L1 验证者 + 2 个主网节点

**状态**：已接受 · **日期**：2026-09-01 · **相关**：research R-04/R-05，spec US5，功能 001

## 决定了什么

本地开发网络由 **7 个 avalanchego 节点**组成，全部运行在同一容器内：

- **2 个 Primary Network 节点**（P/C/X 链，端口 9650/9652）—— Avalanche CLI 本地网络默认规模，对开发者透明；
- **5 个 KarmaChain L1 验证者**（端口 9660–9668，交替分配 staking 端口），**Proof-of-Authority** 管理，密钥固定在 `blockchain/validators/dev/node-{1..5}/`。

共识参数采用 avalanchego 默认值：`k=20, alphaPreference=15, alphaConfidence=15, beta=20`（已在节点运行时配置中实测确认）。

## 为什么

1. **5 个验证者能在本地暴露多验证者行为**（2026-08-31 由项目负责人裁定）：对等连接、bootstrapping、单节点故障下的共识行为都可以在本地观察到，而不必等到 Staging 环境。单节点拓扑虽最轻量，却让 US5 的 peers/共识检查失去意义。
2. **成本远低于预期**：实测 7 节点 + 5 个 VM 插件 + 1 个 signature-aggregator 进程总 RSS ≈ **1.1 GB**，首次启动 75–80 秒（SC-001 目标 5 分钟）。文档前置条件因此定为"给 Docker ≥ 4 GB 内存"。
3. **PoA 而非 PoS**：本地开发无质押经济需求；ValidatorManager 是 Avalanche CLI 部署的官方合约（不自研，符合宪法第六条）。
4. **固定密钥 → 固定 NodeID**：跨重建一致，日志、状态表、文档可以稳定引用节点身份（实测 5/5 NodeID 与仓库记录一致）。

## 容错行为（源码推算 + 实证）

`snow/engine/snowman/engine.go` 的 `minConnectedStakeToQuery = alphaConfidence / K = 15/20 = 75%`，
`chains/manager.go` 又把采样数以总权重为上限（`sampleK > bootstrapWeight` 时下调），因此 5 个等权验证者：

| 离线节点数 | 在线占比 | 结论 |
|---|---|---|
| 1 | 80% ≥ 75% | **继续出块** |
| 2 | 60% < 75% | 停止发起查询，无法出块 |

**实证**（`tests/e2e/single-validator-down.test.mjs`，5/5 通过）：停掉 1 个 L1 验证者后网络继续确认交易，
确认时间保持约 4 秒不变；`devnet-status` 报 1/7 不健康并退出 1，`devnet-verify` 的 `node`/`validator`
两项失败且带正确类别，`transfer`/`block-production` 仍通过。

## 考虑过的替代方案

| 方案 | 否决理由 |
|---|---|
| 单个 L1 验证者 | 最省资源、启动最快，但无法观察对等连接与共识降级行为；US5 的 peers 检查形同虚设 |
| 3 个验证者 | 容错阈值下 1 个离线即 66% < 75%，无法演示"容忍单点故障" |
| 可配置节点数（默认 1，可切多节点） | 两套拓扑都要测试与文档化，扩大范围；且"可配置项"本身要纳入协议参数单一来源 |
| 自定义 Snow 参数（如 k=5） | 偏离 avalanchego 默认值即偏离生产行为，且属协议级改动；实测默认值在 5 节点下工作正常，无必要 |

## 影响

- 资源占用约 1.1 GB / 12 个进程；开发机需给 Docker ≥ 4 GB。
- 节点只监听容器内回环（avalanchego `--http-host` 被 CLI 固定为 127.0.0.1，不可配置），因此：
  - 对外 RPC 经容器内 socat 代理到 `0.0.0.0:8545`；
  - 逐节点健康检查需要额外的每节点代理（绑容器 IP、同端口），只在 compose 网络内可达 → `devnet-verify` 必须在容器内运行，宿主运行时 `node`/`validator` 两项会降级为 SKIP。
- 观测到的 `peers` 为 6（7 节点网络中各自看到其余 6 个）——分析阶段最初写的"peers=4"是错误假设，已改为"≥ 4"并由实测定值。

## 迁移 / 演进

- 改变验证者数量 = 修改 `protocol.json`（`validators.count` 与 `nodes[]`）+ 递增 `configVersion` + 补充/删除密钥目录 → 走宪法第十五条流程并重置链。
- 跨机部署（真正的分布式验证者）不在本功能范围（spec Out of Scope），属未来 Staging/生产功能。
