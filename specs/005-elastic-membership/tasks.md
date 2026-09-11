---

description: "任务清单：弹性成员管理 —— 在线增删节点，不重置链"
---

# Tasks: 弹性成员管理

**Input**: `specs/005-elastic-membership/` 的设计文档

**Prerequisites**: [plan.md](./plan.md) · [spec.md](./spec.md) · [research.md](./research.md) · [data-model.md](./data-model.md) · [contracts/](./contracts/) · [quickstart.md](./quickstart.md)

**Tests**: **包含**。规格明确要求（FR-032：每条新守卫都要做变红检查）。

**Organization**: 按用户故事分组。**范围 A（US1）是地基** —— 它单独交付即有价值，
且 US2/US3 建立在它的文件划分之上。

## Format: `[ID] [P?] [Story] Description`

- **[P]**：可并行（不同文件、不依赖未完成的任务）
- **[Story]**：所属用户故事（US1…US6）
- 每条都带确切文件路径

---

## ⛔ 本期的显式禁止项（实施前先读）

> 来自 [plan.md](./plan.md) 的 Gate 四查。这一期动的是**治理级**的东西，
> 违反任一条的后果都不是"测试变红"那么轻。

1. **不得把部署描述字段写回协议参数文件。** 一次切干净是已拍板的决定（FR-005）。
   守卫是 **T007**；**它自己也要做变红检查**（T016）。
2. **不得削弱 stamp 对真协议变更的保护。** 缩小保护范围之后**必须证明没缩过头** ——
   改一个 `chainId` 仍要让节点退出 12（契约 D-5 / T017）。
   **只做"部署变更不再拦"会得到一个什么都不拦的守卫。**
3. **新验证者的私钥必须在目标机器上生成，不得经仓库、聊天或任何中转传递。**
   只有公开材料（NodeID、证书公钥、BLS 公钥）参与注册（宪法第四条 / T030）。
4. **不得改 `deriveTopology()` 的输出形状。** 这是让 30 多个消费者一行不改的关键
   （research R-02）。守卫是 **T008**，变红检查是 T019。
5. **不得请回 Avalanche CLI 到运行时**（ADR-0008）。
6. **范围 C 的实测会改 Primary 配置甚至重启节点 —— 动手前必须先问用户**（T043）。
7. **不得为让新代码通过而放宽 002/003/004 的任何既有断言**（FR-031）。

---

## Phase 1: Setup

- [ ] T001 建 `specs/005-elastic-membership/checklists/dod.md`：宪法第十七条八项、
      16 条 SC 逐条、38 条 FR 的判据映射（004 的 analyze 教训：编号断链会让回填漏项）、
      两份契约的「会变红吗」核对表、V-01…V-18、实施期缺陷一节
- [X] T002 建 `specs/005-elastic-membership/baseline.md`，记下**分家之前**的：
      10 项生成物**逐个 sha256**、stamp 六项的当前值、`protocol.json` 的 sha256、
      以及**每台机器**本边界节点容器的 `Created` / `StartedAt`（逐台各记一份）

> **T002 必须先于一切改动。** SC-001 / SC-003 都是"与改动前比对"的判据 ——
> 事后再抓就只剩推断。004 的基线漏掉了第七份 compose，教训是
> **按文件全集枚举，不要按"要找的东西"去 grep**。

---

## Phase 2: Foundational（阻塞后续全部）

- [X] T003 归属表定稿：把 [data-model 第 0 节](./data-model.md) 的逐字段归属写成
      **可执行的清单**（生成器与守卫共用同一份），并对三个边界情形做出决定并记录理由：
      ① `avalanche.*Version`（倾向留在协议侧）② `endpoints.rpcPath`（倾向移出 + 一致性守卫）
      ③ `validators.count`（降级为期望成员数）；
      并确认 [R-10](./research.md) 的决定：`docs/protocol-parameters.md` **文档两个文件**、
      保持逐字节相同（`/speckit-analyze` 的 A1）
- [ ] T004 ABI 取得途径定稿（research R-03 三选一），并写明版本锁定方式 ——
      ABI 必须与 `avalancheCliVersion`（当前 v1.9.6）对得上，且有守卫防止两者漂移
- [X] T005 `f(n)` 通用化：把容错推导从"按当前 n 写死"改为对任意 n 正确，
      落在 `tools/protocol/load.mjs` 的 `faultTolerance`
- [X] T006 [P] `tests/unit/fault-tolerance-range.test.mjs`：`f(n)` 对 **n = 4…12 逐格**断言
      （[data-model 第 3 节](./data-model.md) 那张表的机械转录）

> T005/T006 放在 Foundational 而不是 US5，因为 US2/US3/US5 都要用它。
> **逐格写而不是只测两个代表** —— 003 的契约第 4b 节记着一次错误外推
> （从 n=5 推 n=9 推错了），而那次错误恰好发生在没测的那一格。

---

## Phase 3: US1 — 加一台机器进拓扑，链一秒都不停 (Priority: P1)

**Goal**：部署描述与协议参数分家，改部署不再重置链。

**Independent Test**：往拓扑加一台**只跑代理 + 面板**的机器，
stamp 六项逐字节不变、无节点退出 12、既有节点容器未重启。不需要 US2 的任何改动。

### 守卫先行

- [X] T007 [P] [US1] `tests/unit/deployment-split.test.mjs`：按 T003 的归属表断言 ——
      协议参数文件**不含**任何部署字段，部署文件**不含**任何协议字段
- [X] T008 [P] [US1] `tests/unit/derive-topology-shape.test.mjs`：对同一份输入，
      `deriveTopology()` 的输出与分家前 `deepEqual`（形状锁）

### 实现

- [X] T009 [US1] 新建 `blockchain/deployment.json`（名称由 T003 定）与
      `blockchain/deployment.schema.json`；从 `blockchain/protocol.json` 与
      `blockchain/protocol.schema.json` **移出**部署字段（一次切干净，不留兼容）
- [X] T010 [US1] 改 `tools/protocol/load.mjs`：读两个文件；
      **`deriveTopology()` 的输出形状一个字段都不许变**

  **实施期缺陷 ①（漏掉审计接缝，由集成套件抓到）**：
  `validate-topology.mjs --protocol <path>` 的调用方递进来的是一份**合并视图**写成的
  单个文件，而我改完装载器后它仍按协议 schema 校验 → `/ must NOT have additional properties`。
  三条断言红在 `tests/integration/topology-cli.test.mjs`。
  **单元套件当时 816/816 全绿** —— 静态残留扫描（T012）看不见这类"整份文件经 CLI 传递"的接缝。
  修法：`loadProtocol()` 增一条审计接缝分支。

  **实施期缺陷 ②（修法自己差点埋一个不会变红的守卫）**：
  接缝的判定原先内嵌在 `if (isExplicitPath && carriesDeployment)` 里。
  变红检查时发现：**去掉 `isExplicitPath` 这一半，全套断言照旧全绿。**
  而那一半正是关键 —— 少了它，有人把 `topology` 写回 `blockchain/protocol.json` 时，
  装载器会把它当成"一份完整配置"而**静默跳过** `deployment.json`，
  两个文件的分家成为摆设。为此把判定提成 `isAuditSeam(path, doc)` 并补四条断言
  （四种组合逐一断言），两半各自都能变红。
  **教训：判定藏在表达式里，就等于没有判定。**
- [X] T011 [US1] 改 `docker/bootstrap/entrypoint.sh`：`jq` 从新文件读 topology
      （shell 侧唯一直接读原始字段的地方）
- [X] T012 [US1] **用脚本枚举**所有直接读旧路径（`protocol.topology` / `p.topology`）的文件
      并逐个改读新来源，最后断言**零残留**。
      *（`/speckit-analyze` 的 D1：research R-02 的清单结尾是"等"，**那不是穷举** ——
      按名单改一定会漏。把"数数"换成"扫描"。）*
- [X] T013 [US1] `npm run render` 重新生成，`npm run render:check` 必须 10/10

### 判据

- [X] T014 [US1] **quickstart 场景 A**：分家前后 10 项生成物**逐字节相同**
      （对着 T002 的 sha256 清单 `sha256sum -c`）—— **这是本期最强的不回归判据**
- [X] T015 [US1] quickstart 场景 B：`deriveTopology()` 输出 `deepEqual`

### 变红检查

- [X] T016 [US1] 变红 ①：把 `topology` 写回协议参数文件 → T007 必须失败
- [X] T017 [US1] 变红 ②（**不能只做 ①**）：改一个真正的协议参数（如 `chain.chainId`）
      → 节点**必须**退出 12（契约 D-5 / quickstart 场景 D）。**做完记得改回去**
- [X] T018 [US1] 变红 ③：在分家时顺手"优化"一行渲染输出 → T014 的 sha256 比对必须失败
- [X] T019 [US1] 变红 ④：改一个 `deriveTopology()` 的输出字段名 → T008 必须失败

> **T017 与 T016 同等重要。** T016 证明保护范围缩小了，
> T017 证明它**没有缩过头** —— 只做前者会得到一个什么都不拦的守卫。

- [X] T063 [US1] 改 `tools/protocol/render-docs.mjs`：读**两个**文件，
      使 `docs/protocol-parameters.md` 分家前后**逐字节相同**（[R-10](./research.md)）。
      它还维护着一份"每个字段都必须被文档化"的完整性清单 —— 那份清单要覆盖两个文件

  *（编号在后：本条与 T064 是 `/speckit-analyze` 补的，既有编号引用一律不动。）*

  **实施记录（2026-09-11）**：`render-docs.mjs` 第 38 行本来就走 `loadProtocol()`，
  而 `loadProtocol()` 现在读两个文件 —— 所以**代码一行没改**，
  `docs/protocol-parameters.md` 自动逐字节相同。这是"在装载层合并"这个选择的直接红利。

  **但发现一处真缺陷，刻意留到 Polish**：生成出的文档头部仍写着
  `GENERATED FROM blockchain/protocol.json` 与「唯一权威定义：`blockchain/protocol.json`」，
  而现在有一半字段（`topology` / `endpoints` / `primaryNetwork` / `validators.{count,nodes}`）
  **不在那个文件里**。照着文档去改 `topology` 的人会找不到字段。
  改它会让 `docs/protocol-parameters.md` 变字节，而 SC-003（生成物逐字节相同）
  是本期**最强的不回归判据** —— 在 US1 里为它开口子，等于把这期最有力的信号变钝。
  所以记为 **T065**，在 Polish 阶段单独改、单独审。

- [X] T064 [US1] `tests/unit/stamp-scope.test.mjs`：**守卫 stamp 的作用域** ——
      ① 从当前两个文件计算 stamp 六项，断言结果**只依赖协议参数侧**：
      改部署文件（含**它自己的版本号**）后六项的计算结果**逐字节不变**；
      ② 断言 `stamp_fields()` 的输入里**不含**部署文件的任何内容。
      **变红检查**：把部署文件的版本号加进 stamp 的输入 → 本守卫必须失败

  *（`/speckit-analyze` 的 C1 + C2：FR-033 自己写着「**不能只靠一次人工核对**」，
  而原先唯一承接它的 T021 正是一次五台机器的人工现场核对；
  FR-002「部署版本号不进 stamp」此前**一条断言都没有** ——
  而"字段分离成立"与"版本号被排除在 stamp 外"是两件事，
  有人可能把部署版本号也加进 `stamp_fields()` 而字段分离仍然成立。
  这条守卫**纯离线**，不需要机器。）*

### 跨机与现场

- [X] T020 [US1] 扩 `scripts/devnet-start` 的 `warn_stale_mounts`：能报出
      "这台机器还在读旧格式"（FR-008 / quickstart 场景 F）
- [ ] T021 [US1] **quickstart 场景 E（需五台）**：往部署描述加一台机器并同步到五台，
      核 stamp 六项逐字节不变、**零个节点退出 12**、创世哈希不变、
      既有节点容器 `Created`/`StartedAt` **逐字符相同**（对着 T002 的基线逐台核）
- [ ] T022 [US1] 场景 E 的可用性一半：全过程每 30 秒一笔交易、连续 10 分钟，
      **全部确认、零次 5xx**（SC-002）

**Checkpoint**: US1 到此可**独立交付并验收** —— 加观察机零成本、加机器不再重置。
**建议在此停一次，验收通过再开 US2。**

---

## Phase 4: US2 — 在线加一个 L1 验证者 (Priority: P1)

**Goal**：一条命令把新节点注册进验证者集合，链不重置、既有节点不重启。

### 守卫先行

- [ ] T023 [P] [US2] `tests/unit/membership-preflight.test.mjs`：三条前置检查各一组用例 ——
      创世哈希不一致（FR-014）、T-5 越界（FR-013）、恢复能力不可用（FR-015）**都要拦下**
- [ ] T024 [P] [US2] `tests/unit/member-set.test.mjs`：读"链上实际成员"的解析，
      以及**三种漂移**各自的分类（[data-model 第 2 节](./data-model.md)）

### 实现

- [ ] T025 [US2] 新建 `tools/membership/abi/validator-manager.json`（按 T004 的途径取得并锁版本）
- [ ] T026 [US2] 新建 `tools/membership/member-set.mjs`：读链上实际成员；
      与"期望成员"比对并给出三种漂移的分类
- [ ] T027 [US2] 新建 `tools/membership/add-validator.mjs`：ACP-77 四步
      （合约 → Warp → P 链 → 合约确认），**每一步的失败可见、可重试、能报出停在哪一步**（FR-016）
- [ ] T028 [US2] 新建 `scripts/devnet-member.sh` 与 `.ps1` **两份等价实现**，
      退出码有语义，与既有 `scripts/devnet-*` 同形（FR-017）
- [ ] T029 [US2] 前置检查接进入口脚本：任一不过则**拦下且不动链**
- [ ] T030 [US2] 写明新验证者 staking 三件（证书 / 私钥 / BLS signer key）的生成与分发：
      **私钥在目标机器上生成、不离开那台机器**；只有公开材料参与注册（宪法第四条 / FR-019）

### 判据与变红

- [ ] T031 [US2] **quickstart 场景 N**：在 ACP-77 的**每一步**人为注入失败，
      四次都能报出"停在哪一步"并可重试；重试后最终成功（V-10）
- [ ] T032 [US2] 变红：去掉任一条前置检查 → T023 对应用例必须失败
- [ ] T033 [US2] **quickstart 场景 G（需两台）**：加入一个验证者 → 集合数 +1、
      既有节点未重启、stamp 六项不变；引导完成后面板参与共识数 +1
- [ ] T034 [US2] **quickstart 场景 H**：引导期间面板健康百分比**不高于**加入之前
      （名册变长不得让结论更乐观，V-07）

---

## Phase 5: US3 — 在线退一个验证者，且退之前先说清代价 (Priority: P1)

### 守卫先行

- [ ] T035 [P] [US3] `tests/unit/membership-removal.test.mjs`：
      ① `n: A → B` 与 `f(A) → f(B)` 的告知内容正确；
      ② `f` 下降时要求确认、拒绝确认时**零链上改动**（FR-011）；
      ③ 会跌破查询门槛的退出**被拦下**（FR-012）

### 实现

- [ ] T036 [US3] 新建 `tools/membership/remove-validator.mjs`：**优雅退出** ——
      先从集合移除 → 等确认 → 再停进程（顺序不能反，见契约第 4 节）
- [ ] T037 [US3] 加**紧急摘除**路径（机器已损坏/失联时用），
      并在文档里写明它与优雅退出的区别与代价（FR-018）
- [ ] T038 [US3] 退出的节点**不得**被面板报成故障节点 ——
      它是被主动移除的，处置完全不同（FR-028）

### 判据与变红

- [ ] T039 [US3] 变红：去掉"代价告知" → T035① 必须失败
- [ ] T040 [US3] 变红：去掉"跌破门槛拦截" → T035③ 必须失败
- [ ] T041 [US3] **quickstart 场景 I（需两台）**：退出一个验证者 → 集合数 −1、
      链持续出块、该节点不被报成故障
- [ ] T042 [US3] quickstart 场景 J：构造 n=8 执行退出 → 打印 `2 → 1` 并要求确认

**Checkpoint**: 到此"加与退"闭环，弹性的两个方向都有了。

---

## Phase 6: US4 — Primary 侧的弹性 (Priority: P2)

> ⚠️ **本阶段的实测会改 Primary 配置甚至重启节点 —— 动手前必须先问用户。**

- [ ] T043 [US4] **先拿四个数**（research R-07 / V-13…V-15）：
      ① 去掉 `partial-sync-primary-network` 后单节点的磁盘增量与稳定后带宽；
      ② 启动到 P 链引导完成的时间变化；③ 把 L1 验证者加入 P 链验证者集合的流程与耗时
- [ ] T044 [US4] 在 F-6（加到 ≥5 个 Primary）与 F-7（L1 验证者兼任 P 链验证者）之间
      **做出决定并记录被否方案与代价**（FR-020 / FR-021）。**在拿到 T043 之前不写实现**
- [ ] T045 [US4] 实施选定方案
- [ ] T046 [US4] 改 `tools/dashboard/snapshot.mjs`：004 那个写死的门槛常量改为
      **按实际权益分布判定**，保留原注释意图（数字来源是权益门槛而非"总数"）（FR-023）
- [ ] T047 [US4] **quickstart 场景 P（需五台）**：掉任意 1 个 P 链权益持有者时，
      一个被重启的 L1 验证者**仍能**完成引导并重新加入（**≤120 秒**，V-16 / SC-013）

---

## Phase 7: US5 — 成员变了，判据与呈现跟着变且仍然正确 (Priority: P2)

- [ ] T048 [P] [US5] `tests/unit/membership-presentation.test.mjs`：
      ① 门槛与两个余量对 n=4…12 正确（复用 T006 的表）；
      ② 引导中不计入参与共识（扩容与缩容时都成立，FR-026）；
      ③ 健康百分比不因名册变长而虚高（FR-027）
- [ ] T049 [US5] 面板**明确告知这次成员变化有没有改变容错**（FR-025）——
      n=5→6→7 时 f 都是 1，**不得**用"节点更多了"暗示更抗
- [ ] T050 [US5] 成员漂移（声明 vs 链上）在面板上**可见**，三种漂移各带处置方向（FR-030）；
      **扩既有的 `identity-mismatch` 那套形状，不新建一套**
- [ ] T051 [US5] T-5 越界**显目报出**，不静默通过（FR-029）
- [ ] T052 [US5] 变红：把加了节点就更抗的暗示放回文案 → T049 必须失败
- [ ] T053 [US5] 变红：让引导中的节点计入参与共识 → T048② 必须失败
- [ ] T054 [US5] 扩 `tests/unit/dashboard-views.test.mjs`：新增形态
      （n 变化中、成员漂移、T-5 越界）六视图都能 `render()` 而不抛

---

## Phase 8: US6 — 只加一台观察/入口机，零协议改动 (Priority: P3)

- [ ] T055 [US6] `docs/devnet.md` 写明：只跑代理 + 面板的机器**不需要**任何协议或拓扑改动，
      并说清为什么（代理改写 Host、面板用被访方地址）（FR-036 / F-8）
- [ ] T056 [US6] **quickstart 场景 Q**：在一台新机器上只起代理 + 面板，
      确认面板可用、经它的入口能确认交易，且 `git status` **干净**（SC-014）

---

## Phase 9: Polish & Cross-Cutting

- [ ] T057 [P] 建 `docs/adr/0012-deployment-is-not-protocol.md`（宪法第十四/十五/十六条）：
      划分判据（**一个问题**而非字段清单）、**三次不必要重置的历史**、
      与第十五条的关系（协议变更流程一字不改）、与第十六条的关系
      （成员事实来源移到链上为何不违宪）、以及被否方案。进 `docs/adr/README.md` 索引
- [ ] T058 [P] `docs/devnet.md`：**把两条流程分开写**（FR-038）——
      协议变更仍走宪法第十五条并重置；部署变更不递增 `configVersion`、不重置
- [ ] T059 [P] `docs/devnet.md`：扩容与缩容的完整规程，含 **`n → f` 那张表**
      与"哪些变化不会提高容错"（FR-037）
- [ ] T060 全套复跑：`npm test`（应 ≥736 且**无既有断言被放宽**）、
      `npm run test:integration`、`npm run test:e2e`、`npm run render:check`、
      `npm run test:secrets`、`scripts/devnet-verify`、
      `git diff --exit-code package.json package-lock.json`（**FR-035** 零新增依赖）；
      并确认 `tests/integration/no-cli-in-runtime.test.mjs` **保持通过**
      （**FR-034** 不请回 Avalanche CLI —— 既有守卫已覆盖，本期只需不打破它）
- [ ] T065 改 `tools/protocol/render-docs.mjs` 生成出的**出处声明与权威定义那两句**：
      现在只提 `protocol.json`，而一半字段已在 `deployment.json`（来自 T063 的实施记录）。
      **这是本期唯一一处刻意让生成物变字节的改动** —— 必须在 SC-003 的比对
      **通过之后**再做，并在提交信息里写明"此次生成物差异是有意的，且只差这两句"
- [ ] T066 `docker/lib/` 的三个死文件：`runtime.sh` / `nodes.sh` / `health.sh`
      **没有进任何镜像、也没有被任何脚本 source**（001 单容器时代的遗留，
      T012 枚举时查实）。`nodes.sh:72` 当时还在用 `proto_get` 取部署字段，
      已随手改成 `deploy_get` —— 但**一个没人执行的文件里的正确调用毫无价值**。
      本条只**记录并核实**这个判断，删除与否留给单独一次清理（不在 005 范围内：
      宪法要求删除既有制品走明示流程，而本期的承诺里没有这一项）

- [ ] T061 **quickstart 场景 R（SC-016）**：找一名**未参与本期**的人，
      只给他文档，让他把一台机器加成验证者。**卡住就改文档，不改判据**
- [ ] T062 回填 `checklists/dod.md`：16 条 SC、38 条 FR、两份契约的变红核对表、
      V-01…V-18 的实测数据、实施期缺陷一节。
      **凡未实测的一律不写"已达成"**；最后**不写"已交付"**

---

## Dependencies

```
T001 (dod)
  └─ T002 (基线) ─┐
                   ├─ T003 (归属表) ─→ Phase 3 (US1) ─→ Phase 4 (US2) ─→ Phase 5 (US3)
                   ├─ T004 (ABI 途径) ────────────────↗
                   └─ T005/T006 (f(n)) ─→ 被 US2 / US3 / US5 共用

Phase 6 (US4)：可与 US2/US3 并行，但**动手前要问用户**
Phase 7 (US5)：依赖 T005/T006；呈现侧改动依赖 US2/US3 产生的状态
Phase 8 (US6)：纯文档 + 一次现场，随时可做
Phase 9    ：T057–T059 [P] 随时可做；T060–T062 收尾

T063 / T064 属 Phase 3（US1），编号在后只是为了不动既有引用。
T064 纯离线，可与 T007/T008 并行。
```

**US1 是地基**：US2/US3 要往"期望成员"声明里写，而那个声明在 US1 之后才存在。

---

## Parallel Execution Examples

**Phase 2 起手**：T004（ABI 途径）与 T005/T006（`f(n)`）互不相干。

**Phase 3 起手**（两条守卫不同文件）：

```
T007  tests/unit/deployment-split.test.mjs
T008  tests/unit/derive-topology-shape.test.mjs
```

**Phase 9 的三份文档**：T057（ADR）、T058（两条流程）、T059（扩缩容规程）。

---

## Implementation Strategy

**MVP = US1 单独交付。** 做完之后：加一台观察/入口机是**零成本**，
加一台机器进拓扑**不再需要重置链** —— 这已经解决了用户原话里最痛的那一半
（「我不希望加节点会导致链重置」）。**建议在 Checkpoint 停一次，验收通过再开 US2。**

**US2 与 US3 是一对**，不要只交付其中一个：只能加不能退不叫弹性，
而"退"还牵涉到"缩容会降低容错"这件更容易出错的事。

**US4 最后做**，因为它要先拿四个实测数据，而那些实测会动 Primary 配置。

---

## 任务统计

| 阶段 | 任务数 | 其中变红检查 | 需要多台机器 |
|---|---|---|---|
| Phase 1 Setup | 2 | — | T002 逐台记 |
| Phase 2 Foundational | 4 | — | — |
| Phase 3 US1（P1） | **18** | **5** | T021 / T022（**五台**） |
| Phase 4 US2（P1） | 12 | 1 | T033 / T034（两台） |
| Phase 5 US3（P1） | 8 | 2 | T041（两台） |
| Phase 6 US4（P2） | 5 | — | T043 / T047（**五台**，先问用户） |
| Phase 7 US5（P2） | 7 | 2 | — |
| Phase 8 US6（P3） | 2 | — | 1 台新机 |
| Phase 9 Polish | 6 | — | T061（一名他人） |
| **合计** | **64** | **10** | **6** |
