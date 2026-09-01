// tools/verify/lib/rpc.mjs —— 验证器与测试访问链的唯一入口：RPC URL 解析 + viem 客户端 + Avalanche Info/Health API。
// URL 组成来自 blockchain/protocol.json（路径）与运行环境（主机名/端口），不硬编码链参数（FR-017）。
//
// 解析优先级：
//   1. KARMACHAIN_RPC_URL                     （完整 URL，显式覆盖）
//   2. KARMACHAIN_RPC_HOST + KARMACHAIN_RPC_PORT （compose 内网：devnet:8545）
//   3. 127.0.0.1 + protocol.endpoints.hostRpcPort（宿主机默认）

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { loadProtocol, derive } from '../../protocol/load.mjs';

export const protocol = loadProtocol();
export const derived = derive(protocol);

/**
 * avalanchego 的 `--http-allowed-hosts` 默认只放行 Host 头为 `localhost` 或 **IP 字面量** 的请求（其余 403）。
 * compose 内网用服务名（devnet）访问会被拒，因此把非 IP、非 localhost 的主机名先解析成 IP 再拼 URL。
 */
export async function resolveRpcHost(host) {
  if (host === 'localhost' || isIP(host)) return host;
  const { address } = await lookup(host, { family: 4 });
  return address;
}

export async function resolveRpcBase() {
  if (process.env.KARMACHAIN_RPC_URL) {
    return process.env.KARMACHAIN_RPC_URL.replace(new RegExp(`${protocol.endpoints.rpcPath.replace(/\//g, '\\/')}$`), '');
  }
  const host = await resolveRpcHost(process.env.KARMACHAIN_RPC_HOST || '127.0.0.1');
  const port = process.env.KARMACHAIN_RPC_PORT || protocol.endpoints.hostRpcPort;
  return `http://${host}:${port}`;
}

export const rpcBase = await resolveRpcBase();
export const rpcUrl = `${rpcBase}${protocol.endpoints.rpcPath}`;
export const infoUrl = `${rpcBase}/ext/info`;
export const healthUrl = `${rpcBase}/ext/health`;

/** viem 链定义（来自 protocol.json）。 */
export const karmachain = defineChain({
  id: protocol.chain.chainId,
  name: protocol.name,
  nativeCurrency: { name: protocol.nativeToken.name, symbol: protocol.nativeToken.symbol, decimals: protocol.nativeToken.decimals },
  rpcUrls: { default: { http: [rpcUrl] } },
});

export const publicClient = createPublicClient({ chain: karmachain, transport: http(rpcUrl, { timeout: 15_000 }) });
export const walletClient = (account) => createWalletClient({ account, chain: karmachain, transport: http(rpcUrl, { timeout: 15_000 }) });

/** 原始 JSON-RPC 调用（用于逐方法探测与 Avalanche Info API）。 */
export async function jsonRpc(url, method, params = []) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) { const e = new Error(`${method}: ${body.error.message}`); e.rpcError = body.error; throw e; }
  return body.result;
}

export const info = {
  networkID: async () => Number((await jsonRpc(infoUrl, 'info.getNetworkID')).networkID),
  nodeID: async () => (await jsonRpc(infoUrl, 'info.getNodeID')).nodeID,
  peers: async () => jsonRpc(infoUrl, 'info.peers'),
  isBootstrapped: async (chain) => (await jsonRpc(infoUrl, 'info.isBootstrapped', { chain })).isBootstrapped,
};

export async function health() {
  const res = await fetch(healthUrl, { signal: AbortSignal.timeout(10_000) });
  return res.json();
}
