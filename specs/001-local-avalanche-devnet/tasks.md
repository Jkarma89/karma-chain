# Tasks: 本地可复现的 Avalanche L1 开发网络

**Input**: Design documents from `/specs/001-local-avalanche-devnet/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: 包含测试任务 —— spec FR-022~029 与宪法第八条明确要求"先定义验证、实现+测试+验证才算完成"。

**Organization**: 按用户故事分组；Foundational 阶段承载 protocol.json / Docker 镜像 / Genesis 等所有故事共同依赖的地基（含 research.md 实现期验证清单 V-1~V-8 的尽早实测）。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行（不同文件、无未完成依赖）
- **[Story]**: 所属用户故事（US1~US5），仅用户故事阶段标注
- 每个任务附确切文件路径

## Path Conventions

单仓库基础设施项目，目录结构见 plan.md「Project Structure」；仓库根 = `F:\Blockchain\SRC\karma-chain`。

---

## Phase 1: Setup（项目初始化）

**Purpose**: 建立目录骨架与工具链，使后续任务有落点

- [x] T001 按 plan.md 结构创建目录骨架 `blockchain/{genesis,accounts,validators/dev}`、`docker/{devnet/{bin,lib},verify}`、`tools/{protocol,verify/{checks,lib,contracts}}`、`tests/{unit,integration,e2e}`、`scripts/`、`docs/adr/`，并创建 `.gitignore`（忽略 `.devnet/`、`node_modules/`、任何运行时链数据）与 `README.md` 占位
- [x] T002 初始化 `package.json`（type: module；依赖 viem@2.x、solc@0.8.36、ajv；scripts: `protocol:render`、`verify`、`test`、`test:secrets`）并提交 `package-lock.json`
- [x] T003 [P] 编写 `docker-compose.yml`（服务 `devnet`：命名卷 `karmachain-devnet-data`→`/root/.avalanche-cli`、端口 `${KARMACHAIN_RPC_PORT:-8545}:8545`、`sysctls: net.ipv6.conf.all.disable_ipv6=0`；服务 `verify`：profile 隔离、挂载 `tools/`+`tests/`）与 `.env.example`（`KARMACHAIN_RPC_PORT`、`KARMACHAIN_STARTUP_TIMEOUT` 说明，值注明"默认来自 blockchain/protocol.json"）

---

## Phase 2: Foundational（阻塞性地基 —— 完成前任何用户故事不得开始）

**Purpose**: 唯一事实来源、锁定版本的运行镜像、Genesis 流水线；并把 research.md 高风险验证项（V-1/V-2/V-3/V-4/V-5/V-6/V-8）在真实环境中打通

**⚠️ CRITICAL**: T011 冒烟验证是全计划最大风险集中点，其结论可能调整 T008/T018 的实现方式，必须最早暴露

- [x] T004 编写 `blockchain/protocol.json`：按 data-model.md 第 1 节全字段填值（chainId 20189、reservedMainnetChainId 20188、networkId 1337、KarmaCoin/KARMA/18、feeConfig 官方默认 8 字段、blockProduction on-demand、primaryNetwork.nodeCount 2、validators 5 节点含端口 9660-9669、devAccounts 6 项、endpoints 8545 + `/ext/bc/karmachain/rpc`）
- [x] T005 [P] 复制 `specs/001-local-avalanche-devnet/contracts/protocol-config.schema.json` 为运行时 schema `blockchain/protocol.schema.json`，并在 `tests/unit/schema-sync.test.mjs` 断言两文件逐字节一致
- [x] T006 实现 `tools/protocol/load.mjs`：ajv 校验 schema + data-model 约束（chainId≠reservedMainnetChainId、networkId∉{1,5}、count==nodes.length、端口互不冲突、devAccounts 地址唯一且 EIP-55、余额合计=初始供应）
- [x] T007 [P] 编写 `tests/unit/protocol.test.mjs`（node --test）：合法配置通过；上述每条约束的违例样本逐一失败并给出可读错误
- [x] T008 编写 `docker/devnet/Dockerfile`：`FROM avaplatform/avalanche-cli:v1.9.6`，下载 avalanchego v1.14.1 与 subnet-evm v0.8.0 官方发行包（amd64+arm64，sha256 固定写入 Dockerfile）预置到 `/root/.avalanche-cli/bin/{avalanchego/avalanchego-v1.14.1,subnet-evm/subnet-evm-v0.8.0}/`，安装 bash/jq/curl/socat（验证 research V-2：CLI 跳过下载）
- [x] T009 [P] 实现 `docker/devnet/lib/protocol.sh`：用 jq 从 `blockchain/protocol.json` 读取全部参数的函数（proto_chain_id、proto_ports…），容器内所有脚本只经此读取（FR-017）
- [x] T010 实现 `docker/devnet/lib/avalanche.sh`：封装全部 CLI 调用（`network start --num-nodes 2 --avalanchego-version v1.14.1`、`blockchain create --evm --genesis … --vm-version v0.8.0 --proof-of-authority --validator-manager-owner … --evm-token KARMA --force --skip-update-check`、`blockchain deploy --local --use-local-machine --num-bootstrap-validators 5 --http-port … --staking-port … --staking-*-key-path …`、`network stop/clean/status`）；本文件是 CLI 唯一调用点（plan Complexity Tracking）
- [x] T011 冒烟验证脚本 `docker/devnet/spike/bringup-test-defaults.sh`：在容器内用 `--test-defaults` 路线（暂不用自有 genesis）跑通 2+5 拓扑至 RPC 可用，逐项实测并把结果回填 `specs/001-local-avalanche-devnet/research.md` 验证清单（V-1 IPv6 sysctl 是否够、V-2 是否零下载、V-4 stop/start 快照是否恢复 L1 节点、V-5 create/deploy 全非交互所需标志组合、V-6 内存与启动耗时、V-8 http-host 可否配置→决定 socat 去留）；若结论与 plan 冲突，先更新 plan.md 再继续
- [x] T012 从 T011 环境提取 5 组验证者密钥到 `blockchain/validators/dev/node-{1..5}/{staker.crt,staker.key,signer.key}` + 每目录 `README.md`（DEVELOPMENT ONLY 警告 + NodeID 记录）；复跑确认 NodeID 确定性（V-3），失败则按 research 回退并记录
- [x] T013 实现 `tools/protocol/extract-vm-alloc.sh`：从 T011 的 CLI 参考创世提取全部带 `code` 的合约账户，写入 `blockchain/genesis/validator-manager.alloc.json`（含 extractedFrom 元数据）
- [x] T014 实现 `tools/protocol/render-genesis.mjs`（protocol.json + fixture → Subnet-EVM 创世，硬分叉块高 0、固定 timestamp/extraData 等常量保证哈希确定），运行 `npm run protocol:render` 生成并提交 `blockchain/genesis/karmachain.genesis.json`（文件头 `GENERATED FROM blockchain/protocol.json` 注释）
- [x] T015 [P] 编写 `tests/unit/genesis-render.test.mjs`：渲染幂等；输出与提交文件逐字节一致（漂移测试）；chainId/feeConfig/alloc 与 protocol.json 逐项对应；fixture 合约账户完整保留
- [x] T016 [P] 编写 `blockchain/accounts/dev-accounts.json`（ewoq + Foundry Anvil 默认账户 #0-#4，地址/私钥逐字核对 Foundry 官方文档并注明 source，V-7；顶部 warning 字段）与 `tests/unit/accounts.test.mjs`（与 protocol.json devAccounts 按 label 一致、私钥→地址推导正确）
- [x] T050 编写 `docker/verify/Dockerfile`（node:24-alpine + npm ci，挂载 `tools/` 与 `tests/`）并在 `docker-compose.yml` 接线 `verify` 服务（profile 隔离）；验收：`docker compose run --rm verify npm test` 能执行 Phase 2 全部单元测试（插入执行位置：T016 之后、Phase 3 之前；为 T021/T026/T030/T031/T037/T038/T041/T042 等所有容器内测试提供运行环境）

**Checkpoint**: protocol.json 可校验、devnet/verify 两镜像可构建、CLI 路线实测可行、创世可确定性生成 —— 用户故事可开始

---

## Phase 3: User Story 1 - 一键启动本地开发链 (Priority: P1) 🎯 MVP

**Goal**: 克隆仓库 → 一条命令 → 7 节点网络就绪，输出 RPC/链 ID/账户摘要；标准 EVM 工具可转账；可干净停止

**Independent Test**: quickstart 场景 A + B：干净机器 `scripts/devnet-start` → READY 摘要 → cast/MetaMask/viem 连接并完成转账 → `scripts/devnet-stop` 无残留

- [x] T017 [US1] 实现 `docker/devnet/lib/preflight.sh`：Docker 内存、宿主映射端口占用、容器内端口 9650/9660-9669 占用、二进制存在性检查；失败输出可操作信息并按 cli-interface.md 退出 10/11（FR-007）
- [x] T018 [US1] 实现 `docker/devnet/entrypoint.sh` 首次启动路径：preflight → `avalanche.sh` create（用提交的 `blockchain/genesis/karmachain.genesis.json`）→ deploy 5 验证者 → 确认别名 `karmachain` → 起 socat `0.0.0.0:8545→127.0.0.1:9660`（若 T011/V-8 证实可配 http-host 则改配置并删 socat）→ 打印 READY 摘要（cli-interface.md 格式，数值全部经 `protocol.sh` 读取，含 DEVELOPMENT ONLY 警告，FR-008/FR-023）；`trap SIGTERM` → `avalanche network stop` 保存快照后退出（FR-003 无残留）
- [x] T019 [US1] 在 entrypoint 增加幂等分支：网络已运行时报告"already running"并退出 0，不创建第二套节点（FR-006）
- [x] T020 [P] [US1] 编写宿主薄封装 `scripts/devnet-start.ps1`、`scripts/devnet-start.sh`、`scripts/devnet-stop.ps1`、`scripts/devnet-stop.sh`：仅检查 docker 可用 + 转调 compose + 透传退出码（cli-interface.md 契约，无业务逻辑）
- [x] T021 [US1] 编写 `tests/integration/start-stop.test.mjs`：对运行中网络断言 `eth_chainId==0x4edd`、`net_version/info.getNetworkID==1337`、ewoq→anvil-0 转账确认且回执 hash/blockNumber/status/gasUsed/from/to 正确、双方余额差符合金额+费用（FR-013/015）；stop 后宿主 8545 无监听
- [x] T022 [US1] 按 quickstart 场景 B 手工验证 MetaMask 与 Foundry cast（SC-004 三类工具、SC-006 ≤10s 确认），把实测结果与截图/输出记录到 `docs/devnet.md` 的"工具连接"章节草稿

**Checkpoint**: MVP 可演示 —— 启动、连接、转账、停止全链路可用

---

## Phase 4: User Story 2 - 任何人、任何时候重建得到相同的链 (Priority: P1)

**Goal**: 重置回创世、普通停启保状态、参数变更被检测、跨环境创世哈希一致

**Independent Test**: quickstart 场景 D：记录创世哈希 → stop/start 高度延续 → reset 后哈希不变高度归零；×10 重复一致

- [x] T023 [US2] 在 entrypoint 增加 stamp 机制：首次部署写 `/root/.avalanche-cli/karmachain.stamp.json`（configVersion/chainId/genesisSha256）；启动时不一致则拒绝并提示 reset，退出 12（FR-021，data-model 状态机）
- [x] T024 [P] [US2] 编写 `scripts/devnet-reset.ps1`、`scripts/devnet-reset.sh`（`docker compose down -v`，FR-004）
- [x] T025 [US2] 实现 entrypoint 恢复路径：卷中已有链数据且 stamp 一致时走 `avalanche network start`（快照恢复，含 5 个 L1 节点与别名/socat 重建），确保高度延续（FR-005；依据 T011/V-4 实测结论，必要时显式重连逻辑）
- [x] T026 [P] [US2] 编写 `tests/e2e/reset-recreate.test.mjs`：循环 10 次 reset→start→读 `eth_getBlockByNumber("0x0")` 哈希全等（SC-003）；并断言普通 stop→start 后高度 ≥ 停止前
- [x] T027 [US2] 在 `docs/devnet.md` 写"跨环境一致性核对"操作步骤（第二台机器/另一开发者对比创世哈希、链 ID、账户余额，SC-002），并在本仓库 CI 或第二环境实际执行一次、记录结果

**Checkpoint**: US1+US2 = 可复现的可用链

---

## Phase 5: User Story 3 - 协议参数有唯一出处且被完整记录 (Priority: P2)

**Goal**: 全部派生物由 protocol.json 生成，零硬编码可被机器证明，参数含取值理由

**Independent Test**: quickstart 场景 E：`npm test` 漂移/硬编码测试通过；改 chainId 演练走通"漂移失败→重渲→拒启→reset→新链"

- [x] T028 [P] [US3] 实现 `tools/protocol/render-docs.mjs` → 生成 `docs/protocol-parameters.md`（每参数：值 + 取值理由列，理由文案维护在 protocol.json 旁注文件 `blockchain/protocol-rationale.json` 或脚本内映射；文件头 GENERATED 标记；覆盖宪法第十四条参数清单）
- [x] T029 [P] [US3] 实现 `tools/protocol/render-compose-env.mjs` → `.devnet/compose.env`（hostRpcPort 等），`docker-compose.yml` 与 `scripts/*` 改为读取该文件而非内联默认值
- [x] T030 [US3] 编写 `tests/unit/docs-drift.test.mjs`（render-docs 输出与提交文件一致）与 `tests/unit/no-hardcode.test.mjs`（对仓库 git grep `20189|20188|1337|KARMA`，白名单仅 protocol.json、生成物、specs/、docs 引用处，其余命中即失败，SC-007）
- [x] T031 [US3] 编写 `tests/e2e/param-change.test.mjs` 自动化 quickstart 场景 E 演练：临时改 chainId→漂移测试失败→`npm run protocol:render`→start 退出 12→reset→start 后 `eth_chainId` 为新值→恢复原配置（验证 FR-018/019/021 闭环）

**Checkpoint**: 参数单点被测试强制，US3 可独立审查验收

---

## Phase 6: User Story 4 - 自动化验证 (Priority: P2)

**Goal**: 13 项检查、逐项 [OK]/[FAIL] 输出、JSON 报告、失败分类、≤3 分钟、可无人值守

**Independent Test**: quickstart 场景 C：健康网络全过退出 0；停网后 `[FAIL] rpc [category: rpc]` 退出 1

- [x] T032 [P] [US4] 实现 `tools/verify/lib/rpc.mjs`（viem client 按 protocol.json 构造）、`lib/avalanche-api.mjs`（/ext/health、info.peers、info.isBootstrapped）、`lib/report.mjs`（[OK] 行格式 + JSON 按 `contracts/verification-report.schema.json`）、`lib/categories.mjs`（FR-030 九类判据映射）
- [x] T033 [US4] 实现基础检查 `tools/verify/checks/{node,validator,rpc,network-id,chain-id,token,balance}.mjs`（7/7 节点健康、5/5 bootstrapped 且 peers≥4——精确阈值按 T011/V-10 实测写入 `tools/verify/lib/categories.mjs` 的派生常量、RPC 连通、1337、20189、KARMA/18、6 账户余额==创世——以 `eth_getBalance(addr,"0x0")` 为基准，latest 仅要求 ≤，因 ewoq 支付了 PoA 初始化 gas）
- [x] T034 [US4] 实现交易与合约检查 `tools/verify/checks/{transfer,receipt,block-production,contract,rpc-methods,protocol-consistency}.mjs`：转账+回执字段、发 2 笔交易观测高度 N→N+1→N+2（on-demand 模式）、`tools/verify/contracts/Counter.sol` 用 solc-js `evmVersion:"cancun"` 编译部署+increment+count 断言、FR-012 十方法逐一探测（不支持→unsupported 不算失败）、创世 sha256 与提交文件一致
- [x] T035 [US4] 实现编排器 `tools/verify/verify-network.mjs`：顺序执行 13 检查、汇总 READY/NOT READY、写 `./.devnet/verify-report.json`、退出码 0/1、总时长打印（SC-005 ≤3 分钟）
- [x] T036 [P] [US4] 编写 `scripts/devnet-verify.ps1`、`scripts/devnet-verify.sh` 薄封装（转调 `docker compose run --rm verify npm run verify`，退出码与输出契约见 cli-interface.md；容器与 compose 接线已由 T050 完成）
- [x] T037 [US4] 用真实运行结果回填 `specs/001-local-avalanche-devnet/contracts/rpc-endpoint.md` 十方法支持表（V-9，SC-010 零"未知"）；编写 `tests/integration/verify-negative.test.mjs`：停网后运行 verify，断言失败项类别正确（SC-011 一部分）
- [x] T038 [P] [US4] 编写 `tests/unit/report.test.mjs`：报告样本经 ajv 校验 `verification-report.schema.json`；fail 无 category 时校验必须失败

**Checkpoint**: "启动成功"从此由机器判定；回归基线就位

---

## Phase 7: User Story 5 - 可观测节点状态并诊断问题 (Priority: P3)

**Goal**: 按节点看状态与日志；故障能归类；单验证者宕机行为符合 research R-05 结论

**Independent Test**: quickstart 场景 F：status 显示 7 节点明细；端口占用退出 11 且指明端口；停 1 个 L1 节点网络仍出块且 status 报 4/5

- [ ] T039 [US5] 实现 `docker/devnet/lib/health.sh` 与 `docker/devnet/bin/devnet-status`（每节点 NodeID/角色/healthy/bootstrapped/peers，存在不健康节点退出 1）+ `scripts/devnet-status.ps1`、`scripts/devnet-status.sh`
- [ ] T040 [P] [US5] 实现 `docker/devnet/bin/devnet-logs`（按节点过滤、`-f` 跟随、含时间戳与级别）与 `docker/devnet/bin/devnet-node`（stop/start 单节点，供故障注入）+ `scripts/devnet-logs.ps1`、`scripts/devnet-logs.sh`（日志路径按 T011/V-10 实测结果）
- [ ] T041 [US5] 编写 `tests/e2e/failure-classification.test.mjs`：注入端口占用（预期退出 11 + 端口号）、stamp 不一致（退出 12）、停网 verify（category rpc）等场景，断言每种输出归入 FR-030 正确类别（SC-011）
- [ ] T042 [US5] 编写 `tests/e2e/single-validator-down.test.mjs`：`devnet-node stop l1-3` 后转账仍确认（5 节点容忍 1 离线，R-05）、`devnet-status` 报 4/5 且退出 1、verify validator 项 fail[category: validator]；恢复节点后全部转 OK
- [ ] T043 [US5] 审查启动输出与全部节点日志的秘密泄露面：确认私钥/助记词仅出现在明确标记文件，必要时在 entrypoint/摘要处脱敏（FR-026，为 T044 扫描提供保证）

**Checkpoint**: 全部 5 个故事独立可验

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: 安全扫描、文档、ADR、DoD 收口

- [ ] T044 [P] 编写 `tests/e2e/secret-scan.test.mjs`（npm run test:secrets）：对仓库与运行日志扫描私钥/助记词模式，白名单仅 `blockchain/accounts/dev-accounts.json` 与 `blockchain/validators/dev/**` 且要求其含 DEVELOPMENT ONLY 标记（FR-024、SC-009）
- [ ] T045 [P] 编写 `tests/e2e/vm-alloc-drift.test.sh`：容器内重跑 `tools/protocol/extract-vm-alloc.sh` 与提交的 fixture diff（CLI 版本漂移哨兵）
- [ ] T046 [P] 完成 `docs/devnet.md` 开发者手册：前置依赖、六命令、工具连接（MetaMask/cast/viem）、开发账户表、无交易不出块说明、按 FR-030 九类组织的排障章节、跨机部署不在范围声明（FR-033）
- [ ] T047 [P] 撰写 4 份 ADR：`docs/adr/0001-avalanche-l1-and-evm.md`、`0002-avalanche-cli-toolchain-and-versions.md`（含维护模式风险与迁移路径）、`0003-chain-identity-and-dev-security-boundary.md`（20189/20188、公开密钥安全边界、prod 分离）、`0004-five-validator-local-topology.md`（容错结论），格式满足宪法第十四条五要素（FR-034）
- [ ] T048 更新 `README.md`（指向 docs/devnet.md 与三步上手）；把 research.md 验证清单 V-1~V-10 的最终实测结论回填成"已确认/已回退"状态
- [ ] T049 端到端收口：完整执行 quickstart 场景 A–G，记录 SC-001/005/006 实测数值（不达标则回到相应任务修正或按 V-6 回退流程向用户复议）；逐项核对宪法第十七条 DoD 8 项与 spec 全部 FR/SC，结果记入 PR 描述

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 → Phase 2 → (Phase 3…7) → Phase 8**
- Phase 2 内部关键链：T004→T006→T007；T008→T011→{T012,T013}→T014→T015；T010 依赖 T008/T009；T050 依赖 T002/T003，并阻塞所有容器内测试任务（T021/T026/T030/T031/T037/T038/T041/T042）
- **T011（冒烟验证）是最大风险闸门**：其结论可修改 T008（镜像）与 T018（socat/http-host）方案，未完成前不进入 Phase 3

### User Story Dependencies

- **US1 (P1)**: 仅依赖 Phase 2 —— MVP
- **US2 (P1)**: 依赖 Phase 2；T023/T025 与 US1 的 entrypoint（T018）同文件，需在 US1 后串行（或同一开发者连续实现）
- **US3 (P2)**: 仅依赖 Phase 2，可与 US1 并行（不同文件）
- **US4 (P2)**: 检查逻辑仅依赖 Phase 2 + 运行中网络（US1 完成后才能跑集成）；代码编写可与 US1/US2 并行
- **US5 (P3)**: T039/T040 可在 US1 后开始；T041/T042 依赖 US4 的 verify（类别断言）

### Parallel Opportunities

```text
Phase 2:  T005 ∥ T007 ∥ T009 ∥ T015 ∥ T016（T004/T006/T008/T010/T011/T013/T014 按链依次）
Phase 3+: US3 (T028~T031) ∥ US1 (T017~T022)；US4 代码 (T032~T036) ∥ US2 (T023~T027)
Phase 8:  T044 ∥ T045 ∥ T046 ∥ T047
```

### Parallel Example: Foundational

```bash
# T004、T008 完成后可同时推进：
Task: "T009 docker/devnet/lib/protocol.sh"
Task: "T007 tests/unit/protocol.test.mjs"
Task: "T016 blockchain/accounts/dev-accounts.json + tests/unit/accounts.test.mjs"
Task: "T005 blockchain/protocol.schema.json + tests/unit/schema-sync.test.mjs"
```

---

## Implementation Strategy

### MVP First（Phase 1 + 2 + US1）

1. Setup → Foundational（T011 冒烟闸门必须真实跑通）
2. US1：启动/停止/转账/摘要 → quickstart 场景 A+B 验收
3. **STOP & VALIDATE**：此时已可供合约开发者日常使用

### Incremental Delivery

- +US2 → 可复现承诺兑现（场景 D） → 团队可放心共享
- +US3 → 参数单点被测试强制（场景 E） → 后续组件可安全接入
- +US4 → 回归基线（场景 C） → CI 可挂钩
- +US5 → 排障体验（场景 F） → 提升日常效率
- Phase 8 → 安全扫描 + 文档 + ADR + DoD 收口

### 风险提示（承接 plan/research）

- T011 若发现 V-1（IPv6）或 V-4（快照恢复 L1 节点）不成立，按 research 既定回退方案调整，并同步更新 plan.md 与本文件相关任务，不得绕过宪法第十五条私自改协议参数
- SC-001/V-6 实测不达标时，拓扑复议权在用户（宪法第十二条），任务 T049 负责触发

---

## Notes

- 每任务/逻辑组完成后提交一次 commit
- 测试先行：各故事的测试任务（T021/T026/T030/T037~038/T041~042）应先写断言、见其失败，再补实现
- 禁止为通过测试删除测试或放宽安全检查（宪法第十二条）
- 所有含协议参数的输出必须经 `protocol.sh`/`load.mjs` 读取，评审时以 T030 硬编码扫描为准
