// ACP-77 第四步：确认消息的**结构**与 Warp 谓词的**编码**（功能 005 / T027）。
//
// ## 这两件事都是被真链上的拒签逼出来的
//
// 第一版把 `L1ValidatorRegistration`（typeID 2）直接当作 Warp 消息的 payload。
// 两个 Primary 都拒签，回的是同一句（2026-09-16，从聚合器日志里读到）：
//
//   `failed to parse warp addressed call: couldn't unmarshal interface: unknown type ID 2`
//
// P 链用 `warp/payload` 那套编解码器解析 payload，而那里只注册了 `Hash(0)` 与
// `AddressedCall(1)`。ACP-77 的消息必须**包在 AddressedCall 里** ——
// 与第一步那条入站消息同构，区别只是 P 链没有源地址（长度 0）。
//
// 拒签这件事**在链外**：不花钱、不留状态，但要翻聚合器的 debug 日志才看得到理由。
// 所以结构错误应当在本地就抛出来，而不是走到"两个 Primary 都不理你"。
//
// ## 尺寸当断言，不当注释
//
// 内层 39 / AddressedCall 53 / 整条 95 —— 三个都是实测值。
// 写成注释只能让人知道，写成断言才能让布局理解漂移时**变红**。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadProtocol } from '../../tools/protocol/load.mjs';
import {
  registrationConfirmationMessage, packWarpPredicate, WARP_PRECOMPILE_ADDRESS,
} from '../../tools/membership/add-validator.mjs';

// 真链上那次注册的 validationID（2026-09-15 第一步发出，第三步已被 P 链收录）
const VALIDATION_ID = '0xaa37ee1613092654f3a42007d471762698fe64e55a8a34f4a828fd064d6c15fc';
// networkId 从唯一事实来源读 —— 写字面量会被 no-hardcode 守卫拦下（本特性第九次）。
// 而且写死之后，换一条链时这套测试会**静默地还在验旧网络**。
const NETWORK_ID = loadProtocol().avalanche.networkId;

const bytesOf = (hex) => Buffer.from(hex.replace(/^0x/, ''), 'hex');

describe('确认消息的结构', () => {
  const msg = () => bytesOf(registrationConfirmationMessage({
    validationID: VALIDATION_ID, networkId: NETWORK_ID,
  }));

  test('三个尺寸与实测一致：内层 39 / AddressedCall 53 / 整条 95', () => {
    const b = msg();
    assert.equal(b.length, 95, '整条消息长度变了');
    assert.equal(b.readUInt32BE(38), 53, 'payload（AddressedCall）长度变了');
    // AddressedCall 内部：codec(2) + typeID(4) + srcAddrLen(4) + payloadLen(4)
    assert.equal(b.readUInt32BE(42 + 10), 39, '内层 L1ValidatorRegistration 长度变了');
  });

  test('**payload 必须是 AddressedCall（typeID 1）**', () => {
    // 这一条就是那次拒签。若有人把内层消息直接放到顶层，这里会读到 2 而不是 1。
    const b = msg();
    assert.equal(b.readUInt32BE(42 + 2), 1,
      'payload 的 typeID 不是 1（AddressedCall）—— P 链会回 '
      + '"failed to parse warp addressed call: unknown type ID …"，而那句话只在'
      + '聚合器的 debug 日志里看得到，不会出现在任何返回值上');
  });

  test('内层是 L1ValidatorRegistration（typeID 2）', () => {
    const b = msg();
    assert.equal(b.readUInt32BE(42 + 14 + 2), 2, '内层 typeID 不是 2');
  });

  test('P 链没有源地址 —— 地址长度必须是 0', () => {
    assert.equal(msg().readUInt32BE(42 + 6), 0,
      'AddressedCall 的源地址长度不是 0。第一步那条**入站**消息有 20 字节源地址'
      + '（合约地址），而 P 链发出的这条没有 —— 照抄入站结构会多出 20 字节');
  });

  test('sourceChainID 是 32 个零字节（P 链的 blockchainID）', () => {
    const src = msg().subarray(6, 38);
    assert.equal(src.length, 32);
    assert.ok(src.every((x) => x === 0),
      'sourceChainID 不是全零 —— P 链的 blockchainID 解码后正是 32 个零字节，'
      + '填别的会让 P 链按另一条链的验证者集合去验');
  });

  test('networkID 与 validationID 逐字节回得来', () => {
    const b = msg();
    assert.equal(b.readUInt32BE(2), NETWORK_ID);
    assert.equal(`0x${b.subarray(42 + 20, 42 + 20 + 32).toString('hex')}`, VALIDATION_ID);
  });

  test('registered 标志位可控，且默认为已注册', () => {
    const on = bytesOf(registrationConfirmationMessage({
      validationID: VALIDATION_ID, networkId: NETWORK_ID,
    }));
    const off = bytesOf(registrationConfirmationMessage({
      validationID: VALIDATION_ID, networkId: NETWORK_ID, registered: false,
    }));
    assert.equal(on.at(-1), 1, '默认应当是 registered = true（第四步要的就是这个）');
    assert.equal(off.at(-1), 0);
    assert.equal(on.length, off.length, '两种取值的长度必须一样');
  });

  test('换一个 networkID 就换一条消息（不会静默复用）', () => {
    const a = registrationConfirmationMessage({ validationID: VALIDATION_ID, networkId: NETWORK_ID });
    const b = registrationConfirmationMessage({ validationID: VALIDATION_ID, networkId: NETWORK_ID + 1 });
    assert.notEqual(a, b);
  });

  test('**validationID 不是 32 字节 → 抛**', () => {
    for (const bad of ['0xaa', `${VALIDATION_ID}bb`, '0x']) {
      assert.throws(
        () => registrationConfirmationMessage({ validationID: bad, networkId: NETWORK_ID }),
        /32 字节/,
        `${bad.slice(0, 12)}… 被收下了 —— 长度不对会让整条消息的偏移全错，`
        + '而错法是"两个 Primary 都不理你"');
    }
  });

  test('**networkId 不是正整数 → 抛**', () => {
    for (const bad of [0, -1, 1.5, undefined, String(NETWORK_ID)]) {
      assert.throws(
        () => registrationConfirmationMessage({ validationID: VALIDATION_ID, networkId: bad }),
        /networkId/,
        `networkId = ${JSON.stringify(bad)} 被收下了`);
    }
  });
});

describe('Warp 谓词的编码', () => {
  // 实测：签名后的确认消息 200 字节 → 加 1 字节分隔符 = 201 → 补到 224 → 7 个 key
  const SIGNED = `0x${'ab'.repeat(200)}`;

  test('实测那条：200 字节 → 7 个 storage key', () => {
    assert.equal(packWarpPredicate(SIGNED).length, 7);
  });

  test('每个 key 都是 32 字节', () => {
    for (const k of packWarpPredicate(SIGNED)) {
      assert.match(k, /^0x[0-9a-f]{64}$/, `key 不是 32 字节：${k}`);
    }
  });

  test('**末尾有 0xff 分隔符**（没有它就不知道消息到哪儿结束）', () => {
    const flat = bytesOf(packWarpPredicate(SIGNED).join('').replace(/0x/g, ''));
    assert.equal(flat[200], 0xff,
      '消息之后没有 0xff —— 补的零与消息末尾的零无法区分，'
      + '预编译会把补位当成消息内容');
  });

  test('分隔符之后全是零', () => {
    const flat = bytesOf(packWarpPredicate(SIGNED).join('').replace(/0x/g, ''));
    assert.ok(flat.subarray(201).every((b) => b === 0), '补位里混进了非零字节');
  });

  test('消息本身逐字节还原得回来', () => {
    const flat = bytesOf(packWarpPredicate(SIGNED).join('').replace(/0x/g, ''));
    assert.equal(`0x${flat.subarray(0, 200).toString('hex')}`, SIGNED);
  });

  test('长度正好是 32 的倍数时仍要多补一段（分隔符要占位）', () => {
    const exact = `0x${'cd'.repeat(64)}`;   // 64 字节 = 2 段，加分隔符后必须变 3 段
    const keys = packWarpPredicate(exact);
    assert.equal(keys.length, 3,
      '边界情形：消息长度本身是 32 的倍数时，分隔符会挤进新的一段。'
      + '算成 2 段就把分隔符丢了');
    assert.equal(bytesOf(keys[2])[0], 0xff);
  });

  test('**空消息 → 抛**（空谓词会让预编译读到一条不存在的消息）', () => {
    for (const empty of ['0x', '']) {
      assert.throws(() => packWarpPredicate(empty), /空的/);
    }
  });
});

describe('Warp 预编译地址', () => {
  test('是 subnet-evm 的固定地址，格式合法', () => {
    assert.match(WARP_PRECOMPILE_ADDRESS, /^0x0[0-9a-f]{39}$/);
    assert.equal(WARP_PRECOMPILE_ADDRESS, '0x0200000000000000000000000000000000000005');
  });
});
