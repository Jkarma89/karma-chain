// 恢复能力按**实际权益分布**判定（功能 005 / T046、FR-023）。
//
// ## 004 留下的那句话就是本文件的由来
//
// `PRIMARIES_REQUIRED_FOR_REJOIN = 2` 的注释里写着：
//
// > 写成 `primaries.length` 看起来更通用，实际会在拓扑变化时**静悄悄给出错误结论**：
// > 3 个 Primary（各 33%）时 80% 门槛仍需 3 个全在；5 个（各 20%）时需要 4 个。
// > 真正的通用化（按权益算）属于"增加 Primary 节点数"那个特性，不在本期 ——
// > 本期把数字写死并把来源写清。
//
// 那个特性就是 005。本文件守三件事：
//
//   ① 按权益算的判定对任意分布正确（等权、不等权、恰好贴门槛）
//   ② **未匹配的权益持有者**不会被算成"在服务" —— 那是唯一会产生假绿灯的方向
//   ③ 写死的那个 2 与声明的 Primary 数**仍然一致** ——
//      不一致时本文件变红，于是"静悄悄"变成"有人知道"
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessRejoinCapability, deriveRecoveryCapability, equalWeightHoldersRequired,
  PRIMARIES_REQUIRED_FOR_REJOIN, PCHAIN_BOOTSTRAP_STAKE_THRESHOLD, TIERS, servesPChain,
} from '../../tools/dashboard/snapshot.mjs';
import { loadProtocol } from '../../tools/protocol/load.mjs';

/** 一个权益持有者的观测行。`serving` 决定它当下在不在服务。 */
const holder = (i, { serving = true, role = 'primary' } = {}) => ({
  id: `${role === 'primary' ? 'primary' : 'l1'}-${i}`,
  role,
  nodeId: `NodeID-stake${i}`,
  state: serving ? 'healthy' : 'stopped',
  countsTowardTolerance: role !== 'primary',
  countsAsOffline: !serving,
});

/** P 链侧的权益分布。`weights` 是每个持有者的质押（AVAX，按序对应 NodeID-stakeN）。 */
const stake = (weights) => ({
  source: 'p-chain',
  validators: weights.map((w, i) => ({ nodeId: `NodeID-stake${i + 1}`, weight: BigInt(w) })),
  totalWeight: weights.reduce((a, b) => a + BigInt(b), 0n),
  readAt: Date.now(),
});

const verdict = (weights, servingFlags, extraRows = []) => assessRejoinCapability({
  rows: [...weights.map((_, i) => holder(i + 1, { serving: servingFlags[i] })), ...extraRows],
  pchainStake: stake(weights),
}).verdict;

describe('等权前提下"需要几个"与 004 注释里的三个数一致', () => {
  // 注释里给了三格：2 个各 50% → 2；3 个各 33% → 3；5 个各 20% → 4。
  // 它们是本函数的**独立对照** —— 那三个数是 004 当时人工推的。
  for (const [n, need] of [[2, 2], [3, 3], [4, 4], [5, 4], [6, 5], [8, 7], [10, 8]]) {
    test(`n=${n} → 需要 ${need} 个`, () => {
      assert.equal(equalWeightHoldersRequired(n), need,
        `⌈${PCHAIN_BOOTSTRAP_STAKE_THRESHOLD} × ${n}⌉ 应当是 ${need}`);
    });
  }

  test('n=4 时需要 4 个 —— 0.8×4 = 3.2，取整必须向上', () => {
    assert.equal(equalWeightHoldersRequired(4), 4,
      '向下取整会得到 3，而 3/4 = 75% < 80% —— 那会给出假绿灯');
  });

  test('非法的 n 返回 0，不抛', () => {
    for (const bad of [0, -1, 1.5, NaN, undefined]) {
      assert.equal(equalWeightHoldersRequired(bad), 0, `n=${bad} 应当返回 0`);
    }
  });
});

describe('按权益判定：等权', () => {
  test('2 个各 50%，两个都在 → ok', () => {
    assert.equal(verdict([1000000, 1000000], [true, true]), 'ok');
  });

  test('2 个各 50%，掉一个 → blocked（这是 004 的 V-08 实测）', () => {
    assert.equal(verdict([1000000, 1000000], [true, false]), 'blocked',
      '50% < 80% —— 只起回一个之后被重启的验证者仍然卡死');
  });

  test('8 个各 12.5%，掉一个 → ok（87.5%）', () => {
    const w = Array(8).fill(1000000);
    assert.equal(verdict(w, [false, ...Array(7).fill(true)]), 'ok');
  });

  test('8 个各 12.5%，掉两个 → blocked（75%）', () => {
    const w = Array(8).fill(1000000);
    assert.equal(verdict(w, [false, false, ...Array(6).fill(true)]), 'blocked',
      '75% < 80% —— 两条候选路径都到不了容忍 2 台（005 research R-07a）');
  });
});

describe('按权益判定：**不等权**时"需要几个"这个问法本身就是错的', () => {
  // 这一组是本次改造最实在的收益：数个数答不了这些。
  test('2×1,000,000 + 6×2000（F-7 按最小质押）掉一个 Primary → 仍然 blocked', () => {
    const w = [1000000, 1000000, ...Array(6).fill(2000)];
    const serving = [true, false, ...Array(6).fill(true)];
    assert.equal(verdict(w, serving), 'blocked',
      '加 6 个最小质押的验证者买到零提升（50% → 50.29%）—— '
      + '而"在服务的持有者有 7 个"这个数会让人以为很安全');
  });

  test('同一分布下掉一个**小**持有者 → ok', () => {
    const w = [1000000, 1000000, ...Array(6).fill(2000)];
    const serving = [true, true, false, ...Array(5).fill(true)];
    assert.equal(verdict(w, serving), 'ok',
      '掉 0.09% 无关紧要 —— 结论取决于**是哪个**，不是几个');
  });

  test('掉的是哪个决定结论 —— 同样"掉一个"，两个答案', () => {
    const w = [1000000, 1000000, ...Array(6).fill(2000)];
    const big = verdict(w, [true, false, ...Array(6).fill(true)]);
    const small = verdict(w, [true, true, false, ...Array(5).fill(true)]);
    assert.notEqual(big, small,
      '若两者相同，说明判定没有真的看权益 —— 那本文件就白写了');
  });
});

describe('恰好贴门槛那一格：用整数比，不让浮点决定', () => {
  test('恰好 80% → ok（≥ 而非 >）', () => {
    // 5 个各 20%，掉一个 → 80%
    const w = Array(5).fill(1000000);
    const a = assessRejoinCapability({
      rows: w.map((_, i) => holder(i + 1, { serving: i !== 0 })),
      pchainStake: stake(w),
    });
    assert.equal(a.percent, 80);
    assert.equal(a.verdict, 'ok',
      'V-08 的实测结论是"要求连上 ≥ 80%"，所以恰好等于门槛判 ok。'
      + '（research R-07a 另记了一条运维建议：**不要**把拓扑设计在这一格上，'
      + '因为 avalanchego 实现取 > 还是 >= 我们没有直接证据。）');
  });

  test('差一点点 → blocked', () => {
    // 总 1,000,000；连上 799,999 → 79.9999%
    const a = assessRejoinCapability({
      rows: [holder(1, { serving: true }), holder(2, { serving: false })],
      pchainStake: stake([799999, 200001]),
    });
    assert.equal(a.verdict, 'blocked', '79.9999% 不得判成 ok');
  });
});

describe('**未匹配的权益持有者**：唯一会产生假绿灯的方向', () => {
  // P 链上有、声明里没有 → 没有观测行 → 探测不到它在不在服务。
  const withUnmatched = (weights, servingFlags, matchedCount) => assessRejoinCapability({
    rows: weights.slice(0, matchedCount).map((_, i) => holder(i + 1, { serving: servingFlags[i] })),
    pchainStake: stake(weights),
  });

  test('未匹配的权益足以改变结论 → unknown，并说清原因', () => {
    // 两个各 50%：一个在服务、另一个在 P 链上但不在声明里
    const a = withUnmatched([1000000, 1000000], [true], 1);
    assert.equal(a.verdict, 'unknown',
      '算作在服务则 100%（ok）、算作不在则 50%（blocked）—— 两者不一致，不得下结论');
    assert.match(a.reason, /不在声明里/);
    assert.equal(a.unmatched.length, 1);
  });

  test('未匹配的权益**不足以**改变结论 → 照常下结论，不白白 unknown', () => {
    // 一个 99.9%在服务 + 一个 0.1% 未匹配：两种算法都 ≥80%
    const a = withUnmatched([999000, 1000], [true], 1);
    assert.equal(a.verdict, 'ok',
      '未匹配的那点权益无论算哪边都不改变结论 —— '
      + '此时给 unknown 就是一条恒亮的告警，而恒亮等于没有');
  });

  test('即使算上未匹配的也仍然不够 → blocked，不是 unknown', () => {
    // 1 号匹配且在服务（10%）、2 号未匹配（5%）、3 号匹配但**不在服务**（85%）。
    // 乐观算法 10% + 5% = 15% 仍 < 80% → 两种算法一致，可以下结论。
    const a = assessRejoinCapability({
      rows: [holder(1, { serving: true }), holder(3, { serving: false })],
      pchainStake: {
        source: 'p-chain',
        validators: [
          { nodeId: 'NodeID-stake1', weight: 100000n },
          { nodeId: 'NodeID-stake2', weight: 50000n },
          { nodeId: 'NodeID-stake3', weight: 850000n },
        ],
        totalWeight: 1000000n,
      },
    });
    assert.equal(a.verdict, 'blocked', '10% + 5%（未匹配）仍远低于 80%');
    assert.equal(a.unmatched.length, 1, '未匹配的只有 2 号 —— 3 号有行，只是没在服务');
  });

  test('**绝不把未匹配的算成在服务** —— 用一条直接断言钉住', () => {
    const a = withUnmatched([1000000, 1000000], [true], 1);
    assert.equal(a.connectedWeight, 1000000n,
      'connectedWeight 只能含**观测到在服务**的那部分。'
      + '把未匹配的加进去会给出假绿灯，而假绿灯的代价是有人重启了一个再也回不来的验证者');
  });
});

describe('读不到权益分布时**说不知道**，不假设一个分布', () => {
  test("source 非 p-chain → unknown，并带上原因", () => {
    const a = assessRejoinCapability({
      rows: [holder(1), holder(2)],
      pchainStake: { source: 'unknown', error: 'P 链不应答' },
    });
    assert.equal(a.verdict, 'unknown');
    assert.match(a.reason, /P 链不应答/, '原因要带上读取失败的那句话');
    assert.equal(a.percent, null, '读不到就没有百分比 —— 不得给 0，那会被读成"连上了 0%"');
  });

  test('完全不传 → 同样 unknown，不抛', () => {
    assert.equal(assessRejoinCapability({ rows: [] }).verdict, 'unknown');
  });
});

describe('deriveRecoveryCapability：有权益分布就用它，没有就回落到 004 的行为', () => {
  const rows = [holder(1, { serving: true }), holder(2, { serving: false })];

  test('有分布 → 按权益（两个各 50%、掉一个 → blocked）', () => {
    assert.equal(
      deriveRecoveryCapability({ rows, tier: TIERS.NORMAL, pchainStake: stake([1000000, 1000000]) }),
      'blocked',
    );
  });

  test('无分布 → 回落到数个数，与 004 逐字同行为', () => {
    assert.equal(deriveRecoveryCapability({ rows, tier: TIERS.NORMAL }), 'blocked',
      `在服务的 Primary 1 个 < ${PRIMARIES_REQUIRED_FOR_REJOIN}`);
    assert.equal(
      deriveRecoveryCapability({
        rows: [holder(1, { serving: true }), holder(2, { serving: true })], tier: TIERS.NORMAL,
      }),
      'ok',
    );
  });

  test('观察者失明时**先**返回 unknown —— 权益分布不得改变这一条（FR-019）', () => {
    assert.equal(
      deriveRecoveryCapability({
        rows: [holder(1, { serving: true }), holder(2, { serving: true })],
        tier: TIERS.OBSERVER_BLIND,
        pchainStake: stake([1000000, 1000000]),
      }),
      'unknown',
      '这一刻面板知道得最少 —— 一个在本机网线松了时仍然断言"别重启"的面板，'
      + '会把一次局部链路故障变成一次不必要的停手',
    );
  });
});

describe('servesPChain 接受权益持有者集合 —— 那个 role 代理有到期日', () => {
  // 今天 role === 'primary' 与"是 Primary 网络验证者"等价，因为 6 个 L1 验证者
  // 都带 partial-sync-primary-network，而 avalanchego 的错误常量
  // `partial sync should not be configured for a validator` 保证带它的节点
  // 不可能是 Primary 验证者（005 research R-07a③）。T045 去掉那个 flag 之后，
  // 这个代理就静悄悄地错 —— 所以判定要能按权益集合来。
  const l1 = holder(9, { role: 'l1-validator', serving: true });

  test('不给集合时，L1 验证者返回 null（沿用 004 的 role 代理）', () => {
    assert.equal(servesPChain(l1), null,
      '返回 null 而不是 false —— false 会让一次使用错误伪装成一个正常结论');
  });

  test('给了集合且它在其中 → 按状态判，返回 true', () => {
    assert.equal(servesPChain(l1, { stakeHolders: new Set([l1.nodeId]) }), true,
      'T045 之后 L1 验证者也会是权益持有者，那时它的权益必须算进来');
  });

  test('给了集合而它不在其中 → null（连 Primary 也一样）', () => {
    const p = holder(1, { serving: true });
    assert.equal(servesPChain(p, { stakeHolders: new Set(['NodeID-somebody-else']) }), null,
      '实测的权益分布优先于声明的 role —— 一个不在 P 链验证者集合里的 Primary '
      + '对"能不能引导"毫无贡献');
  });
});

describe('**写死的那个 2 仍与声明一致** —— 不一致时本条变红', () => {
  // 这一条是 004 那句"会在拓扑变化时静悄悄给出错误结论"的解药：
  // 它把"静悄悄"变成"有人知道"。
  //
  // ## 变红检查做了两次，第一次没打中
  //
  // 第一次只把 `primaryNetwork.nodeCount` 改成 3 —— 本条确实红了，但红的理由是
  // `loadProtocol` 更早的那条约束：`topology has 2 primary nodes but
  // primaryNetwork.nodeCount is 3`。**红得对，但不是这条断言。**
  //
  // 第二次补上 `topology.nodes` 里的 primary-3 与各形态的边界归属，构造一份
  // **自洽**的三 Primary 声明，本条才用自己的话红：
  // 「声明了 3 个 Primary，等权下 80% 门槛需要 3 个，而回落常量仍是 2」。
  //
  // 顺带说明一件好事：那个"静悄悄"的场景**被两层挡着** ——
  // 光改个数会先被声明自洽性拦下，真的加了节点才轮到本条。
  test(`PRIMARIES_REQUIRED_FOR_REJOIN = ${PRIMARIES_REQUIRED_FOR_REJOIN} 与声明的 Primary 数对得上`, () => {
    const n = loadProtocol().primaryNetwork.nodeCount;
    assert.equal(PRIMARIES_REQUIRED_FOR_REJOIN, equalWeightHoldersRequired(n),
      `声明了 ${n} 个 Primary，等权下 80% 门槛需要 ${equalWeightHoldersRequired(n)} 个，\n`
      + `  而回落常量仍是 ${PRIMARIES_REQUIRED_FOR_REJOIN}。\n`
      + '  这个常量只在**当前形态**下正确，它是读不到 P 链权益时的回落值。\n'
      + '  改了 Primary 数就要一起改它（以及 docs/devnet.md §9.5 那张表与面板文案，\n'
      + '  recovery-copy / recovery-docs-parity 两条守卫钉着它们）。\n'
      + '  或者：若权益已不等权，那个常量就不该再存在 —— 那时把回落改成 unknown。');
  });

  test('**反向断言**：这条比较真的会在 Primary 数变化时变红', () => {
    const n = loadProtocol().primaryNetwork.nodeCount;
    assert.notEqual(equalWeightHoldersRequired(n + 1), PRIMARIES_REQUIRED_FOR_REJOIN,
      `加一个 Primary 后需要 ${equalWeightHoldersRequired(n + 1)} 个 —— `
      + '若它仍等于那个常量，上一条就成了恒真');
  });
});
