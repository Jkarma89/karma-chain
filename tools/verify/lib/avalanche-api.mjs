// tools/verify/lib/avalanche-api.mjs —— 逐节点访问 Avalanche 的 Info / Health API。
//
// 节点只监听容器内回环（research V-8），devnet 容器为每个节点在容器 IP 上起了同端口 socat 代理，
// 并把清单写到 .devnet/nodes.json。本模块读取该清单并按节点探测。
// 注意：avalanchego 的 --http-allowed-hosts 默认只放行 localhost 与 IP 字面量，故 URL 必须用 IP。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { rpcBase, jsonRpc, fetchWithTimeout, resolveRpcHost, REPO_ROOT_HINT } from './rpc.mjs';

export const INVENTORY_PATH = process.env.KARMACHAIN_NODES_JSON
  || resolve(REPO_ROOT_HINT, '.devnet', 'nodes.json');

/** 读取节点清单；缺失时返回 null（调用方降级为"只检查主端点"）。 */
export function readInventory() {
  try {
    const inv = JSON.parse(readFileSync(INVENTORY_PATH, 'utf8'));
    if (!Array.isArray(inv.nodes) || inv.nodes.length === 0) return null;
    return inv;
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
  const probePort = inv?.nodes?.[0]?.httpPort;
  if (!probePort) { cachedHostForNodes = null; return null; }
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
