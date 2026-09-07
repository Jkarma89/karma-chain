// tools/protocol/render-docs.mjs —— 由 protocol.json + protocol-rationale.json 生成 docs/protocol-parameters.md
// （宪法第十四条：每个区块链参数必须记录取值与理由；tasks T028）。
// 用法：node tools/protocol/render-docs.mjs [--check]

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadProtocol, derive, deriveTopology, readJson, REPO_ROOT } from './load.mjs';

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
  // 功能 002：拓扑同样是共识相关参数（它决定容错承诺），因此同样必须附理由（宪法第十四条）。
  // 沿用 001 的做法：缺理由则文档生成失败，改参数的人必须同时说明为什么。
  'topology', 'topology.activeDeployment', 'topology.nodes', 'topology.deployments',
  'topology.deployments.local.containerNetwork',
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

  // 拓扑与故障边界（T072）。逐部署形态展示，含推导出的容错结论 ——
  // 那个结论不是声明出来的，而是算出来的，必须能被读者核对。
  const nodeRows = deriveTopology(p).topologyNodes
    .map((n) => `| \`${n.id}\` | ${n.role} | http ${n.httpPort} / staking ${n.stakingPort} | \`${n.keyDir}\` |`)
    .join('\n');

  const deploymentBlocks = Object.entries(p.topology.deployments).map(([name, dep]) => {
    const t = deriveTopology({ ...p, topology: { ...p.topology, activeDeployment: name } });
    const ft = t.faultTolerance;
    const active = name === p.topology.activeDeployment ? '（**当前生效**）' : '';
    const domainRows = t.failureDomains
      .map((x) => `| \`${x.id}\` | ${x.platform} | ${x.address} | ${x.nodes.join('、')} | ${x.validatorCount} | ${(x.sharedFailureFactors ?? []).join('、') || '—'} |`)
      .join('\n');
    const verdict = ft.domainCount === 1
      ? '单边界形态，不做整机失效容错承诺'
      : `每边界至多 ${ft.maxValidatorsPerDomain} 个验证者 → ${ft.tolerateWholeDomainLoss ? '**可**' : '**无法**'}容忍 1 个边界整体失效`;
    const merged = ft.effectiveDomainCount !== ft.domainCount
      ? `\n\n> ${ft.domainCount} 个声明边界因共享失效因素合并为 **${ft.effectiveDomainCount} 个有效边界**`
        + `（${ft.effectiveDomains.map((g) => `${g.ids.join('+')}：${g.validators} 个验证者`).join('；')}）。`
        + '上面的结论按合并后判定。'
      : '';
    return `#### \`${name}\`${active}\n\n${dep.description}\n\n`
      + `| 故障边界 | 平台 | 地址 | 节点 | 验证者数 | 共享失效因素 |\n|---|---|---|---|---|---|\n${domainRows}\n\n`
      + `容错：${ft.validatorCount} 个等权验证者，查询门槛 75% → 可容忍 ${ft.maxOfflineValidators} 个离线。${verdict}。${merged}`;
  }).join('\n\n');

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
### 拓扑与故障边界

| 参数 | 值 | 取值理由 |
|---|---|---|
| \`topology\` | 见下 | ${rationale.topology} |
| \`topology.activeDeployment\` | ${JSON.stringify(p.topology.activeDeployment)} | ${rationale['topology.activeDeployment']} |
| \`topology.nodes\` | 共 ${p.topology.nodes.length} 个 | ${rationale['topology.nodes']} |
| \`topology.deployments\` | ${Object.keys(p.topology.deployments).length} 个形态：${Object.keys(p.topology.deployments).join('、')} | ${rationale['topology.deployments']} |
| \`topology.deployments.local.containerNetwork\` | ${JSON.stringify(p.topology.deployments.local.containerNetwork)} | ${rationale['topology.deployments.local.containerNetwork']} |

**节点**（端口与 keyDir 解析自 \`validators.nodes[]\` 与 \`topology.nodes[]\`，此处只是展示解析结果）

| 节点 | 角色 | 端口 | 身份材料 |
|---|---|---|---|
${nodeRows}

**部署形态**

${deploymentBlocks}

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
