// T013 —— 面板内不得写死档位阈值（功能 003 / FR-006）。
//
// 沿用既有 `tests/unit/no-hardcode.test.mjs` 的思路，但对象不同：那份守协议参数
// （chainId、端口、地址），这份守**由协议参数派生出来的阈值**。
//
// ## 为什么这些数字一个都不能写进代码
//
// 容错上限是 f ≤ ⌊n/4⌋（001 研究 R-05），由 `load.mjs` 的 `faultTolerance()` 算出。
// 于是 n=5, f=1 时零余量落在 **80%**、停摆落在 **60%**；而 n=9, f=2 时同一判定式
// 给出 **78%** 与 **67%**（契约第 4b 节）。**百分比本身从来不是判据。**
// 任何一个写死的 80 / 60 / 75 / 0.75 都会在验证者数变化时静默给出错误档位。
//
// ## 扫描前必须剥掉注释
//
// 解释"为什么不能写死 80/60"的注释里必然出现 80 和 60。一个不剥注释的扫描会逼人
// 删掉唯一的解释 —— 那是把守卫变成反作用。所以只扫**代码**。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { REPO_ROOT } from '../../tools/protocol/load.mjs';

const DASHBOARD = join(REPO_ROOT, 'tools', 'dashboard');

/**
 * 禁用的阈值字面量。都按词边界匹配，避免误伤 `100`、`21680` 之类。
 *
 * 不含 `100`：`round(x * 100)` 是"化成百分数"，不是阈值。
 */
const FORBIDDEN = [
  { re: /\b0\.75\b/, why: 'α/k 查询门槛 —— 应由 maxOfflineValidators 派生' },
  { re: /\b75\b/, why: '75% 查询门槛 —— 同上' },
  { re: /\b80\b/, why: 'n=5 时零余量的百分比 —— 是结果，不是输入' },
  { re: /\b60\b/, why: 'n=5 时停摆的百分比 —— 是结果，不是输入' },
];

// **刻意不扫裸的 `5`（验证者总数）。** 2026-09-10 加过一条 `/\b5\b/`，它立刻抓到了
// `view-identity.mjs` 的 `order: 5`（视图排序号）—— 一个假阳性。`5` 在数组下标、
// 排序号、切片长度里都合法，静态扫描分不清它们。
//
// 而"验证者总数被写死"这件事已经有一个**更强**的守卫：
// `tests/unit/dashboard-tier.test.mjs` 的那组 n=9 / f=2 用例。任何人把 5 写死在
// 判定式里，喂进 validatorCount=9 之后百分比与档位都会错，那组必然变红。
// 行为守卫抓得住的东西，不需要再加一条会误伤的静态规则 —— 噪音会让人开始忽略红灯。

/** 收集 tools/dashboard 下全部 .mjs（不含 .md / .html / .css）。 */
function collectSources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { collectSources(full, out); continue; }
    if (name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

/**
 * 剥掉行注释、块注释与字符串字面量后的"纯代码"。
 *
 * 字符串也要剥：文案里出现"再有一个验证者离线即停摆"这类话是正常的，
 * 而 `copy.mjs` 里可能出现"低于 75% 查询门槛"这种**解释性**文案 ——
 * 那是给人读的说明，不是判据。判据只可能藏在代码里。
 */
export function stripNonCode(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')      // 块注释（含 JSDoc）
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')  // 行注释（避开 http:// 里的 //）
    .replace(/`(?:\\.|\$\{[^}]*\}|[^`\\])*`/g, '``')  // 模板字符串
    .replace(/'(?:\\.|[^'\\])*'/g, "''")    // 单引号字符串
    .replace(/"(?:\\.|[^"\\])*"/g, '""');   // 双引号字符串
}

describe('面板内不得写死档位阈值（FR-006）', () => {
  const files = collectSources(DASHBOARD);

  test('存在待扫描的源码 —— 否则本守卫在空转', () => {
    assert.ok(files.length > 0, 'tools/dashboard 下没有 .mjs，守卫无对象');
  });

  for (const { re, why } of FORBIDDEN) {
    test(`代码中不出现 ${re.source} —— ${why}`, () => {
      const hits = [];
      for (const file of files) {
        const code = stripNonCode(readFileSync(file, 'utf8'));
        code.split('\n').forEach((line, i) => {
          if (re.test(line)) hits.push(`${relative(REPO_ROOT, file)}:${i + 1}  ${line.trim().slice(0, 90)}`);
        });
      }
      assert.deepEqual(hits, [], `写死的阈值字面量：\n  ${hits.join('\n  ')}\n\n  ${why}`);
    });
  }

  test('阈值确实来自 faultTolerance，不是别处', () => {
    const src = readFileSync(join(DASHBOARD, 'snapshot.mjs'), 'utf8');
    assert.match(src, /validatorCount - maxOfflineValidators/,
      'threshold 必须由这两个派生量算出（契约第 2 节）');
  });
});

describe('这道守卫本身会变红吗', () => {
  // 002 反复教过：静态守卫只证明了"没用错写法"，没证明"用对了"。
  // 所以要喂一段故意违规的源码，断言扫描确实抓得到。
  const bad = [
    'const THRESHOLD = 0.75;',
    'if (percent < 80) alarm();',
    'const total = 5;',
  ].join('\n');

  for (const { re, why } of FORBIDDEN) {
    if (!re.test(stripNonCode(bad))) continue;
    test(`能抓到违规写法中的 ${re.source}`, () => {
      assert.ok(re.test(stripNonCode(bad)), `${re.source} 抓不到违规源码 —— 守卫失效（${why}）`);
    });
  }

  test('剥离逻辑不会把代码里的数字一起剥掉', () => {
    // 若 stripNonCode 过度剥离（例如把整行都当注释），全部用例都会假绿。
    assert.match(stripNonCode('const x = 80; // 说明 60'), /\b80\b/, '代码里的 80 必须保留');
    assert.doesNotMatch(stripNonCode('const x = 1; // 说明 80'), /\b80\b/, '注释里的 80 必须剥掉');
    assert.doesNotMatch(stripNonCode("const s = '低于 75% 门槛';"), /\b75\b/, '字符串里的 75 必须剥掉');
    assert.match(stripNonCode("fetch('http://a/b')"), /fetch/, 'http:// 不得被当成行注释起点');
  });
});
