// T007 —— 异常分类（功能 003）。
//
// 本文件是 `data-model.md` 第 5 节那张表的机械转录。
//
// ## 为什么分类必须机器可读
//
// 宪法第九条要求区分故障类别，理由是**处置方式完全不同**：
//
// | 分类 | 处置 |
// |---|---|
// | observation | 修本机的网络路径。**链是好的，别去动那台机器** |
// | node-infra | 去那台机器看进程/卷/密钥 |
// | sync-lag | **等**。不是故障，不得触发处置 |
// | consensus-margin | 恢复验证者数量，不是修单个节点 |
// | chain-identity | 那台机器跑在另一条链上 —— 比下线严重，且不表现为健康度下降 |
//
// 既有 `classify()` 的 `detail` 是自由文本，页面无从按分类分组、测试无从按分类断言。
// 所以要一个枚举。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { incidentClass, buildIncidents, INCIDENT_CLASSES } from '../../tools/dashboard/snapshot.mjs';

/** 既有 ALL_STATES（node-status.mjs:40）—— 9 个取值，一个都不能漏判。 */
const ALL_STATES = [
  'stopped', 'starting', 'bootstrapping', 'catching-up',
  'healthy', 'unreachable', 'identity-mismatch', 'data-corrupt', 'stalled',
];

const row = (state, extra = {}) => ({
  id: 'l1-1',
  role: 'l1-validator',
  state,
  countsTowardTolerance: true,
  countsAsOffline: !['healthy', 'catching-up', 'bootstrapping', 'starting'].includes(state),
  genesisMatchesBaseline: true,
  ...extra,
});

describe('incidentClass —— 逐状态映射', () => {
  const expected = {
    healthy: null,
    'catching-up': 'sync-lag',
    bootstrapping: 'sync-lag',
    starting: 'sync-lag',
    stopped: 'node-infra',
    stalled: 'node-infra',
    'identity-mismatch': 'node-infra',
    'data-corrupt': 'node-infra',
  };

  for (const [state, cls] of Object.entries(expected)) {
    test(`${state} → ${cls ?? 'null（无异常）'}`, () => {
      assert.equal(incidentClass(row(state)), cls);
    });
  }

  test('unreachable 且 countsAsOffline=false → observation（本机路径问题）', () => {
    assert.equal(incidentClass(row('unreachable', { countsAsOffline: false })), 'observation');
  });

  test('unreachable 且 countsAsOffline=true → node-infra（整域缺席）', () => {
    assert.equal(incidentClass(row('unreachable', { countsAsOffline: true })), 'node-infra');
  });

  test('healthy 不产生异常条目', () => {
    assert.equal(incidentClass(row('healthy')), null);
  });

  test('9 个状态取值全部落进确定的分类，无一落进未定义值（SC-020）', () => {
    const valid = new Set([...INCIDENT_CLASSES, null]);
    for (const state of ALL_STATES) {
      for (const offline of [true, false]) {
        const got = incidentClass(row(state, { countsAsOffline: offline }));
        assert.ok(valid.has(got), `state=${state} offline=${offline} 得到未定义分类 ${got}`);
      }
    }
  });

  test('INCIDENT_CLASSES 恰好是契约里的五类', () => {
    assert.deepEqual(
      [...INCIDENT_CLASSES].sort(),
      ['chain-identity', 'consensus-margin', 'node-infra', 'observation', 'sync-lag'],
    );
  });
});

describe('buildIncidents —— 整条链层面的异常', () => {
  const base = {
    rows: [row('healthy'), row('healthy')],
    tier: 'normal',
    observer: { reachableNodes: 7, totalNodes: 7, blind: false, pathAlive: [] },
    chainIdentity: { forkDetected: false, unknownGenesis: false },
  };

  test('全健康 + normal 档 → 无异常条目', () => {
    assert.deepEqual(buildIncidents(base), []);
  });

  test('zero-margin 档产生一条 consensus-margin', () => {
    const got = buildIncidents({ ...base, tier: 'zero-margin' });
    assert.equal(got.filter((i) => i.class === 'consensus-margin').length, 1);
  });

  test('stopped 档产生一条 consensus-margin', () => {
    const got = buildIncidents({ ...base, tier: 'stopped' });
    assert.equal(got.filter((i) => i.class === 'consensus-margin').length, 1);
  });

  test('observer-blind 产生一条 observation，且**不**产生 consensus-margin', () => {
    // 面板自己瞎了不是共识问题。把它归成 consensus-margin 会让人去看验证者，
    // 而要修的是本机网络。
    const got = buildIncidents({
      ...base,
      tier: 'observer-blind',
      observer: { reachableNodes: 0, totalNodes: 7, blind: true, pathAlive: [] },
    });
    assert.equal(got.filter((i) => i.class === 'observation').length, 1);
    assert.equal(got.filter((i) => i.class === 'consensus-margin').length, 0);
  });

  test('starting 档不产生 consensus-margin —— 它是"要等"，不是"须处置"', () => {
    const got = buildIncidents({ ...base, tier: 'starting' });
    assert.equal(got.filter((i) => i.class === 'consensus-margin').length, 0);
  });

  test('创世哈希不一致产生 chain-identity，且与档位无关', () => {
    const got = buildIncidents({
      ...base,
      tier: 'normal', // 健康度可以是 100% —— 那个节点自己活得很好，只是不在同一条链上
      rows: [row('healthy'), row('healthy', { genesisMatchesBaseline: false })],
      chainIdentity: { forkDetected: true, unknownGenesis: false },
    });
    assert.equal(got.filter((i) => i.class === 'chain-identity').length, 1);
  });

  test('genesisMatchesBaseline === null 不产生 chain-identity —— 虚报一次分叉就再没人信', () => {
    const got = buildIncidents({
      ...base,
      rows: [row('healthy'), row('healthy', { genesisMatchesBaseline: null })],
      chainIdentity: { forkDetected: false, unknownGenesis: true },
    });
    assert.equal(got.filter((i) => i.class === 'chain-identity').length, 0);
  });

  test('每条异常都带 class 与 message，且 class 在枚举内（SC-020）', () => {
    const got = buildIncidents({
      ...base,
      tier: 'zero-margin',
      rows: [row('healthy'), row('stopped'), row('catching-up'), row('unreachable', { countsAsOffline: false })],
      chainIdentity: { forkDetected: true, unknownGenesis: false },
    });
    assert.ok(got.length > 0, '这组输入应当产生异常条目');
    for (const i of got) {
      assert.ok(INCIDENT_CLASSES.has(i.class), `未分类异常：${JSON.stringify(i)}`);
      assert.equal(typeof i.message, 'string');
      assert.ok(i.message.length > 0, '每条异常都要有可读的说明');
      assert.equal(typeof i.action, 'string');
      assert.ok(i.action.length > 0, '每条异常都要给处置方向（宪法第九条）');
    }
  });

  test('buildIncidents 不修改入参', () => {
    const args = { ...base, tier: 'stopped', rows: [row('stopped')] };
    const before = JSON.stringify(args);
    buildIncidents(args);
    assert.equal(JSON.stringify(args), before);
  });
});
