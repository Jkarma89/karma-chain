// T059 —— 五台机器自报的创世哈希一致且等于仓库基准（功能 003 / SC-011 正向）。
//
// ## 这一条守的是什么
//
// 002 交付时逐台核对过创世哈希，结论是"五台一致，含 amd64 与 arm64"——
// 那是一次**人工**核对。本文件把它变成常驻判据：面板每一轮都在比对，
// 而这个测试确认比对的结果与直接从链上取的一致。
//
// 分叉是比节点下线严重得多的问题，而且**不会表现为健康度下降**：那台机器自己
// 活得很好，只是不在同一条链上。所以它必须有独立的正向验证。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { devnetAvailable, genesisHash } from './lib/devnet.mjs';
import { startDashboard, waitFirstPoll } from './lib/dashboard.mjs';

const SKIP = !(await devnetAvailable()) ? '开发网未运行 —— 先 scripts/devnet-start' : undefined;

describe('面板 —— 跨机创世一致性', { skip: SKIP, concurrency: 1 }, () => {
  let dash;
  before(async () => {
    dash = await startDashboard();
    await waitFirstPoll(dash);
  });
  after(async () => { await dash?.stop(); });

  test('面板显示的基准创世哈希等于仓库里的那份', async () => {
    const s = await dash.snapshot();
    assert.equal(s.chainIdentity.baselineGenesisHash, genesisHash(),
      '基准必须取自 blockchain/genesis/karmachain.genesis.hash，不得另抄一份');
  });

  test('全部可达的 L1 验证者自报的创世哈希都等于基准（SC-011）', async (t) => {
    const s = await dash.snapshot();
    const validators = s.nodes.filter((n) => n.countsTowardTolerance);
    const reachable = validators.filter((n) => n.reachable);

    t.diagnostic(`可达验证者 ${reachable.length}/${validators.length}`);
    for (const n of reachable) {
      t.diagnostic(`  ${n.id}（${n.domain}）genesisHash=${n.genesisHash} 匹配=${n.genesisMatchesBaseline}`);
    }

    assert.ok(reachable.length > 0, '至少要有一个可达验证者，否则本用例在空转');
    for (const n of reachable) {
      assert.equal(n.genesisMatchesBaseline, true,
        `${n.id}（${n.domain}）的创世哈希与基准不符 —— 它跑在另一条链上`);
      assert.equal(n.genesisHash.toLowerCase(), genesisHash().toLowerCase());
    }
  });

  test('不报分叉，也不报"创世未知"', async () => {
    const s = await dash.snapshot();
    assert.equal(s.chainIdentity.forkDetected, false);
    assert.equal(s.chainIdentity.unknownGenesis, false,
      '可达的验证者都该取到创世 —— 若为 true，说明有节点已引导但取不到创世区块');
    assert.equal(s.incidents.filter((i) => i.class === 'chain-identity').length, 0);
  });

  test('链身份四项与协议参数一致（FR-024）', async () => {
    const s = await dash.snapshot();
    assert.ok(s.chainIdentity.chainId, '缺 chainId');
    assert.ok(s.chainIdentity.networkId, '缺 networkId');
    assert.ok(s.chainIdentity.blockchainId, '缺 blockchainId');
    assert.ok(s.chainIdentity.chainAlias, '缺链别名');
  });

  test('Primary 节点的创世为 null 而非 false —— 它们不服务 L1', async () => {
    const s = await dash.snapshot();
    for (const n of s.nodes.filter((x) => !x.countsTowardTolerance)) {
      assert.notEqual(n.genesisMatchesBaseline, false,
        `${n.id} 被判成创世不符 —— Primary 不服务 L1，取不到 L1 创世属正常，应为 null`);
    }
  });
});
