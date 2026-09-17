// 「声明里有、链上没有」有**两种成因，处置相反**（功能 005 / T041 实施期发现、FR-028 / FR-030）。
//
// | 成因 | 处置 |
// |---|---|
// | 流程没走完（加入卡住，或退出只做了一半） | 去**重试**停住的那一步 |
// | **退出已经走完**，只是声明还没清理 | 去**改声明**，别重试任何一步 |
//
// 分不开的后果不是"话说得不准"：2026-09-17 真退掉 l1-2 之后，工具对一次**圆满完成**
// 的退出报的是"重试那一步" —— 照着做是白费功夫，而且会让人以为退出失败了。
//
// 这与 FR-028 是同一条要求的两面：被主动移除的节点不该被呈现成出了问题，
// **它的处置方向也不该指向"去修"**。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { encodeEventTopics, encodeAbiParameters, keccak256, toHex } from 'viem';
import { VALIDATOR_MANAGER_ABI, memberSetFromLogs, classifyDrift, DRIFT } from '../../tools/membership/member-set.mjs';

const nodeBytes = (seed) => `0x${keccak256(toHex(seed)).slice(2, 42)}`;
const vid = (seed) => keccak256(toHex(`validation:${seed}`));

const logOf = (eventName, args, blockNumber = 4n) => {
  const ev = VALIDATOR_MANAGER_ABI.find((x) => x.type === 'event' && x.name === eventName);
  const nonIndexed = ev.inputs.filter((i) => !i.indexed);
  return {
    topics: encodeEventTopics({ abi: VALIDATOR_MANAGER_ABI, eventName, args }),
    data: nonIndexed.length
      ? encodeAbiParameters(nonIndexed, nonIndexed.map((i) => args[i.name]))
      : '0x',
    blockNumber,
  };
};

const SEED = 'gone';

/**
 * 造两种"声明里有、链上没有"的链上事件序列。
 *
 * 注意**只发 `InitiatedValidatorRemoval` 造不出这条漂移** —— 那条事件刻意不改
 * `active`（合约要到 `CompletedValidatorRemoval` 才把成员移出集合），
 * 所以那种状态下成员仍在集合里，两侧一致。第一版夹具就是这么写的，红得对。
 *
 * 两种真实形态：
 *   `completed-removal` 走完整的加入 → 退出
 *   `stuck-join`        只发起了加入，没走完 —— 这才是"流程没走完"的样子
 */
const lifecycle = (mode) => {
  const joinLogs = [
    logOf('InitiatedValidatorRegistration', {
      validationID: vid(SEED), nodeID: nodeBytes(SEED),
      registrationMessageID: keccak256(toHex('m')), registrationExpiry: 0n, weight: 100n,
    }, 10n),
  ];
  if (mode === 'stuck-join') return memberSetFromLogs(joinLogs);
  return memberSetFromLogs([
    ...joinLogs,
    logOf('CompletedValidatorRegistration', { validationID: vid(SEED), weight: 100n }, 11n),
    logOf('InitiatedValidatorRemoval', {
      validationID: vid(SEED), validatorWeightMessageID: keccak256(toHex('w')),
      weight: 0n, endTime: 0n,
    }, 20n),
    logOf('CompletedValidatorRemoval', { validationID: vid(SEED) }, 21n),
  ]);
};

/** 用链上解出来的 nodeId 反过来造声明条目，保证两侧是同一个身份。 */
const declaredFor = (set) => {
  const nodeId = set.history.find((h) => h.nodeId)?.nodeId;
  assert.ok(nodeId, '夹具没解出 nodeId —— 事件构造有问题');
  return [{
    index: 9, httpPort: 1, stakingPort: 2,
    keyDir: 'blockchain/validators/dev/node-9/',
    // 公开材料要一次报齐 —— 那条约束本身是对的（半份身份会渲染出半份制品），
    // 所以夹具照着给全，而不是去放宽它。
    identity: {
      origin: 'joined',
      nodeId,
      blsPublicKey: `0x${'11'.repeat(48)}`,
      proofOfPossession: `0x${'22'.repeat(96)}`,
      certSha256: '33'.repeat(32),
      keySha256: '44'.repeat(32),
      signerSha256: '55'.repeat(32),
    },
  }];
};

describe('退出已走完时，处置指向"改声明"而不是"重试"', () => {
  test('有 CompletedValidatorRemoval → removalCompleted 为 true，且不提"重试"', () => {
    const set = lifecycle('completed-removal');
    const cls = classifyDrift(set.members, declaredFor(set), set.history);
    const d = cls.drifts.find((x) => x.kind === DRIFT.DECLARED_ONLY);
    assert.ok(d, '声明里有、链上没有 —— 这条漂移必须报出来');
    assert.equal(d.removalCompleted, true);
    assert.match(d.detail, /退出已经走完/);
    assert.match(d.detail, /不需要重试任何一步/,
      '这是本条的要点：照"重试那一步"去做是白费功夫，还会让人以为退出失败了');
    assert.match(d.detail, /deployment\.json/, '要指出该去改哪个文件');
    assert.doesNotMatch(d.detail, /加入流程没走完/, '不该再挂着那句猜测');
  });

  test('**反向断言**：没走完时仍然说"重试那一步"', () => {
    // 少了这一条，上面那条可以靠"把两种情形都说成已退完"来满足 —— 那是另一个缺陷，
    // 而且更坏：它会让一次真的卡住的退出被当成已完成。
    const set = lifecycle('stuck-join');
    const cls = classifyDrift(set.members, declaredFor(set), set.history);
    const d = cls.drifts.find((x) => x.kind === DRIFT.DECLARED_ONLY);
    assert.ok(d);
    assert.equal(d.removalCompleted, false);
    assert.match(d.detail, /重试那一步/);
    assert.doesNotMatch(d.detail, /退出已经走完/);
  });

  test('不传 history 时按"未完成"处理 —— 忘了传不会静默说成已退完', () => {
    const set = lifecycle('completed-removal');
    const cls = classifyDrift(set.members, declaredFor(set));   // 少传第三个参数
    const d = cls.drifts.find((x) => x.kind === DRIFT.DECLARED_ONLY);
    assert.equal(d.removalCompleted, false,
      '缺省必须落在**更保守**的那一侧：把"没走完"说成"已完成"会让人不去收拾一个真的中间态');
  });
});

describe('前提：夹具真的造出了那条漂移（防空跑）', () => {
  test('两种情形都产出恰好一条 declared-only 漂移', () => {
    for (const mode of ['completed-removal', 'stuck-join']) {
      const set = lifecycle(mode);
      const cls = classifyDrift(set.members, declaredFor(set), set.history);
      const ds = cls.drifts.filter((x) => x.kind === DRIFT.DECLARED_ONLY);
      assert.equal(ds.length, 1, `${mode} 时应恰好一条`);
    }
  });

  test('退出走完之后，它确实不在 members 里了', () => {
    const set = lifecycle('completed-removal');
    assert.equal(set.members.length, 0, 'CompletedValidatorRemoval 之后集合应当为空');
  });
});
