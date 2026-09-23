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
        // 记**是哪几条**，不只是几条。2026-09-23 第三轮 e2e 就栽在这里：
        // 报"实际有 6 个样本带异常"，而没有任何信息说那 5 条异常是什么 ——
        // 失败无从判。`class:nodeId` 是稳定标识（incident 的形状见 snapshot.mjs）。
        incidents: s.incidents.map((i) => `${i.class}:${i.nodeId ?? ''}`).sort(),
      });
      await new Promise((r) => setTimeout(r, 1000));
    }

    const tiers = new Set(seen.map((x) => x.tier));
    const percents = new Set(seen.map((x) => x.percent));
    const heights = new Set(seen.map((x) => x.height));

    t.diagnostic(`${seen.length} 个样本：档位 ${[...tiers].join('/')}，百分比 ${[...percents].join('/')}%，高度 ${[...heights].join('/')}`);

    assert.deepEqual([...tiers], ['normal'],
      `空闲期间档位必须恒为 normal，实际出现过：${[...tiers].join('、')}`);
    // 2026-09-23：原先是 `assert.deepEqual([...percents], [100], '空闲期间百分比不得变化')`
    // —— 消息说"不得变化"，断言说"必须是 100"，**两件事被焊在了一起**。
    // 那一轮 e2e 里 60 个样本全是 88%（一个验证者当时不在参与），
    // 于是它名字里那个性质完全成立，却因为另一个它没声称的条件而红。
    // 本用例是 SC-008「空闲不出块不得报警」，与满不满员无关。
    assert.equal(percents.size, 1,
      `空闲期间百分比不得变化，实际出现过：${[...percents].join('、')}%`);
    // 不满员不算失败，但要**说出来** —— 否则读这份结果的人不知道它是在什么前提下绿的。
    const only = [...percents][0];
    if (only !== 100) {
      t.diagnostic(`注意：本轮百分比恒为 ${only}%（不是 100）——`
        + ' 有验证者不在参与，SC-008 仍成立，但这一轮不是在满员前提下量的');
    }
    assert.deepEqual([...heights], [startHeight],
      '本用例的前提是没有别人在发交易；高度变了说明链上有活动，此轮结果不作数');

    // 2026-09-23 第三轮：原先断言"全程零异常条目"，而本用例的性质是
    // **空闲不得「产生」报警**（SC-008 / 测试名里就是这么写的）。
    // 那一轮窗口开始时已经带着 5 条异常（上一条套件刚杀过又起过节点，余波未清），
    // 档位 normal、百分比 100%、高度不变 —— 空闲本身什么都没产生，它照样红。
    //
    // 等待条件只等到了 `tier === 'normal'`，而 normal 并不意味着异常清单已空。
    // 修法不是把等待条件改成"等到零异常"（真有一条常驻异常时那会超时，
    // 而超时读起来像面板坏了），而是**以窗口开始时的那一份为基线，断言不新增**。
    // 已有的那些如实报出来，让读结果的人知道这一轮是在什么前提下绿的。
    const baseline = new Set(seen[0].incidents);
    if (baseline.size) {
      t.diagnostic(`注意：窗口开始时已有 ${baseline.size} 条异常（${[...baseline].join('、')}）——`
        + ' 那是进入本用例之前就有的，不计入"空闲产生的报警"');
    }
    const added = seen
      .map((x) => ({ at: x.at, fresh: x.incidents.filter((k) => !baseline.has(k)) }))
      .filter((x) => x.fresh.length);
    assert.deepEqual(added, [],
      `空闲不得**产生**异常条目，实际新增：${added.map((x) => `${x.at}ms 出现 ${x.fresh.join('、')}`).join('；')}`);

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
