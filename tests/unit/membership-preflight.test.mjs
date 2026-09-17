// 加入流程的三条前置检查，每条都必须**拦下**（功能 005 / T023、FR-013 / FR-014 / FR-015）。
//
// ## 为什么要有基线用例
//
// 三条断言都是"某某情形下 precheck 不通过"。若基线本身就不通过，三条会**全部恒真** ——
// 那种守卫比没有守卫更坏。所以每组都先证明：不动任何东西时 precheck 是 ok 的，
// 然后只翻一个开关，再证明它变成不 ok，**并且拦下的理由正是那一条**。
//
// ## FR-014 曾经只存在于注释里
//
// precheck 的函数头从第一版起就写着「FR-013 / FR-014 / FR-015」，而实现里
// 只有 013 与 015 —— **一条声称存在的判定不存在，比没有声称更坏**：
// 读注释的人以为已经守住了。本文件补上它的用例，同时 precheck 现在对
// blockchainId / genesisHash 缺失**直接抛**，不再让"没核对"长得像"核对通过"。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadProtocol, deriveTopology, readJson, REPO_ROOT } from '../../tools/protocol/load.mjs';
import { precheck } from '../../tools/membership/add-validator.mjs';

// 这三个值一律**从事实来源读**，不在测试里抄一份 ——
// 抄下来的那份会在换链之后变成一个悄悄失效的用例（SC-007 的守卫也不允许）。
const GENESIS_HASH = readFileSync(
  resolve(REPO_ROOT, 'blockchain', 'genesis', 'karmachain.genesis.hash'), 'utf8',
).trim();
const IDENTITY = readJson(
  resolve(REPO_ROOT, 'blockchain', 'chain-identity', 'karmachain.identity.json'),
);
const BLOCKCHAIN_ID = IDENTITY.blockchainId;

const CHAIN_ID = loadProtocol().chain.chainId;

const clone = (x) => JSON.parse(JSON.stringify(x));

/** 目标是声明里那个 origin=joined 的成员 —— 加入流程本来就只对它生效。 */
function target(config) {
  const v = config.validators.nodes.find((x) => x.identity?.origin === 'joined');
  assert.ok(v, '声明里应当有一个 origin=joined 的成员，否则本文件构造不出加入场景');
  return v.identity.nodeId;
}

/** 链上还没有任何成员：getLogs 返回空，于是"已经是成员"与"认不出的成员"都不成立。 */
const emptyClient = {
  getBlockNumber: async () => 1000n,
  getLogs: async () => [],
};

/** P 链读不到 —— 只影响 splitError，不影响 problems（precheck 自己在 try 里兜住）。 */
const noPChain = async () => { throw new Error('本用例不提供 P 链'); };

/**
 * 按 URL 分流的假 fetch。
 * - `/ext/info`       → 存活探测；`offline` 里的地址答 503
 * - `/ext/bc/<id>/rpc`→ 创世核对；默认答基准哈希与本链 chainId
 */
function fakeFetch({ offline = [], genesis } = {}) {
  return async (url, init) => {
    const host = new URL(url).hostname;
    if (url.includes('/ext/info')) {
      return offline.includes(host)
        ? { ok: false, status: 503, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: 'NodeID-x' }) };
    }
    if (url.includes(`/ext/bc/${BLOCKCHAIN_ID}/rpc`)) {
      if (genesis?.unreachable) throw new Error('connect ECONNREFUSED');
      const body = JSON.parse(init.body);
      const result = body.method === 'eth_chainId'
        ? `0x${(genesis?.chainId ?? CHAIN_ID).toString(16)}`
        : { hash: genesis?.hash ?? GENESIS_HASH, number: '0x0' };
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
    }
    throw new Error(`假 fetch 没有覆盖这个地址：${url} —— 用例构造与实现已经漂移`);
  };
}

const run = ({ config, fetchImpl }) => precheck({
  client: emptyClient,
  pchain: noPChain,
  nodeId: target(config),
  config,
  subnetId: IDENTITY.subnetId,
  blockchainId: BLOCKCHAIN_ID,
  genesisHash: GENESIS_HASH,
  // 公开材料的第二个来源（创世那批的 bootstrapValidators）——
  // 少了它，"把退掉的创世成员加回来"会被误报成"声明里没有这一项"，
  // 所以 precheck 对它缺失直接抛（与 subnetId 同一条规矩）。
  chainIdentity: IDENTITY,
  fetchImpl,
});

describe('基线：不动任何东西时前置检查通过（否则下面三组全部恒真）', () => {
  test('声明原样 + 所有节点在线 + 创世一致 → ok', async () => {
    const pre = await run({ config: loadProtocol(), fetchImpl: fakeFetch() });
    assert.equal(pre.ok, true, `基线就不通过，三组用例证明不了任何事：\n  ${pre.problems.join('\n  ')}`);
  });
});

describe('FR-013：加入会让某个故障边界超过 ⌊n/4⌋ → 拦下', () => {
  test('把两个验证者塞进同一个边界后被拦下，且理由指向 T-5', async () => {
    const config = clone(loadProtocol());
    const dep = config.topology.deployments[config.topology.activeDeployment];
    // 把第二个边界的节点全并进第一个 —— 于是第一个边界的验证者数必然超限
    const [a, b] = dep.failureDomains;
    a.nodes = [...a.nodes, ...b.nodes];
    b.nodes = [];
    dep.failureDomains = dep.failureDomains.filter((d) => d.nodes.length);

    // 先确认这个构造真的违反了 T-5，否则下面的断言测的是别的东西
    const ft = deriveTopology(config).faultTolerance;
    assert.equal(ft.declaredWithinLimit, false, '构造没有真的违反 T-5 —— 用例失去意义');

    const pre = await run({ config, fetchImpl: fakeFetch() });
    assert.equal(pre.ok, false, 'T-5 越界必须拦下（FR-013）');
    assert.ok(pre.problems.some((p) => /T-5/.test(p)),
      `拦下了，但理由不是 T-5：\n  ${pre.problems.join('\n  ')}`);
  });
});

describe('FR-014：新节点跑在另一条链上 → 拦下', () => {
  test('创世区块哈希不一致时拦下，并报出两个哈希', async () => {
    const config = loadProtocol();
    const other = '0x'.padEnd(66, 'a');
    const pre = await run({ config, fetchImpl: fakeFetch({ genesis: { hash: other } }) });
    assert.equal(pre.ok, false, '创世哈希不一致必须拦下（FR-014）');
    const hit = pre.problems.find((p) => p.includes(other));
    assert.ok(hit, `拦下了，但没报出实际读到的哈希：\n  ${pre.problems.join('\n  ')}`);
    assert.ok(hit.includes(GENESIS_HASH), '也要报出基准哈希，否则看的人不知道该信哪个');
  });

  test('哈希一致而 chainId 不同时也拦下', async () => {
    const config = loadProtocol();
    const pre = await run({ config, fetchImpl: fakeFetch({ genesis: { chainId: 1 } }) });
    assert.equal(pre.ok, false, 'chainId 不一致必须拦下');
    assert.ok(pre.problems.some((p) => /chainId/.test(p)),
      `拦下了，但理由不是 chainId：\n  ${pre.problems.join('\n  ')}`);
  });

  test('**读不到也拦** —— "没核对"不是"核对通过"', async () => {
    const config = loadProtocol();
    const pre = await run({ config, fetchImpl: fakeFetch({ genesis: { unreachable: true } }) });
    assert.equal(pre.ok, false, '读不到创世信息时必须拦下，而不是当作通过');
    assert.ok(pre.problems.some((p) => /读不到/.test(p) && /track/.test(p)),
      `理由要说清读不到，并给出该去查什么：\n  ${pre.problems.join('\n  ')}`);
  });

  test('缺 blockchainId / genesisHash 直接抛，不静默跳过这条检查', async () => {
    const config = loadProtocol();
    await assert.rejects(
      () => precheck({
        client: emptyClient, pchain: noPChain, nodeId: target(config), config,
        subnetId: 'x', genesisHash: GENESIS_HASH, chainIdentity: IDENTITY, fetchImpl: fakeFetch(),
      }),
      /blockchainId/,
      '少了 blockchainId 时必须抛 —— subnetId 那次就是被 try 吞掉、检查静默消失',
    );
  });
});

describe('FR-015：恢复能力不可用（Primary 不全在线）→ 拦下', () => {
  test('一个 Primary 不应答就拦下，并指名是哪一个', async () => {
    const config = loadProtocol();
    const primary = deriveTopology(config).topologyNodes.find((n) => n.role === 'primary');
    const pre = await run({ config, fetchImpl: fakeFetch({ offline: [primary.address] }) });
    assert.equal(pre.ok, false, 'Primary 不全在线必须拦下（FR-015）');
    assert.ok(pre.problems.some((p) => p.includes(primary.id) && /两个都必须在线/.test(p)),
      `拦下了，但没指名是哪个 Primary：\n  ${pre.problems.join('\n  ')}`);
  });
});
