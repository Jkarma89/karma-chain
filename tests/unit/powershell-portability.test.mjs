// PowerShell 薄封装的可移植性守卫。
//
// 契约（001 cli-interface.md）要求 `.ps1` 与 `.sh` 是**等价**的薄封装。但等价不只是逻辑等价 ——
// 2026-09-08 实测发现两类只在 **Windows PowerShell 5.1** 上出现的故障，而它们在 pwsh 7 下都不复现，
// 因此从未被察觉（我一直用 pwsh 7 验证，而运维方用的是系统自带的 5.1）。
//
// ## 一、缺 UTF-8 BOM 会让 5.1 按 GBK 解码，并**吞掉换行**
//
// UTF-8 的中文是 3 字节，GBK 按 2 字节配对。若某行注释在换行前的字节数为**奇数**，
// GBK 就会把最后一个字节与行尾的 `\n`(0x0A) 配成一个字符 —— 换行被吃掉，**下一行被并进注释**。
//
// 实际后果：`devnet-bootstrap.ps1` 第 1 行是中文注释（121 字节，奇数），于是第 2 行
// `. (Join-Path $PSScriptRoot '_devnet-common.ps1')` 被并进注释、从未执行 →
// `Get-DevnetContext` 未定义 → `$ctx` 为 null → `$bootstrap` 为 null →
// `docker compose -f  run --rm bootstrap` 把 `run` 当成 `-f` 的值 → 报 `unknown flag: --rm`。
// 三个看似无关的错误其实是同一个根因的连锁。
//
// 更危险的是它**看字节数运气**：`devnet-topology.ps1` 第 1 行恰好 84 字节（偶数），
// 所以它一直是好的 —— 这种"侥幸通过"比全体失败更难发现。
//
// ## 二、`2>$null` 抑制不住原生命令的 stderr
//
// 配合 `$ErrorActionPreference='Stop'`，docker 写到 stderr 的内容会变成 NativeCommandError
// 并打印一大段红字。跨机形态下每台机器只承载本边界的节点，而脚本遍历 active.env 里
// **全部** 7 个节点 id，于是每轮轮询有 6 个必然失败 —— 启动过程会被刷屏，真正的失败被埋掉。
// 统一改用 `_devnet-common.ps1` 的 `Invoke-Quiet`（`2>&1` 合流 + 退出码判断）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { REPO_ROOT } from '../../tools/protocol/load.mjs';

const SCRIPTS = resolve(REPO_ROOT, 'scripts');
const ps1Files = readdirSync(SCRIPTS).filter((f) => f.endsWith('.ps1')).sort();
const BOM = Buffer.from([0xEF, 0xBB, 0xBF]);

describe('PowerShell 脚本在 Windows PowerShell 5.1 上的可移植性', () => {
  test('存在 .ps1 脚本可测 —— 否则本套件在空转', () => {
    assert.ok(ps1Files.length >= 10, `期望至少 10 个 .ps1，实际 ${ps1Files.length}`);
  });

  test('每个 .ps1 都以 UTF-8 BOM 开头', () => {
    const missing = ps1Files.filter((f) => !readFileSync(join(SCRIPTS, f)).subarray(0, 3).equals(BOM));
    assert.deepEqual(missing, [],
      `以下 .ps1 缺 UTF-8 BOM：${missing.join(', ')}\n`
      + '  Windows PowerShell 5.1 对无 BOM 的文件按系统 ANSI 代码页（中文环境为 GBK）解码。\n'
      + '  中文注释被误解码时可能吞掉行尾换行，把下一行代码并进注释 —— 静默失效，且看字节数运气。\n'
      + '  修法：在文件开头写入 EF BB BF。');
  });

  test('不使用 2>$null 抑制原生命令的 stderr —— 用 Invoke-Quiet', () => {
    const offenders = [];
    for (const f of ps1Files) {
      const lines = readFileSync(join(SCRIPTS, f), 'utf8').split('\n');
      // 只看代码行。必须同时跳过行注释与**块注释** `<# ... #>` ——
      // helper 自身的文档里正是在解释这个写法为什么不可靠，那不是违规。
      let inBlockComment = false;
      lines.forEach((line, i) => {
        if (/<#/.test(line)) inBlockComment = true;
        const wasInBlock = inBlockComment;
        if (/#>/.test(line)) inBlockComment = false;
        if (wasInBlock || /^\s*#/.test(line)) return;
        if (line.includes('2>$null')) offenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 90)}`);
      });
    }
    assert.deepEqual(offenders, [],
      `以下位置用 2>$null 抑制原生命令的 stderr，它不可靠：\n  ${offenders.join('\n  ')}\n`
      + '  改用 _devnet-common.ps1 的 Invoke-Quiet { ... }（2>&1 合流 + 退出码判断）。');
  });

  test('Invoke-Quiet 存在于公共模块，且引用它的脚本都点引用了该模块', () => {
    const common = readFileSync(join(SCRIPTS, '_devnet-common.ps1'), 'utf8');
    assert.match(common, /function Invoke-Quiet/, '公共模块应定义 Invoke-Quiet');

    for (const f of ps1Files) {
      if (f === '_devnet-common.ps1') continue;
      const src = readFileSync(join(SCRIPTS, f), 'utf8');
      if (!src.includes('Invoke-Quiet')) continue;
      assert.match(src, /_devnet-common\.ps1/,
        `${f} 用了 Invoke-Quiet 但没有点引用 _devnet-common.ps1`);
    }
  });

  test('每个 .sh 都有同名 .ps1，反之亦然（契约要求等价薄封装）', () => {
    const shNames = readdirSync(SCRIPTS).filter((f) => f.endsWith('.sh')).map((f) => f.replace(/\.sh$/, '')).sort();
    const psNames = ps1Files.filter((f) => !f.startsWith('_')).map((f) => f.replace(/\.ps1$/, '')).sort();
    assert.deepEqual(psNames, shNames,
      `.sh 与 .ps1 不成对：\n  只有 .sh：${shNames.filter((n) => !psNames.includes(n)).join(', ') || '（无）'}`
      + `\n  只有 .ps1：${psNames.filter((n) => !shNames.includes(n)).join(', ') || '（无）'}`);
  });
});
