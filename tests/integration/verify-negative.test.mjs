// T037（负向）/ SC-011：网络停止时验证器必须以失败退出，并把失败归入 FR-030 的 rpc 类别，
// 其余检查标记 skip 而不是产生 13 条噪声。
//
// 本测试会停止并重新启动开发网络（约 2 分钟），因此不在默认集成集中运行：
//   KARMACHAIN_ALLOW_DISRUPTIVE=1 node --test tests/integration/verify-negative.test.mjs
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT, loadProtocol, derive } from '../../tools/protocol/load.mjs';

const protocol = loadProtocol();
const { chainIdHex } = derive(protocol);
const REPORT = resolve(REPO_ROOT, '.devnet/verify-report.json');
const RPC = `http://127.0.0.1:${process.env.KARMACHAIN_RPC_PORT || protocol.endpoints.hostRpcPort}${protocol.endpoints.rpcPath}`;
const disruptive = process.env.KARMACHAIN_ALLOW_DISRUPTIVE === '1';

const run = (cmd, args) => execFileSync(cmd, args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const compose = (...args) => run('docker', ['compose', ...args]);

/** 运行验证器，返回 { exitCode, stdout }（失败不抛）。 */
function runVerifier() {
  try {
    return { exitCode: 0, stdout: run('node', ['tools/verify/verify-network.mjs']) };
  } catch (e) {
    return { exitCode: e.status ?? 1, stdout: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

async function waitReady(timeoutS = 300) {
  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 4000);
    try {
      const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }), signal: ac.signal });
      if ((await res.json()).result === chainIdHex) return;
    } catch { /* not yet */ } finally { clearTimeout(timer); }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`devnet not ready within ${timeoutS}s`);
}

describe('verifier negative path', { skip: !disruptive && 'set KARMACHAIN_ALLOW_DISRUPTIVE=1 (this test stops the devnet)' }, () => {
  after(async () => {
    compose('up', '-d', 'devnet');
    await waitReady();
  });

  test('with the devnet stopped the verifier fails with category rpc and skips the rest', { timeout: 600_000 }, async () => {
    if (existsSync(REPORT)) rmSync(REPORT);
    compose('stop', 'devnet');

    const { exitCode, stdout } = runVerifier();

    assert.equal(exitCode, 1, 'verifier must exit non-zero when the chain is unreachable (FR-028)');
    assert.match(stdout, /KarmaChain is NOT READY/);
    assert.match(stdout, /\[FAIL\]\s+rpc\s+\[category: rpc\]/, 'the rpc failure must name its FR-030 category');
    assert.match(stdout, /is the devnet running\?/, 'the message must be actionable');

    assert.ok(existsSync(REPORT), 'a JSON report must be written even on failure');
    const json = JSON.parse(readFileSync(REPORT, 'utf8'));
    assert.equal(json.overall, 'failed');
    assert.equal(json.checks.length, 13, 'all 13 checks must be accounted for');

    const rpc = json.checks.find((c) => c.id === 'rpc');
    assert.equal(rpc.status, 'fail');
    assert.equal(rpc.category, 'rpc');

    const others = json.checks.filter((c) => c.id !== 'rpc');
    assert.equal(others.every((c) => c.status === 'skip'), true, `non-rpc checks must be skipped, got: ${others.filter((c) => c.status !== 'skip').map((c) => `${c.id}=${c.status}`).join(', ')}`);
    assert.equal(json.checks.filter((c) => c.status === 'fail').length, 1, 'exactly one failure, not 13');
  });
});
