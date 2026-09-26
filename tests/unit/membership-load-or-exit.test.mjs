// 声明不合法时，成员工具必须**干净地退出 30**，而不是抛堆栈（功能 005 / FR-017）。
//
// ## 现场（2026-09-26，SC-009 活链验证）
//
// 把三个验证者塞进同一个故障边界（违反 T-5），然后跑真实的加入流程，得到的是：
//
//     Error: configuration invalid:
//       - constraint: [T-5] 形态 "lan"：故障边界 'ubuntu-3' 含 3 个 L1 验证者…
//         at loadProtocol (file:///…/tools/protocol/load.mjs:412:11)
//     Node.js v22.19.0        ← 退出码 1
//
// **那段文案本身是好的**：点名了边界、给了上限的推导、说了把哪个节点移走。
// 坏的是形式 ——
//
//   ① 退出码 1。契约里 **30 = 前置检查未通过、一步都没动链**，而这正是那种情形；
//      靠退出码分流的调用方（CI、脚本、运维手册）会把它当成未知故障。
//   ② 堆栈把人引向 `load.mjs:412`，而真正要改的是 `blockchain/deployment.json`。
//
// **这是本期已经记过一次的形状**：T031 的注入 ① 发现"入口不可达时抛原始堆栈、
// 退出码 1"并修掉了。同一类问题、另一个触发点 —— 当时修的是那一处，不是这一族。
// 所以这次修在共用的一层（`load-or-exit.mjs`），四个工具都走它。
//
// ## 变红检查（2026-09-26）
//
// 把 `loadConfigOrExit` 里的 try/catch 去掉（即退回直接调 loadProtocol）→
// 第 ①② 条立刻红（抛出去了，没有退出码、也没有文案）。还原即绿。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from '../../tools/protocol/load.mjs';
import { loadConfigOrExit } from '../../tools/membership/load-or-exit.mjs';
import { EXIT_PRECHECK } from '../../tools/membership/exit-codes.mjs';

/** 造一个会抛的 loader，并把 error/exit 收进数组。 */
const run = (thrown) => {
  const lines = [];
  const codes = [];
  const out = loadConfigOrExit({
    load: () => { throw thrown; },
    error: (...a) => lines.push(a.join(' ')),
    exit: (c) => { codes.push(c); return 'EXITED'; },
  });
  return { lines, codes, out, text: lines.join('\n') };
};

const T5_ERROR = new Error(
  'configuration invalid:\n'
  + "  - constraint: [T-5] 形态 \"lan\"：故障边界 'ubuntu-3' 含 3 个 L1 验证者，上限为 2"
  + '（9 个等权验证者，查询门槛 75% → 最多容忍 ⌊9/4⌋ = 2 个离线）。把 l1-9 移到另一个边界，或增加边界数量。',
);

describe('声明不合法时的出口', () => {
  test('① 退出码是 30（前置检查未过，一步都没动链），不是 1', () => {
    const { codes } = run(T5_ERROR);
    assert.deepEqual(codes, [EXIT_PRECHECK],
      '契约里 30 = 前置检查未通过且未动链；退出码 1 让调用方无法与未知故障区分');
  });

  test('② 原来那句可执行的指引必须被保留，不许改写掉', () => {
    // 这一条守的是"不要好心把它重新措辞"：原文案点了边界名、给了上限的推导、
    // 说了把哪个节点移走。重新措辞只会把可执行的部分磨掉。
    const { text } = run(T5_ERROR);
    assert.match(text, /ubuntu-3/, '边界名不见了');
    assert.match(text, /把 l1-9 移到另一个边界/, '"该怎么改"那句不见了');
    assert.match(text, /上限为 2/, '上限与推导不见了');
    assert.match(text, /一步都没动链/, '必须明说链没被动过 —— 否则人会先去查链');
    assert.doesNotMatch(text, /at loadProtocol|\.mjs:\d+/, '不许把堆栈打出来');
  });

  test('③ 认出 T-5 时额外给出改哪个文件', () => {
    const { text } = run(T5_ERROR);
    assert.match(text, /deployment\.json/, '要指向声明文件，而不是让人去读 load.mjs');
    assert.match(text, /npm run render/, '改完还要重新渲染，这一步漏了会留下漂移');
  });

  test('④ 不是 T-5 的约束照样干净退出，只是不加那段附注', () => {
    const other = new Error('configuration invalid:\n  - constraint: endpoints.rpcPath must be /ext/bc/x/rpc');
    const { codes, text } = run(other);
    assert.deepEqual(codes, [EXIT_PRECHECK]);
    assert.match(text, /rpcPath/);
    assert.doesNotMatch(text, /T-5/, '不该给一条与 T-5 无关的错误安上 T-5 的附注');
  });

  test('⑤ 加载成功时原样返回，不插手', () => {
    const cfg = { ok: true };
    const got = loadConfigOrExit({ load: () => cfg, error: () => {}, exit: () => {} });
    assert.equal(got, cfg);
  });

  // 上面几条测的是这一层本身。这一条测**四个工具真的都走了它** ——
  // 否则修好的是一个没人用的函数。
  test('⑥ 成员工具一律经由 loadConfigOrExit 加载，不得再直接调 loadProtocol()', () => {
    const dir = resolve(REPO_ROOT, 'tools/membership');
    const offenders = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.mjs') && x !== 'load-or-exit.mjs')) {
      const src = readFileSync(resolve(dir, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/^\s*\/\/.*$/gm, ' ');
      if (/\bloadProtocol\s*\(\s*\)/.test(src)) offenders.push(f);
    }
    assert.deepEqual(offenders, [],
      '这些工具仍直接调 loadProtocol() —— 声明不合法时它们会抛堆栈、退出码 1，'
      + '而那正是 2026-09-26 修掉的那件事');
  });
});
