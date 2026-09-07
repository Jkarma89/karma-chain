// tests/e2e/lib/devnet.mjs —— 崩溃恢复类 e2e 的共用操作（功能 002）。
//
// 这些测试只通过**对外接口**操作开发网：scripts/devnet-* 与 RPC。
// 不直接读节点内部状态 —— 否则测的就不是"用户能观察到的恢复"了。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, http, defineChain, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { REPO_ROOT } from '../../../tools/protocol/load.mjs';

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

const info = JSON.parse(readFileSync(resolve(REPO_ROOT, 'docs/public/chain-info.json'), 'utf8'));
const chain = defineChain({
  id: info.chainId,
  name: info.name,
  nativeCurrency: info.nativeCurrency,
  rpcUrls: { default: { http: [RPC] } },
});
const transport = http(RPC, { timeout: 20_000, retryCount: 0 });
export const pub = createPublicClient({ chain, transport });

const acct = (label) => info.testAccounts.accounts.find((a) => a.label === label);
export const wallet = createWalletClient({ account: privateKeyToAccount(acct('anvil-0').privateKey), chain, transport });
export const RECIPIENT = acct('anvil-1').address;

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

/** 发一笔转账并等待回执，返回它所在的区块高度。 */
export async function sendTx(valueEth = '0.001') {
  const hash = await wallet.sendTransaction({ to: RECIPIENT, value: parseEther(valueEth) });
  const rcpt = await pub.waitForTransactionReceipt({ hash, timeout: 90_000, pollingInterval: 500 });
  if (rcpt.status !== 'success') throw new Error(`tx ${hash} reverted`);
  return Number(rcpt.blockNumber);
}

export const genesisHash = () => readFileSync(resolve(REPO_ROOT, 'blockchain/genesis/karmachain.genesis.hash'), 'utf8').trim();

/** 开发网是否可用；不可用时让调用方跳过而不是误报失败。 */
export async function devnetAvailable() {
  try { return await pub.getChainId() === info.chainId; } catch { return false; }
}
