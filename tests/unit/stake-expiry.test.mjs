// P 链质押到期的判定（功能 005 / US4，2026-09-26）。
//
// ## 这一条守的是什么
//
// F-7 把 P 链权益推到 6 个持有者各 16.66%，于是掉一台机器还剩 83.34% ≥ 80%。
// **但每一份质押都有到期日**，到期后那个验证者自动退出集合，分布悄悄退回去 ——
// P 链不报警，面板也不会（它看的是当前分布，不是到期日）。
//
// 实测到的具体情形：既有两个 Primary 的质押 **2027-09-08** 到期，
// 而 T045 补的那四笔是 2027-09-26。**绑定日期是前者**，比后者还早 18 天。
//
// ## 判据不是"快到期了"，是"到期之后还撑不撑得住"
//
// 单说"某笔 30 天后到期"没用 —— 到期的若是一个本来就多余的持有者，那不是问题。
// 要问的是：**把窗口内会到期的拿掉之后，掉任意一台机器还剩多少？**
// 这样写顺带覆盖一种文档写不出来的情形：哪天有人补了第 7 个持有者，
// 两个 Primary 到期也不再致命 —— 那时这一条会自己不红，**不需要有人来改它**。
//
// ## 变红检查（2026-09-26）
//
// 把 `assessStakeExpiry` 里的 `survivors` 改成 `withDays`（即"到期的也算还在"）→
// 第 ③ 条立刻红（本该 fail 的情形被判成 ok）。改回即绿。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assessStakeExpiry, WARN_DAYS } from '../../tools/verify/checks/stake-expiry.mjs';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 26);           // 2026-09-26
const AVAX = 1_000_000_000n;

const holder = (domain, inDays, avax = 1_000_000) => ({
  domain,
  label: `${domain}`,
  weight: BigInt(avax) * AVAX,
  endTimeMs: NOW + inDays * DAY,
});

/** 今天的真实形态：6 个持有者，两个 Primary 先到期。 */
const today = () => [
  holder('ubuntu-1', 347), holder('ubuntu-2', 347),      // 2027-09-08
  holder('ubuntu-3', 365), holder('ubuntu-4', 365),      // 2027-09-26
  holder('ubuntu-5', 365), holder('ubuntu-6', 365),
];

describe('P 链质押到期', () => {
  test('① 今天：最早 347 天后，还没进窗口 → ok，但日期要报出来', () => {
    const a = assessStakeExpiry(today(), { now: NOW });
    assert.equal(a.verdict, 'ok');
    assert.equal(a.soonest.inDays, 347);
    assert.equal(new Date(a.soonest.endTimeMs).toISOString().slice(0, 10), '2027-09-08');
    assert.deepEqual(a.expiring, [], '还没到窗口内，不该列出任何一笔');
  });

  test('② 进了窗口但到期后仍够 → ok（不是所有到期都值得报警）', () => {
    // 7 个持有者，其中 1 个 10 天后到期。去掉它还有 6 个，掉一台剩 83.33%。
    const seven = [
      holder('a', 10), holder('b', 300), holder('c', 300),
      holder('d', 300), holder('e', 300), holder('f', 300), holder('g', 300),
    ];
    const a = assessStakeExpiry(seven, { now: NOW });
    assert.equal(a.verdict, 'ok');
    assert.deepEqual(a.expiring, ['a']);
    assert.equal(a.remainingAfter, 83.33);
  });

  test('③ 2027-09-08 那一天的形态：两个 Primary 到期 → fail', () => {
    // 把时钟拨到距那天 30 天（在 45 天窗口内）。去掉两个 Primary 只剩 4 个各 25%，
    // 掉一台剩 75% < 80% —— **F-7 买到的性质在那天失效**。
    const now = NOW + (347 - 30) * DAY;
    const a = assessStakeExpiry(today(), { now });
    assert.equal(a.verdict, 'fail', '两个 Primary 到期后只剩 4 个各 25%，必须判红');
    assert.equal(a.remainingAfter, 75);
    assert.deepEqual(a.expiring.sort(), ['ubuntu-1', 'ubuntu-2']);
    assert.match(a.reason, /P 链引导会失败/);
  });

  test('④ 已经过期的算进"会到期"那一桶，不是"还在"', () => {
    const now = NOW + 400 * DAY;            // 全部过期之后
    const a = assessStakeExpiry(today(), { now });
    assert.equal(a.verdict, 'fail');
    assert.equal(a.remainingAfter, 0, '全过期之后没有幸存者，剩 0%');
    assert.ok(a.soonest.inDays < 0, '已过期应当是负数天，不该被夹到 0');
  });

  test('⑤ 窗口可调，且判据用的是**机器**而不是持有者', () => {
    // 两台各握两份：去掉 ubuntu-1 的两份之后剩 6 份分在 3 台，掉一台剩 66.66%。
    const packed = [
      holder('ubuntu-1', 10), holder('ubuntu-1', 10),
      holder('ubuntu-2', 300), holder('ubuntu-2', 300),
      holder('ubuntu-3', 300), holder('ubuntu-3', 300),
      holder('ubuntu-4', 300), holder('ubuntu-4', 300),
    ];
    const a = assessStakeExpiry(packed, { now: NOW, warnDays: 20 });
    assert.equal(a.verdict, 'fail');
    assert.equal(a.remainingAfter, 66.66, '按机器算：剩 3 台各 33.33%，掉一台剩 66.66%');
  });

  test('⑥ 拿不到可用输入 → null，不作答', () => {
    // 猜出来的到期结论会被当成判据用。宁可报 SKIP。
    assert.equal(assessStakeExpiry([], { now: NOW }), null);
    assert.equal(assessStakeExpiry(undefined, { now: NOW }), null);
    assert.equal(assessStakeExpiry([{ domain: 'a', weight: 1n }], { now: NOW }), null, '没有 endTimeMs 就不算数');
    assert.equal(assessStakeExpiry([holder('a', 10)].map((h) => ({ ...h, weight: 0n })), { now: NOW }), null,
      '零权重的持有者不构成输入');
  });

  test('⑦ 默认窗口是 45 天 —— 够走完续期流程', () => {
    assert.equal(WARN_DAYS, 45);
    // 44 天后到期的那一笔应当落进窗口；46 天的不该。
    const inWindow = assessStakeExpiry([holder('a', 44), holder('b', 300), holder('c', 300)], { now: NOW });
    assert.deepEqual(inWindow.expiring, ['a']);
    const outOfWindow = assessStakeExpiry([holder('a', 46), holder('b', 300), holder('c', 300)], { now: NOW });
    assert.deepEqual(outOfWindow.expiring, []);
  });
});
