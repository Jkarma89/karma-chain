// ACP-77 第二步：签名聚合的**结果校验**（功能 005 / T027）。
//
// ## 这套件守的是一件很容易漏的事
//
// 第二步调 `warp_getMessageAggregateSignature` 拿回一条消息。**"拿回了一条消息"
// 不等于"聚合到了签名"** —— 若那个调用因为某种原因把**未签名**消息原样返回，
// 我们会带着一条 P 链必然拒绝的消息走到第三步。
//
// 而第三步是四步里唯一**花钱**、且成功之后若第四步失败会留下
// 「P 链认了、合约没认」中间态的那一步。所以第二步的产物必须当场验：
// 长度变没变、bitset 里有几位置位。
//
// ## 实测基准（2026-09-15）
//
// 未签名 258 字节 → 已聚合 363 字节，多出 105 =
// 4（签名类型）+ 4（bitset 长度）+ 1（bitset）+ 96（BLS 聚合签名）。
// bitset 为 `0x17` = `0b10111` → 4 个验证者签了（80% ≥ 67% 门槛）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { countSigners, messageIdToCb58, meetsQuorum } from '../../tools/membership/add-validator.mjs';
import { cb58Decode } from '../../tools/verify/lib/identity.mjs';

/** 造一条"已签名"消息：未签名部分 + 4 字节类型 + 4 字节 bitset 长度 + bitset + 96 字节签名。 */
const signedOf = (unsignedLen, bitsetBytes) => {
  const unsigned = Buffer.alloc(unsignedLen, 0xab);
  const bitset = Buffer.from(bitsetBytes);
  const sig = Buffer.concat([
    Buffer.from([0, 0, 0, 2]),                                  // 签名类型
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(bitset.length); return b; })(),
    bitset,
    Buffer.alloc(96, 0xcd),                                     // BLS 聚合签名
  ]);
  return {
    unsignedHex: `0x${unsigned.toString('hex')}`,
    signedHex: `0x${Buffer.concat([unsigned, sig]).toString('hex')}`,
  };
};

describe('bitset 里置位的个数就是签名者数', () => {
  for (const [bits, want, note] of [
    [[0x17], 4, '0b10111 —— 2026-09-15 实测到的那一个'],
    [[0x1f], 5, '五个全签'],
    [[0x01], 1, '只有一个签'],
    [[0x03, 0x01], 3, '跨两个字节'],
    [[0xff], 8, '一个字节全满'],
  ]) {
    test(`bitset ${JSON.stringify(bits)} → ${want} 个（${note}）`, () => {
      const { unsignedHex, signedHex } = signedOf(258, bits);
      const r = countSigners(signedHex, unsignedHex);
      assert.equal(r.signers, want);
      assert.equal(r.signatureBytes, 96, 'BLS 聚合签名恒为 96 字节（G2 压缩表示）');
    });
  }

  test('实测基准对得上：258 → 363 字节，多出 105', () => {
    const { unsignedHex, signedHex } = signedOf(258, [0x17]);
    assert.equal((signedHex.length - 2) / 2, 363,
      '与 2026-09-15 的实测长度不符 —— 要么签名结构变了，要么本夹具造错了');
    assert.equal(countSigners(signedHex, unsignedHex).signers, 4);
  });
});

describe('**没签上就必须抛**（这条是本套件存在的理由）', () => {
  test('聚合后的消息与未签名一样长 → 抛，并说清第三步的代价', () => {
    const unsigned = `0x${Buffer.alloc(258, 0xab).toString('hex')}`;
    assert.throws(() => countSigners(unsigned, unsigned), /没有附上任何签名/,
      '未签名消息被当成聚合结果放过去了 —— 带着它走到第三步，P 链会拒绝，'
      + '而第三步是花钱的那一步');
  });

  test('聚合后反而更短 → 也要抛', () => {
    const unsigned = `0x${Buffer.alloc(258, 0xab).toString('hex')}`;
    const shorter = `0x${Buffer.alloc(100, 0xab).toString('hex')}`;
    assert.throws(() => countSigners(shorter, unsigned), /不比未签名的.*长/);
  });

  test('签名段装不下 bitset 加 96 字节签名 → 抛', () => {
    const unsigned = `0x${Buffer.alloc(258, 0xab).toString('hex')}`;
    const tooShort = `0x${Buffer.alloc(258 + 10, 0xab).toString('hex')}`;
    assert.throws(() => countSigners(tooShort, unsigned), /装不下/,
      '长度只多了一点也算"签上了"的话，一条截断的消息会被放到第三步');
  });

  test('bitset 全零 → signers 为 0（调用方据此拦下）', () => {
    const { unsignedHex, signedHex } = signedOf(258, [0x00]);
    assert.equal(countSigners(signedHex, unsignedHex).signers, 0,
      'step2 会在 signers < 1 时换下一个节点重试 —— 这里只负责如实报 0');
  });
});

describe('Warp 消息 ID 的编码转换', () => {
  test('合约事件给 32 字节 hex，Warp API 要 CB58 —— 转换必须往返一致', () => {
    // 2026-09-15 实测的那一条（第一步的 registrationMessageID）
    const hex = '0x61299911275d6348354bdb292475c8b6a04e723ca527e8f96cae054e1ec298c2';
    const id = messageIdToCb58(hex);
    assert.equal(id, 'jntMehq1kmdvuNt4LstwotbyXNCqvLqqmypEwJPQTGtwxHn35',
      '与实测可用的那个 CB58 ID 不符 —— 拿错的 ID 去调，API 会说消息不存在');
    assert.equal(`0x${cb58Decode(id).toString('hex')}`, hex, '往返不一致');
  });

  test('不带 0x 前缀也能转（事件解码出来的形式可能带也可能不带）', () => {
    const hex = '61299911275d6348354bdb292475c8b6a04e723ca527e8f96cae054e1ec298c2';
    assert.equal(messageIdToCb58(hex), messageIdToCb58(`0x${hex}`));
  });
});

describe('**门槛要自己验** —— 实测那个 quorumNum 参数不是硬门槛', () => {
  // 2026-09-15：给 warp_getMessageAggregateSignature 传了 quorumNum = 67，
  // 它**照样返回了一条只有 3 个签名者的消息**（五个等权验证者，3/5 = 60%）。
  // 带着它走到第三步，P 链会拒绝 —— 而那是四步里唯一花钱的一步。
  test('3/5 = 60% < 67% → 不达标', () => {
    const q = meetsQuorum({ signers: 3, registeredCount: 5, quorumNum: 67 });
    assert.equal(q.ok, false, '60% 被判成达标 —— 这条消息 P 链会拒绝');
    assert.equal(q.percent, 60);
  });

  test('4/5 = 80% ≥ 67% → 达标', () => {
    assert.equal(meetsQuorum({ signers: 4, registeredCount: 5, quorumNum: 67 }).ok, true);
  });

  test('5/5 = 100% → 达标', () => {
    assert.equal(meetsQuorum({ signers: 5, registeredCount: 5, quorumNum: 67 }).ok, true);
  });

  test('**恰好等于门槛算达标**（≥ 不是 >）', () => {
    // 3/4 = 75%，门槛 75% —— 边界上写成 > 会把一条合格的消息判成不合格，
    // 而那种错的表现是"明明都在线却总说聚合不到签名"
    assert.equal(meetsQuorum({ signers: 3, registeredCount: 4, quorumNum: 75 }).ok, true);
  });

  test('registeredCount 为 0 → 抛（不是当成 0% 或 100%）', () => {
    assert.throws(() => meetsQuorum({ signers: 0, registeredCount: 0, quorumNum: 67 }),
      /算不出/, '除数为 0 时给出一个数字，比抛错更坏');
  });

  test('百分比向下取整 —— 不许把 66.x% 凑成 67%', () => {
    // 2/3 = 66.67%。四舍五入会得到 67，恰好"达标"，而实际不到门槛。
    assert.equal(meetsQuorum({ signers: 2, registeredCount: 3, quorumNum: 67 }).percent, 66);
    assert.equal(meetsQuorum({ signers: 2, registeredCount: 3, quorumNum: 67 }).ok, false);
  });
});
