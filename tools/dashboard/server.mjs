// tools/dashboard/server.mjs —— 面板服务（功能 003 / T021）。
//
// 链的**只读旁观者**：不参与共识、不持有链数据、不在崩溃恢复路径上。
// 只用 node 内建模块 —— 零新增依赖（宪法第十三条）。
//
// 用法：node tools/dashboard/server.mjs [--port <n>] [--interval <秒>] [--deployment <name>]
// 退出码：0 正常退出（收到终止信号）| 10 前置条件未满足 | 2 参数错误
//
// **本服务的退出码不表达链的健康状态。** 它是观察者，观察到"链停了"不构成它自己失败
// —— 那是 /api/snapshot 的内容。混淆两者会让"面板进程活着吗"与"链活着吗"无法分辨。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { loadContext, pollOnce, observerViewpoint } from './poll.mjs';
import { buildSnapshot } from './snapshot.mjs';
// 公开投影（US6）：显式字段白名单，方向刻意是挑出允许的而非删掉不允许的。
import { toPublicView } from './public-view.mjs';
// 唯一的写链路径，且只在收到 POST /api/probe 时调用（FR-033 / FR-034）。
// 密钥只活在 probe-tx.mjs 里 —— 本文件不 import 任何 viem 钱包接口，
// 由 tests/e2e/dashboard-readonly.test.mjs 静态断言。
import { probeChain, isProbeInFlight } from './probe-tx.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, 'public');

// FR-018 的预算推导，写成两个显式常量而不是一个魔法数：
//   发现时延 ≈ 轮询间隔 + 一轮探测的最坏耗时
// 一轮探测的最坏耗时由 node-status.mjs 的 `AbortSignal.timeout(4000)` 决定
// （不可达节点并行等满超时）。于是间隔上限 = 预算 − 探测超时。
const DETECTION_BUDGET_MS = 10_000;   // FR-018：≤ 10 秒
const PROBE_TIMEOUT_MS = 4_000;       // node-status.mjs 的 post() 超时
const MAX_INTERVAL_MS = DETECTION_BUDGET_MS - PROBE_TIMEOUT_MS;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export function parseArgs(argv = process.argv.slice(2)) {
  const at = (name) => {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const port = Number(at('--port') ?? process.env.KARMACHAIN_DASHBOARD_PORT ?? 21680);
  // 默认 5 秒（2026-09-10 按使用反馈从 2 改为 5：2 秒刷得太勤）。
  //
  // **预算仍然成立，但余量明显变薄** —— 发现时延 ≈ 间隔 + 一轮探测的最坏耗时：
  //   容器被 kill（端口立即拒连）→ 约 间隔 + 0.2s → 5.2s
  //   机器断电 / 静默丢包（等满探测超时）→ 约 间隔 + 4s → **9.1s**
  // 10 秒预算下最坏余量从约 4 秒降到约 0.9 秒。硬上限 MAX_INTERVAL_MS 未变（6 秒）。
  const intervalSeconds = Number(at('--interval') ?? process.env.KARMACHAIN_DASHBOARD_INTERVAL ?? 5);
  return { port, intervalSeconds, deployment: at('--deployment') };
}

/**
 * 间隔上限的校验。**拒绝启动而不是悄悄夹取** —— 悄悄改成合法值会让运维以为
 * 自己设的间隔生效了，而实际发现时延与他的预期不同。
 */
export function validateInterval(intervalSeconds) {
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    return `--interval 必须是正数，收到 ${intervalSeconds}`;
  }
  if (intervalSeconds * 1000 > MAX_INTERVAL_MS) {
    return `--interval ${intervalSeconds}s 超出上限 ${MAX_INTERVAL_MS / 1000}s。`
      + `发现时延 ≈ 间隔 + 一轮探测最坏耗时（${PROBE_TIMEOUT_MS / 1000}s，不可达节点等满超时），`
      + `必须 ≤ ${DETECTION_BUDGET_MS / 1000}s（FR-018）。`;
  }
  return null;
}

const json = (res, body, status = 200) => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
};

async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  // 归一化后必须仍在 public/ 内 —— 防目录穿越
  const full = normalize(join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403).end('forbidden'); return; }
  try {
    const body = await readFile(full);
    res.writeHead(200, {
      'content-type': MIME[extname(full)] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
  }
}

/**
 * 轮询循环。每轮结束时打戳并替换内存中的快照。
 *
 * **不持久化任何东西**：快照只活在进程内存里，进程退出即消失。
 * 面板是派生视图，不是链状态的第二个副本（宪法第一条）。
 */
export function createPoller({ ctx, intervalSeconds }) {
  const state = { snapshot: null, prevHeights: {}, stopped: false, rounds: 0 };

  const round = async () => {
    const started = Date.now();
    const polled = await pollOnce({
      nodes: ctx.nodes,
      blockchainId: ctx.blockchainId,
      prev: state.prevHeights,
      intervalSeconds,
    });
    const observer = await observerViewpoint({
      reachableNodes: polled.reachableNodes,
      totalNodes: ctx.nodes.length,
      domains: ctx.domains,
      publishedRpcPort: ctx.publishedRpcPort,
    });
    state.snapshot = buildSnapshot({
      // 在**探测完成时**打戳，不是请求到达时 —— 页面的新鲜度判定依赖它反映数据年龄
      collectedAt: Date.now(),
      pollIntervalMs: intervalSeconds * 1000,
      deployment: ctx.deployment,
      networkHeight: polled.networkHeight,
      rows: polled.rows,
      faultTolerance: ctx.faultTolerance,
      observer,
      chain: ctx.chain,
      baselineGenesisHash: ctx.baselineGenesisHash,
      containerFacts: {
        available: polled.containerFactsAvailable,
        reason: polled.containerFactsAvailable ? null : '缺失、旧格式或已过期（120 秒 TTL）',
      },
      summaryLine: polled.summaryLine,
    });
    state.prevHeights = polled.heights;
    state.rounds += 1;
    return Date.now() - started;
  };

  const loop = async () => {
    while (!state.stopped) {
      try {
        await round();
      } catch (err) {
        // 采集本身出错也不能让服务倒下 —— 那会让"面板挂了"与"链挂了"无法分辨。
        // 记一行日志，下一轮继续。
        process.stderr.write(`dashboard: 采集失败 —— ${err?.message ?? err}\n`);
      }
      await new Promise((r) => setTimeout(r, intervalSeconds * 1000));
    }
  };

  return { state, round, start: () => { loop(); }, stop: () => { state.stopped = true; } };
}

export function createDashboardServer({ ctx, intervalSeconds }) {
  const poller = createPoller({ ctx, intervalSeconds });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/api/snapshot') {
      // **恒返回 200。** 观测失败是快照的**内容**（observer.blind / tier=observer-blind），
      // 不是 HTTP 错误 —— 用 5xx 表达"我连不上节点"会让前端无法区分
      // "服务挂了"与"服务好着但看不见链"，而那两者正是 FR-020 要求区分的东西。
      if (!poller.state.snapshot) {
        // 首轮未完成。**不得**返回一个看起来正常的空快照。
        json(res, { collectedAt: null, tier: null, phase: 'first-poll', deployment: ctx.deployment });
        return;
      }
      json(res, poller.state.snapshot);
      return;
    }

    if (url.pathname === '/api/public') {
      // 同样恒 200。首轮未完成时投影会给出全 null 的骨架 —— 那本身就是诚实的答案。
      json(res, toPublicView(poller.state.snapshot ?? {}));
      return;
    }

    if (url.pathname === '/api/probe') {
      if (req.method !== 'POST') {
        // 刻意只接 POST：探活会向链写入，不该是一个 GET 能触发的东西
        // （浏览器预取、链接分享、爬虫都会发 GET）。
        json(res, { error: '探活须用 POST —— 它会向链写入（FR-035）' }, 405);
        return;
      }
      if (isProbeInFlight()) {
        json(res, {
          confirmed: null, blockNumber: null, elapsedMs: 0, txHash: null,
          error: '已有探活在进行中 —— 同一时刻只允许一笔在飞（避免 nonce 间隙）',
          busy: true,
        });
        return;
      }
      // 恒 200：链停了本来就该返回 confirmed:false，那是本端点的正常输出之一（SC-018）
      json(res, await probeChain());
      return;
    }

    if (req.method !== 'GET') { res.writeHead(405).end('method not allowed'); return; }
    await serveStatic(res, url.pathname);
  });

  return { server, poller };
}

async function main() {
  const opts = parseArgs();

  const bad = validateInterval(opts.intervalSeconds);
  if (bad) { process.stderr.write(`dashboard: ${bad}\n`); process.exit(2); }

  let ctx;
  try {
    ctx = loadContext({ deployment: opts.deployment });
  } catch (err) {
    process.stderr.write(`dashboard: 前置条件未满足 —— ${err?.message ?? err}\n`);
    process.exit(10);
  }

  const { server, poller } = createDashboardServer({ ctx, intervalSeconds: opts.intervalSeconds });

  server.on('error', (err) => {
    process.stderr.write(`dashboard: 无法监听 ${opts.port} —— ${err?.message ?? err}\n`);
    process.exit(1);
  });

  server.listen(opts.port, '0.0.0.0', () => {
    process.stdout.write(
      `dashboard: 监听 ${opts.port}，形态 ${ctx.deployment}，`
      + `${ctx.nodes.length} 个节点 / ${ctx.domains.length} 个边界，轮询 ${opts.intervalSeconds}s\n`,
    );
    poller.start();
  });

  const shutdown = () => {
    poller.stop();
    server.close(() => process.exit(0));
    // 兜底：连接没断干净也要退，别把 Ctrl-C 变成挂住
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  await main();
}
