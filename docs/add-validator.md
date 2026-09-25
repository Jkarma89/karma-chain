# 加一个 L1 验证者 —— 一张从头走到尾的单子

把一台干净的机器变成这条链的下一个 L1 验证者，全程**不重置链、不重启既有节点、不丢链上状态**。

- **这张单子只说怎么做，不说为什么。** 每条结论的来由、每个坑的现场记录，在
  [`docs/devnet.md` §11](./devnet.md)。**卡住了再去翻它，不要先读它。**
- **动手之前先知道这一条**：加验证者**常常买不到任何容错提升**。可同时离线的节点数是
  `f = ⌊n/4⌋`，所以 5→6→7 全都是 1，8→9→10→11 全都是 2。你这次加完 `f` 会不会变，
  查 [`§11.1` 的真值表](./devnet.md)。不变的话你买到的是**别的**东西（多一个故障边界、
  多一个 RPC 入口、多一份数据副本），不是更抗 —— 值不值得由你定，但别以为加了就更抗。
- **耗时** 约 40–70 分钟，其中有一段是干等（聚合器要 60–90 秒才真正可用）。
- **花钱** 只有一步花：P 链注册，实测手续费 0.0000469 AVAX，外加给新成员约 0.1 AVAX 的持续费用。

**你需要**

- 一台干净的 Linux 机器（下文以 Ubuntu 为例），你在上面有 `sudo`，它与其余机器在同一个局域网
- 能访问本仓库
- **每一台既有机器上的一个 shell** —— 第 ⑤、⑦ 步要在每台上各敲一条命令

**一条贯穿全程的规矩：新节点的私钥在目标机器上生成，并且只留在那台机器上。**
经过仓库、聊天窗口、U 盘的只有公开材料（NodeID、BLS 公钥、proof of possession、几个 sha256）。
这条不是建议。

---

## ⓪ 先算出你的数，并抓一份基线

### 你的六个值

打开 `blockchain/deployment.json`，看 `validators.nodes` 的**最后一项**，按下表推出你的值：

| 名字 | 怎么来 | 你的值 |
|---|---|---|
| 序号 | 最后一项的 `index` **+ 1** | |
| 节点 id | `l1-<序号>` | |
| `httpPort` | 最后一项的 `httpPort` **+ 2** | |
| `stakingPort` | 最后一项的 `stakingPort` **+ 2** | |
| `keyDir` | `blockchain/validators/dev/node-<序号>/` | |
| 边界名 | **新开一个**，接着既有命名往后排（`ubuntu-3` → `ubuntu-4` → …） | |

想让机器替你算：

```bash
node -e "const d=require('./blockchain/deployment.json'),l=d.validators.nodes.at(-1);
console.log('序号        ', l.index+1);
console.log('节点 id     ', 'l1-'+(l.index+1));
console.log('httpPort    ', l.httpPort+2);
console.log('stakingPort ', l.stakingPort+2);
console.log('加完之后 n =', d.validators.count+1)"
```

**边界要新开一个，不要塞进既有边界。** 塞进去会让那个边界装 2 个验证者；
n 不够大时这违反「每个故障边界至多 ⌊n/4⌋ 个验证者」，校验器会拦。

### 基线（**结束时要用它证明"既有节点没重启"，事后补不回来**）

在每一台既有机器上：

```bash
docker inspect --format '{{.Name}} {{.Created}} {{.State.StartedAt}}' $(docker ps -q) > ~/before.txt
cat ~/before.txt
```

再在任意一台上记下当前的链状态：

```bash
scripts/devnet-status.sh        # 高度与创世哈希
npm run membership:status       # 当前的 n
```

---

## ① 目标机器：装环境

```bash
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 jq git curl
sudo usermod -aG docker $USER
```

**加完组必须重新登录**（退出 SSH 再连），否则 `docker` 不可用。

**判据两条，都要看：**

```bash
snap list 2>/dev/null | grep -i docker && echo "⚠ 有 snap 版 docker —— 必须卸掉"
docker info -f 'Root={{.DockerRootDir}}'        # 必须输出 /var/lib/docker
```

> **有 snap 版 docker 就在这里停下，先卸。** 它挂不了 `$HOME` 之外的路径，
> 而且**不报错** —— 下一步的容器会写得好好的，宿主侧什么也看不到，
> 看上去像"密钥没生成"。卸法：
>
> ```bash
> sudo snap remove docker
> sudo systemctl enable --now docker.socket docker
> docker info -f 'Root={{.DockerRootDir}}'      # 再查一次，必须是 /var/lib/docker
> ```
>
> `curl` 别漏 —— 第 ⑥ 步的就绪判据用它；缺了会等满 300 秒，然后报一句指向链的错。

---

## ② 目标机器：生成密钥

**仓库要克隆在 `$HOME` 下。**

```bash
cd ~ && git clone <仓库地址> && cd karma-chain
docker build -f docker/node/Dockerfile \
  --build-arg TARGETARCH=$(dpkg --print-architecture) -t karmachain/node:local .
KARMACHAIN_DOMAIN=<你的边界名> tools/membership/gen-node-keys.sh <你的序号>
```

**判据**：它打印出一段 JSON，里面有 `nodeID`、BLS 公钥、proof of possession 和三个 sha256。

**把这段 JSON 抄走**（它全是公开材料，可以贴在任何地方）。
私钥留在 `blockchain/validators/dev/node-<序号>/`，**不提交、不外传、不复制**。

---

## ③ 把公开材料写进声明 —— **一共五处**

在有仓库的任意一台机器上编辑 `blockchain/deployment.json`：

1. `validators.count` —— **加一**
2. `validators.nodes[]` —— 追加一项：`index`、`httpPort`、`stakingPort`、`keyDir`（⓪ 里那几个值），
   再把第 ② 步那段 JSON 的 `identity` 块**原样**放进去
3. `topology.nodes` —— 追加 `{ "id": "l1-<序号>", "role": "l1-validator", "validatorIndex": <序号> }`
4. **当前形态**（跨机部署是 `lan`）的 `failureDomains` —— **新开**一个边界装它，
   填上边界名、`platform`、那台机器的局域网地址、`nodes: ["l1-<序号>"]`
5. **`local` 形态也要安置它** —— 加进它**唯一**的那个边界里。
   **不能给 local 新开边界**：T-5 只在边界数 > 1 时生效，多开一个会让原本合法的单边界当场违规

**第 1 处和第 5 处最容易漏。** 漏了不会静默通过 —— 校验器会明说：

```
constraint: topology has N l1-validator nodes but validators.count is M
constraint: deployment "local": node(s) not assigned to any failure domain: l1-N
```

---

## ④ 重新渲染、跑守卫、推上去

```bash
npm run render && npm test
git commit -am "feat: 加入 l1-<序号>" && git push
```

**判据**：两条都得绿。`npm run render` 会重新生成代理配置、compose、节点 flags ——
**不要手改生成物**，漂移测试会拦。

---

## ⑤ 每一台机器（含新机器）拉代码

```bash
cd ~/karma-chain && git pull
```

**先只拉，别动代理。** 代理的同步要排在"新节点已经能服务"**之后**（第 ⑦ 步），
早一步等于往负载池里放一个连不上的成员。

---

## ⑥ 新机器：起节点

```bash
KARMACHAIN_DOMAIN=<你的边界名> scripts/devnet-start.sh
```

**判据看横幅里的「本机节点」那一节**，不是看 `READY`。
`READY` 说的是"本机那条 RPC 入口通了"，而入口的 upstream 里有**全部**节点 ——
那一声应答完全可能来自别的机器。

---

## ⑦ 每一台机器：让代理认识新节点

**怎么生效分两种，选你那台机器对应的一种：**

**Linux 宿主 —— 必须重建代理容器**

```bash
DOM=<本机边界名>
docker compose -f docker/compose/lan-$DOM.yml up -d --force-recreate rpc
```

> `docker restart`、`up -d`、`nginx -s reload` 三个都**没用**：Docker 对单文件挂载绑的是
> **inode**，而 `git pull` 是"写临时文件 + 改名"的原子替换 —— inode 变了，容器还指着旧的。
> `nginx -s reload` 会打印 `signal process started` **看着像成功，重载的却是旧配置**。

**Windows（Docker Desktop）** —— 文件共享层按路径解析，`git pull` 直接可见：

```powershell
docker exec karmachain-rpc-<本机边界名> nginx -s reload
```

**判据（两边都要跑，且必须等于加完之后的验证者数）：**

```bash
docker exec karmachain-rpc-<边界名> grep -c max_fails /etc/nginx/conf.d/karmachain.conf
```

只重建 `rpc` 一个服务，节点容器不受影响。

---

## ⑧ 起签名聚合器

按需容器，用完就停。放在任意一台能连到 Primary staking 端口的机器上。

```bash
docker build -f docker/aggregator/Dockerfile \
  --build-arg TARGETARCH=$(dpkg --print-architecture) -t karmachain/aggregator:local .
docker run -d --rm --name karmachain-aggregator -p 8646:8646 -p 8647:8647 \
  -v "$PWD/blockchain:/repo/blockchain:ro" karmachain/aggregator:local
```

**然后等 60–90 秒。这一段等待是必须的。**

> **`curl http://127.0.0.1:8646/health` 返回 `up` 不是就绪信号。** 它只说进程活着。
> 实测：重启后 13 秒 `/health` 就是 `up`，而它**一个验证者都没连上** ——
> 第 ⑨ 步会直接报 `accumulatedWeight: 0`，长得和"网络配置错了"一模一样。
>
> 而查连接权重的那条指标**刚起来时根本不存在，而不是 0**。
> "读不到"和"0"是两件完全不同的事：前者是没测到，后者是测到了、很糟。
> 所以别在这儿花时间找指标 —— 等够时间直接往下走，第 ⑨ 步的工具自己会报这个数。

不在本机时用 `KARMACHAIN_AGGREGATOR_URL` 指过去。

---

## ⑨ 走 ACP-77 四步

```bash
scripts/devnet-member.sh add --node-id NodeID-…
```

Windows 上是 `scripts\devnet-member.ps1 add --node-id NodeID-…`，两份等价。

**反复跑同一条命令，每次它做一步然后停下来。** 进度是从链上读的，中断了重跑就接着走。

| 步 | 做什么 | 代价 |
|---|---|---|
| ① | 合约 `initiateValidatorRegistration` | 合约交易，失败即回滚，链上不留中间态 |
| ② | 收集 L1 验证者签名 | **不写链**，失败可无代价重做 |
| ③ | P 链 `RegisterL1ValidatorTx` | **唯一花钱的一步** |
| ④ | 合约 `completeValidatorRegistration` | 合约交易，失败即回滚，可直接重试 |

前置检查会拦下三类情况，**一步都不动链**：两个 Primary 不都在线、新成员的机器没起来、
以及**这次注册会把链停掉**。

> **第三步大概率会先失败一次，报 `signature is invalid` 或"权重不够"。这是正常的，不是你做错了。**
> P 链按 `getHeight()-1` 验 Warp 消息，验证集合整体落后一格，聚合公钥对不上 ——
> **多收签名不管用**，"等一会儿"也不管用（P 链不会自己出块）。
> 工具会给你带 `--nudge` 的那条命令：它先发一笔最无害的交易（转一点 AVAX **给自己**，
> 不碰成员、权益与合约）把 P 链高度推一格，再继续注册。
> `--nudge` **刻意不吃 `--yes`** —— 那是工具替你多发的一笔交易，必须你显式要它。

---

## ⑩ 收尾与验收

```bash
docker rm -f karmachain-aggregator          # 聚合器用完就停
```

**四条验收，缺一条都不算做完：**

```bash
# 1. 成员数变了，而且三侧（声明 / 合约 / P 链）一致
npm run membership:status

# 2. 全链检查全绿，容错行显示新的 n
scripts/devnet-verify.sh

# 3. 既有节点没重启 —— 与 ⓪ 的基线**逐字符**比对；"还在跑"不是判据
docker inspect --format '{{.Name}} {{.Created}} {{.State.StartedAt}}' $(docker ps -q)

# 4. 创世哈希与 ⓪ 一致，高度比 ⓪ 高
scripts/devnet-status.sh
```

第 3 条要在每台既有机器上各跑一次 —— `docker` 只看得见本机的容器。

---

## 出错了去哪儿

| 症状 | 多半是 | 去 |
|---|---|---|
| 生成密钥的容器说成功了，宿主上什么也没有 | snap 版 docker 把挂载换成了空目录 | ① |
| `devnet-start` 等满 300 秒才报错，错误指向链 | 机器上没装 `curl` | ① |
| 校验器说 `count is M` 或 `not assigned to any failure domain` | ③ 的第 1 处或第 5 处漏了 | ③ |
| 新节点起来了，但没有请求打到它 | 代理没重建（`nginx -s reload` 骗了你） | ⑦ |
| 第 ② 步报 `accumulatedWeight: 0` | 聚合器还没连上验证者 | ⑧ |
| 第 ③ 步报 `signature is invalid` / 权重不够 | P 链高度滞后，用 `--nudge` | ⑨ |
| 第 ④ 步静默失败，什么都看不到 | 要把链配置临时调到 `debug` 才有输出 | [`§5.4`](./devnet.md) |
| 别的 | | [`§11.2`](./devnet.md)、[`§6`](./devnet.md) |

**退出码**：`0` 成功 / `10` 前置依赖缺失 / `30` 前置检查未过（**没动链**）/
`31` 某步失败（可重跑）/ `32` 人工中止 / `33` 只读报告发现漂移。

---

## 不在这张单子里的

| 你要做的事 | 去 |
|---|---|
| 退掉一个验证者 | [`§11.3`](./devnet.md) |
| 只加一台观察机 / RPC 入口机（**零改动，不用走本单**） | [`§13`](./devnet.md) |
| 加一个 Primary 节点 | [`§11.1`](./devnet.md) 先读完那一段再决定 |
| 改协议参数（chainId、gas、共识参数…） | [`§8`](./devnet.md) —— 那条路**要重置链** |

**本单做的这件事不需要重置链**：它不碰出生证明那六项（`configVersion`、`chain.chainId`、
`avalanche.networkId`、`chain.blockchainName`、创世文件 sha256、创世区块哈希），
所以不递增 `configVersion`、既有节点不重启、创世哈希不变、链数据不动。
