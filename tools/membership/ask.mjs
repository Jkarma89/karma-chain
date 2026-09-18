// tools/membership/ask.mjs —— 危险动作前的那一问，加入与退出**共用**一份。
//
// ## 缺陷一：stdin 关闭时以 13 退出
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
// 结果拿到退出码 13）。两份拷贝会各自漂移，所以抽到这里。
//
// **EOF 按「否」处理**是对的方向：这一问守的是写链的动作，
// "没人回答"与"回答了否"在处置上应当相同 —— 都不动链。
//
// ## 缺陷二：**只有第一问能被回答**（2026-09-17 T033 实测）
//
// 走第三步时要连着答两问（推进 P 链、提交交易）。管道里喂进 `y / n / y`，输出是：
//
//   执行第 2 步？ [y/N]                  ← 读到了 y
//   **先把 P 链推进一格？** [y/N]
//   （标准输入已关闭 —— 按「否」处理）      ← 管道里明明还有两行
//
// 形状很坏：**默认否让它看起来像一次正常的拒绝**。人会以为自己答错了，
// 或者以为工具问过了 —— 而那一问从来没被听见。
// 交互式确认是这套工具唯一的安全闸，而它只有第一道闩。
//
// ### 根因不是 close()，是**行被发出来就丢了**
//
// 第一版归因错了：以为是 `finally` 里的 `rl.close()` 把底层 stdin 一起收掉，
// 于是改成共享一个 readline、问完只 `pause()`。**没修好** —— 实测仍是
// `false,false,false`。
//
// 真正的原因：管道会把 `n\ny\nn\n` 一次交完，readline 立刻为每一行发一个
// `'line'` 事件，而 `rl.question()` **只听一次**。后两行发出来没人接，就丢了；
// 随后 stdin 到尽头，`'close'` 触发，于是后面每一问都是 EOF。
//
// 所以要自己攒一个**行队列**：`'line'` 一律入队，`ask()` 从队里取；
// 队空才去等下一行或 EOF。这样"输入一次到齐"与"人一行一行敲"走同一条路。
//
// 教训：一个"改完没验就以为修好了"的修法，和原缺陷一样坏 —— 这次是靠
// `tests/unit/membership-ask.test.mjs` 里**起子进程**的那一组抓住的。
// 注入 input/output 的用例测不到 `process.stdin` 的生命周期。

/** 用一个独一无二的哨兵区分 EOF 与"用户真的输入了空串" —— 后者也该是否，但理由不同。 */
const EOF = Symbol('stdin-eof');

/** 默认（process.stdin）那条路的共享状态。注入 io 的调用方不碰这些。 */
let shared = null;
/** 已经到达、但还没被哪一问取走的行。 */
const pending = [];
/** 正在等一行的那个 resolve（同一时刻最多一个 —— 这一问是串行的）。 */
let waiter = null;
/** stdin 到了尽头就不会再回来。 */
let ended = false;

function sharedInterface(createInterface, output) {
  if (shared) return shared;
  shared = createInterface({ input: process.stdin, output });
  shared.on('line', (line) => {
    if (waiter) { const w = waiter; waiter = null; w(line); } else { pending.push(line); }
  });
  shared.once('close', () => {
    ended = true;
    if (waiter) { const w = waiter; waiter = null; w(EOF); }
  });
  return shared;
}

function nextLine() {
  if (pending.length) return Promise.resolve(pending.shift());
  if (ended) return Promise.resolve(EOF);
  // 只在**真的要等人**的时候占住事件循环；否则进程不会自己退出。
  process.stdin.ref?.();
  return new Promise((resolve) => { waiter = resolve; });
}

const yes = (a) => ['y', 'yes'].includes(String(a).trim().toLowerCase());

/**
 * 问一个是非题。**默认否**：只有明确的 `y` / `yes` 才算是。
 *
 * @param {string} question 问题本身（不带 `[y/N]`，由本函数补）
 * @param {{input?: import('node:stream').Readable, output?: import('node:stream').Writable,
 *          createInterface?: Function}} [io]
 *   `input` / `output` 可注入，使这条路径能离线测 —— 但**注入的那条路测不到
 *   `process.stdin` 的生命周期**，缺陷二就藏在那里。默认路径由子进程用例守。
 * @returns {Promise<boolean>}
 */
export async function ask(question, io = {}) {
  const injected = Boolean(io.input || io.output || io.createInterface);
  const output = io.output ?? process.stderr;
  const { createInterface } = io.createInterface
    ? { createInterface: io.createInterface }
    : await import('node:readline/promises');

  // ── 注入路径：流由调用方掌管，各建各的、用完即关（行为与最初版一致）──────
  if (injected) {
    const rl = createInterface({ input: io.input ?? process.stdin, output });
    try {
      const answered = rl.question(`${question} [y/N] `);
      const eof = new Promise((resolve) => { rl.once('close', () => resolve(EOF)); });
      const a = await Promise.race([answered, eof]);
      if (a === EOF) {
        output.write('\n（标准输入已关闭 —— 按「否」处理，链未改动）\n');
        return false;
      }
      return yes(a);
    } finally {
      rl.close();
    }
  }

  // ── 默认路径：共享一个 readline + 自己的行队列 ─────────────────────────────
  sharedInterface(createInterface, output);
  output.write(`${question} [y/N] `);
  const a = await nextLine();
  process.stdin.unref?.();
  if (a === EOF) {
    output.write('\n（标准输入已关闭 —— 按「否」处理，链未改动）\n');
    return false;
  }
  return yes(a);
}

/**
 * 交还 stdin。调用方**不需要**在正常退出前调它（各分支都是显式 `process.exit`），
 * 它是给"想让进程自然退出"的调用方，以及测试留的。
 */
export function closeAsk() {
  if (shared) { shared.close(); shared = null; }
  pending.length = 0;
  waiter = null;
  ended = false;
}
