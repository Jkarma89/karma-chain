// T005 —— 健康度档位判定（功能 003）。
//
// 本文件是 `specs/003-chain-health-dashboard/contracts/health-tier.md` 第 4 节真值表
// 与第 9 节「坏了会变红吗」对照表的**机械转录**，不是事后补的测试。
//
// ## 为什么这些判定必须能离线测
//
// 其中两条最重要的分支在**活链上很难制造**：观察者失明要断掉观察者的网卡，
// 全员启动中要把五台机器全停再分批起。若判定不能离线测试，它们就只能靠"希望它对"。
// 而它们恰好是两个方向相反的错误来源：
//
// - 观察者断网 → 7 个节点全不可达 → 既有 `summarize()` 报「链已停止出块」（**假红灯**）
// - 全员引导中 → `NOT_OFFLINE` 含 `bootstrapping` → 报「100% 正常」（**假绿灯**）
//
// 002 的 `classify()` 已采用纯函数并在源码注释里写明同一理由（「状态机分支太多，
// 必须能不靠活链测」），本文件沿用。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { participatesInConsensus, deriveTier } from '../../tools/dashboard/snapshot.mjs';

/** 既有 classify() 的 NOT_OFFLINE 集合 —— 用来复刻它对 countsAsOffline 的默认推导。 */
const NOT_OFFLINE = new Set(['healthy', 'catching-up', 'bootstrapping', 'starting']);

let seq = 0;
/**
 * 造一个 L1 验证者的观测行。`offline` 显式覆盖 countsAsOffline ——
 * `unreachable` 有两种含义且离线语义**相反**，必须能分别构造。
 */
const v = (state, offline) => ({
  id: `l1-${(seq += 1)}`,
  role: 'l1-validator',
  state,
  countsTowardTolerance: true,
  countsAsOffline: offline ?? !NOT_OFFLINE.has(state),
});

/** Primary 节点：不参与 L1 出块，不计入容错（研究 R-09）。 */
const primary = () => ({
  id: `primary-${(seq += 1)}`,
  role: 'primary',
  state: 'healthy',
  countsTowardTolerance: false,
  countsAsOffline: false,
});

/** 容错视图。逐个边界给验证者数，让 domainMargin 也能在同一处构造。 */
const ft = (validatorCount, maxOfflineValidators, perDomain) => ({
  validatorCount,
  maxOfflineValidators,
  domainCount: perDomain.length,
  maxValidatorsPerDomain: maxOfflineValidators,
  declaredWithinLimit: true,
  effectiveDomainCount: perDomain.length,
  effectiveDomains: perDomain.map((n, i) => ({ ids: [`d${i}`], factors: [], validators: n })),
  tolerateWholeDomainLoss: perDomain.length > 1,
});

const LAN = () => ft(5, 1, [1, 1, 1, 1, 1]);
const obs = (reachableNodes, totalNodes = 7) => ({
  reachableNodes, totalNodes, blind: reachableNodes === 0, pathAlive: [],
});

describe('participatesInConsensus —— 与 countsAsOffline 是两个不同的谓词', () => {
  // data-model.md 第 0 节：countsAsOffline 答"这节点须不须要处置"，
  // participatesInConsensus 答"链还能掉几个"。直接复用前者会得到假绿灯。
  const cases = [
    ['healthy', undefined, true, '已引导、已追平、在服务 L1'],
    ['catching-up', undefined, true, '已引导、在服务 L1，只是落后一个传播尾巴（FR-011）'],
    ['unreachable', false, true, '其余节点看得见它 —— 断的是本机到它的路径（FR-012 / FR-004a）'],
    ['unreachable', true, false, '整域缺席，链里没有它'],
    ['bootstrapping', undefined, false, '尚未服务 L1，不提供连接权益'],
    ['starting', undefined, false, '进程在跑、API 未响应'],
    ['stopped', undefined, false, ''],
    ['stalled', undefined, false, ''],
    ['identity-mismatch', undefined, false, ''],
    ['data-corrupt', undefined, false, ''],
  ];
  for (const [state, offline, expected, why] of cases) {
    const label = `${state}${offline === undefined ? '' : `（countsAsOffline=${offline}）`}`;
    test(`${label} → ${expected ? '参与' : '不参与'}${why ? ` —— ${why}` : ''}`, () => {
      assert.equal(participatesInConsensus(v(state, offline)), expected);
    });
  }

  test('bootstrapping 的两个谓词取值相反 —— 这正是不能复用 countsAsOffline 的原因', () => {
    const row = v('bootstrapping');
    assert.equal(row.countsAsOffline, false, '既有语义：引导中是"要等"，不须处置');
    assert.equal(participatesInConsensus(row), false, '健康度语义：引导中不提供连接权益');
  });
});

describe('契约第 4 节 —— n=5, f=1, threshold=4 的完整真值表', () => {
  const rows = [
    // [编号, 描述, 构造, 可达节点数, 期望档位, 期望百分比, 期望验证者余量]
    [1, '5 参与', () => [v('healthy'), v('healthy'), v('healthy'), v('healthy'), v('healthy')], 7, 'normal', 100, 1],
    [2, '4 参与 + 1 stopped', () => [v('healthy'), v('healthy'), v('healthy'), v('healthy'), v('stopped')], 6, 'zero-margin', 80, 0],
    [3, '4 参与 + 1 stalled', () => [v('healthy'), v('healthy'), v('healthy'), v('healthy'), v('stalled')], 6, 'zero-margin', 80, 0],
    [4, '4 参与 + 1 unreachable(整域)', () => [v('healthy'), v('healthy'), v('healthy'), v('healthy'), v('unreachable', true)], 5, 'zero-margin', 80, 0],
    [5, '4 参与 + 1 bootstrapping', () => [v('healthy'), v('healthy'), v('healthy'), v('healthy'), v('bootstrapping')], 7, 'zero-margin', 80, 0],
    [6, '3 参与 + 2 stopped', () => [v('healthy'), v('healthy'), v('healthy'), v('stopped'), v('stopped')], 5, 'stopped', 60, 0],
    [7, '3 参与 + 2 bootstrapping', () => [v('healthy'), v('healthy'), v('healthy'), v('bootstrapping'), v('bootstrapping')], 7, 'starting', 60, 0],
    [8, '3 参与 + 1 bootstrapping + 1 stopped', () => [v('healthy'), v('healthy'), v('healthy'), v('bootstrapping'), v('stopped')], 6, 'stopped', 60, 0],
    [9, '1 参与 + 4 bootstrapping', () => [v('healthy'), v('bootstrapping'), v('bootstrapping'), v('bootstrapping'), v('bootstrapping')], 7, 'starting', 20, 0],
    [10, '0 参与 + 5 stopped（只剩两个 Primary 可达）', () => [v('stopped'), v('stopped'), v('stopped'), v('stopped'), v('stopped')], 2, 'stopped', 0, 0],
    [11, '0 参与 + 全部 unreachable，可达 0', () => [v('unreachable', true), v('unreachable', true), v('unreachable', true), v('unreachable', true), v('unreachable', true)], 0, 'observer-blind', 0, 0],
    [12, '5 参与，其中 1 个本机视角不可达', () => [v('healthy'), v('healthy'), v('healthy'), v('healthy'), v('unreachable', false)], 6, 'normal', 100, 1],
    [13, '5 参与，其中 1 个 catching-up', () => [v('healthy'), v('healthy'), v('healthy'), v('healthy'), v('catching-up')], 7, 'normal', 100, 1],
  ];

  for (const [n, desc, build, reachable, tier, percent, margin] of rows) {
    test(`第 ${n} 行 —— ${desc} → ${tier} / ${percent}% / 余量 ${margin}`, () => {
      const got = deriveTier({
        rows: [...build(), primary(), primary()],
        faultTolerance: LAN(),
        observer: obs(reachable),
      });
      assert.equal(got.tier, tier);
      assert.equal(got.healthPercent, percent);
      assert.equal(got.validatorMargin, margin);
    });
  }

  test('Primary 节点不影响任何一项 —— countsTowardTolerance 为 false', () => {
    const validators = [v('healthy'), v('healthy'), v('healthy'), v('healthy'), v('healthy')];
    const withPrimaries = deriveTier({ rows: [...validators, primary(), primary()], faultTolerance: LAN(), observer: obs(7) });
    const withoutPrimaries = deriveTier({ rows: validators, faultTolerance: LAN(), observer: obs(5) });
    assert.equal(withPrimaries.tier, withoutPrimaries.tier);
    assert.equal(withPrimaries.healthPercent, withoutPrimaries.healthPercent);
  });

  test('分母恒为声明的 validatorCount，不是观测到的行数', () => {
    // 沿用既有 summarize() 的理由：拿观测行数当分母，会在少了一行时把缺失悄悄算成在线。
    const got = deriveTier({
      rows: [v('healthy'), v('healthy')], // 只观测到 2 行，声明是 5 个
      faultTolerance: LAN(),
      observer: obs(2),
    });
    assert.equal(got.healthPercent, 40, '2/5 = 40%，不是 2/2 = 100%');
    assert.equal(got.observedValidators, 2);
    assert.equal(got.validatorCount, 5);
  });
});

describe('契约第 9 节 —— 这些判定坏了会变红吗', () => {
  test('P1 优先于 P3：0 可达必须是 observer-blind，不得是 stopped', () => {
    // 若 P1 缺失：seenByPeers 为空、每边界 domainAllUnreachable → 5 个验证者全判离线
    // → summarize() 输出「链已停止出块」。这正是 FR-020 明令禁止的假报警，
    // **而且是既有代码在孤立使用时的默认行为**。
    const got = deriveTier({
      rows: Array.from({ length: 5 }, () => v('unreachable', true)),
      faultTolerance: LAN(),
      observer: obs(0),
    });
    assert.equal(got.tier, 'observer-blind');
    assert.notEqual(got.tier, 'stopped');
  });

  test('P2 优先于 P3：缺口全由启动中造成时必须是 starting', () => {
    const got = deriveTier({
      rows: [v('healthy'), v('bootstrapping'), v('bootstrapping'), v('starting'), v('starting')],
      faultTolerance: LAN(),
      observer: obs(7),
    });
    assert.equal(got.tier, 'starting');
  });

  test('P2 不得越过 P1：0 可达且恰有节点停在 bootstrapping，仍是 observer-blind', () => {
    // 若 P2 跑到 P1 前面，会报「启动中」而掩盖掉"面板自己瞎了"这个真相。
    const got = deriveTier({
      rows: [v('bootstrapping'), v('unreachable', true), v('unreachable', true), v('unreachable', true), v('unreachable', true)],
      faultTolerance: LAN(),
      observer: obs(0),
    });
    assert.equal(got.tier, 'observer-blind');
  });

  test('P4 不得越过 P3：3 参与必须是 stopped —— 否则 stopped 永不触发', () => {
    // 逻辑上 margin===0 时 participating 必 ≥ threshold，所以写反不会立刻报错，
    // 而是让 stopped 这一档**永远不出现** —— 一个永不变红的报警。
    const got = deriveTier({
      rows: [v('healthy'), v('healthy'), v('healthy'), v('stopped'), v('stopped')],
      faultTolerance: LAN(),
      observer: obs(5),
    });
    assert.equal(got.tier, 'stopped');
    assert.notEqual(got.tier, 'zero-margin');
  });

  test('本机视角不可达算参与：健康度 100%、余量 1', () => {
    const got = deriveTier({
      rows: [v('healthy'), v('healthy'), v('healthy'), v('healthy'), v('unreachable', false)],
      faultTolerance: LAN(),
      observer: obs(6),
    });
    assert.equal(got.healthPercent, 100);
    assert.equal(got.validatorMargin, 1);
    assert.equal(got.tier, 'normal');
  });

  test('引导中不算参与：1 健康 + 4 引导中 是 starting/20%，不是 normal/100%', () => {
    const got = deriveTier({
      rows: [v('healthy'), v('bootstrapping'), v('bootstrapping'), v('bootstrapping'), v('bootstrapping')],
      faultTolerance: LAN(),
      observer: obs(7),
    });
    assert.equal(got.healthPercent, 20);
    assert.equal(got.tier, 'starting');
    assert.notEqual(got.healthPercent, 100);
  });

  test('阈值不写死：喂 n=9 / f=2，档位随 f ≤ ⌊n/4⌋ 整体移位（SC-016）', () => {
    // **这条用例的要点是：百分比本身从来不是判据。**
    // n=5 / f=1 时零余量落在 80%、停摆落在 60%；
    // n=9 / f=2 时零余量落在 78%、停摆落在 67% —— 数字全变了，判定式一行没变。
    // 若实现里写死了 80 / 60（或 0.75），本用例必然变红。
    const nine = ft(9, 2, [1, 1, 1, 1, 1, 1, 1, 1, 1]);
    const at = (participating) => deriveTier({
      rows: [
        ...Array.from({ length: participating }, () => v('healthy')),
        ...Array.from({ length: 9 - participating }, () => v('stopped')),
      ],
      faultTolerance: nine,
      observer: obs(9, 9),
    });

    const nineUp = at(9);
    assert.equal(nineUp.threshold, 7, 'threshold = validatorCount - maxOfflineValidators = 9 - 2');
    assert.equal(nineUp.tier, 'normal');
    assert.equal(nineUp.healthPercent, 100);
    assert.equal(nineUp.validatorMargin, 2);

    const eightUp = at(8);
    assert.equal(eightUp.tier, 'normal', '余量 2-1=1，仍有冗余');
    assert.equal(eightUp.healthPercent, 89, 'round(8/9*100)');
    assert.equal(eightUp.validatorMargin, 1);

    const sevenUp = at(7);
    assert.equal(sevenUp.tier, 'zero-margin', '7 = threshold，余量 0 —— 这里的零余量是 78%，不是 80%');
    assert.equal(sevenUp.healthPercent, 78);
    assert.equal(sevenUp.validatorMargin, 0);

    const sixUp = at(6);
    assert.equal(sixUp.tier, 'stopped', '6 < threshold 7 —— 这里的停摆是 67%，不是 60%');
    assert.equal(sixUp.healthPercent, 67);
  });

  test('高度完全不参与档位判定 —— 本链无交易不出块（FR-015）', () => {
    // 两次"快照"的行完全相同（高度字段也相同），档位与百分比必须逐字节一致。
    // 更关键的是：deriveTier 的输入里**没有**高度这个概念 —— 加了高度字段也不该改变结果。
    const build = () => [v('healthy'), v('healthy'), v('healthy'), v('healthy'), v('healthy')];
    const a = deriveTier({ rows: build(), faultTolerance: LAN(), observer: obs(7) });
    const withHeights = build().map((r) => ({ ...r, height: 748, behindBlocks: 0 }));
    const b = deriveTier({ rows: withHeights, faultTolerance: LAN(), observer: obs(7) });
    assert.deepEqual(
      { tier: b.tier, healthPercent: b.healthPercent, validatorMargin: b.validatorMargin },
      { tier: a.tier, healthPercent: a.healthPercent, validatorMargin: a.validatorMargin },
    );
  });
});

describe('判定层确实是纯函数', () => {
  test('deriveTier 不修改入参', () => {
    const rows = [v('healthy'), v('stopped')];
    const snapshot = JSON.stringify(rows);
    const faultTolerance = LAN();
    const ftSnapshot = JSON.stringify(faultTolerance);
    deriveTier({ rows, faultTolerance, observer: obs(6) });
    assert.equal(JSON.stringify(rows), snapshot, 'rows 不得被改写');
    assert.equal(JSON.stringify(faultTolerance), ftSnapshot, 'faultTolerance 不得被改写');
  });

  test('同一输入两次调用结果相同（不看时钟、不发请求）', () => {
    const args = { rows: [v('healthy'), v('catching-up')], faultTolerance: LAN(), observer: obs(7) };
    assert.deepEqual(deriveTier(args), deriveTier(args));
  });
});
