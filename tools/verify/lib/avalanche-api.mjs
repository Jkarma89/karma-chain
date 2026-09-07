// tools/verify/lib/avalanche-api.mjs —— 逐节点访问 Avalanche 的 Info / Health API。
//
// 节点只监听容器内回环（research V-8），devnet 容器为每个节点在容器 IP 上起了同端口 socat 代理，
// 并把清单写到 .devnet/nodes.json。本模块读取该清单并按节点探测。
// 注意：avalanchego 的 --http-allowed-hosts 默认只放行 localhost 与 IP 字面量，故 URL 必须用 IP。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { rpcBase, jsonRpc, fetchWithTimeout, resolveRpcHost, REPO_ROOT_HINT } from './rpc.mjs';
import { loadProtocol, deriveTopology } from '../../protocol/load.mjs';

export const INVENTORY_PATH = process.env.KARMACHAIN_NODES_JSON
  || resolve(REPO_ROOT_HINT, '.devnet', 'nodes.json');

/**
 * 读取节点清单；缺失时返回 null（调用方降级为"只检查主端点"）。
 *
 * 功能 002 起，清单不再是运行期由编排容器写出的 .devnet/nodes.json，而是直接从
 * protocol.json 的 topology 派生 —— 一节点一容器后，每个节点有自己的地址与端口，
 * 这些都是声明出来的，不需要运行时再报一遍（研究 R-01）。
 * 001 的文件若还在则优先使用，便于两套架构并存期间对比。
 */
export function readInventory() {
  // 拓扑优先：002 起它是当前架构，且是声明出来的（不依赖任何进程写出文件）。
  // .devnet/nodes.json 只作为 001 单容器架构的回退 —— 那份文件是运行期产物，
  // 001 容器一旦跑过就会留在磁盘上，若优先读它会让验证器指向已经不存在的节点端点。
  const fromTopology = inventoryFromTopology();
  if (fromTopology) return normalizeInventory(fromTopology);
  try {
    const inv = JSON.parse(readFileSync(INVENTORY_PATH, 'utf8'));
    if (Array.isArray(inv.nodes) && inv.nodes.length) return normalizeInventory(inv);
  } catch { /* 两者皆无 → null */ }
  return null;
}

/**
 * 两个来源的字段名不同：拓扑给 `name`，001 的 `.devnet/nodes.json` 给 `label`。
 * 统一补齐两者，调用方用哪个都拿得到节点名。
 *
 * 为什么必须补：切成拓扑优先之后，只写 `n.label` 的报错信息里节点名一直是 `undefined`
 * （实测：`7/7 unhealthy: undefined (health: HTTP 503)` —— 恰好在最需要知道"是哪个节点"时失效）。
 * 检查通过时这条路径不执行，所以缺陷一直没露出来。
 */
function normalizeInventory(inv) {
  return {
    ...inv,
    nodes: inv.nodes.map((n) => {
      const name = n.name ?? n.label;
      return { ...n, name, label: name };
    }),
  };
}

function inventoryFromTopology() {
  try {
    const p = loadProtocol();
    if (!p.topology) return null;
    const d = deriveTopology(p);
    // NodeID 取自生成的身份伴生文件（由 staking 证书派生，identity-crosscheck 已验证其正确性）
    const nodeIdOf = (id) => {
      try {
        return JSON.parse(readFileSync(resolve(REPO_ROOT_HINT, 'blockchain', 'nodes', `${id}.identity.json`), 'utf8')).nodeId;
      } catch { return undefined; }
    };
    return {
      source: 'topology',
      nodes: d.topologyNodes.map((n) => ({
        name: n.id,
        role: n.role === 'l1-validator' ? 'l1-validator' : 'primary',
        host: n.address,
        httpPort: n.httpPort,
        stakingPort: n.stakingPort,
        nodeId: nodeIdOf(n.id),
      })),
    };
  } catch {
    return null;
  }
}

/**
 * 逐节点的基础 URL。
 *
 * 每节点代理绑在 devnet 容器的 IP 上（同端口，见 lib/runtime.sh），因此：
 *   - 在 verify 容器内（compose 网络）：用解析后的 devnet 容器 IP 即可；
 *   - 在宿主上：这些端口没有映射到宿主，通常不可达（Docker Desktop 无路由到容器网段），
 *     Linux 默认 bridge 下反而可能可达。
 * 所以候选地址依次尝试"RPC 主机解析出的 IP"与"清单里的 containerIp"，首个可用者被缓存。
 * URL 必须用 IP：avalanchego 的 --http-allowed-hosts 默认只放行 localhost 与 IP 字面量。
 */
let cachedHostForNodes;

async function nodeHostCandidates() {
  const out = [];
  try { out.push(await resolveRpcHost(new URL(rpcBase).hostname)); } catch { /* ignore */ }
  const inv = readInventory();
  if (inv?.containerIp && !out.includes(inv.containerIp)) out.push(inv.containerIp);
  return out;
}

/** 探测每节点端点是否可达；不可达时调用方应降级为 SKIP 而不是 FAIL。 */
export async function resolveNodeHost() {
  if (cachedHostForNodes !== undefined) return cachedHostForNodes;
  const inv = readInventory();
  const first = inv?.nodes?.[0];
  const probePort = first?.httpPort;
  if (!probePort) { cachedHostForNodes = null; return null; }
  // 002：清单来自拓扑，每个节点自带地址（一节点一容器）—— 直接探它自己
  if (first.host) {
    try {
      const res = await fetchWithTimeout(`http://${first.host}:${probePort}/ext/health`, {}, 4000);
      if (res.ok || res.status === 503) { cachedHostForNodes = first.host; return first.host; }
    } catch { /* 落到 001 的候选地址探测 */ }
  }
  for (const host of await nodeHostCandidates()) {
    try {
      const res = await fetchWithTimeout(`http://${host}:${probePort}/ext/health`, {}, 4000);
      if (res.ok || res.status === 503) { cachedHostForNodes = host; return host; }   // 503 = 不健康但可达
    } catch { /* try next */ }
  }
  cachedHostForNodes = null;
  return null;
}

export async function nodeBaseUrl(node) {
  // 002：节点自带地址。001：全部节点挤在一个容器里，靠端口区分，地址取探测结果。
  if (node.host) return `http://${node.host}:${node.httpPort}`;
  const host = await resolveNodeHost();
  if (!host) throw new Error('per-node endpoints are not reachable from here');
  return `http://${host}:${node.httpPort}`;
}

export async function nodeHealth(node) {
  const res = await fetchWithTimeout(`${await nodeBaseUrl(node)}/ext/health`, {}, 10_000);
  if (!res.ok) throw new Error(`health: HTTP ${res.status}`);
  return res.json();
}

export async function nodeInfo(node, method, params = []) {
  return jsonRpc(`${await nodeBaseUrl(node)}/ext/info`, method, params);
}

export const nodeId = async (node) => (await nodeInfo(node, 'info.getNodeID')).nodeID;
export const nodeNetworkId = async (node) => Number((await nodeInfo(node, 'info.getNetworkID')).networkID);
export const nodePeerCount = async (node) => Number((await nodeInfo(node, 'info.peers')).numPeers);
export const nodeIsBootstrapped = async (node, chain) => (await nodeInfo(node, 'info.isBootstrapped', { chain })).isBootstrapped;
