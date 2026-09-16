// 退一个成员的代价判定（功能 005 / T035 / FR-011 / FR-012）。
//
// ## 退比加更容易出错，而且方向是反直觉的
//
// 加成员时分母涨、门槛常常**不**涨（F-5：n=5、6、7 的 f 都是 1）。
// 退成员时分母降，**门槛可能跟着降** —— n=8→7 时 f 从 2 掉到 1。
// 若此刻恰好已有 2 个离线，这一退就把链停了，而被退掉的那个可能根本是好的。
//
// 所以这里守两件**互相独立**的事，它们的处置不同：
//
//   toleranceDrops        f 变小了 —— 要人确认（FR-011）。代价真实，但决定权在人
//   wouldBreachThreshold  退完离线数会超过新的 f —— 拦下（FR-012）。这不是权衡
//
// 合并成一条会在该拦时不拦、或在不该拦时拦：n=8→7 时 f 确实降了（要确认），
// 但若当前一个都没离线，退完 0 ≤ 1 仍然安全，拦下来是错的。
//
// ## 还要守"退掉一个已经离线的成员是在改善处境"
//
// 它本来就不为共识出力，却占着分母。退掉它 n 降 1、离线数也降 1。
// 工具若对"清理一台已经坏掉的机器"发出吓人的警告，人就会开始忽略这些警告。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { removalImpact, maxOffline } from '../../tools/membership/tolerance.mjs';

const impact = (n, offline, removing) => removalImpact({
  membersBefore: n, offlineIds: offline, removingNodeId: removing,
});

describe('① 告知内容：n 与 f 的前后值都要对（FR-011）', () => {
  test('当前这条链：6 → 5，而 f 两边都是 1', () => {
    const r = impact(6, [], 'l1-6');
    assert.equal(r.before.n, 6);
    assert.equal(r.after.n, 5);
    assert.equal(r.before.f, 1);
    assert.equal(r.after.f, 1);
    assert.equal(r.toleranceDrops, false,
      '6 → 5 时 f 没变（⌊6/4⌋ = ⌊5/4⌋ = 1）—— 报成"容错下降"会让人以为付了代价');
  });

  test('**n=8 → 7 时 f 从 2 降到 1**（T042 那个场景）', () => {
    const r = impact(8, [], 'l1-8');
    assert.equal(r.before.f, 2);
    assert.equal(r.after.f, 1);
    assert.equal(r.toleranceDrops, true,
      'f 从 2 降到 1 却没报"容错下降" —— 那是这次退出的真实代价，'
      + '人有权在知道它之后再决定');
  });

  test('f 的前后值与 ⌊n/4⌋ 逐行一致（合同第 7 节那张表）', () => {
    for (const n of [2, 4, 5, 6, 7, 8, 9, 12]) {
      const r = impact(n, [], 'x');
      assert.equal(r.before.f, maxOffline(n), `n=${n} 的 f 不对`);
      assert.equal(r.after.f, maxOffline(n - 1), `n=${n - 1} 的 f 不对`);
    }
  });

  test('离线数前后都报出来（不只报 n 和 f）', () => {
    const r = impact(6, ['l1-2'], 'l1-6');
    assert.equal(r.before.offline, 1);
    assert.equal(r.after.offline, 1, '退的是在线的那个，离线数不变');
  });
});

describe('② f 下降要确认，且与"会不会停摆"是两件事（FR-011）', () => {
  test('f 降但当前无离线 → 要确认，**不拦**', () => {
    const r = impact(8, [], 'l1-8');
    assert.equal(r.toleranceDrops, true, '代价要说');
    assert.equal(r.wouldBreachThreshold, false,
      '一个都没离线，退完 0 ≤ 1 仍然安全 —— 拦下来是错的。'
      + '把"要确认"和"该拦下"合成一条，就会在这里误拦');
    assert.equal(r.after.within, true);
  });

  test('f 不降也不拦 → 两个标记都为假（不制造噪声）', () => {
    const r = impact(6, [], 'l1-6');
    assert.equal(r.toleranceDrops, false);
    assert.equal(r.wouldBreachThreshold, false);
  });
});

describe('③ 会跌破查询门槛的退出必须被拦下（FR-012）', () => {
  test('**n=8、已离线 2 个、退一个在线的 → 拦下**', () => {
    // 退前：8 个、离线 2、上限 ⌊8/4⌋=2 → 正好在边界上，链还在出块
    // 退后：7 个、离线 2、上限 ⌊7/4⌋=1 → 2 > 1，链会停
    const r = impact(8, ['l1-1', 'l1-2'], 'l1-8');
    assert.equal(r.before.within, true, '退之前是在容错内的（链在出块）');
    assert.equal(r.after.within, false);
    assert.equal(r.wouldBreachThreshold, true,
      '这一退会让离线数超过新的上限，链立刻停摆 —— 必须拦下，而不是问"要不要继续"。'
      + '被退掉的那个可能根本是好的，而代价由整条链承担');
    assert.equal(r.toleranceDrops, true, '同时 f 也降了 —— 两件事可以同时成立');
  });

  test('退掉**离线的那一个**则不拦 —— 它占着分母却不出力', () => {
    // 同样 n=8、离线 2，但退的是离线的那个：退后 7 个、离线 1、上限 1 → 1 ≤ 1
    const r = impact(8, ['l1-1', 'l1-2'], 'l1-2');
    assert.equal(r.removingIsOffline, true);
    assert.equal(r.after.offline, 1, '退掉的那个本来就在离线名单里');
    assert.equal(r.wouldBreachThreshold, false,
      '清理一台已经坏掉的机器被拦下了 —— 那正是最该做的操作。'
      + '工具若对它发警告，人就会开始忽略所有警告');
    assert.equal(r.after.within, true);
  });

  test('退之前**就已**越界 → 不归因给这次退出', () => {
    // 5 个、离线 2（上限 1）—— 链已经停了。这时要说的是"先弄清为什么停"，
    // 不是"你这一退会把链停掉"。
    const r = impact(5, ['l1-1', 'l1-2'], 'l1-5');
    assert.equal(r.before.within, false, '5 个掉 2 个已经越界');
    assert.equal(r.wouldBreachThreshold, false,
      '把"本来就停着"归因给这次退出 —— 报错会说"别退"，'
      + '而真正该说的是"链现在就是停的"');
  });

  test('退掉离线成员能把一条已越界的链救回来 —— 结果里看得出', () => {
    const r = impact(5, ['l1-1', 'l1-2'], 'l1-2');
    assert.equal(r.before.within, false);
    assert.equal(r.after.within, true,
      '5 个掉 2 个 → 退掉一个离线的 → 4 个掉 1 个 = 在 ⌊4/4⌋=1 之内。'
      + '这是缩容能救链的情形，工具要能看出来');
  });
});

describe('边界：不能退到一个都不剩', () => {
  test('n=1 → 0 时 wouldEmptySet 为真', () => {
    const r = impact(1, [], 'only');
    assert.equal(r.after.n, 0);
    assert.equal(r.wouldEmptySet, true,
      '没有"缩容到零"这回事 —— 那是销毁这条链，不是成员管理');
  });

  test('n=2 → 1 不算空集合（虽然 f=0，任何离线都会停摆）', () => {
    const r = impact(2, [], 'l1-2');
    assert.equal(r.wouldEmptySet, false);
    assert.equal(r.after.f, 0, 'n=1 时 ⌊1/4⌋ = 0 —— 一个都不能掉');
  });

  test('membersBefore 不合法 → 抛', () => {
    for (const bad of [0, -1, 1.5, undefined, '6']) {
      assert.throws(() => removalImpact({
        membersBefore: bad, offlineIds: [], removingNodeId: 'x',
      }), /membersBefore/, `membersBefore = ${JSON.stringify(bad)} 被收下了`);
    }
  });

  test('**没给 removingNodeId → 抛**（退哪一个决定了离线数怎么变）', () => {
    assert.throws(() => removalImpact({ membersBefore: 6, offlineIds: ['l1-2'] }),
      /removingNodeId/,
      '不知道退的是哪一个，就算不出退完还有几个离线 —— '
      + '默默当成"退一个在线的"会在清理坏机器时给出偏悲观的结论');
  });
});
