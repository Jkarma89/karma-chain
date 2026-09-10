// T025 —— 链空闲、高度不变时，面板不得呈现为故障（功能 003 / SC-008、FR-015）。
//
// ## 为什么这一条必须有测试
//
// KarmaChain **无交易不出块**。空闲时高度本就一动不动 —— 而"高度停滞"是监控面板
// 最容易顺手写进判据的信号。写进去之后，链完全正常的每一个空闲夜晚都会报警；
// 报警一旦开始骗人，就再没人看它了。
//
// 002 把这一条写进了 `contracts/node-runtime.md`（`catching-up` 刻意不以"在增长"为条件），
// 本文件把它守在面板这一侧。
//
// 窗口默认 60 秒（约 30 轮轮询）。**10 分钟的完整判据在 quickstart 场景 G 手工执行** ——
// 自动化里挂十分钟不值得，但一个都不挂就等于没测。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pub, devnetAvailable } from './lib/devnet.mjs';
import { startDashboard, waitForSnapshot, waitFirstPoll } from './lib/dashboard.mjs';

const WINDOW_MS = Number(process.env.KARMACHAIN_IDLE_WINDOW_MS ?? 60_000);

const SKIP = !(await devnetAvailable()) ? '开发网未运行 —— 先 scripts/devnet-start' : undefined;

describe('面板 —— 空闲不出块不得报警', { skip: SKIP, concurrency: 1 }, () => {
  let dash;
  before(async () => {
    dash = await startDashboard();
    await waitFirstPoll(dash);
  });
  after(async () => { await dash?.stop(); });

  test(`空闲 ${WINDOW_MS / 1000}s：高度不变，档位与百分比逐样本相同、无异常条目（SC-008）`, async (t) => {
    // 先等到一个稳定的满员状态再开始观察 —— 否则可能把上一个测试的余波算进来
    const { snapshot: first } = await waitForSnapshot(
      dash, (s) => s.tier === 'normal', { label: '稳定的 normal' },
    );
    const startHeight = first.networkHeight;
    t.diagnostic(`起始高度 ${startHeight}，档位 ${first.tier}/${first.healthPercent}%`);

    const seen = [];
    const started = Date.now();
    while (Date.now() - started < WINDOW_MS) {
      const s = await dash.snapshot();
      seen.push({
        at: Date.now() - started,
        tier: s.tier,
        percent: s.healthPercent,
        height: s.networkHeight,
        incidents: s.incidents.length,
      });
      await new Promise((r) => setTimeout(r, 1000));
    }

    const tiers = new Set(seen.map((x) => x.tier));
    const percents = new Set(seen.map((x) => x.percent));
    const heights = new Set(seen.map((x) => x.height));

    t.diagnostic(`${seen.length} 个样本：档位 ${[...tiers].join('/')}，百分比 ${[...percents].join('/')}%，高度 ${[...heights].join('/')}`);

    assert.deepEqual([...tiers], ['normal'],
      `空闲期间档位必须恒为 normal，实际出现过：${[...tiers].join('、')}`);
    assert.deepEqual([...percents], [100], '空闲期间百分比不得变化');
    assert.deepEqual([...heights], [startHeight],
      '本用例的前提是没有别人在发交易；高度变了说明链上有活动，此轮结果不作数');

    const withIncidents = seen.filter((x) => x.incidents > 0);
    assert.deepEqual(withIncidents, [],
      `空闲不得产生异常条目，实际有 ${withIncidents.length} 个样本带异常`);

    // 链确实一个块都没出 —— 这是"高度停滞"的直接证据，也是本用例成立的前提
    assert.equal(Number(await pub.getBlockNumber()), startHeight,
      '窗口内高度应当完全不变（无交易不出块）');
  });

  test('界面上有一句"按需出块"的说明 —— 让看的人知道高度不动是正常的（FR-015）', async () => {
    // **为什么断言的是机制的两半，而不是渲染后的 DOM**：文案的唯一出处是 copy.mjs
    // （那样 tests/unit/dashboard-copy 才测得到"不得出现某些话"），由 app.mjs 注入。
    // 断言渲染结果需要一个真浏览器，那不该进自动化套件。所以这里分别验证
    // ①文案存在且送得出去 ②页面有它的挂载点 —— 两半都在，注入就一定发生。
    // 实际的**视觉**确认在 quickstart 场景 G。
    const html = await (await fetch(`${dash.base}/`, { signal: AbortSignal.timeout(10_000) })).text();
    assert.match(html, /id="on-demand-note"/, '首页必须有那句说明的挂载点');
    assert.match(html, /<script type="module" src="\.\/app\.mjs">/, '必须加载会填充它的模块');

    const copy = await (await fetch(`${dash.base}/copy.mjs`, { signal: AbortSignal.timeout(10_000) })).text();
    assert.match(copy, /按需出块/, 'copy.mjs 必须含那句说明');
    assert.match(copy, /高度长时间不变是正常的/,
      '要直说"高度不变是正常的" —— 否则每个第一次看面板的人都会怀疑链卡住了');
  });
});
