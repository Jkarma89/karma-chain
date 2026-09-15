// 谁签了聚合签名：靠**验签**判定，不靠 bitset 的位序推断（功能 005 / T027）。
//
// ## 这套件是一次错误汇报逼出来的
//
// 2026-09-15 聚合卡在 3/5，需要知道是哪两个没签。我去推 bitset 的位序：
//
//   第一次按 NodeID 的 CB58 字符串排序 → 「l1-3 与 l1-4 没签」**并这样报了出去**
//   第二次按 BLS 公钥字节排序           → 「l1-2 与 l1-3 没签」
//
// 两个都错。而且两个都违反同一条硬不变式：**发起聚合的节点必然计入自己的
// 本地签名**，可两种排序下都算出了「发起方不在自己的 bitset 里」——
// 这个矛盾当时就在眼前，是它把我拦下来的。
//
// 真正的签名者由验签定出（10 个子集里唯一命中）：l1-1 与 l1-3 没签。
//
// ## 所以本套件守的第一条就是"与位序无关"
//
// `bitset 内容被打乱也不改变结论` 那条测试是这个模块存在的理由：
// 位序是 avalanchego 的实现细节，随版本和规范排序规则变；
// 而"这条聚合签名能被哪一组公钥之和验过"是数学事实。
// 若哪天有人"顺手优化"成直接读位序，那条测试会红。
//
// ## 用仓库里创世那五个的**真密钥**签，不用构造的
//
// 它们按宪法第四条 v1.1.0 的例外提交在库里（仅本地开发网有效）。
// 用真密钥的好处是：本套件与 identifySigners 之间不共享任何关于
// "签名该怎么算"的假设 —— 这边用 avalanchego 同一套派生出的密钥真签一次，
// 那边独立验一次。构造的假签名只能测流程，测不了密码学那一半。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bls } from '@avalabs/avalanchejs';
import { loadProtocol, REPO_ROOT } from '../../tools/protocol/load.mjs';
import { identityOf, genesisValidators } from '../../tools/verify/lib/identity.mjs';
import { identifySigners, memberCandidates } from '../../tools/membership/add-validator.mjs';

const CONFIG = loadProtocol();
const GENESIS = genesisValidators(CONFIG.validators.nodes);

/** 创世那五个：公钥 + BLS 私钥（都在仓库里，仅本地开发网有效）。 */
const KEYS = GENESIS.map((v) => ({
  id: `node-${v.index}`,
  blsPublicKey: identityOf(v).blsPublicKey,
  secret: bls.secretKeyFromBytes(readFileSync(resolve(REPO_ROOT, v.keyDir, 'signer.key'))),
}));

// 被签的"消息"。长度取自实测的注册消息（258 字节），内容无关 —— 验签只看字节。
const MESSAGE = Buffer.alloc(258, 0x5a);
const UNSIGNED = `0x${MESSAGE.toString('hex')}`;

/**
 * 造一条"已签名的 Warp 消息"：给定签名者，真签、真聚合，
 * 再按 avalanchego 的布局拼上去 —— 未签名 ‖ 4 字节类型 ‖ 4 字节 bitset 长度 ‖ bitset ‖ 96 字节签名。
 *
 * `bitsetByte` 可以显式指定，用来验证**位序不影响结论**（只有置位个数有意义）。
 */
const signedBy = (indexes, bitsetByte = null) => {
  const sigs = indexes.map((i) => bls.signatureFromBytes(bls.sign(MESSAGE, KEYS[i].secret)));
  const agg = sigs.slice(1).reduce((p, s) => p.add(s), sigs[0]);
  const bits = bitsetByte === null
    ? indexes.reduce((b, i) => b | (1 << i), 0)
    : bitsetByte;
  const len = Buffer.alloc(4); len.writeUInt32BE(1);
  return `0x${Buffer.concat([
    MESSAGE,
    Buffer.from([0, 0, 0, 2]),
    len,
    Buffer.from([bits]),
    Buffer.from(bls.signatureToBytes(agg)),
  ]).toString('hex')}`;
};

const members = () => KEYS.map(({ id, blsPublicKey }) => ({ id, blsPublicKey }));

describe('identifySigners：验签定身份', () => {
  test('三个签名者能被认出来（实测那次就是 3/5）', async () => {
    const r = await identifySigners({
      signedMessage: signedBy([1, 3, 4]), unsignedMessage: UNSIGNED, members: members(),
    });
    assert.deepEqual(r.signed.sort(), ['node-2', 'node-4', 'node-5']);
    assert.deepEqual(r.missing.sort(), ['node-1', 'node-3']);
  });

  test('四个签名者（达标那次）也能认出来', async () => {
    const r = await identifySigners({
      signedMessage: signedBy([0, 2, 3, 4]), unsignedMessage: UNSIGNED, members: members(),
    });
    assert.deepEqual(r.missing, ['node-2']);
  });

  test('全员签名 → missing 为空', async () => {
    const r = await identifySigners({
      signedMessage: signedBy([0, 1, 2, 3, 4]), unsignedMessage: UNSIGNED, members: members(),
    });
    assert.equal(r.signed.length, 5);
    assert.deepEqual(r.missing, []);
  });

  test('单个签名者', async () => {
    const r = await identifySigners({
      signedMessage: signedBy([2]), unsignedMessage: UNSIGNED, members: members(),
    });
    assert.deepEqual(r.signed, ['node-3']);
  });

  test('**bitset 的内容被打乱也不改变结论**（这是本模块存在的理由）', async () => {
    // 真签名者是 0、2、4；但 bitset 里置的是 1、2、3 —— 个数对，位置全错。
    // 若实现改成"读位序"，这条会红。
    const truth = [0, 2, 4];
    const scrambled = await identifySigners({
      signedMessage: signedBy(truth, 0b01110), unsignedMessage: UNSIGNED, members: members(),
    });
    assert.deepEqual(scrambled.signed.sort(), ['node-1', 'node-3', 'node-5'],
      '换了 bitset 的位置就得出不同的签名者 —— 说明判定又回到了位序推断上。'
      + '位序推过两次，两次都错（一次还报了出去）。');
  });

  test('成员传入的顺序不影响结论（只影响返回的排列）', async () => {
    const forward = await identifySigners({
      signedMessage: signedBy([0, 1, 2]), unsignedMessage: UNSIGNED, members: members(),
    });
    const reversed = await identifySigners({
      signedMessage: signedBy([0, 1, 2]), unsignedMessage: UNSIGNED, members: members().reverse(),
    });
    assert.deepEqual(forward.signed.sort(), reversed.signed.sort());
    assert.deepEqual(forward.missing.sort(), reversed.missing.sort());
  });

  test('只试到命中就停 —— 不做满 C(n,k) 次', async () => {
    const r = await identifySigners({
      signedMessage: signedBy([0, 1, 2]), unsignedMessage: UNSIGNED, members: members(),
    });
    assert.ok(r.tried >= 1 && r.tried <= 10, `tried = ${r.tried} 不在 1…C(5,3)=10 之间`);
  });
});

describe('认不出来时**说认不出来**，不说"都没签"', () => {
  test('候选集合少一个成员 → 抛，且措辞不能被读成"那几个没签"', async () => {
    const sig = signedBy([0, 1, 2]);
    await assert.rejects(
      () => identifySigners({
        signedMessage: sig, unsignedMessage: UNSIGNED, members: members().slice(1),
      }),
      (err) => /验不过|判定不出来/.test(err.message)
        && err.message.includes('不要据此断言谁没签'),
      '候选集合残缺时给出了一个看起来像结论的东西 —— '
      + '**验不过就是判定不出来，不是"都没签"**。这正是我那次错误汇报的形状。');
  });

  test('换一条消息（签名对不上）→ 抛', async () => {
    const sig = signedBy([0, 1, 2]);
    const other = `0x${Buffer.alloc(258, 0x11).toString('hex')}`;
    await assert.rejects(() => identifySigners({
      signedMessage: sig.replace(MESSAGE.toString('hex'), Buffer.alloc(258, 0x11).toString('hex')),
      unsignedMessage: other,
      members: members(),
    }), /验不过/);
  });

  test('签名者数超过已知成员数 → 抛（集合不完整，别硬判）', async () => {
    await assert.rejects(() => identifySigners({
      signedMessage: signedBy([0, 1, 2, 3, 4]), unsignedMessage: UNSIGNED,
      members: members().slice(0, 3),
    }), /成员集合不完整/);
  });

  test('组合数超上限 → 抛，而不是静默跑很久', async () => {
    // 造 5 个成员选 3 个 = 10 种，把上限压到 1 就该拦下
    await assert.rejects(() => identifySigners({
      signedMessage: signedBy([0, 1, 2]), unsignedMessage: UNSIGNED,
      members: members(), maxCombinations: 1,
    }), /超过上限/,
    '没有上限的话，成员多起来时这个函数会在排查现场挂住 —— '
    + '而排查时最不需要的就是再多一个挂住的东西');
  });
});

describe('memberCandidates：候选集合正好是链上那一批', () => {
  const nodeIdOf = (i) => identityOf(GENESIS[i]).nodeId;
  const setOf = (nodeIds) => ({ members: nodeIds.map((nodeId) => ({ nodeId, weight: 100n })) });

  test('五个链上成员都能配上公钥与可读名字', () => {
    const got = memberCandidates({
      config: CONFIG, memberSet: setOf(GENESIS.map((_, i) => nodeIdOf(i))),
    });
    assert.equal(got.length, 5);
    for (const m of got) {
      assert.match(m.id, /^l1-\d+\/\S+$/, `id 不是「节点/故障边界」的形状: ${m.id}`);
      assert.match(m.blsPublicKey, /^0x[0-9a-f]{96}$/);
    }
  });

  test('**链上有一个成员在声明里找不到 → 返回 null**（不拿残缺集合去判定）', () => {
    const got = memberCandidates({
      config: CONFIG,
      memberSet: setOf([nodeIdOf(0), 'NodeID-1111111111111111111111111111111111']),
    });
    assert.equal(got, null,
      '一个来源不明的链上成员被跳过了，于是候选集合少一个 —— '
      + '而少一个的后果是 identifySigners **永远找不到匹配**，'
      + '报出来的却是"验不过"，看不出根因在候选集合上');
  });

  test('链上成员的 nodeId 缺失 → 返回 null', () => {
    const got = memberCandidates({
      config: CONFIG, memberSet: { members: [{ nodeId: null, weight: 100n }] },
    });
    assert.equal(got, null);
  });

  test('候选顺序跟着链上成员的顺序，与声明顺序无关', () => {
    const reversed = [...GENESIS].map((_, i) => nodeIdOf(GENESIS.length - 1 - i));
    const got = memberCandidates({ config: CONFIG, memberSet: setOf(reversed) });
    const forward = memberCandidates({
      config: CONFIG, memberSet: setOf(GENESIS.map((_, i) => nodeIdOf(i))),
    });
    assert.deepEqual(got.map((m) => m.id), forward.map((m) => m.id).reverse());
  });
});
