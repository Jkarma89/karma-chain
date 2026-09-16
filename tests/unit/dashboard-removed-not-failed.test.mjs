// 被主动移除的节点**不是故障节点**（功能 005 / T038 / FR-028）。
//
// ## 不加这一类的后果是实在的
//
// 退出规程要求：先从集合移除 → 等确认 → **再停进程** → 最后改声明。
// 于是"进程已停、声明还在"是一个**正常的中间状态**。
//
// 而 `incidentClass` 原先只看 `state` 与 `countsAsOffline`：那个节点会落进
// `stopped` → `node-infra`，处置写着"到那台机器上查节点进程、数据卷与挂载的密钥"。
// 那台机器上**没什么可查** —— 它是被有意摘掉的。
//
// 更坏的是这条红灯**不会自己消失**：要一直亮到有人去改 deployment.json。
// 一个不会自己消失的假故障会训练人忽略整个清单，那比少一条告警更坏。
//
// ## 这条守卫的边界在"只认显式的 false"
//
// `registeredOnChain` 有三种取值，而它们的含义完全不同：
//
//   `true`   是链上成员 —— 照常按状态判故障
//   `false`  **不是**成员 —— 正在加入或已退出，都不是故障
//   `null`   **不知道** —— 读不到成员集合，或这一行不计入容错（Primary）
//
// 把 `null` 也当成"不是成员"的后果最严重：成员集合读不到时（P 链不可达），
// 面板会把**全部**节点故障都归成"非故障"，于是一条真的停摆看起来像一次正常的成员变更。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  incidentClass, buildIncidents, scopeToChainMembers, INCIDENT_CLASSES,
} from '../../tools/dashboard/snapshot.mjs';
import { INCIDENT_COPY } from '../../tools/dashboard/public/copy.mjs';

/** 一个验证者行。`registeredOnChain` 默认 true（是成员），按需覆盖。 */
const row = (state, over = {}) => ({
  id: 'l1-6',
  role: 'l1-validator',
  domain: 'ubuntu-4',
  state,
  detail: '',
  countsAsOffline: !['healthy', 'catching-up', 'bootstrapping', 'starting'].includes(state),
  countsTowardTolerance: true,
  registeredOnChain: true,
  ...over,
});

const ALL_STATES = [
  'stopped', 'starting', 'bootstrapping', 'catching-up',
  'healthy', 'unreachable', 'identity-mismatch', 'data-corrupt', 'stalled',
];

describe('不是成员 → 一律不判故障（FR-028）', () => {
  test('**已移除且进程已停 → membership，不是 node-infra**（规程里的正常中间态）', () => {
    const cls = incidentClass(row('stopped', { registeredOnChain: false }));
    assert.equal(cls, 'membership',
      '被主动移除、进程已停的节点被判成了故障。'
      + 'node-infra 的处置是"到那台机器上查节点进程" —— 那台机器上没什么可查，'
      + '而这条红灯会一直亮到有人去改 deployment.json');
  });

  test('**全部状态**在非成员时都不判成故障类', () => {
    const failureClasses = new Set(['node-infra', 'observation', 'sync-lag']);
    for (const state of ALL_STATES) {
      for (const countsAsOffline of [true, false]) {
        const cls = incidentClass(row(state, { registeredOnChain: false, countsAsOffline }));
        assert.equal(cls, 'membership',
          `state=${state} offline=${countsAsOffline} 时判成了 ${cls}`);
        assert.ok(!failureClasses.has(cls));
      }
    }
  });

  test('healthy 的非成员也报 membership —— 它在跑，但不在集合里', () => {
    // 这不是噪声：一个健康但不是成员的节点意味着"加入没走完"或"退出只做了一半"，
    // 两种都需要有人去把流程走完。静默掉它就等于让一次半途而废的变更长期潜伏。
    assert.equal(incidentClass(row('healthy', { registeredOnChain: false })), 'membership');
  });
});

describe('是成员时，故障判定一字不变（不许因为新分类而放宽）', () => {
  for (const [state, offline, want] of [
    ['healthy', false, null],
    ['stopped', true, 'node-infra'],
    ['data-corrupt', true, 'node-infra'],
    ['identity-mismatch', true, 'node-infra'],
    ['stalled', true, 'node-infra'],
    ['unreachable', true, 'node-infra'],
    ['unreachable', false, 'observation'],
    ['catching-up', false, 'sync-lag'],
    ['bootstrapping', false, 'sync-lag'],
    ['starting', false, 'sync-lag'],
  ]) {
    test(`成员 + ${state}（offline=${offline}）→ ${want ?? 'null'}`, () => {
      assert.equal(incidentClass(row(state, { registeredOnChain: true, countsAsOffline: offline })), want);
    });
  }
});

describe('**`null` 是"不知道"，不是"不是成员"** —— 这条边界最要紧', () => {
  test('registeredOnChain 为 null 时，故障照旧报出来', () => {
    for (const [state, offline, want] of [
      ['stopped', true, 'node-infra'],
      ['data-corrupt', true, 'node-infra'],
      ['unreachable', true, 'node-infra'],
      ['unreachable', false, 'observation'],
      ['catching-up', false, 'sync-lag'],
    ]) {
      assert.equal(
        incidentClass(row(state, { registeredOnChain: null, countsAsOffline: offline })),
        want,
        `registeredOnChain=null 时 ${state} 被当成了非成员 —— `
        + '成员集合读不到时（P 链不可达），面板会把**全部**故障都归成"非故障"，'
        + '于是一条真的停摆看起来像一次正常的成员变更');
    }
  });

  test('字段缺失（undefined）也按"不知道"处理', () => {
    const r = row('stopped');
    delete r.registeredOnChain;
    assert.equal(incidentClass(r), 'node-infra',
      '缺字段被当成了 false —— 旧的行结构（还没经过 scopeToChainMembers）'
      + '会让全部故障消失');
  });

  test('读不到成员集合时 scopeToChainMembers 给出的正是 null', () => {
    // 接线校验：上面两条假设 "unknown 时字段为 null"，这一条证实它。
    const scope = scopeToChainMembers({
      rows: [row('stopped')],
      faultTolerance: { validatorCount: 5, maxOfflineValidators: 1 },
      memberSet: { source: 'unknown', error: 'P 链不可达' },
    });
    assert.equal(scope.scoped, false);
    assert.equal(scope.rows[0].registeredOnChain, null,
      '读不到成员集合时该给 null —— 给 false 会让全部故障被藏起来');
  });
});

describe('buildIncidents：条目带 nodeId，且不与故障类混淆', () => {
  const base = {
    tier: 'normal',
    observer: { reachableNodes: 7, totalNodes: 7, blind: false, pathAlive: [] },
    chainIdentity: { forkDetected: false, unknownGenesis: false },
  };

  test('非成员产生一条 membership 条目，挂在那个节点上', () => {
    const inc = buildIncidents({ ...base, rows: [row('stopped', { registeredOnChain: false })] });
    const mine = inc.filter((i) => i.class === 'membership');
    assert.equal(mine.length, 1);
    assert.equal(mine[0].nodeId, 'l1-6', '节点级条目必须带 nodeId');
    assert.equal(inc.filter((i) => i.class === 'node-infra').length, 0,
      '同一个节点同时产生了故障条目 —— 两个分类的处置相反，不能并存');
  });

  test('一个非成员 + 一个真故障 → 各报各的，不互相吞掉', () => {
    const inc = buildIncidents({
      ...base,
      rows: [
        row('stopped', { id: 'l1-6', registeredOnChain: false }),
        row('data-corrupt', { id: 'l1-3', registeredOnChain: true }),
      ],
    });
    assert.deepEqual(
      inc.filter((i) => ['membership', 'node-infra'].includes(i.class))
        .map((i) => [i.nodeId, i.class]).sort(),
      [['l1-3', 'node-infra'], ['l1-6', 'membership']],
      '非成员把真故障吞掉了，或反过来');
  });
});

describe('文案：这一类必须读起来不像红灯', () => {
  test('membership 在枚举里，且有文案', () => {
    assert.ok(INCIDENT_CLASSES.has('membership'));
    assert.ok(INCIDENT_COPY.membership, '缺文案 —— 界面上会显示原始 slug');
  });

  test('**标签里要说明它不是故障**', () => {
    assert.match(INCIDENT_COPY.membership.label, /非故障|不是故障/,
      `标签是"${INCIDENT_COPY.membership.label}" —— 这一类最容易被当成红灯，`
      + '而它出现的典型时刻是一次正常的成员变更进行中');
  });

  test('**处置方向不能是"去那台机器查"** —— 那是 node-infra 的方向', () => {
    assert.doesNotMatch(INCIDENT_COPY.membership.action, /到那台机器|去那台机器/,
      '处置写成了去查机器 —— 这一类的全部意义就是把它与 node-infra 分开');
    assert.match(INCIDENT_COPY.membership.action, /membership:status/,
      '没有指向能分清"正在加入"与"已退出"的工具 —— 而这一行本身分不出来');
  });

  test('与其余六类的处置方向互不相同', () => {
    const actions = [...INCIDENT_CLASSES].map((c) => INCIDENT_COPY[c].action);
    assert.equal(new Set(actions).size, actions.length,
      '有两类给出了相同的处置方向 —— 分类若不改变处置，就不该存在');
  });
});
