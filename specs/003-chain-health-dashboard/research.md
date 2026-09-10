# 研究：链状态与验证者网络实时监控面板（功能 003）

本文件记录 Phase 0 的技术决策。每条给出**决定 / 理由 / 否决的替代方案**，实测数据标注取得日期与出处。

## 取证基线（2026-09-09，从 win-1 出发，五台全绿）

| 事实 | 实测值 | 取得方式 |
|---|---|---|
| 7 个节点的 HTTP 端口跨局域网直连 | **7/7 返回 200** | `curl http://<域地址>:<httpPort>/ext/health` |
| `http-allowed-hosts` 白名单 | 已含全部五个局域网地址 | `blockchain/nodes/lan/*.flags.json` |
| avalanchego 的 CORS 响应头 | **`Access-Control-Allow-Origin: *`**、`Access-Control-Allow-Credentials: true`、`Vary: Origin` | `curl -D - -H 'Origin: …'` |
| avalanchego 的 OPTIONS 预检 | **200**，`Allow-Methods: POST`、`Allow-Headers: Content-Type` | `curl -X OPTIONS -H 'Access-Control-Request-*'` |
| nginx 代理（8545）转发上述头 | 是 | 同上，经 `192.168.1.3:8545` |
| 一轮 7 节点全量探测耗时 | **64 / 67 / 142 ms**（三次） | 容器内直接调 `probeNode` ×7 并行 |
| `node-status.mjs` 整体耗时 | 4.18 s | 其中 3 s 是 `--sample-seconds` 的测速休眠 |
| 当前链高度 / 创世哈希 | 748 / `0x19cfde1f…92ed`（五台一致） | `eth_blockNumber` / `eth_getBlockByNumber("0x0")` |
| win-1 动态端口范围 | 1024–15000 | `netsh int ipv4 show dynamicport tcp` |
| win-1 在 15000–29999 的排除区间 | 仅 28385、28390 | `netsh int ipv4 show excludedportrange` |

---

## R-01 采集位置：服务端采集 + 浏览器只渲染

**决定**：在观察者机器上跑一个只读的小型 HTTP 服务，由它轮询 7 个节点并对外提供快照 JSON；浏览器只负责渲染与轮询这一个本地端点。

**理由**——**不是**因为浏览器做不到。恰恰相反，上表证明浏览器**完全可以**直连：avalanchego 自己就发 `Access-Control-Allow-Origin: *` 并正确响应预检。这一条是本轮研究最反直觉的地方，所以要把选择服务端的真实理由写清楚：

1. **判据复用是硬约束（FR-004）。** 状态判据活在 `tools/inspect/node-status.mjs` 的 `classify()` 里，而它经由 `tools/protocol/load.mjs` 间接依赖 `node:fs` / `ajv` / `viem`。服务端可以**原样 import**，一行不改；浏览器则必须先把这些依赖剥掉，或者自己抄一份。抄一份就是 FR-004 明令禁止的第二套判据 —— 而两套判据漂移的那天，没有任何测试会变红。
2. **探活交易需要 viem（FR-034）。** 仓库无任何前端构建工具链，浏览器里用 viem 只能靠 CDN（局域网可能无外网，且引入外部依赖）或引入打包器（宪法第十三条要求新依赖有明确价值）。服务端 viem 是既有依赖，零成本。
3. **观察者视角的语义不受影响。** 服务跑在观察者本机（下见 R-03），所以「本机视角」仍然成立 —— FR-019 / FR-020 要区分的是「**这台机器**到某节点的路径」与「节点本身」，而不是「浏览器进程」与「服务进程」。

**否决的替代方案**：

| 方案 | 否决理由 |
|---|---|
| 浏览器直连 7 个节点（纯静态页，无服务） | 判据必须在浏览器里重写一份（违反 FR-004），且探活交易无处安放。CORS 不是障碍，判据复用才是 |
| nginx 反向代理 7 个节点到同一 origin | 要改 `blockchain/nodes/lan/rpc-proxy.conf` —— 那是 002 的生成物，改它要在**五台机器上逐台 `--force-recreate`**（Linux 的单文件绑定挂载绑 inode，002 实测 `restart` / `up -d` / `nginx -s reload` 都不生效）。为一个面板付这个代价不合理，且触碰 FR-029 的边界 |
| 常驻一台"监控机"集中采集 | 引入新的单点：那台机器一挂，面板就与"链停了"无法区分 —— 正是 002 全篇在消除的东西。也直接违反 FR-031 |

---

## R-02 运行载体：复用既有 `karmachain/verify:local` 容器

**决定**：面板服务在既有的 `karmachain/verify:local` 镜像里运行，通过 `docker run --rm --network <节点网络> -v "$(pwd):/workspace" -p <端口>:<端口>` 启动，入口是 `scripts/devnet-dashboard.{sh,ps1}`。不新增镜像、不改 Dockerfile、不改 `docker-compose.yml`。

**理由**：

1. **宿主不能被要求装 Node。** README 承诺「宿主唯一前置依赖是 Docker」，而 `docker-compose.yml` 的 `render` 服务注释里写明这条承诺曾被 `npm run protocol:render` 破坏过、并专门补了服务来修。Ubuntu 机器上很可能没有宿主 Node。
2. **这条路径已经被证明过。** `scripts/devnet-status.sh` 第 87–90 行就是同一模式，并且**本会话在五台机器上都跑通过** —— 包括容器跨局域网探测另外四台机器的节点。跨机可达性不需要重新论证。
3. 网络名由 `devnet_node_network "$DOMAIN"` 推导而非写死 —— 002 在这里踩过两次（写死 `--network karmachain` 在跨机形态下必然失败）。直接沿用公共件。

**否决**：宿主直接 `node tools/dashboard/server.mjs`（会在没装 Node 的机器上不成立，违反 FR-031）；新建一个专用镜像（既有镜像已含 Node 与全部依赖，新增镜像纯属重复）。

---

## R-03 面板端口**不**进 `protocol.json`

**决定**：面板监听端口由命令行参数 / 环境变量提供，默认 **21680**，写在 `scripts/devnet-dashboard.*` 里。**不**加进 `blockchain/protocol.json`。

**理由 —— 这是本轮研究避掉的最大一个坑。** `docs/protocol-parameters.md` 的约定是「protocol.json 任何字段变更须递增 `configVersion` 并走宪法第十五条流程」，先例是 **1.2.0 仅为新增 `endpoints.publishedHosts` 就递增了**。而 `configVersion` 恰在出生证明（stamp）的六项比对之列（`docker/node/entrypoint.sh` 的 `stamp_fields()`：configVersion / chainId / networkId / blockchainName / genesisSha256 / genesisBlockHash）。

于是：**把面板端口加进 protocol.json ⇒ 递增 configVersion ⇒ 七个节点的 stamp 全部不匹配 ⇒ 退出码 12 拒绝启动 ⇒ 五台机器全链重置，当前 748 个区块的历史全部丢弃。**为一个面板的 HTTP 端口付这个代价是荒谬的。

这与宪法第十六条不冲突：面板端口**不是协议参数**——链上没有任何东西、也没有任何跨组件契约依赖它，它与「你把调试器绑在哪个端口」同类。既有先例即 `KARMACHAIN_CONTAINER_RPC_PORT`、`KARMACHAIN_ADDRESS_OVERRIDE` 两个运维级环境变量，都不在 protocol.json 里。

**21680 的选择依据**（002 研究 R-08 的教训：Windows 的 Hyper-V 会从动态端口范围里切走整段端口，节点端口因此从 96xx 段整体迁到 216xx 段）：

- win-1 动态端口范围 1024–15000 → 21680 在范围之外，Hyper-V 不会切走它（实测）
- 15000–29999 区间内的排除项只有 28385、28390（实测）
- 21680 与节点占用的 21650–21669 不重叠，且留在同一已验证安全的两万段内
- 21680 当前未被占用（实测）

---

## R-04 判据复用：哪些 FR 由既有代码**直接满足**

**决定**：`classify()` / `summarize()` / `probeNode()` / `deriveTopology()` / `faultTolerance()` 原样复用，不重写、不包装出第二套语义。

**理由**：读过实现后发现，规格里若干条 FR 已经由 002 的代码实现了，而且实现里带着当初的实测理由。逐条对上：

| FR | 既有实现 | 位置 |
|---|---|---|
| FR-004 状态取值集合（9 个） | `ALL_STATES` | `node-status.mjs:40` |
| FR-004a `unreachable` 双重含义 | `classify` 的 `ctx.seenByPeers` 分支，显式传 `offline=false` | `node-status.mjs:137-142` |
| FR-011 `catching-up` 不计入离线 | `NOT_OFFLINE` 集合 | `node-status.mjs:46` |
| FR-012 本机视角不可达不计入离线 | 同 FR-004a 那个分支 | 同上 |
| FR-013 不用综合健康位 | `probeNode` 只取 `info.getNodeID` / `info.peers` / `info.isBootstrapped` / `eth_blockNumber`，**从不请求 `/ext/health`** | `node-status.mjs:215-244` |
| FR-014 Primary 不计入容错 | `countsTowardTolerance: isValidator` | `node-status.mjs:78` |
| FR-016 逐节点高度与落后量 | `classify` 的 `catching-up` 分支给出 `落后 N 块` | `node-status.mjs:128-136` |
| FR-006 阈值由协议参数派生 | `faultTolerance()` 由 f ≤ ⌊n/4⌋ 算出 `maxOfflineValidators` | `load.mjs:294` |
| FR-010 边界级判定的原料 | `effectiveDomains`（并查集后的有效边界）、`tolerateWholeDomainLoss` | `load.mjs:264, 312` |
| FR-030 容器事实为可选增强 | `readContainers()` 缺失/旧格式/过期一律降级为纯网络判定 | `node-status.mjs:258` |
| FR-002 地址来自 failureDomains | `deriveTopology` 解析，另支持 `KARMACHAIN_ADDRESS_OVERRIDE` | `load.mjs:319` |

**这意味着 003 的工作量主要不在"实现判据"，而在"补上既有代码没有的那几层，并且不破坏已有的那几层"。**

---

## R-05 必须新增的判定层（既有代码**没有**的部分）

以下九层是 003 真正要写的东西。**逐层给出"若不写会怎样"** —— 这是它们存在的判据。

| 层 | 若不写会怎样 | 对应 FR |
|---|---|---|
| **L1 观察者失明** | 观察者本机网卡一断，7 个节点全不可达 → `seenByPeers` 为空、每个边界都 `domainAllUnreachable` → 5 个验证者全判离线 → `summarize()` 输出「**链已停止出块**」。**这正是 FR-020 明令禁止的假报警，而且是既有代码在孤立使用时的默认行为。** | FR-020 |
| **L2 启动中** | 5 个验证者都在 `bootstrapping` 时，`NOT_OFFLINE` 含 `bootstrapping` → 离线数 0 → 面板显示「100% 正常」，而链其实一个块都出不了。方向与 L1 相反：这里是**假绿灯** | FR-017 |
| **L3 三档 + 百分比** | `summarize()` 给的是 `{online, offline, withinTolerance, margin}` 与一句中文，没有百分比、没有档位枚举。档位可由 `!withinTolerance` / `margin===0` / 其余三分，**不引入新阈值** | FR-005 FR-006 FR-007 FR-008 FR-009 |
| **L4 边界级余量** | `tolerateWholeDomainLoss` 是布尔，不是余量数。余量 = 最大 k 使任意 k 个有效边界的验证者数之和 ≤ `maxOfflineValidators` | FR-010 |
| **L5 逐节点创世哈希** | `probeNode` **不取**创世哈希 → 分叉检测无原料。需要给 `probeNode` 加一个字段（见 R-07） | FR-024 FR-025 |
| **L6 异常四类分类** | 既有 `detail` 是自由文本，无机器可读的分类。需要 state → IncidentClass 的映射 | FR-022 |
| **L7 新鲜度** | 快照需要打时间戳，页面按 age 判陈旧。既有 `collect()` 不带时间戳 | FR-021 |
| **L8 公开投影** | 完整快照含 NodeID、局域网地址、域名 —— 直接给第三方即泄漏。需要显式白名单投影 | FR-026 FR-027 FR-028 |
| **L9 人工探活** | 只读面板无法发现「门槛满足但链实际卡住」 | FR-034 FR-035 FR-036 |

L1–L4、L6、L8 **必须是纯函数**：它们的分支太多，且其中两条（L1、L2）恰好是"活链上很难制造"的情形 —— 不能只靠在活链上跑一遍来验证。这是 002 的 `classify` 已经采用的做法（源码注释：「纯函数 —— 状态机分支太多，必须能不靠活链测」），沿用。

---

## R-06 轮询节奏与 10 秒预算

**决定**：默认轮询间隔 **2 秒**，可配置；上限约束是 **间隔 + 探测超时 ≤ 10 秒**。不做采样休眠 —— 用上一轮的高度当 `prevHeight`。

**理由（实测）**：

- 一轮 7 节点并行探测：**64 / 67 / 142 ms**（全部可达）
- 单个不可达节点因 `post()` 里的 `AbortSignal.timeout(4000)` 最多拖 4 秒；并行，所以一轮最坏约 4 秒
- 于是最坏发现时延 ≈ 间隔 + 4 秒。取间隔 2 秒 → **最坏约 6 秒**，FR-018 的 10 秒有 4 秒余量
- 由此得出可配置区间的硬上限：间隔 **≤ 6 秒**。超过就违反 FR-018，须由测试守住

**为什么不复用 `collect()`**：它在两次采样之间 `setTimeout(3000)` 睡 3 秒（为算追赶速率）。面板天然有上一轮数据，不需要这个休眠 —— 直接给 `classify` 传 `prevHeight` 与真实的 `sampleSeconds`（即实际间隔），这正是 `classify` 那两个参数的设计用途。**新增一个 `pollOnce()`，不改 `collect()`** —— `devnet-status` 仍然要它的一次性语义。

---

## R-07 对 002 代码的两处改动（均为追加，行为不变）

**决定**：给 `probeNode()` 增加一次 `eth_getBlockByNumber("0x0", false)` 调用，把结果的 `hash` 作为 `probe.genesisHash` 返回；沿用文件内既有的"子请求失败不影响其余判定"写法（`try { … } catch { /* … */ }`）。

**理由**：FR-024 / FR-025 的分叉检测没有别的原料来源。这是**加字段**而非改行为：既有调用方（`collect()` → `classify()`）不读这个字段，行为不变；新增一次并行子请求对 64–142 ms 的一轮探测影响可忽略。

**为什么不在面板里单独再发一轮请求**：那会让"某节点的创世哈希"与"该节点的状态"取自两个不同时刻的两次连接，在链路抖动时可能一个成功一个失败，产生自相矛盾的展示。同一次探测取全部事实。

**为什么不在面板里单独再发一轮请求**：那会让"某节点的创世哈希"与"该节点的状态"取自两个不同时刻的两次连接，在链路抖动时可能一个成功一个失败，产生自相矛盾的展示。同一次探测取全部事实。

### 改动二：`readContainers()` 由模块私有改为导出

**决定**：给 `node-status.mjs` 里的 `readContainers()` 加 `export`，并加一个**只为测试留的可选入参**（原始 JSON 文本，默认仍读 `.devnet/containers.json`）。**TTL 与旧格式的判定行数一字不动。**

> 接缝是写测试时才补的（2026-09-10）：本节原先写仅改可见性，函数体一字不动。但那段 TTL 判定**无法离线测试** —— 要么去写真实的 `.devnet/containers.json`（会踩踏正在运行的开发网状态），要么不测。而它恰好是 2026-09-09 咬过我们的那段逻辑（一份两天前的旧文件把刚被 devnet-stop 停掉的本机节点误报成「整域缺席，去看那台机器」）。一段咬过人又测不到的判定就是个不会变红的守卫。仓库对此已有先例：`_devnet-common.ps1` 的 `KARMACHAIN_ENV_FILE` 注明只为测试留的接缝。

**理由 —— 这一条是设计任务分解时才发现的，也纠正了本节标题原先写的"唯一改动"。** 面板必须能读容器事实，否则会在一个很常见的操作下误报：

> 在跨机形态下停掉**本机唯一的**验证者（`devnet-node kill l1-1`），面板若拿不到容器事实 → 探测不可达 → 本边界全部节点不应答 → `classify` 落进 `domainAllUnreachable` 分支，报 `unreachable`「整域缺席，**去看那台机器**」—— 而你正站在那台机器上，是你自己刚停的。

`classify` 的源码注释恰好点出了这个分支的成立条件：「容器**不在运行**且是正常退出：这是本机上有人主动停的……必须在下面的 unreachable 判定之前 —— 否则整台机器的节点全被停掉时会报'整域缺席，去看那台机器'，而运维刚在这台机器上执行过 stop，那条建议是错的」。要走到这个正确分支，就必须有容器事实。

**为什么不在面板里自己读那个文件**：`readContainers()` 带着 120 秒 TTL 与"旧格式不可信"两条判定，以及一段解释「**过期的事实比没有事实更坏**」的注释。在面板里抄一遍 TTL 逻辑就是第二个事实来源（宪法第十六条），而且抄漏 TTL 恰好会重现 002 已经踩过的那个误报。

**与 FR-030 的关系**：容器事实仍是**可选增强** —— 文件缺失、格式旧、过期一律降级为纯网络判定（既有行为）。面板的核心判据（档位、百分比、余量）在完全没有容器事实时依然成立，只是本机节点的 `stopped` 与 `unreachable` 会退化为后者。面板须显式告知这一降级，而不是静默接受。

**风险与守卫**：改动 `node-status.mjs` 就要保证 `devnet-status` 不回归。两条断言：①「创世哈希缺失时不影响任何状态判定」；②`readContainers` 加 export 后 `collect()` 的输出与耗时不变（V-05 实测对照基线 4.18 s / 7 行）。

---

## R-08 前端形态：零构建静态页

**决定**：`tools/dashboard/public/` 下的 `index.html` + 一个 ES module + 一份 CSS。无框架、无打包器、无 CDN、无新增 npm 依赖。由面板服务用 `node:http` 直接静态托管。

**理由**：

1. 宪法第十三条要求新依赖有明确价值；本页面的全部交互是"轮询一个 JSON、渲染一张表、按档位换配色、一个按钮"。框架在这里没有价值。
2. 仓库目前**没有任何前端构建工具链**。引入打包器意味着新增构建步骤、新增 `render:check` 之外的另一套产物一致性问题，以及"生成物是否提交"的新决策。
3. 无 CDN：局域网机器不保证有外网；且外部脚本是新的供应链面。
4. 报警的显目性不得只依赖颜色（FR-009）——文案 + 版式 + 图形符号三通道，纯 CSS 足够。

**否决**：React/Vue（体量与价值不匹配，且需构建）；Tailwind CDN（外网依赖 + 供应链面）；`file://` 直接打开（Chrome 对 `file://` 的 opaque origin 处理各版本不一，且 fetch 到 http 常被拦；服务本来就在，静态托管是顺带的）。

---

## R-09 人工探活交易的判据来源

**决定**：探活复用 `scripts/devnet-verify.sh` 的 `transfer` 检查思路（既有实现在 `tools/verify/checks/chain.mjs`），服务端用既有 `viem` 依赖发一笔开发账户转账，返回是否确认、确认耗时、所在区块。**不**在自动轮询路径上执行（FR-033）。

**理由**：`devnet-verify` 的 transfer 检查已经在本会话实测过（`0x5dae8df22f… confirmed in block 744 (4.2 s)`），判据成熟。另立一套发交易逻辑会出现两个"链能不能出块"的判据。

**为什么必须是人工触发**：自动周期性探活会持续产生区块，使高度不再反映真实业务活动 —— 而 FR-015 恰恰把"按需出块、高度停滞不是活性信号"当成一条诊断依据。自动写入会让这条依据失效。用户在规格阶段已就此裁定。

**开发账户密钥的处置**：探活用的私钥来自 `blockchain/accounts/dev-accounts.json`（宪法第四条 v1.1.0 例外覆盖的公开测试密钥）。它**只在服务端使用**，绝不出现在页面、快照 JSON 或公开投影里 —— 这也是 R-01 选服务端的一个附带好处。

---

## R-10 公开精简视图的形态与守卫

**决定**：同一个服务提供两个端点 —— 完整快照与公开投影；公开投影由**显式字段白名单**构造（挑出允许的字段，而不是删掉不允许的字段）。页面以 `?view=public` 渲染精简视图。

**理由**：白名单方向是唯一能随快照结构演进而保持安全的方向。黑名单（"删掉 nodeId 和 address"）在有人给快照加一个新字段时会默认放行 —— 而那正是泄漏发生的方式。

**守卫方式**（FR-028）：参照 `tests/unit/public-artifacts.test.mjs` 对 `docs/public/*` 的做法，对公开投影的输出做两层断言：

1. **结构断言**：投影输出的键集合等于白名单，多一个键即失败（新增字段必须显式决定是否公开）
2. **内容扫描**：对投影结果的 JSON 文本扫描禁止模式 —— `NodeID-` 前缀、私网地址段（10./172.16-31./192.168.）、仓库内路径片段（`blockchain/`、`/workspace`）、内部组件版本号

**这道守卫必须能变红。** 002 的教训之一是"静态守卫只证明了没用错写法，没证明用对了"。所以除了上面两条，再加一条**行为探针**：喂给投影一个刻意含 `nodeId` / `address` / 内部路径的假快照，断言这些值**不出现在**输出里 —— 而不是只断言"代码里有个白名单常量"。

---

## R-11 `docs/public/` 是否要新增制品

**决定**：**不新增。** 公开精简视图是服务的一个端点与页面的一种渲染模式，不落成 `docs/public/` 下的静态文件。

**理由**：`docs/public/chain-info.json` 是**静态**制品（由 `render-chain-info.mjs` 从 protocol.json 生成），而健康度是**实时**数据 —— 写进静态文件的那一刻就过期了，而"看起来是当前状态的陈旧数据"正是 FR-021 明令禁止的东西（`readContainers()` 的注释说得更直接：「过期的事实比没有事实更坏」）。

顺带一条边界：ADR 里「公开可访问的 RPC 端点」仍是未解决的开放决策，公网上目前没有可供第三方访问的端点。因此公开精简视图当下的实际用途是"可以把这个页面截图/投屏给外部看而不泄漏内部事实"，而非"第三方自己来访问"。这一点写进 quickstart，避免日后误以为它已经对外可用。

---

## 与既有系统的冲突检查

| 潜在冲突 | 结论 |
|---|---|
| 改 `protocol.json` → stamp 拒绝启动 | **已避免**（R-03，端口不入 protocol.json） |
| 改 `rpc-proxy.conf` → 五台 force-recreate | **已避免**（R-01，不走 nginx） |
| 改 `docker-compose.yml` / Dockerfile | **不需要**（R-02，复用既有镜像与 `docker run`） |
| 改节点运行时标志 | **不需要**（CORS 与 `http-allowed-hosts` 都已就绪，实测） |
| 改 `node-status.mjs` | **需要，一处**（R-07 加创世哈希字段），须补回归断言 |
| 新增 npm 依赖 | **零**（node 内建 + 既有 viem） |
| `.sh` / `.ps1` 成对与可执行位 | 新增 `scripts/devnet-dashboard.{sh,ps1}`，受既有 `tests/unit/powershell-portability.test.mjs` 的成对与 git 索引模式守卫约束 |

## 实现期待验证清单

以下几条**只能在实现期实测**，不能靠推理定案；到时逐条回填结果：

- **V-01** ✅ **五台全部通过（2026-09-10）**：五台各自 `devnet-dashboard` 起容器后，从 win-1 逐台探 `http://<边界地址>:21680/` 与 `/api/snapshot` **全部 200**，且五份快照给出**同一个结论**：`normal / 100% / 余量 1 与 1 / 高度 817 / 可达 7-7 / 无分叉`。五个独立观察者互不依赖 —— 这正是 FR-031「不设专属观察机」的实证。

  **在 win-2 上连撞四次才跑通，四项里有三项是 002 遗留的、被 win-1 掩盖的前提**：

  | # | 症状 | 成因 | 修法 |
  |---|---|---|---|
  | 1 | `CommandNotFoundException` | PowerShell 不从当前目录找脚本 | 用 `.\scripts\...`（非缺陷） |
  | 2 | 同上，但带完整路径 | **003 的改动一直没提交**，win-2 上没有那个文件 | 提交并推送 |
  | 3 | `pull access denied … may require docker login` | `karmachain/verify:local` 是**本地构建**的，win-2 没建过；而 docker 那句提示指向权限问题，**完全错误的方向** | 四对脚本加前置检查，直接给出构建命令；`docs/devnet.md` §9.3 补上"两个镜像" |
  | 4 | `Cannot find package 'ajv'` | `-v "$(pwd):/workspace"` 整仓挂载**把镜像里的 node_modules 盖掉了** | 改按子目录挂载（compose 的 verify 服务本来就这么做） |

  **③ 与 ④ 同时影响 devnet-verify / devnet-status / devnet-contracts** —— 也就是说 002 的三个命令在任何"没人跑过它们、且宿主没跑过 npm ci"的机器上都会失败。win-1 上一直没暴露，只因为我所有验证都在那台机器上做。**这是本轮最值得记下的一条："在一台机器上验过"不等于"验过"。**
- **V-02** ✅ **通过（2026-09-10）**：`tests/integration/dashboard-server.test.mjs` 的「探测抛错时服务仍然应答」把全部节点地址指向黑洞，实测 `observer.blind === true`、`tier === "observer-blind"`，并显式断言 `tier !== "stopped"`。另有 `tests/unit/dashboard-blindness.test.mjs` 覆盖 P1/P2 的优先级（含「0 可达且恰有节点 bootstrapping」那一条）。**取证方式是把地址指向黑洞，不是物理断网** —— 在观测层等价（两者都是"一个都探不到"），但物理断网那一份仍留在 quickstart 场景 E 由人做。
- **V-03** ✅ **通过（2026-09-10）**：`tests/e2e/dashboard-detection.test.mjs` 两次运行分别测得 **2942 ms** 与 **2960 ms**（预算 10 000 ms，余量约 7 秒）。档位序列显示前 2.7 秒稳定在 `normal/100%`，第 2942 ms 跳到 `zero-margin/80%` —— 与"轮询间隔 2s + 探测耗时"的预算推导相符。同一时刻实测交易确认（748→749），证明 80% 档「链仍在出块」不是空话。
- **V-04** ✅ **两台机器实测通过（2026-09-10）**：在 ubuntu-3 与 win-2 上各 `devnet-node kill` 一个验证者（l1-5、l1-2）→ 参与共识 3 个 < 门槛 4 个。**四份快照（win-1 / win-2 / ubuntu-2 / ubuntu-3）一致给出 `stopped / 60% / 余量 0 与 0 / 参与 3 / 门槛 4`**，异常分类 `node-infra` + `consensus-margin`。

  **恢复后还落下一条比预期更强的证据。** 两个验证者恢复后，链停期间那笔"45 秒无回执"的交易
  `0x7861c4ee…9f5e` **被原样打包进区块 834**（`from` / `to` / `value` 全部一致，未重发、未改 nonce、
  无任何人工干预）。也就是说交易一直在内存池里等着，连接权益回到门槛以上就自动出块 ——
  面板文案里「**安全停摆：不分叉、区块零回滚，验证者恢复后自动继续**」这句话得到了字面验证，
  而不只是从共识参数推出来的说法。这也反证了"高度停滞不是活性故障信号"（H-2）的另一面：
  **停摆期间高度冻结是真停了，但冻结本身不损坏任何东西**。

  **一处诚实的缺口**：恢复方向的 ≤10 秒时延**本轮没测到** —— 恢复动作发生在我开始采样之前，
  等我看时五台已经全绿。SC-004 的 ≤10 秒仍只由 `dashboard-detection` 第 3/4 用例（自动化）支撑，
  现场证据只到"五个视角都回到 `normal/100%`、报警自行消失、无需任何人工点击"这一步。

  **缺的那一半事实（"交易确实无法确认"）也拿到了**：绕过代理直连仍存活的 l1-1 提交一笔真实交易 —— **16 ms 就被接受进内存池**（节点是活的，RPC 正常应答），但**等 45 秒无回执**，高度始终停在 833。也就是说交易进得去、永远出不来：这正是"低于查询门槛 → 停止出块"的直接证据，而不是"节点连不上"。**这一条不能用代理来验**（见下）。

  **同时暴露我自己一个指错方向的错误提示。** 从代理入口探活拿到的是 viem 的 `HTTP request failed`，而当时 `probe-tx.mjs` 的 `explain()` 说「注意这**不表示链停了**」并让人「检查该边界的 RPC 代理容器是否在运行」——**两句都朝反方向**：链确实停了，代理也确实在运行。真相是 nginx 在 **1.6 ms** 内返回 502，因为 002 的 `max_fails=1 fail_timeout=60s` 已把全部上游关进惩罚期。

  判据只能是**有没有拿到 HTTP 状态码**，不能靠错误文本 —— viem 对"连不上"和"502"抛的是同一句话。已按此改：没有状态码 → 路径/代理问题（可以说"不表示链停了"）；502/503/504 → 代理活着、上游全挂（**不得**再说"不表示链停了"）。状态码还必须**沿 `cause` 链找**：`sendTransaction` 抛的 `TransactionExecutionError` 的 `shortMessage` 一模一样但 `status` 是 `undefined`，只看顶层会永远拿不到，于是 502 被误判成"完全没有 HTTP 应答"—— 我第一版就写错在这儿，是新加的行为用例把它抓出来的。
- **V-05** ✅ **通过（2026-09-10）**：输出逐行相同（7 行、全 healthy、高度 748、summary 一字不差），三次运行判定完全一致。**genesisHash 子请求的净代价实测 13 ms/轮**（交替测 5 组取中位数：不含 59 ms、含 72 ms），`collect()` 两轮共 +26 ms。当日 `node-status.mjs` 整体耗时 5.7 s vs 基线 4.18 s，那 1.5 s 差值经隔离测量确认**与本改动无关**，是四台机器刚开机的环境抖动 —— 这一条特意分开测，否则很容易把环境差异误记成回归
- **V-06** ✅ **通过（2026-09-10）**：`tests/unit/dashboard-public-view.test.mjs` 的第 3 层里有一条专门的自检 ——「这个探针本身会变红吗」：它构造一个**黑名单式**的错误实现（拷贝快照再删掉已知的敏感字段），喂进一个新增字段，断言那个实现**确实泄漏**了 NodeID；再断言白名单实现不泄漏。也就是说探针的判据被证明了是有区分力的，而不是恒真。

- **V-07（SC-007 现场，2026-09-10）** ✅ **两个 Primary 全停，五个视角一致报 `normal / 100%`**：ubuntu-1 停 primary-1、ubuntu-2 停 primary-2 → 两个 Primary 在面板上单列为 `stopped`、分类 `node-infra`，**不牵连链的档位**（余量仍 1 与 1，参与 5 / 门槛 4，`observer.blind=false`，可达 5/7）。同时刻**五个 L1 自报的综合健康位 `/ext/health` 全部 503** —— FR-013 那个陷阱如实复现；而直连 l1-1 的真实交易**确认于区块 835、4108 ms**。若当初把那个综合位当 L1 活性判据，此刻面板会把一条正在出块的链报成"全部节点不健康"。

  **同时找出一个 002 的真实可用性缺陷**：RPC 入口间歇性 502，而五个 L1 各自 200。成因是代理容器的 Docker healthcheck **经由自己**去打 `/ext/health`（综合位，此刻 503），nginx 的 `proxy_next_upstream … http_503` 把它计为上游失败，`max_fails=1 fail_timeout=60s` 一次就关 60 秒，而 `proxy_next_upstream_tries 5` 让一次 healthcheck **毒遍五个上游**，10 秒的 healthcheck 间隔又短于 60 秒惩罚期 —— 于是永不出狱，真实流量一起吃 502。**这是 FR-013 同一个陷阱下沉了一层**：002 的节点 healthcheck 刻意避开了综合位并写明了理由，代理的 healthcheck 却正好用了它。详见 `checklists/dod.md` 第六节；**本期未修**（002 运行时零改动）。
- **V-08（两个 Primary 的真实作用，2026-09-10 实测）** ⚠️ **发现一个恢复能力上的单点**：
  两个 Primary 全停、链仍报 `normal / 100%` 的状态下，`restart` 一个 L1 验证者（win-1 的 l1-1）——
  **它再也回不来了**。5 分钟内 P 链 `isBootstrapped` 恒为 `false`，L1 那条链在该节点上
  **根本没被创建**（`there is no chain with alias/ID 2W9boARg…`）。avalanchego 自报的原因是决定性的：

  ```
  P: disconnectedValidators: [NodeID-7Xhw2mDx…, NodeID-MFrZFVCX…]   ← 正是两个 Primary
     percentConnected: 0
     error: "not connected to enough stake: connected to 0.000000%; required at least 80.000000%"
  bootstrapped: error: "subnets not bootstrapped"
  network: connectedPeers: 4          ← 另外四个 L1 都连上了
  ```

  **关键点：引导的门槛是"连上的 P 链权益"，不是"数据拿不拿得到"。** 另外四个 L1 虽然带
  `partial-sync-primary-network=true`（它们自己也同步 P 链）、也确实被连上了（`connectedPeers: 4`），
  但它们**不是 P 链验证者**，权益为 0 —— 所以顶替不了。两个 Primary 之间握着 P 链的全部权益。

  由此，两个 Primary 的真实作用有三条，前两条此前没有在任何制品里写明：

  | # | 作用 | 证据 |
  |---|---|---|
  | 1 | **它们就是主网络本身** —— P 链是"这个 Subnet 存在、这条链存在、它的验证者是这 5 个"的注册表 | `primary-*.flags.json` 带 `genesis-file=/config/primary-network.genesis.json` 且 `bootstrap-ips=""`（自己是创世种子）；L1 侧 `sybil-protection-enabled=true` + `track-subnets=<subnetId>`，验证者集合读自 P 链 |
  | 2 | **它们是唯一的引导种子，且是唯一的 P 链权益持有者** | 五个 L1 的 `bootstrap-ips` 全指向 `192.168.1.21:21651,192.168.1.22:21653`；本次实测证明其余 L1 顶替不了 |
  | 3 | **验证者集合的变更只能在 P 链上做** —— 增删验证者、改权重、轮换密钥 | 架构事实（未实测） |

  **而出块不受影响的原因也清楚了**：P 链不在出块路径上。L1 验证者一旦引导完成，验证者集合已在
  内存里，之后共识只在 5 个 L1 之间跑。**注册表停了，但按注册表已经组好的班子照样开会**——
  这正是 SC-007 测到的（区块 835、4108 ms）。

  **面板在这次实验里表现完全正确**：l1-1 重启后 **9 / 11 / 15 秒**内三个视角先后转为
  `zero-margin / 80% / 参与 4 门槛 4`，l1-1 标为 `bootstrapping`。**`bootstrapping` 没有被计入
  参与共识** —— 这正是 `data-model.md` §0 那条 `participatesInConsensus` 与 002 的 `NOT_OFFLINE`
  分道扬镳的理由；若当初图省事复用 `NOT_OFFLINE`，此刻会得到一个 **100% 的假绿灯**。

  **补测更正（同日）：一个 Primary 不够，必须两个都在。** 起回 primary-1 之后 l1-1 仍未恢复，
  它自报 `percentConnected: 0.5` / `disconnectedValidators: ["NodeID-MFrZFVCXPv5…"]`（即 primary-2）/
  `"connected to 50.000000%; required at least 80.000000%"`。两个 Primary **各握 P 链 50% 权益**，
  而门槛是 **80%**：

  | 在线的 Primary 数 | 连上的 P 链权益 | 能否引导 |
  |---|---|---|
  | 2 | 100% | ✅ |
  | **1** | **50%** | ❌ **不行** |
  | 0 | 0% | ❌ |

  所以这**不是「单点故障」，是「AND 依赖」** —— 两个 Primary 缺任何一个，整张网就失去了
  让验证者重新加入的能力。上一段把它写成"单点"是低估了：**它比单点更脆**。

  这对 002 的容错结论有一个此前没有写明的边界：**T-5「可容忍 1 个故障边界整体失效」在出块
  这件事上成立，在恢复这件事上不成立。** 只丢 ubuntu-1（它上面有 primary-1 与 l1-3）一台，
  链会继续出块（4/5 = 80% 零余量），但从那一刻起**任何验证者都无法重新加入** ——
  包括 ubuntu-1 自己修好之后的 l1-3。恢复顺序因此有硬约束：**先把两个 Primary 都拉起来，
  再拉验证者**；反过来做会白等。

  （80% 这个数字取自 avalanchego 自己的健康消息。此处只记实测事实：50% 时引导不推进；
  不对它内部的引导门控机制做推断。）

  **但有一件事面板没说。** 两个 Primary 停着、五个 L1 都好的那一刻，面板报 `normal / 100%`
  是对的（问的是"链能不能出块"），可它没告诉人：**此时这张网已经失去自我恢复能力，
  任何一个验证者一旦重启就回不来**。事实（`primary-1/2 = stopped`，分类 `node-infra`）是可见的，
  后果不是。这是一条**已识别、本期未实现**的呈现缺口 —— 需要新 FR，不在 003 的 37 条里。