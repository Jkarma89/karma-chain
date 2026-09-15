// 「加一个成员」这个动作本身能把一条正在出块的链停掉（功能 005 / FR-037 / F-5）。
//
// ## 这条差一步就发生在真链上
//
// 2026-09-15 停电之后的实际状态：
//   链上 5 个成员，win-2（l1-2）整机断电 → 离线 1 个，上限 ⌊5/4⌋ = 1 —— **正好在边界上**，链照常出块
//   要注册的 l1-6 在 ubuntu-4 上，**那台也断着电**
//
// 若那时注册：n = 5 → 6，而 ⌊6/4⌋ **仍然是 1**（F-5 的那张表：5、6、7 都是 1）；
// 离线却变成 l1-2 与 l1-6 两个 > 1 —— 链会真的停止出块。
//
// 停摆的原因不是故障，是**容错的分母涨了、门槛没跟着涨**。
// 当时拦住的是人工核对，不是工具 —— 所以它现在是工具的一部分。
//
// ## 为什么两条判断不能合并
//
// "新成员的机器没起来"与"这一下会停摆"是两件事：n 从 7 到 8 时 f 从 1 变 2，
// 多一个缺席成员仍在容错内。用一条代替另一条，会在该拦的时候不拦、
// 或者在不该拦的时候拦。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { toleranceAfterAdd, toleranceChange } from '../../tools/membership/add-validator.mjs';

describe('那个真实现场：5 个成员、1 个离线、新成员也离线', () => {
  const real = () => toleranceAfterAdd({
    membersBefore: 5, offlineIds: ['l1-2'], newMemberOnline: false,
  });

  test('注册前在容错内（链确实在出块）', () => {
    const t = real();
    assert.equal(t.before.n, 5);
    assert.equal(t.before.f, 1);
    assert.equal(t.before.offline, 1);
    assert.equal(t.before.within, true, '5 个成员掉 1 个仍在 ⌊5/4⌋=1 之内');
  });

  test('注册后越界 —— **上限没跟着涨**', () => {
    const t = real();
    assert.equal(t.after.n, 6);
    assert.equal(t.after.f, 1, 'n 从 5 到 6，⌊n/4⌋ 仍是 1 —— F-5 那张表的核心');
    assert.equal(t.after.offline, 2, '新成员自己也算一个缺席');
    assert.equal(t.after.within, false);
  });

  test('**wouldStopChain 必须为真**（这一条就是那次差一步）', () => {
    assert.equal(real().wouldStopChain, true,
      '注册前在容错内、注册后越界，却没判成"这一下会停摆" —— '
      + '那么这个工具会放行一次把正在出块的链停掉的操作，'
      + '而停摆的原因是这次注册，不是故障');
  });

  test('新成员离线单独成一条', () => {
    assert.equal(real().newMemberOffline, true);
  });
});

describe('wouldStopChain 只归因**这一下**造成的越界', () => {
  test('注册前就已越界 → wouldStopChain 为假（链已经停了，要报的是另一件事）', () => {
    const t = toleranceAfterAdd({
      membersBefore: 5, offlineIds: ['l1-2', 'l1-3'], newMemberOnline: true,
    });
    assert.equal(t.before.within, false, '5 个掉 2 个已经越界');
    assert.equal(t.after.within, false);
    assert.equal(t.wouldStopChain, false,
      '把"本来就停着"也归因给这次注册 —— 报错会说"先把机器弄回来再注册"，'
      + '而真正该说的是"链现在就是停的，先弄清为什么"');
  });

  test('全员在线、新成员也在线 → 放行', () => {
    const t = toleranceAfterAdd({ membersBefore: 5, offlineIds: [], newMemberOnline: true });
    assert.equal(t.wouldStopChain, false);
    assert.equal(t.newMemberOffline, false);
    assert.equal(t.after.within, true);
  });

  test('新成员离线但容错涨了 → **不拦停摆**（两条判断确实独立）', () => {
    // n 从 7 到 8：f 从 ⌊7/4⌋=1 变 ⌊8/4⌋=2。已离线 1 个 + 新成员离线 = 2 ≤ 2。
    const t = toleranceAfterAdd({
      membersBefore: 7, offlineIds: ['l1-2'], newMemberOnline: false,
    });
    assert.equal(t.before.f, 1);
    assert.equal(t.after.f, 2, 'n=8 时 f 才涨到 2（F-5）');
    assert.equal(t.after.within, true);
    assert.equal(t.wouldStopChain, false,
      '容错跟着涨上来了，却仍然报"会停摆" —— '
      + '那就是用"新成员离线"这一条去代替停摆判断，会在不该拦时拦');
    assert.equal(t.newMemberOffline, true, '但"新成员没起来"这条仍然成立，照样要报');
  });

  test('全员在线、新成员离线、f 不变 → 仍然不越界（1 个缺席在 ⌊6/4⌋=1 内）', () => {
    const t = toleranceAfterAdd({ membersBefore: 5, offlineIds: [], newMemberOnline: false });
    assert.equal(t.after.offline, 1);
    assert.equal(t.after.f, 1);
    assert.equal(t.wouldStopChain, false);
    assert.equal(t.newMemberOffline, true);
  });
});

describe('f = ⌊n/4⌋ 这条规则只有一处定义', () => {
  // F-5 的那张真值表。两个函数必须给出同一个 f —— 各自算一遍就会漂移。
  for (const [n, f] of [[4, 1], [5, 1], [6, 1], [7, 1], [8, 2], [9, 2], [11, 2], [12, 3]]) {
    test(`n = ${n} → f = ${f}，且 toleranceChange 与 toleranceAfterAdd 一致`, () => {
      const a = toleranceAfterAdd({ membersBefore: n, offlineIds: [], newMemberOnline: true });
      assert.equal(a.before.f, f);
      const c = toleranceChange(n, n + 1);
      assert.equal(c.before.f, a.before.f, `toleranceChange 与 toleranceAfterAdd 对 n=${n} 算出不同的 f`);
      assert.equal(c.after.f, a.after.f, `两者对 n=${n + 1} 算出不同的 f`);
    });
  }

  test('5 → 7 买不到任何容错提升（F-5 的那句话）', () => {
    for (const n of [5, 6, 7]) {
      assert.equal(
        toleranceAfterAdd({ membersBefore: n, offlineIds: [], newMemberOnline: true }).before.f, 1,
        `n=${n} 的 f 不是 1 —— F-5 那张表被改动了，面板"加节点更抗"的措辞要跟着重审`);
    }
  });
});
