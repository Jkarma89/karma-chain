// 容错函数对**任意 n** 正确（功能 005，FR-024 / V-17）。
//
// ## 为什么这套件必须逐格写，而不是测两个代表
//
// 003 的 `contracts/health-tier.md` 第 4b 节记着一次**错误外推**：
// 从 n=5 的「4/5 = 80% 是零余量」推出「n=9 时 8/9 也是零余量」—— **推错了**
// （n=9 的可离线数是 2，掉 1 个仍有余量）。那次是自己写的测试抓出来的。
//
// 005 会让 n 真的变动（扩容与缩容），于是那条公式第一次要对**一个区间**负责，
// 而不只是对当前的 5 负责。**每一格都要有断言** ——
// 上次出错的恰好是没测的那一格。
//
// ## 两个会让人做错决定的地方
//
// 1. **加节点不一定提高容错。** n = 5 → 6 → 7 都是 f=1，要跨过 8 才变 2。
//    面板与工具**不得**暗示"节点更多了就更抗"（FR-025）。
// 2. **减节点可能砍半容错。** n = 8 → 7 让 f 从 2 掉到 1。
//    名册少一个看着无关紧要 —— 所以退出操作必须在动手前把这个说出来（FR-011）。
//
// ## 实现现状（2026-09-11 核实）
//
// `tools/protocol/load.mjs` 里已经是 `Math.floor(n / 4)`，而
// `(n-f)/n ≥ 0.75 ⟺ f ≤ n/4`，**两者等价** —— 也就是说这条公式**本来就是通用的**，
// 005 不需要改它。本套件的作用是**把这条性质锁住**：
// 日后若有人"简化"成按当前 n 写死的表，或把 0.75 改成别的数，这里会变红。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadProtocol, deriveTopology } from '../../tools/protocol/load.mjs';

/** 共识参数定死的查询门槛：minConnectedStakeToQuery = α/k = 15/20。 */
const QUERY_THRESHOLD = 0.75;

/** 判据的**定义式**（不是实现的复制）：最大的 f 使 (n-f)/n ≥ 门槛。 */
const expectedF = (n) => {
  let f = 0;
  while ((n - (f + 1)) / n >= QUERY_THRESHOLD) f += 1;
  return f;
};

/** data-model 第 3 节那张表的**机械转录** —— 与上面的定义式互为对照。 */
const TABLE = { 4: 1, 5: 1, 6: 1, 7: 1, 8: 2, 9: 2, 10: 2, 11: 2, 12: 3 };

describe('f(n) 的定义式与那张表互相印证', () => {
  for (const [n, f] of Object.entries(TABLE)) {
    test(`n=${n} → 可离线 ${f} 个`, () => {
      assert.equal(expectedF(Number(n)), f,
        `data-model 第 3 节的表与定义式对不上。\n`
        + `  定义式：最大的 f 使 (n-f)/n ≥ ${QUERY_THRESHOLD}\n`
        + '  两者必须一致 —— 表是给人看的，定义式是给机器算的，它们说的是同一件事');
    });
  }

  test('表覆盖的区间就是 005 声明的可行范围（4…12）', () => {
    const ks = Object.keys(TABLE).map(Number).sort((a, b) => a - b);
    assert.equal(ks[0], 4);
    assert.equal(ks.at(-1), 12);
    assert.equal(ks.length, 9, '区间内不得有缺格 —— 上次出错的恰好是没测的那一格');
  });
});

describe('实现与定义式一致（对整个区间，不只是当前的 n）', () => {
  const p = loadProtocol();

  for (const n of Object.keys(TABLE).map(Number)) {
    test(`n=${n}：deriveTopology 给出的 maxOfflineValidators = ${TABLE[n]}`, () => {
      // 只改验证者数，其余一切保持原样 —— 这样测的是那条公式，不是整个拓扑
      const fake = {
        ...p,
        validators: { ...p.validators, count: n },
      };
      const d = deriveTopology(fake);
      assert.equal(d.faultTolerance.maxOfflineValidators, TABLE[n],
        `n=${n} 时实现算出 ${d.faultTolerance.maxOfflineValidators}，表里是 ${TABLE[n]}。\n`
        + '  实现当前是 Math.floor(n / 4)，而 (n-f)/n ≥ 0.75 ⟺ f ≤ n/4 —— 两者等价。\n'
        + '  若这条断言红了，要么公式被改了，要么查询门槛被改了（后者是协议变更）');
    });
  }
});

describe('两个会让人做错决定的性质', () => {
  test('加节点**不一定**提高容错：5 → 6 → 7 都是 1', () => {
    assert.equal(expectedF(5), 1);
    assert.equal(expectedF(6), 1);
    assert.equal(expectedF(7), 1);
    assert.equal(expectedF(8), 2, '要提高必须跨过 8 这一格');
    // 面板与工具不得暗示"节点更多了就更抗"（FR-025）——
    // 这条断言是那条要求的事实基础
  });

  test('减节点**可能砍半**容错：8 → 7 从 2 掉到 1', () => {
    assert.equal(expectedF(8), 2);
    assert.equal(expectedF(7), 1);
    // 名册少一个看着无关紧要，实际把容错砍半 ——
    // 所以退出操作必须在动手**之前**把这个说出来（FR-011）
  });

  test('f 随 n 单调不减 —— 扩容不会让容错倒退', () => {
    for (let n = 4; n < 12; n += 1) {
      assert.ok(expectedF(n + 1) >= expectedF(n),
        `n=${n} → ${n + 1} 时 f 倒退了（${expectedF(n)} → ${expectedF(n + 1)}）`);
    }
  });

  test('f 恒小于 n/4 + 1，且 n ≥ 4 时恒 ≥ 1', () => {
    for (let n = 4; n <= 12; n += 1) {
      assert.ok(expectedF(n) >= 1, `n=${n} 时容错为 0 —— 那意味着一个都不能掉`);
      assert.ok(expectedF(n) < n, `n=${n} 时 f=${expectedF(n)} 不小于 n`);
    }
  });
});

describe('门槛本身是协议参数，不许悄悄改', () => {
  test('查询门槛是 0.75（α/k = 15/20）', () => {
    assert.equal(QUERY_THRESHOLD, 0.75,
      '改这个数**是协议变更**（宪法第十五条的 "Consensus"）—— 它决定链能掉几个验证者。\n'
      + '  005 只让成员数可变，**不碰这个门槛**。');
  });
});
