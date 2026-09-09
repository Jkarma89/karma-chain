# Contract: 命令接口（相对 001 的增量）

**Feature**: `002-resilient-validator-network` | **Status**: Draft

本文只写**相对 001 的变化**。001 的 [`cli-interface.md`](../../001-local-avalanche-devnet/contracts/cli-interface.md) 中未提及的部分继续有效——特别是九类失败分类、退出码语义（10 前置依赖、11 端口冲突、12 数据与声明不一致、20 启动失败）、以及 `.ps1` / `.sh` 等价薄封装的规则。

## 语义变化的命令

| 命令 | 001 的行为 | 002 的行为 | 为什么变 |
|---|---|---|---|
| `devnet-start` | `compose up devnet`（单容器），首次 create+deploy，之后 `network start` 恢复快照 | 生成节点配置 → `compose up` 当前故障边界的全部节点容器。**没有"恢复快照"这条路径**——节点各自从数据卷恢复 | 缺陷 A：快照是唯一的数据丢失路径 |
| `devnet-stop` | SIGTERM → `avalanche network stop` 保存快照 | `compose stop`。**不保存任何东西**，因为没有东西需要保存 | 同上 |
| `devnet-reset` | `compose down -v` | 不变，但**语义降级**：从"崩溃后的唯一出路"变成"开发者显式要求从创世重建"（FR-005） | 崩溃恢复不再需要它 |
| `devnet-status` | 每节点 NodeID / 角色 / healthy / bootstrapped / peers | 增加 **`RecoveryState`**（data-model §7）、**当前高度**、**所属故障边界**；"追赶中"给出进度且不计为故障 | FR-031、FR-032 |
| `devnet-node <stop\|start\|pause\|resume> <node>` | 故障注入演练 | 增加 **`kill`**（`SIGKILL`，不给优雅退出机会）；`pause`/`resume` 的已知限制沿用 001 记录 | US1/US2 的独立测试需要非优雅终止 |

## 新增命令

| 命令 | 语义 | 退出码 |
|---|---|---|
| `devnet-bootstrap` | **一次性建链**。运行 `docker/bootstrap/` 镜像（唯一含 Avalanche CLI 的地方），产出 `blockchain/chain-identity/karmachain.identity.json` 与 Primary Network 创世。默认拒绝覆盖已有制品，需 `--force` | 0 成功；12 已有制品且未加 `--force`；20 建链失败 |
| `devnet-topology [--deployment <name>]` | 校验并展示拓扑：节点→故障边界归属、每边界验证者数、**推导出的容错上限**、共享失效因素告警 | 0 合法；**13 违反容错约束**（新增码，见下）；10 声明缺失 |
| `devnet-render` | 由 `protocol.json` + 建链制品生成全部节点配置与每机 compose；`--check` 模式做漂移检查 | 0 一致；1 漂移 |
| `devnet-logs [<node>] [--chain|--stdout|--file <name>] [-f] [-n N] [--raw]` | 按节点查看日志。省略 `<node>` 时列出可选节点与日志文件。**默认对 `*-content` 字段脱敏**（FR-026），`--raw` 显式关掉。只能看**本机**承载的节点 —— 别的节点要到它所在的机器上看 | 0 成功；10 前置依赖缺失或本机无该节点容器 |

### 新增退出码 13：拓扑违反容错约束

001 已占用 10 / 11 / 12 / 20。本特性新增 **13 = 拓扑声明违反容错约束**（FR-021），归入 `configuration` 类别。

失败输出必须给出可执行的修正方向，而不只是报错：

```text
[karmachain] FAILED [category: configuration] 故障边界 'win-1' 含 2 个 L1 验证者，
             上限为 1（5 个等权验证者，查询门槛 75% → 最多容忍 ⌊5/4⌋ = 1 个离线）。
             把 validator-2 移到另一个边界，或增加边界数量。
```

**13 的语义包含第二种情形：本机与拓扑声明不符。** 由 `devnet-start` 在跨机形态
（`KARMACHAIN_DOMAIN_COUNT > 1`）启动节点**之前**核对：本机网卡地址里必须有该边界声明的地址。

为什么必须在宿主侧、且在启动之前（V-07 实测）：容器处在 NAT 之后，看不到宿主的局域网地址，
容器内无从判断 `--public-ip` 通告出去的地址是不是本机的；而节点对配错**完全无声** ——
既不报错也不退出，唯一与地址相关的日志与配对时一模一样。症状要到跨机形态、且只在**新建**
对等关系时才出现，表现为某个边界时而参与时而不参与。

两种情形同属 `configuration` 类别，共用 13：都是"声明与事实不符"，且都必须在启动前拦下。
单边界形态跳过该核对 —— 那时声明地址是 `127.0.0.1`，不是网卡地址，核对只会误报。

```text
devnet-start: FAILED [category: configuration] 本机不是故障边界 'ubuntu-2' 声明的那台机器
  拓扑声明 ubuntu-2 的地址为 192.168.1.22，但本机的 IPv4 地址是：
    192.168.1.3
    …
  节点会把 192.168.1.22 通告给对等节点，而那不是本机地址 —— 对等节点将连不上它，
  且节点自身日志不会报错（容器在 NAT 后，看不到宿主地址）。
  三种修正方式，择一：
    1. 本机要跑的其实是别的边界 → KARMACHAIN_DOMAIN=<本机对应的边界 id> scripts/devnet-start
    2. 这台机器的地址变了 → KARMACHAIN_ADDRESS_OVERRIDE='ubuntu-2=<新地址>' npm run node:render
    3. 地址应长期改变 → 改 blockchain/protocol.json 的 topology.deployments 后重新渲染
```

## `devnet-topology` 输出格式

```text
KarmaChain topology   deployment: lan   5 domains / 7 nodes

  domain     platform  address        nodes                          validators
  win-1      windows   192.168.1.3    validator-1, primary-1                  1
  win-2      windows   192.168.1.11   validator-2, primary-2                  1
  ubuntu-1   linux     192.168.1.21   validator-3                             1
  ubuntu-2   linux     192.168.1.22   validator-4                             1
  ubuntu-3   linux     192.168.1.23   validator-5                             1

  容错：5 个等权验证者，查询门槛 75% → 可容忍 1 个离线
  边界：每边界 1 个验证者 → 可容忍 1 个边界整体失效  [OK]

  [WARN] 边界 win-1 与 win-2 共享失效因素 'update-window:patch-tuesday-0300'
         该因素触发将同时损失 2 个验证者，超出容错上限 —— 请错开维护窗口
```

告警不阻断（共享交换机在 5 台开发机上通常无法避免），但必须显示。这是 R-12 中"独立性无法由代码验证"的唯一可行补偿。

## `devnet-status` 输出格式

```text
KarmaChain nodes   deployment: lan   height 1284

  node          domain     role           state          height  peers
  validator-1   win-1      l1-validator   healthy          1284      6
  validator-2   win-2      l1-validator   catching-up      1201      6   (+83/min, ~1m)
  validator-3   ubuntu-1   l1-validator   healthy          1284      6
  validator-4   ubuntu-2   l1-validator   healthy          1284      6
  validator-5   ubuntu-3   l1-validator   unreachable         —      —   (域 ubuntu-3 不可达)
  primary-1     win-1      primary        healthy             —      6
  primary-2     win-2      primary        healthy             —      6

  4/5 验证者在线（上限：可容忍 1 个离线）—— 链继续出块
```

### 故障分类：九类够用，无需新增（T079 / FR-034）

分布式化引入的是新的**处境**，不是新的故障*性质*。每个 `RecoveryState`（data-model §7）的归类：

| RecoveryState | 类别 | 说明 |
|---|---|---|
| `healthy` / `starting` / `bootstrapping` / `catching-up` | **非故障** | 前两个要等，后两个是恢复过程；契约第 1 条明确 `catching-up` 不得计为故障 |
| `stopped` | `node` | 进程未运行 |
| `unreachable` | `node` | **两种含义，离线语义相反**：① 其他节点的 peer 列表里有它 → 本机到它的**路径**问题，链里它还在，**不计入离线**；② 同边界全部节点不应答 → **整域缺席**，计入离线、处置对象是那台机器。混淆两者会虚报余量不足 |
| `stalled` | `node` | 未在服务 L1 超过窗口，**且其余验证者全部在场**（否则成因在别的机器，本机无可处置之处）。判据与理由见 `contracts/node-runtime.md` |
| `identity-mismatch` | `configuration` | 挂载的密钥与制品声明不同源（FR-017） |
| `data-corrupt` | `storage` | 数据库打不开或与创世不符 → **重建该节点的卷**（FR-006），不是改声明 |

最后一行的归类值得说明：`data-corrupt` 归 `storage` 而非 `configuration`，因为处置办法是重建卷，
与"改声明"是两回事 —— 分类的用途是指向处置方式，不是描述症状。

该映射登记在 `tools/verify/lib/categories.mjs` 的 `CATEGORY_OF_RECOVERY_STATE`，
并由 `tests/unit/status-format.test.mjs` 双向锁定（状态未登记 → 失败；表中有已删除的状态 → 也失败）。
这把一次性的人工核对变成了持续约束。

### 判据统一：`node` 与 `fault-tolerance` 不再读综合健康位（T094）

两项检查此前用 `/ext/health` 的综合健康位，实测两次误报：

1. 停掉 2 个 Primary 时链正常出块，而 5 个验证者健康位全为 false（它们带
   `partial-sync-primary-network`，健康判定含 P 链可达性）—— 研究 R-09 / V-08。
2. 重建全部容器后约 20 秒，`devnet-start` 报 READY、交易与合约部署都正常，
   同一时刻 `devnet-verify` 报 `7/7 unhealthy: HTTP 503` 且 `0/5 validators online, chain has stopped
   producing blocks` —— 一条**完全健康的链**被报成越过容错上限。

现改为与容器健康检查同一判据：**本节点能否参与 L1 出块**。三处对"健康"的定义因此一致
（`docker/node/healthcheck.sh`、`tools/inspect/node-status.mjs`、`tools/verify/checks/basic.mjs`），
其中后两者共用同一份代码，不会各自漂移。`catching-up` / `bootstrapping` 不计为失败。

三条硬性要求：

1. **`catching-up` 与故障必须可区分**，且给出进度（FR-032）。上例中 validator-2 正在追赶，不计入离线。
2. **`unreachable`（边界缺席）与节点故障必须可区分**。上例中 validator-5 所在的整台机器不可达——运维要去看那台机器，而不是查节点。
3. **必须显示当前在线数与容错上限的关系**，让"还剩多少余量"一眼可见。

## 每台机器的部署

阶段二每台机器执行相同的两条命令，区别只在环境变量指定的边界 id：

```bash
KARMACHAIN_DOMAIN=ubuntu-1 scripts/devnet-start.sh
KARMACHAIN_DOMAIN=ubuntu-1 scripts/devnet-status.sh
```

**机器之间没有编排层面的依赖**——只有链层面的 P2P 关系。任一台机器的编排失效不影响其他机器（R-10）。这是"不引入集群编排系统"的直接收益，也是故障边界独立性在工具层面的体现。
