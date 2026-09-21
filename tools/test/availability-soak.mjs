// tools/test/availability-soak.mjs —— SC-002 的现场探测（功能 005 / T022）。
//
// T022 要证的一句话：**在往拓扑里加一台机器的全过程中，链对外一直可用** ——
// 每 30 秒一笔交易、连续 10 分钟，**全部确认、零次 5xx**。
//
// ## 为什么复用 probe-tx 而不另写一套
//
// `tools/dashboard/probe-tx.mjs` 已经把这件事最难的部分做对了：走**对外的 RPC 入口**
// （本边界的代理，与第三方相同的位置）、沿 `error.cause` 链取 HTTP 状态码、
// 把密钥材料从错误文本里抹掉。再写一份只会得到一份判据不同的第二实现 ——
// 而"链能不能出块"的判据在本仓库只应有一处出处。
//
// ## 三个必须分开的结局
//
// 把它们混成一个"失败"计数，这份探测就废了：
//
//   - **确认** —— 交易进块且回执 success
//   - **5xx** —— 代理**活着**，但它背后没有健康上游。SC-002 数的正是这一类。
//   - **没有 HTTP 应答** —— 连接被拒 / 超时，是**我到代理这条路**的问题，
//     不能算进 5xx（003 的 probe-tx 为这条分辨写了整段注释，此处沿用同一条线）。
//   - **busy** —— 上一笔还在飞。它表示**节奏没守住**，是测量本身的失败，
//     不是链的失败。混进"链不可用"就是拿自己的测量误差去指控链。
//
// ## 节奏从每次尝试的起点计时
//
// "做完再睡 30 秒"会让一笔耗时 25 秒的交易把真实间隔拉到 55 秒 ——
// 于是"每 30 秒一笔、连续 10 分钟"这句话变成假的，而计数看起来完全正常。
// 所以下一次的触发时刻由 `startedAt + i * interval` 算出，不由上一次的结束时刻算出。
// 若某一轮迟到（上一笔跑得比间隔还久），**如实记下迟到多少**，不静默吸收。
//
// 用法：
//   node tools/test/availability-soak.mjs [--minutes=10] [--interval=30] [--out=<file>]
// 退出码：
//   0  SC-002 成立（全部确认 且 零次 5xx 且 节奏守住）
//   1  判据不成立（有未确认 或 有 5xx）—— 链侧的结论
//   2  测量本身没做到（节奏没守住 / 起不来）—— **不是**链的结论，别混
import { writeFileSync } from 'node:fs';
import { probeChain } from '../dashboard/probe-tx.mjs';
import { loadProtocol } from '../protocol/load.mjs';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};

const minutes = Number(arg('minutes', '10'));
const intervalSec = Number(arg('interval', '30'));
const outPath = arg('out', null);

if (!Number.isFinite(minutes) || minutes <= 0) {
  console.error('--minutes 必须是正数');
  process.exit(2);
}
if (!Number.isFinite(intervalSec) || intervalSec <= 0) {
  console.error('--interval 必须是正数');
  process.exit(2);
}

const intervalMs = intervalSec * 1000;
// 向上取整：10 分钟 / 30 秒 = 20 笔，含第 0 秒那一笔共 21 笔。
// 写成 +1 而不是让它凑巧 —— "连续 10 分钟"要求首尾两端都有采样。
const total = Math.floor((minutes * 60_000) / intervalMs) + 1;

/** 到某个绝对时刻为止的等待。迟到时立刻返回，并报出迟到多少。 */
async function waitUntil(deadline) {
  const lateBy = Date.now() - deadline;
  if (lateBy >= 0) return lateBy;
  await new Promise((r) => { setTimeout(r, deadline - Date.now()); });
  return 0;
}

const isServerError = (s) => Number.isInteger(s) && s >= 500 && s <= 599;

async function main() {
  // 装载一次，别让每一笔都去读盘 —— 十分钟里读 21 次同一份文件，
  // 任何一次读失败都会变成一个与链无关的"失败"。
  const protocol = loadProtocol();
  const rpcHint = `${protocol.endpoints.rpcPath}（入口端口 ${protocol.endpoints.hostRpcPort}）`;

  console.log(`SC-002 可用性探测：每 ${intervalSec} 秒一笔，共 ${total} 笔，覆盖 ${minutes} 分钟`);
  console.log(`经对外 RPC 入口：${rpcHint}`);
  console.log('');

  const startedAt = Date.now();
  const attempts = [];

  for (let i = 0; i < total; i += 1) {
    const lateBy = await waitUntil(startedAt + i * intervalMs);
    const at = new Date().toISOString();
    const r = await probeChain({ protocol });

    const outcome = r.busy ? 'busy'
      : r.confirmed === true ? 'confirmed'
        : isServerError(r.httpStatus) ? 'http5xx'
          : r.httpStatus != null ? `http${r.httpStatus}`
            : 'failed';

    attempts.push({
      seq: i + 1,
      at,
      lateByMs: lateBy,
      outcome,
      blockNumber: r.blockNumber,
      elapsedMs: r.elapsedMs,
      httpStatus: r.httpStatus ?? null,
      txHash: r.txHash,
      error: r.error,
    });

    const mark = outcome === 'confirmed' ? 'ok  ' : 'FAIL';
    const late = lateBy > 0 ? `  迟到 ${lateBy}ms` : '';
    const detail = outcome === 'confirmed'
      ? `块 ${r.blockNumber}  ${r.elapsedMs}ms`
      : `${outcome}  ${r.error ?? ''}`;
    console.log(`${mark} ${String(i + 1).padStart(3)}/${total}  ${at}  ${detail}${late}`);
  }

  const confirmed = attempts.filter((a) => a.outcome === 'confirmed').length;
  const http5xx = attempts.filter((a) => a.outcome === 'http5xx').length;
  const busy = attempts.filter((a) => a.outcome === 'busy').length;
  const noResponse = attempts.filter((a) => a.outcome === 'failed').length;
  const otherHttp = attempts.filter((a) => /^http(?!5)/.test(a.outcome)).length;
  // 节奏：允许的迟到上限取间隔的十分之一。超过它，"每 N 秒一笔"这句话就不再成立。
  const lateLimitMs = intervalMs / 10;
  const lateAttempts = attempts.filter((a) => a.lateByMs > lateLimitMs);
  const spanMs = Date.now() - startedAt;

  const summary = {
    startedAt: new Date(startedAt).toISOString(),
    spanMs,
    intervalSec,
    requestedMinutes: minutes,
    total,
    confirmed,
    http5xx,
    otherHttp,
    noResponse,
    busy,
    lateBeyondLimit: lateAttempts.length,
    lateLimitMs,
    maxLateByMs: attempts.reduce((m, a) => Math.max(m, a.lateByMs), 0),
  };

  console.log('');
  console.log(`共 ${total} 笔，跨 ${(spanMs / 60_000).toFixed(2)} 分钟`);
  console.log(`  确认           ${confirmed}`);
  console.log(`  5xx            ${http5xx}    ← SC-002 要求为 0`);
  console.log(`  其他 HTTP 错误 ${otherHttp}`);
  console.log(`  无 HTTP 应答   ${noResponse}`);
  console.log(`  busy（节奏）   ${busy}`);
  console.log(`  迟到超限       ${lateAttempts.length}（上限 ${lateLimitMs}ms，最大 ${summary.maxLateByMs}ms）`);

  if (outPath) {
    writeFileSync(outPath, `${JSON.stringify({ summary, attempts }, null, 2)}\n`);
    console.log(`\n证据已写入 ${outPath}`);
  }

  // 判决顺序有意如此：**先看测量自己做到了没有**。
  // 节奏没守住时，"全部确认"这句话覆盖的不是 10 分钟 —— 此时报"成立"是虚假的绿灯。
  if (busy > 0 || lateAttempts.length > 0) {
    console.error('\n测量本身没做到：节奏没守住 —— 这不是链的结论，不要当成 SC-002 不成立');
    process.exit(2);
  }
  if (confirmed !== total) {
    console.error(`\nSC-002 不成立：${total} 笔里只有 ${confirmed} 笔确认`);
    process.exit(1);
  }
  if (http5xx > 0) {
    console.error(`\nSC-002 不成立：出现 ${http5xx} 次 5xx`);
    process.exit(1);
  }
  console.log('\nSC-002 成立：全部确认，零次 5xx，节奏守住');
  process.exit(0);
}

main().catch((err) => {
  console.error(`探测起不来：${err?.message ?? err}`);
  process.exit(2);
});
