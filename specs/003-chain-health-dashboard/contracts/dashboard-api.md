# 契约：面板服务接口（功能 003）

面板服务是链的**只读旁观者**。它不参与共识、不持有链数据、不在崩溃恢复路径上 —— 与既有 `verify` / `render` 工具容器同类。

## 1. 启动与寻址

```
scripts/devnet-dashboard.sh    [--port <n>] [--interval <秒>] [--deployment <名>]
scripts/devnet-dashboard.ps1   同上
```

实现方式与既有 `scripts/devnet-status.sh` 第 87–90 行同一模式：

```
docker run --rm --network "$(devnet_node_network "$DOMAIN")" \
  -v "$(pwd):/workspace" -p "<port>:<port>" \
  karmachain/verify:local node tools/dashboard/server.mjs …
```

| 参数 | 默认 | 约束 |
|---|---|---|
| `--port` | **21680** | 不入 `protocol.json`（研究 R-03：会触发 stamp 拒绝启动、代价是全链重置）。默认值须在 Windows 动态端口范围（1024–15000）与排除区间之外 |
| `--interval` | **5 秒**（2026-09-10 从 2 调整） | **硬上限 6 秒**。发现时延 ≈ 间隔 + 一轮探测最坏耗时(4s) 必须 ≤ 10 秒（FR-018）。默认 5 秒下最坏约 9.1 秒，余量约 0.9 秒 —— 上限不得再放宽。须有测试同时守住**上限**与**出厂默认值** |
| `--deployment` | `topology.activeDeployment` | 与既有工具同名同义 |

**网络名必须由 `devnet_node_network` 推导，不得写死。** 002 在这里踩过两次（写死 `--network karmachain` 在跨机形态下必然失败，`devnet-verify` 与 `devnet-status` 各中一次）。

## 2. 端点

| 方法 | 路径 | 语义 | 写链？ |
|---|---|---|---|
| GET | `/` 及静态资源 | 零构建静态页 | 否 |
| GET | `/api/snapshot` | 完整快照（`data-model.md` 第 7 节） | 否 |
| GET | `/api/public` | 公开投影（第 4 节白名单） | 否 |
| POST | `/api/probe` | **人工探活**：发一笔交易并返回结果 | **是**（唯一） |

### 2.1 `GET /api/snapshot`

返回 `data-model.md` 第 7 节定义的 Snapshot。

**契约要求**：

- 无论探测成功与否**都返回 200 与一个完整快照**。观测失败是快照的**内容**（`observer.blind`、`tier: "observer-blind"`），不是 HTTP 错误 —— 用 5xx 表达"我连不上节点"会让前端无法区分"服务挂了"与"服务好着但看不见链"，而这两者正是 FR-020 要求区分的东西。
- 服务尚未完成第一轮探测时返回 `collectedAt: null` 与 `tier: null`，页面呈现为"首次采集中"。**不得**返回一个看起来正常的空快照。
- `collectedAt` 由服务端在**探测完成时**打戳，不是请求到达时 —— 页面的新鲜度判定依赖它反映数据年龄而非请求年龄。

### 2.2 `GET /api/public`

返回第 4 节的白名单投影。同样恒 200。

### 2.3 `POST /api/probe`（FR-034 / FR-035）

```
请求：  无参数
响应：  { confirmed: boolean, blockNumber: number|null,
          elapsedMs: number, txHash: string|null, error: string|null }
```

**契约要求**：

- **仅在收到本请求时才发交易。** 服务的自动轮询路径**不得**发起任何交易（FR-033）。守卫方式见第 5 节的 SC-017 用例。
- 判据复用既有 `tools/verify/checks/chain.mjs` 的 transfer 检查思路，不另立一套"链能不能出块"的判据。
- 链处于 `stopped` 档时交易**应当**无法确认 —— 此时返回 `confirmed: false` 与超时原因，**不是** HTTP 错误。这是本端点的正常输出之一（SC-018）。
- 私钥来自 `blockchain/accounts/dev-accounts.json`（宪法第四条 v1.1.0 例外覆盖的公开测试密钥），**只在服务端使用**。**不得**出现在任何响应、页面、快照或日志中。
- 并发保护：同一时刻只允许一个探活在飞。第二个请求返回"已有探活在进行中"，而不是发第二笔（避免 002 踩过的 nonce 间隙问题 —— 并行发交易导致 `WaitForTransactionReceiptTimeoutError`）。

## 3. 前端契约

| 要求 | 说明 |
|---|---|
| 前端**不做判定** | 档位、百分比、余量、异常分类全部由服务端给出。前端只渲染 |
| 前端**不直连节点** | 只访问本服务的四个路径。理由见研究 R-01 |
| 前端**不持有密钥** | 探活经 `POST /api/probe`，密钥不出服务端 |
| 无外部资源 | 无 CDN、无外链字体、无外链脚本（局域网可能无外网；外部脚本是新的供应链面） |
| 探活须先告知 | 点击后先呈现"这会向链写入：消耗开发账户余额、产生一个区块"，确认后才发（FR-035） |
| 新鲜度须始终可见 | 按 `data-model.md` 第 7 节的三档呈现。取不到快照时**不得**空白或静默保留旧画面 |
| `?view=public` | 以公开投影渲染精简视图（FR-026） |

## 4. 公开投影白名单（FR-026 / FR-027）

**允许**（且仅允许）这些键：

```
chainId  networkId  chainAlias  rpcPath  publishedHosts
networkHeight  tier  healthPercent  collectedAt
```

**禁止出现**：`nodeId` 与 `NodeID-` 前缀 · `address` 与任何私网地址段（`10.`、`172.16-31.`、`192.168.`）· `domain` · `detail` · `peers` · `genesisHash` · `blockchainId` · 容器名 · 宿主主机名 · 仓库内路径（`blockchain/`、`tools/`、`/workspace`）· 内部组件版本号（avalanchego / subnet-evm / Avalanche CLI 的具体版本）

`publishedHosts` 取自 `endpoints.publishedHosts`，既有 `tests/unit/public-artifacts.test.mjs` 已禁止该字段含私网地址，因此它安全。**不得**在此处把它替换成 `failureDomains[].address`。

**方向必须是白名单**（挑出允许的），不是黑名单（删掉不允许的）。黑名单在有人给快照加字段时**默认放行**，而那正是泄漏发生的方式。

### 这道守卫必须能变红

三层，缺一不可（FR-028）：

1. **结构断言** —— 投影输出的键集合**等于**白名单。多一个键即失败，迫使新增字段时显式决定是否公开。
2. **内容扫描** —— 对投影结果的 JSON 文本扫描上列禁止模式。
3. **行为探针** —— 喂一个**刻意含** `nodeId: "NodeID-xxx"`、`address: "192.168.1.21"`、`detail: "/workspace/blockchain/..."` 的假快照，断言这些**值**不出现在输出里。

第 3 层是关键。只有前两层时，一个"看起来有白名单常量"的错误实现（比如白名单没被真正应用）依然全绿 —— 002 反复教过这一课：**静态守卫只证明了没用错写法，没证明用对了**。

## 5. 与既有制品的关系

| 既有制品 | 003 的关系 |
|---|---|
| `blockchain/protocol.json` | **只读**。拓扑、地址、端口、验证者数、容错上限全部由它经 `deriveTopology` / `faultTolerance` 派生。面板端口刻意**不**加入（研究 R-03） |
| `tools/inspect/node-status.mjs` | 复用 `classify` / `summarize` / `probeNode` / `ALL_STATES`。**两处追加改动**：`probeNode` 增加 `genesisHash`；`readContainers()` 加 `export`（研究 R-07）。不改 `collect()` —— `devnet-status` 仍需要它的一次性语义 |
| `tools/protocol/load.mjs` | 复用 `loadProtocol` / `deriveTopology`。不改 |
| `tools/verify/checks/chain.mjs` | 探活判据的来源。不改 |
| `blockchain/nodes/lan/rpc-proxy.conf` | **不改**。改它要在五台机器上逐台 `--force-recreate`（Linux 的单文件绑定挂载绑 inode），研究 R-01 已否决走 nginx 的方案 |
| `docker-compose.yml` / `docker/*/Dockerfile` | **不改**。复用既有 `karmachain/verify:local` 镜像 |
| `blockchain/nodes/lan/*.flags.json` | **不改**。CORS 与 `http-allowed-hosts` 均已就绪（实测） |
| `docs/public/*` | **不新增制品**。健康度是实时数据，写进静态文件的那一刻就过期（研究 R-11） |

## 6. 退出码与失败分类

沿用既有 `scripts/devnet-*` 的语义，不新立一套：

| 码 | 含义 |
|---|---|
| 0 | 服务正常退出（收到终止信号） |
| 10 | 前置条件未满足（Docker 未运行、节点网络推导失败）—— 与既有 `devnet-status` 同码同义 |
| 其他非零 | 服务自身启动失败（端口被占等），须给出可操作的原因 |

**面板服务的退出码不表达链的健康状态。** 它是观察者，观察到"链停了"不构成它自己失败 —— 那是 `/api/snapshot` 的内容。混淆两者会让"面板进程活着吗"与"链活着吗"无法分辨。
