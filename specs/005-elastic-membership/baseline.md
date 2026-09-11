# 基线快照（T002）—— 分家**之前**的状态

**取样时刻**：2026-09-11，提交 `6b82b36`（005 的规格/计划/任务完成、**尚未动任何代码**）

**为什么必须先于一切改动**：SC-001（stamp 六项逐字节不变）与
**SC-003（全部生成物逐字节相同）** 都是「与改动前比对」的判据。
事后再抓就只剩推断 —— 而 SC-003 是本期**最强的不回归判据**。

> **按文件全集枚举，不按"要找的东西"去 grep。** 004 的基线是用
> `grep ext/health docker/compose/*.yml` 抓的，漏掉了第七份 compose
> （`bootstrap.yml`，它恰好不含那个串）—— 于是守卫在第一次跑时就变红了。
> 本文件的清单由**遍历 10 个渲染器的输出目标目录**得到，共 **41** 个文件。

---

## 1. stamp 六项（SC-001 的比对基准）

| 项 | 值 |
|---|---|
| `configVersion` | `1.4.0` |
| `chain.chainId` | `20189` |
| `avalanche.networkId` | `1337` |
| `chain.blockchainName` | `karmachain` |
| 创世文件 sha256 | `a265d8d3f4ebfaaa20b123a7956e99cb427e7bb02e18c0edbf1248ff96229742` |
| 创世区块哈希 | `0x19cfde1f02e585020cdae83071bac33c7d81e411cacf7f306b82ceabe98892ed` |

**这六项在整个 005 期间必须逐字节不变。** 任一项变了，说明分家碰到了协议层 ——
而那会让七个节点退出 12、逼出一次全链重置。

`blockchain/protocol.json` 的 sha256（**会变**，因为要移出字段）：
`58882ff33c6783fbe086144ec5f5e552688a562b6cbd82834b70b3f3d86f7427`

---

## 2. 全部生成物的指纹（SC-003 的比对基准）

**共 41 个文件。** 分家之后重新渲染，这张表必须**逐行一致**。

| 文件 | sha256 |
|---|---|
| `blockchain/compose.env` | `7f58cb50071b918d9d664f7b274ea7e428bd4e5b2939491e05931b0b95091c4c` |
| `blockchain/genesis/README.md` | `339431160ac95e3931a19be7f40fb80c9ab7dcdb34a857f7b2de27d74d8ebd6c` |
| `blockchain/genesis/karmachain.genesis.hash` | `50bc8792c19e7f3db3333b0a00f3d8290273cb916170f873c42f6c3e5cfff989` |
| `blockchain/genesis/karmachain.genesis.json` | `a265d8d3f4ebfaaa20b123a7956e99cb427e7bb02e18c0edbf1248ff96229742` |
| `blockchain/genesis/validator-manager.alloc.json` | `dd2d66a3b4b609085378684b74b8cf246007015ef06d8099030eb0cd7d20b3ea` |
| `blockchain/nodes/aliases.json` | `9bf7fd5d4c1b80d4eebd05c1155639f03409d983ea931c143e2cdd2c5e185127` |
| `blockchain/nodes/chain-config/Wd8yzG1cggbUi2nqKC5RzJM8Vz8w7CEisxcvMRJiWwRVLhTqd/config.json` | `af0be8a7dcbc4833b96f02e029a1875ca5892c91708c2fbe339881509276d253` |
| `blockchain/nodes/l1-1.identity.json` | `29a1c36dcff6c2757e2b2b9c53e7718653b5704377d2219956dfbfc053dfb382` |
| `blockchain/nodes/l1-2.identity.json` | `a3a389c152a38f4788bb3055e1f1d08cd7fbfca909e6403ddec42dd9d7bdc15c` |
| `blockchain/nodes/l1-3.identity.json` | `e0bf0667d560fae0a8579eaedf510b89e498be524cff48a255e1139630f47511` |
| `blockchain/nodes/l1-4.identity.json` | `b0b1e0713e91d0fa144673b9877938d1f45edf22fe5c88d1fac1b82da0481f28` |
| `blockchain/nodes/l1-5.identity.json` | `8559aae31b855b8438048daf20bf5c509b48e780e267b885097c164522b55d24` |
| `blockchain/nodes/lan/l1-1.flags.json` | `3c67c8b1a4833d6007c73ec5f67ce0e54fdacb00c7f3e0482d5aa5f9a7acc754` |
| `blockchain/nodes/lan/l1-2.flags.json` | `114fe1191789536d902fbdddc46bebcbb688a8d8e952d99d84deba332c66d3cb` |
| `blockchain/nodes/lan/l1-3.flags.json` | `4658d2678b705bd8aa561c8efb27c83a1de6864371b364db282a262c6795a296` |
| `blockchain/nodes/lan/l1-4.flags.json` | `0b19024d75f13df9ed3bdfa5f8d320885d0f5cc69713d6e1e20b0ccdd01c716d` |
| `blockchain/nodes/lan/l1-5.flags.json` | `232fee4bea1b967fa2719c81424e2d20b2361252b28792f3becf01ab1bda4c85` |
| `blockchain/nodes/lan/primary-1.flags.json` | `223b52c7ed14051e840fb5269bfb87deb60232017970ed97668047c883a8dc3b` |
| `blockchain/nodes/lan/primary-2.flags.json` | `a78578dfc0d31b7291d7cacdc6b9c85a7ff4b492a97a1c6f6fb06ccee87b5b94` |
| `blockchain/nodes/lan/rpc-proxy.conf` | `5de0dfbe1450423eeae7a6c55d1d2303c68eb13382b750a71cb93bc2a7b4e4d3` |
| `blockchain/nodes/local/l1-1.flags.json` | `2d6459f6d8bbdc46bbb7773ad1423c8a37efdef3ff6b3dee4c091ccd9dadb8ee` |
| `blockchain/nodes/local/l1-2.flags.json` | `52c6e57985c54a3655e271cdd376a327f756a62ec25a2014e95aef38b2c05c87` |
| `blockchain/nodes/local/l1-3.flags.json` | `220adef9acbd89aa0cc17702cabfdb50c19909e4ab60395c73113c5ff79947bd` |
| `blockchain/nodes/local/l1-4.flags.json` | `976679d4e50185fcfb711006193fe170f817e7ec271c87840a465285694a9fae` |
| `blockchain/nodes/local/l1-5.flags.json` | `44652b000f35cff82252f48e6293ee14105fdf9bb227c86faf491995db15a392` |
| `blockchain/nodes/local/primary-1.flags.json` | `d67ea80ae87a8918d8b7db2ab48db49557dd84fbf3a5b6ded64e0ccd5e8b6919` |
| `blockchain/nodes/local/primary-2.flags.json` | `074394cfcc394933b215d4cb3eb1af7e69faea77bc97feec21e918390f7a78b0` |
| `blockchain/nodes/local/rpc-proxy.conf` | `5dfde4036c01fbc3ee6221989803daa969315f00f0a2387657efb4c4880f1234` |
| `blockchain/nodes/primary-1.identity.json` | `d4a0924cf14c683bfcaa481bb72b582ec4601d093798435368df81b255f89577` |
| `blockchain/nodes/primary-2.identity.json` | `7daa48d67c1a478a3249801fda82ff3220f31a8da872cd56c18de82ce637c788` |
| `docker/compose/active.env` | `60ff67689d6cf7cbd2d0df2ae1781679a8f759915fb836647b596c680d104fb1` |
| `docker/compose/bootstrap.yml` | `e829c1bd19725fcfd5dfd500cf73648e0880f1b422c4f738887cb98065aeb9c1` |
| `docker/compose/lan-ubuntu-1.yml` | `450a85a8875f5f353857b5ed6a3b81eab2f2bd17a413031fdbd3a1242a24da06` |
| `docker/compose/lan-ubuntu-2.yml` | `23362e8774630d55e0b6fbb581b873c411893df0df4b65abaa7ce100a27b386e` |
| `docker/compose/lan-ubuntu-3.yml` | `bd536e868d10f3fc27354f4a6c1ee2ffa68e02953d8413adec022b907596484a` |
| `docker/compose/lan-win-1.yml` | `64127b9ae9d5dc55325394cd6d86c7d0b2f20c7897e0177d728ab6ee8b89a832` |
| `docker/compose/lan-win-2.yml` | `39c5bc160ba1f360804f7248d0ade2513da3aaabe48f15a701e377b9c955b71b` |
| `docker/compose/local-local.yml` | `4e29845c5bbd303bc4181b9c5d3d253f6ec669240c7c2ff2a822415c3af52207` |
| `docs/protocol-parameters.md` | `73aecfc093dbfc76ec17c421c59c97ddcbbb7abffcb5a3357723868c9d4e8baa` |
| `docs/public/chain-info.json` | `2dc0611c37f1bf014ec06e65fbf0f47d063fb9ccea7a273b3608e4f70281449c` |
| `docs/public/developer-quickstart.md` | `f52b9a22f3ba253f0cbec6e6f201947446215703f47034fb44da0bd7ea7827db` |

### 唯一预期会变的一项

按 [research R-10](./research.md) 的决定，`docs/protocol-parameters.md`
**也要保持逐字节相同** —— `render-docs.mjs` 改成读两个文件（T063）。
**所以这张表没有例外行**：全部 41 个文件都必须一致。

若实施时发现某一项"不得不变"，那是一个**需要先解决的设计问题**，
不是一个可以加例外的地方 —— SC-003 是本期最强的判据，
在它身上开口子等于放弃"只搬家、不改行为"这个承诺。

---

## 3. 节点容器的创建/启动时刻（FR-032 的比对基准）—— **逐台各记一份**

`docker` 只能看**本机**容器，所以这一项必须每台机器自己记
（004 的 `/speckit-analyze` 的 D2 就是这条）。

**win-1（本机，取样时）**：

```
（取样时 docker 不可用 —— 实施前补记）
```

**其余四台**在各自重建容器前后各跑一次，两次输出必须逐字符相同：

| 边界 | 本边界的节点容器 |
|---|---|
| win-2 | `karmachain-l1-2` |
| ubuntu-1 | `karmachain-l1-3`、`karmachain-primary-1` |
| ubuntu-2 | `karmachain-l1-4`、`karmachain-primary-2` |
| ubuntu-3 | `karmachain-l1-5` |

```bash
docker inspect --format '{{.Name}} {{.Created}} {{.State.StartedAt}}' <容器名>
```

**判据是时刻，不是状态**：漏了服务名把节点一起重建时，容器仍然"在跑"，
而 `StartedAt` 已经变了。

---

## 4. 测试基线

| 层 | 分家前 |
|---|---|
| 单元 | **736 / 736**，零跳过 |
| 生成物一致性 `render:check` | **10 / 10** |
| 秘密扫描 | **8 / 8** |
| `devnet-verify` | 14/14（004 期间实测 4/5 次 READY，1 次瞬时失败已记在 004 的 dod 第六节第 12 条） |

**FR-031 的判据**：本期结束时单元数 **≥736 且无既有断言被放宽**。
数字只增不减是必要条件，不是充分条件。

---

## 一次险情（2026-09-11，记录在案）

生成本文件的脚本**没有校验模式**，只有写入模式。实施到 US1 中段时我把它
当成"核对基线"跑了一遍，**基线被当场重写**——如果此时有任何生成物已经漂移，
那次重写会把"分家前的值"悄悄换成"现在的值"，然后据此宣布两者一致。

这次损失为零，而且可以证明：`git status` 显示 41 个生成物**相对提交 `6b82b36`
一个字节都没改**（`docker/compose/`、`blockchain/nodes/`、`blockchain/compose.env`、
`blockchain/genesis/`、`docs/protocol-parameters.md`、`docs/public/` 全部干净），
所以重写出的哈希与原来逐字节相同。

**为此本文件被提交进 git** —— 之后再有一次误跑，`git diff` 会立刻显形。
基线的价值全在"它比被比较的东西更早固定"；一份可被随手覆盖的基线不是基线。
