// tests/e2e/lib/devnet.mjs —— 崩溃恢复类 e2e 的共用操作（功能 002）。
//
// 这些测试只通过**对外接口**操作开发网：scripts/devnet-* 与 RPC。
// 不直接读节点内部状态 —— 否则测的就不是"用户能观察到的恢复"了。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, http, defineChain, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { REPO_ROOT, loadProtocol, deriveTopology } from '../../../tools/protocol/load.mjs';

const env = Object.fromEntries(
  readFileSync(resolve(REPO_ROOT, 'docker/compose/active.env'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z]/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"|"$/g, '')]),
);

export const RPC = `http://127.0.0.1:${env.KARMACHAIN_RPC_PORT}${env.KARMACHAIN_RPC_PATH}`;
export const NODE_IDS = env.KARMACHAIN_NODE_IDS.split(' ');
export const VALIDATOR_IDS = env.KARMACHAIN_VALIDATOR_IDS.split(' ');
export const CHAIN_ID_HEX = env.KARMACHAIN_CHAIN_ID_HEX;
export const MAX_OFFLINE_VALIDATORS = Number(env.KARMACHAIN_MAX_OFFLINE_VALIDATORS ?? 0);

const info = JSON.parse(readFileSync(resolve(REPO_ROOT, 'docs/public/chain-info.json'), 'utf8'));
const acct = (label) => info.testAccounts.accounts.find((a) => a.label === label);

/**
 * 针对任意一个 RPC 入口造一套客户端。
 *
 * 为什么需要"任意入口"：整域失效的测试必须**从别的机器观测** —— 被停掉的那台机器上
 * 本地代理也随之消失，`127.0.0.1` 这条入口不存在了。而链是否继续出块只能由**存活的**
 * 边界回答。
 */
export function clientsFor(rpcUrl) {
  const chain = defineChain({
    id: info.chainId,
    name: info.name,
    nativeCurrency: info.nativeCurrency,
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const transport = http(rpcUrl, { timeout: 20_000, retryCount: 0 });
  return {
    RPC: rpcUrl,
    pub: createPublicClient({ chain, transport }),
    wallet: createWalletClient({
      account: privateKeyToAccount(acct('anvil-0').privateKey), chain, transport,
    }),
  };
}

const local = clientsFor(RPC);
export const pub = local.pub;
export const wallet = local.wallet;
export const RECIPIENT = acct('anvil-1').address;

// —— 故障边界（跨机形态才有多个）——
export const DOMAIN = process.env.KARMACHAIN_DOMAIN || env.KARMACHAIN_DEFAULT_DOMAIN;
export const DOMAIN_COUNT = Number(env.KARMACHAIN_DOMAIN_COUNT ?? 1);
/** 边界 id → 局域网地址的映射，取自 active.env 的渲染事实，不另算一遍。 */
export const DOMAIN_ADDRESSES = Object.fromEntries(
  (env.KARMACHAIN_DOMAIN_ADDRESSES ?? '').split(' ').filter(Boolean).map((pair) => {
    const i = pair.indexOf('=');
    return [pair.slice(0, i), pair.slice(i + 1)];
  }),
);

const topology = deriveTopology(loadProtocol());
/** 某个故障边界承载哪些节点 id。 */
export const nodesOfDomain = (domain) =>
  topology.topologyNodes.filter((n) => n.domain === domain).map((n) => n.id);
/** 某个故障边界承载哪些**验证者** id（Primary 节点不计入容错，研究 R-09）。 */
export const validatorsOfDomain = (domain) =>
  topology.topologyNodes.filter((n) => n.domain === domain && n.role === 'l1-validator').map((n) => n.id);
/** 该边界对外的 RPC 入口（每台机器都跑一个本地 nginx 代理，端口相同）。 */
export const rpcOfDomain = (domain) =>
  `http://${DOMAIN_ADDRESSES[domain]}:${env.KARMACHAIN_RPC_PORT}${env.KARMACHAIN_RPC_PATH}`;

export const sh = (cmd, args) => execFileSync(cmd, args, {
  cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
});

/** 强制杀死全部节点容器 —— 不给任何优雅退出的机会。 */
export function killAll() {
  const ids = sh('docker', ['ps', '-q', '--filter', 'name=karmachain-']).trim().split(/\s+/).filter(Boolean);
  if (ids.length) sh('docker', ['kill', ...ids]);
  return ids.length;
}

export const start = () => sh('sh', ['scripts/devnet-start.sh']);

/** 等 RPC 回到预期的 chainId，返回耗时（毫秒）。 */
export async function waitReady(timeoutMs = 300_000) {
  const t0 = Date.now();
  for (;;) {
    try {
      if (await pub.getChainId() === info.chainId) return Date.now() - t0;
    } catch { /* 尚未就绪 */ }
    if (Date.now() - t0 > timeoutMs) throw new Error(`chain not ready within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/**
 * 发一笔转账并等待回执，返回它所在的**区块高度**。
 *
 * 注意返回值不是 receipt —— 回执非 success 时本函数自己抛异常，因此"拿到返回值"
 * 就等于"已确认"。别去读它的 `.status`（曾踩过：那是个数字，`.status` 恒为 undefined）。
 */
export async function sendTxVia(clients, valueEth = '0.001') {
  const hash = await clients.wallet.sendTransaction({ to: RECIPIENT, value: parseEther(valueEth) });
  const rcpt = await clients.pub.waitForTransactionReceipt({ hash, timeout: 90_000, pollingInterval: 500 });
  if (rcpt.status !== 'success') throw new Error(`tx ${hash} reverted`);
  return Number(rcpt.blockNumber);
}

export const sendTx = (valueEth = '0.001') => sendTxVia(local, valueEth);

export const genesisHash = () => readFileSync(resolve(REPO_ROOT, 'blockchain/genesis/karmachain.genesis.hash'), 'utf8').trim();

/** 开发网是否可用；不可用时让调用方跳过而不是误报失败。 */
export async function devnetAvailable() {
  try { return await pub.getChainId() === info.chainId; } catch { return false; }
}
