// tests/e2e/lib/dashboard.mjs —— 面板 e2e 的共用件（功能 003）。
//
// 面板服务在**进程内**起（import createDashboardServer），不经 docker 包装。
// 理由：这些 e2e 要验的是"快照能否在 10 秒内反映链的变化"，那属于
// server + poll + snapshot 三者；docker 包装（-p / --network / 镜像）由 V-01 逐台人工验。
// 进程内起还让轮询节奏可控 —— 否则测的是容器启动时间。
import { createDashboardServer, parseArgs } from '../../../tools/dashboard/server.mjs';
import { loadContext } from '../../../tools/dashboard/poll.mjs';

/**
 * 起一个面板实例。端口由系统分配，不占用 21680，也不影响运行中的面板。
 *
 * 轮询间隔**默认跟随生产默认值**（`parseArgs([])`），不写死 ——
 * 于是这些 e2e 验的是**用户实际跑的那个间隔**。若日后有人把默认值调到
 * 违反 FR-018 的程度，dashboard-detection 的 ≤10 秒断言会直接变红，
 * 而不是继续在一个测试专用的间隔上全绿。
 */
export async function startDashboard({ intervalSeconds = parseArgs([]).intervalSeconds } = {}) {
  const ctx = loadContext();
  const { server, poller } = createDashboardServer({ ctx, intervalSeconds });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  poller.start();
  return {
    ctx,
    base,
    poller,
    snapshot: () => fetch(`${base}/api/snapshot`, { signal: AbortSignal.timeout(15_000) }).then((r) => r.json()),
    async stop() {
      poller.stop();
      await new Promise((r) => server.close(r));
    },
  };
}

/**
 * 等到快照满足条件，返回 { snapshot, elapsedMs, samples }。
 *
 * 以 200ms 高频**读取**（读的是内存里的快照，不触发新一轮探测），
 * 所以测出来的是"面板显示改变"的真实时刻，而不是被轮询节奏量化后的结果。
 */
export async function waitForSnapshot(dash, predicate, { timeoutMs = 30_000, label = '' } = {}) {
  const started = Date.now();
  const samples = [];
  for (;;) {
    const s = await dash.snapshot();
    samples.push({ at: Date.now() - started, tier: s.tier, healthPercent: s.healthPercent });
    if (s.collectedAt != null && predicate(s)) {
      return { snapshot: s, elapsedMs: Date.now() - started, samples };
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `等待「${label}」超时（${Math.round((Date.now() - started) / 1000)}s）。`
        + `观察到的档位序列：${samples.map((x) => `${x.at}ms:${x.tier}/${x.healthPercent}%`).join(' → ')}`,
      );
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** 等到第一轮采集完成 —— 之后的断言才有意义。 */
export const waitFirstPoll = (dash) =>
  waitForSnapshot(dash, (s) => s.collectedAt != null, { timeoutMs: 30_000, label: '首轮采集' });
