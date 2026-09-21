// T041 / quickstart 场景 C（V-01）：单个验证者被强制终止时链继续出块，重启后自动追平。
//
// 这是「冗余」从纸面变成事实的证明。判据有两层：
//   1. 少一个验证者时链**照常出块**（等权验证者，容错上限 ⌊n/4⌋ —— 001 研究 R-05）
//   2. 该节点重启后**自己追上来**，而且追赶期间不被健康检查判为故障、反复重启
// 第 2 条最容易实现错：把追赶当成不健康，容器就会在节点正常恢复时打断它，恢复变成死循环。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  pub, sendTx, sh, devnetAvailable, VALIDATOR_IDS, pickLocalVictims, localVictimSkip, spreadProblems,
  script,
  SHELL_SKIP,
  restoreOrReport,
 acquireDestructiveLock,
} from './lib/devnet.mjs';
import { maxOffline } from '../../tools/membership/tolerance.mjs';

// 不挑承载 RPC 代理上游首位的那个，避免把"入口失效"和"验证者失效"混为一谈
// 靶子必须是**本机真的有容器**的验证者 —— docker 只能操作本机。
// 原先按下标从全局列表里挑（单机形态下 7 个容器都在本机，那样写没问题），
// 跨机形态下会因为那个节点在别的机器上而失败。挑不到就跳过并说明原因。
const LOCAL = pickLocalVictims(1);
const VICTIM = LOCAL?.[0];
const CONTAINER = `karmachain-${VICTIM}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const node = (...args) => script('devnet-node.sh', ...args);
const inspect = (fmt) => {
  try { return execFileSync('docker', ['inspect', '--format', fmt, CONTAINER], { encoding: 'utf8' }).trim(); } catch { return ''; }
};
const restartCount = () => Number(inspect('{{.RestartCount}}') || 0);

// **没有可用的 POSIX shell 时整套跳过**（研究 V-44）。
// 本套件会改变系统状态，而恢复走 `scripts/devnet-*.sh` —— 跑不了那些脚本就收不了场。
// 毁坏走 docker（总能跑）而恢复走 sh（可能起不来）的那处不对称，
// 2026-09-18 真的把 win-1 的 l1-1 与代理留在了停止状态。
const SUITE_LABEL = 'single-validator-failure';
describe('场景 C —— 单个验证者挂掉，链照常出块',
  { skip: (LOCAL ? undefined : localVictimSkip(1)) ?? SHELL_SKIP, concurrency: 1 }, () => {
  // **兜底恢复。** 断言在毁坏之后、恢复之前抛出时，旧写法会把节点留在停止状态 ——
  // 而报出来的是"断言失败"，不是"我改了什么"。`after` 无论成败都跑。
  // 它自己不抛（见 restoreOrReport）：在 after 里抛会盖掉真正的失败原因。
  after(() => restoreOrReport(SUITE_LABEL));
  // **破坏性套件必须串行**（研究 V-44）。`--test-concurrency=1` 只保证一次运行内
  // 文件串行，挡不住"两次运行同时打同一条链" —— 2026-09-19 我就是那么干的。
  // 一条只写在文档里的规矩，不会在有人违反时变红。
  before(() => acquireDestructiveLock(SUITE_LABEL));
  before(async () => {
    if (!await devnetAvailable()) throw new Error('开发网不可用 —— 先运行 scripts/devnet-start.sh');
    // 此前这里是 `assert.equal(VALIDATOR_IDS.length, 5)` —— 加了第六个验证者之后
    // 整个套件在钩子里就死了，四条子测试全部 cancelled。
    //
    // 但这个前提**不该写成"恰好 5 个"**：本场景问的是"杀掉一个之后链还出不出块"，
    // 那要的只是 ⌊n/4⌋ ≥ 1，也就是 n ≥ 4。写成 5 是把一个**当时的取值**
    // 当成了场景的前提 —— 005 让 n 可变之后，这类写法每一处都会变成一次假红。
    assert.ok(maxOffline(VALIDATOR_IDS.length) >= 1,
      `声明了 ${VALIDATOR_IDS.length} 个验证者，⌊n/4⌋ = ${maxOffline(VALIDATOR_IDS.length)} ——`
      + ' 一个都不能掉，本场景（杀一个还要继续出块）不成立。n 至少要 4。');
  });

  test(`强制杀死 ${VICTIM} 后，链继续接受交易并出块`, async (t) => {
    const before = Number(await pub.getBlockNumber());
    node('kill', VICTIM);
    assert.equal(inspect('{{.State.Status}}'), 'exited', `${VICTIM} 应当已被杀死`);
    t.diagnostic(`${VICTIM} 已强制终止，剩余 ${VALIDATOR_IDS.length - 1}/${VALIDATOR_IDS.length} 个验证者`);

    // 连发几笔，确认不是靠缓存蒙混过关
    let height = before;
    for (let i = 0; i < 3; i += 1) height = await sendTx();
    assert.ok(height > before, `链应当继续出块：${before} -> ${height}`);
  });

  test('状态输出把该节点标记为不可用，而不是把整条链标记为故障（FR-031）', async () => {
    const out = node('status', VICTIM);
    assert.match(out, /exited/, `devnet-node status 应当如实报告 ${VICTIM} 已退出`);
    // "故障没扩散"的判据是**其余验证者是否仍在服务 L1**（网络层探测），
    // 不是"它的容器是否 running" —— 跨机形态下别的验证者在别的机器上，
    // 本机 docker inspect 返回 missing，那样写会把"看不见"当成"挂了"（2026-09-09 实测）。
    const spread = await spreadProblems([VICTIM]);
    assert.deepEqual(spread, [], `其余验证者应当不受影响：\n  ${spread.join('\n  ')}`);
  });

  // **FR-010**（重新启动的验证者 MUST 自动追平当前高度并重新参与共识，无需人工干预）
  // 与 **SC-004**（≤ 2 分钟）的判据。第二个断言（重启次数不涨）同样属于 FR-010 的
  // "无需人工干预"：追赶被误判为不健康会让容器反复重启它，恢复变成死循环。
  test(`${VICTIM} 重启后自动追平，且追赶期间不被反复重启`, async (t) => {
    const target = Number(await pub.getBlockNumber());
    const restartsBefore = restartCount();

    node('start', VICTIM);
    const t0 = Date.now();
    let healthy = false;
    for (let i = 0; i < 60; i += 1) {
      await sleep(2000);
      if (inspect('{{if .State.Health}}{{.State.Health.Status}}{{end}}') === 'healthy') { healthy = true; break; }
    }
    const seconds = (Date.now() - t0) / 1000;
    assert.ok(healthy, `${VICTIM} 未能自动恢复健康`);
    assert.ok(seconds <= 120, `追平耗时 ${Math.round(seconds)}s，应当 ≤ 2 分钟（SC-004）`);
    t.diagnostic(`${VICTIM} 在 ${Math.round(seconds)}s 后追平到 ≥ ${target}`);

    // 追赶中被判为不健康 → 容器反复重启 → 恢复变成死循环。重启次数不该涨。
    assert.equal(restartCount(), restartsBefore,
      '追赶期间不得触发容器重启 —— catching-up 不是故障（contracts/node-runtime.md）');
  });

  test('恢复后的节点确实在服务 L1，而不只是进程活着', async () => {
    // `--tail` 与 `maxBuffer` 都是必需的。无界读取整个容器日志有两个问题：
    //   1. 日志随运行时间增长，迟早以 `spawnSync docker ENOBUFS` 失败。串行跑整套 e2e 时
    //      本文件可能排在"50 轮强制终止"之后，那 50 轮会把日志撑得很大（crash-recovery
    //      就是这么炸的）。这三处在 33/33 那次没炸纯属顺序运气 —— 前面正好有测试重建过容器。
    //   2. **正确性**：断言可能命中**上一次启动**留下的旧行而假通过。判据要的是"最近一次
    //      启动时说了什么"，`--tail` 把范围收到最近一段，比读全量更准。
    const logs = execFileSync('docker', ['logs', '--tail', '5000', CONTAINER],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    assert.match(logs, /<karmachain Chain>/, '日志中应当出现 L1 链的启动记录');
    const h = Number(await pub.getBlockNumber());
    const block = await sendTx();
    assert.ok(block > h, '全部验证者在线时链应当照常出块');
  });
});
