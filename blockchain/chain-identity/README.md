# `blockchain/chain-identity/` —— 建链制品

**功能 002**。一次性建链的产出，运行期只读。

## 这是「第二类事实」

`blockchain/protocol.json` 是协议参数的唯一事实来源（宪法第十六条），本目录的内容**不是**由它派生的，因为无法派生：BlockchainID 取决于 P 链上 CreateChainTx 的交易 ID，而交易 ID 取决于 P 链彼时的状态。

它们是**某一次建链的身份凭证**，处理方式与 `blockchain/genesis/karmachain.genesis.hash` 相同——生成、提交、漂移测试、启动期校验，而不是每次运行重新推导。

| 文件 | schema |
|---|---|
| `karmachain.identity.json` | [`../chain-identity.schema.json`](../chain-identity.schema.json) |
| `primary-network.genesis.json` | avalanchego 的 Primary Network 创世格式 |

## 启动期交叉校验

节点启动时必须确认制品与身份材料同源（[`node-runtime.md`](../../specs/002-resilient-validator-network/contracts/node-runtime.md)）：

- `bootstrapValidators[].nodeId` ↔ `blockchain/validators/dev/node-N/staker.crt` 派生出的 NodeID
- `bootstrapValidators[].blsPublicKey` ↔ 同目录 `signer.key` 派生出的公钥

任一不符即说明制品与密钥来自不同的两次建链，必须立即拒绝（FR-017），而不是让节点带着错误身份去连网络。
