// package.json 里那几条测试入口本身的正确性。
//
// ## 起因：e2e 套件必须串行
//
// `test:e2e` 原先是 `node --test "tests/e2e/**/*.test.mjs"`，而 **node 的测试运行器
// 默认按 CPU 数并行跑测试文件**。e2e 测试天生互斥 —— 每一个都在杀／删卷／重启**同一套**
// 共享开发网。并行跑的结果是它们互相把地基抽掉。
//
// 2026-09-09 实测（5 台机器的 lan 形态）：13 个文件里 7 个失败、耗时只有 29 分钟
// （串行本该 85 分钟以上，这个"太快"本身就是线索）。失败信息是
// `开发网不可用` 与 `test did not finish before its parent and was cancelled` ——
// 全是互踩，与被测系统无关。逐个单跑时它们都是通的。
//
// `describe(..., { concurrency: 1 })` **管不了这件事**：它只约束**文件内**的测试，
// 文件之间的并行度由命令行的 `--test-concurrency` 决定。这个区别是踩坑的核心，
// 而仓库里 8 个 e2e 文件都写着 `{ concurrency: 1 }`，看起来像已经处理过了。
//
// ## 为什么这里要**验证 node 真的接受那些标志**
//
// 本文件的初稿只用正则检查 package.json 里有没有 `--concurrency=1` 字样。
// 它**通过了** —— 而那个标志名是错的：node 的选项叫 `--test-concurrency`，
// 用 `--concurrency` 会直接 `node: bad option`，整个套件一秒都跑不起来。
// 也就是说：守卫是绿的，被守的东西是坏的。
//
// 同一教训在本会话里出现过第二次（第一次是 `Invoke-Quiet`）：
// **静态守卫只能证明"没用错写法"，证明不了"用对了"。** 因此这里额外把每个 node 标志
// 拿去和 `node --help` 的选项清单核对 —— 一次 spawn，能挡住整类拼错标志名的问题。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from '../../tools/protocol/load.mjs';

const scripts = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')).scripts ?? {};

/** node 支持的选项清单。用 --help 而不是硬编码，跟着实际运行的 node 版本走。 */
const nodeHelp = execFileSync(process.execPath, ['--help'], { encoding: 'utf8' });

/** 命令里传给 node 的标志（`node` 之后、第一个非 - 开头的实参之前）。 */
function nodeFlagsOf(cmd) {
  const parts = cmd.trim().split(/\s+/);
  if (parts[0] !== 'node') return [];
  const flags = [];
  for (const t of parts.slice(1)) {
    if (!t.startsWith('--')) break;      // 到达脚本／glob，标志段结束
    flags.push(t.split('=')[0]);
  }
  return flags;
}

describe('package.json 的测试入口', () => {
  test('test:e2e 必须串行跑文件（--test-concurrency=1）', () => {
    const s = scripts['test:e2e'];
    assert.ok(s, 'package.json 里应当有 test:e2e');
    assert.match(s, /--test-concurrency[= ]1\b/,
      `test:e2e 缺 --test-concurrency=1，实际："${s}"\n`
      + '  node --test 默认按 CPU 数**并行跑文件**，而 e2e 每一个都在杀／删卷／重启同一套\n'
      + '  共享开发网 —— 并行等于互相抽地基。2026-09-09 实测：13 个文件 7 个失败，\n'
      + '  失败信息全是"开发网不可用"与"cancelled"，与被测系统无关。\n'
      + '  注意 describe 里的 { concurrency: 1 } 管不了这件事：那只约束文件内的测试。');
  });

  test('每条测试入口传给 node 的标志都真实存在（挡住拼错标志名）', () => {
    const bad = [];
    for (const [key, cmd] of Object.entries(scripts)) {
      if (!key.startsWith('test')) continue;
      for (const f of nodeFlagsOf(cmd)) {
        if (!nodeHelp.includes(f)) bad.push(`${key}: ${f}`);
      }
    }
    assert.deepEqual(bad, [],
      `以下 node 标志在当前 node（${process.version}）的选项清单里不存在：\n  ${bad.join('\n  ')}\n`
      + '  拼错标志名会让 node 以 `bad option` 立即退出 —— 整个套件一秒都跑不起来，\n'
      + '  而只检查字符串的守卫会照样是绿的。本文件的初稿就是这么放过 --concurrency 的\n'
      + '（正确的名字是 --test-concurrency）。');
  });

  test('单元与集成入口不必串行 —— 它们不改动共享状态', () => {
    // 反向记录一笔：这两个入口**故意**保持并行，因为它们是只读的（集成里唯一会注入故障的
    // status-recovery-states 已按本机实况自行跳过）。若哪天它们也开始改共享状态，
    // 这条测试就是提醒"该考虑串行了"的位置。
    for (const key of ['test', 'test:integration']) {
      assert.ok(scripts[key], `package.json 里应当有 ${key}`);
    }
  });

  test('每条测试入口都指向 tests/ 下的路径，不会误扫全仓库', () => {
    for (const [key, cmd] of Object.entries(scripts)) {
      if (!key.startsWith('test')) continue;
      assert.match(cmd, /tests\//, `${key} 应当限定在 tests/ 下，实际："${cmd}"`);
    }
  });
});
