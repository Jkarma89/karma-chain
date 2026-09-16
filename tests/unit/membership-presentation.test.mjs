// 成员数变了之后，呈现侧的判据**跟着动且仍然正确**（功能 005 / T048、FR-024/026/027）。
//
// ## 为什么这三条要单独成文件，而不是塞进 dashboard-tier
//
// `dashboard-tier.test.mjs` 是 003 真值表的机械转录 —— 它问的是"给定一组观测，
// 落哪个档"。本文件问的是另一件事：**n 本身变动时，那些数字还对不对**。
// 003 与 004 的判据全是在 n=5 上写的，而 005 让 n 第一次真的会变。
//
// 三条对应 tasks.md 的 T048：
//
//   ① 门槛与两个余量对 n=4…12 正确 —— 与 fault-tolerance-range 那张表同源，
//      但那个文件只管 `maxOfflineValidators`，**门槛与两个余量是这里才覆盖的**
//   ② 引导中的节点不计入参与共识 —— 扩容与缩容时都成立（FR-026）
//   ③ 健康百分比**不因名册变长而虚高**（FR-027）
//
// ③ 是本特性最容易出错的那一个方向。分母若取"观测到的行数"，
// 名册长一行而那一行还没起来，缺失就被悄悄算成了在线 —— 结论会比现实更乐观。
// 这不是假设：2026-09-15 的假警报正是同一个分母问题的**反向**版本
// （按声明的 6 算，把一条正在出块的链报成"已停止"，见 scopeToChainMembers 的注释）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { participatesInConsensus, deriveTier } from '../../tools/dashboard/snapshot.mjs';
import { maxOffline } from '../../tools/membership/tolerance.mjs';

let seq = 0;
const NOT_OFFLINE = new Set(['healthy', 'catching-up', 'bootstrapping', 'starting']);

/** 一个 L1 验证者的观测行（与 dashboard-tier 同一造法）。 */
const v = (state = 'healthy', offline) => ({
  id: `l1-${(seq += 1)}`,
  role: 'l1-validator',
  state,
  countsTowardTolerance: true,
  countsAsOffline: offline ?? !NOT_OFFLINE.has(state),
});

/** 每边界一个验证者的容错视图 —— 跨机形态的真实形状（T-5 保证每边界 ≤ ⌊n/4⌋）。 */
const ftFor = (n) => ({
  validatorCount: n,
  maxOfflineValidators: maxOffline(n),
  domainCount: n,
  maxValidatorsPerDomain: maxOffline(n),
  declaredWithinLimit: true,
  effectiveDomainCount: n,
  effectiveDomains: Array.from({ length: n }, (_, i) => ({ ids: [`d${i}`], factors: [], validators: 1 })),
  tolerateWholeDomainLoss: true,
});

const obs = (n) => ({ reachableNodes: n, totalNodes: n, blind: false, pathAlive: [] });

/** P 链侧说这 n 个都注册了、权重相等 —— 本文件不测收敛逻辑，那在 dashboard-member-scope。 */
const chainMembers = (rows) => ({
  source: 'p-chain',
  registeredNodeIds: rows.map((r) => r.id),
  equalWeights: true,
});

/** 造 n 行，前 `down` 行整域缺席。 */
function rowsOf(n, { down = 0, bootstrapping = 0 } = {}) {
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    if (i < down) rows.push(v('unreachable', true));
    else if (i < down + bootstrapping) rows.push(v('bootstrapping'));
    else rows.push(v('healthy'));
  }
  return rows;
}

const tierOf = (rows, n = rows.length) => deriveTier({
  rows,
  faultTolerance: ftFor(n),
  observer: obs(rows.length),
  memberSet: chainMembers(rows),
});

// ── ① 门槛与两个余量，对整个区间 ────────────────────────────────────────────
describe('① 门槛与两个余量对 n=4…12 正确（FR-024）', () => {
  for (let n = 4; n <= 12; n += 1) {
    const f = maxOffline(n);

    test(`n=${n}：满员时 threshold = n − ⌊n/4⌋ = ${n - f}，两个余量都是 ${f}`, () => {
      const s = tierOf(rowsOf(n));
      assert.equal(s.threshold, n - f,
        `门槛必须是 n − f。写死成 4（n=5 时代的结果）会在 n 一变就错`);
      assert.equal(s.participating, n, '满员时参与数就是 n');
      assert.equal(s.validatorMargin, f, `还可容忍 ${f} 个离线`);
      assert.equal(s.domainMargin, f, '每边界一个验证者时，边界级余量与验证者级相同');
      assert.equal(s.healthPercent, 100);
      assert.equal(s.tier, 'normal');
    });

    test(`n=${n}：掉满 ${f} 个后余量为 0，且仍判为在出块`, () => {
      const s = tierOf(rowsOf(n, { down: f }));
      assert.equal(s.validatorMargin, 0, '余量必须用尽');
      assert.equal(s.participating, s.threshold, '参与数恰好等于门槛 —— 这是 zero-margin 的定义');
      assert.equal(s.tier, 'zero-margin',
        '掉到上限仍在容错内，不得判成已停止 —— 那是把正确行为报成事故');
    });

    test(`n=${n}：掉 ${f + 1} 个（越界一格）判为已停止`, () => {
      const s = tierOf(rowsOf(n, { down: f + 1 }));
      assert.ok(s.participating < s.threshold, '越界后参与数必须低于门槛');
      assert.equal(s.tier, 'stopped',
        `n=${n} 掉 ${f + 1} 个已越界（(n−f−1)/n < 75%），必须报已停止`);
    });
  }

  test('**反向断言**：门槛不是常数（否则上面 27 条里的一多半是巧合）', () => {
    const ts = [];
    for (let n = 4; n <= 12; n += 1) ts.push(tierOf(rowsOf(n)).threshold);
    assert.ok(new Set(ts).size > 1,
      `n=4…12 的门槛全都是 ${ts[0]} —— 那说明它没有随 n 变，`
      + '上面那些"= n − ⌊n/4⌋"的断言只是在一个常数上恰好成立');
  });
});

// ── ② 引导中不计入参与共识 ──────────────────────────────────────────────────
describe('② 引导中的节点不计入参与共识（FR-026）', () => {
  test('谓词本身：bootstrapping 不参与，healthy / catching-up 参与', () => {
    assert.equal(participatesInConsensus(v('bootstrapping')), false,
      '引导中的节点还没在服务这条链 —— 计入它就是给假绿灯');
    assert.equal(participatesInConsensus(v('healthy')), true);
    assert.equal(participatesInConsensus(v('catching-up')), true,
      '已引导、在服务 L1，只是落后一个传播尾巴（003 / FR-011）');
  });

  test('**扩容中**：名册 6、第六个还在引导 → 参与 5，不是 6', () => {
    const rows = rowsOf(6, { bootstrapping: 1 });
    const s = tierOf(rows, 6);
    assert.equal(s.participating, 5, '引导中的那一个不得计入');
    assert.equal(s.threshold, 6 - maxOffline(6));
    assert.equal(s.validatorMargin, 0, '它相当于一个缺席成员，余量被它吃掉');
  });

  test('**缩容中**：名册 8、两个在引导 → 参与 6，与掉两个等价', () => {
    const boot = tierOf(rowsOf(8, { bootstrapping: 2 }), 8);
    const down = tierOf(rowsOf(8, { down: 2 }), 8);
    assert.equal(boot.participating, 6);
    assert.equal(boot.participating, down.participating,
      '对"链还能掉几个"而言，引导中与整域缺席是同一件事 —— 两者都没在服务这条链');
    assert.equal(boot.validatorMargin, down.validatorMargin);
  });
});

// ── ③ 健康百分比不因名册变长而虚高 ─────────────────────────────────────────
describe('③ 健康百分比不因名册变长而虚高（FR-027）', () => {
  test('n=5 满员 100% → 加第六个且它还没起来 → **必须低于** 100%', () => {
    const five = tierOf(rowsOf(5));
    assert.equal(five.healthPercent, 100);

    const six = tierOf(rowsOf(6, { bootstrapping: 1 }), 6);
    assert.ok(six.healthPercent < five.healthPercent,
      `名册从 5 长到 6、新的那个还在引导，健康度却是 ${six.healthPercent}% —— `
      + '不得不降。分母若取观测到的行数，缺失会被悄悄算成在线，结论比现实更乐观');
    assert.equal(six.healthPercent, Math.round((5 / 6) * 100));
  });

  test('分母是声明的 n，不是观测到的行数 —— 少一行不得让结论变好', () => {
    // 名册 6，但只观测到 5 行（第六台机器连不上、连行都没有）
    const s = deriveTier({
      rows: rowsOf(5),
      faultTolerance: ftFor(6),
      observer: obs(5),
      memberSet: { source: 'p-chain', registeredNodeIds: null, equalWeights: true },
    });
    assert.ok(s.healthPercent < 100,
      `只看见 5 行而名册是 6，健康度报了 ${s.healthPercent}% —— `
      + '拿观测行数当分母会把"没看见"算成"在线"');
    assert.equal(s.healthPercent, Math.round((5 / 6) * 100));
  });

  test('加一个**已经健康**的成员才允许回到 100%', () => {
    const s = tierOf(rowsOf(6));
    assert.equal(s.healthPercent, 100, '六个都在服务时才是 100%');
  });

  test('百分比涨了**不等于**更抗：n=5→6→7 满员都是 100%，而 f 一直是 1', () => {
    for (const n of [5, 6, 7]) {
      const s = tierOf(rowsOf(n));
      assert.equal(s.healthPercent, 100);
      assert.equal(s.validatorMargin, 1,
        `n=${n} 的余量必须仍是 1 —— 加节点买不到容错提升（F-5），`
        + '呈现上不得让人以为更抗了');
    }
  });
});
