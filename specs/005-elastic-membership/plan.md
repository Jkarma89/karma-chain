# Implementation Plan: 弹性成员管理 —— 在线增删节点，不重置链

**Branch**: `005-elastic-membership` ｜ **Date**: 2026-09-11 ｜ **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/005-elastic-membership/spec.md`

---

## Summary

把一个**分类错误**纠正过来：`topology`、端口、地址这些**部署描述**住在 `protocol.json` 里，
与 `chainId`、创世、gas 共用一个 `configVersion`，而 `configVersion` 在出生证明的比对之列 ——
于是「换一台机器」被当成了「换一条链」。

**本仓库自己的历史就是最有力的论据**：`configVersion` 递增过四次，**三次是部署变更**
（1.2.0 加 `publishedHosts`、1.3.0 加 `topology`、1.4.0 改端口），每一次都丢掉了当时的全部链上状态。

四块范围：

- **A（地基）** 部署描述与协议参数**一次切干净**。判据是**分家前后生成物逐字节相同** ——
  只搬家、不改行为。关键手法是**保持 `deriveTopology()` 的输出形状不变**，
  这样 30 多个消费者一行不用改。
- **B** 在线**增删** L1 验证者（ACP-77 + 预部署的 PoA 合约）。**退之前先说清代价** ——
  8→7 会把可离线数从 2 砍到 1。
- **C** Primary 侧的弹性。**不预选方案**，先拿四个实测数据再动手。
- **D** 判据与呈现跟着成员变化 —— 包括那个反直觉的结论：**加了节点，容错可能一点没涨。**

---

## Technical Context

**Language/Version**：Node.js（仓库既有版本，`node:test` 内建运行器）；
生成器为 JS；shell 侧 `.sh` + `.ps1` 双份；合约调用走既有 `viem`

**Primary Dependencies**：**零新增运行时依赖**。可能新增**一份数据文件**
（ValidatorManager 的 ABI，vendor 成 JSON 并锁版本）—— 它是数据不是依赖（research R-03）

**Storage**：链上状态（PoA 合约的验证者集合、P 链的权益分布）是成员的事实来源；
仓库侧只存"期望成员"的声明

**Testing**：`node:test` 三层 + `npm run render:check`（10 项生成物漂移）+
`npm run test:secrets` + `scripts/devnet-verify`；当前基线 **单元 736/736**

**Target Platform**：Linux（3 台 Ubuntu，**宿主无 Node**）+ Windows/WSL2（2 台）；
新增机器同样两种可能

**Project Type**：区块链基础设施 + 只读观测面板。既有布局，不新增顶层目录

**Performance Goals**：
- 加/删成员**不得**中断链的可用性（每 30 秒一笔连续 10 分钟，零失败）
- 面板判据的复杂度不随 n 上升（它本来就是 O(n)）

**Constraints**：
- stamp 六项的**语义零改动**（FR-003）——只移出部署描述，不削弱保护
- `deriveTopology()` 输出形状**逐字段不变**（research R-02）
- 分家前后生成物**逐字节相同**（FR-007 / SC-003）
- 不引入新编排系统（ADR-0008）、不引入重型依赖
- PoA owner 仍单一（权限去中心化不在本期）

**Scale/Scope**：当前 7 节点 / 5 边界 / 5 台机器；本期后 n 的可行范围 4…12
（判据要对整个范围正确）

---

## Constitution Check

*GATE：Phase 0 之前必须通过；Phase 1 设计后重查。* 宪法 v1.1.0，20 条全查。

| 条 | 标题 | 判定 | 依据 |
|---|---|---|---|
| 一 | 区块链优先原则 | ✅ | 本期让**链的成员**可在线变更，而这正是 Avalanche L1 的设计目标；不绕开链去做假的"弹性" |
| 二 | 链上与链下必须明确分工 | ✅ | **本期的核心就是一次分工纠正**：成员集合的事实来源在链上，文件只声明期望；部署描述在链下且不影响链身份 |
| 三 | EVM 兼容性原则 | ✅ | 不改 chainId / 创世 / gas / 预编译。ValidatorManager 是**已在创世里**的合约，本期只调用不改写 |
| 四 | 安全优先原则 | ⚠️ 见下 | 新验证者的密钥材料是本期最大的安全面：**私钥必须在目标机器上生成、不离开那台机器**，只有公开材料参与注册。需在 plan 阶段把这条写成显式禁止项 |
| 五 | 区块链执行必须具有确定性 | ✅ | 不触碰执行路径；成员变更走链上既有的 ACP-77 流程 |
| 六 | 智能合约安全原则 | ⚠️ 见下 | 本期**调用**一个已部署的合约。它不是我们写的，但我们要为"调用参数正确、失败可见"负责；且需要 ABI（research R-03） |
| 七 | 基础设施必须可复现 | ✅ | 分家后生成物仍全部由生成器渲染，`render:check` 覆盖新划分；**逐字节相同**是本期的核心不回归判据 |
| 八 | 测试和验证优先 | ✅ | 每条 FR 有判据（dod 第三节逐条映射）；每条新守卫做**变红检查**（FR-032）。`f(n)` 对 n=4…12 逐格 —— 因为 003 在这里栽过一次错误外推 |
| 九 | 可观测性原则 | ✅ | 成员漂移、T-5 越界、"这次变化有没有改变容错"都要**可见且带处置方向**；沿用 003/004 的异常分类形状，不新建一套 |
| 十 | API 与协议必须明确 | ✅ | 两份契约：[deployment-descriptor](./contracts/deployment-descriptor.md)、[membership-change](./contracts/membership-change.md)。面板快照可能新增字段（附加，不改既有语义） |
| 十一 | 严格进行模块职责划分 | ✅ | 装载层（读哪个文件）与消费层（用派生结果）分离 —— 保持 `deriveTopology()` 输出不变正是这条的落地 |
| 十二 | AI 辅助开发治理原则 | ✅ | 全程 Spec Kit；两处会改变工作量的分歧（退出是否在本期、怎么切）**在写规格之前问过并拍板**；范围 C **不预设结论**，要求实测 |
| 十三 | 依赖和技术选型原则 | ⚠️ 见下 | 零新增运行时依赖，但可能 vendor 一份 ABI JSON。需在 plan 阶段确认它算数据而非依赖，并锁版本 |
| 十四 | 文档与架构决策必须可追踪 | ⚠️ 见下 | 需要一份 ADR 记「部署描述不是协议参数」这个划分及其历史论据（三次不必要的重置） |
| 十五 | 协议变更控制原则 | ⚠️ 见下 | 本期**重新定义了什么算协议变更**。这本身是一次治理级改动，必须逐项核验而非声称 |
| 十六 | 协议配置必须有唯一事实来源 | ⚠️ 见下 | 本期把"成员"的事实来源从文件移到链上。**这需要显式论证与第十六条不冲突**（第十六条管的是协议参数），并写进 ADR |
| 十七 | Definition of Done | ✅ | dod 在 tasks 阶段建，八项逐条核 |
| 十八 | 宪法治理规则 | ✅ | 无偏离需要豁免 |
| 十九 | 修改 Constitution 的规则 | ✅ | 本期**不修改宪法**。但第十五/十六条的**适用范围**被重新划定 —— 见下方 Gate 四 |
| 二十 | 版本 | ✅ | v1.1.0，无需变更 |

### Gate 四查

**查一：这次改动本身构成协议变更吗？（第十五条）**

**不构成。** 分家只是把字段搬家，`chain` / `avalanche.networkId` / `nativeToken` /
`feeConfig` / `devAccounts` 一个不动，创世不重新生成。

**但这条不能只靠声明** —— **SC-003 要求分家前后全部生成物逐字节相同**，
这是机械判据。**在它通过之前，本期不得宣称"不需要重置"。**

> 004 的教训：plan 里那句「每条 FR 都有对应判据」当时就是假的，
> 是 `/speckit-analyze` 的机械扫描查出来的。**一句自我声明的合规，
> 在没有机械核验之前不算证据。**

**查二：这是在削弱 stamp 吗？（第十五条 / 第十六条）**

**是在缩小它的保护范围，而不是削弱它。** 缩小之后必须证明它**没有缩过头** ——
契约的 **D-5** 与 quickstart 场景 **D**：改一个真正的协议参数，节点仍必须退出 12。

**只做"部署变更不再拦"而不做"协议变更照旧拦"，会得到一个什么都不拦的守卫。**
本项目已在三处栽过「不会变红的守卫比没有守卫更坏」。

**查三：成员的事实来源移到链上，与第十六条冲突吗？**

**不冲突，但必须写清楚。** 第十六条要的是**协议参数**的唯一事实来源；
而本期之后成员集合**不再是协议参数** —— 它是运行期可变的链上状态。
文件保留"期望成员"的声明，两者漂移**必须可见**（FR-030）。

**这个论证要进 ADR**，否则下一个人会认为本期违宪。

**查四：新验证者的密钥怎么办？（第四条）**

**显式禁止项**：私钥（staking TLS key、BLS signer key）**必须在目标机器上生成**，
**不得**经由仓库、聊天或任何中转传递；只有公开材料（NodeID、证书公钥、BLS 公钥）
参与注册流程。

宪法第四条 v1.1.0 允许提交密钥**仅当四个条件全部成立**
（公开已知或仅本地开发网有效、文件标 `DEVELOPMENT ONLY`、在秘密扫描白名单里、
生产技术上无法接受它们）。**新验证者的密钥默认不满足** —— 除非有人显式论证并登记。

### 需要处理的六条 ⚠️

| 条 | 缺什么 | 怎么补 |
|---|---|---|
| 四 | 密钥处置写成显式禁止项 | 进 tasks 的禁止项清单 + 文档 |
| 六 | ValidatorManager 的 ABI 与调用正确性 | research R-03 已列三条途径，plan 阶段选定并锁版本 |
| 十三 | 确认 vendor ABI 算数据不算依赖 | 写进 ADR 与 dod |
| 十四 | 一份 ADR | `docs/adr/0012-deployment-is-not-protocol.md` —— 记划分判据、三次不必要重置的历史、以及与第十五/十六条的关系 |
| 十五 | 逐项核验"不构成协议变更" | SC-003（生成物逐字节相同）+ SC-001（stamp 六项不变） |
| 十六 | 论证成员事实来源移到链上不违宪 | 同 ADR-0012 |

---

## Project Structure

### Documentation (this feature)

```text
specs/005-elastic-membership/
├── plan.md                          # 本文件
├── spec.md                          # 6 个用户故事 · 38 条 FR · 16 条 SC
├── research.md                      # R-01…R-09 + V-01…V-18
├── data-model.md                    # 分家判据（一个问题）+ 逐字段归属 + f(n) + 成员漂移
├── contracts/
│   ├── deployment-descriptor.md     # 范围 A（含"没缩过头"的 D-5）
│   └── membership-change.md         # 范围 B/C/D（含两条退出路径）
├── quickstart.md                     # 18 个验收场景 A–R
├── checklists/
│   └── requirements.md               # 规格质量核对（已通过）
└── tasks.md                          # Phase 2（/speckit-tasks 生成）
```

### Source Code (repository root)

**绝大多数落在既有文件里。** 新增的只有部署描述文件、它的 schema、成员操作脚本与守卫。

```text
blockchain/
├── protocol.json                  # 改：移出部署描述（一次切干净）
├── protocol.schema.json           # 改：去掉被移出的字段
├── deployment.json                # 新：部署描述（**文件名由 T003 定**）
└── deployment.schema.json         # 新（同上）

tools/protocol/
└── load.mjs                       # 改：读两个文件；**deriveTopology() 输出形状不变**

docker/bootstrap/entrypoint.sh     # 改：jq 从新文件读 topology

tools/membership/                  # 新：成员变更（范围 B）
├── add-validator.mjs
├── remove-validator.mjs
├── member-set.mjs                 # 读链上实际成员
└── abi/validator-manager.json     # vendor 的 ABI（数据，锁版本）

scripts/
├── devnet-member.sh / .ps1        # 新：两份等价，退出码有语义

tools/dashboard/snapshot.mjs       # 改：成员漂移、f(n) 通用化、004 的常量改按权益算

tests/unit/
├── deployment-split.test.mjs      # 新：归属表 + 部署字段不得回协议文件
├── derive-topology-shape.test.mjs # 新：输出形状 deepEqual
├── fault-tolerance-range.test.mjs # 新：f(n) 对 n=4…12 逐格
├── membership-guards.test.mjs     # 新：三条"拦下" + 代价告知
└── （约 12 个既有测试改读新文件）

tests/integration/ + tests/e2e/    # 新：成员变更的多步失败与重试

docs/
├── adr/0012-deployment-is-not-protocol.md   # 新（第十四/十五/十六条）
├── adr/README.md                             # 改：索引
└── devnet.md                                 # 改：两条流程分开写 + 加机器规程 + 只加观察机零成本
```

**Structure Decision**：沿用既有分层。本期最关键的结构决定是
**把改动挡在装载层** —— `deriveTopology()` 的输出形状不变，
于是 `render-*`、`poll.mjs`、`node-status.mjs`、`avalanche-api.mjs` 等 30 多个消费者
**一行都不用改**（research R-02 实测：37 个文件、203 处提及，但绝大多数用的是派生结果）。

---

## Complexity Tracking

| 偏离 | 为什么需要 | 更简单的方案为何被否 |
|---|---|---|
| **新增一个顶层配置文件** | 部署描述必须有自己的版本号且不进 stamp；留在原文件里做不到 | 「在 `protocol.json` 里加一个 `stampExempt` 段」更小，但那仍是一个文件两种语义 —— 下一个人加字段时还是要猜它属于哪半边 |
| **vendor 一份 ABI JSON** | 要调用 ValidatorManager 就必须有 ABI，而仓库里没有 | 从链上反推选择器更"自给自足"但脆弱且难核对；用 Avalanche CLI 则与 ADR-0008 冲突 |
| **成员的事实来源从文件移到链上** | 本期之后成员运行期可变，文件回答不了"现在有几个" | 「让文件继续当事实来源、每次变更同步写回」看着更符合第十六条，但那是**两个事实来源**，且链上变更可能绕过工具发生 —— 漂移会静默 |
| **`f(n)` 对 n=4…12 逐格写断言** | 003 在这里栽过一次错误外推（从 n=5 推 n=9 推错） | 「只测 n=5 与 n=8 两个代表」少写七行，但那次错误恰好发生在没测的那一格 |
| **优雅退出与紧急摘除两条路径** | 机器坏了时优雅退出走不通，而那正是最需要退出的时候 | 只做优雅退出，会在真出事时把人逼到手工乱来 |

---

## Phase 结果

- **Phase 0（研究）**：[research.md](./research.md) —— R-01…R-09 决策 + V-01…V-18 待实测。
  最有力的一条是**本仓库自己的历史**：四次 `configVersion` 递增里**三次是部署变更**，
  每次都丢掉了当时的全部链上状态。
- **Phase 1（设计与契约）**：[data-model.md](./data-model.md)、[contracts/](./contracts/)、
  [quickstart.md](./quickstart.md)。
- **Phase 1 后重查宪法**：六条 ⚠️ 已列为必办项，其余 14 条通过。
  设计过程中**没有**新增偏离 —— Complexity Tracking 的五条全部在 Phase 0 就已识别。
- **`/speckit-analyze` 的结果（2026-09-11）**：0 CRITICAL、2 HIGH、3 MEDIUM、2 LOW；
  幽灵编号 0、模糊形容词 0、重复需求 0。已修六条：
  **A1**（`docs/protocol-parameters.md` 与 SC-003 的内在张力 → R-10 选 (a)，新增 T063）、
  **C1 + C2**（FR-033 自己写着"不能只靠人工核对"却只有人工核对；FR-002 一条断言都没有
  → 新增 T064，纯离线）、**C3**（FR-034 由既有 `no-cli-in-runtime` 覆盖，T060 标注）、
  **D1**（T012 由"按名单改"换成"脚本枚举 + 零残留断言"）、**D2**（去掉裸的"待定"）。
  **L1**（13/38 FR 在 tasks 里缺编号引用，语义已覆盖）由 **T001 的任务描述**承接，不另处理。

> **A1 值得单独记一句。** 它不是漏了一条判据，是**两条判据互相矛盾**：
> SC-003 要求全部生成物逐字节相同，而其中一项生成物按定义就会变。
> 这种张力如果留到实施时才撞上，最短路径是**把 SC-003 悄悄放宽** ——
> 而那恰好是本期最强的不回归判据。

## 分阶段交付建议

**范围 A 单独交付即有价值**：做完之后加一台观察/入口机是零成本，
加一台机器进拓扑不再需要重置。**建议先把 A 做完并验收，再开 B。**

范围 C 的实测会改动 Primary 的配置甚至重启节点 —— **动手前必须先问用户**。

## 当前环境

五台机器在线，链健康（7/7 节点、`normal/100%`、高度 890+），004 刚交付。
