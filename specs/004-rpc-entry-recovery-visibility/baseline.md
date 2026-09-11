# 基线快照（T002）—— 本期**开始前**的状态

**取样时刻**：2026-09-11，提交 `2958f36`（004 的规格与计划完成、**尚未动任何代码**）

**为什么这份文件必须先于一切改动存在**：SC-008（`protocol.json` 逐字节不变）、
SC-011（公开投影字段集合逐字段相同）、FR-032（节点容器未被重启）
**全部是「与改动前比对」的判据**。事后再抓就只剩下推断 ——
而这个项目在 2026-09-10 一天之内两次证明了「推得出」不等于「验过」。

---

## 1. 协议与链身份（SC-008 的比对基准）

| 项 | 值 |
|---|---|
| `blockchain/protocol.json` sha256 | `1651092127c8a6f6ccf01fbe3f4e08a7f89389ed8a201738bc1bc44eef632e34` |
| `configVersion` | `1.4.0` |
| 创世哈希基准（`blockchain/genesis/karmachain.genesis.hash`） | `0x19cfde1f02e585020cdae83071bac33c7d81e411cacf7f306b82ceabe98892ed` |
| `karmachain.genesis.json` sha256 | `a265d8d3f4ebfaaa20b123a7956e99cb427e7bb02e18c0edbf1248ff96229742` |
| `validator-manager.alloc.json` sha256 | `dd2d66a3b4b609085378684b74b8cf246007015ef06d8099030eb0cd7d20b3ea` |

**验收时逐项核对**：这五行**必须逐字节不变**。任一行变了，说明改动碰到了协议层 ——
`configVersion` 一递增，stamp 守卫就会让**七个节点退出 12**，代价是五台机器全链重置。

---

## 2. 代理配置（改动落点的比对基准）

| 文件 | sha256（改动前） |
|---|---|
| `blockchain/nodes/local/rpc-proxy.conf` | `7551ae07a3fd1edd48c683bc7f8249fe972dc5b925c66dbe5df5fdf8cc228f9f` |
| `blockchain/nodes/lan/rpc-proxy.conf` | `4a4aaab788bd88dbf6202f8f30b6fef18b57681fee6c6d472893ac5a9227314d` |

**这两个哈希预期会变**（T005 要加一个新位置）。记下来是为了 T007 能逐份 diff，
确认**只有**预期的那一处变化 —— 而不是"看起来差不多"。

---

## 3. 六份 compose 的代理 healthcheck 原文（改动前）

六份**完全相同**，都是：

```yaml
      test: ["CMD", "wget", "-q", "-O", "-", "http://127.0.0.1:8545/ext/health"]
```

| 文件 | 行号 |
|---|---|
| `docker/compose/lan-ubuntu-1.yml` | 73 |
| `docker/compose/lan-ubuntu-2.yml` | 73 |
| `docker/compose/lan-ubuntu-3.yml` | 51 |
| `docker/compose/lan-win-1.yml` | 51 |
| `docker/compose/lan-win-2.yml` | 51 |
| `docker/compose/local-local.yml` | 197 |

**这一行就是本期范围 A 的病灶** —— 它经由代理自己去打 avalanchego 的综合健康位。
六份全部由 `tools/protocol/render-compose.mjs` 生成，因此**只改生成器**（T006）。

**T007 的判据**：改完之后这六行应当**全部**变成新的探测位置 ——
只变五份就是 `local` 形态被漏掉了（FR-009），而单机形态恰好是 e2e 跑的地方。

---

## 4. 公开投影的字段集合（SC-011 的比对基准）

`tools/dashboard/public-view.mjs` 的白名单，**9 个字段**：

```
chainId, networkId, chainAlias, rpcPath, publishedHosts,
networkHeight, tier, healthPercent, collectedAt
```

**验收判据（SC-011 / FR-022）**：本期结束时这个集合**逐字段相同** ——
既不多一个（`recoveryCapability` **不得**进对外视图，R-07），也不少一个。

T023 要把既有测试改成对着**这一行**断言，而不是写「不含 recovery 字段」——
那种否定式断言漏得掉下一个新增字段。

---

## 5. 节点容器的创建时刻（FR-032 的比对基准）—— ⚠️ **本次未能取得**

**如实记录**：取样时 win-1 的 Docker Desktop 已停止，`docker` 不可用；
且从 win-1 到其余四台（`192.168.1.13 / .21 / .22 / .23`）**全部 ping 不通**
（win-1 自己的网卡 Up、仍持 `192.168.1.3`）。

**而且这一项本来就跨不了机** —— 这是 `/speckit-analyze` 的 **D2** 指出的问题：
T002 原文写「七个节点容器的创建时刻」，但 `docker` 只能看**本机**容器，
从任何一台机器都拿不到七个。

**因此 FR-032 的核验方式改为逐台进行**：每台机器在**自己重建代理容器之前**
记下本边界节点容器的创建时刻，重建之后再核对一次。要记的是：

| 边界 | 本边界的节点容器 |
|---|---|
| win-1 | `karmachain-l1-1` |
| win-2 | `karmachain-l1-2` |
| ubuntu-1 | `karmachain-l1-3`、`karmachain-primary-1` |
| ubuntu-2 | `karmachain-l1-4`、`karmachain-primary-2` |
| ubuntu-3 | `karmachain-l1-5` |

取法：

```bash
docker inspect --format '{{.Name}} {{.Created}} {{.State.StartedAt}}' <容器名>
```

**不要用「容器还在跑」代替这一项。** `docker compose up -d rpc` 只重建代理服务，
但若有人手滑打成 `docker compose up -d`，节点会被一起重建 ——
那时容器仍然"在跑"，而 `StartedAt` 已经变了。**判据是时刻，不是状态。**

---

## 6. 测试基线

| 层 | 改动前 |
|---|---|
| 单元 | **600 通过 / 0 失败** |
| 生成物一致性 `npm run render:check` | **10 / 10** |
| 秘密扫描 `npm run test:secrets` | 5 通过（另 1 条「运行时日志脱敏」**跳过** —— 本机没有运行中的节点容器；容器起来后应为 8） |
| 集成 / e2e | **未取得** —— 需要 Docker 与运行中的链 |

**FR-029 的判据**：本期结束时单元数应 **≥ 600 且无既有断言被放宽**。
数字只增不减是必要条件，不是充分条件 —— 还要人核一遍没有谁把断言改松。
