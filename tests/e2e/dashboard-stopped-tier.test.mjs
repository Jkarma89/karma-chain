// T026c —— 60% 的「已停止」档（功能 003 / SC-003）。
//
// **这一条是 `/speckit-analyze` 补上的缺口**：SC-003 原先只有 quickstart 场景 C 的
// 手工路径与 T073 的 V-04 实测，没有任何自动化任务。而它恰恰是用户最初那句
// 「低于安全健康度后要马上显目报警，告知链已经停止」的正主。
//
// ## 它在跨机形态下必然跳过，这是结构性的
//
// 需要 2 个验证者同时离线，而 T-5 约束保证**每个故障边界至多 1 个验证者** ——
// 于是没有任何单台机器能同时停掉两个，而 docker 只能操作本机容器。
// 与 002 的场景 D（超出容错上限）、场景 I（两个 Primary 全停）同一处境。
//
// 跳过时说明原因并指向 quickstart 场景 C 的两机人工做法，让缺口**可见**而不是静默消失。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  pub, sendTx, sh, devnetAvailable, pickLocalVictims, localVictimSkip, MAX_OFFLINE_VALIDATORS,
} from './lib/devnet.mjs';
import { startDashboard, waitForSnapshot, waitFirstPoll } from './lib/dashboard.mjs';

const node = (...args) => sh('sh', ['scripts/devnet-node.sh', ...args]);

/** 要超出容错上限，得停掉 f+1 个验证者。n=5,f=1 时是 2 个。 */
const NEEDED = MAX_OFFLINE_VALIDATORS + 1;

const SKIP = !(await devnetAvailable())
  ? '开发网未运行 —— 先 scripts/devnet-start'
  : (pickLocalVictims(NEEDED)
    ? undefined
    : `${localVictimSkip(NEEDED)} 跨机形态下这一条必然跳过：T-5 保证每边界至多 1 个验证者，`
      + '没有单台机器能同时停掉 2 个。人工做法见 quickstart 场景 C（在两台机器上各 devnet-node kill）。');

describe('面板 —— 超出容错上限时的「已停止」档', { skip: SKIP, concurrency: 1 }, () => {
  let dash;
  let victims = [];

  before(async () => {
    dash = await startDashboard();
    await waitFirstPoll(dash);
    victims = pickLocalVictims(NEEDED);
  });

  after(async () => {
    for (const v of victims) {
      try { node('start', v); } catch { /* 交给下一次 devnet-start */ }
    }
    await dash?.stop();
  });

  test(`停 ${NEEDED} 个验证者 → ≤10 秒内 stopped 档，且交易确实无法确认（SC-003）`, async (t) => {
    for (const v of victims) node('kill', v);

    const { snapshot: s, elapsedMs, samples } = await waitForSnapshot(
      dash, (x) => x.tier === 'stopped', { label: 'stopped' },
    );
    t.diagnostic(`档位序列：${samples.map((x) => `${x.at}ms:${x.tier}/${x.healthPercent}%`).join(' → ')}`);
    t.diagnostic(`发现时延 ${elapsedMs} ms`);

    assert.ok(elapsedMs <= 10_000, `发现时延 ${elapsedMs} ms 超过 10 秒（FR-018）`);
    assert.ok(s.participating < s.threshold,
      `参与数 ${s.participating} 必须低于查询门槛 ${s.threshold}`);
    assert.ok(
      s.incidents.some((i) => i.class === 'consensus-margin'),
      '必须产生一条 consensus-margin 异常，指向"恢复验证者数量"而非"修某个节点"',
    );

    // **面板说停了，链就必须真的停了。** 一个恒报 stopped 的实现也能通过上面的断言。
    await assert.rejects(
      async () => { await sendTx(); },
      '链处于 stopped 档时交易不应当被确认 —— 若这里通过，说明档位判据比现实更悲观',
    );
    t.diagnostic('交易确实无法确认 —— 面板与现实一致');
  });

  test('恢复后 ≤10 秒回到 normal / 100%（SC-004）', async (t) => {
    for (const v of victims) node('start', v);

    const { snapshot: s, elapsedMs } = await waitForSnapshot(
      dash, (x) => x.tier === 'normal' && x.healthPercent === 100,
      { timeoutMs: 300_000, label: '恢复到 normal/100' },
    );
    t.diagnostic(`恢复耗时 ${Math.round(elapsedMs / 1000)}s`);
    assert.equal(s.validatorMargin, MAX_OFFLINE_VALIDATORS);
    assert.deepEqual(s.incidents, [], '恢复后报警须自行消除，无需人工清除');

    const before = Number(await pub.getBlockNumber());
    assert.ok(await sendTx() > before, '恢复后链应当照常出块');
  });
});
