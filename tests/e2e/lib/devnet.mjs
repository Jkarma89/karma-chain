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

// —— 本机实况：故障注入只能操作**本机**的容器 ——
//
// 这一组是跨机形态逼出来的。原先各测试都按下标从全局验证者列表里挑靶子
// （`VALIDATOR_IDS[2]`、`VALIDATOR_IDS.at(-1)` 之类），单机形态下 7 个容器都在本机，
// 那样写没问题；跨机形态下 `docker kill karmachain-l1-5` 会因为 l1-5 在别的机器上而失败。
// 2026-09-09 实测：11 个 e2e 里有 6 个因此失败，全是同一个结构性原因，与实现无关。

/** 本机是否真的有这个节点的容器。 */
export const containerExists = (id) => {
  try { sh('docker', ['inspect', '--format', '{{.State.Status}}', `karmachain-${id}`]); return true; }
  catch { return false; }
};

/** 本机实际承载的节点 / 验证者（跨机形态下只有本边界那几个）。每次调用现查。 */
export const localNodeIds = () => NODE_IDS.filter(containerExists);
export const localValidatorIds = () => VALIDATOR_IDS.filter(containerExists);

/**
 * 挑本机的验证者当靶子，不够就返回 null 让调用方跳过。
 *
 * @param count 需要几个（`beyond-tolerance` 要 2 个才能超出容错上限）
 * @param requireDomainPeers 是否要求靶子所在边界**还有别的节点**。
 *   判据是"杀一个验证者 → 节点级故障而非边界缺席"时必须为真：若该边界只有它一个节点，
 *   杀掉它**确实**是整域缺席，报 `unreachable` 是对的（那属 domain-failure.test.mjs）。
 */
export function pickLocalVictims(count = 1, { requireDomainPeers = false } = {}) {
  const sizeOf = topology.topologyNodes
    .reduce((m, n) => m.set(n.domain, (m.get(n.domain) ?? 0) + 1), new Map());
  const domainOf = new Map(topology.topologyNodes.map((n) => [n.id, n.domain]));
  const usable = localValidatorIds()
    .filter((id) => !requireDomainPeers || sizeOf.get(domainOf.get(id)) >= 2)
    .reverse();          // 从后往前：靠后的验证者一般不与 Primary 同处一台
  return usable.length >= count ? usable.slice(0, count) : null;
}

/**
 * 「故障没扩散」的判据：其余验证者**是否仍在服务 L1**（网络层探测）。
 *
 * 为什么不能用"它的容器是否 running"（各测试原先的写法）：跨机形态下别的验证者在**别的
 * 机器上**，本机 `docker inspect` 返回 missing，于是测试把"看不见"当成了"挂了"。
 * 2026-09-09 实测：SC-003 的 30 分钟窗口里 30 笔交易全部确认、零交易失败，
 * 却报出 120 条"故障扩散了" —— 全是这个假阳性（30 轮 × 4 个远端验证者）。
 *
 * 换成"在不在服务 L1"同时也是**更强**的判据：容器活着但不服务，比容器不在更坏。
 *
 * @param excludeIds 不检查的节点（通常是本测试自己制造故障的靶子）
 * @returns [{ id, domain, serving, detail }]
 */
export async function validatorsServing(excludeIds = []) {
  const { probeNode } = await import('../../../tools/inspect/node-status.mjs');
  let blockchainId = null;
  try {
    blockchainId = JSON.parse(readFileSync(
      resolve(REPO_ROOT, 'blockchain/chain-identity/karmachain.identity.json'), 'utf8')).blockchainId;
  } catch { /* 尚未建链 */ }

  const targets = topology.topologyNodes
    .filter((n) => n.role === 'l1-validator' && !excludeIds.includes(n.id));
  const probes = await Promise.all(targets.map((n) => probeNode(n, blockchainId)));
  return targets.map((n, i) => ({
    id: n.id,
    domain: n.domain,
    serving: Boolean(probes[i].reachable) && probes[i].height != null,
    detail: !probes[i].reachable
      ? '不可达'
      : probes[i].height == null ? '可达但尚未服务 L1' : `服务中（高度 ${probes[i].height}）`,
  }));
}

/** 便捷形式：返回「未在服务」的那些验证者的说明，全在服务时为空数组。 */
export async function spreadProblems(excludeIds = [], label = '') {
  const rows = await validatorsServing(excludeIds);
  return rows.filter((r) => !r.serving)
    .map((r) => `${label}${r.id}（${r.domain}）${r.detail} —— 故障扩散了`);
}

/** 靶子不足时的 skip 理由。TAP 的 skip 是**单行**字段，别用换行（会被转义成 \n 字面量）。 */
export const localVictimSkip = (count, { requireDomainPeers = false } = {}) =>
  `本机可用的验证者容器不足 ${count} 个（本机承载：${localValidatorIds().join('、') || '无'}；`
  + `拓扑声明：${VALIDATOR_IDS.join('、')}）—— 故障注入只能操作本机容器。`
  + (requireDomainPeers ? ' 且靶子所在边界须另有节点，否则杀掉它是整域缺席（见 domain-failure.test.mjs）。' : '')
  + ' 在承载足够验证者的机器上跑本文件即可。';

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
