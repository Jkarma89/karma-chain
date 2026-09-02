# ADR-0003：链身份（Chain ID 20189 / 主网预留 20188）与开发密钥的安全边界

**状态**：已接受 · **日期**：2026-09-01（2026-09-02 补充创世分配变更） · **相关**：宪法第四/十四/十五/十六条

## 决定了什么

### 链身份

| 参数 | 值 | 说明 |
|---|---|---|
| 本地开发网 Chain ID | **20189** | 唯一权威定义在 `blockchain/protocol.json` |
| 未来主网 Chain ID | **20188**（预留） | 本地网络**禁止**使用；`load.mjs` 与容器 preflight 双重断言 |
| Avalanche Network ID | **1337** | Avalanche CLI 本地网络的固定值（≠ 主网 1、Fuji 5） |
| 原生代币 | **KarmaCoin / KARMA / 18** | |

两个 Chain ID 于 2026-08-31 在公开注册表 [ethereum-lists/chains](https://github.com/ethereum-lists/chains)（2739 条记录）核实**均未被占用**；相邻的 20261 已被占用，说明该区段并非完全空闲，**正式对外发布前须再次核实并提交注册**。

### 开发密钥

仓库内提交两类公开测试密钥，全部带显著的 `DEVELOPMENT ONLY` 标记：

- `blockchain/accounts/dev-accounts.json`：`ewoq`（Avalanche 官方本地测试账户，兼 PoA 管理员）+ Anvil/Hardhat 默认账户 #0–#4（公开助记词 `test test … junk` 派生）。
- `blockchain/validators/dev/node-{1..5}/`：5 组验证者 TLS 证书/私钥与 BLS 签名密钥（决定 NodeID）。

## 为什么

1. **本地与生产的链身份从第一天就分离**：Chain ID 不同 + Network ID 不同，钱包在技术上不可能把本地链误认为主网，Genesis 也不可能被混用（宪法第四条）。
2. **用生态公开密钥换取零配置**：Anvil 默认账户让 Foundry / Hardhat / viem 的默认配置直接可用（SC-004 实测三类工具零适配）；固定验证者密钥让 NodeID 跨重建一致，日志与文档里的节点身份稳定可引用。
3. **密钥公开是特性而非疏漏**：这些密钥全网已知，任何人都能查到；它们只在 Network ID 1337 / Chain ID 20189 上有效，链上无任何真实价值。

### 宪法第四条的处理

原第四条以绝对措辞禁止提交私钥，与上述做法冲突。这一冲突在 `/speckit-analyze` 中被识别为 CRITICAL，
并按宪法第十九条走了正式修正流程：**第四条 v1.1.0 增补"公开已知的本地开发密钥"例外**，要求同时满足四个条件
（密钥公开已知或仅本地有效、文件带 DEVELOPMENT ONLY 标记、纳入秘密扫描白名单、生产环境技术上不可能接受）。
未走这个流程而直接提交密钥，是"偷偷绕过宪法"（第十八条禁止）。

## 安全边界（明确写下来）

| 边界 | 结论 |
|---|---|
| 密钥泄漏影响范围 | 仅本地开发网络。无真实资产，链可随时 `devnet-reset` 重建 |
| 与真实网络隔离 | Chain ID 20189 ≠ 20188/1/43114；Network ID 1337 ≠ 1/5 |
| 生产环境 | **禁止复用**本地 Genesis、密钥、验证者配置（FR-025）。生产参数另建文件与目录，`protocol.json` 的 `environment` 字段被 schema 限定为 `dev`，容器 preflight 亦断言 |
| 日志 | avalanchego 启动时把 staking 私钥（base64）打进 `main.log`；`devnet-logs` **默认脱敏**（FR-026），实测 raw 中出现 7 次、脱敏后 0 次 |
| 强制手段 | `tests/e2e/secret-scan.test.mjs`：仓库内任何"私钥形态的赋值"都必须是已知的 DEVELOPMENT ONLY 密钥，出现未登记密钥即失败；并断言脱敏后的日志与 READY 摘要无密钥 |

## 考虑过的替代方案

| 方案 | 否决理由 |
|---|---|
| 本地网也用 20188 | 本地与主网链身份相同，钱包/Genesis 存在误用风险 |
| 不提交任何密钥，运行时生成 | NodeID 每次重建都变（日志与文档无法引用固定身份）；Anvil 账户不可用则工具需额外配置，损害 SC-004/SC-008 |
| 自造一套私有测试账户 | 失去"Foundry/Hardhat 默认可用"的全部好处，且仍需提交密钥，安全性并无改善 |
| 不修宪、直接提交密钥 | 违反宪法第十八条"不能偷偷绕过 Constitution" |

## 影响与迁移

- 创世分配变更（2026-09-02，configVersion 1.1.0）：anvil-1/3/4 各 10,000,000、anvil-2 7,500,000，初始供应 6,000,000 → 39,500,000 KARMA。**开发网供应量不代表主网代币经济学**；主网参数将另行规格化。该变更已走宪法第十五条流程（记录于该次提交）。
- 任何链身份参数的改动都会改变创世哈希 → stamp 守卫拒绝旧链数据（退出 12）→ 必须 `devnet-reset`。
- 正式发布前的待办：向 ethereum-lists/chains 提交 20188/20189 注册。
