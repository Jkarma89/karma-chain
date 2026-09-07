# `tests/fixtures/002/` —— 功能 002 的实测基准

从 2026-09-05 那套**可用的 001 开发网**中取证得到，用于让生成器与提取器的测试**不依赖一条活链**。

| 文件 | 内容 | 谁在用 |
|---|---|---|
| `measured-node-flags.json` | Avalanche CLI 实际传给 avalanchego 的完整标志集（L1 验证者 + Primary 节点各一份，已剔除 `*-content` 的 base64 大块，绝对路径已归一化） | **T021** —— 逐项对照 `render-node-flags.mjs` 的输出 |
| `measured-sidecar.json` | CLI 建链产出的 `sidecar.json` 原样 | **T009** —— 提取器的输入样本 |

## 为什么要固化

这些是**一次性证据**：`scripts/devnet-reset` 会删除承载它们的数据卷，而 T080 会退役整个 001 架构。届时再想拿到"CLI 到底怎么启动节点的"就只能重新搭一套旧架构。

它们记录的是**行为基准**，不是配置来源——`blockchain/protocol.json` 仍是唯一事实来源（宪法第十六条）。生成器的正确性判据是"与实测基准的差异都能说清理由"，例如 `http-host` 由 `127.0.0.1` 改为 `0.0.0.0` 是研究 R-07 的明确决定。

## 内容都是公开信息

NodeID、BLS 公钥、SubnetID、BlockchainID 均为公开标识；不含任何私钥。路径已归一化为占位符，不泄漏宿主目录结构。
