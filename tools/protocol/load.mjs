// tools/protocol/load.mjs
// 读取并校验 blockchain/protocol.json —— KarmaChain 协议参数的唯一事实来源（宪法第十六条）。
// 其他所有工具（创世/文档/compose 生成器、验证器、测试）必须经由本模块获取参数，不得自行解析或硬编码。
//
// 用法（库）：   import { loadProtocol } from '../protocol/load.mjs'
// 用法（CLI）：  node tools/protocol/load.mjs [path]   → 打印摘要，校验失败以退出码 1 结束

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { getAddress, isAddress } from 'viem';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');
export const DEFAULT_PROTOCOL_PATH = resolve(REPO_ROOT, 'blockchain', 'protocol.json');
export const DEFAULT_SCHEMA_PATH = resolve(REPO_ROOT, 'blockchain', 'protocol.schema.json');

// Avalanche 主网 / Fuji 的 Network ID —— 本地网络绝不允许与之相同（spec 边缘用例"误连真实网络"）。
const REAL_NETWORK_IDS = new Set([1, 5]);

// RPCChainVM 协议版本兼容表。来源（2026-09-01 核实）：
//   avalanchego  version/compatibility.json      → "44": [v1.14.0, v1.14.1], "45": [v1.14.2]
//   subnet-evm   compatibility.json（归档仓库）   → v0.8.0: 44, v0.7.9: 43
// 升级任一版本时必须同步更新此表并递增 configVersion（宪法第十五条协议变更流程）。
export const RPC_CHAIN_VM_PROTOCOL = {
  avalanchego: { 'v1.13.4': 43, 'v1.13.5': 43, 'v1.14.0': 44, 'v1.14.1': 44, 'v1.14.2': 45 },
  subnetEvm: { 'v0.7.9': 43, 'v0.8.0': 44 },
};

// 容器内被其他组件占用的端口：Avalanche CLI 主网节点固定区间（9650-9653，CLI 常量，非本项目参数）。
// 对外 RPC 代理端口来自 protocol.json，运行时并入检查（见 validateConstraints）。
const CLI_PRIMARY_NODE_PORTS = [9650, 9651, 9652, 9653];

let ajvInstance;
function getAjv() {
  if (!ajvInstance) {
    ajvInstance = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajvInstance);
  }
  return ajvInstance;
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** 仅做 JSON Schema 校验；返回 ajv 错误数组（空数组 = 通过）。 */
export function validateSchema(protocol, schema = readJson(DEFAULT_SCHEMA_PATH)) {
  const ajv = getAjv();
  // 同一 $id 在一个 Ajv 实例里只能编译一次；复用已编译的校验器。
  const validate = (schema.$id && ajv.getSchema(schema.$id)) || ajv.compile(schema);
  return validate(protocol) ? [] : validate.errors.map(formatAjvError);
}

function formatAjvError(e) {
  return `${e.instancePath || '/'} ${e.message}${e.params?.allowedValues ? ` (${JSON.stringify(e.params.allowedValues)})` : ''}`;
}

/** data-model.md §1 的业务约束；返回可读错误列表（空数组 = 通过）。假定 schema 已通过。 */
export function validateConstraints(p) {
  const errors = [];
  const fail = (msg) => errors.push(msg);

  // --- 链身份 ---
  if (p.chain.chainId === p.chain.reservedMainnetChainId) {
    fail(`chain.chainId (${p.chain.chainId}) must differ from reservedMainnetChainId — the local devnet must never impersonate mainnet`);
  }
  if (REAL_NETWORK_IDS.has(p.avalanche.networkId)) {
    fail(`avalanche.networkId ${p.avalanche.networkId} is a real Avalanche network (mainnet=1, fuji=5)`);
  }
  if (p.environment !== 'dev') fail(`environment must be "dev" in this file (got ${p.environment})`);

  // --- 版本兼容 ---
  const avagoProto = RPC_CHAIN_VM_PROTOCOL.avalanchego[p.avalanche.avalanchegoVersion];
  const evmProto = RPC_CHAIN_VM_PROTOCOL.subnetEvm[p.avalanche.subnetEvmVersion];
  if (avagoProto === undefined) fail(`avalanche.avalanchegoVersion ${p.avalanche.avalanchegoVersion} is not in the compatibility table (update RPC_CHAIN_VM_PROTOCOL after verifying upstream)`);
  if (evmProto === undefined) fail(`avalanche.subnetEvmVersion ${p.avalanche.subnetEvmVersion} is not in the compatibility table`);
  if (avagoProto !== undefined && evmProto !== undefined && avagoProto !== evmProto) {
    fail(`protocol mismatch: avalanchego ${p.avalanche.avalanchegoVersion} speaks RPCChainVM ${avagoProto} but subnet-evm ${p.avalanche.subnetEvmVersion} speaks ${evmProto}`);
  }
  if (avagoProto !== undefined && p.avalanche.rpcChainVmProtocol !== avagoProto) {
    fail(`avalanche.rpcChainVmProtocol ${p.avalanche.rpcChainVmProtocol} does not match the table value ${avagoProto} for ${p.avalanche.avalanchegoVersion}`);
  }

  // --- 出块 / 费用一致性 ---
  if (p.blockProduction.targetBlockRateSeconds !== p.feeConfig.targetBlockRate) {
    fail(`blockProduction.targetBlockRateSeconds (${p.blockProduction.targetBlockRateSeconds}) must equal feeConfig.targetBlockRate (${p.feeConfig.targetBlockRate})`);
  }
  if (p.feeConfig.minBlockGasCost > p.feeConfig.maxBlockGasCost) fail('feeConfig.minBlockGasCost must be <= maxBlockGasCost');

  // --- 验证者 ---
  const nodes = p.validators.nodes;
  if (p.validators.count !== nodes.length) fail(`validators.count (${p.validators.count}) != validators.nodes.length (${nodes.length})`);
  const expectedIdx = nodes.map((_, i) => i + 1);
  if (JSON.stringify(nodes.map((n) => n.index)) !== JSON.stringify(expectedIdx)) fail('validators.nodes[].index must be 1..count in order');
  nodes.forEach((n) => {
    if (n.keyDir !== `blockchain/validators/dev/node-${n.index}/`) fail(`validators.nodes[${n.index}].keyDir must be blockchain/validators/dev/node-${n.index}/`);
  });
  const ports = nodes.flatMap((n) => [n.httpPort, n.stakingPort]);
  const dupPorts = ports.filter((x, i) => ports.indexOf(x) !== i);
  if (dupPorts.length) fail(`validator ports must be unique; duplicates: ${[...new Set(dupPorts)].join(', ')}`);
  const reserved = new Set([...CLI_PRIMARY_NODE_PORTS, p.endpoints.hostRpcPort]);
  ports.filter((x) => reserved.has(x)).forEach((x) => fail(`validator port ${x} collides with a reserved container port (${[...reserved].join(', ')})`));

  // --- 开发账户 ---
  const labels = p.devAccounts.map((a) => a.label);
  if (new Set(labels).size !== labels.length) fail('devAccounts[].label must be unique');
  const lowerAddrs = p.devAccounts.map((a) => a.address.toLowerCase());
  if (new Set(lowerAddrs).size !== lowerAddrs.length) fail('devAccounts[].address must be unique');
  p.devAccounts.forEach((a) => {
    if (!isAddress(a.address, { strict: true }) || getAddress(a.address) !== a.address) {
      fail(`devAccounts[${a.label}].address ${a.address} is not EIP-55 checksummed`);
    }
    if (BigInt(a.balanceWei) <= 0n) fail(`devAccounts[${a.label}].balanceWei must be > 0`);
  });
  if (!labels.includes(p.validators.ownerAccount)) fail(`validators.ownerAccount "${p.validators.ownerAccount}" is not a devAccounts label`);

  // --- 端点 ---
  const expectedPath = `/ext/bc/${p.chain.blockchainName}/rpc`;
  if (p.endpoints.rpcPath !== expectedPath) fail(`endpoints.rpcPath must be ${expectedPath} (derived from chain.blockchainName)`);

  return errors;
}

/** 完整校验（schema + 约束）。 */
export function validateProtocol(protocol, schema) {
  const schemaErrors = validateSchema(protocol, schema);
  if (schemaErrors.length) return { ok: false, errors: schemaErrors.map((e) => `schema: ${e}`) };
  const constraintErrors = validateConstraints(protocol);
  return { ok: constraintErrors.length === 0, errors: constraintErrors.map((e) => `constraint: ${e}`) };
}

/** 读取 + 校验；失败抛出含全部错误的 Error。 */
export function loadProtocol(path = DEFAULT_PROTOCOL_PATH, schemaPath = DEFAULT_SCHEMA_PATH) {
  const protocol = readJson(path);
  const { ok, errors } = validateProtocol(protocol, readJson(schemaPath));
  if (!ok) throw new Error(`protocol.json invalid (${path}):\n  - ${errors.join('\n  - ')}`);
  return Object.freeze(protocol);
}

// --- 派生值（不存储于 protocol.json，避免第二份事实）---
export function derive(p) {
  const initialSupplyWei = p.devAccounts.reduce((sum, a) => sum + BigInt(a.balanceWei), 0n);
  return {
    chainIdHex: `0x${p.chain.chainId.toString(16)}`,
    // 端点主机来自 protocol.json 的 endpoints.publishedHosts（声明的协议参数，不在代码里硬编码）。
    // rpcUrl / wsUrl 保留为"首选端点"，等于列表首项。
    rpcUrls: p.endpoints.publishedHosts.map((h) => `http://${h}:${p.endpoints.hostRpcPort}${p.endpoints.rpcPath}`),
    wsUrls: p.endpoints.publishedHosts.map((h) => `ws://${h}:${p.endpoints.hostRpcPort}${p.endpoints.rpcPath.replace(/\/rpc$/, '/ws')}`),
    rpcUrl: `http://${p.endpoints.publishedHosts[0]}:${p.endpoints.hostRpcPort}${p.endpoints.rpcPath}`,
    wsUrl: `ws://${p.endpoints.publishedHosts[0]}:${p.endpoints.hostRpcPort}${p.endpoints.rpcPath.replace(/\/rpc$/, '/ws')}`,
    initialSupplyWei,
    initialSupplyTokens: initialSupplyWei / 10n ** BigInt(p.nativeToken.decimals),
    totalNodeCount: p.primaryNetwork.nodeCount + p.validators.count,
  };
}

// --- CLI ---
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const p = loadProtocol(process.argv[2] ? resolve(process.argv[2]) : undefined);
    const d = derive(p);
    console.log(`${p.name} protocol config v${p.configVersion} (${p.environment}) — OK`);
    console.log(`  chainId ${p.chain.chainId} (${d.chainIdHex})  networkId ${p.avalanche.networkId}  token ${p.nativeToken.symbol}`);
    console.log(`  avalanchego ${p.avalanche.avalanchegoVersion} / subnet-evm ${p.avalanche.subnetEvmVersion} / cli ${p.avalanche.avalancheCliVersion} (RPCChainVM ${p.avalanche.rpcChainVmProtocol})`);
    console.log(`  nodes ${d.totalNodeCount} (${p.primaryNetwork.nodeCount} primary + ${p.validators.count} L1)  rpc ${d.rpcUrl}`);
    console.log(`  dev accounts ${p.devAccounts.length}, initial supply ${d.initialSupplyTokens} ${p.nativeToken.symbol}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
