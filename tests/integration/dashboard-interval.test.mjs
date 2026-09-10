// T046 —— 轮询间隔的上限与快照年龄（功能 003 / FR-018）。
//
// ## FR-018 的预算推导，写成可执行的判据
//
//   发现时延 ≈ 轮询间隔 + 一轮探测的最坏耗时
//
// 一轮探测的最坏耗时由 `node-status.mjs` 的 `AbortSignal.timeout(4000)` 决定
// （不可达节点并行等满超时）。于是：
//
//   间隔上限 = 10 秒预算 − 4 秒探测超时 = 6 秒
//
// 这个推导若被人改坏（比如把间隔上限调到 30 秒图省事），FR-018 就悄悄失效了 ——
// 而"发现慢了"不会有任何东西报错。本文件是那条推导的守卫。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateInterval, createDashboardServer, parseArgs } from '../../tools/dashboard/server.mjs';
import { loadContext } from '../../tools/dashboard/poll.mjs';
import { REPO_ROOT } from '../../tools/protocol/load.mjs';

describe('间隔上限就是那条预算推导', () => {
  test('6 秒合法、7 秒被拒 —— 边界正好落在 10 − 4', () => {
    assert.equal(validateInterval(6), null);
    assert.ok(validateInterval(7));
  });

  test('拒绝理由里写出了推导，而不是只说"超了"', () => {
    const msg = validateInterval(30);
    assert.match(msg, /10/, '要提到 10 秒预算');
    assert.match(msg, /4/, '要提到 4 秒探测超时');
    assert.match(msg, /FR-018/, '要指向那条要求');
  });

  test('两个常量都以显式命名出现在源码里，不是魔法数', () => {
    const src = readFileSync(resolve(REPO_ROOT, 'tools/dashboard/server.mjs'), 'utf8');
    assert.match(src, /DETECTION_BUDGET_MS\s*=\s*10_000/, '预算须显式命名');
    assert.match(src, /PROBE_TIMEOUT_MS\s*=\s*4_000/, '探测超时须显式命名');
    assert.match(src, /MAX_INTERVAL_MS\s*=\s*DETECTION_BUDGET_MS\s*-\s*PROBE_TIMEOUT_MS/,
      '上限必须是**算出来**的，写死一个 6 就等于把推导藏起来了');
  });

  test('探测超时常量与 node-status.mjs 里的实际值一致', () => {
    // 若哪天 node-status 把 4000 改了而这里没跟上，预算推导就错了 ——
    // 而"发现慢了"不会有任何东西报错。所以要交叉校验。
    const probe = readFileSync(resolve(REPO_ROOT, 'tools/inspect/node-status.mjs'), 'utf8');
    assert.match(probe, /AbortSignal\.timeout\(4000\)/,
      'node-status 的探测超时不再是 4000 —— 请同步更新 server.mjs 的 PROBE_TIMEOUT_MS');
  });
});

describe('默认间隔下快照年龄有上界', () => {
  let ctx; let server; let poller; let base;

  before(async () => {
    ctx = loadContext();
    // 用**生产默认值**，不写死 —— 这条断言要覆盖用户实际跑的那个间隔
    ({ server, poller } = createDashboardServer({ ctx, intervalSeconds: parseArgs([]).intervalSeconds }));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    poller.start();
  });

  after(async () => {
    poller?.stop();
    if (server) await new Promise((r) => server.close(r));
  });

  test('连续采样 18 秒，快照年龄始终 ≤ 10 秒（FR-018）', async (t) => {
    const ages = [];
    const started = Date.now();
    while (Date.now() - started < 18_000) {
      const s = await (await fetch(`${base}/api/snapshot`)).json();
      if (s.collectedAt != null) ages.push(Date.now() - s.collectedAt);
      await new Promise((r) => setTimeout(r, 500));
    }
    const max = Math.max(...ages);
    t.diagnostic(`${ages.length} 个样本，年龄最大 ${max} ms，中位 ${[...ages].sort((a, b) => a - b)[Math.floor(ages.length / 2)]} ms`);
    assert.ok(ages.length > 0, '应当采到样本');
    assert.ok(max <= 10_000,
      `快照年龄最大 ${max} ms 超过 10 秒 —— 面板显示的数据比 FR-018 允许的更旧`);
  });

  test('pollIntervalMs 如实反映实际间隔 —— 页面的陈旧判据依赖它', async () => {
    const s = await (await fetch(`${base}/api/snapshot`)).json();
    assert.equal(s.pollIntervalMs, parseArgs([]).intervalSeconds * 1000);
  });
});
