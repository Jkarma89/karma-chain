// tools/membership/ask.mjs —— 危险动作前的那一问，加入与退出**共用**一份。
//
// ## 为什么它值得单独一个文件
//
// 两个工具原先各有一份逐字相同的 `ask()`，而它有一个**只在非交互环境下显形**的缺陷：
//
// `readline/promises` 的 `rl.question()` 在 **stdin 已关闭**时（CI、管道、
// `< /dev/null`）**永不落定** —— 于是顶层 `await` 挂住，Node 以
// **13** 退出（`ERR_UNSETTLED_TOP_LEVEL_AWAIT`）。
//
// 而 **13 正是本仓库保留给「拓扑违反容错约束」的退出码**（002 的 CLI 契约）。
// 后果不是"少一句提示"：一次**没人回答**会被靠退出码分流的调用方读成一次
// **拓扑违规** —— 两件毫不相干的事，而且它不报错。
//
// 2026-09-17 跑 T041 的前置检查时撞到（`< /dev/null` 想拿一次干跑的输出，
// 结果拿到退出码 13）。两份拷贝会各自漂移，所以抽到这里，
// 并由 `tests/unit/membership-ask.test.mjs` 守住"EOF 按否处理"这条性质。
//
// **EOF 按「否」处理**是对的方向：这一问守的是写链的动作，
// "没人回答"与"回答了否"在处置上应当相同 —— 都不动链。

/**
 * 问一个是非题。**默认否**：只有明确的 `y` / `yes` 才算是。
 *
 * @param {string} question 问题本身（不带 `[y/N]`，由本函数补）
 * @param {{input?: import('node:stream').Readable, output?: import('node:stream').Writable,
 *          createInterface?: Function}} [io]
 *   `input` / `output` 可注入，使这条路径能离线测 —— 否则"stdin 关闭时怎么办"
 *   这件事只能靠在真实环境里踩一次来发现，而那正是它此前的处境。
 * @returns {Promise<boolean>}
 */
export async function ask(question, io = {}) {
  const { createInterface } = io.createInterface
    ? { createInterface: io.createInterface }
    : await import('node:readline/promises');
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stderr;
  const rl = createInterface({ input, output });
  try {
    const answered = rl.question(`${question} [y/N] `);
    // 与 'close' 赛跑：EOF 时 readline 只会 close，而那个 question 永远不落定。
    const eof = new Promise((resolve) => { rl.once('close', () => resolve(EOF)); });
    const a = await Promise.race([answered, eof]);
    if (a === EOF) {
      output.write('\n（标准输入已关闭 —— 按「否」处理，链未改动）\n');
      return false;
    }
    return ['y', 'yes'].includes(String(a).trim().toLowerCase());
  } finally {
    rl.close();
  }
}

/** 用一个独一无二的哨兵区分 EOF 与"用户真的输入了空串" —— 后者也该是否，但理由不同。 */
const EOF = Symbol('stdin-eof');
