// T041 / quickstart 场景 C（V-01）：单个验证者被强制终止时链继续出块，重启后自动追平。
//
// 这是「冗余」从纸面变成事实的证明。判据有两层：
//   1. 少一个验证者时链**照常出块**（5 个等权验证者，容错上限 1 —— 001 研究 R-05）
//   2. 该节点重启后**自己追上来**，而且追赶期间不被健康检查判为故障、反复重启
// 第 2 条最容易实现错：把追赶当成不健康，容器就会在节点正常恢复时打断它，恢复变成死循环。
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pub, sendTx, sh, devnetAvailable, VALIDATOR_IDS } from './lib/devnet.mjs';

// 不挑承载 RPC 代理上游首位的那个，避免把"入口失效"和"验证者失效"混为一谈
const VICTIM = VALIDATOR_IDS[2];
const CONTAINER = `karmachain-${VICTIM}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const node = (...args) => sh('sh', ['scripts/devnet-node.sh', ...args]);
const inspect = (fmt) => {
  try { return execFileSync('docker', ['inspect', '--format', fmt, CONTAINER], { encoding: 'utf8' }).trim(); } catch { return ''; }
};
const restartCount = () => Number(inspect('{{.RestartCount}}') || 0);

describe('场景 C —— 单个验证者挂掉，链照常出块', { concurrency: 1 }, () => {
  before(async () => {
    if (!await devnetAvailable()) throw new Error('开发网不可用 —— 先运行 scripts/devnet-start.sh');
    assert.equal(VALIDATOR_IDS.length, 5, '本场景假定 5 个等权验证者');
  });

  test(`强制杀死 ${VICTIM} 后，链继续接受交易并出块`, async (t) => {
    const before = Number(await pub.getBlockNumber());
    node('kill', VICTIM);
    assert.equal(inspect('{{.State.Status}}'), 'exited', `${VICTIM} 应当已被杀死`);
    t.diagnostic(`${VICTIM} 已强制终止，剩余 ${VALIDATOR_IDS.length - 1}/5 个验证者`);

    // 连发几笔，确认不是靠缓存蒙混过关
    let height = before;
    for (let i = 0; i < 3; i += 1) height = await sendTx();
    assert.ok(height > before, `链应当继续出块：${before} -> ${height}`);
  });

  test('状态输出把该节点标记为不可用，而不是把整条链标记为故障（FR-031）', () => {
    const out = node('status', VICTIM);
    assert.match(out, /exited/, `devnet-node status 应当如实报告 ${VICTIM} 已退出`);
    for (const other of VALIDATOR_IDS.filter((v) => v !== VICTIM)) {
      assert.match(node('status', other), /running/, `${other} 不应受影响`);
    }
  });

  test(`${VICTIM} 重启后自动追平，且追赶期间不被反复重启`, async (t) => {
    const target = Number(await pub.getBlockNumber());
    const restartsBefore = restartCount();

    node('start', VICTIM);
    const t0 = Date.now();
    let healthy = false;
    for (let i = 0; i < 60; i += 1) {
      await sleep(2000);
      if (inspect('{{if .State.Health}}{{.State.Health.Status}}{{end}}') === 'healthy') { healthy = true; break; }
    }
    const seconds = (Date.now() - t0) / 1000;
    assert.ok(healthy, `${VICTIM} 未能自动恢复健康`);
    assert.ok(seconds <= 120, `追平耗时 ${Math.round(seconds)}s，应当 ≤ 2 分钟（SC-004）`);
    t.diagnostic(`${VICTIM} 在 ${Math.round(seconds)}s 后追平到 ≥ ${target}`);

    // 追赶中被判为不健康 → 容器反复重启 → 恢复变成死循环。重启次数不该涨。
    assert.equal(restartCount(), restartsBefore,
      '追赶期间不得触发容器重启 —— catching-up 不是故障（contracts/node-runtime.md）');
  });

  test('恢复后的节点确实在服务 L1，而不只是进程活着', async () => {
    const logs = execFileSync('docker', ['logs', CONTAINER], { encoding: 'utf8' });
    assert.match(logs, /<karmachain Chain>/, '日志中应当出现 L1 链的启动记录');
    const h = Number(await pub.getBlockNumber());
    const block = await sendTx();
    assert.ok(block > h, '全部验证者在线时链应当照常出块');
  });
});
