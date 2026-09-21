// tools/membership/cli-failure.mjs —— 成员工具的**失败出口**：说清链动没动过。
//
// ## 为什么需要它（T031 场景 N，2026-09-21 注入实测）
//
// 把入口代理停掉再跑 `devnet-member remove`，拿到的是：
//
//   [TypeError: fetch failed]
//     [cause]: Error: getaddrinfo ENOTFOUND karmachain-rpc-win-1
//   Node.js v24.21.0
//   exit=1
//
// 一段**原始堆栈**加上**退出码 1**。而本仓库的成员工具用的是 30/31/32/33 那一套 ——
// 1 在这里没有任何含义，靠退出码分流的调用方读不出发生了什么。
//
// 场景 N 的判据是「四次都能说清，**没有一次只回『失败了』**」——
// 而这一次连"失败了"都算不上：它是一段崩溃。
//
// 成因：三个工具的命令行主体都是**顶层 await 且没有 try/catch**，
// 于是任何未预料的抛出都直通 Node 的默认处理。
//
// ## 这里只回答一个问题：**链动了没有**
//
// 别的都是次要的。看得见进度就能重试，看不见就只能人工去核 ——
// 所以每条失败路径都必须把这件事讲清楚，而不是把 stack trace 摊给人看。
import { EXIT_PRECHECK, EXIT_STEP_FAILED } from './exit-codes.mjs';

/**
 * 链**可达吗** —— 在动任何东西之前问一次。
 *
 * 不可达时以 `EXIT_PRECHECK`（30）退出：那个码的含义正是
 *「前置检查未通过 —— **一步都没动链**」，而此刻这句话是确定为真的。
 */
export async function assertChainReachable({ client, rpcUrl, label = 'L1 RPC' }) {
  try {
    await client.getBlockNumber();
  } catch (err) {
    const cause = err?.cause?.cause ?? err?.cause ?? err;
    console.error(`\n✗ 连不上${label}：${rpcUrl}`);
    console.error(`  ${cause?.code ? `${cause.code}: ` : ''}${cause?.message ?? err.message}`);
    console.error('\n  **一步都没动链** —— 本命令在读到链上进度之前就停了。');
    console.error('  常见成因：入口代理没起来（scripts/devnet-start），');
    console.error('  或 KARMACHAIN_RPC_URL 指向了一个本容器到不了的地址。');
    console.error('  修好之后直接重跑：进度从链上读，不依赖本次运行留下的任何东西。');
    process.exit(EXIT_PRECHECK);
  }
}

/**
 * 兜底：未预料的抛出。
 *
 * **不说"链没动"** —— 到这一步我们不知道。能确定的只有一件事：
 * 进度是从链上读的，所以再跑一次就能看到真实状态。那才是该给的下一步。
 */
export function reportUnexpected(err, { command }) {
  const cause = err?.cause?.cause ?? err?.cause ?? null;
  console.error(`\n✗ ${command} 未预料的失败：${err?.message ?? err}`);
  if (cause && cause !== err) {
    console.error(`  根因：${cause.code ? `${cause.code}: ` : ''}${cause.message ?? cause}`);
  }
  console.error('\n  **链动没动过，这里说不准** —— 不要据此假设任何一侧的状态。');
  console.error(`  再跑一次 ${command}：它**从链上读**当前进度，会准确报出停在第几步。`);
  console.error('  若要在动手之前先看一眼：scripts/devnet-member.sh status（只读）。');
  if (err?.stack) console.error(`\n（堆栈，供排查）\n${err.stack}`);
  process.exit(EXIT_STEP_FAILED);
}
