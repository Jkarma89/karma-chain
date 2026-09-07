# `docker/bootstrap/` —— 一次性建链镜像

**功能 002**。仓库中**唯一包含 Avalanche CLI 的镜像**。

## 为什么单独存在

Avalanche CLI v1.9.6 已进入维护模式（见 [ADR-0002](../../docs/adr/0002-avalanche-cli-toolchain-and-versions.md)）。但 ACP-77 的 L1 建链全流程（CreateSubnet → CreateChain → ConvertSubnetToL1 → PoA 初始化）目前没有其他可脚本化的官方路径。

功能 002 的做法是把它**限制在一次性建链**：产出固化为 [`blockchain/chain-identity/`](../../blockchain/chain-identity/README.md) 下的制品，此后运行期只读消费，节点的启动/停止/重启完全不经过它。维护模式的风险因此从"每次启动都踩"降级为"只在重新建链时踩"。

## 产出

| 制品 | 内容 |
|---|---|
| `karmachain.identity.json` | SubnetID、BlockchainID、链别名、5 个引导验证者 |
| `primary-network.genesis.json` | Primary Network 创世 |
