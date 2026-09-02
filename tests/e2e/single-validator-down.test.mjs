// T042 / research R-05：5 个 L1 验证者中 1 个离线时，网络必须继续出块（默认 Snow 参数下
// alphaConfidence/K = 15/20 = 75%，4/5 = 80% ≥ 75%），且 devnet-status 与验证器必须把它报出来。
//
// 需要开发网络处于运行状态。会暂停并恢复 l1-3（SIGSTOP/SIGCONT，完全可逆）。
//   node --test tests/e2e/single-validator-down.test.mjs
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { REPO_ROOT, loadProtocol } from '../../tools/protocol/load.mjs';
import { protocol, publicClient, walletClient } from '../../tools/verify/lib/rpc.mjs';

const VICTIM = process.env.KARMACHAIN_VICTIM_NODE || 'l1-3';
const keys = JSON.parse(readFileSync(resolve(REPO_ROOT, 'blockchain/accounts/dev-accounts.json'), 'utf8'));
const keyOf = (label) => keys.accounts.find((a) => a.label === label);

const run = (cmd, args) => execFileSync(cmd, args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const runAllowFail = (cmd, args) => {
  try { return { code: 0, out: run(cmd, args) }; }
  catch (e) { return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }; }
};
const devnetNode = (...a) => run('docker', ['compose', 'exec', '-T', 'devnet', 'devnet-node', ...a]);
const devnetStatus = (...a) => runAllowFail('docker', ['compose', 'exec', '-T', 'devnet', 'devnet-status', ...a]);

/** 发一笔转账并等确认，返回确认耗时（秒）。 */
async function sendAndConfirm(fromLabel, toLabel, value = parseEther('0.01')) {
  const account = privateKeyToAccount(keyOf(fromLabel).privateKey);
  const to = keyOf(toLabel).address;
  const t0 = Date.now();
  const hash = await walletClient(account).sendTransaction({ to, value });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
  assert.equal(receipt.status, 'success', `transfer ${fromLabel} → ${toLabel} did not succeed`);
  return { seconds: (Date.now() - t0) / 1000, blockNumber: Number(receipt.blockNumber) };
}

async function waitAllHealthy(timeoutS = 120) {
  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline) {
    if (devnetStatus().code === 0) return true;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

/** 把受害节点恢复到健康：先 start（若已停止），必要时 stop+start 重建 VM 插件连接。 */
async function restoreVictim() {
  try { devnetNode('resume', VICTIM); } catch { /* 未暂停 */ }
  try { devnetNode('start', VICTIM); } catch { /* 已在运行 */ }
  if (await waitAllHealthy(90)) return;
  // 兜底：长时间冻结会拆掉 avalanchego 与 subnet-evm 插件间的 gRPC 连接，只能真正重启
  devnetNode('stop', VICTIM);
  devnetNode('start', VICTIM);
  assert.ok(await waitAllHealthy(180), `${VICTIM} did not become healthy again even after stop+start`);
}

// 整套约 4-6 分钟：容器内跑一次验证器就要 40 s 以上，恢复健康还要等健康检查周期。
describe(`one L1 validator down (${VICTIM})`, { timeout: 1_500_000 }, () => {
  before(async () => {
    try { await publicClient.getChainId(); } catch (e) {
      assert.fail(`devnet not reachable — run scripts/devnet-start first (${e.message})`);
    }
    // 上一次中断的运行可能留下节点处于暂停状态：先无条件恢复，再等全网健康
    await restoreVictim();
  });

  after(async () => {
    await restoreVictim();   // 无论测试成败都恢复
  });

  test('network keeps confirming transactions with 4 of 5 validators (R-05: 80% >= 75% quorum)', async () => {
    const before = await sendAndConfirm('anvil-1', 'anvil-2');
    assert.ok(before.seconds <= 10, `baseline confirmation took ${before.seconds}s (SC-006 applies to a healthy network)`);

    // 用 stop（真正终止进程）而不是 pause：本套件需要节点离线约 2 分钟，而长时间 SIGSTOP 会拆掉
    // avalanchego 与 subnet-evm 插件之间的 gRPC 连接，SIGCONT 后无法自愈（见 devnet-node 说明）。
    // stop 也是更贴近现实的"节点崩溃"模型，且探测立即被拒而非等超时。
    devnetNode('stop', VICTIM);
    // 给健康检查与共识一点时间感知节点消失
    await new Promise((r) => setTimeout(r, 12_000));

    const during = await sendAndConfirm('anvil-1', 'anvil-2');
    assert.ok(during.blockNumber > before.blockNumber, 'a new block must still be produced with one validator down');
    // 降级态下确认会变慢：共识需要等对已停节点的查询超时（adaptive timeout 上限 10 s）。
    // SC-006 的 10 秒目标只针对健康网络；这里只要求"仍能在回执超时内确认"，并把实测值打印出来。
    console.log(`  confirmation latency: healthy ${before.seconds.toFixed(1)}s -> one validator down ${during.seconds.toFixed(1)}s`);
    assert.ok(during.seconds <= 45, `confirmation with one validator down took ${during.seconds}s (expected well under the 60 s receipt timeout)`);
  });

  test('devnet-status reports the node unhealthy and exits 1', async () => {
    const { code, out } = devnetStatus();
    assert.equal(code, 1, 'devnet-status must exit 1 while a node is unhealthy');
    assert.match(out, /nodes NOT healthy \[category: node\]/, 'must name the FR-030 category');
    const line = out.split('\n').find((l) => l.startsWith(VICTIM));
    assert.ok(line, `${VICTIM} row missing from the status table (a stopped node must still be listed)`);
    assert.match(line, /\bfalse\b/, `${VICTIM} must be reported unhealthy: ${line}`);

    const json = JSON.parse(devnetStatus('--json').out);
    assert.equal(json.unhealthy, 1, 'exactly one node unhealthy');
    const victim = json.nodes.find((n) => n.label === VICTIM);
    assert.equal(victim.healthy, false);
    assert.equal(victim.running, false, 'a stopped node must not be reported as running (socat proxy shares the port)');
    const others = json.nodes.filter((n) => n.label !== VICTIM);
    assert.equal(others.every((n) => n.healthy === true), true, 'the other nodes must stay healthy');
  });

  test('the containerized verifier fails with categories node and validator, chain-level checks still pass', { timeout: 420_000 }, () => {
    // 必须在 verify 容器内运行：每节点端点只在 compose 网络内可达，宿主上这两项会合理地 SKIP。
    const { code, out } = runAllowFail('docker', ['compose', 'run', '--rm', 'verify', 'npm', 'run', 'verify', '--', '--quick']);
    assert.equal(code, 1, `verifier must fail while a validator is down; output:\n${out.slice(-800)}`);
    assert.match(out, /\[FAIL\]\s+node\s+\[category: node\]/, 'node check must fail with the node category');
    assert.match(out, /\[FAIL\]\s+validator\s+\[category: validator\]/, 'validator check must fail with the validator category');
    assert.match(out, new RegExp(VICTIM), 'the failing node must be named');
    assert.match(out, /\[OK\]\s+transfer/, 'chain-level transfer must still succeed');
    assert.match(out, /KarmaChain is NOT READY/);
  });

  test('the host-run verifier degrades to SKIP for per-node checks instead of false failures', () => {
    const { out } = runAllowFail('node', ['tools/verify/verify-network.mjs', '--quick']);
    assert.match(out, /\[SKIP\]\s+node\s+.*devnet container network/, 'host run must explain why per-node checks are skipped');
    assert.match(out, /\[SKIP\]\s+validator\s+.*devnet-verify/, 'the skip reason must point at the in-container command');
  });

  test('restart restores all nodes to healthy', async () => {
    await restoreVictim();
    const { code, out } = devnetStatus();
    assert.equal(code, 0);
    assert.match(out, /all \d+ nodes healthy/);
    const expected = loadProtocol().primaryNetwork.nodeCount + protocol.validators.count;
    const json = JSON.parse(devnetStatus('--json').out);
    assert.equal(json.nodes.length, expected);
    assert.equal(json.unhealthy, 0);
  });
});
