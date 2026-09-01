// T026 / SC-003：reset → start 重复 N 次，创世区块哈希必须全等且等于 blockchain/genesis/karmachain.genesis.hash；
// 另断言普通 stop → start 后高度不回退（FR-005）。
//
// 在宿主运行（需要 docker CLI）：  npm run test:e2e -- --test-name-pattern=reset
//   KARMACHAIN_RESET_CYCLES=10   循环次数（SC-003 要求 10；快速冒烟可设 2）
//   KARMACHAIN_STARTUP_TIMEOUT   每次启动等待上限（秒，默认 300）
// 长时任务：10 轮 ≈ 15 分钟。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT, loadProtocol, derive } from '../../tools/protocol/load.mjs';

const protocol = loadProtocol();
const { chainIdHex } = derive(protocol);
const CYCLES = Number(process.env.KARMACHAIN_RESET_CYCLES || 10);
const TIMEOUT_S = Number(process.env.KARMACHAIN_STARTUP_TIMEOUT || 300);
const PORT = process.env.KARMACHAIN_RPC_PORT || protocol.endpoints.hostRpcPort;
const RPC = `http://127.0.0.1:${PORT}${protocol.endpoints.rpcPath}`;
const EXPECTED_GENESIS_HASH = readFileSync(resolve(REPO_ROOT, 'blockchain/genesis/karmachain.genesis.hash'), 'utf8').trim();

const dbg = (...a) => { if (process.env.KARMACHAIN_E2E_DEBUG) console.log('[e2e]', new Date().toISOString().slice(11, 19), ...a); };
const compose = (...args) => {
  dbg('docker compose', args.join(' '));
  const out = execFileSync('docker', ['compose', ...args], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  dbg('  done');
  return out;
};

// 注意：不用 AbortSignal.timeout() —— 它的计时器是 unref 的；当连接被 Docker 端口代理接受但容器内尚无应答时，
// 事件循环里没有任何 ref 句柄，node --test 会以 "Promise resolution is still pending but the event loop has already
// resolved" 取消整个测试。这里用显式 ref 计时器兜底。
async function rpc(method, params = [], timeoutMs = 5000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`rpc ${method} timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: ac.signal });
    const body = await res.json();
    if (body.error) throw new Error(body.error.message);
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

async function waitReady() {
  const deadline = Date.now() + TIMEOUT_S * 1000;
  while (Date.now() < deadline) {
    try { if ((await rpc('eth_chainId')) === chainIdHex) { dbg('ready'); return; } } catch (e) { dbg('not ready:', e.message.slice(0, 60)); }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`devnet not ready within ${TIMEOUT_S}s at ${RPC}`);
}

const genesisHash = async () => (await rpc('eth_getBlockByNumber', ['0x0', false])).hash;
const height = async () => Number(await rpc('eth_blockNumber'));

describe(`reset → recreate ×${CYCLES}`, { timeout: (TIMEOUT_S + 60) * 1000 * (CYCLES + 2) }, () => {
  const hashes = [];
  const seconds = [];

  test(`every fresh start yields genesis hash ${EXPECTED_GENESIS_HASH.slice(0, 14)}…`, async () => {
    for (let i = 1; i <= CYCLES; i++) {
      compose('down', '-v', '--remove-orphans');
      const t0 = Date.now();
      compose('up', '-d', 'devnet');
      await waitReady();
      seconds.push((Date.now() - t0) / 1000);
      const h = await genesisHash();
      hashes.push(h);
      assert.equal(h, EXPECTED_GENESIS_HASH, `cycle ${i}: genesis hash mismatch`);
      assert.equal(await height() >= 0, true);
    }
    assert.equal(new Set(hashes).size, 1, `hashes differ across cycles: ${[...new Set(hashes)].join(', ')}`);
    console.log(`  cycles=${CYCLES} start times (s): ${seconds.map((s) => s.toFixed(0)).join(', ')}  max=${Math.max(...seconds).toFixed(0)}`);
  });

  test('stop → start preserves height (FR-005) and genesis hash', async () => {
    const h0 = await height();
    compose('stop', 'devnet');
    compose('up', '-d', 'devnet');
    await waitReady();
    assert.ok((await height()) >= h0, 'height went backwards after restart');
    assert.equal(await genesisHash(), EXPECTED_GENESIS_HASH);
  });
});
