// package.json 里那几条测试入口本身的正确性。
//
// 起因：`test:e2e` 原先是 `node --test "tests/e2e/**/*.test.mjs"`，而 **node 的测试运行器
// 默认按 CPU 数并行跑测试文件**。e2e 测试天生互斥 —— 每一个都在杀／删卷／重启**同一套**
// 共享开发网。并行跑的结果是它们互相把地基抽掉。
//
// 2026-09-09 实测（5 台机器的 lan 形态）：13 个文件里 7 个失败、耗时只有 29 分钟
// （串行本该 85 分钟以上，这个"太快"本身就是线索）。失败信息是
// `开发网不可用` 与 `test did not finish before its parent and was cancelled` ——
// 全是互踩，与被测系统无关。逐个单跑时它们都是通的。
//
// `describe(..., { concurrency: 1 })` **管不了这件事**：它只约束**文件内**的测试，
// 文件之间的并行度由命令行的 `--concurrency` 决定。这个区别是这次踩坑的核心。
//
// 守卫它的理由：`--concurrency=1` 看起来像个可以"清理掉"的多余标志，
// 而去掉它不会让任何测试变红 —— 只会让 e2e 套件变成不可复现的噪声。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from '../../tools/protocol/load.mjs';

const scripts = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')).scripts ?? {};

describe('package.json 的测试入口', () => {
  test('test:e2e 必须串行跑文件（--concurrency=1）', () => {
    const s = scripts['test:e2e'];
    assert.ok(s, 'package.json 里应当有 test:e2e');
    assert.match(s, /--concurrency[= ]1\b/,
      `test:e2e 缺 --concurrency=1，实际："${s}"\n`
      + '  node --test 默认按 CPU 数**并行跑文件**，而 e2e 每一个都在杀／删卷／重启同一套\n'
      + '  共享开发网 —— 并行等于互相抽地基。2026-09-09 实测：13 个文件 7 个失败，\n'
      + '  失败信息全是"开发网不可用"与"cancelled"，与被测系统无关。\n'
      + '  注意 describe 里的 { concurrency: 1 } 管不了这件事：那只约束文件内的测试。');
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
