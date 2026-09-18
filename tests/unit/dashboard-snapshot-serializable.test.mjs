// 快照必须能变成 JSON（功能 005 / T033 收尾实测）。
//
// ## 面板整个进程崩了，而 263 个单元测试一个都没红
//
// 2026-09-17 走完 T033 之后起面板，第一个 /api/snapshot 请求就把进程打掉了：
//
//   TypeError: Do not know how to serialize a BigInt
//     at JSON.stringify (<anonymous>)
//     at json (tools/dashboard/server.mjs:80)
//
// 来源是 member-set.mjs 里**刻意**用的 BigInt：P 链上的成员权重，
// 以及 Primary 的质押（10^15 量级，用 Number 会在别的部署里丢精度）。
// 那个选择是对的 —— 错的是没人问过"这个对象能不能变成 JSON"。
//
// 已有的面板测试全都断言 `buildSnapshot` 返回的**对象**：tier 对不对、
// 余量算得对不对、文案有没有那句话。**一条都没经过序列化这一步**，
// 而序列化恰恰是这个对象存在的理由 —— 它是一个 HTTP API 的响应体。
// 检查器自己没有被检查。
//
// ## 为什么这条守卫要**同时**钉住两件事
//
//   ① 快照里确实有 BigInt（所以这不是一条恒真的断言）
//   ② 服务端那条序列化路径能处理它
//
// 只钉②的话，哪天 BigInt 被改成 Number，这条守卫会继续绿 —— 而它守的东西
// 已经不存在了。一条恒真的断言等于没有断言。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildSnapshot } from '../../tools/dashboard/snapshot.mjs';
import { loadProtocol, REPO_ROOT } from '../../tools/protocol/load.mjs';

const PROTOCOL = loadProtocol();
const BASELINE = '0x19cfde1f02e585020cdae83071bac33c7d81e411cacf7f306b82ceabe98892ed';

const validator = (i) => ({
  id: `l1-${i}`, role: 'l1-validator', domain: `d-${i}`, address: `10.0.0.${i}`,
  nodeId: `NodeID-fake${i}`, reachable: true, state: 'healthy', detail: '已追平',
  height: 1304, peers: 6, genesisHash: BASELINE,
  countsTowardTolerance: true, countsAsOffline: false,
});

const ROWS = [1, 2, 3, 4, 5, 6].map(validator);

/** 与 readPChainMembers 的真实返回同形 —— weight/balance 是 **BigInt**。 */
const MEMBER_SET = {
  source: 'p-chain',
  subnetId: '2W9boARgCWL25z6pMFNtkCfNA5v28VGg9PmBgUJfuKndEdhrvw',
  members: ROWS.map((r) => ({
    nodeId: r.nodeId, weight: 100n, validationID: `0x${'ab'.repeat(32)}`, balance: 99162945n,
  })),
};

/** 与 readPrimaryNetworkStake 的真实返回同形 —— 10^15 量级的 BigInt。 */
const PCHAIN_STAKE = {
  source: 'p-chain',
  validators: [
    { nodeId: 'NodeID-fakep1', weight: 1_000_000_000_000_000n },
    { nodeId: 'NodeID-fakep2', weight: 1_000_000_000_000_000n },
  ],
  totalWeight: 2_000_000_000_000_000n,
  readAt: Date.now(),
};

const snapshot = () => buildSnapshot({
  collectedAt: Date.now(),
  pollIntervalMs: 5000,
  deployment: 'lan',
  networkHeight: 1304,
  rows: ROWS,
  faultTolerance: {
    validatorCount: 6, maxOfflineValidators: 1, domainCount: 6, maxValidatorsPerDomain: 1,
    declaredWithinLimit: true, effectiveDomainCount: 6,
    effectiveDomains: ROWS.map((r) => ({ ids: [r.domain], factors: [], validators: 1 })),
    tolerateWholeDomainLoss: true,
  },
  observer: { reachableNodes: 6, totalNodes: 6, blind: false, pathAlive: [] },
  chain: {
    chainId: PROTOCOL.chain.chainId, networkId: PROTOCOL.avalanche.networkId,
    chainAlias: PROTOCOL.chain.blockchainName, blockchainId: 'fakeBlockchainId',
    rpcPath: '/ext/bc/karmachain/rpc', publishedHosts: ['127.0.0.1', 'localhost'],
  },
  baselineGenesisHash: BASELINE,
  containerFacts: { available: true, reason: null },
  summaryLine: '6/6 验证者在线',
  memberSet: MEMBER_SET,
  pchainStake: PCHAIN_STAKE,
});

/** 深搜 BigInt —— 用来证明①，而不是假设它。 */
const findBigInt = (v, path = '$') => {
  if (typeof v === 'bigint') return path;
  if (v === null || typeof v !== 'object') return null;
  for (const [k, x] of Object.entries(v)) {
    const hit = findBigInt(x, `${path}.${k}`);
    if (hit) return hit;
  }
  return null;
};

describe('① 快照里确实带 BigInt（否则本文件是一条恒真断言）', () => {
  test('能在快照里找到至少一个 BigInt', () => {
    const where = findBigInt(snapshot());
    assert.ok(where,
      '快照里已经没有 BigInt 了 —— 那么本文件守的东西不存在，应当连同 '
      + 'server.mjs 的 bigintSafe 一起删掉，而不是留一条恒绿的断言。\n'
      + '  （若是有意改成 Number，请先确认 Primary 质押的 10^15 量级不会丢精度。）');
  });

  test('裸 JSON.stringify **确实**会抛 —— 这是那次崩溃的成因', () => {
    assert.throws(() => JSON.stringify(snapshot()), /BigInt/,
      '裸序列化不再抛了，说明①已经不成立 —— 见上一条');
  });
});

describe('② 服务端那条路径能把它序列化出去', () => {
  const SERVER = readFileSync(resolve(REPO_ROOT, 'tools/dashboard/server.mjs'), 'utf8');

  test('server.mjs 的 json() 带了 BigInt 的 replacer', () => {
    assert.match(SERVER, /const bigintSafe = /,
      'server.mjs 少了 bigintSafe —— 面板会在第一个 /api/snapshot 请求上崩掉');
    assert.match(SERVER, /JSON\.stringify\(body, bigintSafe\)/,
      'json() 没有用上那个 replacer —— 定义了不用等于没定义');
  });

  test('用它序列化能过，且 BigInt 出去是十进制字符串', () => {
    // replacer 与 server.mjs 里那一行同义。按字符串出与 P 链 API 的表示一致 ——
    // 转成 Number 会在 10^15 量级上丢精度，那比崩溃更坏（它不报错）。
    const bigintSafe = (_k, v) => (typeof v === 'bigint' ? v.toString() : v);
    const text = JSON.stringify(snapshot(), bigintSafe);
    const back = JSON.parse(text);
    assert.ok(text.length > 100);
    const still = findBigInt(back);
    assert.equal(still, null, `往返之后还有 BigInt：${still}`);
    // 权重必须是 JSON **字符串**。写成数字的话，Primary 质押那 10^15 在 JS 里
    // 还撑得住，但再大一点就静默丢精度 —— 而那种丢法不报错，比崩溃更难发现。
    //（第一版这里断言"没有科学计数法"，用字形去猜 —— 结果被创世哈希里的
    // "1e4" 误伤了。按值断言，别按字形猜。）
    // 按**快照里实际存在的**那一处断言。BigInt 全部落在 rejoin 下（来自
    // readPrimaryNetworkStake 的质押）；成员权重并不进快照 ——
    // 第一版按 "weight":"100" 断言，红了，那是我猜的字段而不是查到的字段。
    assert.match(text, /"totalWeight":"2000000000000000"/,
      'Primary 质押合计没有以字符串出现 —— 它要么没被 replacer 处理，'
      + '要么被转成了数字（10^15 现在还撑得住，再大一点就静默丢精度）');
  });

  test('10^15 量级的质押一位不差地往返', () => {
    const bigintSafe = (_k, v) => (typeof v === 'bigint' ? v.toString() : v);
    const back = JSON.parse(JSON.stringify(snapshot(), bigintSafe));
    const text = JSON.stringify(back);
    assert.match(text, /2000000000000000/,
      'Primary 质押合计 2×10^15 没有原样出现 —— 精度在序列化时丢了，'
      + '而这种丢法不报错，比崩溃更难发现');
  });
});
