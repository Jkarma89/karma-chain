// tools/protocol/extract-primary-genesis.mjs
//
// 从节点的 flags.json 中解出 Primary Network 创世，产出
// blockchain/chain-identity/primary-network.genesis.json。
//
// 为什么需要它（研究 R-04）：Avalanche CLI 把 Primary Network 创世以 base64 内联在
// `genesis-file-content` 里传给 avalanchego。002 自己拉起 Primary 节点时要用文件形式的
// `--genesis-file`，因此必须先把它解出来固化。它同样是「第二类事实」——initialStakers 的
// NodeID 与 BLS 材料由建链那一刻决定，无法由 protocol.json 推导。
//
// 用法：node tools/protocol/extract-primary-genesis.mjs <node-flags.json> [--out <path>]
//       不带 --out 时打印到标准输出。

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { loadProtocol, readJson, REPO_ROOT } from './load.mjs';

export const OUTPUT_PATH = resolve(REPO_ROOT, 'blockchain', 'chain-identity', 'primary-network.genesis.json');
const FIELD = 'genesis-file-content';

/**
 * 解出并交叉校验 Primary Network 创世。
 * @param {object} flags 节点的 flags.json
 * @param {object} p     已校验的 protocol.json
 */
export function extractPrimaryGenesis(flags, p) {
  const b64 = flags?.[FIELD];
  if (!b64) {
    throw new Error(`node flags has no "${FIELD}"; keys present: ${Object.keys(flags ?? {}).join(', ') || '(none)'}`);
  }

  let genesis;
  try {
    genesis = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch (err) {
    throw new Error(`"${FIELD}" is not base64-encoded JSON: ${err.message}`);
  }

  const problems = [];
  if (genesis.networkID !== p.avalanche.networkId) {
    problems.push(`networkID: genesis ${genesis.networkID}, protocol.json ${p.avalanche.networkId}`);
  }
  const stakers = genesis.initialStakers ?? [];
  if (stakers.length !== p.primaryNetwork.nodeCount) {
    problems.push(`initialStakers: genesis has ${stakers.length}, primaryNetwork.nodeCount is ${p.primaryNetwork.nodeCount}`);
  }
  const ids = stakers.map((s) => s.nodeID);
  if (new Set(ids).size !== ids.length) problems.push('initialStakers[].nodeID must be unique');

  if (problems.length) {
    throw new Error(`primary network genesis does not match protocol.json:\n  - ${problems.join('\n  - ')}`);
  }

  return genesis;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const oi = args.indexOf('--out');
  const flagsPath = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
  if (!flagsPath) {
    console.error('usage: node tools/protocol/extract-primary-genesis.mjs <node-flags.json> [--out <path>]');
    process.exit(10);
  }

  try {
    const genesis = extractPrimaryGenesis(readJson(resolve(flagsPath)), loadProtocol());
    const text = `${JSON.stringify(genesis, null, 2)}\n`;
    if (oi !== -1) {
      const out = resolve(args[oi + 1] ?? OUTPUT_PATH);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, text);
      console.log(`wrote ${out}`);
      console.log(`  networkID ${genesis.networkID}  initialStakers ${genesis.initialStakers.length}`);
    } else {
      process.stdout.write(text);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
