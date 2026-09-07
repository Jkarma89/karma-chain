# `docker/node/` —— 节点运行时镜像

**功能 002**。每个节点一个容器，容器内直接运行 `avalanchego`。

| 契约 | [`specs/002-resilient-validator-network/contracts/node-runtime.md`](../../specs/002-resilient-validator-network/contracts/node-runtime.md) |
|---|---|
| 基底 | `avaplatform/avalanchego:v1.14.1`（官方镜像） |
| 叠加 | 版本锁定的 `subnet-evm` 插件、启动期校验、健康检查 |

## 职责边界

**本目录不得包含 Avalanche CLI。** 这不是约定，是 FR-015 的实现方式——运行时能否脱离编排工具，由镜像构成静态保证，而非靠"我们保证不调用"。编排工具只出现在 [`docker/bootstrap/`](../bootstrap/README.md)。

入口脚本只做两件事：组装标志、`exec avalanchego`。**不得包含重试、快照、状态判断等编排行为**——进程存活归容器运行时，崩溃恢复归 avalanchego 自身的数据库，缺块补齐归共识协议。
