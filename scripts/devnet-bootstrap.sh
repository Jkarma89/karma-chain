#!/usr/bin/env sh
# scripts/devnet-bootstrap.sh —— 一次性建链（功能 002 / T047）
#
# 这是仓库中唯一会用到 Avalanche CLI 的地方，跑完即退。它做三件事：
#   1. 在 P 链上创建 Subnet 与 Blockchain
#   2. 把结果**播种进 7 个节点卷** —— 那两笔交易只存在于节点数据库里，
#      节点从空卷启动会得到一条没有该 Subnet 的新 P 链（研究 R-04）
#   3. 产出 blockchain/chain-identity/ 下的制品
#
# 默认拒绝覆盖已有制品：重新建链会换掉链身份，与现有链数据不再匹配。
set -eu
cd "$(dirname "$0")/.."

command -v docker >/dev/null 2>&1 || { echo "devnet-bootstrap: docker not found" >&2; exit 10; }
command -v node   >/dev/null 2>&1 || { echo "devnet-bootstrap: 需要 Node（提取制品）—— 见 package.json engines" >&2; exit 10; }

BOOTSTRAP=./docker/compose/bootstrap.yml
[ -f "$BOOTSTRAP" ] || { echo "devnet-bootstrap: $BOOTSTRAP 不存在 —— 先运行 'npm run node:render'" >&2; exit 10; }

if docker ps --format '{{.Names}}' | grep -q '^karmachain-'; then
  # 退出码 10（前置条件未满足），**不是 11**：契约里 11 专指宿主端口冲突
  # （specs/001-…/contracts/cli-interface.md）。此前误用 11，会让"端口被占"与
  # "节点还在跑"这两件毫不相干的事映射到同一个码上。
  echo "devnet-bootstrap: 仍有节点在运行 —— 先执行 scripts/devnet-stop" >&2
  exit 10
fi

docker compose -f "$BOOTSTRAP" run --rm bootstrap "$@"

echo
echo "devnet-bootstrap: 提取制品 ..."
node tools/protocol/extract-identity.mjs       .devnet/bootstrap/sidecar.json   --out blockchain/chain-identity/karmachain.identity.json
node tools/protocol/extract-primary-genesis.mjs .devnet/bootstrap/node-flags.json --out blockchain/chain-identity/primary-network.genesis.json
# 建链改变了 chain-identity 制品，因此重新生成全部派生物。
# 与 .ps1 版本保持同一入口（那边不能用 npm —— StrictMode 会弄坏 npm.ps1 shim）。
node tools/protocol/render-all.mjs >/dev/null

echo
echo "devnet-bootstrap: 完成。下一步：scripts/devnet-start"
