// T046 —— 观察者失明时**不对恢复能力作任何断言**（功能 004，FR-019）。
//
// ## 这条守卫是 /speckit-analyze 补回来的
//
// 它原先**不存在**：`unknown` 那个分支只在实现里被写出来、在视图里被渲染，
// **没有任何一条测试断言它的行为**。机械覆盖扫描查出 FR-019 在 34 条里
// 是唯二没有判据的一条（另一条是 FR-030 零新增依赖）。
//
// ## 为什么它值得单独一个文件
//
// 失明恰好是面板**知道得最少**的时刻。003 把 `observer-blind` 定为
// **P1 优先级**（先于"链已停止"判定）就是为这个：观察者本机断网时，
// 七个节点会全部不可达，朴素判定会报「链已停止」—— 一个假红灯。
//
// 恢复能力这一维度有同样的风险，而且方向更坏：
// **一个在本机网线松了时仍然断言「现在不能重启任何东西」的面板，
// 会把一次局部链路故障变成一次不必要的停手。**
//
// 判据从"五态之一"退化成"数个数"是最自然的简化 —— 而它恰好会在
// 面板最不该说话的时候让面板说话。变红检查 T047 专门验这一点。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deriveRecoveryCapability, buildSnapshot } from '../../tools/dashboard/snapshot.mjs';

let seq = 0;
const primary = (state) => ({
  id: `primary-${(seq += 1)}`,
  role: 'primary',
  state,
  countsTowardTolerance: false,
  countsAsOffline: state !== 'healthy',
  domain: 'dp',
});
const validator = (state = 'healthy') => ({
  id: `l1-${(seq += 1)}`,
  role: 'l1-validator',
  state,
  countsTowardTolerance: true,
  countsAsOffline: state !== 'healthy' && state !== 'catching-up',
  domain: `d${seq}`,
});

const ft = () => ({
  validatorCount: 5,
  maxOfflineValidators: 1,
  domainCount: 5,
  maxValidatorsPerDomain: 1,
  declaredWithinLimit: true,
  effectiveDomainCount: 5,
  effectiveDomains: [1, 1, 1, 1, 1].map((n, i) => ({ ids: [`d${i}`], factors: [], validators: n })),
  tolerateWholeDomainLoss: true,
});

const blindSnapshot = (rows) => buildSnapshot({
  collectedAt: 1,
  pollIntervalMs: 5000,
  deployment: 'lan',
  networkHeight: null,
  rows,
  faultTolerance: ft(),
  // 观察者失明：本机一个节点都连不上
  observer: { reachableNodes: 0, totalNodes: 7, blind: true, pathAlive: [] },
  chain: { chainId: 1, networkId: 1, blockchainName: 'x' },
  baselineGenesisHash: null,
  containerFacts: { available: false, reason: '本机 docker 不可用' },
});

describe('失明时恢复能力是 unknown —— 不论那一刻 Primary 看起来怎样（FR-019）', () => {
  for (const [label, primaries] of [
    ['两个 Primary 都"看起来在服务"', [primary('healthy'), primary('healthy')]],
    ['两个 Primary 都"看起来停了"', [primary('stopped'), primary('stopped')]],
    ['一个看起来在、一个看起来停了', [primary('healthy'), primary('stopped')]],
    ['两个都不可达（失明时最常见的样子）', [primary('unreachable'), primary('unreachable')]],
  ]) {
    test(label, () => {
      const got = deriveRecoveryCapability({ rows: primaries, tier: 'observer-blind' });
      assert.equal(got, 'unknown',
        `失明时返回了 ${JSON.stringify(got)}。\n`
        + '  面板此刻连不上任何节点 —— 它**不知道**那些 Primary 是死了还是只是看不见。\n'
        + '  按 Primary 数去数会得出一个它无权得出的结论：\n'
        + '  说 blocked 会让人在网线松的时候不敢重启任何东西；\n'
        + '  说 ok 会在真的全停时给出假绿灯。**两个方向都错，所以只能说"不知道"。**');
    });
  }
});

describe('失明时不产生 recovery-blocked 异常', () => {
  test('哪怕两个 Primary 都不可达，也不出那条"别重启"', () => {
    const s = blindSnapshot([
      validator('unreachable'), validator('unreachable'), validator('unreachable'),
      validator('unreachable'), validator('unreachable'),
      primary('unreachable'), primary('unreachable'),
    ]);
    assert.equal(s.tier, 'observer-blind', '前置条件：档位应先落到 observer-blind（003 的 P1）');
    assert.equal(s.recoveryCapability, 'unknown');
    assert.ok(!s.incidents.some((i) => i.class === 'recovery-blocked'),
      '失明时出了 recovery-blocked —— 那是在面板最不该说话的时候让它说话。\n'
      + '  这一刻该出的是 observation 类异常（"修本机到节点的网络路径"），不是"别重启验证者"。');
  });

  test('失明时该出的是 observation 类，指向本机网络', () => {
    const s = blindSnapshot([
      validator('unreachable'), validator('unreachable'), validator('unreachable'),
      validator('unreachable'), validator('unreachable'),
      primary('unreachable'), primary('unreachable'),
    ]);
    assert.ok(s.incidents.some((i) => i.class === 'observation'),
      '失明时应当有一条 observation 异常把人指向本机网络');
  });
});

describe('非失明时照常判 —— unknown 不是一个"偷懒的默认值"', () => {
  test('档位正常 + 两个 Primary 在服务 → ok', () => {
    assert.equal(
      deriveRecoveryCapability({ rows: [primary('healthy'), primary('healthy')], tier: 'normal' }),
      'ok',
    );
  });

  test('档位正常 + 一个在服务 → blocked（不是 unknown）', () => {
    assert.equal(
      deriveRecoveryCapability({ rows: [primary('healthy'), primary('stopped')], tier: 'normal' }),
      'blocked',
      'unknown 只属于"观察者失明"这一种情形。把它当成"拿不准就 unknown"的兜底，\n'
      + '  会让本期整个维度退化成一个永远不说话的字段。',
    );
  });

  test('链已停止但观察者没瞎 → 仍然给出恢复能力的结论', () => {
    assert.equal(
      deriveRecoveryCapability({ rows: [primary('stopped'), primary('stopped')], tier: 'stopped' }),
      'blocked',
      '链停了和面板瞎了是两件事 —— 前者不影响面板作判断的资格',
    );
  });

  test('启动中（starting）时也照常判', () => {
    assert.equal(
      deriveRecoveryCapability({ rows: [primary('healthy'), primary('healthy')], tier: 'starting' }),
      'ok',
    );
  });
});
