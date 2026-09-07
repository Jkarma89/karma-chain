# DEVELOPMENT ONLY — KarmaChain local devnet **Primary Network** node key material

**绝不可用于任何真实网络。** 这些密钥公开存放于版本库，仅在本地开发网络（Network ID 1337 / Chain ID 20189）中有效；依据宪法第四条 v1.1.0 例外条款提交。

| 项 | 值 |
|---|---|
| 节点 | primary-1（protocol.json topology.nodes） |
| 角色 | Primary Network（P/C/X 链），**不是 L1 验证者**，不计入容错计算 |
| NodeID | NodeID-7Xhw2mDxuDS44j42TCB6U5579esbSt3Lg |
| 容器内 HTTP 端口 | 9650 |
| staker.crt / staker.key | 节点 TLS 证书与私钥（PEM，决定 NodeID） |
| signer.key | BLS 签名私钥（32 字节原始二进制） |
| 来源 | Avalanche CLI 建链时以 `staking-tls-cert-file-content` 等内联参数注入的本地网络固定密钥，功能 002 / T018 提取（2026-09-06） |

## 为什么必须提交进仓库

`blockchain/chain-identity/primary-network.genesis.json` 的 `initialStakers` 把这两个 NodeID **钉死在创世里**。002 自己拉起 Primary 节点时，若拿不到对应的 staking 材料就复现不出这两个 NodeID，主网络起不来。

在 001 架构下它们不在仓库中也能跑，是因为 Avalanche CLI 把材料以内联 base64 传给了 avalanchego —— 编排工具退出运行时路径后，这条隐式供给随之消失，必须显式化。这与 L1 验证者密钥的处理方式一致（研究 R-03）。

派生值由 `tests/unit/identity-crosscheck.test.mjs` 对照创世逐一校验。
