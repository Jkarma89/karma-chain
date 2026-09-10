// T043 / T044 —— 观察者失明与 pathAlive（功能 003 / FR-020、SC-006）。
//
// ## 为什么这一层必须存在，而且必须离线可测
//
// 观察者本机网卡一断，7 个节点全不可达 → `seenByPeers` 为空、每个边界都
// `domainAllUnreachable` → 5 个验证者全判离线 → 既有 `summarize()` 输出
// 「**链已停止出块**」。
//
// **那是既有代码在孤立使用时的正确行为**（`devnet-status` 是人主动跑的一次性命令，
// 人知道自己刚拔了网线），但对一个常驻面板就是 FR-020 明令禁止的假报警。
// 面板必须在它之上加一层，而且这一层要能不靠拔网线来测。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deriveTier, buildIncidents, TIERS } from '../../tools/dashboard/snapshot.mjs';
import { tierCopy } from '../../tools/dashboard/public/copy.mjs';

let seq = 0;
const v = (state, offline) => ({
  id: `l1-${(seq += 1)}`,
  role: 'l1-validator',
  state,
  countsTowardTolerance: true,
  countsAsOffline: offline ?? !['healthy', 'catching-up', 'bootstrapping', 'starting'].includes(state),
});

const LAN = () => ({
  validatorCount: 5,
  maxOfflineValidators: 1,
  domainCount: 5,
  maxValidatorsPerDomain: 1,
  declaredWithinLimit: true,
  effectiveDomainCount: 5,
  effectiveDomains: Array.from({ length: 5 }, (_, i) => ({ ids: [`d${i}`], factors: [], validators: 1 })),
  tolerateWholeDomainLoss: true,
});

const obs = (reachableNodes, pathAlive = []) => ({
  reachableNodes, totalNodes: 7, blind: reachableNodes === 0, pathAlive,
});

const allUnreachable = () => Array.from({ length: 5 }, () => v('unreachable', true));

describe('P1 观察者失明优先于 P3 已停止', () => {
  test('0 可达 → observer-blind，绝不是 stopped', () => {
    const got = deriveTier({ rows: allUnreachable(), faultTolerance: LAN(), observer: obs(0) });
    assert.equal(got.tier, TIERS.OBSERVER_BLIND);
    assert.notEqual(got.tier, TIERS.STOPPED);
  });

  test('0 可达**且**恰有节点停在 bootstrapping，仍是 observer-blind（P2 不得越过 P1）', () => {
    // 若 P2 跑到 P1 前面，会报「启动中」而掩盖掉"面板自己瞎了"这个真相。
    const rows = [v('bootstrapping'), ...Array.from({ length: 4 }, () => v('unreachable', true))];
    const got = deriveTier({ rows, faultTolerance: LAN(), observer: obs(0) });
    assert.equal(got.tier, TIERS.OBSERVER_BLIND);
  });

  test('0 可达且全部 healthy（矛盾输入）仍是 observer-blind —— 观察者可达性是独立事实', () => {
    // 这种输入现实中不会出现，但它证明 P1 不是"从行状态推出来的"，
    // 而是取自 ObserverViewpoint 这个**独立于链**的实体。
    const rows = Array.from({ length: 5 }, () => v('healthy'));
    const got = deriveTier({ rows, faultTolerance: LAN(), observer: obs(0) });
    assert.equal(got.tier, TIERS.OBSERVER_BLIND);
  });

  test('1 个可达就不再失明 —— 判据是 reachableNodes === 0，不是"多数不可达"', () => {
    const rows = [v('healthy'), ...Array.from({ length: 4 }, () => v('unreachable', true))];
    const got = deriveTier({ rows, faultTolerance: LAN(), observer: obs(1) });
    assert.notEqual(got.tier, TIERS.OBSERVER_BLIND);
    assert.equal(got.tier, TIERS.STOPPED, '1/5 参与，低于门槛 4，且缺口是真实故障');
  });

  test('observer.blind 与 reachableNodes 不一致时以 blind 为准', () => {
    // blind 是显式字段；调用方若已经算好就该被尊重（例如未来加入别的失明判据）。
    const rows = Array.from({ length: 5 }, () => v('healthy'));
    const got = deriveTier({
      rows,
      faultTolerance: LAN(),
      observer: { reachableNodes: 7, totalNodes: 7, blind: true, pathAlive: [] },
    });
    assert.equal(got.tier, TIERS.OBSERVER_BLIND);
  });
});

describe('pathAlive 只改措辞，永不改档位（T044）', () => {
  const base = { rows: allUnreachable(), faultTolerance: LAN() };

  test('全无应答 / 部分路径通 / 全部路径通 —— 档位与百分比完全相同', () => {
    const none = deriveTier({ ...base, observer: obs(0, [{ domain: 'a', alive: false }, { domain: 'b', alive: false }]) });
    const some = deriveTier({ ...base, observer: obs(0, [{ domain: 'a', alive: true }, { domain: 'b', alive: false }]) });
    const all = deriveTier({ ...base, observer: obs(0, [{ domain: 'a', alive: true }, { domain: 'b', alive: true }]) });
    for (const got of [some, all]) {
      assert.equal(got.tier, none.tier);
      assert.equal(got.healthPercent, none.healthPercent);
      assert.equal(got.validatorMargin, none.validatorMargin);
      assert.equal(got.domainMargin, none.domainMargin);
    }
  });

  test('措辞确实随 pathAlive 变化 —— 否则这几个额外请求白发了', () => {
    const noPath = tierCopy({
      ...deriveTier({ ...base, observer: obs(0, [{ domain: 'a', alive: false }]) }),
      observer: obs(0, [{ domain: 'a', alive: false }]),
    });
    const somePath = tierCopy({
      ...deriveTier({ ...base, observer: obs(0, [{ domain: 'a', alive: true }]) }),
      observer: obs(0, [{ domain: 'a', alive: true }]),
    });
    assert.notEqual(noPath.body, somePath.body);
    assert.match(noPath.action, /本机|网卡|交换机/, '全无应答时指向本机网络');
    assert.match(somePath.action, /机器|节点进程/, '有路径通时指向那几台机器');
  });

  test('两种措辞都不得出现"链已停止"（FR-020 / SC-006）', () => {
    for (const alive of [true, false]) {
      const observer = obs(0, [{ domain: 'a', alive }]);
      const copy = tierCopy({ ...deriveTier({ ...base, observer }), observer });
      const text = `${copy.label}${copy.body}${copy.action}`;
      assert.doesNotMatch(text, /链已停止|停止出块|链停止/,
        `pathAlive=${alive} 时的措辞出现了"链已停止" —— 面板自己瞎了不能替链下结论`);
    }
  });
});

describe('失明时的异常分类', () => {
  const args = (pathAlive) => ({
    rows: allUnreachable(),
    tier: TIERS.OBSERVER_BLIND,
    observer: obs(0, pathAlive),
    chainIdentity: { forkDetected: false, unknownGenesis: false },
  });

  test('产生 observation 类，且**不**产生 consensus-margin', () => {
    // 归错类会让人去看验证者，而要修的是本机网络。
    const got = buildIncidents(args([]));
    assert.equal(got.filter((i) => i.class === 'observation').length >= 1, true);
    assert.equal(got.filter((i) => i.class === 'consensus-margin').length, 0);
  });

  test('observation 的处置方向指向本机，不指向那台机器', () => {
    const got = buildIncidents(args([]));
    const o = got.find((i) => i.class === 'observation' && !i.nodeId);
    assert.ok(o, '应当有一条整体层面的 observation');
    assert.match(o.action, /本机|别去动/);
  });

  test('有路径通时消息里说明"节点确实不应答"，无路径时指向本机网络', () => {
    const withPath = buildIncidents(args([{ domain: 'a', alive: true }]))
      .find((i) => i.class === 'observation' && !i.nodeId);
    const without = buildIncidents(args([{ domain: 'a', alive: false }]))
      .find((i) => i.class === 'observation' && !i.nodeId);
    assert.match(withPath.message, /路径.*通|确实不应答/);
    assert.match(without.message, /本机网络|网卡|交换机/);
  });
});

describe('单节点的「本机视角不可达」与整体失明是两件事', () => {
  test('1 个本机视角不可达 → 健康度 100%、无 consensus-margin、异常归 observation', () => {
    const rows = [
      ...Array.from({ length: 4 }, () => v('healthy')),
      { ...v('unreachable', false), detail: '本机连不上它，但网络中其他节点与它有连接' },
    ];
    const tierInfo = deriveTier({ rows, faultTolerance: LAN(), observer: obs(6) });
    assert.equal(tierInfo.healthPercent, 100);
    assert.equal(tierInfo.tier, TIERS.NORMAL);
    assert.equal(tierInfo.validatorMargin, 1);

    const incidents = buildIncidents({
      rows, tier: tierInfo.tier, observer: obs(6),
      chainIdentity: { forkDetected: false, unknownGenesis: false },
    });
    assert.equal(incidents.filter((i) => i.class === 'consensus-margin').length, 0,
      '本机路径问题不是共识问题');
    assert.equal(incidents.filter((i) => i.class === 'observation').length, 1);
  });

  test('整域缺席的 unreachable 归 node-infra，与上面那条方向相反', () => {
    const rows = [
      ...Array.from({ length: 4 }, () => v('healthy')),
      v('unreachable', true),
    ];
    const incidents = buildIncidents({
      rows, tier: TIERS.ZERO_MARGIN, observer: obs(5),
      chainIdentity: { forkDetected: false, unknownGenesis: false },
    });
    assert.equal(incidents.filter((i) => i.class === 'node-infra').length, 1);
    assert.equal(incidents.filter((i) => i.class === 'observation').length, 0,
      '同一个状态名，两种含义 —— 混淆两者会把人指向错误的机器');
  });
});
