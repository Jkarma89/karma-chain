// tools/protocol/render-genesis.mjs
// 由 blockchain/protocol.json（唯一事实来源）+ blockchain/genesis/validator-manager.alloc.json（CLI 注入的合约账户 fixture）
// 确定性地生成 Subnet-EVM 创世文件 blockchain/genesis/karmachain.genesis.json（宪法第十六条；research R-07；tasks T014）。
//
// 结构以 Avalanche CLI v1.9.6 `--test-defaults` 生成的参考创世为基底（T011 提取），仅以下字段由 protocol.json 决定：
//   config.chainId、config.feeConfig.*、config.allowFeeRecipients（非默认时才写出）、gasLimit（= feeConfig.gasLimit）、alloc 中的开发账户余额。
// 所有时间戳固定为常量 GENESIS_TIMESTAMP，保证任意时间、任意机器生成的创世哈希一致（SC-002/SC-003）。
//
// 用法：node tools/protocol/render-genesis.mjs [--check]   （--check：只比较不写文件，漂移时退出码 1）

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadProtocol, readJson, REPO_ROOT } from './load.mjs';

export const FIXTURE_PATH = resolve(REPO_ROOT, 'blockchain', 'genesis', 'validator-manager.alloc.json');
export const GENESIS_PATH = resolve(REPO_ROOT, 'blockchain', 'genesis', 'karmachain.genesis.json');

/** 创世时间：2026-09-01T00:00:00Z（= Date.UTC(2026, 8, 1) / 1000）。固定常量 —— 这是创世哈希可复现的前提；改动它 = 协议变更（宪法第十五条）。 */
export const GENESIS_TIMESTAMP = 1788220800;

const ZERO_HASH = '0x' + '0'.repeat(64);
const ZERO_ADDRESS = '0x' + '0'.repeat(40);

/** Subnet-EVM 默认 feeConfig（官方文档 Customize Avalanche L1）。protocol.json 与之不同的字段视为"偏离默认"，仅用于文档标注，不影响生成。 */
export const SUBNET_EVM_DEFAULT_FEE_CONFIG = Object.freeze({
  gasLimit: 15_000_000,
  targetBlockRate: 2,
  minBaseFee: 25_000_000_000,
  targetGas: 15_000_000,
  baseFeeChangeDenominator: 36,
  minBlockGasCost: 0,
  maxBlockGasCost: 1_000_000,
  blockGasCostStep: 200_000,
});

const hex = (n) => '0x' + BigInt(n).toString(16);
const allocKey = (address) => address.toLowerCase().replace(/^0x/, '');

/** 纯函数：protocol + fixture → genesis 对象（键序固定）。 */
export function renderGenesis(protocol, fixture) {
  const p = protocol;
  const fee = p.feeConfig;

  // --- alloc：开发账户（仅余额）∪ fixture 合约账户（code/storage/nonce，余额 0）---
  const alloc = {};
  for (const account of p.devAccounts) {
    alloc[allocKey(account.address)] = { balance: account.balanceWei.toLowerCase() };
  }
  for (const [address, entry] of Object.entries(fixture.alloc)) {
    const key = allocKey(address);
    if (alloc[key]) throw new Error(`fixture contract ${key} collides with a dev account address`);
    alloc[key] = { balance: '0x0', code: entry.code, nonce: entry.nonce ?? '0x1', ...(entry.storage ? { storage: entry.storage } : {}) };
  }
  const sortedAlloc = Object.fromEntries(Object.entries(alloc).sort(([a], [b]) => (a < b ? -1 : 1)));

  // --- config：硬分叉全部自块高 0 激活；Warp 预编译为 ValidatorManager 与 P-Chain 通信所需 ---
  const config = {
    berlinBlock: 0,
    byzantiumBlock: 0,
    chainId: p.chain.chainId,
    constantinopleBlock: 0,
    eip150Block: 0,
    eip155Block: 0,
    eip158Block: 0,
    feeConfig: {
      gasLimit: fee.gasLimit,
      targetBlockRate: fee.targetBlockRate,
      minBaseFee: fee.minBaseFee,
      targetGas: fee.targetGas,
      baseFeeChangeDenominator: fee.baseFeeChangeDenominator,
      minBlockGasCost: fee.minBlockGasCost,
      maxBlockGasCost: fee.maxBlockGasCost,
      blockGasCostStep: fee.blockGasCostStep,
    },
    homesteadBlock: 0,
    istanbulBlock: 0,
    londonBlock: 0,
    muirGlacierBlock: 0,
    petersburgBlock: 0,
    warpConfig: {
      blockTimestamp: GENESIS_TIMESTAMP,
      quorumNumerator: fixture.warpConfig.quorumNumerator,
      requirePrimaryNetworkSigners: fixture.warpConfig.requirePrimaryNetworkSigners,
    },
  };
  if (p.allowFeeRecipients) config.allowFeeRecipients = true; // 默认 false（手续费销毁），与参考创世一致时省略

  return {
    config,
    nonce: '0x0',
    timestamp: hex(GENESIS_TIMESTAMP),
    extraData: '0x',
    gasLimit: hex(fee.gasLimit),
    difficulty: '0x0',
    mixHash: ZERO_HASH,
    coinbase: ZERO_ADDRESS,
    alloc: sortedAlloc,
    number: '0x0',
    gasUsed: '0x0',
    parentHash: ZERO_HASH,
    baseFeePerGas: null,
    excessBlobGas: null,
    blobGasUsed: null,
  };
}

/** 序列化：2 空格缩进 + 末尾换行；这是提交文件与漂移测试的字节级基准。 */
export function serializeGenesis(genesis) {
  return JSON.stringify(genesis, null, 2) + '\n';
}

export function renderGenesisText(protocolPath, fixturePath = FIXTURE_PATH) {
  const protocol = loadProtocol(protocolPath);
  const fixture = readJson(fixturePath);
  return serializeGenesis(renderGenesis(protocol, fixture));
}

/** 与提交文件比较；返回 { same, expected, actual }。 */
export function checkGenesis(genesisPath = GENESIS_PATH) {
  const expected = renderGenesisText();
  let actual = null;
  try { actual = readFileSync(genesisPath, 'utf8'); } catch { /* 文件不存在 */ }
  return { same: actual === expected, expected, actual };
}

// --- CLI ---
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const check = process.argv.includes('--check');
  const { same, expected } = checkGenesis();
  if (check) {
    if (same) { console.log(`genesis up to date: ${GENESIS_PATH}`); process.exit(0); }
    console.error(`genesis DRIFT: ${GENESIS_PATH} differs from render(protocol.json, fixture). Run: npm run protocol:render`);
    process.exit(1);
  }
  writeFileSync(GENESIS_PATH, expected);
  const g = JSON.parse(expected);
  console.log(`wrote ${GENESIS_PATH}`);
  console.log(`  chainId ${g.config.chainId}  gasLimit ${parseInt(g.gasLimit, 16)}  timestamp ${GENESIS_TIMESTAMP} (${new Date(GENESIS_TIMESTAMP * 1000).toISOString()})`);
  console.log(`  alloc: ${Object.keys(g.alloc).length} accounts (${Object.values(g.alloc).filter((a) => a.code).length} contracts)`);
}
