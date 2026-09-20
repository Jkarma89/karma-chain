// 测试里不许**裸起** `sh` / `bash`（研究 V-43，2026-09-19 补全）。
//
// ## 为什么
//
// Windows 上这两个名字都不可靠：
//
//   PowerShell> Get-Command bash → C:\Windows\system32\bash.exe   ← **WSL 的启动器**
//   PowerShell> Get-Command sh   → 不在 PATH 里
//
// 裸起的后果分两种，**都不是"脚本的行为"**：
//
//   `sh`   → `spawnSync sh ENOENT`，测试报一个与被测内容无关的失败
//   `bash` → 起到 WSL 去，它看到的是另一套文件系统，脚本路径必然 127
//
// 而这些套件判的恰恰是**脚本自己的退出码与输出**。
//
// ## 这条守卫是**补**的，而那正是它存在的理由
//
// 2026-09-19 第一次修这个类别时，我只改了当时报红的两个文件 ——
// 没有扫一遍还有谁也这么写。两天后 `npm run test:secrets` 在 PowerShell 下报红，
// 而它是**密钥扫描**：一条报红的密钥扫描，人的第一反应是"泄漏了"，
// 不是"shell 没找到"。当时还剩两个文件没改。
//
// **修了看见的症状，没有修那个类别。** 这条守卫把"类别"变成可执行的。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { REPO_ROOT } from '../../tools/protocol/load.mjs';

/** 递归列出 tests/ 下的 .mjs（含 lib/）。 */
const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.mjs')) out.push(full);
  }
  return out;
};

/**
 * **本文件自己要排除** —— 它下面那张 BARE 表里就是这些字面量。
 *
 * 排除按文件名，而且**只许排除这一个**：下一条断言钉住了这件事。
 * 一个会悄悄变宽的例外，等于把守卫慢慢关掉。
 */
const SELF = 'no-bare-shell-spawn.test.mjs';

const ALL = walk(resolve(REPO_ROOT, 'tests'));
const FILES = ALL.filter((f) => !f.endsWith(SELF));

/** 裸起的几种写法。`posix-shell.mjs` 自己不算（它就是那个解析器）。 */
const BARE = [
  "spawnSync('sh'",
  'spawnSync("sh"',
  "spawnSync('bash'",
  'spawnSync("bash"',
  "execFileSync('sh'",
  'execFileSync("sh"',
  "execFileSync('bash'",
  'execFileSync("bash"',
  "spawn('sh'",
  "spawn('bash'",
];

describe('夹具前提', () => {
  test('只排除了本文件自己，一个不多', () => {
    assert.equal(ALL.length - FILES.length, 1,
      `排除了 ${ALL.length - FILES.length} 个文件 —— 只该排除 ${SELF} 一个。`
      + '例外每多一个，这条守卫就少守一块，而它是悄悄发生的');
  });

  test('确实扫到了一批测试文件（否则本条空跑）', () => {
    assert.ok(FILES.length >= 40,
      `只扫到 ${FILES.length} 个测试文件 —— 目录结构大概变了，而那会让这条守卫变成空跑`);
  });
});

describe('没有一处裸起 sh / bash', () => {
  test('全部改用 findPosixShell() 解析出来的那一个', () => {
    const offenders = [];
    for (const f of FILES) {
      const src = readFileSync(f, 'utf8');
      // 注释里提到这些写法是允许的（本文件与 posix-shell 的文件头就有）
      const code = src.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
      for (const pat of BARE) {
        if (code.includes(pat)) {
          offenders.push(`${f.slice(REPO_ROOT.length + 1)}: ${pat}`);
        }
      }
    }
    assert.deepEqual(offenders, [],
      '这些地方裸起了 sh / bash：\n  ' + offenders.join('\n  ')
      + '\n\n  Windows 上 `sh` 可能不在 PATH 里、`bash` 可能是 WSL 的启动器 ——'
      + '\n  两种都不是"脚本的行为"，而这些套件判的正是脚本自己的退出码与输出。'
      + '\n  改用 tools/test/posix-shell.mjs 的 findPosixShell()，'
      + '\n  并把 skipReasonFor(SHELL) 并进那个 describe 的 skip。');
  });

  test('反向：解析器自己确实提供了那两个出口（不然上一条无从遵守）', () => {
    const src = readFileSync(resolve(REPO_ROOT, 'tools/test/posix-shell.mjs'), 'utf8');
    assert.match(src, /export function findPosixShell/);
    assert.match(src, /export function skipReasonFor/);
  });
});
