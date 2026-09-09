// quickstart 场景 I（V-08）：**两个 Primary Network 节点全停时，L1 是否继续出块。**
//
// 规格把这一条标为「本特性唯一一个『答案为否就要改设计』的场景」——
// 若 L1 会随 Primary 一起停，那 Primary 节点就是新的单点，会抵消 5 个验证者边界的冗余，
// 必须在阶段二之前追加 Primary 的冗余设计。
//
// ## 它已经跑过，结论是「继续出块」
//
// 2026-09-06 手工实测：停掉两个 Primary 之后，链 4 笔交易全部 1.0s 确认、高度单调递增。
// 但**同时**发现 5 个 L1 验证者的 `/ext/health` 全部转为不健康 —— 因为它们带
// `partial-sync-primary-network=true`，节点自报的综合健康位包含 P 链可达性。
// 这个发现直接决定了健康判据：**以"本节点能否参与 L1 出块"为准，不采用综合健康位**
// （`docker/node/healthcheck.sh`、`contracts/node-runtime.md` 都记着这条理由）。
//
// ## 为什么此前没有自动化测试，以及本文件补的是什么
//
// 场景 A–H 都有 e2e，只有 I 没有 —— 结论只活在一段脚本注释里，**没有回归守卫**。
// 若哪天有人改动 Primary 的角色或 partial-sync 标志而让 L1 依赖上 P 链，
// 没有任何测试会变红。本文件补上这道守卫。
//
// **它在跨机形态下必然跳过**，这是结构性的：T-5 保证每边界至多 1 个验证者，而两个 Primary
// 分处 ubuntu-1 与 ubuntu-2，**没有任何单台机器同时承载它们** —— 而 docker 只能操作本机容器。
// 与场景 D（超出容错上限，需要 2 个本地验证者）同样处境。跳过时说明原因并指向人工做法
// （docs/devnet.md §9.6），让缺口**可见**而不是静默消失 —— 这正是它此前的状态。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  pub, sendTx, sh, devnetAvailable, NODE_IDS, containerExists, localNodeIds,
} from './lib/devnet.mjs';

const node = (...args) => sh('sh', ['scripts/devnet-node.sh', ...args]);
const containerState = (id) => {
  try { return sh('docker', ['inspect', '--format', '{{.State.Status}}', `karmachain-${id}`]).trim(); }
  catch { return 'missing'; }
};

/** Primary 节点不是 l1-validator —— 由 active.env 的两个清单相减得到，不写死名字。 */
const PRIMARIES = (() => {
  const validators = new Set(
    (process.env.KARMACHAIN_VALIDATOR_IDS ?? '').split(' ').filter(Boolean),
  );
  // 环境变量通常不会设，退回 lib 导出的两个清单
  return NODE_IDS.filter((id) => !validators.has(id) && !/^l1-/.test(id));
})();

const LOCAL_PRIMARIES = PRIMARIES.filter(containerExists);

let SKIP;
if (!await devnetAvailable()) {
  SKIP = '开发网未运行 —— 先 scripts/devnet-start';
} else if (PRIMARIES.length < 2) {
  SKIP = `拓扑里的 Primary 节点少于 2 个（识别到：${PRIMARIES.join('、') || '无'}）—— 本场景不成立`;
} else if (LOCAL_PRIMARIES.length < PRIMARIES.length) {
  SKIP = `本机只承载 ${LOCAL_PRIMARIES.length}/${PRIMARIES.length} 个 Primary`
    + `（本机节点：${localNodeIds().join('、') || '无'}）—— docker 只能操作本机容器，`
    + ' 而跨机形态下两个 Primary 分处不同机器，没有单台机器能同时停掉它们。'
    + ' 人工做法见 docs/devnet.md 9.6（在两台机器上各 devnet-node kill）。';
}

describe('场景 I —— 两个 Primary Network 节点全停，L1 是否继续出块（V-08）',
  { skip: SKIP, concurrency: 1 }, () => {
    before(() => {
      for (const p of PRIMARIES) {
        assert.equal(containerState(p), 'running', `${p} 应当在运行，测试才有意义`);
      }
    });

    after(() => {
      // 无论断言成败都放回去 —— Primary 是 P 链的持有者，不该留在停止状态
      for (const p of PRIMARIES) {
        try { node('start', p); } catch { /* 交给下一次 devnet-start */ }
      }
    });

    test('停掉全部 Primary 之后，L1 仍然接受交易并出块', async (t) => {
      const before = Number(await pub.getBlockNumber());
      for (const p of PRIMARIES) node('kill', p);
      for (const p of PRIMARIES) {
        assert.notEqual(containerState(p), 'running', `${p} 应已停止`);
      }
      t.diagnostic(`已停掉 ${PRIMARIES.join('、')}，L1 验证者未动`);

      // 连发几笔，确认不是靠缓存蒙混过关。
      //
      // **这是本场景的全部意义所在**：这几笔若失败，说明 Primary 是单点，
      // 5 个验证者分处 5 个边界的冗余会被它抵消 —— 那时必须改设计，
      // 而不是把测试改宽（quickstart 场景 I 的原话）。
      let height = before;
      for (let i = 0; i < 3; i += 1) height = await sendTx();
      assert.ok(height > before,
        `Primary 全停时 L1 应当继续出块：${before} -> ${height}。`
        + '若这里失败，Primary 节点就是新的单点，必须追加 Primary 的冗余设计（quickstart 场景 I）');
      t.diagnostic(`L1 继续出块：高度 ${before} → ${height}`);
    });

    test('Primary 回来之后，链照常', async () => {
      for (const p of PRIMARIES) node('start', p);
      const h = Number(await pub.getBlockNumber());
      const block = await sendTx();
      assert.ok(block > h, '全员归队后链应当照常出块');
      for (const p of PRIMARIES) {
        assert.equal(containerState(p), 'running', `${p} 应当在运行`);
      }
    });
  });
