# DEVELOPMENT ONLY — KarmaChain local devnet validator key material

**绝不可用于任何真实网络。** 这些密钥公开存放于版本库，仅在本地开发网络（Network ID 1337 / Chain ID 20189）中有效；依据宪法第四条 v1.1.0 例外条款提交。

| 项 | 值 |
|---|---|
| 节点序号 | node-4（protocol.json validators.nodes[3]） |
| NodeID | NodeID-7Wioqad7SdYpp51WugCWmqtwpehjnpWs7 |
| 容器内 HTTP 端口 | 9666 |
| staker.crt / staker.key | 节点 TLS 证书与私钥（PEM，决定 NodeID） |
| signer.key | BLS 签名私钥（32 字节原始二进制） |
| 来源 | 由 Avalanche CLI v1.9.6 在 T011 冒烟中生成，T012 提取（2026-09-01） |
