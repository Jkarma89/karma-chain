# Specification Quality Checklist: 弹性成员管理

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-11
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

## 逐条核对记录

| 项 | 结论 | 依据 / 处理 |
|---|---|---|
| 无实现细节 | ⚠️→✅ | 规格里出现了 `stamp_fields()`、`configVersion`、`participatesInConsensus`、ACP-77 这些具体名字。与 004 同一处理：**它们是约束的标的物，不是实现选择**。「加节点后那六项必须逐字节不变」若不点名那六项就无法测；「引导中的节点不得计入参与共识」若不点名那个既有谓词就会各写一套。反之**真正的实现选择全部留白**：拓扑放哪个文件、用什么格式、脚本怎么组织、范围 C 走哪条路 —— 一律交给 research / plan。 |
| 面向非技术读者 | ✅ | 六个用户故事全部以人的动作与期望写成（"他期望既有的七个节点连日志都不多一行"）。F-5 那张 `n → f` 表是本特性最需要被非技术读者看懂的东西，放在最前面并配了一句话解释。 |
| 判据可测且无歧义 | ✅ | 逐条检查了"有动词但没有可测对象"。FR-007（分家不改变任何运行时行为）写成了**逐字节相同**这个可机械核对的判据；FR-011/FR-012/FR-013 三条"拦下"类要求都配了具体触发条件（f 下降 / 跌破门槛 / 违反 T-5），不是"必要时提醒"。 |
| 判据不含实现 | ✅ | SC 全部落在可观察结果上：stamp 六项是否逐字节变、节点容器时刻是否变、集合数 ±1、面板显示什么、`git status` 干不干净。没有一条以"某函数返回某值"表述。 |
| 判据可测量 | ✅ | 每条 SC 带数字或二值结论：逐字节 / 零个退出 12 / 每 30 秒一笔连续 10 分钟 / n=4…12 逐个 / ≤120 秒 / `git status` 干净。SC-016 是人的判断，但判定明确（能不能不问人完成）。 |
| 边界情形 | ✅ | 10 条，全部来自 002–004 的实测或本次核对，不是设想：加入时链本身不健康、创世不一致的节点、T-5 越界、缩容让 f 下降、缩容跌破门槛、Warp 多步中间失败、退出后进程还活着、两个 Primary 都不在时加入、跨机同步不是原子的、有人把拓扑加回协议文件。 |
| 范围边界清楚 | ✅ | 四块范围 + 五条"不在范围内"。特别写明**权限去中心化不在本期**（PoA owner 仍单一）—— 否则"弹性成员"很容易被读成"任何人都能加入"。 |
| 依赖与假设 | ✅ | 7 条假设，每条都给了取该默认值的理由；另有独立一节列出 8 处既有事实来源，全部可点开核对。 |

## Notes

**零个 [NEEDS CLARIFICATION]。** 两处真正会改变工作量的分歧已在写规格**之前**问过并拍板：

1. **退出/缩容是否在本期** → **加与退都要**。理由写进了 US3 的 "Why this priority"：
   「退」比「加」更容易出事（8→7 把可离线数从 2 砍到 1，而名册少一个看着无关紧要）。
2. **拓扑分家怎么切** → **一次切干净，不留向后兼容**（FR-005）。
   保留兼容会在一段时间里存在**两个事实来源**，而"两个地方都能配"正是 004 刚修的
   那类问题的根源。

**其余本可提问的地方都取了有据可依的默认值**，写在 Assumptions 里 ——
其中最要紧的一条是「**成员的事实来源在链上**」：本期之后成员是运行期可变的，
文件无法回答"现在到底有几个验证者"。这与宪法第十六条不冲突（它管的是**协议参数**），
但必须显式说出来，否则下一个人会拿 `validators.count` 当答案。

**一处刻意不预设结论**：范围 C 在 F-6（加到 ≥5 个 Primary）与 F-7（L1 验证者兼任
P 链验证者）之间**不预选**。F-7 看起来更省，但它改变节点的同步模式与资源占用 ——
**未实测**。规格只要求「决定必须有实测数据支撑」（FR-020），不要求走哪条。

**一处必须在 plan 阶段复核而非现在断言**：范围 A 声称「分家不触发 stamp、不需要重置」。
静态证据已有（`stamp_fields()` 只比那六项、`topology` 不在其中），
但 **SC-001 要求实测**。004 的经验是：这类"推得出"的结论必须有一条机械判据顶着 ——
plan 的宪法第十五条核查里要把「禁止把部署描述写回协议参数文件」列成显式禁止项。
