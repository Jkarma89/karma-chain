// tools/protocol/render-aliases.mjs
//
// 生成 blockchain/nodes/aliases.json —— avalanchego 的 --chain-aliases-file，
// 把 BlockchainID 映射到对外公布的链别名。
//
// 为什么显式声明（研究 R-05）：`docs/public/chain-info.json` 对第三方公布的是
// /ext/bc/karmachain/rpc。该路径当前能用是靠 avalanchego 依链名自动建别名 —— 隐式行为，
// 卷里找不到 aliases.json，也无法漂移测试。显式化之后：
//   1. 别名成为版本控制下的配置，上游默认行为变化不会静默打断对外地址；
//   2. 对外路径与内部标识解耦 —— 即便某项输入变化导致 BlockchainID 改变，公布的地址不受影响。
//
// 用法：node tools/protocol/render-aliases.mjs [--check]

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { loadProtocol, readJson, REPO_ROOT } from './load.mjs';

export const OUTPUT_PATH = resolve(REPO_ROOT, 'blockchain', 'nodes', 'aliases.json');
const IDENTITY_PATH = resolve(REPO_ROOT, 'blockchain', 'chain-identity', 'karmachain.identity.json');

export function renderAliases(p = loadProtocol(), identity = readJson(IDENTITY_PATH)) {
  // 别名必须与 endpoints.rpcPath 中的那一段一致，否则第三方拿到的地址会失效（FR-024）
  const alias = identity.chainAlias;
  const expectedPath = `/ext/bc/${alias}/rpc`;
  if (p.endpoints.rpcPath !== expectedPath) {
    throw new Error(`chain alias "${alias}" does not match endpoints.rpcPath (${p.endpoints.rpcPath}); expected ${expectedPath}`);
  }
  if (alias !== p.chain.blockchainName) {
    throw new Error(`chain alias "${alias}" does not match chain.blockchainName "${p.chain.blockchainName}"`);
  }
  return { [identity.blockchainId]: [alias] };
}

const text = (aliases) => `${JSON.stringify(aliases, null, 2)}\n`;

export function checkAliases() {
  const expected = renderAliases();
  let actual = null;
  try { actual = readFileSync(OUTPUT_PATH, 'utf8'); } catch { /* absent */ }
  return { same: actual === text(expected), expected };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { same, expected } = checkAliases();
  if (process.argv.includes('--check')) {
    if (same) { console.log(`chain aliases up to date: ${OUTPUT_PATH}`); process.exit(0); }
    console.error('chain aliases DRIFT: run npm run node:render');
    process.exit(1);
  }
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, text(expected));
  const [id, names] = Object.entries(expected)[0];
  console.log(`wrote ${OUTPUT_PATH}`);
  console.log(`  ${id} -> ${names.join(', ')}`);
}
