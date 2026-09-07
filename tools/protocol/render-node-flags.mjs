// tools/protocol/render-node-flags.mjs
//
// 由 topology + 建链制品 + protocol.json 生成每个节点的 avalanchego 配置文件
// （blockchain/nodes/<deployment>/<id>.flags.json），供 docker/node/ 以 --config-file 消费。
//
// 为什么按部署形态分目录：标志里的 public-ip / bootstrap-ips / http-allowed-hosts 是**形态相关**的
// （local 用容器网段 172.28.0.x，lan 用各机器的局域网地址）。早先只落 activeDeployment 一份，
// 结果是把仓库拷到另一台机器跑 lan 时，节点仍在用那台机器上不存在的容器地址。
// 逐形态落盘之后：切换形态不必改 protocol.json，两份配置也都能被漂移测试锁定。
// 与形态无关的产物（<id>.identity.json、aliases.json、chain-config/）仍在 blockchain/nodes/ 顶层。
//
// 输出格式与 Avalanche CLI 写给 avalanchego 的 flags.json 一致（键为去掉 -- 的标志名、值为字符串），
// 这样与实测基准 tests/fixtures/002/measured-node-flags.json 可以逐项对照 —— 每一处差异都必须
// 能说出理由（例如 http-host 由 127.0.0.1 改为 0.0.0.0 来自研究 R-07）。
//
// 用法：node tools/protocol/render-node-flags.mjs [--check] [--deployment <name>]

import { writeFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadProtocol, deriveTopology, readJson, REPO_ROOT } from './load.mjs';
import { identityFromKeyDir, vmIdFromChainName } from '../verify/lib/identity.mjs';

export const OUTPUT_DIR = resolve(REPO_ROOT, 'blockchain', 'nodes');
const IDENTITY_PATH = resolve(REPO_ROOT, 'blockchain', 'chain-identity', 'karmachain.identity.json');

/** 容器内的固定路径 —— 与 docker/node/ 的挂载约定一致（contracts/node-runtime.md）。 */
export const CONTAINER = {
  data: '/data',
  keys: '/keys',
  config: '/config',
  plugins: '/plugins',
};

/**
 * 生成全部节点的标志集合。
 * @returns {Record<string, Record<string,string>>} nodeId → flags
 */
export function renderNodeFlags(p = loadProtocol(), identity = readJson(IDENTITY_PATH), deploymentName) {
  const scoped = deploymentName
    ? { ...p, topology: { ...p.topology, activeDeployment: deploymentName } }
    : p;
  const d = deriveTopology(scoped);
  const nodes = d.topologyNodes;

  // Host 头白名单：精确到已发布主机与各故障边界地址，不使用通配符。
  // avalanchego 的 --http-allowed-hosts 默认只放行 localhost，这是 001 记录的
  // `403 invalid host specified` 的来源（研究 R-07）。显式声明后放宽范围是可审计的决策。
  // 必须是 JSON 数组：配置文件里写成逗号拼接的字符串，avalanchego 会当成**单个**主机名，
  // 于是清单形同虚设（实测：Host: localhost 被拒，因为 IP 字面量本就无条件放行，
  // 而 localhost 依赖这份清单）。
  const allowedHosts = [...new Set([
    ...p.endpoints.publishedHosts,
    ...d.failureDomains.map((x) => x.address),
    // 单机形态下节点之间用容器 IP 互访，Host 头即该 IP
    ...d.topologyNodes.map((n) => n.address),
  ])];

  // L1 验证者的引导目标是 Primary 节点（实测：bootstrap-ids 恰为两个 Primary 的 NodeID）
  const primaries = nodes.filter((n) => n.role === 'primary');
  const primaryGenesis = readJson(resolve(REPO_ROOT, 'blockchain', 'chain-identity', 'primary-network.genesis.json'));
  const primaryNodeIds = primaryGenesis.initialStakers.map((s) => s.nodeID);
  if (primaryNodeIds.length !== primaries.length) {
    throw new Error(`primary genesis has ${primaryNodeIds.length} initial stakers but topology declares ${primaries.length} primary nodes`);
  }
  const primaryIdOf = new Map(primaries.map((n, i) => [n.id, primaryNodeIds[i]]));
  const endpointOf = (n) => `${n.address}:${n.stakingPort}`;

  const out = {};
  for (const n of nodes) {
    const isValidator = n.role === 'l1-validator';

    // Primary 节点互为引导：第一个是种子（无引导目标），其余引导自它之前的所有 Primary。
    // L1 验证者引导自全部 Primary 节点。
    const targets = isValidator
      ? primaries
      : primaries.slice(0, primaries.findIndex((x) => x.id === n.id));

    const flags = {
      'network-id': String(p.avalanche.networkId),
      'data-dir': CONTAINER.data,
      'db-type': 'leveldb',
      'genesis-file': `${CONTAINER.config}/primary-network.genesis.json`,

      // 身份：三个显式标志，材料只读挂载自仓库（研究 R-03）
      'staking-tls-cert-file': `${CONTAINER.keys}/staker.crt`,
      'staking-tls-key-file': `${CONTAINER.keys}/staker.key`,
      'staking-signer-key-file': `${CONTAINER.keys}/signer.key`,

      // 端点：不再需要 socat 代理（研究 R-07）
      'http-host': '0.0.0.0',
      'http-port': String(n.httpPort),
      'http-allowed-hosts': allowedHosts,
      'staking-port': String(n.stakingPort),
      'public-ip': n.address,
      'network-allow-private-ips': 'true',

      'bootstrap-ids': targets.map((x) => primaryIdOf.get(x.id)).join(','),
      'bootstrap-ips': targets.map(endpointOf).join(','),
    };

    // 索引开关必须与**播种进卷的数据库**当初的设置一致。
    // 建链时 CLI 给 Primary 节点开了索引、给 L1 验证者关了索引并允许不完整索引；
    // 沿用 avalanchego 默认值会让 Primary 启动即 FATAL：
    //   "running would cause index to become incomplete but incomplete indices are disabled"
    // 这是实测教训 —— 不是所有"看似无害的默认值"都无害（研究 R-04 的播种设计）。
    if (isValidator) {
      flags['index-enabled'] = 'false';
      flags['index-allow-incomplete'] = 'true';
      flags['track-subnets'] = identity.subnetId;
      flags['partial-sync-primary-network'] = 'true';
      flags['sybil-protection-enabled'] = 'true';
      flags['plugin-dir'] = CONTAINER.plugins;
      flags['chain-aliases-file'] = `${CONTAINER.config}/aliases.json`;
      flags['chain-config-dir'] = `${CONTAINER.config}/chains`;
    } else {
      flags['index-enabled'] = 'true';
    }

    out[n.id] = Object.fromEntries(Object.entries(flags).sort(([a], [b]) => a.localeCompare(b)));
  }
  return out;
}

/**
 * 生成每个节点的身份伴生文件。
 *
 * 为什么需要它：启动期必须确认「挂进来的密钥」与「制品声明的身份」同源（FR-017），
 * 但官方 avalanchego 镜像里没有 Node，shell 也算不出 BLS 公钥。
 * 因此把重活留在渲染期（Node，已被 identity-crosscheck.test 证明正确），
 * 运行期只做一次 sha256 比对 —— 密钥文件只要与派生身份时用的那份不同，摘要必然不同。
 */
export function renderNodeIdentities(p = loadProtocol(), identity = readJson(IDENTITY_PATH), deploymentName) {
  const scoped = deploymentName
    ? { ...p, topology: { ...p.topology, activeDeployment: deploymentName } }
    : p;
  const d = deriveTopology(scoped);
  const vmId = vmIdFromChainName(p.chain.blockchainName);
  const sha = (path) => createHash('sha256').update(readFileSync(resolve(REPO_ROOT, path))).digest('hex');

  const out = {};
  for (const n of d.topologyNodes) {
    const derived = identityFromKeyDir(n.keyDir);
    out[n.id] = {
      $comment: 'GENERATED by tools/protocol/render-node-flags.mjs — DO NOT EDIT. '
        + 'Startup integrity check: the container compares sha256 of the mounted key files against these values.',
      nodeId: derived.nodeId,
      blsPublicKey: derived.blsPublicKey,
      role: n.role,
      vmId,
      expectedVmVersion: p.avalanche.subnetEvmVersion,
      expectedRpcVersion: p.avalanche.rpcChainVmProtocol,
      certSha256: sha(`${n.keyDir}staker.crt`),
      keySha256: sha(`${n.keyDir}staker.key`),
      signerSha256: sha(`${n.keyDir}signer.key`),
    };
  }
  return out;
}

/** 声明的全部部署形态。 */
export const deploymentNames = (p = loadProtocol()) => Object.keys(p.topology.deployments);

const dirFor = (deployment) => resolve(OUTPUT_DIR, deployment);
const fileFor = (deployment, id) => resolve(dirFor(deployment), `${id}.flags.json`);
const identityFileFor = (id) => resolve(OUTPUT_DIR, `${id}.identity.json`);
const textFor = (flags) => `${JSON.stringify(flags, null, 2)}\n`;

const listDir = (path, re) => {
  try { return readdirSync(path).filter((f) => re.test(f)); } catch { return []; }
};

/** blockchain/nodes/ 下已不再对应任何部署形态的子目录（chain-config 与形态无关，排除）。 */
function staleDeploymentDirs(byDeployment) {
  let entries = [];
  try { entries = readdirSync(OUTPUT_DIR, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory() && e.name !== 'chain-config' && !(e.name in byDeployment))
    .map((e) => e.name);
}

/**
 * 生成全部部署形态下每个节点的标志集合。
 * @returns {Record<string, Record<string, Record<string,string>>>} deployment → nodeId → flags
 */
export function renderAllNodeFlags(p = loadProtocol(), identity = readJson(IDENTITY_PATH)) {
  const out = {};
  for (const name of deploymentNames(p)) out[name] = renderNodeFlags(p, identity, name);
  return out;
}

/** 与磁盘上的生成物比对（覆盖全部部署形态）。 */
export function checkNodeFlags(p = loadProtocol(), identity = readJson(IDENTITY_PATH)) {
  const byDeployment = renderAllNodeFlags(p, identity);
  const identities = renderNodeIdentities(p, identity);
  const drift = [];

  const compare = (path, want, label) => {
    let actual = null;
    try { actual = readFileSync(path, 'utf8'); } catch { /* absent */ }
    if (actual !== want) drift.push(label);
  };

  for (const [name, flags] of Object.entries(byDeployment)) {
    for (const [id, f] of Object.entries(flags)) compare(fileFor(name, id), textFor(f), `${name}/${id}.flags.json`);
    for (const f of listDir(dirFor(name), /\.flags\.json$/)) {
      if (!flags[f.replace(/\.flags\.json$/, '')]) drift.push(`${name}/${f} (stale — no such node in topology)`);
    }
  }
  for (const [id, ident] of Object.entries(identities)) {
    compare(identityFileFor(id), textFor(ident), `${id}.identity.json`);
  }
  // 顶层残留：分目录之前留下的 flags，或已从拓扑移除的节点身份
  for (const f of listDir(OUTPUT_DIR, /\.(flags|identity)\.json$/)) {
    if (f.endsWith('.flags.json')) drift.push(`${f} (stale — flags 已按部署形态分目录)`);
    else if (!identities[f.replace(/\.identity\.json$/, '')]) drift.push(`${f} (stale — no such node in topology)`);
  }
  for (const name of staleDeploymentDirs(byDeployment)) drift.push(`${name}/ (stale — no such deployment in topology)`);
  return { same: drift.length === 0, drift, byDeployment, identities };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const di = args.indexOf('--deployment');
  if (di !== -1) {
    // 只打印指定形态，便于人工核对；落盘走下面的全形态路径
    const flags = renderNodeFlags(loadProtocol(), readJson(IDENTITY_PATH), args[di + 1]);
    process.stdout.write(`${JSON.stringify(flags, null, 2)}\n`);
    process.exit(0);
  }

  const { same, drift, byDeployment, identities } = checkNodeFlags();
  if (args.includes('--check')) {
    if (same) { console.log(`node flags up to date: ${OUTPUT_DIR}`); process.exit(0); }
    console.error(`node flags DRIFT (${drift.join(', ')}): run npm run node:render`);
    process.exit(1);
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });
  // 清理残留：顶层旧 flags、已移除节点的身份、已移除形态的整个目录
  for (const f of listDir(OUTPUT_DIR, /\.(flags|identity)\.json$/)) {
    if (f.endsWith('.flags.json') || !identities[f.replace(/\.identity\.json$/, '')]) {
      rmSync(resolve(OUTPUT_DIR, f));
    }
  }
  for (const name of staleDeploymentDirs(byDeployment)) rmSync(dirFor(name), { recursive: true, force: true });

  for (const [id, ident] of Object.entries(identities)) writeFileSync(identityFileFor(id), textFor(ident));
  for (const [name, flags] of Object.entries(byDeployment)) {
    mkdirSync(dirFor(name), { recursive: true });
    for (const f of listDir(dirFor(name), /\.flags\.json$/)) {
      if (!flags[f.replace(/\.flags\.json$/, '')]) rmSync(resolve(dirFor(name), f));
    }
    for (const [id, f] of Object.entries(flags)) writeFileSync(fileFor(name, id), textFor(f));
  }

  console.log(`wrote ${Object.keys(identities).length} node identity files to ${OUTPUT_DIR}`);
  for (const [name, flags] of Object.entries(byDeployment)) {
    console.log(`  ${name}/ — ${Object.keys(flags).length} node config files`);
    for (const [id, f] of Object.entries(flags)) {
      console.log(`    ${id.padEnd(11)} ${String(f['public-ip']).padEnd(15)} http ${f['http-port']}  staking ${f['staking-port']}  ${f['track-subnets'] ? 'tracks subnet' : 'primary only'}`);
    }
  }
}
