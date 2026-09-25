// SC-003 的正式验收：单个验证者不可用时，链在**连续 30 分钟、每分钟至少一笔交易**的
// 观测窗口内继续出块，成功率 100%。
//
// 与 `single-validator-failure.test.mjs` 的分工：那个测的是**行为**（杀掉后链还接不接受
// 交易、重启后能否追平），窗口只有几十秒；本文件测的是**持续性** —— 短窗口通过说明不了
// "连续半小时都不掉"，而 SC-003 要的正是后者。
//
// 判据（spec.md SC-003）：
//   - 每分钟至少一笔交易，全部确认（receipt status = 1）
//   - 成功率 **100%**，不是"大部分成功"
//   - 整个窗口内那个验证者始终不可用
//   - 其余 4 个验证者始终健康 —— 故障没有扩散
//
// 时长按 spec 取 30 分钟，可用 KARMACHAIN_SC003_MINUTES 缩短（沿用
// crash-recovery-repeat 的约定：日常回归可短跑，正式验收才跑满）。
//
// 本测试**制造并恢复**单验证者故障。1 个离线在容错上限内，链全程可用；
// 但余量为 0，因此期间不要再动别的节点。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  RPC, pub, sh, sendTx, devnetAvailable, attemptTx, TRANSPORT_BUDGET,
  spreadProblems,
  // 2026-09-25：这两个曾在一次改动里从导入列表掉出去，而它们在模块**顶层**被调用 ——
  // 于是整个文件在 import 阶段就 ReferenceError，一条断言都没跑，
  // 而 e2e 汇总里它只表现为"1 个失败"。**没跑过的测试和跑过并通过的测试，
  // 在总数上长得一样。** 守卫见 tests/unit/e2e-imports-resolve.test.mjs。
  pickLocalVictims, localVictimSkip,
  SHELL_SKIP,
  restoreOrReport,
 acquireDestructiveLock, requireFullMargin,
} from './lib/devnet.mjs';

const MINUTES = Number(process.env.KARMACHAIN_SC003_MINUTES ?? 30);
// 靶子必须是**本机真的有容器**的验证者 —— docker 只能操作本机。
// 原先按下标从全局列表里挑（单机形态下 7 个容器都在本机，那样写没问题），
// 跨机形态下会因为那个节点在别的机器上而失败。挑不到就跳过并说明原因。
const LOCAL = pickLocalVictims(1);
const VICTIM = LOCAL?.[0];

const docker = (...args) => {
  try { sh('docker', args); return true; } catch { return false; }
};
const containerState = (id) => {
  try { return sh('docker', ['inspect', '--format', '{{.State.Status}}', `karmachain-${id}`]).trim(); }
  catch { return 'missing'; }
};

const SKIP = !LOCAL ? localVictimSkip(1) : await devnetAvailable()
  ? undefined
  : `开发网未运行（${RPC}）—— 先执行 scripts/devnet-bootstrap 与 scripts/devnet-start`;

// **没有可用的 POSIX shell 时整套跳过**（研究 V-44）。
// 本套件会改变系统状态，而恢复走 `scripts/devnet-*.sh` —— 跑不了那些脚本就收不了场。
// 毁坏走 docker（总能跑）而恢复走 sh（可能起不来）的那处不对称，
// 2026-09-18 真的把 win-1 的 l1-1 与代理留在了停止状态。
const SUITE_LABEL = 'single-validator-window';
describe(`SC-003 —— 单验证者离线，${MINUTES} 分钟观测窗口`, { skip: SKIP ?? SHELL_SKIP, concurrency: 1 }, () => {
  // **兜底恢复。** 断言在毁坏之后、恢复之前抛出时，旧写法会把节点留在停止状态 ——
  // 而报出来的是"断言失败"，不是"我改了什么"。`after` 无论成败都跑。
  // 它自己不抛（见 restoreOrReport）：在 after 里抛会盖掉真正的失败原因。
  after(() => restoreOrReport(SUITE_LABEL));
  // **破坏性套件必须串行**（研究 V-44）。`--test-concurrency=1` 只保证一次运行内
  // 文件串行，挡不住"两次运行同时打同一条链" —— 2026-09-19 我就是那么干的。
  // 一条只写在文档里的规矩，不会在有人违反时变红。
  // 两条姊妹前提，缺一判据都不成立：
  //   锁   —— 现在只有我在动节点（V-44）
  //   满额 —— 我动手之前，别人没先把它弄坏（2026-09-23 那轮 e2e 的教训）
  before(async () => { acquireDestructiveLock(SUITE_LABEL); await requireFullMargin(SUITE_LABEL); });
  before(() => {
    assert.equal(containerState(VICTIM), 'running', `${VICTIM} 应当在运行，测试才有意义`);
  });

  after(() => {
    // 无论断言成败都把节点放回去：测试不该留下一个缺席的验证者
    docker('start', `karmachain-${VICTIM}`);
  });

  test(`杀死 ${VICTIM} 后，每分钟一笔交易连续 ${MINUTES} 分钟全部确认`, async (t) => {
    t.diagnostic(`预计耗时约 ${MINUTES} 分钟；窗口内 ${VICTIM} 始终离线`);

    const heightBefore = await pub.getBlockNumber();
    assert.ok(docker('kill', `karmachain-${VICTIM}`), `应能强制杀死 ${VICTIM}`);
    assert.notEqual(containerState(VICTIM), 'running', `${VICTIM} 应已停止`);

    const failures = [];
    const transport = [];   // 传输层问题单独计 —— 它说的是观测方的网络，不是链
    const heights = [];
    let sent = 0;

    for (let minute = 1; minute <= MINUTES; minute++) {
      const roundStart = Date.now();

      // 1) 本分钟的交易必须确认。
      //    原先这里写着：「SC-003 要的是 100%，因此**不重试** —— 重试会把"第一次失败"
      //    藏起来，而那恰恰是判据要抓的。」那条对**链给出的判决**（5xx、回执没来）成立，
      //    attemptTx 也确实不重试它们。
      //    但它覆盖不到"传输层根本没有应答"那一类 —— 2026-09-23 第四轮 e2e 里
      //    场景 F 就栽在这上面（第 30 分钟 `HTTP request failed`，无状态码，而链在出块）。
      //    那是**观测方到入口的链路**抖了一下，不是关于链的结论，而真实客户端会重试。
      //    所以：传输层重试一次，链侧零容忍，两类分开计。
      //    sendTx() 返回交易所在的**区块号**，并在回执非 success 时自己抛异常，
      //    因此拿到返回值即等于"已确认"（不要去读它的 .status —— 它不是 receipt 对象）。
      sent += 1;
      const r = await attemptTx(() => sendTx());
      if (r.ok) {
        heights.push(r.height);
        if (r.retried) transport.push(`第 ${minute} 分钟：首次无应答，重试后成功`);
      } else if (r.kind === 'chain') {
        // 失败的那一刻就是唯一能取证的时刻：把本机代理最近的日志一并记下来。
        // 2026-09-09 有一轮在第 5、6 分钟各失败一笔（回执超时 + 502），而事后查 nginx
        // 日志时已经没了 —— 排在最后的 T090 会删掉并重建 rpc 容器。那次只留下客户端侧
        // 一句 502，无从判断是代理耗尽了重试还是某个上游瞬时不可达。
        failures.push(`第 ${minute} 分钟：交易未确认（${String(r.error.message).slice(0, 160)}）`);
        t.diagnostic(`  第 ${minute} 分钟失败时，本机代理最近的日志：
${proxyTail(30)}`);
        try { heights.push(Number(await pub.getBlockNumber())); }
        catch { heights.push(heights.at(-1) ?? Number(heightBefore)); }   // 占位，保持与分钟对齐
      } else {
        transport.push(`第 ${minute} 分钟：入口无应答（重试后仍然）（${String(r.error.message).slice(0, 120)}）`);
        try { heights.push(Number(await pub.getBlockNumber())); }
        catch { heights.push(heights.at(-1) ?? Number(heightBefore)); }
      }

      // 3) 靶子必须全程离线 —— 否则这 30 分钟测的不是"单验证者离线"
      const st = containerState(VICTIM);
      if (st === 'running') failures.push(`第 ${minute} 分钟：${VICTIM} 又起来了（状态 ${st}），窗口不成立`);

      // 4) 故障不得扩散到其余验证者
      // 同上：按"是否仍在服务 L1"判断，不按容器状态 —— 30 分钟 × 4 个远端验证者
      // 曾因此报出 120 条假阳性，而那一轮的 30 笔交易其实全部确认。
      failures.push(...await spreadProblems([VICTIM], `第 ${minute} 分钟：`));

      if (minute % 5 === 0 || minute === 1) {
        t.diagnostic(`  第 ${minute}/${MINUTES} 分钟：高度 ${heights.at(-1)}，失败 ${failures.length} 次`);
      }

      // 补足到整分钟；最后一轮不必再等
      if (minute < MINUTES) {
        const wait = 60_000 - (Date.now() - roundStart);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
    }

    if (transport.length) {
      t.diagnostic(`传输层问题 ${transport.length} 次（预算 ${TRANSPORT_BUDGET}）：\n  ${transport.join('\n  ')}`);
    }

    // ① 链侧零容忍 —— 这才是 SC-003 要的那个 100%
    assert.deepEqual(failures, [],
      `成功率必须是 100%，实际有 ${failures.length}/${sent} 次问题：\n  ${failures.join('\n  ')}`);

    // ② 传输层超预算 → **此轮不作数**，而不是判产品有问题。
    //    本机到入口的链路反复断时，这一轮量到的是观测方的网络，不是链的可用性。
    assert.ok(transport.length <= TRANSPORT_BUDGET,
      `本机到 RPC 入口的链路在窗口内出问题 ${transport.length} 次（预算 ${TRANSPORT_BUDGET}）——`
      + `\n  **此轮结果不作数**：量到的是观测方的网络，不是链的可用性。先查本机网络再跑。`
      + `\n  ${transport.join('\n  ')}`);

    // 高度单调不减，且确实推进了（每分钟一笔交易 ⇒ 至少 MINUTES 个新区块）
    for (let i = 1; i < heights.length; i++) {
      assert.ok(heights[i] >= heights[i - 1],
        `高度回退：第 ${i} 分钟 ${heights[i - 1]} → 第 ${i + 1} 分钟 ${heights[i]}`);
    }
    assert.ok(heights.at(-1) >= Number(heightBefore) + MINUTES,
      `${MINUTES} 分钟内应至少新增 ${MINUTES} 个区块：${heightBefore} → ${heights.at(-1)}`);

    t.diagnostic(`窗口结束：${sent} 笔全部确认，高度 ${heightBefore} → ${heights.at(-1)}`);
  });

  test(`${VICTIM} 重启后追平，链恢复满余量`, async () => {
    assert.ok(docker('start', `karmachain-${VICTIM}`));
    // SC-004 已实测 6–17 秒；给到 120 秒仍未追平才是问题
    const deadline = Date.now() + 120_000;
    for (;;) {
      if (containerState(VICTIM) === 'running') {
        try { await sendTx(); break; } catch { /* 还没就绪，继续等 */ }
      }
      assert.ok(Date.now() < deadline, `120 秒内未恢复，${VICTIM} 状态 ${containerState(VICTIM)}`);
      await new Promise((r) => setTimeout(r, 5_000));
    }
    // 靶子在本机，查容器状态是有效的；其余验证者在别的机器上，只能问"是否仍在服务 L1"。
    // 这一处是同一个缺陷的最后一个残留 —— 我先修了窗口内的循环，漏了这个收尾的。
    assert.equal(containerState(VICTIM), 'running', `${VICTIM} 应当在运行`);
    const spread = await spreadProblems([VICTIM]);
    assert.deepEqual(spread, [], `链应恢复满余量，但：\n  ${spread.join('\n  ')}`);
  });
});
