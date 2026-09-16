// 容错判据必须收敛到**链上注册的成员**（功能 005 / T073 / research V-31）。
//
// ## 这条守卫来自一次真实的假警报
//
// 2026-09-15 的现场：声明 6 个验证者（l1-6 已声明、未注册、未启动）、
// 链上注册 5 个、win-2 整机离线导致 l1-2 缺席。面板按**声明的 6 个**算：
//
//     threshold = 6 - ⌊6/4⌋ = 5，participating = 4 < 5 → 「链已停止出块」
//
// **而链一直在出块** —— 一笔探测交易在区块 975 确认，耗时 8.7 秒。
// 真实账是 5 个注册成员掉 1 个 = 80% ≥ 75%，仍在门槛之上。
//
// 这不是"数字不准"，是**结论方向错了**。假警报会让人去排查一个不存在的故障，
// 而反复的假警报会训练人忽略面板 —— 那比少一个告警更坏。
//
// ## 本套件最要紧的一条
//
// 不是"收敛后结论对"，而是**「不收敛时确实会报假警报」** ——
// 那条把这个修复的意义钉住。少了它，后人可能把 scopeToChainMembers 当成
// 一层可以随手绕过的包装，而绕过它的代价在正常状态下看不出来。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from '../../tools/protocol/load.mjs';
import { deriveTier, scopeToChainMembers, TIERS } from '../../tools/dashboard/snapshot.mjs';

/** 造一个验证者行。`nodeId` 是它自报（或声明）的身份 —— 收敛就靠它比对。 */
const v = (id, nodeId, state = 'healthy', domain = id) => ({
  id,
  role: 'l1-validator',
  nodeId,
  domain,
  state,
  countsTowardTolerance: true,
  countsAsOffline: !['healthy', 'catching-up', 'bootstrapping', 'starting'].includes(state),
});

/** 按**声明**派生的容错，n 个验证者各占一个边界。 */
const declaredFt = (n) => ({
  validatorCount: n,
  maxOfflineValidators: Math.floor(n / 4),
  domainCount: n,
  maxValidatorsPerDomain: Math.floor(n / 4),
  declaredWithinLimit: true,
  effectiveDomainCount: n,
  effectiveDomains: Array.from({ length: n }, (_, i) => ({ ids: [`l1-${i + 1}`], factors: [], validators: 1 })),
  tolerateWholeDomainLoss: true,
});

const observer = { reachableNodes: 5, totalNodes: 7, blind: false, pathAlive: [] };

/** 复现 V-31 的那一刻：声明 6、链上 5、在线 4（l1-2 掉了，l1-6 未注册未启动）。 */
const v31 = () => {
  const rows = [
    v('l1-1', 'NodeID-A'),
    v('l1-2', 'NodeID-B', 'unreachable'),
    v('l1-3', 'NodeID-C'),
    v('l1-4', 'NodeID-D'),
    v('l1-5', 'NodeID-E'),
    v('l1-6', 'NodeID-F', 'unreachable'),      // 已声明，**未注册**，未启动
  ];
  const memberSet = {
    source: 'p-chain',
    registeredNodeIds: ['NodeID-A', 'NodeID-B', 'NodeID-C', 'NodeID-D', 'NodeID-E'],
  };
  return { rows, faultTolerance: declaredFt(6), memberSet };
};

describe('**不收敛时确实会报假警报**（这条钉住了本修复的意义）', () => {
  test('V-31 那一刻：按声明的 6 个算 → stopped（而链其实在出块）', () => {
    const { rows, faultTolerance } = v31();
    const got = deriveTier({ rows, faultTolerance, observer });   // 刻意不传 memberSet
    assert.equal(got.tier, TIERS.STOPPED,
      '按声明算竟然没报 stopped —— 那么本套件其余断言证明不了任何事。\n'
      + '  这条不是在要求"报错"，而是在确认：**不收敛的那条路真的会给出错结论**。');
    assert.equal(got.threshold, 5, '门槛应为 6 - ⌊6/4⌋ = 5');
    assert.equal(got.participating, 4);
  });
});

describe('收敛到链上成员之后，结论变对', () => {
  test('同一刻：按链上的 5 个算 → 不是 stopped', () => {
    const { rows, faultTolerance, memberSet } = v31();
    const scope = scopeToChainMembers({ rows, faultTolerance, memberSet });
    const got = deriveTier({ rows: scope.rows, faultTolerance: scope.faultTolerance, observer, memberSet });
    assert.notEqual(got.tier, TIERS.STOPPED,
      '收敛之后仍报「链已停止」—— 那正是 V-31 的假警报，链当时在正常出块');
    assert.equal(got.tier, TIERS.ZERO_MARGIN,
      '5 个注册成员掉 1 个：仍在门槛之上（80% ≥ 75%）但余量用尽 → 应为 zero-margin');
    assert.equal(got.validatorCount, 5, 'n 必须取**链上注册数**');
    assert.equal(got.threshold, 4, '门槛应为 5 - ⌊5/4⌋ = 4');
    assert.equal(got.participating, 4);
    assert.equal(got.validatorMargin, 0);
  });

  test('五个注册成员全在线 → normal（余量 1）', () => {
    const { faultTolerance, memberSet } = v31();
    const rows = [
      v('l1-1', 'NodeID-A'), v('l1-2', 'NodeID-B'), v('l1-3', 'NodeID-C'),
      v('l1-4', 'NodeID-D'), v('l1-5', 'NodeID-E'),
      v('l1-6', 'NodeID-F', 'unreachable'),
    ];
    const scope = scopeToChainMembers({ rows, faultTolerance, memberSet });
    const got = deriveTier({ rows: scope.rows, faultTolerance: scope.faultTolerance, observer, memberSet });
    assert.equal(got.tier, TIERS.NORMAL,
      '未注册的 l1-6 离线不该影响结论 —— 它还不是共识成员');
    assert.equal(got.validatorMargin, 1);
    assert.equal(got.healthPercent, 100, '分母是链上的 5 个，所以 5/5 = 100%');
  });

  test('未注册的声明成员：registeredOnChain 为 false，且**不计入**容错', () => {
    const { rows, faultTolerance, memberSet } = v31();
    const scope = scopeToChainMembers({ rows, faultTolerance, memberSet });
    const l16 = scope.rows.find((r) => r.id === 'l1-6');
    assert.equal(l16.registeredOnChain, false);
    assert.equal(l16.countsTowardTolerance, false,
      '未注册的成员计入了容错判据 —— 那就是 V-31 那个假警报的来源');
    // 但它照旧在行里，页面要显示它（"已声明，未注册"是一条要看见的信息）
    assert.ok(scope.rows.some((r) => r.id === 'l1-6'), '不该把它从行里删掉');
  });

  test('已注册的成员：registeredOnChain 为 true', () => {
    const { rows, faultTolerance, memberSet } = v31();
    const scope = scopeToChainMembers({ rows, faultTolerance, memberSet });
    for (const id of ['l1-1', 'l1-2', 'l1-3', 'l1-4', 'l1-5']) {
      assert.equal(scope.rows.find((r) => r.id === id).registeredOnChain, true, `${id} 应为已注册`);
    }
  });
});

describe('**保守侧**：链上注册了但看不见的成员，算不参与', () => {
  test('链上 5 个而只有 4 行 → n 仍是 5，缺的那个算不参与', () => {
    // 沿用 deriveTier 里那条既有理由：拿观测行数当分母，
    // 会在少了一行时把缺失**悄悄算成在线**。
    const rows = [
      v('l1-1', 'NodeID-A'), v('l1-2', 'NodeID-B'),
      v('l1-3', 'NodeID-C'), v('l1-4', 'NodeID-D'),
    ];
    const memberSet = {
      source: 'p-chain',
      registeredNodeIds: ['NodeID-A', 'NodeID-B', 'NodeID-C', 'NodeID-D', 'NodeID-E'],
    };
    const scope = scopeToChainMembers({ rows, faultTolerance: declaredFt(5), memberSet });
    assert.equal(scope.faultTolerance.validatorCount, 5,
      'n 取 P 链上带权重的成员数，不是行数 —— 否则少一行会把缺失算成在线');
    const got = deriveTier({ rows: scope.rows, faultTolerance: scope.faultTolerance, observer, memberSet });
    assert.equal(got.observedValidators, 4);
    assert.equal(got.healthPercent, 80, '4 个在线 / 5 个 P 链成员 = 80%');
  });
});

describe('读不到成员集合时：说「不知道」，不拿声明去凑', () => {
  test('source 非 chain → members-unknown，且**先于**所有数值判据', () => {
    const { rows, faultTolerance } = v31();
    const memberSet = { source: 'unknown', error: '连不上 RPC 入口' };
    const scope = scopeToChainMembers({ rows, faultTolerance, memberSet });
    const got = deriveTier({ rows: scope.rows, faultTolerance: scope.faultTolerance, observer, memberSet });
    assert.equal(got.tier, TIERS.MEMBERS_UNKNOWN,
      '读不到成员集合时按声明算出了一个结论 —— 那正是 V-31 的成因');
    assert.notEqual(got.tier, TIERS.STOPPED, '尤其不能说链停了');
  });

  test('未知时原样返回，不改任何行的 countsTowardTolerance', () => {
    const { rows, faultTolerance } = v31();
    const scope = scopeToChainMembers({ rows, faultTolerance, memberSet: { source: 'unknown' } });
    assert.equal(scope.scoped, false);
    assert.equal(scope.faultTolerance.validatorCount, 6, '未知时不该篡改 n');
    for (const r of scope.rows) {
      assert.equal(r.registeredOnChain, null, '未知时每一行的注册状态都该是 null，不是 false');
    }
  });

  test('**观察者失明仍然优先**（两者都是"我们看不见"，但失明更根本）', () => {
    const { rows, faultTolerance, memberSet } = v31();
    const blind = { reachableNodes: 0, totalNodes: 7, blind: true, pathAlive: [] };
    const scope = scopeToChainMembers({ rows, faultTolerance, memberSet });
    const got = deriveTier({ rows: scope.rows, faultTolerance: scope.faultTolerance, observer: blind, memberSet });
    assert.equal(got.tier, TIERS.OBSERVER_BLIND,
      '本机什么都连不上时，应当先说"我瞎了"，而不是"成员集合未知"');
  });
});

describe('有效边界的验证者数也要收敛', () => {
  test('只承载「已声明未注册」验证者的边界，不贡献余量', () => {
    const { rows, faultTolerance, memberSet } = v31();
    const scope = scopeToChainMembers({ rows, faultTolerance, memberSet });
    const l16Domain = scope.faultTolerance.effectiveDomains.find((g) => g.ids.includes('l1-6'));
    assert.ok(l16Domain, '边界应当还在（它是声明的一部分）');
    assert.equal(l16Domain.validators, 0,
      '未注册的验证者仍被算进边界的验证者数 —— 那会贡献一个不存在的整域余量');
  });

  test('承载已注册验证者的边界照旧计 1', () => {
    const { rows, faultTolerance, memberSet } = v31();
    const scope = scopeToChainMembers({ rows, faultTolerance, memberSet });
    for (const id of ['l1-1', 'l1-3']) {
      const g = scope.faultTolerance.effectiveDomains.find((x) => x.ids.includes(id));
      assert.equal(g.validators, 1, `边界 ${id} 应当计 1`);
    }
  });
});

describe('声明侧的数字没被丢掉（呈现"声明 6 / 链上 5"要用）', () => {
  test('declaredValidatorCount 保留了声明数', () => {
    const { rows, faultTolerance, memberSet } = v31();
    const scope = scopeToChainMembers({ rows, faultTolerance, memberSet });
    assert.equal(scope.faultTolerance.declaredValidatorCount, 6);
    assert.equal(scope.faultTolerance.validatorCount, 5);
    assert.notEqual(scope.faultTolerance.declaredValidatorCount, scope.faultTolerance.validatorCount,
      '两个数相等就说明没漂移 —— 此处夹具刻意让它们不等，否则测不到差额');
  });
});

describe('呈现：已声明未注册的验证者不得被叫成 Primary 节点', () => {
  // 分组一刀切按 countsTowardTolerance 的话，未注册的 L1 验证者会落进
  // 「Primary Network 节点」那一组 —— **用一句假话换掉另一句假话**。
  // 这里不渲染 DOM，只断言源码里的分组判据含"角色 + 注册状态"，
  // 而不是单看一个布尔值。行为层面的渲染由 tests/unit/dashboard-views.test.mjs 覆盖。
  test('view-nodes 的分组判据包含 role 与 registeredOnChain', () => {
    const src = readFileSync(resolve(REPO_ROOT, 'tools/dashboard/public/view-nodes.mjs'), 'utf8');
    assert.match(src, /registeredOnChain === false/,
      'view-nodes 没有按注册状态分组 —— 未注册的 L1 验证者会被归进 Primary 那一组');
    assert.match(src, /role === 'l1-validator'/,
      '分组判据里没有角色 —— 单看 countsTowardTolerance 分不出"未注册的验证者"与"Primary"');
    assert.match(src, /已声明、未注册/, '缺少那一组的标题');
  });

  test('那一组的说明必须给出去哪儿看（不是只说"没注册"）', () => {
    const src = readFileSync(resolve(REPO_ROOT, 'tools/dashboard/public/view-nodes.mjs'), 'utf8');
    assert.match(src, /membership:status|add-validator/,
      '说明里没给出下一步该看什么 —— 看到"未注册"的人需要知道去哪儿查它停在哪一步');
  });
});
