# Phase 1 Quickstart: 验证场景

**Feature**: `002-resilient-validator-network` | **Date**: 2026-09-06

本文定义**在实现之前就已确定的验收场景**（宪法第八条）。每个场景可独立运行，判据明确到可以写成断言。

场景 A–E 在**单机**即可完成（阶段一），F–G 需要 5 台机器（阶段二）。

> 结构与判据风格沿用 [001 的 quickstart](../001-local-avalanche-devnet/quickstart.md)。命令名以 [`contracts/cli-interface.md`](./contracts/cli-interface.md) 为准。

## 前置

| | |
|---|---|
| 阶段一 | 一台装有 Docker Engine 24+ 与 Compose v2 的机器 |
| 阶段二 | 5 台机器：2 × Windows 10+（Docker Desktop / WSL2）、3 × Ubuntu 22.04 LTS |
| 建链 | 已执行 `devnet-bootstrap`，`blockchain/chain-identity/karmachain.identity.json` 已提交 |

每个场景开始前的公共步骤：

```bash
scripts/devnet-start.sh          # 全部节点起来
scripts/devnet-verify.sh         # 13 项检查全过，作为基线
```

---

## 场景 A — 全部节点被强制杀死后自愈（US1，最高优先级）

**这是触发本特性的那次故障的直接复现。**

```bash
# 1. 制造可验证的链上状态
cast send --private-key $ANVIL_0 --value 1ether $ANVIL_1 --rpc-url $RPC
forge create src/Greeter.sol:Greeter --rpc-url $RPC --private-key $ANVIL_0 --broadcast
H0=$(cast block-number --rpc-url $RPC)

# 2. 最粗暴的终止 —— 不给任何优雅退出的机会
docker kill $(docker ps -q --filter name=karmachain-)

# 3. 直接重启，不执行任何重置
scripts/devnet-start.sh
```

| 判据 | 期望 |
|---|---|
| 高度 | `cast block-number` ≥ `H0` |
| 创世哈希 | 与 `0x19cfde1f02e5…92ed` 完全一致 |
| 合约 | Greeter 的 `eth_getCode` 非空，存储可读 |
| 余额 | 转账后的余额保持 |
| 启动输出 | 明确告知这是崩溃恢复及恢复到的高度（FR-033） |
| 重置次数 | **0** |
| 耗时 | ≤ 5 分钟（SC-001） |

**对照组**：同样的操作在 001 的架构上必然失败（等满 300 秒后退出码 20）。这个对照是本特性价值的最直接证明，值得在验收时实际跑一遍留档。

---

## 场景 B — 反复强制终止（SC-002）

```bash
for i in $(seq 1 50); do
  docker kill $(docker ps -q --filter name=karmachain-)
  scripts/devnet-start.sh
  cast send --private-key $ANVIL_0 --value 1wei $ANVIL_1 --rpc-url $RPC
done
```

| 判据 | 期望 |
|---|---|
| 状态丢失次数 | **0** |
| 需要重置的次数 | **0** |
| 每轮后高度 | 单调不减 |
| 是否进入需人工干预的状态 | 否（边缘用例：快速连续重启） |

---

## 场景 C — 单个验证者故障与追赶（US2，V-01）

```bash
H1=$(cast block-number --rpc-url $RPC)
scripts/devnet-node.sh kill validator-3          # SIGKILL 单个验证者

# 链必须继续 —— 持续发交易观察
for i in $(seq 1 10); do
  cast send --private-key $ANVIL_0 --value 1wei $ANVIL_1 --rpc-url $RPC
done

scripts/devnet-status.sh                          # validator-3 应为 stopped，其余 healthy
scripts/devnet-node.sh start validator-3
```

| 判据 | 期望 |
|---|---|
| 杀死后链是否继续出块 | **是**（4/5 = 80% ≥ 75% 门槛） |
| `devnet-status` 对 validator-3 | 标记为不可用，**不把整条链标记为故障**（FR-031） |
| 重启后状态迁移 | `starting → catching-up`（带进度）`→ healthy` |
| 追平耗时 | ≤ 2 分钟（SC-004） |
| 追赶期间是否被健康检查反复重启 | **否**（`catching-up` 不得判为不健康 —— 见 node-runtime 契约） |

---

## 场景 D — 超出容错上限后恢复（V-05，FR-009）

```bash
H2=$(cast block-number --rpc-url $RPC)
scripts/devnet-node.sh kill validator-3
scripts/devnet-node.sh kill validator-4          # 2 个离线 → 60% < 75%

cast send ... --rpc-url $RPC                      # 应当不被确认

scripts/devnet-node.sh start validator-3          # 恢复到上限内
```

| 判据 | 期望 |
|---|---|
| 2 个离线期间 | 链**停止出块**，不分叉、不产生前后不一致的状态 |
| 恢复到 1 个离线后 | **自动**继续出块，无需人工干预 |
| 已确认区块 | **零回滚** —— 高度 `H2` 处的区块哈希前后一致（SC-006） |
| `devnet-status` | 显示在线数与容错上限的关系，让"已越界"一眼可见 |

这个场景验证的是**安全性**而非可用性：停摆是正确行为，分叉才是事故。

---

## 场景 E — 单节点数据损坏（V-04，FR-006）

```bash
scripts/devnet-node.sh stop validator-5
docker volume rm karmachain-validator-5-data      # 模拟该节点数据彻底损坏
scripts/devnet-node.sh start validator-5
```

| 判据 | 期望 |
|---|---|
| 其余 4 个节点 | 完全不受影响，链持续出块 |
| validator-5 | 从对等节点重新同步，最终 `healthy` |
| 是否需要全链重置 | **否**（SC-011） |
| 身份 | NodeID 不变（身份来自只读挂载的 `staker.crt`，不在数据卷里 —— 这正是 R-03 的收益） |

---

## 场景 F — 整个故障边界失效（US4，阶段二）

在 5 台机器部署完成后，对任意一台执行整机关机或拔网线。

| 判据 | 期望 |
|---|---|
| 链是否继续出块 | **是**，连续 30 分钟、每分钟至少一笔交易全部确认（SC-005） |
| 其余机器的 `devnet-status` | 缺席节点标记为 `unreachable`（**边界缺席**），区别于节点故障 |
| 边界恢复后 | 其上节点全部自动追平，≤ 2 分钟，无需人工干预 |
| Windows 边界重启后 | 节点是否自动回来 —— **V-09 的实测出口**，结果决定 R-11 采用哪个候选方案 |

---

## 场景 G — 拓扑校验（FR-021，US5）

```bash
scripts/devnet-topology.sh --deployment lan       # 合法拓扑
# 手工把 validator-2 挪进 win-1，使该边界含 2 个验证者
scripts/devnet-topology.sh --deployment lan       # 应当拒绝
```

| 判据 | 期望 |
|---|---|
| 合法拓扑 | 退出 0，显示每边界验证者数与容错上限 |
| 违规拓扑 | 退出 **13**，指出边界 id、实际数量、上限、以及"把哪个节点挪走" |
| 共享失效因素 | 两个边界共享同一因素时**告警但不阻断** |
| 漂移 | 手改任一生成的节点配置后，`devnet-render --check` 失败并指出偏离项 |

---

## 场景 H — 运行时确实脱离了编排工具（US3，FR-015）

```bash
docker run --rm --entrypoint sh karmachain/node:local -c 'command -v avalanche || echo ABSENT'
grep -rn "avalanche " docker/node/ scripts/ tools/ | grep -v bootstrap
```

| 判据 | 期望 |
|---|---|
| 运行时镜像内 | `avalanche` 可执行文件 **ABSENT** |
| 运行时代码路径 | 无任何 Avalanche CLI 调用（`docker/bootstrap/` 除外） |
| 全部节点能否正常起来 | 是，13 项验证全过 |

这个场景把 FR-015 从"我们保证不调用"变成**可静态验证的事实**——这正是 R-02 选官方 avalanchego 镜像而非沿用 CLI 镜像的理由。

---

## 场景 I — Primary Network 节点全停（V-08，**最高优先级**）

```bash
H3=$(cast block-number --rpc-url $RPC)
scripts/devnet-node.sh kill primary-1
scripts/devnet-node.sh kill primary-2
cast send ... --rpc-url $RPC
```

| 结果 | 含义 | 后续 |
|---|---|---|
| L1 **继续出块** | Primary 节点不是单点 | 按现设计推进 |
| L1 **停止出块** | Primary 节点是新的单点，会抵消 5 个验证者边界的冗余 | **必须在阶段二之前追加 Primary 节点的冗余设计** |

**这是本特性唯一一个"答案为否就要改设计"的场景，必须在阶段一就跑，不能拖到阶段二。**

---

## 回归基线（不得回退）

任何场景执行后，以下必须仍然成立：

| 项 | 判据 | 来源 |
|---|---|---|
| 13 项验证 | 全部通过 | FR-025 |
| 创世哈希 | `0x19cfde1f02e5…92ed` | FR-024 |
| Chain ID / Network ID | 20189 / 1337 | FR-024 |
| 6 个开发账户余额 | 与创世一致 | FR-024 |
| 对外 RPC 路径 | `/ext/bc/karmachain/rpc` 可用 | FR-024、V-10 |
| 出生证明机制 | 参数与链数据不一致时仍以退出码 12 拒绝 | FR-026 |
| 公开制品 | 不含内部路径、密钥材料、内部版本、私网地址 | FR-028 |
| 人工步骤 | 克隆 + 一条启动命令，不多于当前 | FR-030、SC-007 |
