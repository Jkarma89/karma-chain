// tools/dashboard/probe-tx.mjs —— 人工触发的探活交易（功能 003 / T033、L9）。
//
// **这是面板唯一的写链路径**，且只在收到 `POST /api/probe` 时执行。
// 自动轮询路径永不写链（FR-033）—— 理由：自动探测会持续产生区块，使"高度"不再反映
// 真实业务活动，而 FR-015（按需出块、高度停滞不是活性信号）恰恰把那一点当成诊断依据。
//
// ## 为什么需要它
//
// 纯只读面板只能从"参与共识的验证者数 vs 查询门槛"**推断**链应当能出块。
// 它发现不了一种情形：**门槛满足，但链实际卡住了**。要覆盖这个盲区只能真发一笔。
//
// ## 判据来源
//
// 复用既有 `tools/verify/checks/chain.mjs` 的 transfer 检查思路：
// sendTransaction → waitForTransactionReceipt → 看 receipt.status，报出哈希/区块/耗时。
// 不另立一套"链能不能出块"的判据。
//
// ## 密钥处置（宪法第四条；完整安全分析见 specs/003-.../security-probe-tx.md）
//
// 私钥来自 `blockchain/accounts/dev-accounts.json`（v1.1.0 例外覆盖的公开测试密钥），
// **只在本文件内使用**：不进响应、不进日志、不进快照、不进公开投影。
// 本文件是唯一 import viem 钱包接口的地方 —— 由
// `tests/e2e/dashboard-readonly.test.mjs` 静态断言 poll.mjs / server.mjs 里没有这些符号。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createPublicClient, createWalletClient, defineChain, http, parseEther,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { REPO_ROOT } from '../protocol/load.mjs';

const readJson = (rel) => JSON.parse(readFileSync(resolve(REPO_ROOT, rel), 'utf8'));

/** 回执等待上限。verify 的 transfer 检查用的也是 30 秒。 */
const RECEIPT_TIMEOUT_MS = 30_000;

/**
 * 探活走**对外的 RPC 入口**（本边界的代理），而不是某个验证者的私有端口 ——
 * 与第三方相同的位置发起，才能代表"链对外是否可用"。
 *
 * 容器内与宿主上的地址不同，因此留一个环境变量：
 *   - 宿主：http://127.0.0.1:<hostRpcPort><rpcPath>（默认）
 *   - 容器：由 scripts/devnet-dashboard.* 传入 KARMACHAIN_RPC_URL
 */
function resolveRpcUrl(protocol) {
  if (process.env.KARMACHAIN_RPC_URL) return process.env.KARMACHAIN_RPC_URL;
  return `http://127.0.0.1:${protocol.endpoints.hostRpcPort}${protocol.endpoints.rpcPath}`;
}

/** 供错误信息使用 —— 读不到 protocol 也不能让报错本身炸掉。 */
function rpcUrlOf(protocol) {
  try { return resolveRpcUrl(protocol ?? readJson('blockchain/protocol.json')); } catch { return '(未知)'; }
}

/**
 * 给连接类失败补上"试的是哪个地址"与最可能的成因。
 *
 * **为什么值得专门写这一段**：viem 的 `HTTP request failed` 对排障零信息量。
 * 2026-09-10 的实际情形是：面板在容器里跑，`KARMACHAIN_RPC_URL` 没传进来，
 * 于是回落到 `127.0.0.1` —— 而容器内的 127.0.0.1 是容器自己，那儿没有代理。
 * 报错看起来像"链坏了"，实际是地址不对。一句"试的是 X"就能省掉整轮猜测。
 */
function explain(raw, url) {
  const connectish = /HTTP request failed|fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|timed out|socket hang up/i.test(raw);
  if (!connectish) return `${raw}（RPC 入口 ${url}）`;
  const looksLoopback = /^https?:\/\/(127\.0\.0\.1|localhost)\b/.test(url);
  return `${raw} —— 连不上 RPC 入口 ${url}。`
    + (looksLoopback
      ? '面板若跑在容器里，容器内的 127.0.0.1 是容器自己（那儿没有 RPC 代理）；'
        + '入口脚本应当传入 KARMACHAIN_RPC_URL 指向本边界的代理容器。'
      : '检查该边界的 RPC 代理容器是否在运行（scripts/devnet-start），以及本容器是否接在节点网络上。')
    + ' 注意这**不表示链停了** —— 链的可用性看上面的档位。';
}

/** 出资方与收款方都取自声明，不写死地址（宪法第十六条）。 */
function pickAccounts() {
  const { accounts } = readJson('blockchain/accounts/dev-accounts.json');
  // 与 e2e / verify 同一对账户，便于对照余额变化
  const funder = accounts.find((a) => a.label === 'anvil-0') ?? accounts[0];
  const recipient = accounts.find((a) => a.label === 'anvil-1' && a.address !== funder.address)
    ?? accounts.find((a) => a.address !== funder.address);
  return { funder, recipient };
}

function makeClients(protocol) {
  const rpcUrl = resolveRpcUrl(protocol);
  const chain = defineChain({
    id: protocol.chain.chainId,
    name: protocol.chain.blockchainName,
    nativeCurrency: {
      name: protocol.nativeToken.name,
      symbol: protocol.nativeToken.symbol,
      decimals: protocol.nativeToken.decimals,
    },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const transport = http(rpcUrl, { timeout: 20_000, retryCount: 0 });
  const { funder, recipient } = pickAccounts();
  return {
    rpcUrl,
    recipient,
    pub: createPublicClient({ chain, transport }),
    // account 只活在这个闭包里
    wallet: createWalletClient({ account: privateKeyToAccount(funder.privateKey), chain, transport }),
  };
}

/**
 * 单飞守卫。002 踩过并行发交易导致 nonce 间隙、进而
 * `WaitForTransactionReceiptTimeoutError` 的坑 —— 那次的教训是不要同时有两笔在飞。
 */
let inFlight = null;

export const isProbeInFlight = () => inFlight !== null;

/**
 * 发一笔探活交易。
 *
 * **绝不抛**：链停了本来就该返回 `confirmed: false`，那是本端点的正常输出之一
 * （SC-018），不是 HTTP 错误。
 */
export async function probeChain({ protocol } = {}) {
  if (inFlight) {
    return {
      confirmed: null, blockNumber: null, elapsedMs: 0, txHash: null,
      error: '已有探活在进行中 —— 同一时刻只允许一笔在飞（避免 nonce 间隙）',
      busy: true,
    };
  }

  const run = (async () => {
    const started = Date.now();
    let txHash = null;
    try {
      const p = protocol ?? readJson('blockchain/protocol.json');
      const { pub, wallet, recipient, rpcUrl } = makeClients(p);
      txHash = await wallet.sendTransaction({
        to: recipient.address,
        value: parseEther('0.001'),
      });
      const receipt = await pub.waitForTransactionReceipt({ hash: txHash, timeout: RECEIPT_TIMEOUT_MS });
      const elapsedMs = Date.now() - started;
      return receipt.status === 'success'
        ? {
          confirmed: true,
          blockNumber: Number(receipt.blockNumber),
          elapsedMs,
          txHash,
          error: null,
          via: rpcUrl,
        }
        : {
          confirmed: false,
          blockNumber: Number(receipt.blockNumber),
          elapsedMs,
          txHash,
          error: `回执状态为 ${receipt.status}`,
          via: rpcUrl,
        };
    } catch (err) {
      // 错误文本要有信息量，但**不得**带出任何密钥材料 —— viem 的错误里可能含请求体。
      const raw = String(err?.shortMessage ?? err?.message ?? err);
      return {
        confirmed: false,
        blockNumber: null,
        elapsedMs: Date.now() - started,
        txHash,
        // 把**试的是哪个地址**一并带出来。原先只回 viem 的 `HTTP request failed`，
        // 而那句话对"为什么连不上"零信息量 —— 2026-09-10 就是它让人无从下手：
        // 容器内回落到 127.0.0.1 时，报错看起来像链坏了，实际是地址不对。
        error: redact(explain(raw, rpcUrlOf(protocol))),
      };
    }
  })();

  inFlight = run;
  try {
    return await run;
  } finally {
    inFlight = null;
  }
}

/**
 * 从错误文本里抹掉可能出现的密钥材料与签名负载。
 *
 * 为什么必须做：viem 在某些失败路径上会把请求体（含已签名的 raw transaction）
 * 放进错误消息。原始交易本身不含私钥，但它是签名产物，不该出现在面板上；
 * 而 64 位十六进制串一旦出现在 UI 或日志里，就再也说不清它是什么了。
 * 宁可抹掉一段可能有用的调试信息，也不要在只读面板上渲染一串来源不明的十六进制。
 */
export function redact(text) {
  return String(text)
    .replace(/0x[0-9a-fA-F]{64,}/g, '0x…<已隐去>')
    .slice(0, 400);
}
