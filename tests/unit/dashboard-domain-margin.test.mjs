// T006 —— 边界级余量（功能 003）。
//
// 本文件是 `contracts/health-tier.md` 第 5 节那张表的机械转录。
//
// ## 为什么必须与验证者级余量分开
//
// 两者可以不同：若两个验证者挤到同一台机器，验证者级余量仍是 1（还能掉一个验证者），
// 但边界级余量变成 0（那台机器一挂就同时掉两个）。只看前者会**高估冗余**。
//
// ## 为什么必须用 effectiveDomains
//
// `load.mjs:259` 就此留了一条注释：按**声明的**边界判会得到
// 「可容忍 1 个边界整体失效 [OK]」这样**在现实里为假的绿灯** ——
// 因为共享失效因素（同一路供电、同一台交换机）会被绿灯掩盖。
// 本文件第 4 个用例专门守这一条。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deriveTier } from '../../tools/dashboard/snapshot.mjs';

let seq = 0;
const v = (state, offline) => ({
  id: `l1-${(seq += 1)}`,
  role: 'l1-validator',
  state,
  countsTowardTolerance: true,
  countsAsOffline: offline ?? !['healthy', 'catching-up', 'bootstrapping', 'starting'].includes(state),
});

/**
 * `effectiveDomains` 是**并查集之后**的分组 —— 由 load.mjs 的 effectiveDomains()
 * 按 sharedFailureFactors 合并得到。这里直接给合并后的结果。
 */
const ft = (validatorCount, maxOfflineValidators, effective) => ({
  validatorCount,
  maxOfflineValidators,
  domainCount: effective.length,
  maxValidatorsPerDomain: effective.length > 1 ? maxOfflineValidators : validatorCount,
  declaredWithinLimit: true,
  effectiveDomainCount: effective.length,
  effectiveDomains: effective,
  tolerateWholeDomainLoss: effective.length > 1,
});

const grp = (id, validators, factors = []) => ({ ids: [id], factors, validators });
const obs = (reachableNodes, totalNodes = 7) => ({
  reachableNodes, totalNodes, blind: reachableNodes === 0, pathAlive: [],
});
const allHealthy = (n) => Array.from({ length: n }, () => v('healthy'));

describe('契约第 5 节 —— 边界级余量', () => {
  test('第 1 行 lan：5 台各 1 个验证者，f=1 → 边界余量 1', () => {
    const got = deriveTier({
      rows: allHealthy(5),
      faultTolerance: ft(5, 1, [grp('win-1', 1), grp('win-2', 1), grp('ubuntu-1', 1), grp('ubuntu-2', 1), grp('ubuntu-3', 1)]),
      observer: obs(7),
    });
    assert.equal(got.domainMargin, 1, '与既有 devnet-topology 的 [OK] 可容忍 1 个边界整体失效 一致');
    assert.equal(got.validatorMargin, 1);
  });

  test('第 2 行：某边界承载 2 个验证者 → 边界余量 0，而验证者级余量仍是 1', () => {
    const got = deriveTier({
      rows: allHealthy(5),
      faultTolerance: ft(5, 1, [grp('win-1', 2), grp('win-2', 1), grp('ubuntu-1', 1), grp('ubuntu-2', 1)]),
      observer: obs(7),
    });
    assert.equal(got.domainMargin, 0, '该边界一挂即同时失去 2 个 > f=1');
    assert.equal(got.validatorMargin, 1, '**两者必须分开显示**（FR-010）—— 只看后者会高估冗余');
  });

  test('第 3 行 local：单边界承载全部 5 个 → 边界余量 0（该形态不做整机失效承诺）', () => {
    const got = deriveTier({
      rows: allHealthy(5),
      faultTolerance: ft(5, 1, [grp('local', 5, ['host:single-machine'])]),
      observer: obs(7),
    });
    assert.equal(got.domainMargin, 0);
  });

  test('第 4 行：声明 5 边界但三台共享一路供电 → 并查集合成 3 组 → 边界余量 0', () => {
    // **这一行是本文件的要点。** 按声明的 5 个边界会算出 1，那正是
    // load.mjs:259 注释所说的「在现实里为假的绿灯」。
    // 输入是合并后的 [1, 1, 3] —— 那个 3 组一旦整体失效就同时掉 3 个 > f=1。
    const got = deriveTier({
      rows: allHealthy(5),
      faultTolerance: ft(5, 1, [
        grp('win-1', 1),
        grp('win-2', 1),
        { ids: ['ubuntu-1', 'ubuntu-2', 'ubuntu-3'], factors: ['power:rack-A'], validators: 3 },
      ]),
      observer: obs(7),
    });
    assert.equal(got.domainMargin, 0, '必须按有效边界判，否则共享因素被绿灯掩盖');
  });

  test('第 5 行：已有 1 个验证者不参与 → 余量已被用掉 → 边界余量 0', () => {
    const got = deriveTier({
      rows: [...allHealthy(4), v('stopped')],
      faultTolerance: ft(5, 1, [grp('win-1', 1), grp('win-2', 1), grp('ubuntu-1', 1), grp('ubuntu-2', 1), grp('ubuntu-3', 1)]),
      observer: obs(6),
    });
    assert.equal(got.domainMargin, 0, '边界余量必须扣掉当前缺口');
    assert.equal(got.validatorMargin, 0);
  });
});

describe('边界余量取最坏边界，不取平均', () => {
  test('f=2 且分组为 [3,1,1,1] → 边界余量 0（最大那组就超了）', () => {
    const got = deriveTier({
      rows: allHealthy(6),
      faultTolerance: ft(6, 2, [grp('a', 3), grp('b', 1), grp('c', 1), grp('d', 1)]),
      observer: obs(8, 8),
    });
    assert.equal(got.domainMargin, 0, '降序取第一组就是 3 > 2');
  });

  test('f=2 且分组为 [1,1,1,1,1,1] → 边界余量 2', () => {
    const got = deriveTier({
      rows: allHealthy(6),
      faultTolerance: ft(6, 2, [grp('a', 1), grp('b', 1), grp('c', 1), grp('d', 1), grp('e', 1), grp('f', 1)]),
      observer: obs(8, 8),
    });
    assert.equal(got.domainMargin, 2);
  });

  test('f=2 且分组为 [2,1,1,1] → 边界余量 1（掉那个 2 的正好用尽）', () => {
    const got = deriveTier({
      rows: allHealthy(5),
      faultTolerance: ft(5, 2, [grp('a', 2), grp('b', 1), grp('c', 1), grp('d', 1)]),
      observer: obs(7),
    });
    assert.equal(got.domainMargin, 1);
  });
});
