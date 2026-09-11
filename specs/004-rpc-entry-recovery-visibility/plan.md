# Implementation Plan: RPC 入口可用性修复与「恢复能力」呈现

**Branch**: `004-rpc-entry-recovery-visibility` ｜ **Date**: 2026-09-11 ｜ **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/004-rpc-entry-recovery-visibility/spec.md`

---

## Summary

修两件 003 验收当天照出来、但因「002 运行时零改动」的自我约束而只记录未修的事：

- **范围 A**：代理容器的 Docker healthcheck **经由自己**去打 avalanchego 的综合健康位
  `/ext/health`。两个 Primary 全停时那个位返回 503，nginx 把 503 计为上游失败，
  `max_fails=1 fail_timeout=60s` 一次就关 60 秒，`proxy_next_upstream_tries 5`
  让一次探测毒遍五个上游，10 秒的探测间隔又短于 60 秒惩罚期 —— 于是
  **真实客户端流量也吃 502，而链好着**。
  **修法**：探测改成打一个由 nginx **自己应答**的位置，完全不碰上游。
  三个故障转移参数**一律不动** —— 它们是 002 实测后定的（research.md R-02）。

- **范围 B**：同一时刻面板报 `normal / 100%`（**这是对的**），但那一刻任何 L1 验证者
  一旦重启就再也回不来。**修法**：新增一个与三档健康度**正交**的维度「恢复能力」，
  判据是「在服务 P 链的 Primary 数 **< 2**」（不是 `= 0` —— 一个 Primary 只有 50%
  的 P 链权益，达不到 80% 门槛），并新增第六类异常 `recovery-blocked`。

**技术路径的骨架**：改两个生成器（nginx 配置 + compose）各几行、
在面板的纯函数层加**第三个**「在线」谓词与一个正交字段、加一批会变红的守卫。
**零新增依赖，`protocol.json` 零改动，节点容器不重启，不需要全链重置。**

---

## Technical Context

**Language/Version**：Node.js（仓库既有版本，`node:test` 内建测试运行器）；
nginx 配置由 JS 生成器渲染；无前端构建工具链（003 立的规矩，本期照办）

**Primary Dependencies**：**零新增**。既有 `viem`（发交易）、`ajv`（协议校验）、
`nginx:alpine`（代理镜像，不换）

**Storage**：N/A —— 面板无持久化（003 的 FR）；代理无状态

**Testing**：`node:test` 三层（单元 / 集成 / e2e），既有 600 个单元用例；
`npm run render:check` 生成物漂移核对；`npm run test:secrets` 秘密扫描；
`scripts/devnet-verify` 系统级检查

**Target Platform**：Linux（3 台 Ubuntu）+ Windows/WSL2（2 台）；
amd64 与 arm64 混合（003 已实证创世哈希跨架构一致）

**Project Type**：基础设施 + 只读观测面板。既有布局，不新增顶层目录

**Performance Goals**：
- 恢复能力的判定并入既有轮询，**不新增任何网络请求**（它从已采集的行派生）
- 代理健康探测由"一次打五个上游"变为"一次不打任何上游" —— 开销单调下降

**Constraints**：
- `protocol.json` / `configVersion` / 共识参数 / 节点标志 / 创世 **零改动**（FR-031）
- 节点容器 **不重启、不重建**，只重建代理容器（FR-032）
- `max_fails` / `fail_timeout` / `proxy_next_upstream` **零改动**（R-02）
- 三档健康度判据与 P1…P5 优先级 **零改动**（R-05）
- 对外精简视图字段集合 **逐字段不变**（R-07）

**Scale/Scope**：7 个节点 / 5 个故障边界 / 5 份面板；改动面预估
2 个生成器 + 1 个纯函数模块 + 1 个文案模块 + 1 个视图 + 若干守卫

---

## Constitution Check

*GATE：Phase 0 之前必须通过；Phase 1 设计后重查。* 宪法 v1.1.0，20 条全查。

| 条 | 标题 | 判定 | 依据 |
|---|---|---|---|
| 一 | 区块链优先原则 | ✅ | 本期只改**观测与入口健康判定**，链上行为零改动。范围 B 呈现的正是链的真实约束（P 链权益门槛） |
| 二 | 链上与链下必须明确分工 | ✅ | 全部在链下：nginx 配置、容器健康位、面板纯函数。无合约改动 |
| 三 | EVM 兼容性原则 | ✅ | 不触碰 EVM、不改 chainId / 创世 / 预编译 |
| 四 | 安全优先原则 | ✅ | **恢复能力不进对外精简视图**（R-07）—— 它描述拓扑层面的脆弱窗口，对外只提供攻击时机。守卫按"逐字段相同"断言（SC-011）。健康探测不引入任何新的对外端点（新位置只在容器内被访问，且不返回任何内部信息） |
| 五 | 区块链执行必须具有确定性 | ✅ | 不触碰执行路径。面板为只读（003 已有源码静态守卫禁 `sendTransaction` 出现在轮询路径） |
| 六 | 智能合约安全原则 | ✅ | 无合约改动 |
| 七 | 基础设施必须可复现 | ✅ | 所有落点都是**生成物**：nginx 配置由 `render-rpc-proxy.mjs`、compose 由 `render-compose.mjs`。改生成器不改生成物，由 `render:check` 漂移核对守着。两种形态（`local` / `lan`）同一处生成（FR-009） |
| 八 | 测试和验证优先 | ✅ | 每条 FR 都有对应判据；**每条新守卫都要做变红检查**（FR-027），结果记进 dod。契约 §8 列了 8 行变红核对表 |
| 九 | 可观测性原则 | ✅ | 本期核心即可观测性。新异常分类 `recovery-blocked` **带处置方向**（与既有五类同形），机器可读枚举而非自由文本 |
| 十 | API 与协议必须明确 | ✅ | 两份契约：[proxy-health](./contracts/proxy-health.md)、[recovery-capability](./contracts/recovery-capability.md)。面板 API 的既有四个端点形状不变，快照新增字段为**附加**（不改已有字段语义） |
| 十一 | 严格进行模块职责划分 | ✅ | 判据（纯函数）与呈现（视图/文案）分离，沿用 003 的分层。代理健康位只回答"代理自己"，"链能不能用"留给面板与 `devnet-verify` —— **本期的整个范围 A 就是一次职责划分的纠正** |
| 十二 | AI 辅助开发治理原则 | ✅ | 全程 Spec Kit；research 逐条记决策与被否方案；两处**规格措辞问题**（FR-002 后半句、FR-017）显式提出交人拍板，**不静悄悄改小 FR** |
| 十三 | 依赖和技术选型原则 | ✅ | **零新增依赖**。R-01 刻意选了不需要 busybox `wget --post-data` 的方案 |
| 十四 | 文档与架构决策必须可追踪 | ⚠️ 见下 | 需要一份 ADR 记「代理健康位只回答代理自己」这个决定与被否方案 |
| 十五 | 协议变更控制原则 | ⚠️ 见下 | 本期**声明**不构成协议变更，但必须逐项核验而非推断 |
| 十六 | 协议配置必须有唯一事实来源 | ✅ | 地址 / 端口 / 上游列表 / 别名一律仍从 `protocol.json` 派生。新增的健康探测位置是**实现细节**，硬编码在生成器里 —— 与既有 healthcheck 取值同一处，**不往协议文件里加字段**（加了就会递增 `configVersion`，见第十五条） |
| 十七 | Definition of Done | ✅ | dod 清单在 tasks 阶段建，八项逐条核 |
| 十八 | 宪法治理规则 | ✅ | 无偏离需要豁免 |
| 十九 | 修改 Constitution 的规则 | ✅ | 本期不修改宪法 |
| 二十 | 版本 | ✅ | v1.1.0，无需变更 |

### Gate 三查

**查一：这是协议变更吗？（第十五条）**

**声明**：不是。healthcheck 的取值与 nginx 位置都硬编码在生成器里，
**不在 `blockchain/protocol.json`**，因此不递增 `configVersion`、不触发 stamp 守卫、
**不需要全链重置**。

**但这条必须核验，不能当成已知结论**：

- 已做的静态核对：`grep health blockchain/protocol.json` 无命中；
  `render-compose.mjs:208` 的 healthcheck 字符串为字面量
- 待做的核验：**SC-008** —— 改完之后 `git diff blockchain/protocol.json` 必须为空、
  `configVersion` 未递增、创世哈希不变、无节点因 stamp 退出 12
- **禁止的实现路径**：把探测位置或探测间隔"规范化"到 `protocol.json` 里。
  那样做会让本期从"零风险改动"变成"全链重置" —— 七个节点退出 12。
  这条要写进 tasks 的显式禁止项

> 搞错的代价是五台机器全链重置。**"推得出"不等于"验过"** ——
> 这个项目在 2026-09-10 一天之内证明过两次。

**查二：有没有新增依赖？（第十三条）**

没有。R-01 在方案选择时就把"需要 busybox `wget --post-data`"当作否掉 POST 方案的
三条理由之一 —— 不是事后发现，是选之前就算进去了。

**查三：判据会变红吗？（第八条）**

这是本期最该被怀疑的一处，因为**范围 A 的修法本身就是"让判据少看一些东西"** ——
从"看链的健康位"变成"只看自己"。少看东西的判据天然更容易变成永远绿。

- 契约 §2 的 **C-4** 与 **V-02** 专门管这件事
- 但 V-02 的**具体判据取决于 R-03 那个待拍板的措辞问题**：
  若按 (a)，V-02 验的是"nginx 死了/配置坏了会红"；若按 (b)，还要验"转发坏了会红"
- **在人拍板之前不写这条测试** —— 先写一个判据不明的测试，比暂时没有测试更坏

### 需要处理的两条 ⚠️

| 条 | 缺什么 | 怎么补 |
|---|---|---|
| 十四 | 一份 ADR | `docs/adr/0011-proxy-health-answers-only-for-itself.md` —— 记「代理健康位只回答代理自己」这个决定、四条被否方案（POST `eth_chainId` / 删 `http_503` / 拉长间隔 / 直接删掉 healthcheck）、以及"`zone` 这个正确修复放大了另一个缺陷"这条观察。进 `docs/adr/README.md` 索引 |
| 十五 | 逐项核验 | 见「查一」的待做清单；SC-008 + tasks 里的显式禁止项 |

---

## Project Structure

### Documentation (this feature)

```text
specs/004-rpc-entry-recovery-visibility/
├── plan.md                            # 本文件
├── spec.md                            # 4 个用户故事 · 33 条 FR · 12 条 SC
├── research.md                        # Phase 0：R-01…R-08 + V-01…V-10
├── data-model.md                      # 三个「在线」谓词并排 + 三个实体
├── contracts/
│   ├── proxy-health.md                # 范围 A 的契约（含待拍板的 §5）
│   └── recovery-capability.md         # 范围 B 的契约（含变红核对表）
├── quickstart.md                       # 13 个验收场景 A–M
├── checklists/
│   └── requirements.md                # 规格质量核对（已通过）
└── tasks.md                            # Phase 2（/speckit-tasks 生成，本命令不建）
```

### Source Code (repository root)

**全部落在既有文件与既有目录里** —— 不新增顶层目录，不新增子系统。
（用户全局偏好：优先改既有文件，不轻易新建。）

```text
tools/protocol/
├── render-rpc-proxy.mjs        # 改：加一个由 nginx 自己应答的位置
└── render-compose.mjs          # 改：代理 healthcheck 那一行换目标（六份 compose 的来源）

tools/dashboard/
├── snapshot.mjs                # 改：加第三个谓词 servesPChain + 恢复能力字段 + 第六类异常
├── public/copy.mjs             # 改：恢复能力的文案（纯函数、零 import）
└── public/view-*.mjs           # 改：呈现恢复能力（版式与停摆报警可区分）

blockchain/nodes/{local,lan}/rpc-proxy.conf     # 生成物 —— 不手改
docker/compose/{local-local,lan-*}.yml          # 生成物 —— 不手改（六份）

tests/unit/
├── proxy-health-boundaries.test.mjs   # 新：静态禁 /ext/health（剥注释后扫）
├── recovery-capability.test.mjs        # 新：真值表 10 行 + 门槛 < 2
├── recovery-tier-isolation.test.mjs    # 新：blocked 时档位逐字段不变
├── recovery-copy.test.mjs              # 新：必含「两个」、禁含「需要重置」
├── recovery-docs-parity.test.mjs       # 新：与 docs/devnet.md §9.5 一致
└── dashboard-public-view.test.mjs      # 改：改成"逐字段相同"断言

tests/integration/
└── proxy-health.test.mjs               # 新：探测不产生上游失败计数

tests/e2e/
├── proxy-entry-availability.test.mjs   # 新：综合健康位不健康时入口仍可用
└── recovery-capability.test.mjs         # 新：出现 / 只停一个仍在 / 恢复后消失

docs/
├── adr/0011-proxy-health-answers-only-for-itself.md   # 新（第十四条）
├── adr/README.md                                       # 改：索引
└── devnet.md                                           # 改：§10 面板加恢复能力一节；部署步骤说明"不需要重置链"（FR-033）
```

**Structure Decision**：沿用 003 的分层 —— **判据是纯函数、呈现是视图、
两者分离且各有守卫**。范围 A 落在生成器层（`tools/protocol/`），
范围 B 落在面板的纯函数层与视图层（`tools/dashboard/`）。
两个范围**没有共享代码**，因此可以按 spec 的 US1 / US2 各自独立交付与验收。

---

## Complexity Tracking

| 偏离 | 为什么需要 | 更简单的方案为何被否 |
|---|---|---|
| **第三个「在线」谓词** `servesPChain` | `participatesInConsensus` 对任何 Primary 恒返回 `false`（它第一行就 `if (!countsTowardTolerance) return false`），拿它数 Primary 会让提示**永远亮着** | 「复用既有谓词」是最简单的方案，但它给出的是一个恒定错误答案。这也是规格 FR-017 措辞需要修正的原因（data-model §0） |
| **恢复能力不进档位枚举，另立正交字段 + 第六类异常** | 档位五态互斥、靠严格优先级判定；而链可以「正常出块 + 无法恢复」也可以「已停止 + 无法恢复」，两条信息必须能同时呈现 | 「加成第六档」更简单，但会丢掉一半信息 —— 而丢掉的恰好是最要紧的那个组合（看起来完全健康却无法自愈） |
| **门槛写常量 `2` 而不是按权益算** | 判据要用能直接观测、直接断言、直接告诉人的东西；80% 是 avalanchego 的内部门控参数，不在 `protocol.json` 里 | 「按权益算」更通用，但引入一个我们控制不了、也没有事实来源的隐含依赖。代价是拓扑变化时这个常量会失效 —— 已在 data-model §2 写明注释，并明确留给"增加 Primary 节点数"那个特性 |
| **两处规格措辞问题不自行改小 FR** | FR-002 后半句与 FR-003 在同一个探测里结构性冲突；FR-017 字面不可实现 | 「按自己的理解实现，事后说明」更快，但那就是悄悄改小验收标准。两条都写进 research / 契约并标"待人拍板" |

---

## Phase 结果

- **Phase 0（研究）**：[research.md](./research.md) —— R-01…R-08 决策 + 被否方案 + V-01…V-10 待实测项。
  **零个 NEEDS CLARIFICATION**，但有**两个待人拍板的规格措辞问题**（R-03、R-04）。
- **Phase 1（设计与契约）**：[data-model.md](./data-model.md)、
  [contracts/](./contracts/)、[quickstart.md](./quickstart.md)。
- **Phase 1 后重查宪法**：第十四条（ADR）与第十五条（逐项核验）已列为必办项，
  其余 18 条通过。设计过程中**没有**新增偏离 —— Complexity Tracking 的四条
  全部在 Phase 0 就已识别。

## 当前环境状态

2026-09-11：win-1 的 Docker Desktop 已停；从 win-1 到
`192.168.1.13 / .21 / .22 / .23` 四台**全部 ping 不通**（win-1 自己的网卡 Up、
仍持 `192.168.1.3`）。**从单一视角分辨不出"那四台关了"与"win-1 掉链路了"** ——
这正是 003 要有 `observer-blind` 那一档的现场。

V-01…V-10 全部需要链在线，要等环境回来。**代码与守卫可以先写**（它们跑在
单元层与 `local` 形态），但**不得把"测试全绿"当成"缺陷已修"** ——
范围 A 的缺陷当初能活下来，正是因为它只在跨机形态下、只在两个 Primary 全停时才显形。
