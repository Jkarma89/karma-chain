// tools/protocol/render-docs.mjs —— 由 protocol.json + protocol-rationale.json 生成 docs/protocol-parameters.md
// （宪法第十四条：每个区块链参数必须记录取值与理由；tasks T028）。
// 用法：node tools/protocol/render-docs.mjs [--check]

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadProtocol, derive, readJson, REPO_ROOT } from './load.mjs';

export const RATIONALE_PATH = resolve(REPO_ROOT, 'blockchain', 'protocol-rationale.json');
export const DOCS_PATH = resolve(REPO_ROOT, 'docs', 'protocol-parameters.md');
export const GENESIS_HASH_PATH = resolve(REPO_ROOT, 'blockchain', 'genesis', 'karmachain.genesis.hash');

/** 必须给出理由的参数路径（宪法第十四条清单的落地）；缺一即失败。 */
export const REQUIRED_RATIONALE_KEYS = [
  'environment', 'configVersion',
  'chain.chainId', 'chain.reservedMainnetChainId', 'chain.blockchainName',
  'avalanche.networkId', 'avalanche.avalanchegoVersion', 'avalanche.subnetEvmVersion',
  'avalanche.avalancheCliVersion', 'avalanche.rpcChainVmProtocol',
  'nativeToken.name', 'nativeToken.symbol', 'nativeToken.decimals',
  'feeConfig.gasLimit', 'feeConfig.targetBlockRate', 'feeConfig.minBaseFee', 'feeConfig.targetGas',
  'feeConfig.baseFeeChangeDenominator', 'feeConfig.minBlockGasCost', 'feeConfig.maxBlockGasCost', 'feeConfig.blockGasCostStep',
  'allowFeeRecipients',
  'blockProduction.mode', 'blockProduction.targetBlockRateSeconds',
  'primaryNetwork.nodeCount',
  'validators.count', 'validators.management', 'validators.ownerAccount', 'validators.nodes',
  'devAccounts',
  'endpoints.hostRpcPort', 'endpoints.rpcPath', 'endpoints.publishedHosts',
];

const get = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);

export function renderDocsText() {
  const p = loadProtocol();
  const d = derive(p);
  const rationale = readJson(RATIONALE_PATH).rationale;
  const genesisHash = readFileSync(GENESIS_HASH_PATH, 'utf8').trim();

  const missing = REQUIRED_RATIONALE_KEYS.filter((k) => !rationale[k]);
  if (missing.length) throw new Error(`protocol-rationale.json missing rationale for: ${missing.join(', ')}`);

  const row = (path, value = JSON.stringify(get(p, path))) => `| \`${path}\` | ${value} | ${rationale[path]} |`;
  const section = (title, rows) => `### ${title}\n\n| 参数 | 值 | 取值理由 |\n|---|---|---|\n${rows.join('\n')}\n`;

  const validatorRows = p.validators.nodes
    .map((n) => `| \`validators.nodes[${n.index - 1}]\` | http ${n.httpPort} / staking ${n.stakingPort}，密钥 \`${n.keyDir}\` | ↑ |`)
    .join('\n');
  const accountRows = p.devAccounts
    .map((a) => `| \`${a.label}\` | ${a.address}（${BigInt(a.balanceWei) / 10n ** BigInt(p.nativeToken.decimals)} ${p.nativeToken.symbol}，${a.source}） | ↑ |`)
    .join('\n');

  return `<!-- GENERATED FROM blockchain/protocol.json + blockchain/protocol-rationale.json by tools/protocol/render-docs.mjs — DO NOT EDIT.
     修改参数：编辑 protocol.json（走宪法第十五条流程）→ npm run protocol:render → 提交。 -->

# KarmaChain 协议参数（${p.environment} · configVersion ${p.configVersion}）

宪法第十四条要求记录的全部区块链参数及其取值理由。唯一权威定义：[\`blockchain/protocol.json\`](../blockchain/protocol.json)。

${section('链身份', [row('chain.chainId'), row('chain.reservedMainnetChainId'), row('chain.blockchainName'), row('avalanche.networkId'), row('environment'), row('configVersion')])}
${section('Avalanche 组件版本（锁定）', [row('avalanche.avalanchegoVersion'), row('avalanche.subnetEvmVersion'), row('avalanche.avalancheCliVersion'), row('avalanche.rpcChainVmProtocol')])}
${section('原生代币', [row('nativeToken.name'), row('nativeToken.symbol'), row('nativeToken.decimals'), row('allowFeeRecipients')])}
${section('Gas / 费用（Subnet-EVM feeConfig）', ['gasLimit', 'targetBlockRate', 'minBaseFee', 'targetGas', 'baseFeeChangeDenominator', 'minBlockGasCost', 'maxBlockGasCost', 'blockGasCostStep'].map((k) => row(`feeConfig.${k}`)))}
${section('出块', [row('blockProduction.mode'), row('blockProduction.targetBlockRateSeconds')])}
${section('拓扑与验证者', [row('primaryNetwork.nodeCount'), row('validators.count'), row('validators.management'), row('validators.ownerAccount'), `| \`validators.nodes\` | 见下 | ${rationale['validators.nodes']} |`, validatorRows])}
${section('创世开发账户', [`| \`devAccounts\` | 共 ${p.devAccounts.length} 个，初始供应 ${d.initialSupplyTokens} ${p.nativeToken.symbol} | ${rationale.devAccounts} |`, accountRows])}
${section('端点', [row('endpoints.hostRpcPort'), row('endpoints.rpcPath'), row('endpoints.publishedHosts')])}
### 派生值（不存储，由 \`tools/protocol/load.mjs derive()\` 计算）

| 派生值 | 值 |
|---|---|
| Chain ID（十六进制） | \`${d.chainIdHex}\` |
| 宿主 RPC URL | \`${d.rpcUrl}\` |
| 宿主 WS URL | \`${d.wsUrl}\` |
| 初始供应 | ${d.initialSupplyTokens} ${p.nativeToken.symbol}（${d.initialSupplyWei} wei） |
| 节点总数 | ${d.totalNodeCount}（${p.primaryNetwork.nodeCount} 主网 + ${p.validators.count} L1） |
| 创世区块哈希（实测基准） | \`${genesisHash}\` |

### 创世配置

创世文件 [\`blockchain/genesis/karmachain.genesis.json\`](../blockchain/genesis/karmachain.genesis.json) 由本参数集 + ValidatorManager fixture 确定性生成（固定创世时间 2026-09-01T00:00:00Z），详见 [\`blockchain/genesis/README.md\`](../blockchain/genesis/README.md)。
`;
}

export function checkDocs() {
  const expected = renderDocsText();
  let actual = null;
  try { actual = readFileSync(DOCS_PATH, 'utf8'); } catch { /* absent */ }
  return { same: actual === expected, expected };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { same, expected } = checkDocs();
  if (process.argv.includes('--check')) {
    if (same) { console.log(`docs up to date: ${DOCS_PATH}`); process.exit(0); }
    console.error('docs DRIFT: run npm run protocol:render'); process.exit(1);
  }
  writeFileSync(DOCS_PATH, expected);
  console.log(`wrote ${DOCS_PATH}`);
}
