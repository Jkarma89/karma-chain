// T019 —— 恢复能力的判据（功能 004，范围 B）。
//
// 本文件是 `specs/004-rpc-entry-recovery-visibility/data-model.md` 第 1 节的
// `servesPChain` 真值表（10 行）与 `contracts/recovery-capability.md` 第 2/3 节的
// **机械转录**，不是事后补的测试。
//
// ## 这个维度回答的问题
//
// > 这张网现在还能不能让一个**已停的验证者重新加入**？
//
// 它与三档健康度（"链能不能出块"）**正交**。两者可以任意组合，
// 而最要紧的那个组合是「**正常出块 + 无法恢复**」——
// 因为它看起来完全健康。
//
// ## 判据为什么是 `< 2` 而不是 `= 0`
//
// 2026-09-10 实测：两个 Primary 全停时重启 l1-1，它 5 分钟内 P 链引导毫无进展，
// L1 那条链在该节点上根本没被创建。起回**一个** Primary 之后**仍然**卡着 ——
// 它自报 `percentConnected: 0.5` / `"not connected to enough stake: connected to
// 50.000000%; required at least 80.000000%"`。
//
// 两个 Primary **各握 P 链 50% 权益**，而门槛是 80% —— 所以两个都得在。
// **从"两个都停了"这个现场，最自然的归纳是 `= 0`，而那是错的。**
// 本文件第「只有一个在服务」那一格就是专门守这件事的（变红检查 T030）。
//
// ## 为什么需要第三个谓词
//
// `participatesInConsensus` 的第一行就是 `if (!row.countsTowardTolerance) return false`，
// 而 Primary 的该字段**恒为 false** —— 它对任何 Primary 都返回 false，
// 不管活着还是停着。拿它数"有几个 Primary 在服务"，答案恒为 0，
// 提示会**永远亮着**。一个永远亮着的提示和一个永远不亮的提示一样没用。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  servesPChain,
  deriveRecoveryCapability,
  participatesInConsensus,
  PRIMARIES_REQUIRED_FOR_REJOIN,
} from '../../tools/dashboard/snapshot.mjs';

let seq = 0;
const primary = (state, offline) => ({
  id: `primary-${(seq += 1)}`,
  role: 'primary',
  state,
  countsTowardTolerance: false,
  countsAsOffline: offline,
});
const validator = (state = 'healthy') => ({
  id: `l1-${(seq += 1)}`,
  role: 'l1-validator',
  state,
  countsTowardTolerance: true,
  countsAsOffline: false,
});

describe('servesPChain 真值表（data-model 第 1 节，10 行逐行）', () => {
  const ROWS = [
    { n: 1, row: primary('healthy'), want: true, why: '在服务' },
    { n: 2, row: primary('catching-up'), want: true, why: '在追块但在服务（与 SERVING_L1 同理）' },
    { n: 3, row: primary('bootstrapping'), want: false, why: '还没在服务 —— 003 §0 那条教训' },
    { n: 4, row: primary('starting'), want: false, why: '"要等"，不是"在服务"' },
    { n: 5, row: primary('stopped'), want: false, why: '容器已退出' },
    { n: 6, row: primary('stalled'), want: false, why: '进程在但不推进' },
    { n: 7, row: primary('identity-mismatch'), want: false, why: '跑在另一条链上' },
    { n: 8, row: primary('data-corrupt'), want: false, why: '数据损坏' },
    { n: 9, row: primary('unreachable', false), want: true, why: '其余节点看得见它 → 本机链路故障，它活着' },
    { n: 10, row: primary('unreachable', true), want: false, why: '整域缺席 → 它真的不在' },
  ];

  for (const { n, row, want, why } of ROWS) {
    test(`第 ${n} 行：${row.state}${row.countsAsOffline === undefined ? '' : `（countsAsOffline=${row.countsAsOffline}）`} → ${want}`, () => {
      assert.equal(servesPChain(row), want, `${why}。判据见 data-model 第 1 节第 ${n} 行`);
    });
  }

  test('第 9 行是本表唯一会被写错的一格 —— 它的后果最坏', () => {
    // 写错的后果：**一根网线松了，面板就告诉人"现在不能重启任何东西"**，
    // 而实际上那两个 Primary 好得很。002 里 ubuntu-1 的网线故障正是这一类。
    assert.equal(servesPChain(primary('unreachable', false)), true);
    assert.equal(servesPChain(primary('unreachable', true)), false);
  });
});

describe('误用防护：传验证者进来不是"它没在服务"，是**用错了**', () => {
  test('对 l1-validator 返回 null，而不是 false', () => {
    assert.equal(servesPChain(validator('healthy')), null,
      '返回 false 会让一次使用错误伪装成一个正常结论 —— 恢复能力被算错而没有任何东西变红');
    assert.equal(servesPChain(validator('stopped')), null);
  });

  test('对空值不抛异常（轮询路径里不许因为一行脏数据整块崩掉）', () => {
    assert.equal(servesPChain(undefined), null);
    assert.equal(servesPChain(null), null);
    assert.equal(servesPChain({}), null);
  });

  test('participatesInConsensus 对活着的 Primary 也返回 false —— 这正是不能复用它的原因', () => {
    const alive = primary('healthy');
    assert.equal(participatesInConsensus(alive), false,
      '它回答的是"还能再掉几个验证者"，Primary 对 L1 出块零贡献，所以恒 false');
    assert.equal(servesPChain(alive), true,
      '而恢复能力问的是另一件事 —— 两个谓词必须分开，否则提示会永远亮着');
  });
});

describe(`门槛是 ${PRIMARIES_REQUIRED_FOR_REJOIN}（在服务的 Primary < ${PRIMARIES_REQUIRED_FOR_REJOIN} 即 blocked）`, () => {
  const tier = 'normal';

  test('两个都在服务 → ok（不呈现，无噪音）', () => {
    const rows = [primary('healthy'), primary('healthy'), validator(), validator()];
    assert.equal(deriveRecoveryCapability({ rows, tier }), 'ok');
  });

  test('**只有一个在服务 → 仍然 blocked**（把判据写成 = 0 就会漏掉这一格）', () => {
    const rows = [primary('healthy'), primary('stopped'), validator(), validator()];
    assert.equal(deriveRecoveryCapability({ rows, tier }), 'blocked',
      '一个 Primary 只有 50% 的 P 链权益，达不到 80% 门槛 —— 2026-09-10 实测：\n'
      + '  起回 primary-1 之后 l1-1 仍然卡着，自报 percentConnected: 0.5。\n'
      + '  **这一格是 `< 2` 与 `= 0` 唯一的区别所在。**');
  });

  test('两个都不在服务 → blocked', () => {
    const rows = [primary('stopped'), primary('stopped'), validator(), validator()];
    assert.equal(deriveRecoveryCapability({ rows, tier }), 'blocked');
  });

  test('一个在服务、另一个只是本机看不见（对等看得见）→ ok', () => {
    // 这两格合起来才说明"本机链路故障不产生假提示"
    const rows = [primary('healthy'), primary('unreachable', false), validator()];
    assert.equal(deriveRecoveryCapability({ rows, tier }), 'ok',
      '那个 Primary 是活的，断的是本机到它的路径（FR-018）—— 不该因此叫人别重启');
  });

  test('一个在服务、另一个整域缺席 → blocked', () => {
    const rows = [primary('healthy'), primary('unreachable', true), validator()];
    assert.equal(deriveRecoveryCapability({ rows, tier }), 'blocked');
  });

  test('bootstrapping 的 Primary 不算在服务', () => {
    const rows = [primary('healthy'), primary('bootstrapping'), validator()];
    assert.equal(deriveRecoveryCapability({ rows, tier }), 'blocked',
      '引导中的 Primary 还没在提供 P 链服务 —— 把它算进去就是一个假绿灯');
  });

  test('门槛这个数字本身是导出的常量，不是散落的字面量', () => {
    assert.equal(PRIMARIES_REQUIRED_FOR_REJOIN, 2);
    // 它恰好等于当前 Primary 总数，但那是巧合：来源是**权益门槛**。
    // 若哪天 Primary 加到 3 个（各 33%），80% 门槛需要的仍是 3 个全在。
    // 所以判据里**不能**写 primaries.length —— 那会在拓扑变化时静悄悄给出错误结论。
  });
});
