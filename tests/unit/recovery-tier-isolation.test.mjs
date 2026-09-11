// T020 —— 恢复能力**不得影响健康档位**（功能 004，FR-013）。
//
// ## 这条守卫为什么是本期最该有的一条
//
// 本期是在往面板里加一条**关于 P 链的信息**。而 003 的 FR-013 立下的规矩正是：
// **不许把 P 链可达性掺进 L1 的活性判断。**
//
// 002 实测过：两个 Primary 全停时，五个 L1 验证者自报的**综合**健康位全部转不健康，
// 而链在**正常出块**（4 笔交易 1.0s 确认）。2026-09-10 又原地复现了一次：
// 五个 L1 的 `/ext/health` 全部 503，同时刻直连提交的交易确认于区块 835。
//
// 所以本期最容易顺手犯的错，就是让"恢复能力已丧失"把档位降一档 ——
// 那会把一条**正在出块**的链报成有问题，正是 FR-013 禁止的那件事。
//
// 判据：`blocked` 与 `ok` 两种情形下，档位相关的六个字段**逐字段相同**。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot } from '../../tools/dashboard/snapshot.mjs';

let seq = 0;
const validator = (state = 'healthy') => ({
  id: `l1-${(seq += 1)}`,
  role: 'l1-validator',
  state,
  countsTowardTolerance: true,
  countsAsOffline: state !== 'healthy' && state !== 'catching-up',
  domain: `d${seq}`,
});
const primary = (state) => ({
  id: `primary-${(seq += 1)}`,
  role: 'primary',
  state,
  countsTowardTolerance: false,
  countsAsOffline: state !== 'healthy',
  domain: 'dp',
});

const ft = (perDomain) => ({
  validatorCount: perDomain.reduce((a, b) => a + b, 0),
  maxOfflineValidators: 1,
  domainCount: perDomain.length,
  maxValidatorsPerDomain: 1,
  declaredWithinLimit: true,
  effectiveDomainCount: perDomain.length,
  effectiveDomains: perDomain.map((n, i) => ({ ids: [`d${i}`], factors: [], validators: n })),
  tolerateWholeDomainLoss: perDomain.length > 1,
});

const snap = ({ validators, primaries }) => buildSnapshot({
  collectedAt: 1,
  pollIntervalMs: 5000,
  deployment: 'lan',
  networkHeight: 100,
  rows: [...validators, ...primaries],
  faultTolerance: ft([1, 1, 1, 1, 1]),
  observer: { reachableNodes: 7, totalNodes: 7, blind: false, pathAlive: [] },
  chain: { chainId: 1, networkId: 1, blockchainName: 'x' },
  baselineGenesisHash: null,
  containerFacts: { available: true },
});

/** 档位相关的字段 —— 这一组必须与恢复能力完全无关。 */
const TIER_FIELDS = [
  'tier', 'healthPercent', 'participating', 'threshold',
  'validatorMargin', 'domainMargin', 'validatorCount', 'observedValidators',
];
const tierView = (s) => Object.fromEntries(TIER_FIELDS.map((k) => [k, s[k]]));

describe('恢复能力为 blocked 时，档位的每一个字段都不变（FR-013）', () => {
  for (const [label, states] of [
    ['链完全正常（五个验证者健康）', ['healthy', 'healthy', 'healthy', 'healthy', 'healthy']],
    ['零余量（掉一个）', ['healthy', 'healthy', 'healthy', 'healthy', 'stopped']],
    ['已停止出块（掉两个）', ['healthy', 'healthy', 'healthy', 'stopped', 'stopped']],
  ]) {
    test(label, () => {
      const validators = states.map((st) => validator(st));
      const ok = snap({ validators, primaries: [primary('healthy'), primary('healthy')] });
      const blocked = snap({ validators, primaries: [primary('stopped'), primary('stopped')] });

      assert.equal(ok.recoveryCapability, 'ok');
      assert.equal(blocked.recoveryCapability, 'blocked');
      assert.deepEqual(tierView(blocked), tierView(ok),
        '恢复能力改变了档位相关字段。**这正是 FR-013 禁止的那件事** ——\n'
        + '  002 实测过两个 Primary 全停时五个 L1 的综合健康位全转不健康，而链在正常出块。\n'
        + '  把 P 链可达性掺进 L1 的活性判断，会把一条正在出块的链报成有问题。');
    });
  }

  test('只起回一个 Primary 时同样不影响档位', () => {
    const validators = ['healthy', 'healthy', 'healthy', 'healthy', 'healthy'].map((st) => validator(st));
    const ok = snap({ validators, primaries: [primary('healthy'), primary('healthy')] });
    const half = snap({ validators, primaries: [primary('healthy'), primary('stopped')] });
    assert.equal(half.recoveryCapability, 'blocked');
    assert.deepEqual(tierView(half), tierView(ok));
  });
});

describe('两条信息必须能同时呈现，不能互相吃掉（契约第 3 节第 5/7 行）', () => {
  test('链已停止 + 无法恢复 → 档位仍是 stopped，且两条异常都在', () => {
    const validators = ['healthy', 'healthy', 'healthy', 'stopped', 'stopped'].map((st) => validator(st));
    const s = snap({ validators, primaries: [primary('stopped'), primary('stopped')] });

    assert.equal(s.tier, 'stopped', '链确实停了 —— 这一条不能被恢复能力盖掉');
    assert.equal(s.recoveryCapability, 'blocked');

    const classes = s.incidents.map((i) => i.class);
    assert.ok(classes.includes('recovery-blocked'),
      '缺了"无法恢复"那一条 —— 看面板的人不会知道现在别重启任何东西');
    assert.ok(classes.includes('consensus-margin') || classes.includes('node-infra'),
      '缺了"链停了"那一侧的异常');
  });

  test('正常出块 + 无法恢复 → 这是最要紧的组合，因为它看起来完全健康', () => {
    const validators = ['healthy', 'healthy', 'healthy', 'healthy', 'healthy'].map((st) => validator(st));
    const s = snap({ validators, primaries: [primary('stopped'), primary('stopped')] });

    assert.equal(s.tier, 'normal');
    assert.equal(s.healthPercent, 100);
    assert.equal(s.recoveryCapability, 'blocked');
    assert.ok(s.incidents.some((i) => i.class === 'recovery-blocked'));
  });
});

describe('recovery-blocked 这条异常带处置方向（宪法第九条）', () => {
  test('message 说后果，action 说怎么办', () => {
    const validators = ['healthy', 'healthy', 'healthy', 'healthy', 'healthy'].map((st) => validator(st));
    const s = snap({ validators, primaries: [primary('stopped'), primary('stopped')] });
    const inc = s.incidents.find((i) => i.class === 'recovery-blocked');
    assert.ok(inc, '没有产生 recovery-blocked 异常');

    assert.match(inc.message, /无法重新加入/, 'message 必须说出**后果**，不是只重复"Primary 停了"这个事实');
    assert.ok(inc.action && inc.action.length > 0, 'action 不能为空 —— 机器可读的分类要配可执行的方向');
    assert.match(inc.action, /两个/, 'action 必须说"两个"—— 只起一个不够');
  });

  test('与每个 Primary 各自那条 node-infra 并存，不是重复', () => {
    const validators = ['healthy', 'healthy', 'healthy', 'healthy', 'healthy'].map((st) => validator(st));
    const s = snap({ validators, primaries: [primary('stopped'), primary('stopped')] });
    const classes = s.incidents.map((i) => i.class);
    assert.equal(classes.filter((c) => c === 'node-infra').length, 2,
      '两个 Primary 各自那条"去那台机器上查"应当都在 —— 它说的是"哪个东西坏了"');
    assert.equal(classes.filter((c) => c === 'recovery-blocked').length, 1,
      '链层面只该有一条"因此现在不能做什么"');
  });
});
