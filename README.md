# KarmaChain

基于 **Avalanche L1** 构建的 **EVM 兼容**区块链。项目最高工程规则见 [`.specify/memory/constitution.md`](.specify/memory/constitution.md)。

## 当前状态

- 功能 001「本地可复现的 Avalanche L1 开发网络」：**实现中**（阶段 1 / 8）
  - 规格：[`specs/001-local-avalanche-devnet/spec.md`](specs/001-local-avalanche-devnet/spec.md)
  - 计划：[`specs/001-local-avalanche-devnet/plan.md`](specs/001-local-avalanche-devnet/plan.md)
  - 任务：[`specs/001-local-avalanche-devnet/tasks.md`](specs/001-local-avalanche-devnet/tasks.md)

## 快速开始

> 开发者手册 `docs/devnet.md` 将在功能 001 完成时提供。宿主机唯一前置依赖是 Docker（Windows 需 WSL2 后端）。

```text
scripts/devnet-start     # 启动本地 KarmaChain 开发网络
scripts/devnet-verify    # 自动化验证
scripts/devnet-stop      # 停止（保留链状态）
scripts/devnet-reset     # 重置到创世
```

## 目录

| 目录 | 内容 |
|---|---|
| `blockchain/` | 协议参数唯一事实来源 `protocol.json`、生成的 Genesis、DEVELOPMENT ONLY 开发密钥 |
| `docker/` | 开发网络容器（Avalanche CLI 封装）与验证容器 |
| `tools/` | 协议参数派生工具、网络验证器 |
| `tests/` | 单元 / 集成 / 端到端测试 |
| `scripts/` | 宿主机薄封装（PowerShell + sh） |
| `docs/` | 开发者手册、生成的参数文档、ADR |
| `specs/` | Spec Kit 规格、计划、任务 |

## 安全提示

仓库内 `blockchain/accounts/` 与 `blockchain/validators/dev/` 下的密钥是**公开已知、仅供本地开发**的测试密钥（宪法第四条 v1.1.0 例外条款），绝不可用于任何真实网络。
