# Specification Quality Checklist: 崩溃可恢复、可跨机部署的验证者网络

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-06
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

### 第 1 轮校验（2026-09-06）

**通过**：内容质量 4/4，需求完整性 7/8，特性就绪度 4/4。

**唯一未通过项**：`No [NEEDS CLARIFICATION] markers remain` —— 规格中保留 1 处待澄清（阶段二的故障边界规模），已在 `## Outstanding Clarifications` 中登记为 Q1，并作为问题提交给决策方。

**关于"无实现细节"的说明**：`## 背景与目标` 中出现容器运行时的产品名称，属于对触发事件的事实陈述（取证记录），非实现规定。需求（FR）与成功标准（SC）中不含任何产品、框架或接口名称，均以"运行单元""持久化数据存储""编排工具""故障边界"等能力语言表述。此处理与 001 规格的既有惯例一致。

**阻塞范围**：Q1 只阻塞阶段二相关条目（US4、FR-020、FR-021、SC-005）。阶段一（US1–US3、US5、US6 及其对应 FR / SC）不受影响，可先行进入 `/speckit-plan`。

**待办**：Q1 得到答复后，把答案写回 FR-020、FR-021、SC-005 与 Assumptions 中的验证者数量假设，删除 `## Outstanding Clarifications` 小节，并重跑本清单。

### 第 2 轮校验（2026-09-06）

**Q1 已答复：选项 A —— 5 个故障边界 × 5 个验证者，每边界 1 个。** 满足 $\lceil 5/5 \rceil = 1 \le 5/4$，验证者数量不变，不触发宪法第十五条的协议变更流程。

已写回规格：

| 位置 | 变更 |
|---|---|
| FR-020 | 由"多个故障边界"具体化为"5 个边界、每边界恰好 1 个验证者"，并写明失效后剩余权重 80% ≥ 75% 门槛 |
| FR-021 | 校验规则具体化为"任一边界内验证者数量不得超过 1 个"，并规定报错须指出边界、实际数量与上限 |
| SC-005 | 具体化为"5 个边界中任意 1 个失效"，补齐 30 分钟观测窗口与 2 分钟追平上限 |
| Assumptions | 验证者数量维持 5 的理由改为"该组合已满足约束"；新增 5 台异构机器（1 Windows + 4 Linux）的边界声明，及"宿主操作系统前置条件须在 plan 阶段逐台核验"为阶段二硬前提；新增 Primary 节点归属留待 plan |
| Edge Cases | 新增两条：异构操作系统的行为差异、宿主不满足运行时前置条件须在部署前识别 |

**结果**：15 项全部通过。规格计 34 条 FR、12 条 SC、6 个用户故事、15 条边缘用例。

**遗留风险（不阻塞规格，阻塞阶段二实施）**：目标硬件中的 4 台为 CentOS 6（2020-11-30 已终止支持）。其能否运行选定的节点运行时须在 `/speckit-plan` 阶段逐台核验；若不可行，需先解决宿主操作系统问题，否则阶段二的 5 个故障边界无法成立。已作为 Assumptions 中的硬前提记录。

### 第 3 轮校验（2026-09-06）

**硬件布局已确定，第 2 轮的遗留风险解除。** 最终布局：**2 台 Windows + 3 台 Ubuntu 22.04 LTS**，共 5 台，每台 1 个验证者、1 个故障边界。CentOS 6 不再参与，操作系统前置条件（Docker Engine 24+ 与 Compose v2）已满足——节点运行在容器内，宿主 glibc 不参与约束。

已写回规格（Assumptions 与 Edge Cases）：

| 变更 | 缘由 |
|---|---|
| 硬件描述由"1 Windows + 4 Linux"改为"2 Windows + 3 Ubuntu 22.04 LTS"，并写明操作系统前置条件已确定 | 布局确定，第 2 轮的核验前提已满足 |
| 新增假设：故障边界的独立性需主动维护（更新窗口、供电、网络路径） | 5 台机器不等于 5 个独立故障边界；同一事件同时打掉 2 个边界即突破容错上限 |
| 新增假设：Windows 与 Linux 边界的可用性特征不同（容器运行时是否需登录才启动） | 两类宿主的开机恢复行为不一致，不能默认同构 |
| 新增边缘用例：多个边界被同一外部事件同时打掉 | 对应上述独立性风险的可观测要求 |
| 新增边缘用例：宿主重启后容器运行时未自动启动 | 对应 Windows 边界的缺席风险 |

**结果**：15 项仍全部通过。规格计 34 条 FR、12 条 SC、6 个用户故事、**17 条**边缘用例。

**移交 plan 阶段的待定项**：故障边界独立性的具体保障手段、Windows 宿主的开机自启方案、2 个 Primary Network 节点的边界归属。
