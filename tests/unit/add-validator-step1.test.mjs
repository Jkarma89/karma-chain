// ACP-77 第一步的入参构造与拦阻条件（功能 005 / T027）。
//
// ## 为什么这些断言值得存在
//
// 第一步是**写链**的第一个动作。它的入参有四样东西，每一样写错的后果都不是报错：
//
//   nodeID 抄错一个字符  → 注册一个**不存在的节点**，链上多一个永远不上线的成员
//   BLS 公钥不对         → 节点永远无法出示有效签名
//   权重与既有不等        → ⌊n/4⌋ 的容错推导失效，而面板照旧给出余量
//   P 链 owner 不一致     → 几个月后没人知道该去哪儿续费
//
// 所以入参**只能从声明与链上取**，不接受命令行传值；而每一条"取不出一致答案"的
// 情形都必须**停下来让人决定**，不能挑一个值继续。
//
// ## 全部离线
//
// `pchain` 与 `client` 都是假的。真链上造不出"既有成员权重不等"这种情形 ——
// 而那恰恰是最需要拦住的一种。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadProtocol } from '../../tools/protocol/load.mjs';
import { cb58Encode, nodeIdToBytes, joinedValidators } from '../../tools/verify/lib/identity.mjs';
import { step1Inputs, step1 } from '../../tools/membership/add-validator.mjs';

const CONFIG = loadProtocol();
const JOINED = joinedValidators(CONFIG.validators.nodes);
const NODE_ID = JOINED[0]?.identity.nodeId;

/** 既有成员用的 P 链地址 —— 取自 2026-09-14 实测（research V-29）的那一个形状。 */
const P_ADDR = 'P-custom18jma8ppw3nhx5r4ap8clazz0dps7rv5u9xde7p';

const validator = (nodeID, weight = '100', owner = P_ADDR) => ({
  nodeID, weight, remainingBalanceOwner: { locktime: '0', threshold: '1', addresses: [owner] },
});

/** 假的 P 链：只回答 getCurrentValidators。 */
const fakePchain = (validators) => async (method) => {
  if (method !== 'platform.getCurrentValidators') throw new Error(`没料到的方法 ${method}`);
  return { validators };
};

const fiveEqual = () => Array.from({ length: 5 }, (_, i) =>
  validator(`NodeID-${cb58Encode(createHash('sha256').update(`v${i}`).digest().subarray(0, 20))}`));

describe('夹具前提', () => {
  test('声明里确实有一个 origin=joined 的成员（否则本套件空跑）', () => {
    assert.ok(NODE_ID, 'blockchain/deployment.json 里没有 origin=joined 的成员 —— '
      + '本套件的每一条都会因为拿不到目标而失去意义');
  });
});

describe('正常路径：入参全部从声明与链上取', () => {
  test('nodeID 解成 20 字节，且与声明往返一致', async () => {
    const r = await step1Inputs({
      client: null, pchain: fakePchain(fiveEqual()), nodeId: NODE_ID,
      config: CONFIG, subnetId: 'x',
    });
    assert.match(r.nodeIdBytes, /^0x[0-9a-f]{40}$/, 'nodeID 应为 20 字节的 hex');
    assert.equal(`NodeID-${cb58Encode(Buffer.from(r.nodeIdBytes.slice(2), 'hex'))}`, NODE_ID);
  });

  test('BLS 公钥取自声明，48 字节', async () => {
    const r = await step1Inputs({
      client: null, pchain: fakePchain(fiveEqual()), nodeId: NODE_ID,
      config: CONFIG, subnetId: 'x',
    });
    assert.equal(r.blsPublicKey, JOINED[0].identity.blsPublicKey);
    assert.match(r.blsPublicKey, /^0x[0-9a-f]{96}$/);
  });

  test('权重取既有成员的值 —— 不是写死的常量', async () => {
    const r = await step1Inputs({
      client: null, pchain: fakePchain(fiveEqual().map((v) => ({ ...v, weight: '250' }))),
      nodeId: NODE_ID, config: CONFIG, subnetId: 'x',
    });
    assert.equal(r.weight, 250n,
      '权重应当跟随既有成员。写死 100 的话，换一条既有权重不同的链时'
      + '会静默注册出一个不等权的成员，而 ⌊n/4⌋ 的推导就此失效');
  });

  test('P 链 owner 沿用既有成员的那一个，解成 20 字节地址', async () => {
    const r = await step1Inputs({
      client: null, pchain: fakePchain(fiveEqual()), nodeId: NODE_ID,
      config: CONFIG, subnetId: 'x',
    });
    assert.equal(r.pAddr, P_ADDR);
    assert.equal(r.pchainOwner.threshold, 1);
    assert.equal(r.pchainOwner.addresses.length, 1);
    assert.match(r.pchainOwner.addresses[0], /^0x[0-9a-f]{40}$/,
      'PChainOwner.addresses 的 ABI 类型是 address[]（20 字节），不是 bech32 字符串');
  });
});

describe('**取不出一致答案时停下来**，不挑一个值继续', () => {
  test('既有成员权重不等 → 抛，并说明为什么不能自动选', async () => {
    const mixed = fiveEqual();
    mixed[2] = { ...mixed[2], weight: '250' };
    await assert.rejects(
      () => step1Inputs({ client: null, pchain: fakePchain(mixed), nodeId: NODE_ID, config: CONFIG, subnetId: 'x' }),
      /等权/,
      '权重不等时自动挑了一个继续 —— ⌊n/4⌋ 的容错推导以等权为前提，'
      + '此时该让人先决定新成员用什么权重、以及不等权之后容错怎么算');
  });

  test('既有成员的 remainingBalanceOwner 不唯一 → 抛', async () => {
    const mixed = fiveEqual();
    mixed[1] = validator(mixed[1].nodeID, '100', 'P-custom1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqv3yc8u');
    await assert.rejects(
      () => step1Inputs({ client: null, pchain: fakePchain(mixed), nodeId: NODE_ID, config: CONFIG, subnetId: 'x' }),
      /不唯一/,
      '多个 owner 时自动挑了一个 —— 新成员该跟谁一致需要人来定，'
      + '挑错的后果是几个月后没人知道该去哪儿续费');
    });

  test('P 链上一个成员都没有 → 抛（而不是当成"第一个成员"继续）', async () => {
    await assert.rejects(
      () => step1Inputs({ client: null, pchain: fakePchain([]), nodeId: NODE_ID, config: CONFIG, subnetId: 'x' }),
      /一个成员都没有/,
      '空集合时继续下去，权重与 owner 都只能凭空造 —— 那不是"加成员"，是在猜链的配置');
  });

  test('声明里没有这个 nodeID → 抛', async () => {
    await assert.rejects(
      () => step1Inputs({
        client: null, pchain: fakePchain(fiveEqual()),
        nodeId: 'NodeID-111111111111111111116DBWJs', config: CONFIG, subnetId: 'x',
      }),
      /声明里没有/,
      '不在声明里的 nodeID 被接受了 —— 那就绕过了 schema 与 CB58 校验和那两道关');
  });
});

describe('**签名密钥必须就是合约的 owner**', () => {
  const fakeClient = (owner) => ({
    readContract: async ({ functionName }) => {
      if (functionName === 'owner') return owner;
      throw new Error(`没料到的读取 ${functionName}`);
    },
    transport: { url: 'http://127.0.0.1:0/nowhere' },
  });

  test('本地密钥地址与合约 owner 不符 → 抛，且**没有发出任何交易**', async () => {
    const wrong = '0x000000000000000000000000000000000000dEaD';
    await assert.rejects(
      () => step1({
        client: fakeClient(wrong),
        pchain: fakePchain(fiveEqual()),
        nodeId: NODE_ID, config: CONFIG, subnetId: 'x',
        ownerAccount: { address: '0x0000000000000000000000000000000000001234' },
      }),
      /owner/,
      '不比对就发交易的话，合约会 revert —— 而 revert 的原因要去读 trace 才知道，'
      + '而这里可以直接说清"你手上的密钥不是 owner"');
  });
});

describe('nodeID 的校验和是写链之前的最后一道关', () => {
  test('抄错一个字符的 NodeID 被拒（格式仍然合法，只有校验和不对）', () => {
    const last = NODE_ID.at(-1);
    const swapped = NODE_ID.slice(0, -1) + (last === 'k' ? 'm' : 'k');
    assert.notEqual(swapped, NODE_ID);
    assert.throws(() => nodeIdToBytes(swapped), /校验和/,
      '抄错一个字符的 NodeID 通过了 —— 那会注册一个**不存在的节点**：'
      + '链上多一个永远不上线的成员，而容错判据把它算成"该在线但掉了"');
  });

  test('正确的 NodeID 照旧通过（保护范围没缩过头）', () => {
    assert.equal(nodeIdToBytes(NODE_ID).length, 20);
  });
});
