# tools/dashboard —— 链状态监控面板（功能 003）

面板是链的**只读旁观者**。不参与共识、不持有链数据、不在崩溃恢复路径上 —— 与同级的
`tools/verify/`、`tools/inspect/` 同性质。

规格见 [`specs/003-chain-health-dashboard/`](../../specs/003-chain-health-dashboard/)。

## 职责边界（三层，单向依赖）

```
public/app.mjs  ──HTTP──►  server.mjs  ──►  snapshot.mjs / public-view.mjs   （纯函数）
                                       ──►  poll.mjs  ──►  ../inspect/node-status.mjs
                                                       ──►  ../protocol/load.mjs
                                       ──►  probe-tx.mjs ──► viem
```

| 文件 | 职责 | 硬性约束 |
|---|---|---|
| `snapshot.mjs` | 判定层：参与共识谓词、档位、两个余量、异常分类、快照组装 | **纯函数**：不读文件、不发请求、不看时钟 |
| `public-view.mjs` | 公开投影（显式字段白名单） | 纯函数；方向必须是白名单，不是黑名单 |
| `poll.mjs` | 一轮探测 + 分类，无采样休眠 | 复用既有 `probeNode` / `classify`，**不另立判据** |
| `probe-tx.mjs` | 人工探活（唯一的写链路径） | 只在收到显式请求时执行；私钥不出本文件 |
| `server.mjs` | `node:http` 服务：静态托管 + 三个端点 | `/api/*` **恒返回 200** —— 观测失败是快照的内容，不是 HTTP 错误 |
| `public/` | 零构建静态页 | 见 `public/README.md` |

## 为什么判定层必须是纯函数

其中两条最重要的分支在**活链上很难制造**：

- **观察者失明**（0/7 可达）要断掉观察者的网卡
- **全员启动中**要把五台机器全停再分批起

若判定不能离线测试，这两条就只能靠"希望它对"。而它们恰好是两个方向相反的错误来源 ——
观察者断网会让既有 `summarize()` 报「链已停止出块」（**假红灯**），全员引导中会让它报
「100% 正常」（**假绿灯**）。002 的 `classify()` 已采用纯函数并在源码注释里写明同一理由。

## 不做什么

- **不调用 docker。** 核心判据（档位、百分比、余量）不得依赖容器运行时（FR-030）；
  容器事实只是可选增强，缺失时降级为纯网络判定并**显式告知**。
- **不请求 `/ext/health`。** 5 个 L1 验证者带 `partial-sync-primary-network=true`，
  其综合健康位包含 P 链可达性 —— 002 实测两个 Primary 全停时它们全部转假而 L1 仍在正常出块。
  判据必须以"本节点能否参与 L1 出块"为准（FR-013）。
- **不对节点执行任何操作类动作**（重启、停止、改配置）（FR-032）。
- **自动路径不写链。** 自动探测会持续产生区块，使高度不再反映真实业务活动 ——
  而"按需出块、高度停滞不是活性信号"正是一条诊断依据（FR-015 / FR-033）。

以上四条由 `tests/unit/dashboard-boundaries.test.mjs` 与
`tests/e2e/dashboard-readonly.test.mjs` 守卫。
