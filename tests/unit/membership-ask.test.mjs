// 危险动作前那一问：**stdin 关闭时按「否」处理**（功能 005 / T041 实施期发现）。
//
// ## 这条守卫防的是一个会伪装成别的错误的缺陷
//
// `readline/promises` 的 `rl.question()` 在 stdin 已关闭时（CI、管道、`< /dev/null`）
// **永不落定**。于是工具的顶层 `await` 挂住，Node 以 **13** 退出
//（`ERR_UNSETTLED_TOP_LEVEL_AWAIT`）。
//
// 而 **13 是本仓库保留给「拓扑违反容错约束」的退出码**（002 的 CLI 契约）。
// 所以后果不是"少一句提示"：一次**没人回答**会被靠退出码分流的调用方读成一次
// **拓扑违规** —— 两件毫不相干的事，而且它不报错、不留痕。
//
// 2026-09-17 跑 T041 的前置检查时撞到：想用 `< /dev/null` 拿一次干跑的输出，
// 拿回来一个退出码 13。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from '../../tools/protocol/load.mjs';
import { ask } from '../../tools/membership/ask.mjs';

/** 立刻结束的输入流 —— 等价于 `< /dev/null`。 */
const closedInput = () => Readable.from([]);
/** 给定几行输入的流。 */
const inputOf = (...lines) => Readable.from([`${lines.join('\n')}\n`]);

const sink = () => {
  const chunks = [];
  const w = new Writable({ write(c, _e, cb) { chunks.push(String(c)); cb(); } });
  w.text = () => chunks.join('');
  return w;
};

describe('EOF 按「否」处理，而不是把进程挂住', () => {
  test('stdin 立刻结束 → 返回 false，且**能返回**（不挂起）', async () => {
    const out = sink();
    const answered = await ask('执行第 1 步？', { input: closedInput(), output: out });
    assert.equal(answered, false);
  });

  test('并且说清"为什么没问成"，而不是静悄悄当否', async () => {
    const out = sink();
    await ask('执行第 1 步？', { input: closedInput(), output: out });
    assert.match(out.text(), /标准输入已关闭/,
      '按否处理是对的，但要让人知道它是"没人回答"而不是"有人回答了否" —— '
      + '两者在排查时指向完全不同的地方');
    assert.match(out.text(), /链未改动/, '要顺带说清这一下没有后果');
  });
});

describe('正常回答仍然按原来的规矩', () => {
  for (const [line, expected] of [
    ['y', true], ['Y', true], ['yes', true], ['YES', true], [' y ', true],
    ['n', false], ['N', false], ['no', false], ['', false], ['随便', false],
  ]) {
    test(`输入 ${JSON.stringify(line)} → ${expected}`, async () => {
      assert.equal(await ask('问题', { input: inputOf(line), output: sink() }), expected);
    });
  }

  test('**默认是否** —— 只有明确的 y / yes 才算是', async () => {
    // 这一条是上面那组的用意：守的是写链的动作，含糊一律不动链。
    const ambiguous = ['ok', '1', 'true', 'ye', 'yep', '是'];
    for (const a of ambiguous) {
      assert.equal(await ask('问题', { input: inputOf(a), output: sink() }), false,
        `${JSON.stringify(a)} 被当成了"是" —— 这一问守的是写链的动作，含糊必须按否`);
    }
  });
});

describe('两个工具都用这一份，没有谁自己再写一个', () => {
  // 与退出码那条守卫同一个理由：两份拷贝会各自漂移，
  // 而这个缺陷恰恰是**两份拷贝同时有**的那种 —— 修一份不够。
  for (const f of ['add-validator.mjs', 'remove-validator.mjs']) {
    test(`${f} 从 ask.mjs 取，不自己定义`, () => {
      const text = readFileSync(resolve(REPO_ROOT, 'tools/membership', f), 'utf8');
      assert.match(text, /import \{ ask \} from '\.\/ask\.mjs'/,
        `${f} 没有从 ask.mjs 引入`);
      assert.doesNotMatch(text, /^const ask = /m,
        `${f} 自己又定义了一个 ask —— 那正是这次缺陷能同时存在于两处的原因`);
      assert.doesNotMatch(text, /readline\/promises/,
        `${f} 仍在直接用 readline —— 绕过 ask.mjs 就绕过了 EOF 那条处理`);
    });
  }

  test('**反向断言**：ask.mjs 里确实有那个 EOF 分支', () => {
    const text = readFileSync(resolve(REPO_ROOT, 'tools/membership/ask.mjs'), 'utf8');
    assert.match(text, /once\('close'/,
      'EOF 的处理靠的是与 close 事件赛跑 —— 这一句没了，上面那两条会在一个'
      + '永远挂起的函数上超时，而超时读起来像"测试环境慢"');
  });
});
