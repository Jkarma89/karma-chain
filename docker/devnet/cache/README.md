# Avalanche CLI 下载缓存模板（离线可复现，research V-2）

Avalanche CLI v1.9.6 在 `create` / `deploy` 期间会向 GitHub 查询若干组件的 "latest" 版本并写入
`~/.avalanche-cli/download-cache/latest.json`（有效期 3 小时，`constants.DownloadCacheExpiration`），
其中 **signature-aggregator** 的版本没有任何命令行标志可以锁定（`DefaultSignatureAggregatorVersion = latest`）。

为满足宪法第七条（可复现）与第十三条（依赖锁定），本目录保存 2026-09-01 观测到的缓存内容，
`lib/binaries.sh` 在每次容器启动时把它复制进卷并刷新 mtime，使 CLI 视缓存为有效、不再联网：

| 文件 | 作用 | 锁定的版本 |
|---|---|---|
| `latest.json` | "latest" 版本解析结果 | avalanchego **v1.14.1**、subnet-evm **v0.8.0**、signature-aggregator **v0.5.3**、icm-relayer v1.7.4（不使用） |
| `min_cli_version.json` | CLI 最低版本检查 | 1.9.3（当前 1.9.6 满足） |

对应二进制/文件由 `Dockerfile` 以 sha256 锁定预置到 `/opt/avalanche/`。
升级任一版本时需同步修改：`blockchain/protocol.json`、`Dockerfile` ARG/SHA、本目录文件、`tools/protocol/load.mjs` 兼容表。
