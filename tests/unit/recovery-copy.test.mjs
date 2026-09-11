// T021 —— 恢复能力的文案（功能 004，FR-014 / FR-015 / FR-016 / FR-021）。
//
// ## 这条提示要说的不是事实，是后果
//
// 面板早就把 `primary-1 = 已停止` 显示出来了 —— **事实是可见的**。
// 缺的是那两条合起来意味着什么：此刻任何一个 L1 验证者一旦重启，就**再也回不来**。
//
// 2026-09-10 实测：两个 Primary 全停、五个验证者都健康、面板报 `normal / 100%`
// 的状态下重启 l1-1，它 5 分钟内 P 链引导毫无进展。而"重启一下试试"恰好是
// **最本能的运维动作** —— 事实可见、后果不可见，是最容易出事的组合。
//
// ## 为什么禁那四个字样
//
// 停摆与卡住**不损坏任何东西**。003 的 V-04 实证过：链停期间那笔 45 秒无回执的交易，
// 在验证者恢复后被**原样打包进区块 834**（未重发、未改 nonce）。
// 文案里出现"需要重置"会让人去做一次**丢掉全部链上状态**的操作来解决一个
// 起两个容器就能解决的问题。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { recoveryCopy, INCIDENT_COPY } from '../../tools/dashboard/public/copy.mjs';
import { PRIMARIES_REQUIRED_FOR_REJOIN } from '../../tools/dashboard/snapshot.mjs';

const blocked = () => recoveryCopy({
  recoveryCapability: 'blocked',
  primariesRequiredForRejoin: PRIMARIES_REQUIRED_FOR_REJOIN,
});
/**
 * 面板在这条提示上会显示的**全部**文字。
 *
 * **必须把 `INCIDENT_COPY` 也算进来。** 第一版只拼 `recoveryCopy()` 的三段，
 * 于是变红检查 T033b（往文案里注入「需要重置」）**没有变红** ——
 * 注入的字进了 `INCIDENT_COPY['recovery-blocked'].label`，而那一份不在扫描范围里。
 *
 * 两处都是面板显示的东西：`recoveryCopy()` 是那条横幅，
 * `INCIDENT_COPY` 是异常列表里那一行的标签与处置。
 * **禁含类断言漏掉任何一处，都等于给那一处发了豁免。**
 */
const allText = (c) => [
  c.label, c.body, c.action,
  INCIDENT_COPY['recovery-blocked'].label,
  INCIDENT_COPY['recovery-blocked'].action,
].join(' ');

describe('只在 blocked 时呈现 —— ok 与 unknown 都不出声', () => {
  test('ok → null（无噪音）', () => {
    assert.equal(recoveryCopy({ recoveryCapability: 'ok' }), null);
  });
  test('unknown → null（观察者失明时不作断言，FR-019）', () => {
    assert.equal(recoveryCopy({ recoveryCapability: 'unknown' }), null,
      '失明时出提示，等于在面板最不该说话的时候让它说话');
  });
  test('字段缺失 / 快照残缺时也不出声', () => {
    assert.equal(recoveryCopy({}), null);
    assert.equal(recoveryCopy(undefined), null);
  });
  test('blocked → 有文案', () => {
    const c = blocked();
    assert.ok(c && c.label && c.body && c.action, 'blocked 时必须给出完整文案');
  });
});

describe('必含：后果、数量、顺序（FR-014 / FR-015）', () => {
  test('说出**后果** —— 验证者重启后无法重新加入', () => {
    assert.match(blocked().body, /无法重新加入/,
      '只重复"Primary 停了"这个事实不满足 FR-014 —— 面板早就把那个事实显示出来了');
  });

  test('说清**已经在跑的不受影响** —— 否则人会以为整条链都不能碰', () => {
    assert.match(blocked().body, /已经在跑|不受影响/,
      '缺了这一句，看的人可能连交易都不敢发 —— 而链其实在正常出块');
  });

  test('处置方向要求把**全部** Primary 都启动，并明说只起一个不够', () => {
    const a = blocked().action;
    assert.match(a, /只起一个不够|一个不够/,
      '这是 `< 2` 与 `= 0` 的全部区别 —— 2026-09-10 实测：起回一个之后 l1-1 仍然卡着');
    assert.match(a, new RegExp(String(PRIMARIES_REQUIRED_FOR_REJOIN)),
      `处置方向里要出现需要的个数（${PRIMARIES_REQUIRED_FOR_REJOIN}）`);
  });

  test('明说在那之前**不要重启任何验证者** —— 这是这条提示存在的全部理由', () => {
    assert.match(blocked().action, /不要重启/,
      '没有这一句，这条提示就退化成又一条"有东西坏了"，而它要防的正是那个本能动作');
  });

  test('给出恢复后的预期，而不是让人干等', () => {
    assert.match(blocked().body, /自行追上|自动/,
      '两个 Primary 回来后卡住的验证者约半分钟自愈（实测 36 秒）—— 说出来，人就不会去重装');
  });
});

describe('禁含四个字样（FR-016）', () => {
  const FORBIDDEN = ['数据可能丢失', '需要重置', '需要重建', '需要重新部署'];
  for (const word of FORBIDDEN) {
    test(`不含「${word}」`, () => {
      assert.ok(!allText(blocked()).includes(word),
        `文案里出现了「${word}」。停摆与卡住**不损坏任何东西** ——\n`
        + '  003 的 V-04 实证：链停期间那笔 45 秒无回执的交易，恢复后被原样打包进区块 834。\n'
        + '  这四个字样会让人去做一次丢掉全部链上状态的操作，来解决一个起两个容器就能解决的问题。');
    });
  }

  test('也不写否定句（"不会丢数据"这类）—— 它们对子串守卫天然敌对', () => {
    // 003 期间踩过：`starting` 的文案写了「也不是"须处置"」，那个词触发了一条子串断言，
    // 当时的处理是**改文案，不是改守卫**。这里正面说"恢复后自动追上"。
    const t = allText(blocked());
    for (const neg of ['不会丢', '不需要重置', '无需重置']) {
      assert.ok(!t.includes(neg),
        `文案里写了否定句「${neg}」。它是真的，但下一条禁含断言会把它误判为违规 ——\n`
        + '  正面说（"恢复后自动继续"）既传达同样的意思，也不和守卫打架。');
    }
  });
});

describe('版式与停摆报警可区分（FR-021）', () => {
  test('severity 不是 critical —— 链在出块，它不是活性紧急事件', () => {
    const c = blocked();
    assert.notEqual(c.severity, 'critical',
      '做成与「链已停止出块」同一档的报警会**稀释那一档的含义** ——\n'
      + '  003 期间为此删掉过一条会误报的守卫，理由记在那边："噪音会让人开始忽略红灯。"');
    assert.ok(c.severity && c.severity.length > 0, '但它也要有自己的等级，不能没有版式');
  });

  test('有自己的字形标记 —— 不只靠颜色（003 的 FR-009 三通道）', () => {
    const c = blocked();
    assert.ok(c.symbol && c.symbol.length > 0,
      '缺 symbol —— 只靠颜色区分对色觉障碍者与打印件都无效');
  });
});

describe('文案与门槛常量的耦合有守卫 —— 常量一改，文案必须跟着改', () => {
  test('静态处置文案里的「两个」与 PRIMARIES_REQUIRED_FOR_REJOIN 一致', () => {
    // INCIDENT_COPY 是**零 import 的静态表**（沿用 003 的约定），没法插值，
    // 只能把数字写成汉字。于是它与常量之间存在漂移可能 —— 本断言就是那道锁。
    assert.equal(PRIMARIES_REQUIRED_FOR_REJOIN, 2,
      '门槛常量改了。那么 INCIDENT_COPY["recovery-blocked"].action 里的「两个」\n'
      + '  以及 docs/devnet.md §9.5 的表都必须跟着改 —— 本断言故意在这里挡住你。');
    assert.match(INCIDENT_COPY['recovery-blocked'].action, /两个/,
      '静态处置文案里应当出现「两个」，与常量 2 对应');
  });

  test('第六类异常有 label 与 action（否则界面上会显示原始 slug）', () => {
    const c = INCIDENT_COPY['recovery-blocked'];
    assert.ok(c && c.label && c.action);
    assert.match(c.action, /不要重启/);
  });
});
