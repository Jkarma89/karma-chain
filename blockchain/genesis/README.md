# KarmaChain 创世（dev）

| 文件 | 性质 |
|---|---|
| `karmachain.genesis.json` | **GENERATED FROM `blockchain/protocol.json`** —— 由 `npm run protocol:render`（`tools/protocol/render-genesis.mjs`）生成，**禁止手改**。提交到仓库是为了可审阅与漂移检测（`tests/unit/genesis-render.test.mjs`）。 |
| `validator-manager.alloc.json` | Avalanche CLI v1.9.6 注入的 ValidatorManager 相关合约账户 fixture，由 `tools/protocol/extract-vm-alloc.sh` 在容器内提取；CLI 版本变化时重新提取（`tests/e2e/vm-alloc-drift.test.sh`）。 |

创世时间固定为 `2026-09-01T00:00:00Z`（`GENESIS_TIMESTAMP` = 1788220800），因此任意机器、任意时刻生成的创世区块哈希相同。

**创世区块哈希基准**（SC-002/SC-003 的比对值，亦记录于 `karmachain.genesis.hash`）：

```text
0x19cfde1f02e585020cdae83071bac33c7d81e411cacf7f306b82ceabe98892ed   configVersion 1.1.0（2026-09-02 起）
```

历史基准（已作废，仅供追溯）：

| configVersion | 创世哈希 | 变更 |
|---|---|---|
| 1.0.0 | `0xcd807715…3efa` | 初始：6 账户各 1,000,000 KARMA（供应 6,000,000） |
| 1.1.0 | `0x19cfde1f…92ed` | anvil-1/3/4 各 10,000,000、anvil-2 7,500,000（供应 39,500,000） |

注意：部署完成时高度已为 4——Avalanche CLI 用 ewoq 账户发送了 4 笔 PoA ValidatorManager 初始化交易，因此 ewoq 在 `latest` 的余额低于创世值；核对创世分配请查询区块 `0x0`。
改动 protocol.json 的任何共识相关字段后：`npm run protocol:render` → 提交 → `scripts/devnet-reset` 后重新启动（宪法第十五条协议变更流程）。
