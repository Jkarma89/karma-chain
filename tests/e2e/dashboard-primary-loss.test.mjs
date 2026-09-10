// T038 —— 两个 Primary 全停时 L1 健康度不受影响（功能 003 / SC-007、FR-013、FR-014）。
//
// ## 背景：这是 002 唯一一处由实测倒逼修订判据的规则
//
// 5 个 L1 验证者带 `partial-sync-primary-network=true`，其节点自报的综合健康位
// **包含 P 链可达性**。002 实测（2026-09-06）：停掉两个 Primary 之后这些健康位
// 全部转为 false，`devnet-status` 报 "7/7 nodes NOT healthy"，
// **而链完全可用** —— 4 笔交易全部 1.0 秒确认、高度单调递增。
//
// 于是判据被改成"以本节点能否参与 L1 出块为准，不采用综合健康位"。
//
// ## 它在跨机形态下必然跳过，且这个缺口已被静态守卫补上
//
// 两个 Primary 分处 ubuntu-1 与 ubuntu-2，没有任何单台机器同时承载它们，
// 而 docker 只能操作本机容器。**原先这是 FR-013 唯一的守卫** —— 也就是说在实际的
// 五机部署上那条规则一个长期运行的守卫都没有（`/speckit-analyze` 查出的 C1）。
// 现在 `tests/unit/dashboard-boundaries.test.mjs` 静态禁止面板源码出现 `/ext/health`，
// 无论本文件是否跳过都会执行。本文件仍保留，因为静态守卫证明不了"停掉 Primary 后
// 链真的继续出块"这件事实。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pub, sendTx, sh, devnetAvailable, NODE_IDS, containerExists, localNodeIds } from './lib/devnet.mjs';
import { startDashboard, waitForSnapshot, waitFirstPoll } from './lib/dashboard.mjs';

const node = (...args) => sh('sh', ['scripts/devnet-node.sh', ...args]);

/** Primary 节点由角色相减得到，不写死名字（沿用 002 primary-network-loss 的做法）。 */
const PRIMARIES = NODE_IDS.filter((id) => !/^l1-/.test(id));
const LOCAL_PRIMARIES = PRIMARIES.filter(containerExists);

let SKIP;
if (!await devnetAvailable()) {
  SKIP = '开发网未运行 —— 先 scripts/devnet-start';
} else if (PRIMARIES.length < 2) {
  SKIP = `拓扑里的 Primary 节点少于 2 个（识别到：${PRIMARIES.join('、') || '无'}）—— 本场景不成立`;
} else if (LOCAL_PRIMARIES.length < PRIMARIES.length) {
  SKIP = `本机只承载 ${LOCAL_PRIMARIES.length}/${PRIMARIES.length} 个 Primary`
    + `（本机节点：${localNodeIds().join('、') || '无'}）—— docker 只能操作本机容器，`
    + ' 而跨机形态下两个 Primary 分处不同机器。FR-013 的静态守卫见'
    + ' tests/unit/dashboard-boundaries.test.mjs；人工做法见 quickstart 场景 F。';
}

describe('面板 —— 两个 Primary 全停时 L1 健康度不受影响', { skip: SKIP, concurrency: 1 }, () => {
  let dash;

  before(async () => {
    dash = await startDashboard();
    await waitFirstPoll(dash);
  });

  after(async () => {
    // Primary 是 P 链的持有者，不该留在停止状态
    for (const p of PRIMARIES) {
      try { node('start', p); } catch { /* 交给下一次 devnet-start */ }
    }
    await dash?.stop();
  });

  test('停掉全部 Primary 之后，L1 健康度仍 100%、档位 normal、链继续出块', async (t) => {
    const before = Number(await pub.getBlockNumber());
    for (const p of PRIMARIES) node('kill', p);
    t.diagnostic(`已停掉 ${PRIMARIES.join('、')}，L1 验证者未动`);

    // 给面板几轮时间把 Primary 的状态反映出来
    const { snapshot: s } = await waitForSnapshot(
      dash,
      (x) => PRIMARIES.every((p) => x.nodes.find((n) => n.id === p)?.reachable === false),
      { timeoutMs: 60_000, label: 'Primary 全部不可达' },
    );

    assert.equal(s.healthPercent, 100,
      'L1 健康度不得因 Primary 停止而下降 —— Primary 不参与 L1 出块（FR-014）');
    assert.equal(s.tier, 'normal');
    assert.equal(s.validatorMargin, 1);

    // 五个 L1 验证者必须仍被判为参与共识
    for (const n of s.nodes.filter((x) => x.countsTowardTolerance)) {
      assert.equal(n.participatesInConsensus, true,
        `${n.id} 不该因 P 链不可达而被判为不参与（这正是 002 实测过的那次误报）`);
    }

    // Primary 单独成组：不计入容错，但状态要可见
    for (const p of PRIMARIES) {
      const row = s.nodes.find((n) => n.id === p);
      assert.equal(row.countsTowardTolerance, false, `${p} 不得计入容错计算`);
      assert.equal(row.participatesInConsensus, false);
      assert.notEqual(row.state, 'healthy', `${p} 已停止，状态不该还是 healthy`);
    }

    // **面板说链正常，链就必须真的正常。**
    const height = await sendTx();
    assert.ok(height > before, `Primary 全停时 L1 应当继续出块：${before} -> ${height}`);
    t.diagnostic(`L1 继续出块：${before} → ${height}`);
  });

  test('Primary 回来之后，面板恢复全绿', async () => {
    for (const p of PRIMARIES) node('start', p);
    const { snapshot: s } = await waitForSnapshot(
      dash,
      (x) => PRIMARIES.every((p) => x.nodes.find((n) => n.id === p)?.state === 'healthy'),
      { timeoutMs: 180_000, label: 'Primary 恢复' },
    );
    assert.equal(s.tier, 'normal');
    assert.equal(s.healthPercent, 100);
  });
});
