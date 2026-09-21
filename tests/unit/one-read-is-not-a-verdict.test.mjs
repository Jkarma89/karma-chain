// **一次读失败不是判决**（研究 V-53，2026-09-21）。
//
// ## 同一个形状，本期撞到三次
//
// | 哪里 | 一次读失败被当成了什么 |
// |---|---|
// | `spreadProblems` | 第 8 分钟三台机器各"不可达"一次 → **「故障扩散了」**，而那 30 笔交易全部确认 |
// | `dashboard-genesis-parity` | 某一轮 `genesisHash` 为 `null` → **「它跑在另一条链上」**，而同一时刻直接问它答得好好的 |
// | `waitForSnapshot` | 一次 `fetch failed` → 整个套件 hookFailed，而单独跑它 5/5 通过 |
//
// 三处的结论都很重（故障扩散 / 分叉 / 服务挂了），而**从一次读失败得不出它们**。
//
// 004 早就记过这个形状：「本机连不上它，但网络里其他节点与它有连接 ——
// 是本机到它的网络路径问题，不是节点故障」。三处都没照着做。
//
// ## 修法不是放宽断言
//
// 是**把观测做到与说法一样强**：重探一次、或等到读得到再判。
// 放宽断言会让真故障也溜过去；而重探只是让"读到了"这件事成立之后再下结论。
//
// ## 本文件按源码断言
//
// 真跑一遍要几十分钟且要真的打掉节点 —— 一条"为了验证重试存在而去制造故障"的测试，
// 代价不对。这里守的是**那三处确实做了复核**，而不是它们复核得对不对
//（后者由它们各自的活链运行覆盖）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from '../../tools/protocol/load.mjs';

const read = (rel) => readFileSync(resolve(REPO_ROOT, rel), 'utf8');
const DEVNET = read('tests/e2e/lib/devnet.mjs');
const DASHBOARD = read('tests/e2e/lib/dashboard.mjs');
const PARITY = read('tests/e2e/dashboard-genesis-parity.test.mjs');

describe('① spreadProblems：可疑的要复核，两次都不成才算', () => {
  test('有第二次探测', () => {
    const body = DEVNET.slice(DEVNET.indexOf('export async function spreadProblems'));
    const end = body.indexOf('\n}\n');
    const fn = body.slice(0, end);
    assert.match(fn, /const suspect =/,
      '必须先挑出"看起来不好的那几个" —— 否则每一轮都要多探一遍全部节点');
    assert.match(fn, /if \(!suspect\.length\) return \[\]/,
      '没有可疑对象时必须直接返回：正常路径上不该有任何额外开销');
    assert.match(fn, /await validatorsServing\(excludeIds\)[\s\S]{0,400}await validatorsServing\(excludeIds\)/,
      '只探了一次 —— 那样一次网络抖动就会被报成「故障扩散了」，'
      + '而 2026-09-19 实测那一轮的 30 笔交易全部确认');
  });

  test('结论里说清"复核过"', () => {
    assert.match(DEVNET, /复核仍然如此/,
      '报出来的话要让人知道这是**两次**观测的结论，而不是一次');
  });
});

describe('② 创世一致性：等到读得到再判，且 null ≠ 不符', () => {
  test('断言之前先等"每个可达验证者都读到创世"', () => {
    assert.match(PARITY, /const withGenesis = /,
      '要有一个"都读到了"的谓词，并等到它成立');
    // **按出现次数断言，不是"有没有出现过"。**
    // 第一版只要求出现一次 —— 而那个文件里有两处判据都依赖"读到了"，
    // 于是把其中一处的等待拿掉，守卫照旧全绿（变红检查抓到）。
    // 一个只要求"某处做了"的守卫，挡不住"另一处没做"。
    const waits = PARITY.split('waitForSnapshot(dash, withGenesis').length - 1;
    assert.ok(waits >= 2,
      `只有 ${waits} 处等待 —— 两条依赖"读到了"的判据各要一处：`
      + '「哈希都等于基准」与「不报创世未知」。漏掉的那处就是下一次假分叉');
  });

  test('null 与 false 分开说 —— 前者是读不到，后者才是分叉', () => {
    assert.match(PARITY, /assert\.notEqual\(n\.genesisMatchesBaseline, null/,
      'null 要单独断言并单独说话：probeNode 的注释写着'
      + '「null（未知）与不匹配是两件事，不得混淆」');
    assert.match(PARITY, /这不是分叉，是取不到/,
      'null 的那句话不能说成"跑在另一条链上" —— 分叉是本仓库最重的结论之一');
  });
});

describe('③ waitForSnapshot：读失败照旧计时，但不当判决', () => {
  test('读失败被接住并记下根因', () => {
    assert.match(DASHBOARD, /const readErrors = \[\]/, '要把读失败逐次记下来');
    assert.match(DASHBOARD, /err\?\.cause\?\.code/,
      '`fetch failed` 把根因藏在 cause 里 —— 不取出来，超时报告就没有线索');
  });

  test('**超时仍然会报**，并带上那些根因（容忍，不掩盖）', () => {
    const fn = DASHBOARD.slice(DASHBOARD.indexOf('export async function waitForSnapshot'));
    assert.match(fn, /throw new Error\(/,
      '一直读不到时必须抛 —— 容忍一次抖动，不等于永远不报');
    assert.match(fn, /读快照失败 \$\{readErrors\.length\} 次/,
      '报错里要带上读失败的次数与根因，否则"真故障"与"抖了一下"在输出里长得一样');
  });
});
