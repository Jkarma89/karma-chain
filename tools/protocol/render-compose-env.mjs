// tools/protocol/render-compose-env.mjs —— 由 protocol.json 生成 blockchain/compose.env（tasks T029）。
// 该文件同时被三方消费，使宿主侧不出现手写的端口字面量（FR-017 / SC-007）：
//   1) scripts/*.sh 直接 `.`（source）它取默认值；
//   2) scripts/*.ps1 逐行解析；
//   3) docker compose 经封装脚本以 `--env-file blockchain/compose.env` 读取（用户 .env 在其后加载可覆盖宿主端口）。
// 之所以提交到仓库而非放 .devnet/：新开发者只装 Docker、没有 Node，无法现场生成（SC-008）。
// docker-compose.yml 中保留的 `:-` 兜底字面量由 tests/unit/docs-drift.test.mjs 与 protocol.json 锁定同步。
// 用法：node tools/protocol/render-compose-env.mjs [--check]

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadProtocol, REPO_ROOT } from './load.mjs';

export const COMPOSE_ENV_PATH = resolve(REPO_ROOT, 'blockchain', 'compose.env');

export function renderComposeEnvText() {
  const p = loadProtocol();
  return `# GENERATED FROM blockchain/protocol.json by tools/protocol/render-compose-env.mjs — DO NOT EDIT.
# 宿主覆盖请写 .env（见 .env.example）；本文件提供由协议参数派生的默认值。
KARMACHAIN_RPC_PORT=${p.endpoints.hostRpcPort}
KARMACHAIN_CONTAINER_RPC_PORT=${p.endpoints.hostRpcPort}
KARMACHAIN_STARTUP_TIMEOUT=300
`;
}

export function checkComposeEnv() {
  const expected = renderComposeEnvText();
  let actual = null;
  try { actual = readFileSync(COMPOSE_ENV_PATH, 'utf8'); } catch { /* absent */ }
  return { same: actual === expected, expected };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { same, expected } = checkComposeEnv();
  if (process.argv.includes('--check')) {
    if (same) { console.log(`compose.env up to date: ${COMPOSE_ENV_PATH}`); process.exit(0); }
    console.error('compose.env DRIFT: run npm run protocol:render'); process.exit(1);
  }
  writeFileSync(COMPOSE_ENV_PATH, expected);
  console.log(`wrote ${COMPOSE_ENV_PATH}`);
}
