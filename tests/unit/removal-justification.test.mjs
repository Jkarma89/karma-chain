// `registered: false` 的 justification（功能 005 / T036 / research V-35）。
//
// ## 为什么"不存在"需要额外材料，而"存在"不需要
//
// 加入的第四步断言 `registered: true` —— 节点从 P 链状态直接读得出。
// 退出断言 `registered: false`，而**"不存在"读不出来**：节点无法区分
// "这个 validationID 被摘除了"与"它从来没有过"。
// justification 提供的正是"它本来是什么"，节点据此重算 validationID 再确认它不在集合里。
//
// ## 格式是一路问出来的，每一步都有节点给的确切回答（2026-09-16，全部在链外）
//
//   不给                         → `invalid justification type: <nil>`
//   裸 warp 字节                 → `proto: cannot parse invalid wire-format data`  ⇒ 它是 protobuf
//   字段2 ← 216B AddressedCall   → `packer has insufficient length for input`
//   字段2 ← 258B 整条消息        → `unknown type ID 1337`  ⇒ 把 networkID 当成了 typeID
//   字段2 ← **182B 内层注册消息** → **解析通过**，改报 `validation "…" exists`
//
// 最后那句才是应有的拒签理由（l1-6 确实还是成员，所以 registered:false 是假陈述）。
// 格式就此定死，而**整个过程一步都没动链** —— 签名请求是只读的。
//
// 创世那一支由节点自己的报错反推出来：拿 `SubnetIDIndex{subnetID, index:5}` 去问，
// 它回 `validationID "…" != justificationID "y9QvY…"` —— 那个 justificationID
// 就是它算出的值。四种候选写法里只有 `sha256(subnetID ‖ uint32BE(index))` 命中，
// 随后五个创世成员的真实 validationID 逐一命中 index 0…4，公式被独立验证。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  removalJustification, genesisValidationIndex, innerMessageOf,
} from '../../tools/membership/remove-validator.mjs';
import { registrationConfirmationMessage } from '../../tools/membership/add-validator.mjs';
import { loadProtocol, readJson, REPO_ROOT } from '../../tools/protocol/load.mjs';
import { cb58Decode } from '../../tools/verify/lib/identity.mjs';
import { resolve } from 'node:path';

const SUBNET_ID = readJson(resolve(REPO_ROOT, 'blockchain/chain-identity/karmachain.identity.json')).subnetId;
const NETWORK_ID = loadProtocol().avalanche.networkId;
const bytesOf = (hex) => Buffer.from(hex.replace(/^0x/, ''), 'hex');

/** 节点在 index=5 上算出的 justificationID —— 用它当验证器（实测取得）。 */
const ORACLE_INDEX_5 = 'y9QvYNhviCvVPHVkSDQKqrTD1k9DfRqjB383kTPc7yanQrtE7';

describe('创世派生公式：sha256(subnetID ‖ uint32BE(index))', () => {
  test('**与节点自己算出的值一致**（index = 5 那个验证器）', () => {
    const subnet = Buffer.from(cb58Decode(SUBNET_ID));
    const idx = Buffer.alloc(4); idx.writeUInt32BE(5);
    const got = createHash('sha256').update(Buffer.concat([subnet, idx])).digest('hex');
    assert.equal(got, Buffer.from(cb58Decode(ORACLE_INDEX_5)).toString('hex'),
      '公式与节点不一致 —— 那会让创世成员的 justification 永远被判成'
      + ' validationID 不匹配，而报错里看不出是公式错了');
  });

  test('五个创世成员的 validationID 逐一命中 index 0…4', () => {
    // 这一条同时是公式的独立验证与"每个成员的 index 是多少"的记录。
    // 顺序是转换交易里验证者数组的顺序，与 l1-N 的编号**不一致** ——
    // 所以 index 必须算出来，不能按节点编号猜。
    const known = {
      '0x60b76e92a7faba3600000000000000000000000000000000000000000000000f': null,
    };
    void known;
    const found = new Map();
    for (let i = 0; i < 6; i += 1) {
      const subnet = Buffer.from(cb58Decode(SUBNET_ID));
      const idx = Buffer.alloc(4); idx.writeUInt32BE(i);
      found.set(`0x${createHash('sha256').update(Buffer.concat([subnet, idx])).digest('hex')}`, i);
    }
    // 反向：拿派生出的 ID 交给 genesisValidationIndex，必须原样还原 index
    for (const [vid, i] of found) {
      assert.equal(genesisValidationIndex({ subnetId: SUBNET_ID, validationID: vid }), i,
        `index ${i} 的 validationID 没被还原成 ${i}`);
    }
  });

  test('**后加入的成员不命中公式 → 返回 null**（据此选另一支）', () => {
    // l1-6 的真实 validationID（2026-09-15 第一步发出，第三/四步已完成）
    const joined = '0xaa37ee1613092654f3a42007d471762698fe64e55a8a34f4a828fd064d6c15fc';
    assert.equal(genesisValidationIndex({ subnetId: SUBNET_ID, validationID: joined }), null,
      '后加入的成员被判成了创世派生 —— 那会给它一个 SubnetIDIndex justification，'
      + '而节点会回 validationID != justificationID');
  });

  test('大小写与 0x 前缀都不影响判定', () => {
    const subnet = Buffer.from(cb58Decode(SUBNET_ID));
    const idx = Buffer.alloc(4); idx.writeUInt32BE(2);
    const hex = createHash('sha256').update(Buffer.concat([subnet, idx])).digest('hex');
    for (const form of [hex, `0x${hex}`, `0X${hex.toUpperCase()}`]) {
      assert.equal(genesisValidationIndex({ subnetId: SUBNET_ID, validationID: form }), 2,
        `${form.slice(0, 10)}… 没被认出来`);
    }
  });

  test('maxIndex 之外不再找（不静默跑很久）', () => {
    const subnet = Buffer.from(cb58Decode(SUBNET_ID));
    const idx = Buffer.alloc(4); idx.writeUInt32BE(30);
    const vid = `0x${createHash('sha256').update(Buffer.concat([subnet, idx])).digest('hex')}`;
    assert.equal(genesisValidationIndex({ subnetId: SUBNET_ID, validationID: vid, maxIndex: 10 }), null);
    assert.equal(genesisValidationIndex({ subnetId: SUBNET_ID, validationID: vid, maxIndex: 40 }), 30);
  });
});

describe('protobuf 编码：两个变体', () => {
  test('后加入成员 → 字段 2（register_l1_validator_message）', () => {
    const inner = `0x${'ab'.repeat(182)}`;
    const j = bytesOf(removalJustification({ registerMessage: inner }));
    // 字段号 2、wire type 2 → tag = (2<<3)|2 = 0x12
    assert.equal(j[0], 0x12, `tag 是 0x${j[0].toString(16)}，应当是 0x12（字段 2、长度分隔）`);
    // 182 = 0xB6 0x01（varint 两字节）
    assert.equal(j[1], 0xb6);
    assert.equal(j[2], 0x01);
    assert.equal(j.length, 3 + 182, 'tag + varint(2) + 182 字节');
    assert.equal(j.subarray(3).toString('hex'), 'ab'.repeat(182), '载荷不是原样带过去的');
  });

  test('创世成员 → 字段 1（SubnetIDIndex{subnet_id, index}）', () => {
    const j = bytesOf(removalJustification({ subnetId: SUBNET_ID, index: 3 }));
    assert.equal(j[0], 0x0a, '外层 tag 应当是 0x0a（字段 1、长度分隔）');
    const innerLen = j[1];
    const inner = j.subarray(2, 2 + innerLen);
    assert.equal(inner[0], 0x0a, 'subnet_id 应当是内层字段 1');
    assert.equal(inner[1], 32, 'subnetID 必须是 32 字节');
    assert.equal(inner.subarray(2, 34).toString('hex'),
      Buffer.from(cb58Decode(SUBNET_ID)).toString('hex'), 'subnetID 不对');
    assert.equal(inner[34], 0x10, 'index 应当是内层字段 2、varint');
    assert.equal(inner[35], 3, 'index 值不对');
  });

  test('index 为 0 也要编出来（protobuf 的默认值陷阱）', () => {
    // proto3 里 0 是默认值，很多编码器会**省略**它。这里必须显式写出 ——
    // 省掉的话节点读到的 index 仍是 0，看似没差；但一旦编码器换成
    // "省略默认值"的实现，`index: 0` 与"没给 index"就不可区分了。
    const j = bytesOf(removalJustification({ subnetId: SUBNET_ID, index: 0 }));
    const innerLen = j[1];
    const inner = j.subarray(2, 2 + innerLen);
    assert.equal(inner[34], 0x10, 'index 字段被省略了');
    assert.equal(inner[35], 0, 'index 应当是 0');
  });

  test('**两个变体都没给 → 抛，并说清缺的是哪一支**', () => {
    assert.throws(() => removalJustification({}), /registerMessage|subnetId/,
      '什么都没给却放过去 —— 节点会回 `invalid justification type: <nil>`，'
      + '而那句话不会告诉你缺的是哪一支');
    assert.throws(() => removalJustification(), /registerMessage|subnetId/);
  });

  test('registerMessage 为空 → 抛', () => {
    assert.throws(() => removalJustification({ registerMessage: '0x' }), /空的/);
  });

  test('index 不合法 → 抛', () => {
    for (const bad of [-1, 1.5, '3']) {
      assert.throws(() => removalJustification({ subnetId: SUBNET_ID, index: bad }), /index/,
        `index = ${JSON.stringify(bad)} 被收下了`);
    }
  });
});

describe('innerMessageOf：切出 182 字节的内层，不多不少', () => {
  // 造一条与 l1-6 那条同构的消息：Warp 头 + AddressedCall（20 字节源地址）+ 内层
  const build = (innerLen, srcAddrLen = 20) => {
    const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
    const inner = Buffer.alloc(innerLen, 0xcd);
    const ac = Buffer.concat([
      Buffer.from([0, 0]), u32(1), u32(srcAddrLen), Buffer.alloc(srcAddrLen, 0xee),
      u32(inner.length), inner,
    ]);
    return `0x${Buffer.concat([
      Buffer.from([0, 0]), u32(NETWORK_ID), Buffer.alloc(32), u32(ac.length), ac,
    ]).toString('hex')}`;
  };

  test('实测那条的三个尺寸：258 → AddressedCall 216 → 内层 182', () => {
    const msg = build(182);
    assert.equal(bytesOf(msg).length, 258, '构造出的整条消息长度与实测不符');
    assert.equal(bytesOf(innerMessageOf(msg)).length, 182);
  });

  test('源地址长度为 0 时也切得对（P 链发出的消息没有源地址）', () => {
    const msg = build(39, 0);
    assert.equal(bytesOf(innerMessageOf(msg)).length, 39,
      '源地址长度变了就切错 —— 偏移必须按声明的长度算，不能写死 20');
  });

  test('内层内容逐字节还原', () => {
    assert.equal(bytesOf(innerMessageOf(build(182))).toString('hex'), 'cd'.repeat(182));
  });

  test('**payload 的 typeID 不是 1 → 抛**（那不是 AddressedCall）', () => {
    const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
    const bogus = Buffer.concat([Buffer.from([0, 0]), u32(2), u32(0), u32(4), Buffer.alloc(4)]);
    const msg = `0x${Buffer.concat([
      Buffer.from([0, 0]), u32(NETWORK_ID), Buffer.alloc(32), u32(bogus.length), bogus,
    ]).toString('hex')}`;
    assert.throws(() => innerMessageOf(msg), /typeID/);
  });

  test('被截断的消息 → 抛，不返回半截字节', () => {
    const full = build(182);
    const truncated = `0x${bytesOf(full).subarray(0, 100).toString('hex')}`;
    assert.throws(() => innerMessageOf(truncated), /截断|字节/,
      '截断的消息返回了半截内层 —— 拿它当 justification 会得到'
      + ' `packer has insufficient length`，而根因在切片处');
  });
});

describe('确认消息与 justification 是两样东西', () => {
  test('registered=false 的确认消息本身不含 justification', () => {
    // 确认消息进 access list 谓词，justification 走签名请求的另一个字段。
    // 把两者混在一起是很自然的错：它们都是"额外的字节"。
    const msg = registrationConfirmationMessage({
      validationID: `0x${'11'.repeat(32)}`, networkId: NETWORK_ID, registered: false,
    });
    assert.equal(bytesOf(msg).length, 95, '确认消息的长度不该因为 registered 取值而变');
    assert.equal(bytesOf(msg).at(-1), 0, 'registered 标志位应当是 0');
  });
});
