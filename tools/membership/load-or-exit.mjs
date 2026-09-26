// tools/membership/load-or-exit.mjs —— 成员工具加载声明时的统一出口（功能 005 / FR-017）。
//
// ## 为什么要有这一层
//
// `loadProtocol()` 在声明不合法时**抛异常**。四个成员工具都直接调它，于是一份
// 违反约束的 `deployment.json` 会让它们以**未捕获异常 + 堆栈 + 退出码 1** 收场。
//
// 2026-09-26 现场（SC-009 活链验证）：把三个验证者塞进同一个故障边界之后跑加入，
// 得到的是
//
//     Error: configuration invalid:
//       - constraint: [T-5] 形态 "lan"：故障边界 'ubuntu-3' 含 3 个 L1 验证者…
//         at loadProtocol (file:///…/tools/protocol/load.mjs:412:11)
//     Node.js v22.19.0
//
// **那段文案本身是好的** —— 它点名了边界、给了上限的推导、说了把哪个节点移走。
// 坏的是它的**形式**：
//
//   ① 退出码 1。契约（tools/membership/exit-codes.mjs）里 **30 = 前置检查未通过、
//      一步都没动链**，而这正是那种情形。靠退出码分流的调用方会把它当成未知故障。
//   ② 堆栈把人引向 `load.mjs:412`，而真正要改的是 `blockchain/deployment.json`。
//
// **这是本期已经记过一次的那个形状**：T031 的注入 ① 发现"入口不可达时抛原始堆栈、
// 退出码 1"并修掉了。同一类问题、另一个触发点 —— 说明当时修的是那一处，不是这一族。
// 所以这次修在**共用的一层**，四个工具都走它。
import { loadProtocol, TOPOLOGY_VIOLATION_TAG } from '../protocol/load.mjs';
import { EXIT_PRECHECK } from './exit-codes.mjs';

/**
 * 加载合并后的声明；不合法时**干净地**退出 30，不抛堆栈。
 *
 * @param {{exit?:(code:number)=>never, error?:(...a:unknown[])=>void, load?:()=>object}} io
 *   注入点，供守卫用；默认打到 stderr 并 `process.exit`。
 */
export function loadConfigOrExit(io = {}) {
  const load = io.load ?? loadProtocol;
  const error = io.error ?? ((...a) => console.error(...a));
  const exit = io.exit ?? ((c) => process.exit(c));
  try {
    return load();
  } catch (err) {
    const msg = String(err?.message ?? err);
    error('\n✗ 声明不合法 —— **一步都没动链**：\n');
    // 第一行是 "configuration invalid:"，后面每行是一条具体约束。只转述，不改写：
    // 那些文案里已经写明了"把哪个节点移到哪儿"，重新措辞只会把可执行的部分磨掉。
    for (const line of msg.split('\n').slice(1)) {
      if (line.trim()) error(`  ${line.trim()}`);
    }
    if (msg.includes(TOPOLOGY_VIOLATION_TAG)) {
      error('\n  这是拓扑约束 T-5：边界数 > 1 时，任一故障边界内的验证者不得超过 ⌊n/4⌋。');
      error('  改 blockchain/deployment.json 的 failureDomains，再跑 npm run render。');
    }
    error('\n  改完重跑本命令即可 —— 链上没有留下任何中间态。');
    return exit(EXIT_PRECHECK);
  }
}
