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
/**
 * **一次读失败不是答案。**
 *
 * 这个函数的职责是"等到快照满足条件"，而一次 `fetch` 失败只说明**这一次没读到** ——
 * 它既不能证明条件不成立，也不能证明服务挂了。旧写法让它直接抛，于是一次瞬时失败
 * 就把整个套件判死。
 *
 * 2026-09-19 的全量 e2e 里，`面板 —— 跨机创世一致性` 就是这么红的：钩子里
 * `fetch failed`，套件报 hookFailed，而**单独跑它 5/5 通过**。
 * 2026-09-21 复现：同样两套连跑，第一次红在**另一套**上，第二次两套全过 ——
 * 间歇性。（面板的轮询循环本身有 try/catch，注释还写明"采集出错也不能让服务倒下"，
 * 所以"进程被打掉"那个假设已被代码证伪。）
 *
 * ## 容忍，但**不掩盖**
 *
 * 读失败照旧计入超时窗口，并**逐次记下根因**（`err.cause.code` —— `fetch failed`
 * 把它藏在里面）。持续读不到时超时，报错里带上那些根因 ——
 * 于是一次抖动被容忍，而一次真正的故障仍然会响，且带着可查的线索。
 */
export async function waitForSnapshot(dash, predicate, { timeoutMs = 30_000, label = '' } = {}) {
  const started = Date.now();
  const samples = [];
  const readErrors = [];
  for (;;) {
    let s = null;
    try {
      s = await dash.snapshot();
    } catch (err) {
      const cause = err?.cause?.code ?? err?.cause?.message ?? err?.message ?? String(err);
      readErrors.push({ at: Date.now() - started, cause: String(cause).slice(0, 60) });
    }
    if (s) {
      samples.push({ at: Date.now() - started, tier: s.tier, healthPercent: s.healthPercent });
      if (s.collectedAt != null && predicate(s)) {
        return { snapshot: s, elapsedMs: Date.now() - started, samples, readErrors };
      }
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `等待「${label}」超时（${Math.round((Date.now() - started) / 1000)}s）。`
        + `观察到的档位序列：${samples.map((x) => `${x.at}ms:${x.tier}/${x.healthPercent}%`).join(' → ')}`
        + (readErrors.length
          ? `。**读快照失败 ${readErrors.length} 次**：`
            + `${readErrors.slice(-5).map((e) => `${e.at}ms:${e.cause}`).join('、')}`
          : ''),
      );
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** 等到第一轮采集完成 —— 之后的断言才有意义。 */
export const waitFirstPoll = (dash) =>
  waitForSnapshot(dash, (s) => s.collectedAt != null, { timeoutMs: 30_000, label: '首轮采集' });
