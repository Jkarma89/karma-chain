// 从事件重建链上成员集合，以及**三种漂移**各自的分类（功能 005 / T024 / FR-030）。
//
// ## 为什么必须离线
//
// 三种漂移里最要紧的一种是**「链上有、声明里没有」** —— 有人绕过工具加了一个。
// 而那种情形在真实环境里恰恰最难造出来：得先绕过工具往链上加一个成员。
// 所以解析与分类做成纯函数，日志用 `encodeEventLog` 合成，全部离线断言。
//
// 对活链的那一半在 tests/integration/member-set-live.test.mjs。
//
// ## 合成日志而不是抄一份真实日志
//
// 用 viem 的 `encodeEventLog` 按**同一份 ABI** 生成 —— 那份 ABI 的每个事件 topic
// 都对着创世字节码核验过（tests/unit/validator-manager-abi.test.mjs）。
// 抄一份真实日志的话，事件签名写错时两边会一起错，而守卫照样全绿。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { encodeEventTopics, encodeAbiParameters, keccak256, toHex, pad } from 'viem';
import {
  memberSetFromLogs, classifyDrift, DRIFT, TOPICS,
  VALIDATOR_MANAGER_ABI, nodeIdFromBytes20,
} from '../../tools/membership/member-set.mjs';
import { cb58Encode } from '../../tools/verify/lib/identity.mjs';

/** 造一个确定的 20 字节 nodeID（派生，不写字面量）。 */
const nodeBytes = (seed) => `0x${keccak256(toHex(seed)).slice(2, 42)}`;
const nodeIdOf = (seed) => `NodeID-${cb58Encode(Buffer.from(nodeBytes(seed).slice(2), 'hex'))}`;
const vid = (seed) => keccak256(toHex(`validation:${seed}`));

/**
 * 合成一条日志。`args` 按 ABI 的字段名给。
 *
 * 本仓库的 viem 版本没有 `encodeEventLog`（只有 decode），所以按 ABI 自己拼：
 * indexed 的进 topics（`encodeEventTopics`），非 indexed 的按顺序编进 data。
 * **仍然走同一份 ABI** —— 事件签名写错时，解析端与合成端会一起错，
 * 而那种一起错的情况由 tests/unit/validator-manager-abi.test.mjs 挡着
 * （它把每个 topic 对着创世字节码核验）。
 */
const logOf = (eventName, args, blockNumber = 4n) => {
  const ev = VALIDATOR_MANAGER_ABI.find((x) => x.type === 'event' && x.name === eventName);
  if (!ev) throw new Error(`ABI 里没有事件 ${eventName}`);
  const nonIndexed = ev.inputs.filter((i) => !i.indexed);
  return {
    topics: encodeEventTopics({ abi: VALIDATOR_MANAGER_ABI, eventName, args }),
    data: nonIndexed.length
      ? encodeAbiParameters(nonIndexed, nonIndexed.map((i) => args[i.name]))
      : '0x',
    blockNumber,
  };
};

const genesisLog = (seed, weight = 100n) => logOf('RegisteredInitialValidator', {
  validationID: vid(seed), nodeID: nodeBytes(seed), weight,
});
const initiatedLog = (seed, weight = 100n) => logOf('InitiatedValidatorRegistration', {
  validationID: vid(seed),
  nodeID: nodeBytes(seed),
  registrationMessageID: keccak256(toHex(`msg:${seed}`)),
  registrationExpiry: 0n,
  weight,
}, 100n);
const completedLog = (seed, weight = 100n) => logOf('CompletedValidatorRegistration', {
  validationID: vid(seed), weight,
}, 101n);
const initiatedRemovalLog = (seed, weight = 100n) => logOf('InitiatedValidatorRemoval', {
  validationID: vid(seed),
  validatorWeightMessageID: keccak256(toHex(`weightmsg:${seed}`)),
  weight,
  endTime: 0n,
}, 150n);
const removedLog = (seed) => logOf('CompletedValidatorRemoval', { validationID: vid(seed) }, 200n);

/** 声明侧的成员（走 identityOf 的「声明身份」那条路，不需要密钥文件）。 */
const declaredOf = (seeds) => seeds.map((seed, i) => ({
  index: i + 1,
  httpPort: 20000 + i * 2,
  stakingPort: 20001 + i * 2,
  keyDir: `blockchain/validators/dev/node-${i + 1}/`,
  identity: {
    origin: 'joined',
    nodeId: nodeIdOf(seed),
    blsPublicKey: `0x${(keccak256(toHex(`bls-a:${seed}`)) + keccak256(toHex(`bls-b:${seed}`))).replace(/0x/g, '').slice(0, 96)}`,
    proofOfPossession: `0x${[1, 2, 3].map((i) => keccak256(toHex(`pop-${i}:${seed}`))).join('').replace(/0x/g, '').slice(0, 192)}`,
    certSha256: keccak256(toHex(`cert:${seed}`)).slice(2),
    keySha256: keccak256(toHex(`key:${seed}`)).slice(2),
    signerSha256: keccak256(toHex(`signer:${seed}`)).slice(2),
    reportedBy: 'fixture',
    reportedAt: '2026-09-14',
  },
}));

const FIVE = ['a', 'b', 'c', 'd', 'e'];

describe('夹具与前提（防空跑）', () => {
  test('合成的日志确实解得出成员', () => {
    const { members } = memberSetFromLogs(FIVE.map((s) => genesisLog(s)));
    assert.equal(members.length, 5, '合成日志解不出五个成员 —— 下面全部断言失去意义');
    assert.equal(members[0].nodeId, nodeIdOf('a'));
  });

  test('nodeID 的 20 字节 ←→ NodeID-<cb58> 往返一致', () => {
    assert.equal(nodeIdFromBytes20(pad(nodeBytes('a'), { dir: 'right', size: 32 })), nodeIdOf('a'));
  });

  test('四个成员事件的 topic 互不相同（否则分支会串）', () => {
    const ts = Object.values(TOPICS);
    assert.equal(new Set(ts).size, ts.length, `topic 有重复：${ts.join(' ')}`);
  });
});

describe('集合重建', () => {
  test('创世事件一出现就是生效成员', () => {
    const { members } = memberSetFromLogs(FIVE.map((s) => genesisLog(s)));
    assert.deepEqual(members.map((m) => m.origin), Array(5).fill('genesis'));
    assert.ok(members.every((m) => m.active));
  });

  test('**只有 Initiated 没有 Completed → 不算成员**', () => {
    // 这条是加入流程的核心性质：注册没走完就不是成员。
    // 若把 Initiated 也算进去，面板会在引导期间就把名册变长 ——
    // 而那恰恰是 V-07 禁止的「名册变长让结论更乐观」。
    const { members } = memberSetFromLogs([...FIVE.map((s) => genesisLog(s)), initiatedLog('f')]);
    assert.equal(members.length, 5, 'Initiated 被当成了生效成员');
    assert.ok(!members.some((m) => m.nodeId === nodeIdOf('f')));
  });

  test('Initiated + Completed → 成为成员，且 origin 是 joined', () => {
    const { members } = memberSetFromLogs([
      ...FIVE.map((s) => genesisLog(s)), initiatedLog('f'), completedLog('f'),
    ]);
    assert.equal(members.length, 6);
    const joined = members.find((m) => m.nodeId === nodeIdOf('f'));
    assert.ok(joined, '走完注册流程的成员不在集合里');
    assert.equal(joined.origin, 'joined');
    assert.equal(joined.active, true);
  });

  test('Completed removal → 从集合里去掉', () => {
    const { members } = memberSetFromLogs([
      ...FIVE.map((s) => genesisLog(s)), initiatedLog('f'), completedLog('f'), removedLog('f'),
    ]);
    assert.equal(members.length, 5);
    assert.ok(!members.some((m) => m.nodeId === nodeIdOf('f')), '退出后仍在集合里');
  });

  test('**退出创世成员也要生效**（不是只对新成员有效）', () => {
    const { members } = memberSetFromLogs([...FIVE.map((s) => genesisLog(s)), removedLog('a')]);
    assert.equal(members.length, 4);
    assert.ok(!members.some((m) => m.nodeId === nodeIdOf('a')));
  });

  test('权重以 Completed 为准（中途可能被改过）', () => {
    const { members } = memberSetFromLogs([initiatedLog('f', 100n), completedLog('f', 250n)]);
    assert.equal(members[0].weight, 250n);
  });

  test('Completed 没有配对的 Initiated → 照实记下 incomplete，不静默丢掉', () => {
    const { members } = memberSetFromLogs([completedLog('f')]);
    assert.equal(members.length, 1);
    assert.equal(members[0].nodeId, null);
    assert.match(members[0].incomplete, /没有配对的 Initiated/);
  });

  test('**不认识的 topic** 要报出来，而 ABI 里认得的非成员事件不算', () => {
    const bogus = { topics: [keccak256(toHex('SomethingNobodyRegistered()'))], data: '0x', blockNumber: 5n };
    const gov = logOf('OwnershipTransferred', {
      previousOwner: '0x0000000000000000000000000000000000000000',
      newOwner: '0x0000000000000000000000000000000000000001',
    }, 3n);
    const r = memberSetFromLogs([...FIVE.map((s) => genesisLog(s)), gov, bogus]);
    assert.equal(r.unknownTopics.length, 1, '不认识的 topic 应当恰好一个');
    assert.deepEqual(r.ignoredTopics.map((x) => x.event), ['OwnershipTransferred']);
    // 这条边界最要紧：**恒定非空的告警等于没有告警**。
    // 第一版把两类混在一起，于是 unknownTopics 永远含治理事件那两条。
    assert.equal(memberSetFromLogs([...FIVE.map((s) => genesisLog(s)), gov]).unknownTopics.length, 0,
      '只有非成员事件时，"不认识的 topic" 必须为空');
  });
});

describe('三种漂移（data-model 第 2 节）', () => {
  const declaredFive = declaredOf(FIVE);
  const onChainFive = memberSetFromLogs(FIVE.map((s) => genesisLog(s))).members;

  test('两边一致 → 无漂移', () => {
    const r = classifyDrift(onChainFive, declaredFive);
    assert.ok(r.ok, `不该有漂移，实际：${JSON.stringify(r.drifts)}`);
    assert.equal(r.onChainCount, 5);
    assert.equal(r.declaredCount, 5);
  });

  test('① 链上有、声明里没有 → member-unexpected', () => {
    const onChain = memberSetFromLogs([...FIVE, 'ghost'].map((s) => genesisLog(s))).members;
    const r = classifyDrift(onChain, declaredFive);
    const d = r.drifts.find((x) => x.kind === DRIFT.ON_CHAIN_ONLY);
    assert.ok(d, `应报出 ${DRIFT.ON_CHAIN_ONLY}，实际：${JSON.stringify(r.drifts)}`);
    assert.equal(d.nodeId, nodeIdOf('ghost'));
    assert.match(d.detail, /绕过工具/, '处置建议要说清这是怎么发生的');
    assert.ok(d.validationID, '要带 validationID —— 退出它需要这个值');
  });

  test('② 声明里有、链上没有 → member-missing', () => {
    const r = classifyDrift(onChainFive, declaredOf([...FIVE, 'f']));
    const d = r.drifts.find((x) => x.kind === DRIFT.DECLARED_ONLY);
    assert.ok(d, `应报出 ${DRIFT.DECLARED_ONLY}`);
    assert.equal(d.nodeId, nodeIdOf('f'));
    assert.match(d.detail, /没走完|一半/, '要指向多步流程的哪一步');
  });

  test('③ 权重不等 → member-attributes，并说明为什么要紧', () => {
    const onChain = memberSetFromLogs([
      genesisLog('a', 100n), genesisLog('b', 100n), genesisLog('c', 100n),
      genesisLog('d', 100n), genesisLog('e', 250n),
    ]).members;
    const r = classifyDrift(onChain, declaredFive);
    const d = r.drifts.find((x) => x.kind === DRIFT.ATTRIBUTES);
    assert.ok(d, '权重不等必须报出来');
    assert.match(d.detail, /等权/,
      '必须说明 ⌊n/4⌋ 的推导以等权为前提 —— 否则读到这条的人不知道它为什么要紧');
  });

  test('两种方向的漂移可以同时报出（不是二选一）', () => {
    const onChain = memberSetFromLogs([...FIVE.slice(1), 'ghost'].map((s) => genesisLog(s))).members;
    const r = classifyDrift(onChain, declaredFive);
    const kinds = new Set(r.drifts.map((d) => d.kind));
    assert.ok(kinds.has(DRIFT.ON_CHAIN_ONLY), 'ghost 应报 unexpected');
    assert.ok(kinds.has(DRIFT.DECLARED_ONLY), '缺掉的 a 应报 missing');
  });

  test('**nodeID 未知的成员不会被当成"声明里没有"**（那会报错方向）', () => {
    // Completed 没配对 Initiated 时 nodeId 是 null。若把它当成一个"链上有的成员"
    // 去比对，会得到一条 member-unexpected（nodeId: null）—— 指向不明、无从处置。
    // 正确的做法是报 attributes 类的 incomplete，让人去查日志起点。
    const onChain = memberSetFromLogs([...FIVE.map((s) => genesisLog(s)), completedLog('f')]).members;
    const r = classifyDrift(onChain, declaredFive);
    assert.ok(!r.drifts.some((d) => d.kind === DRIFT.ON_CHAIN_ONLY && d.nodeId === null),
      'nodeID 未知的成员被报成了 member-unexpected');
    assert.ok(r.drifts.some((d) => d.kind === DRIFT.ATTRIBUTES && /没有配对/.test(d.detail)),
      '应当报成 attributes 类的 incomplete');
  });

  test('漂移条目都带可执行的处置方向（FR-030 要求"可见"，不是"报个数"）', () => {
    const r = classifyDrift(
      memberSetFromLogs([...FIVE.slice(1), 'ghost'].map((s) => genesisLog(s))).members,
      declaredFive,
    );
    for (const d of r.drifts) {
      assert.ok(d.detail && d.detail.length > 20, `漂移 ${d.kind} 的说明太短：${d.detail}`);
      assert.ok(/处置|重试|补进|退出|查/.test(d.detail),
        `漂移 ${d.kind} 没给出该怎么办：${d.detail}`);
    }
  });
});

// ## `InitiatedValidatorRemoval`：不改变集合，但**必须进 history**
//
// 写 T036（退出流程）时才发现这个缺口：这条事件原先被归进
// `NON_MEMBERSHIP_TOPICS`（"ABI 里认得、但不影响成员集合"），于是完全不进 history。
// 而它带着 `validatorWeightMessageID` —— **退出的第二步要拿它去收集签名**。
//
// 后果是退出流程走到第二步时报"事件里没有 validatorWeightMessageID"，
// 而根因在一百多行之外的一个分类名单里。**「不改变集合」不等于「不需要记下来」。**
describe('InitiatedValidatorRemoval —— 不动集合，但记得住', () => {
  const logs = (seed) => [genesisLog(seed), initiatedRemovalLog(seed)];

  test('**成员仍在集合里**（合约侧要到 Completed 才移除）', () => {
    const r = memberSetFromLogs(logs('a'));
    assert.equal(r.members.length, 1, '发起退出就把成员移出集合了 —— '
      + '那会让容错的 n 提前少一个，而它此刻还带着权重');
    assert.equal(r.members[0].nodeId, nodeIdOf('a'));
  });

  test('**history 里有它，且带 validatorWeightMessageID**', () => {
    const r = memberSetFromLogs(logs('a'));
    const h = r.history.find((x) => x.eventName === 'InitiatedValidatorRemoval');
    assert.ok(h, 'history 里找不到 InitiatedValidatorRemoval —— '
      + '退出的第二步就拿不到那条 Warp 消息的 ID，流程卡死在第二步，'
      + '而报出来的是"事件里没有 validatorWeightMessageID"，看不出根因');
    assert.match(h.validatorWeightMessageID, /^0x[0-9a-f]{64}$/,
      'validatorWeightMessageID 没被解出来');
  });

  test('nodeId 从既有条目补上 —— 这条事件本身不带 nodeID', () => {
    const r = memberSetFromLogs(logs('a'));
    const h = r.history.find((x) => x.eventName === 'InitiatedValidatorRemoval');
    assert.equal(h.nodeId, nodeIdOf('a'),
      'nodeId 为空 —— 那样就没法按 nodeID 找出"这个成员退到哪一步了"');
  });

  test('**不出现在 ignoredTopics / unknownTopics 里**（它是被真正解析的）', () => {
    const r = memberSetFromLogs(logs('a'));
    assert.deepEqual(r.unknownTopics, [], '被当成不认识的 topic 了');
    assert.deepEqual(r.ignoredTopics.map((x) => x.event), [],
      '仍被归进"认得但忽略"—— 那正是它进不了 history 的原因');
  });

  test('发起退出之后再 Completed → 集合里才没有它', () => {
    const r = memberSetFromLogs([...logs('a'), removedLog('a')]);
    assert.deepEqual(r.members, [], 'Completed 之后成员还在集合里');
  });
});
