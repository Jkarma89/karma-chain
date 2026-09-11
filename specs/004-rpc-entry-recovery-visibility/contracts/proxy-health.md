# 契约：代理容器的健康判定

**规格**：[../spec.md](../spec.md) 范围 A ｜ **决策**：[../research.md](../research.md) R-01 / R-02 / R-03

---

## 1. 这个判定回答的问题

> **这个代理容器本身，有没有在正常工作？**

**它不回答**「链能不能用」。两者被搞混一次，代价是 003 验收当天那个
「链好着但门坏了」的缺陷。

---

## 2. 判定的输入与输出

| | |
|---|---|
| 输入 | 一次对 nginx **自身应答的位置**的 HTTP GET（不 `proxy_pass`） |
| 输出 | 二值：healthy / unhealthy |
| 频率 | 由 compose 的 `interval` 决定（本期**不改**现有取值） |

### 必须成立（可测）

- **C-1**：该请求 **MUST NOT** 抵达任何上游节点。
  可测法：探测期间上游节点的访问日志里没有对应条目；
  或代理日志里该位置没有 `upstream` 字段。
- **C-2**：该请求 **MUST NOT** 使任何上游被计入失败（不得进惩罚期）。
  可测法：探测运行数分钟后，对上游发真实请求，全部 200、无 `no live upstreams`。
- **C-3**：判定 **MUST NOT** 读取 avalanchego 的综合健康位 `/ext/health`。
  可测法：**静态守卫**扫生成器与生成物（FR-024）。
- **C-4**：nginx 进程死亡或配置无法加载时，判定 **MUST** 转为 unhealthy。
  可测法：**变红检查**（V-02）。

### 明确**不**成立（并且是故意的）

- 该判定 **不覆盖**「改写与转发是否正确」。
  见 §5 —— 这一句需要人拍板，不是已定事项。
- 该判定 **不随链的可用性变化**。全部 L1 都不出块时它仍是 healthy ——
  因为代理确实在正常工作。**这是特性，不是缺陷**：
  「链能不能用」有面板与 `devnet-verify` 在回答。

---

## 3. 与既有 nginx 配置的关系

**一律不动**（[R-02](../research.md)）：

```
upstream karmachain_rpc {
    zone karmachain_rpc 64k;                                  ← 不动
    ip_hash;                                                  ← 不动
    server <addr> max_fails=1 fail_timeout=60s;   ×5           ← 不动
}
server {
    proxy_next_upstream error timeout http_502 http_503 http_504;   ← 不动
    proxy_connect_timeout 2s;                                       ← 不动
    proxy_next_upstream_tries 5;                                    ← 不动
    proxy_next_upstream_timeout 15s;                                ← 不动
    location /ext/bc/<alias>/ { rewrite …; proxy_pass …; }          ← 不动
    location / { proxy_pass …; }                                    ← 不动
}
```

**新增的只有一处**：一个由 nginx 自己应答的位置。

> **为什么"什么都不动"是本契约最重要的一条。**
> 看到 `max_fails=1 fail_timeout=60s` 的本能反应是"太激进、放宽一点"。
> 但那是 002 在 2026-09-09 **实测后**定下的，生成器注释里写着完整推导
> （原值 `max_fails=2 fail_timeout=10s` 在低频请求下等于没生效，5 次测量 5 次都付了连接超时）。
> **当前的 502 不是这些参数的错，是探测在制造失败。先去病因，再谈剂量。**

---

## 4. 生成与漂移

| 落点 | 由谁生成 | 守卫 |
|---|---|---|
| nginx 配置里的新位置 | `tools/protocol/render-rpc-proxy.mjs` | `npm run render:check` 漂移核对 |
| compose 里的 healthcheck 那一行 | `tools/protocol/render-compose.mjs` | 同上 |
| 两种形态（`local` / `lan`）一致 | 同一处生成器 | 漂移核对 + 逐形态断言（FR-009） |

**六份 compose 都要改**：`lan-win-1` / `lan-win-2` / `lan-ubuntu-1` / `lan-ubuntu-2` /
`lan-ubuntu-3` / `local-local`。它们都是生成物 —— 改生成器，不改生成物。

### 不触发 stamp 守卫

healthcheck 的取值**硬编码在生成器里，不在 `blockchain/protocol.json`**。
因此改它**不递增 `configVersion`**、**不触发 stamp 守卫**、**不需要全链重置**。

**这一条必须在实施时逐项核对，不能当成已知结论**（SC-008：`protocol.json` 与
`configVersion` 逐字节不变）。搞错的代价是七个节点退出 12、全链重置。

---

## 5. 悬而未决：FR-002 的第二个分句

FR-002 要求判定反映「进程在监听，**且能把面向客户端的 RPC 路径正确改写并转发到上游**」。

本契约只覆盖前半句。原因是**结构性的**：

| | 要验证转发 | 不得毒害上游 |
|---|---|---|
| 必须接触上游 | ✅ 必须 | ❌ 不可 |

**两条要求在同一个探测里无法同时满足。**

### 两种改法

- **(a)** 把 FR-002 的第二个分句移到一条新 FR，明确它由**静态守卫**
  （生成物漂移核对 + `tests/unit/rpc-proxy-failover.test.mjs`）与**系统级检查**
  （`devnet-verify`、003 面板的 `pathAlive`）覆盖。
  —— 理由：改写规则是**静态属性**，运行期每 10 秒重验一次没有收益。
- **(b)** 保留 FR-002 原样，改用 POST `eth_chainId` 经 RPC 路径探测。
  —— 代价：所有 L1 引导中时该路径返回 404（链还没注册）→ healthcheck 假红，
  而代理完全正常；引导常常超过 `start_period`。另需验证 busybox `wget --post-data`。

**倾向 (a)。** 但这决定了 §2 的 C-4 与 V-02 的具体判据，**必须由人拍板**。
