# 功能 001 验收报告：本地可复现的 Avalanche L1 开发网络

**日期**：2026-09-02 · **configVersion**：1.1.0 · **创世哈希**：`0x19cfde1f02e585020cdae83071bac33c7d81e411cacf7f306b82ceabe98892ed`

**环境 A**：Windows 10 Pro 19045，Docker Desktop 29.7.2，Compose v5.4.0，amd64
**环境 B**：macOS，Docker Desktop（SC-002 在 configVersion 1.0.0 下验证通过）

---

## 一、Quickstart 场景（`quickstart.md` A–G）

| 场景 | 内容 | 结果 |
|---|---|---|
| **A** 一键启动 | 重置后 `devnet-start` 至 READY | ✅ **80 秒**（快照恢复 16 秒；已运行时幂等返回 2 秒） |
| **B** 标准工具连接 | viem（集成测试 5/5）、Foundry `cast` v1.8.1（chainId 20189、转账 status 1 / gasUsed 21000 / **2 秒**）、MetaMask（手工，费 0.0005 KARMA = 21000×25 gwei、约 3 秒） | ✅ 三类工具零适配 |
| **C** 自动化验证 | `devnet-verify` 13 项 | ✅ **13/13，9.6 秒** |
| **D** 重置与状态保留 | reset→start ×10 创世哈希全等；stop→start 高度延续 | ✅ **10/10 一致**，2/2 通过 |
| **E** 参数唯一来源 | 单元 62/62（含漂移与全库字面量扫描）；改 chainId 闭环 e2e | ✅ 违规 0 处；闭环 1/1 |
| **F** 可观测与故障分类 | 五类故障注入 + 类别断言 | ✅ **6/6** |
| **G** 安全边界 | 仓库 + 运行时日志秘密扫描 | ✅ **8/8** |

## 二、Success Criteria

| # | 要求 | 实测 | 结论 |
|---|---|---|---|
| SC-001 | 启动 ≤ 5 分钟（首次含拉取 ≤ 15 分钟） | 80 秒（快照恢复 16 秒） | ✅ |
| SC-002 | 两个独立环境创世哈希/链 ID/代币/余额 100% 一致 | Windows 与 macOS 逐项一致（1.0.0 下执行；机制未变） | ✅ |
| SC-003 | 连续 10 次重置→启动创世哈希完全一致 | **10/10 一致**（configVersion 1.1.0，创世 `0x19cfde1f…92ed`）；启动 75/75/75/75/75/75/75/75/76/77 秒，max 77 秒。1.0.0 下亦曾 10/10 | ✅ |
| SC-004 | ≥ 3 种主流 EVM 工具零适配完成读→发→确认 | viem / cast / MetaMask 均通过 | ✅ |
| SC-005 | 验证全项通过且 ≤ 3 分钟 | 13/13，**9.6–22 秒** | ✅ |
| SC-006 | 转账提交到确认 ≤ 10 秒 | cast 2 秒、MetaMask 约 3 秒、viem 0.1–4 秒 | ✅ |
| SC-007 | 协议参数仅一处权威定义，0 处独立硬编码 | `no-hardcode` 扫描 0 违规（白名单均登记理由） | ✅ |
| SC-008 | 新成员仅凭文档首次启动并部署合约 | 文档就绪（README 三步 + `docs/devnet.md`）；环境 B 由另一台机器独立按文档启动成功 | ✅（团队扩充后可再取样） |
| SC-009 | 无未标记的私钥/助记词；日志 0 命中 | 秘密扫描 8/8，含"`--raw` 必须暴露"的反向断言 | ✅ |
| SC-010 | FR-012 十个 RPC 方法 0 个"未知" | 10/10 supported，已回填契约表 | ✅ |
| SC-011 | 每类可复现故障归入正确 FR-030 类别 | 5 类注入 + 类别集合守卫，6/6 | ✅ |

## 三、Definition of Done（宪法第十七条）

| # | 条件 | 证据 |
|---|---|---|
| 1 | **Specification 满足** | 34 条 FR 与 11 条 SC 全部落实并有测试或实测记录；`checklists/requirements.md` 16/16 |
| 2 | **Constitution 满足** | `plan.md` 逐条门禁（20 条）通过；`/speckit-analyze` 发现的 1 个 CRITICAL 已按第十九条修宪解决（第四条 v1.1.0）；无绕过 |
| 3 | **测试通过** | 单元 62、集成 5、e2e 六套（reset×10、param-change、single-validator-down、failure-classification、secret-scan、vm-alloc-drift）全绿 |
| 4 | **安全评估完成** | ADR-0003 记录链身份隔离、密钥泄漏边界、生产分离、日志脱敏；由 `secret-scan` 强制 |
| 5 | **文档更新** | `README.md`、`docs/devnet.md`（8 节含排障与改参流程）、生成的 `docs/protocol-parameters.md`、4 份 ADR |
| 6 | **可观测性完成** | `devnet-status`（7 节点健康/共识/peers，退出码语义）、`devnet-logs`（按节点、脱敏）、`devnet-node`（故障注入）、验证报告 JSON |
| 7 | **部署配置完成** | `docker-compose.yml` + 两个 Dockerfile（5 个组件 sha256 锁定）+ 宿主薄封装（sh/ps1 各 6 个）；离线可启动（GitHub 全域名屏蔽下实测 73 秒） |
| 8 | **无已知严重回归** | 全部测试绿；已知限制与其处置见下 |

## 四、已知限制（均已记录并有处置）

| 限制 | 处置 |
|---|---|
| Avalanche CLI 处于维护模式且官方标记 Deprecated | 版本锁定 + 调用收敛到单文件 + 迁移路径（ADR-0002） |
| 节点只监听容器内回环，`--http-host` 不可配 | socat 主代理 + 每节点代理；`devnet-verify` 需在容器内运行，宿主运行时两项优雅 SKIP |
| avalanchego 把 staking 私钥写进 `main.log` | `devnet-logs` 默认脱敏（raw 7 次 → 0 次）；材料本身是已公开的 dev 密钥 |
| `devnet-node pause` 超过约 1 分钟会拆掉 VM 的 gRPC 连接 | 已在命令帮助与文档标注；长时离线用 `stop` |
| Subnet-EVM 仅到 Cancun（不支持 Pectra） | 编译固定 `evmVersion: cancun`，写入 RPC 契约与 ADR-0001 |
| MetaMask 在 `devnet-reset` 后显示旧余额/脏 nonce | 文档给出必做步骤（切换网络 + 清除活动标签数据） |
| 跨机分布式验证者 | spec 明确 Out of Scope，属未来 Staging/生产功能 |

## 五、实现过程中被测试发现并修复的缺陷

按宪法第八条"代码能编译 ≠ 功能完成"，这些都是手工试用不会暴露、由自动化抓出的：

1. **启动期 SIGTERM 竞态**：READY 摘要打印中收到停止信号会打断命令替换，`avalanche network stop` 未执行 → 快照不含 L1 节点 → 恢复后只剩主网节点。改为启动期延迟处理信号。（reset×10 e2e 发现）
2. **出块检查竞态（两处）**：`eth_blockNumber` 在回执可见后仍可能返回旧值。验证器与集成测试均改为取回执的 `blockNumber`。（第二处在最终验收扫描中发现——第一次只修了验证器）
3. **`hostname -i` 依赖 DNS**：容器 DNS 短暂不可用时 IP 为空 → 7 个代理全部绑定失败 → 启动退出 20。改为直接读网卡，并把每节点代理降级为尽力而为。（故障分类 e2e 发现）
4. **停止的节点从清单消失**：清单依赖 `process.json`，而 tmpnet 在关闭时删除它 → `devnet-node start` 找不到节点。改用持久化的 `flags.json`。
5. **停止的节点被误报 running**：端口检测匹配"任意地址:端口"，撞上同端口的 socat 代理。改为只认 `127.0.0.1` 绑定。
6. **jq 崩溃 / NodeID 误报**：`peers`、`nodeId` 初始化为字面字符串 `"null"`，节点停止时 `tonumber` 报错、NodeID 被判为不匹配。
7. **创世时间戳算错一年**：单元测试的时间常量断言抓出。
8. **报告 schema 不过 Ajv 严格模式**：条件分支未自洽声明 `category`；改为 `$defs` 引用。
9. **三处协议参数硬编码**：全库扫描上线当天抓出（preflight 端口默认值 + 两条注释），全部改为派生而非加白名单。
10. **Host 头 403**：avalanchego `--http-allowed-hosts` 默认只放行 localhost 与 IP 字面量，compose 内用服务名访问被拒。验证器自动解析为 IP，约束写入 RPC 契约。
11. **`devnet-start` 在网络已运行时挂满 300 秒**（最终验收时发现）：容器已在运行时 `docker compose up -d` 是空操作，entrypoint 不会再打印 READY 标记，而封装脚本在等这个标记 → 超时退出 20。已加幂等快路径：探测到容器运行且 RPC 应答即回放上次摘要并退出 0（实测 2 秒）。

## 六、结论

功能 001 满足宪法第十七条全部八项，**可标记为完成**。后续功能（智能合约、索引器、后端、前端、监控）可在此基础上开展，复用：

- RPC 端点契约 `contracts/rpc-endpoint.md`
- 协议参数唯一来源 `blockchain/protocol.json`（+ 生成的 `docs/protocol-parameters.md`）
- 预置开发账户与固定 NodeID
- 13 项验证器作为回归基线
