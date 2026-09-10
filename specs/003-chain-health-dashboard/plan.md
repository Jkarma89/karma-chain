# Implementation Plan: 链状态与验证者网络实时监控面板

**Branch**: `003-chain-health-dashboard` | **Date**: 2026-09-09 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/003-chain-health-dashboard/spec.md`

## Summary

把"链现在什么状态"从**人主动去某台机器上跑一次命令得到的快照**，变成**常驻、自动刷新、判据可信的视图**。

技术路径：在观察者机器上以既有 `karmachain/verify:local` 容器运行一个**只读**的小型 HTTP 服务，它原样复用 002 已实现的状态判据（`classify` / `summarize` / `probeNode` / `deriveTopology`）轮询 7 个节点，对外提供快照 JSON；浏览器加载一个零构建静态页渲染它。

**Phase 0 的三条关键取证决定了整个形态**：

1. **判据不必重写，只需补层。** 读过 `tools/inspect/node-status.mjs` 才发现，规格里 11 条 FR 已由 002 的代码实现，且实现里带着当初的实测理由 —— 包括最难的那条（`unreachable` 的双重含义与"不计入离线"）。003 真正要写的是既有代码**没有**的九层（研究 R-05），其中两层修的正是既有代码在孤立使用时会给出的**错误结论**：观察者本机断网会让 `summarize()` 输出「链已停止出块」（假红灯，FR-020 禁止），5 个节点同时引导中会让它输出「100% 正常」（假绿灯，FR-017 禁止）。
2. **面板端口绝不能进 `protocol.json`。** 项目约定是"任何字段变更须递增 `configVersion`"，而 `configVersion` 在出生证明的六项比对之列 —— 加一个字段就等于**五台机器全链重置、748 个区块历史全丢**。端口走环境变量，默认 21680（实测在 Windows 动态端口范围与排除区间之外）。
3. **浏览器其实可以直连，但仍然选服务端采集。** avalanchego 自己就发 `Access-Control-Allow-Origin: *` 并正确响应预检（实测）。选服务端不是因为 CORS，而是因为判据复用（FR-004）与探活交易的密钥处置 —— 理由与否决的替代方案见研究 R-01。

**代价清单**：新增 npm 依赖 **0**；改动 002 的运行时制品 **0**（不碰 protocol.json、不碰 rpc-proxy.conf、不碰节点标志、不碰 compose、不碰 Dockerfile）；对 002 代码的改动 **2 处，均为追加**（给 `probeNode` 加创世哈希字段；给 `readContainers()` 加 `export`。研究 R-07）。

## Technical Context

**Language/Version**: Node.js ≥ 22.12.0（面板服务与判定层，`package.json` 已声明，容器内即此版本）；浏览器端 ES2022 模块（无转译）；Bash + PowerShell（入口脚本，沿用 002 的成对惯例）

**Primary Dependencies**: **零新增**。服务端用 `node:http` / `node:fs` / `node:path` 内建模块 + 既有 `viem`（仅用于人工探活交易）；复用既有 `tools/inspect/node-status.mjs` 与 `tools/protocol/load.mjs`；运行载体为既有 `karmachain/verify:local` 镜像。浏览器端无框架、无打包器、**无 CDN**

**Storage**: **无持久化**。快照只存在于服务进程内存（当前一轮 + 上一轮的高度，用于追赶速率）。状态变化时间线亦仅在内存与页面会话内，进程退出即消失 —— 规格已把"长期指标存储与趋势图"排除在范围外

**Testing**: `node --test`。单元测试覆盖可纯函数化的判定层（观察者失明、启动中、档位、边界余量、异常分类、公开投影）**以及档位文案的必含/禁止短语** —— 后者是 `/speckit-analyze` 补上的缺口：FR-008 / FR-020 / SC-006 的判据本质是"文案里不得出现某些话"，这类要求不会自己报错，必须把文案抽成纯模块才测得到。另有三条**静态边界守卫**（禁 `/ext/health`、禁 `child_process`/`docker`、禁阈值字面量），每条都自带反向用例证明它会变红。集成测试覆盖四个端点；e2e 覆盖 ≤10 秒发现时延、档位跃迁与实际交易可确认性的一致性。既有 271 项单元、14 项 `devnet-verify`、33 项 e2e 不得回归

**Target Platform**: 面板服务运行于 Linux 容器（既有验证镜像）；宿主为 Windows 10+（Docker Desktop）× 2 与 Ubuntu 22.04（Docker Engine，其中两台 arm64）× 3；浏览器为观察者机器上的现代浏览器，经 `localhost:21680` 访问

**Project Type**: 观测工具 —— 链的**只读**旁观者。不参与共识、不持有链数据、不在崩溃恢复路径上（与既有 `verify` / `render` 工具容器同类）

**Performance Goals**: 从验证者不再参与 L1 出块到面板改变显示 ≤ **10 秒**（FR-018）。预算依据（实测）：一轮 7 节点并行探测 64–142 ms，单个不可达节点因 4 秒探测超时最多把一轮拖到约 4 秒；取轮询间隔 2 秒 → 最坏约 6 秒，余量 4 秒。由此得硬上限：**间隔 ≤ 6 秒**，须由测试守住

**Constraints**: 不得改动共识参数、创世、节点运行时标志或 002 的任何运行时行为（FR-029）；核心判据不得依赖 docker 访问（FR-030）；不得引入唯一观察点（FR-031）；自动路径不得写链（FR-033）；档位阈值不得写死（FR-006）；公开投影不得含内部事实（FR-027）

**Scale/Scope**: 7 个节点 / 5 个故障边界 / 5 台机器；单页面；两个数据端点（完整 + 公开投影）+ 一个人工触发端点；预期同时观察者数量为个位数（局域网自用，无鉴权 —— 访问控制由网络边界承担）

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 条 | 要求 | 本计划如何满足 | 结果 |
|---|---|---|---|
| 一 区块链优先 | 共识状态只由链定义 | 面板是纯派生视图，无任何链状态副本、无持久化、无影子记账。唯一写链路径是人工触发的探活交易，走标准 RPC + 签名交易 | ✅ |
| 二 链上/链下分工 | 每功能标注 | 全部链下。链上：零改动。同步方式：只读 Info API / JSON-RPC（`info.getNodeID`、`info.peers`、`info.isBootstrapped`、`eth_blockNumber`、`eth_getBlockByNumber`） | ✅ |
| 三 EVM 兼容 | 标准优先 | 不触碰 EVM 层；探活交易是标准 EVM 转账，用既有 viem | ✅ |
| 四 安全优先 | 无真实秘密入库；**涉及 Key Management 的修改必须做安全分析** | **不新增任何密钥**，但**新增一条密钥使用路径** —— 探活用既有 `blockchain/accounts/dev-accounts.json` 的公开测试密钥（v1.1.0 例外已覆盖），只在服务端使用，绝不出现在页面、快照 JSON、公开投影或日志里。第四条要求的安全分析由 **T032a** 产出（不能因为"只是改几行代码"就跳过）。面板无鉴权是显式决定（局域网自用），已写入规格的范围外条目 | ✅ |
| 五 确定性 | 共识代码确定性 | 不编写共识/VM 代码 | ✅（不适用） |
| 六 合约安全 | 成熟库、测试 | 不新增、不修改任何合约 | ✅（不适用） |
| 七 可复现 | Git → 环境 | 面板由仓库内代码 + 既有镜像启动，无手工配置；宿主唯一前置依赖仍是 Docker（研究 R-02 专门为此选择容器载体而非宿主 Node） | ✅ |
| 八 测试优先 | 先定义验证 | 纯判定层的单元判据（含档位真值表 13 行与"会变红吗"对照 9 条）、三条静态边界守卫、六项实现期验证（V-01…V-06）在实现前已定义；既有 271/14/33 不得回退 | ✅ |
| 九 可观测 | 日志/健康/分类，且**必须区分**故障类别 | **本特性即第九条的落地。** 逐节点运行/引导/高度/peers/边界可见；异常按四类分类（观测故障 / 单节点基础设施 / 同步落后 / 共识余量不足），因为这四类处置完全不同 | ✅ |
| 十 API 明确 | 接口契约 | `contracts/dashboard-api.md`（三个数据/动作端点 + 静态托管 + 快照结构 + 公开投影白名单）、`contracts/health-tier.md`（档位判定，含边界情形穷举与"不得如何"） | ✅ |
| 十一 模块边界 | 层次清晰 | 前端 → 面板服务 → RPC/Info API → 链，单向。前端**不**直连节点、**不**持有密钥、**不**做判定（只渲染）。前端内部再分一层：`app.mjs` 只做轮询/路由/装配，六个 `view-*.mjs` 各归一个用户故事 —— 这既让故事真的能并行，也阻止判定逻辑渗进呈现层。判定层依赖既有 `tools/`，不反向依赖 | ✅ |
| 十二 AI 治理 | 不臆测协议、记录不确定 | research.md 每条标注 [实测] 及取得方式；六项实现期验证清单显式列出；R-01 专门记录了"CORS 可行但仍不选浏览器直连"这一反直觉取舍的真实理由，避免日后被误读为技术限制 | ✅ |
| 十三 依赖选型 | 成熟稳定、有理由 | **零新增依赖**。显式否决 React/Vue（体量与价值不匹配且需构建）、Tailwind CDN（外网依赖 + 供应链面）、打包器（仓库无前端工具链，会新增产物一致性问题） | ✅ |
| 十四 决策可追踪 | ADR + 参数记录 | 新增 1 条 ADR：面板作为只读旁观者的架构位置与"为何不进 protocol.json / 不走 nginx / 不引前端框架"。ADR 中「validator decentralisation path」已由 002 关闭，本特性不重开 | ✅ |
| 十五 协议变更控制 | Spec→兼容→迁移→回归→Review | **不构成协议变更**：不改 Genesis / Chain ID / Gas / 出块 / 交易校验 / 状态转换 / 验证者行为 / VM / 共识 / 预编译 / RPC 语义。**且刻意不改 `protocol.json`**——研究 R-03 论证了改它会触发 stamp 拒绝启动、代价是全链重置 | ✅ |
| 十六 唯一事实来源 | 参数单点 | 拓扑、地址、端口、验证者数、容错上限全部经 `deriveTopology` / `faultTolerance` 从 `blockchain/protocol.json` 派生，面板内零硬编码。面板监听端口**不是协议参数**（链上与跨组件契约都不依赖它），与既有 `KARMACHAIN_CONTAINER_RPC_PORT` / `KARMACHAIN_ADDRESS_OVERRIDE` 同类，走环境变量 | ✅ |
| 十七 DoD | 全项 | tasks 阶段按 DoD 组织；六个用户故事各有独立验收边界，US1 可单独交付 | ✅ |

**Gate 结论（Phase 0 前）**：通过，无违规。

**Gate 复查（Phase 1 后）**：通过。设计阶段新增三处需登记的复杂度（对 `node-status.mjs` 的两处追加改动、面板端口游离于 protocol.json 之外、面板无鉴权），均已在 Complexity Tracking 中附理由与守卫。**没有**新增依赖、**没有**改动任何 002 运行时制品，因此第七、十三、十五条的风险面小于 002。

**Gate 三查（2026-09-10，`/speckit-analyze` 之后）**：通过。该轮查出 1 项 CRITICAL —— **第四条**要求"任何涉及 Key Management 的修改都必须进行安全分析"，而本特性虽不新增密钥却新增了一条密钥使用路径（探活读私钥并签名），原先无任何任务产出该分析。已补 **T032a**，产物为 `security-probe-tx.md`，结论回写第四条那一行。同轮还补齐了三处"不会变红的守卫"：FR-013 的唯一守卫会在跨机形态下跳过（补 T013a 静态守卫）、FR-008/FR-020 的文案判据只有实现没有测试（补 `copy.mjs` + T026a）、FR-030/FR-032 零守卫（并入 T013a）。

## Project Structure

### Documentation (this feature)

```text
specs/003-chain-health-dashboard/
├── spec.md                     # 规格（37 条 FR / 21 条 SC / 6 个用户故事）
├── plan.md                     # 本文件
├── research.md                 # Phase 0：R-01…R-11 + 取证基线 + V-01…V-06
├── data-model.md               # Phase 1：快照、节点观测、观察者视角、档位、异常分类
├── quickstart.md               # Phase 1：怎么起、怎么验、10 个验证场景（A–J）的手工做法
├── contracts/
│   ├── dashboard-api.md        # 四个端点 + 快照结构 + 公开投影白名单
│   └── health-tier.md          # 档位判定契约（含边界情形穷举与"不得如何"）
├── security-probe-tx.md        # 宪法第四条要求的安全分析（由 T032a 产出）
├── checklists/
│   └── requirements.md         # 规格质量核对（16/16）
└── tasks.md                    # Phase 2 输出（/speckit-tasks 生成，本命令不创建）
```

### Source Code (repository root)

```text
tools/
├── dashboard/                          # 新增
│   ├── server.mjs                      # node:http 服务：静态托管 + 三个端点。无框架
│   ├── poll.mjs                        # pollOnce()：一轮探测 + classify，无采样休眠（R-06）
│   ├── snapshot.mjs                    # 纯函数：L1 观察者失明、L2 启动中、L3 三档、
│   │                                   #   L4 边界余量、L6 异常分类、L7 新鲜度
│   ├── public-view.mjs                 # 纯函数：L8 公开投影（显式字段白名单，R-10）
│   ├── probe-tx.mjs                    # L9 人工探活：viem 发一笔，复用 verify 的 transfer 判据
│   └── public/                         # 零构建静态页（R-08）
│       ├── index.html
│       ├── style.css                   # 档位配色 + 显目性（不依赖颜色单通道）
│       ├── copy.mjs                    # 纯函数：全部档位/状态文案。零 import，Node 与浏览器共用
│       ├── app.mjs                     # 只做轮询、按 ?view= 路由、装配 DOM —— 不渲染任何具体视图
│       ├── view-health.mjs             # US1：百分比、档位、两个余量、新鲜度、探活按钮
│       ├── view-nodes.mjs              # US2：节点表、Primary 分组
│       ├── view-observer.mjs           # US3：本机视角不可达、失去观测能力、说法不一致、启动中
│       ├── view-domains.mjs            # US4：边界视图、两个余量的成因、异常四类
│       ├── view-identity.mjs           # US5：链身份、分叉警报
│       └── view-public.mjs             # US6：?view=public 精简渲染
├── inspect/
│   └── node-status.mjs                 # 改 2 处（追加）：probeNode 加 genesisHash；readContainers 加 export
└── protocol/load.mjs                   # 不改，直接复用

scripts/
├── devnet-dashboard.sh                 # 新增：docker run 既有 verify 镜像，-p 21680
└── devnet-dashboard.ps1                # 新增：同上（.sh/.ps1 成对，受既有守卫约束）

tests/
├── unit/
│   ├── dashboard-tier.test.mjs         # L1…L3：档位真值表 13 行 + 9 条"会变红吗"对照
│   ├── dashboard-domain-margin.test.mjs # L4：边界余量 5 行表（须用 effectiveDomains）
│   ├── dashboard-incident-class.test.mjs # L6：五类映射，无未分类取值
│   ├── dashboard-copy.test.mjs         # 文案的必含/禁止短语（FR-008/FR-020/SC-006）
│   ├── dashboard-no-hardcode.test.mjs  # 禁 75/0.75/80/60/5 字面量（FR-006）
│   ├── dashboard-boundaries.test.mjs   # 禁 /ext/health、child_process、docker（FR-013/030/032）
│   ├── dashboard-blindness.test.mjs    # P1 优于 P3、P2 不越 P1、pathAlive 不改档位
│   ├── dashboard-fork.test.mjs         # 分叉不改健康度；null ≠ false
│   ├── dashboard-public-view.test.mjs  # L8：结构断言 + 内容扫描 + **行为探针**（R-10）
│   └── node-status-genesis.test.mjs    # R-07 回归：两处追加改动不影响任何状态判定
├── integration/
│   ├── dashboard-server.test.mjs       # 端点、静态托管、新鲜度戳、间隔上限
│   ├── dashboard-probe.test.mjs        # POST /api/probe：结构、单飞、stopped 档、不泄密钥
│   ├── dashboard-nodes.test.mjs        # 节点/边界与 protocol.json 逐项一致；切 local 形态
│   └── dashboard-topology-parity.test.mjs # 与 devnet-topology 的判定一致
└── e2e/
    ├── dashboard-detection.test.mjs    # ≤10 秒发现 80%（SC-002/004/010）
    ├── dashboard-stopped-tier.test.mjs # 60% 已停止档（SC-003，跨机带说明跳过）
    ├── dashboard-idle.test.mjs         # 空闲不出块不报警（SC-008）
    ├── dashboard-readonly.test.mjs     # 面板自身不产生区块（SC-017）
    ├── dashboard-link-fault.test.mjs   # 单链路故障（SC-005）
    ├── dashboard-primary-loss.test.mjs # 两 Primary 全停（SC-007，跨机带说明跳过）
    └── dashboard-genesis-parity.test.mjs # 五节点创世一致（SC-011）

docs/
├── devnet.md                           # 新增一节：面板的起法与六个故障场景的读法
└── adr/
    ├── README.md                       # 登记新 ADR
    └── 0010-readonly-observability-dashboard.md   # 新增
```

**Structure Decision**：沿用仓库既有布局，**不新建顶层目录**。判定与服务代码进 `tools/dashboard/`（与既有 `tools/inspect/`、`tools/verify/` 同级同性质：都是只读工具）；入口脚本进 `scripts/` 并保持 `.sh`/`.ps1` 成对；测试按既有三层分置。前端静态资源作为面板服务的一部分放在 `tools/dashboard/public/`，而非新建顶层 `frontend/` —— 它没有独立的构建、依赖或部署单元，独立目录只会造成"看起来是个独立应用"的错觉。

**依赖方向**（宪法第十一条）：

```text
public/app.mjs  ──HTTP──►  server.mjs  ──►  snapshot.mjs / public-view.mjs   （纯函数）
                                       ──►  poll.mjs  ──►  node-status.mjs   （既有）
                                                       ──►  load.mjs         （既有）
                                       ──►  probe-tx.mjs ──► viem            （既有）
```

单向。前端不直连节点、不持有密钥、不做任何判定。既有 `tools/` 不反向依赖 `tools/dashboard/`。

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| 改动 002 的 `tools/inspect/node-status.mjs`（两处追加：`probeNode` 增加 `genesisHash`；`readContainers()` 加 `export`） | FR-024/FR-025 的分叉检测没有别的原料来源：`probeNode` 当前不取创世哈希 | 面板另发一轮请求取创世哈希 → 「某节点的状态」与「该节点的创世哈希」会来自两个时刻的两次连接，链路抖动时可能一成一败，产生自相矛盾的展示。同一次探测取全部事实。守卫：新增回归断言"创世哈希缺失时不影响任何状态判定" |
| 面板监听端口游离于 `protocol.json` 之外（默认 21680，走环境变量） | 加进 protocol.json ⇒ 按项目约定须递增 `configVersion` ⇒ `configVersion` 在 stamp 六项比对之列 ⇒ 七个节点退出码 12 拒绝启动 ⇒ **五台机器全链重置**（研究 R-03） | 递增 configVersion 并重置全链 → 为一个 HTTP 端口丢弃 748 个区块的历史。它本非协议参数：链上与跨组件契约都不依赖它，既有先例是 `KARMACHAIN_CONTAINER_RPC_PORT` / `KARMACHAIN_ADDRESS_OVERRIDE` 两个同类运维参数 |
| 面板无鉴权 | 局域网自用，访问控制由网络边界承担；引入鉴权需要凭据管理，而仓库不得存放真实凭据（宪法第四条） | 加账号密码 → 要么把凭据写进仓库（第四条禁止），要么引入外部凭据管理（与"局域网自用一个只读面板"的规模完全不匹配）。已在规格的范围外条目中显式记录，并限定"不做公网暴露"。**风险面的完整分析由 T032a 产出**（无鉴权 + 一个会写链的端点是一个组合，不是两件独立的事） |
| **`pathAlive` 探测**（每轮对 5 个边界的已发布 RPC 端口各多发 1 个请求）在 spec 中无 FR/SC 溯源 | 它是**设计新增的机制**：`observer.blind` 为真时，面板在原理上无法区分"全网真停机"与"本机失去观测能力"（两者的网络表征完全相同）。没有它，面板在这一情形下只能说"我不知道"，给不出任何可指路的信息。nginx 代理与节点是不同的进程、不同的端口，节点全停而机器活着时代理会回 502/504 —— **一个 502 就足以证明路径通、机器活着** | 不做这个探测 → 0/7 可达时面板只能给出"可能 A 也可能 B"，运维得自己去逐台 ping。**刻意不为它补一条 FR**：它只改措辞、永不改档位（契约 health-tier 第 3 节的 P1 不受它影响），属实现手段而非需求；若日后它开始影响档位，那时才必须补 FR。守卫：T044 断言它不改变档位 |

**没有**登记为复杂度的三件事，说明理由以免日后被当成遗漏：

- **零新增依赖**：不构成复杂度，是本计划刻意的约束结果。
- **前端无框架**：不构成复杂度豁免请求 —— 页面的全部交互是轮询一个 JSON、渲染一张表、按档位换配色、一个按钮。
- **判定层与既有 `classify` 的分工**：既有代码判"单个节点是什么状态"，新增层判"整条链是什么档位"。两者不重叠，不是重复实现。若日后有人想把档位判定下沉进 `classify`，那会让 `devnet-status` 承担它不需要的职责 —— 分工的理由记在 `contracts/health-tier.md`。
