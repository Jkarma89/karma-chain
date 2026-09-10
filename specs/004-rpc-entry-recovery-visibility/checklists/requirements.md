# Specification Quality Checklist: RPC 入口可用性修复与「恢复能力」呈现

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-10
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

## 逐条核对记录（第 1 轮）

| 项 | 结论 | 依据 / 处理 |
|---|---|---|
| 无实现细节 | ⚠️→✅ | **本条最需要交代。** 规格里出现了 `/ext/health`、`configVersion`、`participatesInConsensus`、`bootstrapping` 这些具体名字。它们**不是实现选择**，而是**约束的标的物** —— 「不得请求那个特定端点」若不点名就无法测；「判据必须与那个既有函数同源」若不点名就会各写一套。反之，**真正的实现选择一律留白**：新的健康判定用什么请求、失败计数参数改不改、提示放在页面哪里，全部交给 research / plan（见 Assumptions 前三条）。 |
| 面向非技术读者 | ✅ | 每条 FR 前都有一段用日常语言说「为什么」的正文；US1–US4 全部以人的动作与期望写成。运维者是本特性的真实读者，「链好着但门坏了」「现在别重启任何东西」是他能直接用的说法。 |
| 判据可测且无歧义 | ✅ | 逐条检查了「有动词但没有可测对象」的情况。FR-006 特意把**不改动**也写成了义务（必须记录为何无需改动），否则「视情况决定」等于不可测。FR-012 明确写出 `< 2` 而非 `= 0`，并附上为什么 —— 这一条若写错，整个范围 B 的行为都会错。 |
| 判据不含实现 | ✅ | SC 全部落在可观察结果上：5xx 次数、五份面板的一致性、提示是否自行消失、卡住的验证者多久自愈、protocol.json 是否逐字节不变。没有一条以「某函数返回某值」形式表述。 |
| 判据可测量 | ✅ | 每条 SC 都带数字或可判定的二值结论：10 分钟 / 10 笔 / 零次 5xx / 五份 / 一个探测周期 / ≤60 秒 / 逐字节不变。SC-009 是人的判断，但判定明确（第一个动作是不是「启动两个 Primary」）。 |
| 边界情形 | ✅ | 8 条，全部来自实测或既有教训，不是设想：AND 依赖的中间态、`bootstrapping` 的语义、`unreachable` 的双重含义、观察者失明、两条提示同现、新 healthcheck 必须会变红、两种部署形态、误触协议变更路径。 |
| 范围边界清楚 | ✅ | 「不在范围内」列了 5 条，其中「增加 Primary 节点数」特意写明它是**更彻底但属另一个特性**的方向 —— 避免它在实施期被顺手做掉。 |
| 依赖与假设 | ✅ | 7 条假设，每条都给了取该默认值的理由；另有独立一节列出 5 处既有事实来源，全部可点开核对。 |

## Notes

**零个 [NEEDS CLARIFICATION]。** 三处本可提问的地方都取了有据可依的默认值，并写进 Assumptions：

1. **恢复能力要不要进对外精简视图** → 不进。它描述的是拓扑层面的脆弱窗口，
   对外只提供攻击时机、对外部使用者无可操作价值（宪法第四条）。
2. **提示是不是报警** → 不是。链在出块，做成红色报警会稀释「链已停止」那一档的含义。
   003 期间已经为「噪音会让人开始忽略红灯」删过一条会误报的守卫。
3. **失败计数参数改不改** → 默认不动，只在拿到实测依据时才改（FR-006）。
   当前的 502 不是该参数有错，而是**健康探测在制造失败**；先去病因，再谈剂量。

**一处需要在 plan 阶段复核而非现在断言的事**：范围 A 的改动落点
（healthcheck 硬编码在生成器里、不在 `protocol.json`）意味着**不触发 stamp 守卫、
不需要全链重置**。这已写成 FR-031 / FR-032 / SC-008 三条**义务与判据**，
但「实际改动是否真的没碰 protocol.json」必须在 plan 的宪法第十五条核查里逐项确认 ——
现在把它当成已知结论会是本项目栽过的那类错误（"推得出"不等于"验过"）。
