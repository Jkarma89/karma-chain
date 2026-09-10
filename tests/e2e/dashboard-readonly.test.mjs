// T026 —— 面板自身不得产生区块（功能 003 / SC-017、FR-033）。
//
// ## 为什么这一条要单独守
//
// 自动周期性探活会持续产生区块，于是"高度"不再反映真实业务活动 ——
// 而 FR-015（按需出块、高度停滞不是活性信号）恰恰把这一点当成一条诊断依据。
// **自动写入会让那条依据失效**，连带毁掉 dashboard-idle 那个用例的前提。
//
// 用户在规格阶段已就此裁定：自动路径纯只读，探活只能人工触发。
//
// 窗口默认 60 秒。**30 分钟的完整判据在 quickstart 场景 H 手工执行。**
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pub, devnetAvailable } from './lib/devnet.mjs';
import { REPO_ROOT } from '../../tools/protocol/load.mjs';
import { startDashboard, waitFirstPoll } from './lib/dashboard.mjs';

const WINDOW_MS = Number(process.env.KARMACHAIN_READONLY_WINDOW_MS ?? 60_000);

const SKIP = !(await devnetAvailable()) ? '开发网未运行 —— 先 scripts/devnet-start' : undefined;

describe('面板 —— 自动路径纯只读', { skip: SKIP, concurrency: 1 }, () => {
  let dash;
  before(async () => {
    dash = await startDashboard();
    await waitFirstPoll(dash);
  });
  after(async () => { await dash?.stop(); });

  test(`运行 ${WINDOW_MS / 1000}s 且不点探活：高度零增长（SC-017）`, async (t) => {
    const before = Number(await pub.getBlockNumber());
    const roundsBefore = dash.poller.state.rounds;

    await new Promise((r) => setTimeout(r, WINDOW_MS));

    const after = Number(await pub.getBlockNumber());
    const rounds = dash.poller.state.rounds - roundsBefore;
    t.diagnostic(`窗口内完成 ${rounds} 轮采集，高度 ${before} → ${after}`);

    assert.ok(rounds > 0, '窗口内应当完成过若干轮采集 —— 否则这条只读性断言是空的');
    assert.equal(after, before,
      `面板运行 ${rounds} 轮后高度从 ${before} 变成 ${after} —— `
      + '自动路径里有写操作。那会让"高度停滞不是活性信号"这条诊断依据失效（FR-015 / FR-033）');
  });

  test('轮询路径的源码里没有任何写链的调用（FR-033）', () => {
    // 静态守卫：光看高度不涨还不够 —— 也许这一轮恰好没触发。
    // 判据是 poll.mjs 与 server.mjs 里不出现签名/发交易的痕迹。
    for (const rel of ['tools/dashboard/poll.mjs', 'tools/dashboard/server.mjs']) {
      const src = readFileSync(resolve(REPO_ROOT, rel), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
      for (const re of [
        /sendTransaction/, /writeContract/, /eth_sendRawTransaction/,
        /createWalletClient/, /privateKeyToAccount/,
      ]) {
        assert.doesNotMatch(src, re,
          `${rel} 出现了 ${re.source} —— 轮询路径不得写链，探活只能在 probe-tx.mjs 里`);
      }
    }
  });

  test('探活的实现与轮询隔离在不同文件 —— 便于上面那条守卫成立', () => {
    const server = readFileSync(resolve(REPO_ROOT, 'tools/dashboard/server.mjs'), 'utf8');
    assert.match(server, /probe-tx\.mjs/,
      '探活须由独立模块提供（server 只在收到 POST /api/probe 时调它）');
  });
});
