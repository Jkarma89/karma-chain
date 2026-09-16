// `@avalabs/avalanchejs` 的边界（功能 005 / T071 / FR-035 / ADR-0008）。
//
// ## 为什么这条边界要被机械检查
//
// FR-035 是"MUST NOT 引入重型依赖"。avalanchejs 是那条规则的**一个例外** ——
// 加它的唯一理由是第三步要构造并签名一笔 P 链交易（`RegisterL1ValidatorTx`），
// 而那件事没有轻量替代：手写 P 链交易的序列化与签名，错了会在花钱那一步才暴露。
//
// 例外的问题不在它本身，在它**会扩散**。一个已经装好的库，下次有人需要
// 「就顺手用一下里面那个工具函数」时，成本看起来是零。于是运行时路径上
// 慢慢多出一堆对它的依赖，而 ADR-0008 让 Avalanche CLI 退出运行时所换来的
// 那个结构性保证（节点镜像里没有编排工具）也就一点点被磨掉。
//
// 所以边界写下来还不够 —— **它得被机械检查**。这就是本套件。
//
// ## 反向断言：守卫不能变成空跑
//
// 「只许出现在 tools/membership/」这句话，在**没人导入它**时是恒真的。
// 若哪天 T027 那批代码被删掉而依赖留在 package.json 里，这条守卫会继续全绿，
// 而它守的东西已经不存在了。所以必须同时断言：至少有一处**运行时**代码真的导入它。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { REPO_ROOT, readJson } from '../../tools/protocol/load.mjs';

const PKG = '@avalabs/avalanchejs';

/**
 * 待扫描的 .mjs / .js。
 *
 * `--cached` 已跟踪 + `--others --exclude-standard` **未跟踪但未被忽略** ——
 * 后半截不可省：这条守卫防的是"顺手加一行 import"，而那件事发生在 `git add`
 * **之前**。只扫已跟踪文件的话，新文件要等到提交之后才被看见，
 * 而那时人已经走了。node_modules 被 .gitignore 排除，所以不会混进来。
 */
const trackedScripts = () => execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '*.mjs', '*.js'],
  { cwd: REPO_ROOT, encoding: 'utf8' },
)
  .split(/\r?\n/)
  .filter(Boolean)
  .map((p) => p.replace(/\\/g, '/'))
  // 同一个路径可能同时出现在 cached 与 others 里
  .filter((p, i, a) => a.indexOf(p) === i);

/**
 * 一个文件有没有导入它。**三种写法都要认**：
 *   静态   `from '@avalabs/avalanchejs'`
 *   动态   `import('@avalabs/avalanchejs')`
 *   CJS    `require('@avalabs/avalanchejs')`
 *
 * 只认静态那一种是个真实的漏洞：本仓库里实际用的**全是动态 import**
 * （add-validator.mjs 三处），静态匹配会让守卫对着零个文件空跑。
 */
const importsPkg = (text) => new RegExp(String.raw`(from|import\(|require\()\s*['"]${PKG.replace('/', '\\/')}['"]`)
  .test(text);

const IMPORTERS = trackedScripts()
  .map((p) => ({ path: p, text: readFileSync(resolve(REPO_ROOT, p), 'utf8') }))
  .filter(({ text }) => importsPkg(text))
  .map(({ path }) => path);

const isRuntime = (p) => p.startsWith('tools/');
const isTest = (p) => p.startsWith('tests/');

describe(`${PKG} 只许出现在 tools/membership/`, () => {
  test('扫描确实覆盖到了文件（不是在空集合上做断言）', () => {
    const all = trackedScripts();
    assert.ok(all.length > 50,
      `只扫到 ${all.length} 个脚本 —— git ls-files 的模式可能写错了，`
      + '而在一个几乎为空的集合上做"没有越界"的断言毫无意义');
  });

  test('**运行时的导入者全部在 tools/membership/ 下**', () => {
    const outside = IMPORTERS.filter(isRuntime).filter((p) => !p.startsWith('tools/membership/'));
    assert.deepEqual(outside, [],
      `${PKG} 出现在 tools/membership/ 之外：${outside.join('、')}\n`
      + '  它是 FR-035「不引入重型依赖」的一个例外，理由只有一条：'
      + '第三步要构造并签名 P 链交易。\n'
      + '  例外一旦扩散，ADR-0008 换来的那个结构性保证就被一点点磨掉了。\n'
      + '  要在别处用它，先问清楚有没有轻量替代 —— 如果确实没有，'
      + '那是一次需要记录的决定，不是顺手一行 import。');
  });

  test('测试可以导入它（测试不是运行时路径）', () => {
    // 这条不是放行，是把范围说清楚：守的是**运行时**会不会背上这个依赖。
    // 测试里用它来独立验证密码学结果，反而是好事 ——
    // tests/unit/identify-signers.test.mjs 就靠它对聚合签名做独立验签。
    const inTests = IMPORTERS.filter(isTest);
    for (const p of inTests) {
      assert.match(p, /^tests\//, `${p} 既不在 tools/ 也不在 tests/ —— 分类表要更新`);
    }
  });

  test('没有第三类位置（既非 tools/ 也非 tests/）', () => {
    const other = IMPORTERS.filter((p) => !isRuntime(p) && !isTest(p));
    assert.deepEqual(other, [],
      `${PKG} 出现在 tools/ 与 tests/ 之外：${other.join('、')} —— `
      + '本守卫的分类只认这两类，出现第三类说明有一条没被考虑过的路径');
  });
});

describe('反向断言：这条守卫必须真的在守着什么', () => {
  test('**至少有一处运行时代码导入它**', () => {
    const runtime = IMPORTERS.filter(isRuntime);
    assert.ok(runtime.length > 0,
      `没有任何运行时代码导入 ${PKG}，可它还在 package.json 的 dependencies 里。\n`
      + '  于是上面那条「只许出现在 tools/membership/」变成了恒真 —— 守卫空跑。\n'
      + '  两种处置，选一个：把依赖从 package.json 移除（它已经没用了），'
      + '或者查清那处导入为什么消失了。');
  });

  test('导入者落在 tools/membership/ 里（不是别的 tools 子目录）', () => {
    const runtime = IMPORTERS.filter(isRuntime);
    assert.ok(runtime.every((p) => p.startsWith('tools/membership/')),
      `运行时导入者：${runtime.join('、')}`);
  });

  test('识别函数认得**动态** import —— 仓库里用的就是那种', () => {
    // 这条守的是识别函数本身。只认 `from '...'` 的话，
    // add-validator.mjs 的三处 `await import('...')` 全都扫不到，
    // 于是 IMPORTERS 为空、上面每条断言都恒真。
    assert.equal(importsPkg(`await import('${PKG}')`), true, '动态 import 没被认出来');
    assert.equal(importsPkg(`from '${PKG}'`), true, '静态 import 没被认出来');
    assert.equal(importsPkg(`require('${PKG}')`), true, 'CJS require 没被认出来');
    assert.equal(importsPkg(`from '${PKG}/dist/es'`), false, '子路径不该被当成本包的导入');
    assert.equal(importsPkg('// 提到了 @avalabs/avalanchejs 但没导入'), false,
      '注释里提到包名被当成了导入 —— 那会让本文件自己都算成越界者');
  });
});

describe('版本必须精确锁定', () => {
  const pkg = readJson(resolve(REPO_ROOT, 'package.json'));

  test(`${PKG} 在 dependencies 里`, () => {
    assert.ok(pkg.dependencies?.[PKG], `${PKG} 不在 dependencies 里`);
  });

  test('**精确版本，没有 ^ 或 ~**', () => {
    const v = pkg.dependencies[PKG];
    assert.match(v, /^\d+\.\d+\.\d+$/,
      `版本是 "${v}" —— 必须精确（npm i --save-exact）。\n`
      + '  理由不是洁癖：这个库参与构造并签名**花钱的** P 链交易，'
      + '而交易的序列化布局是它的实现细节。\n'
      + '  一次 minor 升级把某个字段的编码改了，表现会是"交易被 P 链拒绝"'
      + '或者更坏 —— 一笔构造错了却被接受的交易。');
  });

  test('package-lock 里的版本与 package.json 一致', () => {
    let lock;
    try { lock = readJson(resolve(REPO_ROOT, 'package-lock.json')); } catch { lock = null; }
    if (!lock) return;   // 没有 lock 文件就没什么可比的
    const entry = lock.packages?.[`node_modules/${PKG}`];
    assert.ok(entry, `package-lock.json 里没有 ${PKG}`);
    assert.equal(entry.version, pkg.dependencies[PKG],
      `lock 里是 ${entry.version}，package.json 里是 ${pkg.dependencies[PKG]} —— `
      + '两者不一致时，装出来的是哪个版本取决于安装方式');
  });
});
