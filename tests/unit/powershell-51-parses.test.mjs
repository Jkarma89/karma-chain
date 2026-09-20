// 每个 `.ps1` 都必须能被 **Windows PowerShell 5.1** 解析（2026-09-20 实地撞到）。
//
// ## 事情是怎么发生的
//
// 在 win-2 上跑 `.\scripts\devnet-node.ps1 restart l1-2`：
//
//   所在位置 …\devnet-node.ps1:26 字符: 5
//   +     | Where-Object { $_ -and $_.ToString().Trim() } | ForEach-Object …
//   不允许使用空管道元素。
//   + FullyQualifiedErrorId : EmptyPipeElement
//
// **整个脚本解析不了** —— 不是某一行失败，是它根本没开始跑。
// 成因：5.1 不接受以 `|` 开头的续行，而 PowerShell 7 接受。
//
// ## 我见过这个报错，然后放过去了
//
// 两天前我用 5.1 做语法检查时，它就报了同一行同一句。我当时判断成
//「5.1 对 `@(…)` 里的换行管道更严」，换 `pwsh`（7.x）过了就继续 ——
// **那不是"更严"，那是真的语法错**。而两台 Windows 机器上跑的都是 5.1。
//
// 与 DoD 第 15 条同族：**拿到一个「你的前提可能不成立」的信号，然后没去验。**
//
// ## 为什么是"真解析"而不是"扫几个模式"
//
// 5.1 与 7 的差异不止一条：行首 `|` 续行、`&&` / `||` 管道链、`??`、三元 `? :`
// 都是 7 才有的。列一张模式表只能守住我**想得到**的那几条，
// 而想不到的那条恰恰是会出事的那条。所以直接让 5.1 自己去解析。
//
// 没有 `powershell.exe` 的机器（Linux / macOS / CI）**带理由跳过** ——
// 跳过时要说清「这一轮没有验过 5.1」，而不是让它看起来像通过。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from '../../tools/protocol/load.mjs';

const HELPER = resolve(REPO_ROOT, 'tools/test/parse-ps51.ps1');

/** 仓库里所有要在 Windows 上跑的 .ps1。 */
const scripts = readdirSync(resolve(REPO_ROOT, 'scripts'))
  .filter((f) => f.endsWith('.ps1'))
  .map((f) => resolve(REPO_ROOT, 'scripts', f));

/** Windows PowerShell 5.1 在不在。**`pwsh` 不算** —— 它是 7.x，正是看不见这个错的那个。 */
const winPowerShell = (() => {
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
      encoding: 'utf8', timeout: 20_000,
    });
    if (r.status !== 0) return null;
    const major = Number(String(r.stdout).trim());
    return Number.isFinite(major) ? { cmd: 'powershell', major } : null;
  } catch { return null; }
})();

const skipReason = winPowerShell
  ? undefined
  : '本机没有 Windows PowerShell（powershell.exe）—— **这不是通过**：'
    + '这一轮没有验过 .ps1 能否被 5.1 解析。'
    + '两台 Windows 机器上跑的是 5.1，而 pwsh 7 看不见它特有的语法错。';

describe('夹具前提', () => {
  test('确实扫到了一批 .ps1（否则下面那条空跑）', () => {
    assert.ok(scripts.length >= 10,
      `只扫到 ${scripts.length} 个 .ps1 —— 目录结构大概变了，而那会让这条守卫变成空跑`);
  });
});

describe('每个 .ps1 都能被 Windows PowerShell 解析', { skip: skipReason }, () => {
  test(`用本机的 powershell（主版本 ${winPowerShell?.major ?? '?'}）逐个解析，零语法错`, () => {
    const r = spawnSync(winPowerShell.cmd, ['-NoProfile', '-File', HELPER, ...scripts, HELPER], {
      encoding: 'utf8', timeout: 120_000,
    });
    const lines = String(r.stdout ?? '').trim().split('\n').filter(Boolean);
    assert.deepEqual(lines, [],
      '这些 .ps1 在本机的 PowerShell 下解析不了：\n  '
      + lines.map((l) => {
        const [file, line, ...msg] = l.split('|');
        return `${file.slice(REPO_ROOT.length + 1)}:${line} ${msg.join('|')}`;
      }).join('\n  ')
      + '\n\n  **解析不了 = 整个脚本跑不起来**，不是某一行失败。'
      + '\n  5.1 与 7 的常见差异：行首 `|` 续行（改成把 `|` 放行尾）、'
      + '`&&` / `||` 管道链、`??`、三元 `? :` —— 后三者 5.1 都没有。');
  });

  test('**确认用的确实是 5.1 那一支**（用 7.x 验等于没验）', () => {
    assert.equal(winPowerShell.major, 5,
      `本机的 powershell 是 ${winPowerShell.major}.x。这条守卫要的是 **Windows PowerShell 5.1** ——\n`
      + '  两台 Windows 机器上跑的是它，而 7.x 能解析的 5.1 未必能。\n'
      + '  在 5.x 缺席的机器上，本套件应当**跳过并说明**，而不是用 7.x 冒充。');
  });
});
