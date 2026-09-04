// tools/inspect/list-contracts.mjs
//
// 列出链上所有合约账户：创世内置的 + 运行期部署的。
//
// 填补的空缺：本链目前没有区块浏览器（见 docs/adr/README.md 待决策），"链上有哪些合约"
// 这个问题此前只能临时写脚本扫区块。调试单笔交易用 `cast run <tx>` 已经足够好，
// 但"浏览全链状况"没有替代品，本工具就是那个替代品的最小形态。
//
// 只用公开 RPC + 创世文件，不依赖节点内部状态，因此宿主与容器内都能跑。
//
// 用法：
//   node tools/inspect/list-contracts.mjs [--json] [--from <block>] [--no-probe]
//     --json       机器可读输出
//     --from <n>   只扫 <n> 之后的区块（默认从 1 开始）
//     --no-probe   跳过标准接口探测（省一些 eth_call）

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicClient, protocol, rpcUrl, REPO_ROOT_HINT } from '../verify/lib/rpc.mjs';

/**
 * 解析命令行开关。**每次调用时解析**，不在模块加载时定格 —— 否则 collect() 的行为
 * 会被 import 那一刻的 argv 锁死，调用方（测试、其他工具）再也无法改变它。
 */
export function parseArgs(argv = process.argv.slice(2)) {
  const i = argv.indexOf('--from');
  return {
    asJson: argv.includes('--json'),
    probe: !argv.includes('--no-probe'),
    fromBlock: i !== -1 && argv[i + 1] ? BigInt(argv[i + 1]) : 1n,
  };
}

const GENESIS_PATH = resolve(REPO_ROOT_HINT, 'blockchain/genesis/karmachain.genesis.json');
const CHAIN_INFO_PATH = resolve(REPO_ROOT_HINT, 'docs/public/chain-info.json');

/** 创世里 CLI 注入的合约，按其在合约集中的角色标注（chain-info 只公开前两个）。 */
const GENESIS_ROLES = {
  '0x0c0deba5e0000000000000000000000000000000': 'PoA ValidatorManager implementation',
  '0x0feedc0de0000000000000000000000000000000': 'Validator TransparentProxy (entry point)',
  '0x9c00629ce712b0255b17a4a657171acd15720b8c': 'ValidatorMessages library (internal)',
  '0xa0affe1234567890abcdef1234567890abcdef34': 'Validator ProxyAdmin (internal)',
};

/** 无参 view 函数探测：命中哪些标准接口，用来提示合约类型。 */
const PROBES = [
  { sig: 'name()', ret: 'string' },
  { sig: 'symbol()', ret: 'string' },
  { sig: 'decimals()', ret: 'uint8' },
  { sig: 'totalSupply()', ret: 'uint256' },
  { sig: 'owner()', ret: 'address' },
];

const readJsonMaybe = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

/** 官方合约地址集合（取自公开产物；未列出的一律不是官方合约）。 */
function officialAddresses() {
  const info = readJsonMaybe(CHAIN_INFO_PATH);
  if (!info?.contracts) return new Map();
  return new Map(Object.entries(info.contracts)
    .filter(([k, v]) => !k.startsWith('$') && typeof v === 'string')
    .map(([name, addr]) => [addr.toLowerCase(), name]));
}

async function probeInterfaces(address, probe) {
  if (!probe) return [];
  const { keccak256, toHex, decodeAbiParameters } = await import('viem');
  const hits = [];
  await Promise.all(PROBES.map(async ({ sig, ret }) => {
    try {
      const data = keccak256(toHex(sig)).slice(0, 10);
      const result = await publicClient.call({ to: address, data });
      if (!result.data || result.data === '0x') return;
      const [value] = decodeAbiParameters([{ type: ret }], result.data);
      hits.push(`${sig.replace('()', '')}=${typeof value === 'string' && value.length > 24 ? `${value.slice(0, 10)}…` : value}`);
    } catch { /* 该合约没有这个函数 */ }
  }));
  return hits.sort();
}

/** 并发扫区块，找出所有合约创建交易。 */
async function scanDeployments(from, to, concurrency = 16) {
  const found = [];
  for (let start = from; start <= to; start += BigInt(concurrency)) {
    const batch = [];
    for (let n = start; n < start + BigInt(concurrency) && n <= to; n++) batch.push(n);
    const blocks = await Promise.all(batch.map((n) => publicClient.getBlock({ blockNumber: n, includeTransactions: true })));
    for (const b of blocks) {
      for (const tx of b.transactions) {
        if (tx.to !== null) continue;
        const r = await publicClient.getTransactionReceipt({ hash: tx.hash });
        if (r.contractAddress) {
          found.push({ address: r.contractAddress, block: Number(b.number), deployer: tx.from, txHash: tx.hash, status: r.status });
        }
      }
    }
  }
  return found;
}

/** @param {{fromBlock?: bigint, probe?: boolean}} [opts] 未给出的项回落到命令行开关。 */
async function collect(opts = {}) {
  const { fromBlock, probe } = { ...parseArgs(), ...opts };
  const height = await publicClient.getBlockNumber();
  const official = officialAddresses();
  const genesis = readJsonMaybe(GENESIS_PATH);

  const entries = [];

  // 创世内置
  if (genesis) {
    for (const [addr, alloc] of Object.entries(genesis.alloc)) {
      if (!alloc.code) continue;
      const address = `0x${addr}`;
      entries.push({
        address,
        origin: 'genesis',
        block: 0,
        role: GENESIS_ROLES[address.toLowerCase()] ?? null,
        official: official.has(address.toLowerCase()),
        officialName: official.get(address.toLowerCase()) ?? null,
      });
    }
  }

  // 运行期部署
  for (const d of await scanDeployments(fromBlock, height)) {
    entries.push({
      address: d.address,
      origin: 'deployed',
      block: d.block,
      deployer: d.deployer,
      txHash: d.txHash,
      role: null,
      official: official.has(d.address.toLowerCase()),
      officialName: official.get(d.address.toLowerCase()) ?? null,
    });
  }

  // 现存代码与接口探测
  for (const e of entries) {
    const code = await publicClient.getCode({ address: e.address });
    e.codeSize = code && code !== '0x' ? (code.length - 2) / 2 : 0;
    e.live = e.codeSize > 0;
    e.signals = e.live ? await probeInterfaces(e.address, probe) : [];
  }

  entries.sort((a, b) => (a.block - b.block) || a.address.localeCompare(b.address));
  return { height: Number(height), scannedFrom: Number(fromBlock), entries };
}

function printTable({ height, scannedFrom, entries }) {
  const genesisCount = entries.filter((e) => e.origin === 'genesis').length;
  const deployedCount = entries.filter((e) => e.origin === 'deployed').length;

  console.log(`\nKarmaChain contracts   chainId ${protocol.chain.chainId}   height ${height}   (rpc: ${rpcUrl})`);
  if (scannedFrom > 1) console.log(`  note: deployments scanned from block ${scannedFrom} only`);

  const show = (list, title) => {
    if (list.length === 0) return;
    console.log(`\n${title}`);
    for (const e of list) {
      const flag = e.official ? '[official]' : e.origin === 'deployed' ? '[unlisted]' : '[internal]';
      const size = `${e.codeSize}B`.padStart(8);
      const where = e.origin === 'genesis' ? 'genesis' : `block ${e.block}`;
      console.log(`  ${e.address}  ${size}  ${flag.padEnd(11)}${where.padEnd(12)}${e.officialName ?? e.role ?? ''}`);
      if (e.deployer) console.log(`  ${' '.repeat(44)}deployed by ${e.deployer}`);
      if (e.signals.length) console.log(`  ${' '.repeat(44)}responds to: ${e.signals.join('  ')}`);
      if (!e.live) console.log(`  ${' '.repeat(44)}no code at this address`);
    }
  };

  show(entries.filter((e) => e.origin === 'genesis'), `Genesis-embedded (${genesisCount})`);
  show(entries.filter((e) => e.origin === 'deployed'), `Deployed at runtime (${deployedCount})`);

  const unlisted = entries.filter((e) => e.origin === 'deployed' && !e.official);
  console.log(`\n  ${entries.length} contract accounts total`);
  if (unlisted.length) {
    console.log(`  ${unlisted.length} marked [unlisted] — not in the published contracts block, so NOT official`);
    console.log('  (examples and probes such as Greeter/Counter show up here; do not integrate against them)');
  }
  console.log('  debug a specific transaction with:  cast run <txhash> --rpc-url <rpc>\n');
}

export { collect };

// 只有作为命令运行时才扫链；被 import 时不产生任何副作用。
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const data = await collect();
  if (parseArgs().asJson) console.log(JSON.stringify(data, null, 2));
  else printTable(data);
}
