# Specification Quality Checklist: 链状态与验证者网络实时监控面板

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-09
**Feature**: [spec.md](../spec.md)

## Content Quality

- [X] No implementation details (languages, frameworks, APIs)
- [X] Focused on user value and business needs
- [X] Written for non-technical stakeholders
- [X] All mandatory sections completed

## Requirement Completeness

- [X] No [NEEDS CLARIFICATION] markers remain
- [X] Requirements are testable and unambiguous
- [X] Success criteria are measurable
- [X] Success criteria are technology-agnostic (no implementation details)
- [X] All acceptance scenarios are defined
- [X] Edge cases are identified
- [X] Scope is clearly bounded
- [X] Dependencies and assumptions identified

## Feature Readiness

- [X] All functional requirements have clear acceptance criteria
- [X] User scenarios cover primary flows
- [X] Feature meets measurable outcomes defined in Success Criteria
- [X] No implementation details leak into specification

## 验证记录

### 第 1 轮（2026-09-09）—— 1 项未通过

**「No [NEEDS CLARIFICATION] markers remain」**：FR-032 的一处标记 —— 面板是否允许主动向链
提交交易以探测出块能力。符合"必须问"的三条判据：影响范围（面板从只读变为链的写入方）、
有两种合理解读、无安全的默认值可选。已作为 Q1 提交用户。

### 第 2 轮（2026-09-09）—— 全部通过

Q1 答复：**给一个由人显式触发的「立即探活」按钮，自动路径保持只读**。据此把 FR-032 展开为
FR-032…FR-036，并补 SC-017 / SC-018。

同轮补齐三处**只有边缘用例、缺可测判据**的 FR —— 若不补，「每条 FR 都有清晰验收判据」这一项
不成立而只是看起来成立：

| 原缺口 | 补上的判据 |
|---|---|
| FR-017 启动中不得报"已停止" | SC-019 |
| FR-022 异常四类分类 | SC-020 |
| FR-023 各节点各自的说法 | SC-021 |

最终规模：**37 条 FR（FR-001…FR-036，含 FR-004a）、21 条 SC**，编号连续无重复无断号。

### 第 3 轮（2026-09-10，`/speckit-analyze` 之后）—— 仍全部通过，但改了两条 FR 的措辞

`/speckit-analyze` 查出 **1 项 CRITICAL + 5 项 HIGH**，其中两项直接指向本规格：

| finding | 原文的问题 | 改法 |
|---|---|---|
| **I1** | FR-005 把健康度定义为「**计入在线**的验证者数 ÷ 总数」。"计入在线"恰好对应既有 `classify()` 的 `countsAsOffline`，而它的 `NOT_OFFLINE` **包含 `bootstrapping`** —— 照字面实现会把"1 个健康 + 4 个引导中"算成 **100% 正常**，而链一个块都出不了 | 改为「**参与共识**的验证者数 ÷ 总数」，并指向 data-model 第 0 节的逐状态判据表。"参与共识"一词此前在 spec.md 里出现 **0 次**，在 data-model 与 health-tier 里各 3 次 —— 术语漂移的典型形态 |
| **I2** | FR-007 写「MUST 呈现**三档且三档互斥**」，只列了健康度那三个。但 FR-017 要求「启动中」、FR-020 要求「失去观测能力」，实际是五个互斥状态 | 改为「三个**健康度档位** + 两个**非健康度状态**，五者互斥」。只读 FR-007 的实现者会建三档，然后必然违反 FR-017 与 FR-020 |

**这两处都是"规格自身指向错误答案"的形态**，比缺漏更危险：缺漏会让人来问，而一个写错方向的定义会被照做。两处都在条目下就地记了修订理由与后果。

另有一项本规格的小改：D2 —— 「明确不在范围内」里"不做节点的远程操作"与 FR-032 近重复，改为指向 FR-032（保留规范性条文，范围章节只做索引）。

其余四项 HIGH（FR-013 的守卫会跳过、文案禁止词无测试、`app.mjs` 跨故事冲突、探活密钥路径缺安全分析）都落在 plan.md 与 tasks.md，不影响本清单的判定。

### 逐项说明（通过项中值得记录的判断）

| 检查项 | 判断依据 |
|---|---|
| 无实现细节 | 全文未指定前端框架、构建工具、协议或数据结构。提到 `blockchain/protocol.json`、`data-model.md` §7、`tests/unit/public-artifacts.test.mjs` 是**既有事实来源与既有契约的引用**（宪法第十六条要求派生自唯一事实来源），不是本特性的实现选型；技术选型留给 `/speckit-plan` |
| 判据可测且无歧义 | 三档阈值全部由协议参数派生（FR-006）而非写死数字；"10 秒内"（FR-018/SC-002…004/SC-013）有明确起止事件；FR-008/FR-009/FR-015/FR-020 用 MUST NOT 写出**禁止的表述**，可直接对照界面文案检查 |
| 判据技术无关 | SC-001…SC-016 全部以"面板显示什么""实际交易能否确认""自动化检查是否含某类内容"表述，未涉及框架或接口 |
| 边界清楚 | 有独立的"明确不在范围内"章节（7 条），并把区块浏览器、告警外发、历史趋势、鉴权、远程操作、公网暴露逐一排除 |
| 假设已记录 | 8 条假设，每条带理由；其中"从任一台机器打开、不设专属观察机"与"时间线不持久化"两条明确写出了取舍与可砍性 |
| 与既有契约的一致性 | FR-004 / FR-004a 直接引用 `data-model.md` §7 的 `RecoveryState` 状态机与 `unreachable` 双重含义，避免另立一套判据（本轮修订过一次：初稿只写了 5 个状态取值，实际契约有 9 个，且"本机视角不可达"已由契约定义，不是本特性的新发明） |

### 与用户原始表述的一处必要偏离

用户原话「在低于安全健康度后要马上显目报警，告知链已经停止」在规格中被拆成**两级**：
80%（4/5）是"高危：零余量"，链**仍在出块**；≤60%（3/5）才是"已停止"。

理由：查询门槛 α/k = 75%，80% ≥ 75%。把 80% 表述为"链已停止"会在链完全可用时发出假报警。
已在 spec.md「核心概念」一节与 FR-007/FR-008 中就地记录该判断及其依据。
