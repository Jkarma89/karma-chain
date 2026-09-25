// e2e 测试文件从 `lib/devnet.mjs` 取的东西，**必须真的取到**（2026-09-25）。
//
// ## 为什么要有这条
//
// `single-validator-window.test.mjs` 在一次改动里把 `pickLocalVictims` / `localVictimSkip`
// 从导入列表里弄丢了，而它们在模块**顶层**被调用：
//
//     const LOCAL = pickLocalVictims(1);     // ← 顶层，import 阶段就执行
//
// 于是整个文件在加载时 `ReferenceError`，**一条断言都没跑**。
// 而在 e2e 的汇总里，它只表现为 `# fail 1` —— 和"跑了一条、红了一条"长得一模一样。
//
// **没跑过的测试与跑过并通过的测试，在总数上是分不出来的**；而这一份跑的是 SC-003
// 的正式验收（连续 30 分钟、每分钟一笔、成功率 100%）。它悄悄缺席了整整一轮。
//
// e2e 跑一轮要一个多小时，**靠跑一轮来发现"某个文件根本没加载"的成本太高** ——
// 这条放在单元测试里，几毫秒就能答。
//
// ## 这条查两个方向
//
//   ① 导入了但库里没有 → 加载时报 `SyntaxError: does not provide an export named …`
//   ② 用到了但没导入   → 加载时报 `ReferenceError`（**这次栽的就是这个**）
//
// 第 ② 条只查**调用**（`name(`）：库里导出的基本都是函数，而按裸标识符去查
// 会被字符串与同名局部变量误伤 —— 一条会误报的守卫，很快就会被人关掉。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { REPO_ROOT } from '../../tools/protocol/load.mjs';

const E2E_DIR = resolve(REPO_ROOT, 'tests/e2e');
const LIB = resolve(E2E_DIR, 'lib/devnet.mjs');

/** 去掉注释与字符串字面量 —— 它们里面的名字不是引用。 */
const stripNoise = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ')
  .replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, "''");

const EXPORTS = (() => {
  const src = stripNoise(readFileSync(LIB, 'utf8'));
  const names = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:const|let|function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1]);
  }
  return names;
})();

const FILES = readdirSync(E2E_DIR)
  .filter((f) => f.endsWith('.test.mjs'))
  .map((f) => ({ name: f, src: readFileSync(join(E2E_DIR, f), 'utf8') }));

const importedNames = (src) => {
  // `[^}]*` 而不是 `[\s\S]*?`：后者是懒的，却会从文件里**第一个** `import {` 开始，
  // 一路吞到 devnet 那一行的 `}`，于是把 node:test 等其它导入也算了进来。
  // 2026-09-25 第一版就是这么写的，本守卫自己先红了一次（它红得对）。
  const block = /import\s*\{([^}]*)\}\s*from\s*['"][^'"]*lib\/devnet\.mjs['"]/.exec(src);
  if (!block) return null;
  return new Set(
    block[1]
      .split(',')
      .map((s) => s.replace(/\/\/.*$/gm, '').trim())
      .map((s) => (s.includes(' as ') ? s.split(' as ')[0].trim() : s))
      .filter(Boolean),
  );
};

describe('e2e 的导入必须成立', () => {
  test('前提：库里确实有一批导出，且测试文件确实在导入它', () => {
    // 不写死名单（那会在每次加减导出时要改两处），但要挡住"正则全都没匹配到"
    // 这种把本条变成永远通过的情形 —— 一条不会变红的守卫比没有守卫更坏。
    assert.ok(EXPORTS.size >= 20, `只从 lib/devnet.mjs 解出 ${EXPORTS.size} 个导出 —— 正则多半失效了`);
    assert.ok(FILES.length >= 10, `只找到 ${FILES.length} 个 e2e 文件 —— 目录或后缀变了？`);
    const users = FILES.filter((f) => importedNames(f.src));
    assert.ok(users.length >= 10, `只有 ${users.length} 个文件从 lib/devnet.mjs 导入 —— 匹配失效了`);
    // **解出来的必须长得像标识符。** 第一版正则吞掉了半个文件，解出的"名字"里带着换行
    // 和 `from 'node:test';` —— 而上面两条断言照样通过（数量都够）。
    // 数量对不代表解析对：那正是"判据说的是一回事、实际测的是另一回事"。
    const junk = users.flatMap((f) => [...importedNames(f.src)]
      .filter((n) => !/^[A-Za-z_$][\w$]*$/.test(n))
      .map((n) => `${f.name}: ${JSON.stringify(n.slice(0, 40))}`));
    assert.deepEqual(junk, [], '解出来的导入名不是合法标识符 —— 正则吃多了');
  });

  test('① 导入的名字，库里都得有', () => {
    const bad = [];
    for (const f of FILES) {
      const names = importedNames(f.src);
      if (!names) continue;
      for (const n of names) if (!EXPORTS.has(n)) bad.push(`${f.name}: ${n}`);
    }
    assert.deepEqual(bad, [],
      '这些名字 lib/devnet.mjs 没有导出 —— 加载时会是 SyntaxError，整个文件一条都不跑');
  });

  test('② 用到的名字，都得导入 —— 否则整个文件在加载时就没了', () => {
    const bad = [];
    for (const f of FILES) {
      const names = importedNames(f.src);
      if (!names) continue;
      // 去掉导入块本身，免得把导入语句里的名字当成使用
      const body = stripNoise(f.src)
        .replace(/import\s*\{[\s\S]*?\}\s*from\s*''\s*;?/g, ' ');
      for (const n of EXPORTS) {
        if (names.has(n)) continue;
        // 只认调用点，且前面不能是 `.`（那是别人的方法，不是这个名字）
        const used = new RegExp(`(?<![\\w$.])${n}\\s*\\(`).test(body);
        // 也可能是本文件自己定义的同名东西 —— 那不算漏导入
        const declared = new RegExp(`(?:const|let|var|function|class)\\s+${n}\\b`).test(body);
        if (used && !declared) bad.push(`${f.name}: 用了 ${n}() 却没从 lib/devnet.mjs 导入`);
      }
    }
    assert.deepEqual(bad, [],
      '这是 2026-09-25 栽过的那一种：顶层调用一个没导入的名字，'
      + '整个文件在 import 阶段 ReferenceError，一条断言都不跑，'
      + '而汇总里只显示为「1 个失败」');
  });
});
