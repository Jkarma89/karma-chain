#!/usr/bin/env sh
# scripts/devnet-render.sh —— 由唯一事实来源重新生成全部派生物（功能 002 / US5、FR-027）。
#
# 用法：scripts/devnet-render.sh [--check]
#   （无参数）重新生成全部 10 项派生物
#   --check   只检查是否漂移，一次列出**全部**偏离项；有漂移则退出 1
#
# 退出码：0 一致或已生成 | 1 存在漂移 | 10 Docker 不可用
#
# 与 devnet-verify 同一模式在容器内跑，因此宿主不需要装 Node ——
# README 承诺的"唯一前置依赖是 Docker"对"改参数"这条流程同样成立。
# 宿主装了 Node 的话，`npm run render` 等价且更快。
#
# **不要手改生成物**：漂移测试会拦下（tests/unit/docs-drift.test.mjs 等）。
set -eu
cd "$(dirname "$0")/.."
command -v docker >/dev/null 2>&1 || { echo "devnet-render: docker not found" >&2; exit 10; }
exec docker compose run --rm render node tools/protocol/render-all.mjs "$@"
