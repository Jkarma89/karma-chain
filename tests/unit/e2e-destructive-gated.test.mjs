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
import { isKillTarget } from '../e2e/lib/devnet.mjs';
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

describe('④ 破坏性套件必须**串行** —— 一条只写在文档里的规矩不会变红', () => {
  // `--test-concurrency=1` 只保证**一次运行内**文件串行（npm-scripts 那条守卫钉着它）。
  // 它挡不住的是：把一次完整 e2e 放到后台跑，**同时**又在同一条链上跑别的破坏性套件。
  // 2026-09-19 我就是这么干的（V-44）。链没事是因为容错刚好够，不是因为我做得对。
  const needLock = destructiveFiles.filter((f) => {
    const src = srcOf(f);
    return src.includes('killAll(') || src.includes("'kill'") || src.includes("'stop'")
      || src.includes("'wipe'");
  });

  test('需要加锁的那批不为空', () => {
    assert.ok(needLock.length >= 8, `只有 ${needLock.length} 个 —— 识别特征大概漂了`);
  });

  for (const f of needLock) {
    test(`${f} 在 before 里取锁，并核实链是满的`, () => {
      const src = srcOf(f);
      // 2026-09-23：原先查的是 `before(() => acquireDestructiveLock(` 这一行字面量。
      // 加第二条前提之后那一行变成了 `before(async () => { … ; await … })`，
      // 于是这条红了 —— **行为没变，是前提过期**。所以改前提，不放宽。
      assert.match(src, /before\([\s\S]{0,160}?acquireDestructiveLock\(/,
        `${f} 没有取锁 —— 两轮故障注入并发时，各自的判据都建立在`
        + '"现在只有我在动节点"这个前提上，而那个前提不成立。');
      // 姊妹前提：锁管"只有我在动"，这条管"我动手之前别人没先把它弄坏"。
      // 2026-09-23 那轮完整 e2e 就是缺这一条：l1-2 开跑时已经卡住，
      // 而没有任何东西检查它 —— 四条失败看起来像产品缺陷，其实全是回声。
      assert.ok(src.includes('requireFullMargin('),
        `${f} 没有核实链是满的。在已经退化的链上注入故障，量到的不是被测性质 ——`
        + '\n  是别人的故障加上我的故障。加 `await requireFullMargin(SUITE_LABEL);` 到取锁之后。');
    });
  }

  test('锁自己：拒绝时说得清，陈旧时接管并说出来，退出时释放', () => {
    const LIB = readFileSync(resolve(E2E, 'lib/devnet.mjs'), 'utf8');
    assert.match(LIB, /已经有一次破坏性运行在进行中/, '拒绝时要说清是谁在跑');
    assert.match(LIB, /接管一把陈旧的锁/,
      '静默接管等于没有锁 —— 崩溃留下的锁被接管时必须打印一行');
    assert.ok(LIB.includes("process.on('exit', release)"),
      '退出时不释放的话，一次正常运行会把后面所有运行都挡住');
    assert.ok(LIB.includes('alive(held.pid)'),
      '要按持有者进程还在不在判断陈旧 —— 只看文件在不在会把崩溃留下的锁当成活的');
  });

  // 2026-09-23：原先这条查的是黑名单的**字面量**
  //     `new Set(['karmachain-aggregator'])`
  // 它当初是为了避免"断言提到过"而特意查字符串的 —— 方向对，但仍然是**文本**。
  // 而文本查不出它真正该守的性质：**哪些容器会被杀**。
  //
  // 实证：面板（karmachain-dashboard）同前缀，黑名单里没有它，于是被一起杀了，
  // 而它是 --rm 起的 —— 是移除，不是停掉，start() 不会带它回来。
  // 2026-09-23 完整 e2e 实测，场景 B 第一轮就清掉了它。
  // 这条守卫全程是绿的，因为它查的字符串一直在。
  //
  // 改成黑名单→白名单之后，判据也改成**行为**：直接问那个谓词。
  test('killAll 的目标是白名单：本机节点 + RPC 代理，其余一律不碰', () => {
    assert.equal(isKillTarget('karmachain-l1-1'), true, '节点容器必须在内');
    assert.equal(isKillTarget('karmachain-primary-1'), true, 'Primary 也是节点');
    assert.equal(isKillTarget('karmachain-rpc-win-1'), true,
      'RPC 代理是故意在内的 —— 场景 A 要的是「全都崩掉」，crash-recovery 按 节点数+1 断言');
    assert.equal(isKillTarget('karmachain-aggregator'), false,
      '聚合器是按需容器，start() 不会把它带回来 —— 杀掉之后下一次成员变更会以退出码 10 失败');
    assert.equal(isKillTarget('karmachain-dashboard'), false,
      '面板是 --rm 起的：杀掉即移除，恢复逻辑（管节点）救不回它');
    assert.equal(isKillTarget('karmachain-whatever-new'), false,
      '白名单的意义就在这里：将来加的辅助容器默认安全，要杀它必须显式写进来');
  });
});
