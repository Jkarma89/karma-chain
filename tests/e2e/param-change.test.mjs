// T031 / quickstart 场景 E：协议参数变更的完整闭环（FR-018/FR-019/FR-021，宪法第十五条）。
//   ① 改 chainId（20189 → 20190）后创世漂移测试必须变红；
//   ② `npm run protocol:render` 重新生成派生物；
//   ③ 携带旧链数据启动必须被 stamp 拒绝（退出 12）；
//   ④ reset 后启动，新 chainId（0x4ede）生效；
//   ⑤ 无论成败，恢复原始文件并把网络重置回原链。
// 在宿主运行（需要 docker CLI）：node --test tests/e2e/param-change.test.mjs   （约 3-4 分钟）
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from '../../tools/protocol/load.mjs';

const P = (rel) => resolve(REPO_ROOT, rel);
const FILES_TO_BACKUP = [
  'blockchain/protocol.json',
  'blockchain/genesis/karmachain.genesis.json',
  'docs/protocol-parameters.md',
  'blockchain/compose.env',
];
const backups = new Map(FILES_TO_BACKUP.map((f) => [f, readFileSync(P(f))]));

const ORIG_CHAIN_ID = 20189;
const NEW_CHAIN_ID = 20190;
const ORIG_HEX = '0x4edd';
const NEW_HEX = '0x4ede';

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const runExpectFail = (cmd, args) => {
  try { run(cmd, args); return { failed: false, output: '' }; }
  catch (e) { return { failed: true, status: e.status, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }; }
};
const compose = (...args) => run('docker', ['compose', ...args]);

async function rpc(method, params = [], timeoutMs = 5000) {
  const proto = JSON.parse(readFileSync(P('blockchain/protocol.json'), 'utf8'));
  const url = `http://127.0.0.1:${process.env.KARMACHAIN_RPC_PORT || proto.endpoints.hostRpcPort}${proto.endpoints.rpcPath}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: ac.signal });
    const body = await res.json();
    if (body.error) throw new Error(body.error.message);
    return body.result;
  } finally { clearTimeout(timer); }
}

async function waitChainId(expectedHex, timeoutS = 300) {
  const deadline = Date.now() + timeoutS * 1000;
  let last = 'none';
  while (Date.now() < deadline) {
    try { last = await rpc('eth_chainId'); if (last === expectedHex) return; } catch (e) { last = e.message.slice(0, 50); }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`chainId ${expectedHex} not observed within ${timeoutS}s (last: ${last})`);
}

async function waitContainerExit(timeoutS = 120) {
  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline) {
    const state = run('docker', ['inspect', '--format', '{{.State.Status}}', 'karmachain-devnet']).trim();
    if (state === 'exited' || state === 'dead') {
      return Number(run('docker', ['inspect', '--format', '{{.State.ExitCode}}', 'karmachain-devnet']).trim());
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`container did not exit within ${timeoutS}s`);
}

after(async () => {
  // ⑤ 恢复原始文件 + 把网络重置回原链（无论测试成败）
  for (const [f, buf] of backups) writeFileSync(P(f), buf);
  compose('down', '-v', '--remove-orphans');
  compose('up', '-d', 'devnet');
  await waitChainId(ORIG_HEX);
});

test('protocol change workflow: drift → render → refuse (12) → reset → new chain', { timeout: 900_000 }, async () => {
  // 0) 基线：原参数的链在运行
  compose('up', '-d', 'devnet');
  await waitChainId(ORIG_HEX);

  // 1) 修改 chainId（模拟协议变更）
  const proto = JSON.parse(readFileSync(P('blockchain/protocol.json'), 'utf8'));
  assert.equal(proto.chain.chainId, ORIG_CHAIN_ID);
  proto.chain.chainId = NEW_CHAIN_ID;
  writeFileSync(P('blockchain/protocol.json'), `${JSON.stringify(proto, null, 2)}\n`);

  // 2) 创世漂移测试必须失败，且指向 protocol:render
  const drift = runExpectFail('node', ['tools/protocol/render-genesis.mjs', '--check']);
  assert.equal(drift.failed, true, 'genesis drift check should fail after a parameter change');
  assert.match(drift.output, /DRIFT/);

  // 3) 重新生成派生物
  run('npm', ['run', 'protocol:render'], { shell: process.platform === 'win32' });
  assert.match(readFileSync(P('blockchain/genesis/karmachain.genesis.json'), 'utf8'), new RegExp(`"chainId": ${NEW_CHAIN_ID}`));

  // 4) 旧链数据 + 新参数：重启必须被 stamp 拒绝，退出 12
  compose('restart', 'devnet');
  const exitCode = await waitContainerExit();
  assert.equal(exitCode, 12, 'container should refuse to start with mismatched chain data (exit 12)');
  const logs = compose('logs', '--no-log-prefix', '--tail', '40', 'devnet');
  assert.match(logs, /does not match the current protocol configuration/);
  assert.match(logs, /devnet-reset/);

  // 5) reset 后启动：新链生效
  compose('down', '-v', '--remove-orphans');
  compose('up', '-d', 'devnet');
  await waitChainId(NEW_HEX);
  assert.equal(await rpc('eth_chainId'), NEW_HEX);
});
