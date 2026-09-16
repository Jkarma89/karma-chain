// 第二个事实来源：P 链（功能 005 / T070 / research V-28）。
//
// ## 为什么必须有两侧
//
// 合约侧是「PoA owner 注册了谁」，P 链侧是「谁真的在共识里带权重」。
// **两者可以合法地不一致** —— ACP-77 第三步做完、第四步没做完时就是那个状态，
// 而那恰恰是最需要看清的中间态。
//
// 2026-09-16 在真链上出现过：合约说 5 个、P 链说 6 个（l1-6 的第三步做完、
// 第四步还没做）。当时容错口径只认合约那一侧，方向是**偏乐观**的 ——
// 真掉两个节点时，面板会说"还在容错内"，而共识按 P 链的 6 个算已经停了。
//
// ## 最要紧的一条守卫是「不要造出恒为真的告警」
//
// 两侧的 validationID 编码不同（P 链 CB58 / 合约 hex，同一个值两种表示）。
// 不归一化就比，**每个成员都会报一处 validationID 不一致** ——
// 一条永远亮着的告警，等于没有告警。`同一个值的两种编码不算分歧` 那条守的是这个。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from '../../tools/protocol/load.mjs';
import {
  normalizeValidationId, classifyPChainDrift, readPChainMembers, SPLIT,
} from '../../tools/membership/member-set.mjs';
import { cb58Encode } from '../../tools/verify/lib/identity.mjs';

/** 造一个 32 字节的 validationID，并给出它的两种表示。构造而非写死。 */
const idPair = (seed) => {
  const bytes = createHash('sha256').update(seed).digest();
  return { hex: `0x${bytes.toString('hex')}`, cb58: cb58Encode(bytes) };
};

const A = idPair('validation-a');
const B = idPair('validation-b');

const member = (nodeId, { weight = 100n, validationID = null, balance = null } = {}) => ({
  nodeId, weight, validationID, balance,
});

describe('normalizeValidationId：同一个值的两种编码归一', () => {
  test('CB58 → hex', () => {
    assert.equal(normalizeValidationId(A.cb58), A.hex);
  });

  test('hex 原样通过（大小写归一）', () => {
    assert.equal(normalizeValidationId(A.hex), A.hex);
    assert.equal(normalizeValidationId(A.hex.toUpperCase().replace('0X', '0x')), A.hex);
  });

  test('两种表示归一后相等 —— 这是不造假告警的前提', () => {
    assert.equal(normalizeValidationId(A.cb58), normalizeValidationId(A.hex));
  });

  test('不同的值不会被归一成同一个', () => {
    assert.notEqual(normalizeValidationId(A.cb58), normalizeValidationId(B.hex));
  });

  test('null / undefined 原样返回 null（有的成员认不出 validationID）', () => {
    assert.equal(normalizeValidationId(null), null);
    assert.equal(normalizeValidationId(undefined), null);
  });

  test('**解码后不是 32 字节 → 抛**', () => {
    const short = cb58Encode(Buffer.alloc(20, 7));
    assert.throws(() => normalizeValidationId(short), /32 字节/,
      '长度不对却放过去，比较时会和真值对不上 —— 报出来是"两侧不一致"，'
      + '而真实原因是解码出的东西根本不是 validationID');
  });
});

describe('classifyPChainDrift：两侧一致时不报任何东西', () => {
  test('同一批成员、权重相同 → ok', () => {
    const contract = [member('NodeID-a', { validationID: A.hex }), member('NodeID-b', { validationID: B.hex })];
    const pchain = [member('NodeID-a', { validationID: A.cb58 }), member('NodeID-b', { validationID: B.cb58 })];
    const r = classifyPChainDrift({ contractMembers: contract, pchainMembers: pchain });
    assert.equal(r.ok, true, `两侧一致却报了分歧：${JSON.stringify(r.splits)}`);
    assert.equal(r.contractCount, 2);
    assert.equal(r.pchainCount, 2);
  });

  test('**同一个值的两种编码不算分歧**（否则就是恒为真的告警）', () => {
    const r = classifyPChainDrift({
      contractMembers: [member('NodeID-a', { validationID: A.hex })],
      pchainMembers: [member('NodeID-a', { validationID: A.cb58 })],
    });
    assert.deepEqual(r.splits, [],
      'P 链的 CB58 与合约的 hex 被当成了不同的值 —— 那会让**每个**成员都报一处 '
      + 'validationID 不一致，而一条永远亮着的告警等于没有告警');
  });

  test('两侧都空 → ok（不是"有问题"）', () => {
    const r = classifyPChainDrift({ contractMembers: [], pchainMembers: [] });
    assert.equal(r.ok, true);
    assert.deepEqual(r.stoppedAtStepFour, []);
  });

  test('没有 nodeId 的成员被跳过，不当成分歧', () => {
    // 合约侧可能有 nodeID 未知的成员（Completed 没配对 Initiated）。
    // 拿 null 去比会把它算成"P 链缺一个"，而真实情况是"我们认不出它是谁"。
    const r = classifyPChainDrift({
      contractMembers: [member(null), member('NodeID-a')],
      pchainMembers: [member('NodeID-a')],
    });
    assert.equal(r.ok, true, `nodeID 未知的成员被当成了分歧：${JSON.stringify(r.splits)}`);
    assert.equal(r.contractCount, 1, '认不出的成员不该进计数');
  });
});

describe('classifyPChainDrift：真链上出现过的那个中间态', () => {
  // 2026-09-16：合约 5 个、P 链 6 个，差的那个是 l1-6（第三步做完、第四步没做）
  const five = ['a', 'b', 'c', 'd', 'e'].map((x) => member(`NodeID-${x}`));
  const r = () => classifyPChainDrift({
    contractMembers: five,
    pchainMembers: [...five, member('NodeID-f', { validationID: A.cb58 })],
  });

  test('P 链多一个 → 报 split-pchain-only', () => {
    const got = r();
    assert.equal(got.splits.length, 1);
    assert.equal(got.splits[0].kind, SPLIT.PCHAIN_ONLY);
    assert.equal(got.splits[0].nodeId, 'NodeID-f');
  });

  test('**stoppedAtStepFour 单独给出来** —— 它有明确处置，不是故障', () => {
    assert.deepEqual(r().stoppedAtStepFour, ['NodeID-f'],
      '"停在第四步"没有被单独标出来。把它和"有人绕过工具加了一个"混在一起，'
      + '就等于让一个已知且有处置的状态长期亮红灯');
  });

  test('报错文本要说清容错该按哪一侧算', () => {
    assert.match(r().splits[0].detail, /容错的分母按 P 链算/,
      '没有说清容错口径 —— 而这正是那次偏乐观判断的成因：'
      + '合约少算一个成员，会把"再掉一个就停摆"报成"还有余量"');
  });

  test('两侧计数都报出来', () => {
    const got = r();
    assert.equal(got.contractCount, 5);
    assert.equal(got.pchainCount, 6);
  });
});

describe('classifyPChainDrift：另一个方向更危险', () => {
  test('合约有、P 链没有 → split-contract-only，且说明它不带权重', () => {
    const r = classifyPChainDrift({
      contractMembers: [member('NodeID-a'), member('NodeID-x')],
      pchainMembers: [member('NodeID-a')],
    });
    const s = r.splits.find((x) => x.nodeId === 'NodeID-x');
    assert.equal(s.kind, SPLIT.CONTRACT_ONLY);
    assert.match(s.detail, /不带权重/,
      '没说清这个方向的后果：合约以为它是成员，而它在共识里不带权重');
    assert.deepEqual(r.stoppedAtStepFour, [],
      '这个方向不是"停在第四步" —— 不该混进那个列表');
  });
});

describe('classifyPChainDrift：属性不同', () => {
  test('权重两侧不同 → split-weight，并点明共识按 P 链算', () => {
    const r = classifyPChainDrift({
      contractMembers: [member('NodeID-a', { weight: 100n })],
      pchainMembers: [member('NodeID-a', { weight: 200n })],
    });
    assert.equal(r.splits.length, 1);
    assert.equal(r.splits[0].kind, SPLIT.WEIGHT);
    assert.match(r.splits[0].detail, /共识按 P 链的算/);
    assert.match(r.splits[0].detail, /等权/, '没提等权前提 —— ⌊n/4⌋ 的推导就是建立在它上面的');
  });

  test('validationID 两侧真的不同 → split-validation-id', () => {
    const r = classifyPChainDrift({
      contractMembers: [member('NodeID-a', { validationID: A.hex })],
      pchainMembers: [member('NodeID-a', { validationID: B.cb58 })],
    });
    assert.equal(r.splits.length, 1);
    assert.equal(r.splits[0].kind, SPLIT.VALIDATION_ID);
    assert.match(r.splits[0].detail, /注册过两次|重复/,
      '没说清这意味着什么：同一个 nodeID 被注册过两次，'
      + '两侧各记着不同的那一次，后续按 validationID 的操作会打错目标');
  });

  test('一侧的 validationID 未知时不报分歧（认不出 ≠ 不一致）', () => {
    const r = classifyPChainDrift({
      contractMembers: [member('NodeID-a', { validationID: null })],
      pchainMembers: [member('NodeID-a', { validationID: A.cb58 })],
    });
    assert.deepEqual(r.splits, []);
  });
});

describe('readPChainMembers：参数缺一个就抛，不静默返回空集合', () => {
  // 断言**那句刻意的报错**，不能只匹配 /pchain/ —— 去掉检查之后会抛
  // `pchain is not a function`，而那个 TypeError 的文本里也含 "pchain"，
  // 于是宽匹配两种情况都过。第一版就是这样，那条变异没能变红。
  test('没有 pchain 调用器 → 抛，且是那句可操作的报错', async () => {
    await assert.rejects(
      () => readPChainMembers({ subnetId: 'x' }),
      /readPChainMembers 需要一个 pchain/,
      '缺调用器时没有给出可操作的报错 —— 让它走到 TypeError，'
      + '报出来的是"pchain is not a function"，看的人不知道该传什么');
  });

  test('没有 subnetId → 抛，且是那句刻意的报错', async () => {
    await assert.rejects(
      () => readPChainMembers({ pchain: async () => ({}) }),
      /readPChainMembers 需要 subnetId/,
      'subnetId 缺失时若放过去，P 链会按 undefined 查，返回空集合 —— '
      + '而空集合会被比对报成"合约有 6 个、P 链 0 个"，根因完全看不出来');
  });

  test('空集合不当成错误，但也不当成"一致"', async () => {
    // P 链返回空是**可能**的（比如 subnetID 传错）。这里只断言它照实返回，
    // 让上层的比对去把"合约有 6 个、P 链 0 个"报成分歧 —— 那才是有信息量的说法。
    const r = await readPChainMembers({ pchain: async () => ({ validators: [] }), subnetId: 'x' });
    assert.deepEqual(r.members, []);
    assert.equal(r.source, 'p-chain');
  });

  test('权重与余额转成 BigInt（P 链回的是字符串）', async () => {
    const r = await readPChainMembers({
      pchain: async () => ({ validators: [{ nodeID: 'NodeID-a', weight: '100', balance: '99371468', validationID: A.cb58 }] }),
      subnetId: 'x',
    });
    assert.equal(r.members[0].weight, 100n);
    assert.equal(r.members[0].balance, 99371468n);
    assert.equal(r.members[0].validationID, A.hex, 'validationID 没有被归一化成 hex');
  });

  test('没有 balance 字段时给 null，不给 0', async () => {
    const r = await readPChainMembers({
      pchain: async () => ({ validators: [{ nodeID: 'NodeID-a', weight: '100' }] }),
      subnetId: 'x',
    });
    assert.equal(r.members[0].balance, null,
      '缺字段给 0 会让"余额为零"和"不知道余额"长得一样，而前者意味着成员即将被停用');
  });
});

// ## 接线也要守
//
// 上面那些测的是**判定**。但判定对而**没人调用**，第二个事实来源就等于不存在 ——
// 而"不存在"的表现和"两侧一致"完全一样：什么都不报。
// T073 那次就是这个形状：判定测到了、接线没测到，而 bug 在接线上。
//
// 两个调用方都要连真链才能跑，所以这里退到源码层面断言。
describe('接线：两个调用方都真的读了 P 链', () => {
  const read = (p) => readFileSync(resolve(REPO_ROOT, p), 'utf8');

  for (const [path, who] of [
    ['tools/membership/member-set.mjs', 'membership:status 命令行'],
    ['tools/membership/add-validator.mjs', 'add-validator 的前置检查'],
  ]) {
    test(`${who} 调用 readPChainMembers 与 classifyPChainDrift`, () => {
      const src = read(path);
      assert.match(src, /await readPChainMembers\(\{\s*pchain,\s*subnetId/,
        `${path} 没有读 P 链侧 —— 少了这一侧，「停在第四步」这个中间态完全不可见，`
        + '而它的表现与"两侧一致"一模一样：什么都不报');
      assert.match(src, /classifyPChainDrift\(\{\s*contractMembers:/,
        `${path} 读了 P 链但没有比对`);
    });

    test(`${who} 把 subnetId 传下去（漏了它第二个来源会静默消失）`, () => {
      const src = read(path);
      // 第一版 precheck 的签名里没有 subnetId：函数体引用它抛 ReferenceError，
      // 而那句在 try 里被当成"读不到 P 链"吞掉 —— 前置检查照样报"全部通过"，
      // 而第二个事实来源整个不见了。漏一个参数不该有这种代价。
      if (path.endsWith('add-validator.mjs')) {
        assert.match(src, /export async function precheck\(\{[^}]*\bsubnetId\b/,
          'precheck 的签名里没有 subnetId');
        assert.match(src, /precheck 需要 subnetId/,
          'precheck 没有在缺 subnetId 时抛错 —— 那会让它静默退化成只有一个来源');
        assert.match(src, /precheck\(\{[^}]*subnetId: identity\.subnetId/,
          '命令行调用 precheck 时没有把 subnetId 传下去');
      }
    });

    test(`${who} 读不到 P 链时**说读不到**，不静默跳过`, () => {
      const src = read(path);
      assert.match(src, /读不到 P 链侧/,
        `${path} 在 P 链读取失败时没有明确报出 —— 静默跳过会让"没看"`
        + '长得像"没问题"，而这一步的全部价值就在于看见那个中间态');
    });
  }
});
