// 旧路径零残留：没有人再"读协议文件原文、然后去取部署字段"（功能 005 / T012 / FR-005）。
//
// ## 这条守的是分家最危险的那种失败
//
// 分家之后 `blockchain/protocol.json` 里已经没有 `topology` / `endpoints` /
// `primaryNetwork` / `validators.{count,nodes}` 了。谁要是还直接 `JSON.parse` 那个文件
// 再去取这些字段，拿到的是 **`undefined`** —— 而 `undefined` **不抛异常**：
//
//   `http://127.0.0.1:${p.endpoints.hostRpcPort}${p.endpoints.rpcPath}`
//     → "http://127.0.0.1:undefinedundefined"
//
// 连不上的时候，错因看起来像「链挂了」。这类残留不会在任何一次绿灯里显形，
// 只会在某个人半夜排查入口故障时才被发现 —— 而 004 刚为这件事花掉一整个特性。
//
// ## 正确的取值方式只有一个
//
// `loadProtocol()` 读两个文件、各自按自己的 schema 校验、再合并成一个对象返回。
// **合并视图与分家前逐字段相同**（见 tests/unit/derive-topology-shape.test.mjs），
// 所以下游一行不用改 —— 前提是它们走 `loadProtocol()`，而不是自己去 parse。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { REPO_ROOT } from '../../tools/protocol/load.mjs';
import { DEPLOYMENT_FIELDS, VALIDATORS_SPLIT } from '../../tools/protocol/field-ownership.mjs';

/**
 * 允许直接读协议文件原文的地方 —— 每条都要写清**为什么它不是残留**。
 *
 * 下方有一条**反向断言**：这张表里的每一项都必须仍然是一次真实命中。
 * 残留被清掉之后若表项还留着，那条会红 —— 否则这张表会慢慢变成一张
 * 「曾经允许过什么」的名单，而守卫的覆盖面在无人察觉中缩小。
 *
 * **当前为空 —— 真的零残留。** 我一度把 `tests/integration/node-runtime.test.mjs`
 * 登记在这里（它确实既碰协议文件又取部署字段），而反向断言第一次跑就把它顶了回来：
 * 那个文件的部署字段全走 `loadProtocol()`，它对协议文件的两处直接操作是
 * "拷进容器配置目录"与"读回那份**副本**"——都不是从仓库原文取部署字段，压根不该命中。
 * 一条空的例外表比一条填着"其实不必要的例外"的表更可信。
 */
const ALLOWED = Object.freeze({});

const DEPLOY_KEYS = [
  ...DEPLOYMENT_FIELDS,
  ...VALIDATORS_SPLIT.deployment.map((k) => `validators.${k}`),
];

/** 把 JS 注释去掉再扫 —— 注释里提一句不算用（本项目既有约定）。 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');

const jsFiles = execSync('git ls-files "*.mjs" "*.js"', { cwd: REPO_ROOT, encoding: 'utf8' })
  .split('\n').filter(Boolean).filter((f) => !f.startsWith('node_modules/'));

/** 把协议文件 parse 进 JS 的写法（拷贝文件不算）。 */
const PARSES_PROTOCOL = /(?:readJson|JSON\.parse\s*\(\s*readFileSync)\s*\([^;]*?blockchain\/protocol\.json/;
// 刻意不用正则：键名里本来就有点号，转义一多就容易写出一个"永远为假"的模式，
// 而那正是最难发现的假绿灯 —— 扫描器照跑，只是什么都扫不到。
const accessesDeployment = (code) => DEPLOY_KEYS.some((k) => code.includes(`.${k}`));

const scan = () => {
  const hits = [];
  for (const f of jsFiles) {
    if (f === 'tests/unit/deployment-path-residue.test.mjs') continue;   // 本文件自身
    const code = stripComments(readFileSync(resolve(REPO_ROOT, f), 'utf8'));
    if (PARSES_PROTOCOL.test(code) && accessesDeployment(code)) hits.push(f);
  }
  return hits;
};

describe('JS 侧：没有人读协议文件原文再取部署字段', () => {
  const hits = scan();

  test('扫描器本身有效（能扫到文件，且认得部署字段）', () => {
    // 防"什么都没扫到所以全绿"——本项目最熟悉的那种假绿灯。
    assert.ok(jsFiles.length > 50, `只列出了 ${jsFiles.length} 个 JS 文件，git ls-files 出问题了`);
    assert.ok(DEPLOY_KEYS.length >= 5, `部署字段只有 ${DEPLOY_KEYS.length} 个，归属表被掏空了？`);
    assert.ok(PARSES_PROTOCOL.test("const p = readJson('blockchain/protocol.json');"),
      '识别"读协议文件"的正则失效了');
    assert.ok(accessesDeployment('p.endpoints.hostRpcPort'),
      '识别"取部署字段"的正则失效了');
  });

  test('零残留（登记过的例外除外）', () => {
    const unregistered = hits.filter((f) => !(f in ALLOWED));
    assert.deepEqual(unregistered, [],
      `以下文件读协议文件原文之后取了部署字段：\n  ${unregistered.join('\n  ')}\n`
      + '  分家之后这些取值是 `undefined` —— **不抛异常，只是静默变错**。\n'
      + '  改为 `loadProtocol()`（合并视图，与分家前逐字段相同）；\n'
      + '  确属误报则登记进本文件的 ALLOWED 并写明为什么它不是残留。');
  });

  for (const [f, why] of Object.entries(ALLOWED)) {
    test(`例外 \`${f}\` 仍然成立（反向断言）`, () => {
      assert.ok(hits.includes(f),
        `\`${f}\` 登记在 ALLOWED 里，但它已经不再命中扫描了。\n`
        + '  **请把这一项删掉。** 留着陈旧的例外，守卫的覆盖面会在无人察觉中缩小 ——\n'
        + '  下次真有残留落在这个文件里时，它会被这张表直接放行。\n'
        + `  当初登记的理由：${why}`);
      assert.ok(why.length > 40, `${f} 的例外理由太短 —— 只写结论，下一个人无从判断它是否还成立`);
    });
  }
});

describe('shell 侧：没有人用 proto_get 取部署字段', () => {
  const shFiles = execSync('git ls-files "*.sh"', { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean);

  test('扫描器能扫到 shell 文件', () => {
    assert.ok(shFiles.length > 5, `只列出了 ${shFiles.length} 个 shell 文件`);
  });

  test('`proto_get` 的参数里不出现部署字段路径', () => {
    const bad = [];
    for (const f of shFiles) {
      const src = readFileSync(resolve(REPO_ROOT, f), 'utf8');
      for (const [i, line] of src.split('\n').entries()) {
        if (/^\s*#/.test(line)) continue;                     // 整行注释
        const m = line.match(/proto_get\s+(['"])([^'"]*)\1/);
        if (!m) continue;
        const expr = m[2];
        if (DEPLOY_KEYS.some((k) => expr.includes(`.${k}`))) {
          bad.push(`${f}:${i + 1}  proto_get '${expr}'`);
        }
      }
    }
    assert.deepEqual(bad, [],
      `以下取值走了协议文件，但要的是部署字段：\n  ${bad.join('\n  ')}\n`
      + '  改用 `deploy_get`（docker/lib/protocol.sh）—— 两个函数分开，\n'
      + '  就是为了让「这个值住在哪一侧」在调用处就看得见。');
  });

  test('`deploy_get` 确实在用（否则上一条是空跑）', () => {
    const users = shFiles.filter((f) => /deploy_get\s+['"]/.test(readFileSync(resolve(REPO_ROOT, f), 'utf8')));
    assert.ok(users.length > 0,
      'shell 侧一处都没用 deploy_get —— 要么分家没做，要么上一条断言在空跑');
  });
});
