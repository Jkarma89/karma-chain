# ADR-0008：运行时脱离编排工具，一节点一容器直接运行 avalanchego

**状态**：已接受 · **日期**：2026-09-07 · **决策者**：项目负责人 · **相关**：宪法第七/九/十三条 · **来源**：功能 002（研究 R-01、R-02、R-13）· **取代**：ADR-0002 的运行时部分

## 决定了什么

链的运行时不再由 Avalanche CLI 编排。**每个节点一个容器，容器内直接以进程方式运行 `avalanchego`**，
标志由唯一事实来源生成。CLI 只保留在**一次性建链**这一步（ADR-0009）。

| | 001（已退役） | 002 |
|---|---|---|
| 进程形态 | 1 个容器内 7 个由 `avalanche network start/stop` 管理的进程 | 7 个容器，各 1 个 `avalanchego` 进程 |
| 链状态存续 | 依赖容器收到 SIGTERM 后 `avalanche network stop` **成功写出快照** | 依赖每个节点自己的 LevelDB（崩溃一致） |
| 崩溃后 | `devnet-reset` 丢弃全链状态 | 重启即恢复，**不需要重置** |
| 镜像 | `avaplatform/avalanche-cli` | `avaplatform/avalanchego` + sha256 校验的 subnet-evm 插件，**不含 CLI** |
| 编排层 | CLI 的 `~/.avalanche-cli/` 账本 | 无。容器运行时的 `restart` 策略 + 健康检查即进程守护 |

`docker/devnet/`（001 的单容器编排、entrypoint 的快照逻辑、CLI 缓存与 spike 脚本）已于 T080 删除。

## 为什么

### 直接动因是一次真实故障，而它的根因不是"运气不好"

2026-09-05 强制重启 Docker Desktop 后开发网无法启动。事后取证：**7 个节点的数据库全部完好**
（崩溃一致的 LevelDB），丢失的是 CLI 自己的编排账本 —— `~/.avalanche-cli/snapshots/` 为空、
`localNetworks.json` 指向已死的运行目录。CLI 因此不知道如何重新拉起那些本身健康的节点，
等满 300 秒超时后以退出码 20 失败，唯一出路是丢弃全链状态。

关键在于**这不是偶发**：链状态的存续依赖"容器收到 SIGTERM 后快照写出成功"这条路径，而
强制重启 Docker、宿主断电、`docker kill`、OOM **必然绕过它**。也就是说数据丢失是该架构的
确定性后果，不是概率问题。

取证还发现第二个根因：全卷搜索 `staker.crt` **零命中**。节点身份不是节点自有的持久属性，
而是编排层每次注入的外部输入 —— 即便快照还在，节点也拿不回自己的身份。

### CLI 在运行期没有提供任何不可替代的能力

[实测] 从节点的 `flags.json` 取到 CLI 实际传给 `avalanchego` 的**全部**参数，
没有任何一项是 CLI 私有的 —— 全是 avalanchego 的公开配置标志（`network-id`、`track-subnets`、
`bootstrap-ips/ids`、`data-dir`、`plugin-dir`、`public-ip`、`staking-*` 等）。
CLI 只是把它们拼起来并记账。把这份参数改由我们自己从唯一事实来源生成，编排工具就能完全退出运行时。

### 一个附带的、结构性的收益

节点镜像以官方 `avalanchego` 为基底、**不含 CLI**，于是"运行时不依赖编排工具"这条要求
**由镜像构成本身保证**，可以静态验证（`tests/integration/no-cli-in-runtime.test.mjs`
断言镜像内不存在 `avalanche` 可执行文件、运行时代码路径无 CLI 调用）。
这把一条需求变成了结构性事实，而不是靠测试去追一个约定。

## 代价（必须写清楚，因为它们是真实的）

| 代价 | 说明 | 缓解 |
|---|---|---|
| **参数拼装的责任转移给我们** | CLI 原本承担"给 avalanchego 喂什么参数"。现在这份知识落在 `render-node-flags.mjs` 里，上游默认值变化不再自动跟随 | 与实测基准 `tests/fixtures/002/measured-node-flags.json` 逐项对照，每处差异都必须能说出理由 |
| **索引开关等"看似无害的默认值"会咬人** | 实测教训：沿用 avalanchego 默认值让 Primary 启动即 FATAL（`running would cause index to become incomplete`）。索引开关必须与**播种进卷的数据库**当初的设置一致 | 标志由拓扑生成，角色差异显式声明；漂移测试锁定 |
| **容器数从 1 变 8** | 单机形态下 7 节点 + 1 个 RPC 代理。资源占用与启动编排都更复杂 | 实测总 RSS 约 1.1 GB，与 001 同量级；每边界一份 compose 由拓扑生成，无需手写 |
| **链别名要自己维护** | 实测修正：`--chain-aliases-file` 被读进配置但 **v1.14.1 不据此注册 HTTP 路由**，别名路径仍 404。而 001 公布给第三方的地址正是别名路径 —— 它此前依赖 CLI 每次 `network start` 调 admin API 建别名 | 无状态的 nginx 路径重写代理（不持有数据、不在崩溃恢复路径上），顺带获得跨验证者的 RPC 故障转移 |
| **建链仍需 CLI** | P 链上的 CreateSubnetTx / CreateChainTx 无法离线推导 | 收缩到一次性动作，产出固化为制品（ADR-0009） |

## 考虑过的替代方案

| 方案 | 否决理由 |
|---|---|
| **继续用 CLI，只是加自动重启** | 不解决问题。根因是链状态存续依赖 CLI 的快照记账，重启只会重复触发同一条失败路径 —— 本次故障即为实证：CLI 重启后确实自动跑了 `network start`，仍然失败 |
| **改用 `tmpnetctl` / avalanche-network-runner** | 二者定位都是**临时测试网络**（tmpnet 的名字即 temporary network），生命周期语义与"长期存续的链"相反，且同样是外部编排层 |
| **自研编排守护进程** | 把 CLI 的问题原样重写一遍，额外承担维护成本。容器运行时本身（`restart` 策略 + 健康检查）已经是成熟的进程守护，不需要再造（宪法第十三条） |
| **引入 Kubernetes / Nomad 等集群编排** | 用一个更大的编排层去解决"编排层是单点"的问题。跨机形态下每台机器一份 compose、机器之间**没有编排依赖**，任一台的编排失效不影响其他机器 —— 这正是不引入集群编排的直接收益（研究 R-10） |
| **保留 `docker/devnet/` 作为回退路径** | 两套运行时并存意味着两份"链如何启动"的事实，与宪法第十六条冲突；且回退路径正是要消灭的那条数据丢失路径。历史版本在 git 里，需要时可查 |

## 影响

- 崩溃恢复不再需要 `devnet-reset`：实测 `docker kill` 全部容器后重启，高度／余额／创世哈希全部保留，12–17 秒恢复，4 轮 + 8 轮重复零丢失
- `devnet-stop` 不再保存任何东西 —— 因为没有东西需要保存
- 每个节点一个独占命名卷承载 `/data`：删掉某个卷再启动，该节点从对等节点重新同步，其余节点不受影响（实测 5/5）
- 出生证明（stamp）机制下沉到**每个节点自己的卷**，001 的退出码 12 语义未回退
- `docker-compose.yml` 只剩无状态工具容器（verify / render）；链的编排一律在生成物里，
  并由 `tests/unit/docs-drift.test.mjs` 断言节点服务不得出现在手写 compose 中

## 迁移

从 001 升级：`scripts/devnet-reset` 删除旧卷 → `scripts/devnet-bootstrap` 一次性建链 → `scripts/devnet-start`。
001 的链数据**无法**平滑迁移，因为 002 的节点各自持有独立卷，而 001 的数据在单容器的 CLI 目录树里；
且 `configVersion` 变更会被 stamp 守卫以退出码 12 拒绝。开发网从创世重建是可接受的一次性代价。

若将来上游提供"以服务方式长期运行"的官方编排（而非临时测试网络），可重新评估 ——
但前提是它不能把链状态的存续挂在编排层自己的账本上。
