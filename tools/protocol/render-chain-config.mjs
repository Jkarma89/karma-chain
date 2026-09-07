// tools/protocol/render-chain-config.mjs
//
// 生成 blockchain/nodes/chain-config/<blockchainID>/config.json —— subnet-evm 的链配置，
// 由 avalanchego 的 --chain-config-dir 加载。
//
// **为什么这个文件决定了 US1 成不成立**（实测，2026-09-06）：
// subnet-evm 默认开启修剪（pruning-enabled=true），状态每 commit-interval（默认 4096）个区块
// 才落盘一次。节点被强制杀死时，最近一段区块的状态没提交，重启后回滚到上一个提交点。
// 实测：高度 2 的链被 docker kill 后重启，5 个验证者全部报高度 0 —— 两个区块丢了。
//
// 也就是说「非优雅终止后从自身数据恢复、高度不回退」（FR-002 / FR-003）用默认配置**做不到**。
// 001 从没暴露这一点，是因为它每次都优雅停止；而一旦非优雅停止，整条链本来就起不来了。
//
// 因此本配置关闭修剪（归档模式），每个区块的状态都提交。对一条 5 节点开发链，
// 这点磁盘开销换来的是崩溃后不丢块 —— 这正是本特性的立身之本。
//
// 用法：node tools/protocol/render-chain-config.mjs [--check]

import { writeFileSync, mkdirSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadProtocol, readJson, REPO_ROOT } from './load.mjs';

export const OUTPUT_DIR = resolve(REPO_ROOT, 'blockchain', 'nodes', 'chain-config');
const IDENTITY_PATH = resolve(REPO_ROOT, 'blockchain', 'chain-identity', 'karmachain.identity.json');

/** 与 Avalanche CLI 建链时所用的一致，保持 API 面不变（实测自 chain-config-content）。 */
const ETH_APIS = [
  'eth', 'eth-filter', 'net', 'web3',
  'internal-eth', 'internal-blockchain', 'internal-transaction',
  'internal-debug', 'internal-account',
  'debug', 'debug-tracer',
];

export const FLAT_PATH = resolve(REPO_ROOT, 'blockchain', 'chain-config.json');

/**
 * 链配置的内容 —— 与 blockchainID 无关。
 *
 * 建链时也要用它：Avalanche CLI 从 subnets/<name>/chain.json 读链配置并写进节点数据库。
 * 若建链用默认（修剪）而运行时用归档，就是在一个修剪模式写过的库上切模式 ——
 * 实测会卡在引导中不出来。两处必须同源，这就是把内容单独拆出来的原因。
 */
export function chainConfigContent() {
  return {
    $comment: 'GENERATED FROM blockchain/protocol.json by tools/protocol/render-chain-config.mjs — DO NOT EDIT.',

    // 崩溃后不丢块的关键：关闭修剪，每个区块都提交状态。
    // 默认的 pruning-enabled=true + commit-interval=4096 会让强制终止回滚到上一个提交点。
    'pruning-enabled': false,

    'database-type': 'leveldb',
    'log-level': 'info',
    'eth-apis': ETH_APIS,
  };
}

export function renderChainConfig(p = loadProtocol(), identity = readJson(IDENTITY_PATH)) {
  return { [identity.blockchainId]: chainConfigContent() };
}

const fileFor = (bid) => resolve(OUTPUT_DIR, bid, 'config.json');
const text = (cfg) => `${JSON.stringify(cfg, null, 2)}\n`;

export function checkChainConfig() {
  const expected = renderChainConfig();
  const drift = [];
  for (const [bid, cfg] of Object.entries(expected)) {
    let actual = null;
    try { actual = readFileSync(fileFor(bid), 'utf8'); } catch { /* absent */ }
    if (actual !== text(cfg)) drift.push(`${bid}/config.json`);
  }
  let existing = [];
  try { existing = readdirSync(OUTPUT_DIR); } catch { /* absent */ }
  for (const d of existing) if (!expected[d]) drift.push(`${d} (stale — no such blockchain)`);
  return { same: drift.length === 0, drift, expected };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { same, drift, expected } = checkChainConfig();
  if (process.argv.includes('--check')) {
    if (same) { console.log(`chain config up to date: ${OUTPUT_DIR}`); process.exit(0); }
    console.error(`chain config DRIFT (${drift.join(', ')}): run npm run node:render`);
    process.exit(1);
  }
  mkdirSync(OUTPUT_DIR, { recursive: true });
  for (const d of readdirSync(OUTPUT_DIR)) if (!expected[d]) rmSync(resolve(OUTPUT_DIR, d), { recursive: true });
  for (const [bid, cfg] of Object.entries(expected)) {
    mkdirSync(resolve(OUTPUT_DIR, bid), { recursive: true });
    writeFileSync(fileFor(bid), text(cfg));
  }
  // 建链时用的那一份（与 blockchainID 无关）—— bootstrap 会把它写进 CLI 的 chain.json
  writeFileSync(FLAT_PATH, text(chainConfigContent()));
  console.log(`wrote chain config for ${Object.keys(expected).length} chain(s) to ${OUTPUT_DIR}`);
  console.log('  pruning-enabled=false —— 崩溃后不回滚区块（FR-002 / FR-003）');
}
