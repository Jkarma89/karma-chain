# 契约：健康度档位判定（功能 003）

**判定方必须是纯函数。** 输入是一轮观测的结果与从 `protocol.json` 派生的容错视图，输出是档位、百分比与两个余量。不读文件、不发请求、不看时钟。

理由：本契约里最重要的两条分支（P1 观察者失明、P2 全员启动中）在活链上很难制造 —— 前者要断掉观察者的网卡，后者要把五台机器全停再分批起。若判定不能离线测试，这两条就只能靠"希望它对"。002 的 `classify()` 已经采用纯函数并在源码注释里写明了同一理由，本契约沿用。

---

## 1. 输入

```
tierInput = {
  rows: NodeObservation[],        // 已由既有 classify() 判过 state 的行
  faultTolerance: {               // 既有 faultTolerance() 的输出，原样传入
    validatorCount, maxOfflineValidators,
    effectiveDomains: [{ ids, factors, validators }], ...
  },
  observer: { reachableNodes, totalNodes, pathAlive[] },
}
```

**契约要求**：判定方**不得**从 `rows` 重新推断节点状态，**不得**重算 `maxOfflineValidators`。前者是 002 `classify()` 的职责，后者是 `load.mjs` 的 f ≤ ⌊n/4⌋ 派生。这是 FR-004 与宪法第十六条的执行面。

## 2. 派生量

```
counted        = rows.filter(r => r.countsTowardTolerance)
participating  = counted.filter(r => participatesInConsensus(r)).length
notParticipating = counted.filter(r => !participatesInConsensus(r))
threshold      = validatorCount - maxOfflineValidators
healthPercent  = round(participating / validatorCount * 100)
validatorMargin = max(0, maxOfflineValidators - notParticipating.length)
```

`participatesInConsensus` 的定义见 `data-model.md` 第 0 节。**分母恒为 `validatorCount`（声明值），不是观测到的行数** —— 沿用既有 `summarize()` 的理由：拿观测行数当分母，会在少了一行时把缺失悄悄算成在线。

## 3. 判定（严格优先级）

```
P1  observer.reachableNodes === 0                        → observer-blind
P2  participating < threshold
      && notParticipating.every(state ∈ {bootstrapping, starting})
                                                          → starting
P3  participating < threshold                             → stopped
P4  validatorMargin === 0                                 → zero-margin
P5  —                                                     → normal
```

## 4. 当前拓扑（n=5, f=1, threshold=4）的完整真值表

每一行都必须有一条单元测试。

| 参与共识 | 未参与者的状态 | 观察者可达 | 档位 | 百分比 | 验证者余量 |
|---|---|---|---|---|---|
| 5 | — | 7 | `normal` | 100% | 1 |
| 4 | 1× stopped | 6 | `zero-margin` | 80% | 0 |
| 4 | 1× stalled | 6 | `zero-margin` | 80% | 0 |
| 4 | 1× unreachable(整域) | 5 | `zero-margin` | 80% | 0 |
| 4 | 1× bootstrapping | 7 | `zero-margin` | 80% | 0 |
| 3 | 2× stopped | 5 | **`stopped`** | 60% | 0 |
| 3 | 2× bootstrapping | 7 | **`starting`** | 60% | 0 |
| 3 | 1× bootstrapping + 1× stopped | 6 | **`stopped`** | 60% | 0 |
| 1 | 4× bootstrapping | 7 | **`starting`** | 20% | 0 |
| 0 | 5× stopped | 2（仅两个 Primary） | **`stopped`** | 0% | 0 |
| 0 | 全部 unreachable | **0** | **`observer-blind`** | 0% | 0 |
| 5 | — | 6（1 个本机视角不可达） | **`normal`** | **100%** | **1** |
| 5 | — | 7，但 1 个 catching-up | **`normal`** | **100%** | **1** |

最后三行是本契约的要点：

- **本机视角不可达不降健康度**（FR-012 / FR-004a）。既有 `classify()` 已把它的 `countsAsOffline` 显式置为 `false`，本契约据此把它算作参与共识。混淆这一条会虚报余量不足，让人以为链快停了，而实际要修的是本机的网络路径。
- **`catching-up` 不降健康度**（FR-011）。它已引导、在服务 L1，只是落后一个传播尾巴。
- **1 个健康 + 4 个引导中 → `starting` 20%，不是 `normal` 100%。** 若健康度直接复用既有 `countsAsOffline`（其 `NOT_OFFLINE` 含 `bootstrapping`）就会得到后者 —— 一个链根本出不了块时的**假绿灯**。理由见 `data-model.md` 第 0 节。

### 4b. n=9 / f=2 时同一判定式的结果（SC-016）

**这一组的要点是：百分比本身从来不是判据。** 判定式一行不改，档位落点整体移位：

| 参与共识 | 百分比 | 验证者余量 | 档位 |
|---|---|---|---|
| 9 | 100% | 2 | `normal` |
| 8 | 89% | 1 | `normal` ← **不是** `zero-margin` |
| 7 | 78% | 0 | `zero-margin` ← 零余量在 **78%**，n=5 时是 80% |
| 6 | 67% | 0 | `stopped` ← 停摆在 **67%**，n=5 时是 60% |

`threshold = 9 - 2 = 7`。若实现里写死了 80 / 60 / 0.75 中的任何一个，这一组必然变红。

> **这四行是 2026-09-10 补的，并纠正了一处错误外推**：tasks.md 的 T005 原先写「n=9/f=2 时 8/9 为 `zero-margin`」，那是从 n=5 的"4/5 = 零余量"想当然推来的。f=2 时掉 1 个还剩余量 1，正确答案是 `normal`。写测试时才发现 —— 这也说明真值表必须逐行算，不能靠类比。

## 5. 边界级余量

```
domainMargin = 最大的 k，使得 effectiveDomains 按 validators 降序取前 k 个，
               其验证者数之和 + notParticipating.length ≤ maxOfflineValidators
```

| 拓扑 | `effectiveDomains` | f | `domainMargin` | 说明 |
|---|---|---|---|---|
| lan，5 台各 1 个验证者 | 5 组 × 1 | 1 | **1** | 与既有 `devnet-topology` 的 `[OK] 可容忍 1 个边界整体失效` 一致 |
| 某边界 2 个验证者 | 含一组 × 2 | 1 | **0** | 该边界一挂即同时失去 2 个 > f。此时 `validatorMargin` 仍是 1 —— 两者必须分开显示（FR-010） |
| local，单边界 7 节点 | 1 组 × 5 | 1 | **0** | 该形态不做整机失效承诺（既有 `maxValidatorsPerDomain` 在 `domainCount === 1` 时即为 n） |
| 声明 5 边界但三台共享一路供电 | 并查集合成 3 组（1/1/3） | 1 | **0** | **必须用 `effectiveDomains`**：按声明边界会算出 1，那是 `load.mjs:259` 注释所说的「在现实里为假的绿灯」 |
| 已有 1 个验证者不参与 | 5 组 × 1 | 1 | **0** | 余量已被用掉；边界余量必须扣掉当前缺口 |

## 6. 呈现契约（FR-008 / FR-009）

| 档位 | 必须说的 | **不得**说的 |
|---|---|---|
| `normal` | 还可容忍几个离线 | — |
| `zero-margin` | **链仍在正常出块**；再掉 1 个即停摆 | 「链已停止」或任何同义表述 |
| `stopped` | 成因（连接权益低于查询门槛 α/k）；恢复所需（至少再恢复几个验证者）；这是**安全停摆**——不分叉、区块零回滚、恢复后自动继续 | 「数据可能丢失」「需要重置」（002 已证明恢复不需要重置） |
| `starting` | 还在等哪些边界 / 看见几个对等验证者 | 「链已停止」「须处置」 |
| `observer-blind` | 先检查本机网络；`pathAlive` 的佐证结论 | 「链已停止」 |

**显目性不得只依赖颜色单通道**（FR-009）：`stopped` 与 `zero-margin` 必须同时具备文案差异、版式差异（如整幅横幅 vs 行内标记）与图形符号差异。理由：色觉差异、投屏偏色、黑白截图三种常见情形都会让纯颜色编码失效。

## 7. 高度**不参与**档位判定

`networkHeight` 与各节点 `height` 只用于：显示、算 `behindBlocks`、算 `catching-up` 的追赶速率（由既有 `classify()` 完成）。

**高度差、高度停滞时长一律不进入档位判定式。** 本链无交易不出块（FR-015），空闲时高度本就不动。把它写进判定会在链完全正常时报警 —— 而这恰是 002 反复强调、并已写进 `contracts/node-runtime.md` 的一条既有结论。

## 8. 分叉判定与档位并列，不相互影响

`forkDetected` 是**独立**的警报维度（FR-025）。一个创世哈希与基准不符的节点，其 `state` 完全可以是 `healthy`、其参与共识为真、健康度仍是 100% —— 它只是不在同一条链上。

因此：**档位判定式里不含 `genesisMatchesBaseline`**，分叉警报不改变百分比。两者在页面上并列呈现。

`genesisMatchesBaseline === null`（未取到）**不得**触发分叉警报，只登记 `unknownGenesis`。虚报一次分叉，之后就没人信这条警报了。

## 9. 这些判定坏了会变红吗

002 反复踩到"绿灯盖着坏机制"，所以每条判定都要回答这个问题：

| 判定 | 若实现反了，哪条测试变红 |
|---|---|
| P1 优先于 P3 | 真值表第 11 行（0 可达 → `observer-blind`）；若 P1 缺失会得 `stopped` |
| P2 优先于 P3 | 真值表第 7、9 行；若 P2 缺失会得 `stopped` |
| P2 不越过 P1 | 一条专门用例：0 可达 **且** 有节点停在 bootstrapping → 必须是 `observer-blind` |
| P4 不越过 P3 | 真值表第 6 行；若 P4 在前，`stopped` 永不触发（**一个永不变红的报警**），故必须有专门用例 |
| 本机视角不可达算参与 | 真值表第 12 行（100% / 余量 1） |
| 引导中不算参与 | 真值表第 9 行（20% `starting`，而非 100% `normal`） |
| 阈值不写死 | 一条用例喂 n=9, f=2 的容错视图，断言 threshold=7 且 8/9 为 `zero-margin`（SC-016） |
| `domainMargin` 用有效边界 | 第 5 节第 4 行（共享供电 → 0，而非 1） |
| 高度不参与档位 | 一条用例：两次快照高度完全相同、其余不变 → 档位与百分比逐字节相同 |
| 分叉不改健康度 | 一条用例：某节点 `genesisMatchesBaseline=false` 而全部参与 → 100% `normal` + `forkDetected=true` |
