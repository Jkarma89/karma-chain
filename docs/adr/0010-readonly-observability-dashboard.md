# ADR-0010：面板作为链的只读旁观者

**状态**：已采纳（2026-09-10）
**背景特性**：[003 链状态与验证者网络实时监控面板](../../specs/003-chain-health-dashboard/spec.md)
**取代 / 相关**：[ADR-0007 故障边界独立性](0007-failure-domain-independence.md)、[ADR-0009 建链制品作为第二类事实](0009-chain-identity-as-second-class-fact.md)

## 决定了什么

在观察者机器上运行一个**只读**的小型 HTTP 服务，它复用 002 已有的状态判据轮询 7 个节点，
对外提供快照 JSON；浏览器加载一个零构建静态页渲染它。面板不参与共识、不持有链数据、
不在崩溃恢复路径上 —— 与既有的 `verify` / `render` 工具容器同类。

**唯一的写链路径**是人工点击触发的探活交易；自动刷新路径永不写链。

## 为什么 —— 四条"为何不"

这四条都是被认真考虑过又否决的，写下来是为了让日后想改的人知道代价在哪。

### 1. 为何面板端口**不**进 `protocol.json`

`docs/protocol-parameters.md` 的约定是「protocol.json 任何字段变更须递增 `configVersion`」，
先例是 **1.2.0 仅为新增 `endpoints.publishedHosts` 就递增了**。而 `configVersion`
恰在出生证明（stamp）的六项比对之列（`docker/node/entrypoint.sh` 的 `stamp_fields()`）。

于是：**加一个字段 ⇒ 递增 configVersion ⇒ 七个节点 stamp 全部不匹配 ⇒ 退出码 12
拒绝启动 ⇒ 五台机器全链重置。** 为一个 HTTP 端口丢弃全部区块历史是荒谬的。

面板端口**不是协议参数**：链上没有任何东西、也没有任何跨组件契约依赖它。
既有同类先例是 `KARMACHAIN_CONTAINER_RPC_PORT` 与 `KARMACHAIN_ADDRESS_OVERRIDE`
两个运维级环境变量。默认 21680，依据是 002 研究 R-08 的端口迁移教训
（实测在 Windows 动态端口范围 1024–15000 与排除区间之外，且与节点端口区段不重叠）。

### 2. 为何**不**走 nginx 反向代理

让 nginx 把 7 个节点代理到同一 origin 可以彻底消掉跨域问题，但要改
`blockchain/nodes/lan/rpc-proxy.conf` —— 那是 002 的生成物，改它要在**五台机器上逐台
`--force-recreate`**：Linux 的 Docker 单文件绑定挂载绑的是 **inode**，`restart` /
`up -d` / `nginx -s reload` 一概不生效（002 实测，2026-09-09 用 md5sum 对照才发现）。

为一个面板付这个代价不合理，且会触碰 FR-029 的边界（不得改动 002 的运行时制品）。

### 3. 为何**不**让浏览器直连节点

这一条最反直觉，所以要说清：**浏览器完全可以直连。** 实测 avalanchego 自己就发
`Access-Control-Allow-Origin: *` 并正确响应 OPTIONS 预检，7 个节点的 HTTP 端口也已
发布到宿主、`http-allowed-hosts` 已白名单五个局域网地址。**CORS 不是障碍。**

否决的真实理由是**判据复用**（FR-004）：状态判据活在 `tools/inspect/node-status.mjs`
的 `classify()` 里，而它经 `tools/protocol/load.mjs` 间接依赖 `node:fs` / `ajv` / `viem`。
服务端可以原样 import，一行不改；浏览器则必须先把这些依赖剥掉，或者自己抄一份 ——
**抄一份就是第二套判据，而两套判据漂移的那天没有任何测试会变红。**

附带好处：探活交易的私钥只在服务端，前端不持有任何密钥。

> 这一条记在这里，是为了避免日后有人读到"服务端采集"就以为是 CORS 限制所致。
> 那个理解会导致错误的后续决策（比如为了"绕过 CORS"去改节点配置）。

### 4. 为何**不**引入前端框架

页面的全部交互是：轮询一个 JSON、渲染一张表、按档位换配色、一个按钮。
框架在这里没有价值（宪法第十三条要求新依赖有明确价值）。仓库本就没有任何前端构建
工具链，引入打包器会新增构建步骤与产物一致性问题。也不用 CDN —— 局域网不保证有外网，
外部脚本还是一道供应链面。

最终：**新增 npm 依赖 0，新增构建步骤 0。**

## 影响

| 方面 | 影响 |
|---|---|
| 002 的运行时制品 | **零改动** —— 不碰 protocol.json、rpc-proxy.conf、节点标志、compose、Dockerfile |
| 002 的代码 | **两处追加**：`probeNode` 增加 `genesisHash`（分叉检测的唯一原料）、`readContainers` 由私有改为导出（否则本机停掉唯一验证者时会误报「整域缺席，去看那台机器」）。两处均有回归断言 |
| 新增依赖 | 0 |
| 运行载体 | 复用既有 `karmachain/verify:local` 镜像 —— 宿主唯一前置依赖仍是 Docker |
| 单点 | **不引入**。面板可从任一台承载节点的机器上打开；刻意不设"监控机"，因为那台机器一挂，面板就与"链停了"无法区分 |

## 这个设计里最容易被改坏的三处

003 的判定层里有三条规则，**改坏了不会报错，而是给出一个看起来合理的错误结论**。
它们各有一道会变红的守卫，改动前请先读那道守卫。

| 规则 | 改坏的后果 | 守卫 |
|---|---|---|
| 健康度用「参与共识」而非既有的 `countsAsOffline` | `NOT_OFFLINE` 含 `bootstrapping`，于是「1 个健康 + 4 个引导中」会显示 **100% 正常**，而链一个块都出不了（**假绿灯**） | `tests/unit/dashboard-tier.test.mjs` 真值表第 9 行 |
| 观察者失明的判定优先于「已停止」 | 观察者本机断网 → 7 个节点全不可达 → 既有 `summarize()` 输出「链已停止出块」（**假红灯**）。这是既有代码孤立使用时的默认行为 | 同上第 11 行 + `dashboard-blindness.test.mjs` |
| 面板不请求 `/ext/health` | 5 个 L1 验证者带 `partial-sync-primary-network=true`，综合健康位含 P 链可达性 —— 两个 Primary 一停就会把 5 个**工作正常**的验证者判成不健康（002 实测过；2026-09-10 又原地复现：l1-1 的 `/ext/health` 返回 503 而它自己 `healthy/748`） | `tests/unit/dashboard-boundaries.test.mjs` 静态禁止该字符串 |

## 迁移与退役

面板是纯派生视图，无持久化。停掉它对链无任何影响，删掉 `tools/dashboard/` 与
`scripts/devnet-dashboard.*` 即完成退役 —— 唯一需要一并回退的是 002 代码里那两处追加。

**若日后要把面板暴露到公网**（ADR 里「公开可访问的 RPC 端点」仍是未解决的开放决策），
必须重做 `specs/003-chain-health-dashboard/security-probe-tx.md` 第 4 节的风险评估：
当前的「无鉴权 + 一个会写链的端点」组合只在局域网开发网边界内可接受。
