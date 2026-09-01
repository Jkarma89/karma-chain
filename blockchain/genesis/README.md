# KarmaChain 创世（dev）

| 文件 | 性质 |
|---|---|
| `karmachain.genesis.json` | **GENERATED FROM `blockchain/protocol.json`** —— 由 `npm run protocol:render`（`tools/protocol/render-genesis.mjs`）生成，**禁止手改**。提交到仓库是为了可审阅与漂移检测（`tests/unit/genesis-render.test.mjs`）。 |
| `validator-manager.alloc.json` | Avalanche CLI v1.9.6 注入的 ValidatorManager 相关合约账户 fixture，由 `tools/protocol/extract-vm-alloc.sh` 在容器内提取；CLI 版本变化时重新提取（`tests/e2e/vm-alloc-drift.test.sh`）。 |

创世时间固定为 `2026-09-01T00:00:00Z`（`GENESIS_TIMESTAMP` = 1788220800），因此任意机器、任意时刻生成的创世区块哈希相同。

**创世区块哈希基准**（2026-09-01 首次部署实测，SC-002/SC-003 的比对值）：

```text
0xcd807715b50b5eaba52dd332cce379da66704b443b1439e881e11751b88d3efa
```

注意：部署完成时高度已为 4——Avalanche CLI 用 ewoq 账户发送了 4 笔 PoA ValidatorManager 初始化交易，因此 ewoq 在 `latest` 的余额低于创世值；核对创世分配请查询区块 `0x0`。
改动 protocol.json 的任何共识相关字段后：`npm run protocol:render` → 提交 → `scripts/devnet-reset` 后重新启动（宪法第十五条协议变更流程）。
