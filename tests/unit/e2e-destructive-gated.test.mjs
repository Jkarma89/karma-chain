// 会改变系统状态的 e2e 套件，必须**有闸门、且收得了场**（研究 V-44）。
//
// ## 事情是怎么发生的
//
// 2026-09-18 为了给 DoD 取一个数字，我跑了 `npm run test:e2e` —— 当成测量跑的。
// 它不是测量：场景 A/B/C/E 与 V-03 做的是强制终止、数据卷擦除这类故障注入。
// 结果 win-1 的 `l1-1` 与代理停在退出码 137，套件随后中止，**没有恢复它们**。
//
// 根因是一处**不对称**：
//
//   毁坏  killAll() / node kill → `docker`       ← 在 PATH 里，**总能跑**
//   恢复  start()               → `sh scripts/…` ← `sh` 不在 PowerShell 的 PATH 里
//
// 于是它把节点打掉、又没法放回去。一个会改状态的动作必须自己负责把状态放回去；
// 做不到就**别动手**。
//
// ## 本文件守两条性质
//
//   ① 每个破坏性套件都有闸门（`SHELL_SKIP` 或自己的显式开关）—— 收不了场就不跑
//   ② 每个会打掉节点的套件都有 `after` 兜底恢复 —— 断言中途失败也要放回去
//
// 按**源码**断言。理由与 verify-non-members 那条相同：真跑一遍这些套件要几分钟、
// 而且会真的打掉节点 —— 一条为了验证"破坏是安全的"而去破坏的测试，代价不对。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from '../../tools/protocol/load.mjs';

const E2E = resolve(REPO_ROOT, 'tests/e2e');
const files = readdirSync(E2E).filter((f) => f.endsWith('.test.mjs'));
const srcOf = (f) => readFileSync(resolve(E2E, f), 'utf8');

/** 毁坏的动作有哪些形态。任何一种出现，这个文件就算会改变系统状态。 */
const DESTRUCTIVE = [
  'killAll(',                      // 强杀全部容器
  "'kill'",                        // devnet-node kill
  "'stop'",                        // devnet-node stop
  "'wipe'",                        // 删数据卷
  'devnet-stop.sh',                // 停整网
];

const destructiveFiles = files.filter((f) => {
  const s = srcOf(f);
  // 只看代码，不看注释 —— 注释里提到 'kill' 的文件不该被算进来
  const code = s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
  return DESTRUCTIVE.some((d) => code.includes(d));
});

/** 顶层 `describe(...)` 里**选项那一段**的原文（从名字到箭头函数之前）。 */
const describeOptions = (s) => {
  const starts = ["describe('", 'describe(' + String.fromCharCode(96)]
    .map((x) => s.indexOf(x)).filter((i) => i >= 0);
  if (!starts.length) return null;
  const d = Math.min(...starts);
  const arrow = s.indexOf('() => {', d);
  return arrow < 0 ? null : s.slice(d, arrow);
};

/** 认可的闸门：共用的 SHELL_SKIP，或套件自己的显式开关（更严）。 */
const GATE_TOKENS = [
  'SHELL_SKIP',
  'KARMACHAIN_ALLOW_DISRUPTIVE',
  'KARMACHAIN_ALLOW_DESTRUCTIVE',
  'KARMACHAIN_EXPECT_STOPPED',
  'skipReasonFor(',
];

describe('夹具前提', () => {
  test('确实找出了一批破坏性套件（否则下面两条空跑）', () => {
    assert.ok(destructiveFiles.length >= 8,
      `只认出 ${destructiveFiles.length} 个破坏性 e2e 文件 —— 太少，`
      + '大概是识别特征漂了，而那会让下面两条守卫变成空跑。'
      + `\n  认出的是：${destructiveFiles.join('、')}`);
  });
});

describe('① 收不了场就不跑：每个破坏性套件都有闸门', () => {
  for (const f of destructiveFiles) {
    test(`${f} 的顶层 describe 带 skip`, () => {
      const s = srcOf(f);
      // **查 describe 的选项，不查"文件里提到过"。**
      //
      // 第一版写的是 `s.includes('SHELL_SKIP')` —— 而导入行里就有这个名字，
      // 于是把 describe 选项里的 skip 整个拿掉，这条守卫照旧全绿（变红检查抓到）。
      // 判定放得太宽，等于没判。
      const gated = GATE_TOKENS.some((t) => (describeOptions(s) ?? '').includes(t));
      assert.ok(gated,
        `${f} 会改变系统状态，但没有任何闸门。没有可用的 POSIX shell 时它会\n`
        + '  毁坏成功、恢复失败 —— 留下一个需要人工收拾的状态，而报出来的是"断言失败"。\n'
        + '  加 SHELL_SKIP 到它的 describe 选项里（见 tests/e2e/lib/devnet.mjs）。');
    });
  }
});

describe('② 断言中途失败也要放回去：会打掉节点的套件有 after 兜底', () => {
  // 只有"真的会让节点停下来"的那些需要兜底。读状态或停整网的（domain-failure 自己
  // 管着整域）也在内 —— 它们同样是打掉之后要起回来。
  const needRestore = destructiveFiles.filter((f) => {
    const s = srcOf(f);
    return s.includes('killAll(') || s.includes("'kill'") || s.includes("'stop'") || s.includes("'wipe'");
  });

  test('需要兜底的那批不为空', () => {
    assert.ok(needRestore.length >= 8, `只有 ${needRestore.length} 个 —— 识别特征大概漂了`);
  });

  for (const f of needRestore) {
    test(`${f} 有 after 兜底恢复`, () => {
      const s = srcOf(f);
      assert.match(s, /after\(\(\) => restoreOrReport\(/,
        `${f} 没有 after 兜底。旧写法在"毁坏之后、恢复之前"抛出时会把节点留在停止状态，\n`
        + '  而报出来的是"断言失败"，不是"我改了什么"。\n'
        + '  加 `after(() => restoreOrReport(SUITE_LABEL));` 到 describe 体的开头。');
    });
  }
});

describe('③ 那两个入口自己也要拦得住', () => {
  const LIB = readFileSync(resolve(E2E, 'lib/devnet.mjs'), 'utf8');

  test('killAll() 在没有恢复路径时**拒绝执行**', () => {
    assert.match(LIB, /export function killAll\(\) \{\s*\n\s*if \(!SHELL\) throw/,
      'killAll() 必须先检查有没有恢复路径 —— `docker kill` 能跑不代表我们能起回来。'
      + '这是 V-44 的核心：会改状态的动作做不到自我恢复时就别动手');
  });

  test('script() 在没有 shell 时抛，而不是静默不做', () => {
    assert.match(LIB, /export const script = [\s\S]{0,120}if \(!SHELL\) throw/,
      'script() 静默返回的话，"恢复"会变成一次什么都没做的成功 —— 那比抛异常坏得多');
  });

  test('restoreOrReport 认 KARMACHAIN_EXPECT_STOPPED', () => {
    assert.match(LIB, /KARMACHAIN_EXPECT_STOPPED === '1'\) return null/,
      '有人显式声明"这一轮期望开发网是停的"时，把它拉起来才是破坏 —— 兜底也要认这个开关');
  });

  test('restoreOrReport **自己不抛**（否则会盖掉真正的失败原因）', () => {
    const body = LIB.slice(LIB.indexOf('export async function restoreOrReport'));
    const end = body.indexOf('\n}\n');
    assert.match(body.slice(0, end), /catch \(err\)/,
      'after 里抛异常会把真正的断言失败原因盖掉，而那个原因才是人要看的');
  });
});
