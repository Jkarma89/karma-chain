// **测试套件自身的接线方式**是否正确 —— 不测被测系统，只测"测试是怎么跑起来的"。
// 目前两块：package.json 的测试入口（并行度、标志名），以及测试代码读取容器日志的方式。
// 这类缺陷的共同点是**它们不会让任何被测功能变红**，只会让套件变成噪声或在某种顺序下炸掉。
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
import { readdirSync, readFileSync } from 'node:fs';
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
  // e2e 与 integration 都要串行；unit 不用（见下一条）。
  for (const key of ['test:e2e', 'test:integration']) {
    test(`${key} 必须串行跑文件（--test-concurrency=1）`, () => {
      const s = scripts[key];
      assert.ok(s, `package.json 里应当有 ${key}`);
      assert.match(s, /--test-concurrency[= ]1\b/,
        `${key} 缺 --test-concurrency=1，实际："${s}"\n`
      + '  node --test 默认按 CPU 数**并行跑文件**，而 e2e 每一个都在杀／删卷／重启同一套\n'
      + '  共享开发网 —— 并行等于互相抽地基。2026-09-09 实测：13 个文件 7 个失败，\n'
      + '  失败信息全是"开发网不可用"与"cancelled"，与被测系统无关。\n'
        + '  注意 describe 里的 { concurrency: 1 } 管不了这件事：那只约束文件内的测试。');
    });
  }

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

  test('单元入口可以并行 —— 它确实不碰共享状态', () => {
    // 反向记录一笔，而这一次是**量过**的。
    //
    // 本文件初稿写的是"单元与集成入口不必串行 —— 它们不改动共享状态"。那句话对集成而言
    // 是错的，而我当时没有去查：`tests/integration/start-stop.test.mjs` 会发交易、部署合约
    // （改链高度与合约数量），另有 5 个文件会动容器（docker kill / devnet-stop / devnet-node）。
    // 与读取活链的 list-contracts 并发跑，正好解释了 2026-09-09 那次偶发失败 ——
    // 同一套件重跑与单跑各 7/7，只在并行时挂过一次。所以集成也改成串行了。
    //
    // 单元入口保持并行是**查过**的：它们只读文件、跑 git ls-files、spawn 一次 `node --help`，
    // 以及一个写在各自 mkdtemp 临时目录里的 PowerShell 探针 —— 没有共享可写状态。
    // 若哪天单元测试开始碰活链或容器，这条就是提醒改串行的位置。
    assert.ok(scripts.test, 'package.json 里应当有 test');
    assert.doesNotMatch(scripts.test, /tests\/(integration|e2e)/,
      '单元入口不该扫到 integration／e2e —— 那两类会改动共享状态，必须走各自的串行入口');
  });

  test('每条测试入口都指向 tests/ 下的路径，不会误扫全仓库', () => {
    for (const [key, cmd] of Object.entries(scripts)) {
      if (!key.startsWith('test')) continue;
      assert.match(cmd, /tests\//, `${key} 应当限定在 tests/ 下，实际："${cmd}"`);
    }
  });
});

// 测试代码读取容器日志时必须**有界**。
//
// `docker logs <c>` 不加 `--tail` 会返回整个日志，而日志随容器运行时间增长。
// execFileSync 的默认缓冲是 1MB，超了就是 `spawnSync docker ENOBUFS` —— 测试失败，
// 而失败原因与被测系统毫无关系。
//
// 2026-09-09 实测：串行跑整套 e2e 时，`crash-recovery` 排在"50 轮强制终止"之后，
// 那 50 轮把节点日志撑大，于是它以 ENOBUFS 失败。**并行跑时两者从未相邻过，所以这个
// 顺序依赖是串行化之后才暴露的。** 事后扫全库又发现三处一模一样的写法，它们那一轮
// 恰好没炸 —— 因为前面正好有测试重建过容器（新容器日志从零开始）。纯属顺序运气。
//
// 除了缓冲，`--tail` 还有个**正确性**理由：读全量意味着断言可能命中**上一次启动**
// 留下的旧行而假通过。判据通常是"最近一次启动时说了什么"，收到最近一段反而更准。
//
// 这是一条**静态**守卫（只检查两个参数在不在）。行为性的版本要先造出一个 >1MB 的容器日志
// 才能触发 ENOBUFS，代价远大于收益 —— 这里如实标明它的性质，不假装它验证了行为。
describe('测试代码读取容器日志的方式', () => {
  const testFiles = [];
  for (const dir of ['tests/unit', 'tests/integration', 'tests/e2e', 'tests/e2e/lib']) {
    let entries = [];
    try { entries = readdirSync(resolve(REPO_ROOT, dir)); } catch { continue; }
    for (const f of entries) {
      if (f.endsWith('.mjs')) testFiles.push([`${dir}/${f}`, readFileSync(resolve(REPO_ROOT, dir, f), 'utf8')]);
    }
  }

  test('存在测试文件可扫 —— 否则本套件在空转', () => {
    assert.ok(testFiles.length >= 15, `期望至少 15 个测试文件，实际 ${testFiles.length}`);
  });

  test("每处 docker logs / compose logs 都同时带 --tail 与 maxBuffer", () => {
    const offenders = [];
    for (const [path, src] of testFiles) {
      src.split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return;                    // 注释行不算
        if (!/'logs'|"logs"/.test(line)) return;                   // 只看真的在取日志的
        if (!/execFileSync|spawnSync|sh\(/.test(line)) return;
        // 参数可能换行，往后看 3 行
        const stmt = src.split('\n').slice(i, i + 4).join(' ');
        const missing = [];
        if (!/--tail/.test(stmt)) missing.push('--tail');
        if (!/maxBuffer/.test(stmt)) missing.push('maxBuffer');
        if (missing.length) offenders.push(`${path}:${i + 1} 缺 ${missing.join(' 与 ')}：${line.trim().slice(0, 80)}`);
      });
    }
    assert.deepEqual(offenders, [],
      `以下位置无界读取容器日志：\n  ${offenders.join('\n  ')}\n`
      + '  日志随运行时间增长，execFileSync 默认缓冲 1MB —— 超了就是 spawnSync docker ENOBUFS，\n'
      + '  失败原因与被测系统无关。2026-09-09 实测：crash-recovery 排在"50 轮强制终止"之后即炸。\n'
      + '  另外 --tail 还能把断言收到"最近一次启动"，避免命中旧行而假通过。');
  });
});
