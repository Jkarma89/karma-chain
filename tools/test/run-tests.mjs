// tools/test/run-tests.mjs —— 跑 node:test，并且**不放过被静默跳过的套件**。
//
// ## 为什么需要这一层
//
// Node 22.19 的测试运行器有一个会让人误判的行为：**`describe` 体在求值时抛异常时，
// TAP 里报 `not ok`，但它不计入 `# fail`，进程退出码仍是 0。**
//
// 最小复现（2026-09-14 实测，Node v22.19.0）：
//
//     describe('setup 抛异常的套件', () => { throw new Error('boom'); });
//     describe('正常套件', () => { test('一条真断言', () => assert.equal(1, 1)); });
//
//     not ok 1 - setup 抛异常的套件
//     # tests 1   # pass 1   # fail 0      ← 退出码 0
//
// 后果：**`npm test` 通过不等于每个套件都跑了。** 任何文件的夹具计算一坏，
// 那个文件的全部断言会悄悄消失，而总数只是少了几条 —— 没人会盯着总数。
//
// 这个仓库有 140 多个套件，其中不少在 `describe` 求值期构造夹具（跨形态渲染、
// 读链上制品、解析字节码……），所以这不是理论风险。
// 本期就撞到过两次：一次是加机器守卫的模拟违反了 T-5，一次是身份渲染读不到私钥 ——
// 两次都是 `not ok` 而退出码 0。
//
// ## 做法
//
// 原样透传 `node --test` 的输出，同时扫**列首**的 `not ok`。
// 有任何一条 → 以 1 退出，并把那几行再列一遍。
// 子进程本身非零退出照旧非零（普通的断言失败走那条路）。
//
// 不引入任何依赖（宪法 / FR-035），只用 node 内置模块。
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
if (!args.length) {
  console.error('用法: node tools/test/run-tests.mjs <node --test 的参数…>');
  process.exit(2);
}

const child = spawn(process.execPath, ['--test', ...args], {
  stdio: ['inherit', 'pipe', 'inherit'],
});

/** 列首的 `not ok` = 一个套件或顶层测试失败。缩进的那些是子测试，由退出码覆盖。 */
const silent = [];
let carry = '';

child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  const text = carry + chunk.toString('utf8');
  const lines = text.split('\n');
  carry = lines.pop() ?? '';
  for (const line of lines) {
    // `not ok N - 名字` 且**无前导空白**。TODO 标记的那些不算失败。
    if (/^not ok \d+ - /.test(line) && !/# TODO\b/.test(line)) silent.push(line);
  }
});

child.on('close', (code) => {
  if (carry && /^not ok \d+ - /.test(carry) && !/# TODO\b/.test(carry)) silent.push(carry);

  if (!silent.length) process.exit(code ?? 1);

  // 到这里说明有列首的 `not ok`。若退出码已经非零，普通失败路径已经生效，照旧退出；
  // 若退出码是 0，那就是上面说的那个静默跳过 —— 必须拦下。
  if (code === 0) {
    console.error('');
    console.error('run-tests: **有套件没有真的跑起来，而 node --test 仍以 0 退出。**');
    console.error('');
    for (const line of silent) console.error(`  ${line}`);
    console.error('');
    console.error('  这是 Node 测试运行器的行为：`describe` 体在求值时抛异常 → 报 not ok，');
    console.error('  但不计入 # fail、退出码仍为 0。上面那些套件里的断言**一条都没执行**。');
    console.error('  常见原因：夹具在 describe 求值期构造，而构造过程抛了 ——');
    console.error('  读不到文件、配置不合法、渲染失败。往上翻 TAP 输出里那条 error。');
    process.exit(1);
  }
  process.exit(code ?? 1);
});
