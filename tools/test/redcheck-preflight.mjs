// tools/test/redcheck-preflight.mjs —— 加入流程前置检查的**变红检查**（功能 005 / T032）。
//
// 用法：node tools/test/redcheck-preflight.mjs        （npm run redcheck:preflight）
// 退出码：0 每一条都如期变红 | 1 基线不是全绿 | 3 有判定拿掉之后测试仍然全绿
//
// ## 为什么这件事要有一个**可复跑的**脚本，而不是做一遍就算
//
// 本项目反复撞到同一类缺陷：**一条不会变红的守卫**。004 的 18 条里有 3 条是
// 第二次才真正通过的；005 里 FR-014 曾经只写在函数头的注释里而实现根本没有。
// 一条声称存在的判定不存在，比没有声称更坏 —— 读注释的人以为已经守住了。
//
// 手工做一遍的问题是它**不留下可核对的东西**。半年后有人重构 precheck、
// 顺手把某条判定的条件写成恒假，测试照旧全绿 —— 而"T032 做过了"这句话
// 已经写在 tasks.md 里。所以把它做成脚本：随时能重跑，结论是一张表。
//
// ## 纪律：每次都要独立确认变异**真的落进了文件**
//
// 本期两次踩过"假变红"：变异脚本因为引号/转义没生效，而测试照旧全绿，
// 被误读成"守卫有效"。所以这里对每条变异都核对锚点出现次数是否**恰好少了一处**，
// 并把结论打在表里 —— `MUTATION-NOT-APPLIED` 是一个显目的结论，不是沉默的跳过。
import { readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { REPO_ROOT } from '../protocol/load.mjs';

const SRC = resolve(REPO_ROOT, 'tools/membership/add-validator.mjs');
const BAK = `${SRC}.redcheck-bak`;

/**
 * 每条 = [这条判定叫什么, 原文, 换成什么]。
 *
 * 原文是**源码片段**，所以这个表会随 precheck 的改动而失效 —— 那是刻意的：
 * 锚点找不到时本脚本报 `MUTATION-NOT-APPLIED` 并以 3 退出，
 * 逼着改代码的人回来确认那条判定还在、且仍然会变红。
 * 一个"锚点过期就静默跳过"的变异器，本身就是一条不会变红的守卫。
 */
const MUTANTS = [
  ['FR-013 T-5 越界不再拦',
    'if (!d.faultTolerance.declaredWithinLimit && d.faultTolerance.domainCount > 1) {',
    'if (false) {'],
  ['FR-014① 创世区块哈希不一致不再拦',
    '} else if (g.genesisHash !== genesisHash) {',
    '} else if (false) {'],
  ['FR-014② chainId 不一致不再拦',
    '} else if (g.chainId !== config.chain.chainId) {',
    '} else if (false) {'],
  ['FR-014③ 读不到也放过（"没核对"当成"核对通过"）',
    '    if (g.error) {',
    '    if (false) {'],
  ['FR-015 Primary 不在线不再拦',
    'if (offline.length) {',
    'if (false) {'],
  ['公开材料拿不到也放过',
    '  if (!material) {',
    '  if (false) {'],
  ['precheck 缺 chainIdentity 不再抛',
    '  if (!chainIdentity) {',
    '  if (false) {'],
  ['已经是链上成员也放过（重复注册）',
    'if (set.members.some((m) => m.nodeId === nodeId)) {',
    'if (false) {'],
];

const FILES = [
  'tests/unit/membership-preflight.test.mjs',
  'tests/unit/add-validator-step1.test.mjs',
];

const runTests = () => {
  try {
    return execFileSync(process.execPath, ['--test', ...FILES], { encoding: 'utf8', cwd: REPO_ROOT });
  } catch (e) {
    return `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
};

// TAP 的计数行。**不用正则** —— 这个文件被 heredoc / 多层引号搬运过，
// 转义丢一层就会让计数恒为 -1，而那看起来像"基线不绿"。按前缀切更结实。
const counts = (out) => {
  const num = (label) => {
    const want = `# ${label} `;
    const line = out.split('\n').map((l) => l.trim()).find((l) => l.startsWith(want));
    return line ? Number(line.slice(want.length)) : -1;
  };
  return { tests: num('tests'), pass: num('pass'), fail: num('fail') };
};

const cleanup = () => {
  try { copyFileSync(BAK, SRC); unlinkSync(BAK); } catch { /* 已经还原过 */ }
};
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

copyFileSync(SRC, BAK);

const base = counts(runTests());
if (base.tests < 0) {
  console.error('解析不出 TAP 计数 —— 先手动跑一次那两个测试文件看输出');
  process.exit(1);
}
console.log(`基线：${base.pass}/${base.tests} 通过，${base.fail} 失败`);
if (base.fail !== 0) {
  console.error('**基线就不是全绿** —— 变红检查证明不了任何事，先把它修绿');
  process.exit(1);
}

const rows = [];
for (const [name, from, to] of MUTANTS) {
  const original = readFileSync(BAK, 'utf8');
  const before = original.split(from).length - 1;
  if (before === 0) {
    rows.push([name, 'MUTATION-NOT-APPLIED（锚点不存在）', '本条无结论']);
    continue;
  }
  writeFileSync(SRC, original.replace(from, to));
  const applied = readFileSync(SRC, 'utf8').split(from).length - 1 === before - 1;
  const c = counts(runTests());
  rows.push([
    name,
    applied ? `applied（锚点 ${before} 处）` : 'NOT-APPLIED',
    `${c.fail} 红 / ${c.tests} 条`,
  ]);
  copyFileSync(BAK, SRC);
}

console.log('');
console.log('| 拿掉哪一条 | 变异落地 | 结果 |');
console.log('|---|---|---|');
for (const [n, a, r] of rows) console.log(`| ${n} | ${a} | ${r} |`);

const final = counts(runTests());
console.log('');
console.log(`还原后：${final.pass}/${final.tests} 通过，${final.fail} 失败`);

const bad = rows.filter(([, a, r]) => !a.startsWith('applied') || r.startsWith('0 红'));
if (bad.length || final.fail !== 0) {
  console.log('');
  for (const [n, a, r] of bad) console.log(`✗ ${n} —— ${a} / ${r}`);
  if (final.fail !== 0) console.log('✗ 还原之后不是全绿 —— 源文件可能没被还原干净');
  console.log('');
  console.log('一条拿掉之后测试仍然全绿的判定，等于没有判定。给它补一组用例，');
  console.log('或者说明为什么它不需要（并把那个理由写进测试文件的注释里）。');
  process.exit(3);
}
console.log('');
console.log(`✅ ${rows.length} 条判定逐条拿掉，每一条都如期变红`);
