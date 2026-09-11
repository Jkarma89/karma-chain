# Quickstart · 验收场景：RPC 入口可用性修复与「恢复能力」呈现

**规格**：[spec.md](./spec.md) ｜ **契约**：[proxy-health](./contracts/proxy-health.md) · [recovery-capability](./contracts/recovery-capability.md)

---

## 执行状态

| 场景 | 判据 | 需要几台机器 | 状态 |
|---|---|---|---|
| A · 配置能加载 | V-01 | 1 | ⬜ 待做 |
| B · 探测不碰上游 | C-1 / C-2 | 1 | ⬜ 待做 |
| C · 静态守卫禁 `/ext/health` | FR-024 | 0（纯测试） | ⬜ 待做 |
| D · 代理健康位会变红 | V-02 | 1 | ⬜ 待做 |
| D2 · 上游全死时**保持健康** | V-02b / C-5 | 1 | ⬜ 待做 |
| E · 两个 Primary 全停时入口可用 | SC-001 / V-03 | **3**（两个 Primary 分处两台，加一台发交易） | ⬜ 待做 |
| F · 单验证者失效不回归 | SC-006 / V-04 | 1 | ⬜ 待做 |
| G · 恢复能力提示的出现与消失 | SC-002/003/004 / V-05 | **3** | ⬜ 待做 |
| H · 档位零影响 | FR-013 / V-07 | 0（单元） | ⬜ 待做 |
| I · 变红检查全表 | 契约 §8 | 0（单元） | ⬜ 待做 |
| J · 协议零改动 | SC-008 / V-08 | 1 | ⬜ 待做 |
| K · 两种形态各验一次 | R-08 / V-09 | 1 + 5 | ⬜ 待做 |
| L · 文案与 §9.5 一致 | SC-010 / V-10 | 0（单元） | ⬜ 待做 |
| M · 一个没见过的人 | SC-009 | 1 + 一名他人 | ⬜ 待做 |

**前置**：链在运行，七个节点健康。当前（2026-09-11）五台机器均不可达 ——
所有需要链的场景都要等环境回来。

---

## A · 配置能加载

```bash
npm run render                     # 重新生成 nginx 配置与 compose
npm run render:check               # 10 项生成物必须与 protocol.json 一致
scripts/devnet-start               # 或只重建代理：docker compose -f <形态> up -d rpc
```

**期望**：`render:check` 全绿；代理容器起来后 `nginx -t` 无错；
容器内 `wget -q -O - http://127.0.0.1:<port>/_alive` 退出码 0。

**不期望**：任何节点容器被重启（FR-032）。重建前后 `docker ps` 的节点
`CREATED` / `STATUS` 起始时刻应保持不变。

---

## B · 探测不碰上游（本期的核心判据）

```bash
# 让 healthcheck 跑几轮（interval 10s），期间不要发任何真实请求
# 然后看上游节点的访问日志里有没有来自代理的探测条目
scripts/devnet-logs l1-1 | tail -40
# 再看代理自己的日志：新位置的条目不应带 upstream 字段
docker logs --tail 40 karmachain-rpc-<domain>
```

**期望**：上游日志里**没有**探测条目；代理日志里该位置**没有** `upstream`。

**紧接着验 C-2**：

```bash
# 探测已跑满数个 fail_timeout 周期后，发真实请求
scripts/devnet-contracts        # 或任意经入口的交易
```

**期望**：全部 200，日志里**没有** `no live upstreams`、
**没有** `upstream server temporarily disabled`。

> 这两条合起来就是范围 A 的全部。修之前的现场是：代理日志里
> 每 10 秒一条 `GET /ext/health … 502`（User-Agent `Wget`），
> 夹杂着 `upstream server temporarily disabled` 四连，以及真实流量的 502。

---

## C · 静态守卫

```bash
npm test          # 单元层
```

**期望**：新守卫存在且通过 —— 断言 `/ext/health` 不出现在
`tools/protocol/render-compose.mjs` 的代理健康判定处、
也不出现在六份生成的 compose 里。

**变红检查**：把那个字符串加回去，确认守卫失败。

> **扫源码前先剥注释。** 003 期间这一条栽过三次 ——
> 解释性注释里出现的字符串被当成了真的配置。

---

## D · 代理健康位会变红

**判据已定**（[R-03](./research.md) 2026-09-11 拍板）：验的是 **nginx 自己**死了或配置坏了。

**① 配置改坏**：

```bash
# 让 nginx 的配置坏掉（只在临时副本上做，别改生成物）
docker exec <代理容器> sh -c 'echo "garbage" >> /etc/nginx/conf.d/karmachain.conf'
docker restart <代理容器>
docker inspect <代理容器> --format '{{.State.Health.Status}}'
```

**期望**：`unhealthy`。

**② 杀掉 nginx 进程**：

```bash
docker exec <代理容器> sh -c 'kill 1' || true
docker inspect <代理容器> --format '{{.State.Health.Status}}'
```

**期望**：两条都 `unhealthy`。

**做完把临时改动清掉并从生成物重建。**

> 这一条是 R-01 的风险所在。一个**不看上游**的判据天生更容易变成"永远绿"，
> 所以它必须被显式证明会变红。

---

## D2 · 上游全死时**保持健康**（反向确认）

```bash
# 把本机的全部 L1 验证者停掉（单机形态最容易造）
scripts/devnet-node kill l1-1     # …其余同理
docker inspect <代理容器> --format '{{.State.Health.Status}}'
```

**期望**：`healthy` —— 代理确实在正常履行职责，"链能不能用"不是它回答的问题。

**这一条与 D 同等重要。** D 证明判据会变红，D2 证明它**不会在错误的时候变红** ——
两条合起来才说明职责划分真的落地了，而不只是写在文档里。
只做 D 会漏掉本期最核心的那个纠正。

---

## E · 两个 Primary 全停时入口可用（**需三台机器**）

两个 Primary 分处 ubuntu-1 与 ubuntu-2，单台机器造不出这个场景。

```bash
# ubuntu-1
sudo KARMACHAIN_DOMAIN=ubuntu-1 sh scripts/devnet-node.sh kill primary-1
# ubuntu-2
sudo KARMACHAIN_DOMAIN=ubuntu-2 sh scripts/devnet-node.sh kill primary-2
```

然后在**每一台**机器上，10 分钟窗口内经**本机入口**发 ≥10 笔交易：

```bash
# 记录每次的 HTTP 状态码，任何 5xx 都是失败
```

**期望**：每一笔都确认，**零次 5xx**。

**恢复**（顺序有硬约束，见 `docs/devnet.md` §9.5）：

```bash
# 两台都要起，起一个不够
sudo KARMACHAIN_DOMAIN=ubuntu-1 sh scripts/devnet-node.sh start primary-1
sudo KARMACHAIN_DOMAIN=ubuntu-2 sh scripts/devnet-node.sh start primary-2
```

> **这段窗口里不要重启任何 L1 验证者** —— 它会卡在 `bootstrapping`，
> 直到两个 Primary 都回来才自愈（约半分钟）。

---

## F · 单验证者失效不回归（002 既有能力）

```bash
scripts/devnet-node kill l1-3
scripts/devnet-contracts          # 经入口，应当成功
scripts/devnet-node start l1-3
```

**期望**：交易确认；请求被转到其余健康上游。
**这一条是本期最容易回归的地方** —— 因为 R-02 决定不动故障转移参数，
所以它应当原样保持；若它坏了，说明改动越界了。

---

## G · 恢复能力提示的出现与消失（**需三台机器**）

分三步，每步都要看**五份**面板：

| 步 | 动作 | 期望 |
|---|---|---|
| 1 | 停 primary-1 与 primary-2 | 五份都：档位 `normal/100%`、余量不变、**并且**有恢复能力提示 |
| 2 | **只**起回 primary-1 | 五份都：提示**仍然在**（判据是 `< 2`，不是 `= 0`） |
| 3 | 再起回 primary-2 | 五份都：提示在**一个探测周期内**自行消失，无任何人工操作 |

**第 2 步是本场景的要点。** 它是 `< 2` 与 `= 0` 唯一能在现场区分的一步 ——
少了它，一个写错成 `= 0` 的实现会全程看起来正确。

**顺带验 SC-005**：第 1 步之后重启一个 L1 验证者，第 3 步之后它应在 **≤60 秒**
自行回到健康（2026-09-10 基线约 36 秒）。

---

## H · 档位零影响

```bash
npm test
```

**期望**：一条用例断言恢复能力为 `blocked` 时，
`tier` / `healthPercent` / `validatorMargin` / `domainMargin` /
`participating` / `threshold` **逐字段**与 `ok` 时相同。

---

## I · 变红检查全表

逐行执行 [recovery-capability 契约 §8](./contracts/recovery-capability.md) 的表，
把结果记进 dod。**每一行都要真的做一次。**

---

## J · 协议零改动

```bash
git diff --stat blockchain/protocol.json      # 必须为空
git diff blockchain/genesis/                  # 必须为空
npm run render:check                          # 10/10
scripts/devnet-verify                         # 全部检查项
```

**期望**：`protocol.json` 与创世**逐字节不变**；`configVersion` 未递增；
没有任何节点因 stamp 守卫退出 12。

**同时核对节点容器未被重启**（FR-032）。

---

## K · 两种形态各验一次

| 形态 | 在哪 | 验什么 |
|---|---|---|
| `local` | 单台机器 | e2e 全套（本期新增的自动化判据都跑在这里） |
| `lan` | 五台机器 | 场景 A / B / E / F / G / J |

> **"在一台机器上验过"不等于"验过"。** 003 在 win-2 上连撞四次才跑通，
> 其中三项是被 win-1 掩盖的 002 遗留缺陷 —— 而本期要修的这个缺陷，
> 当初能活下来正是因为同一个原因。

---

## L · 文案与 `docs/devnet.md` §9.5 一致

```bash
npm test
```

**期望**：一条守卫比对面板文案与 §9.5 的**结论、门槛数字、顺序**。
不是人工核对 —— 人会忘（SC-010）。

---

## M · 一个没见过的人（SC-009）

在两个 Primary 停着的状态下，请一名未参与本期的人打开面板，**不许查文档**，
说出他接下来要做的第一件事。

**期望**：「把两个 Primary 都启动」。

**答不上或答错就改呈现，不改判据。**
