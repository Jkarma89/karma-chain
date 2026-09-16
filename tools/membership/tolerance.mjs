// tools/membership/tolerance.mjs —— 成员数与容错上限的关系（功能 005 / FR-011 / FR-012 / F-5）。
//
// ## 为什么单独成文件
//
// 加成员与退成员用的是**同一套算术**，而它们在两个工具里。写两份的后果不是
// "多打几行字"，是**两份会各自漂移** —— 而漂移的样子是：加的时候说"可离线 1 个"、
// 退的时候说"可离线 2 个"，两句话都看着合理，没有任何测试会红。
//
// 面板那边（snapshot.mjs）另有一处 `Math.floor(n / 4)`。**那一处刻意不合并**：
// 那个模块零 import 是 node-status 能引用它的前提（见 tests/unit/node-image-fields
// 与 binaries-env 那两条守卫的理由）。代价是这条规则有两处实现，
// 所以 tests/unit/tolerance-after-add.test.mjs 里有一条按 F-5 真值表逐行比对的守卫。
//
// ## 这套算术本身
//
// 可离线数 f = ⌊n/4⌋，来自 `minConnectedStakeToQuery = α/k = 15/20 = 75%`
// （研究 R-05）：发起查询要求已连接权重 ≥ 75%，故可离线的最大 f 满足 (n−f)/n ≥ 0.75。
//
// **前提是等权**（research V-22 实测各 100）。权重不等时这条推导不成立 ——
// 调用方拿到 equalWeights=false 时必须说破，不能给一个按不成立前提算出的数。
//
// F-5 那张表（加成员**常常买不到**容错提升，这是本特性最反直觉的一条）：
//
//   n   4  5  6  7  8  9  10 11 12
//   f   1  1  1  1  2  2  2  2  3

/** 可离线数 f = ⌊n/4⌋。**本仓库 tools/membership 下只有这一处定义。** */
export const maxOffline = (n) => Math.floor(n / 4);

/** 容错会不会变？加成员时 n 增大，⌊n/4⌋ **可能不变** —— 这一条必须说出来（FR-037 / F-5）。 */
export function toleranceChange(before, after) {
  return {
    before: { n: before, f: maxOffline(before) },
    after: { n: after, f: maxOffline(after) },
    changed: maxOffline(before) !== maxOffline(after),
  };
}

/**
 * 加一个成员**会不会把链推过容错上限**。
 *
 * ## 为什么必须有这一条
 *
 * 2026-09-15 停电之后：链上 5 个成员、win-2 断电离线 —— 正好在 ⌊5/4⌋ = 1 的边界上，
 * 链照常出块。而要注册的 l1-6 所在机器**也断着电**。
 *
 * 若此时注册：n = 5 → 6，而 ⌊6/4⌋ **仍然是 1**；离线的却变成两个 > 1 ——
 * **链会真的停止出块**，而停的原因不是故障，是"容错分母涨了、门槛没跟着涨"。
 * 我差一步就这么干了；拦住我的是人工核对，不是工具。所以它现在是工具的一部分。
 */
export function toleranceAfterAdd({ membersBefore, offlineIds, newMemberOnline }) {
  const offBefore = offlineIds.length;
  const nAfter = membersBefore + 1;
  const offAfter = offBefore + (newMemberOnline ? 0 : 1);
  const fBefore = maxOffline(membersBefore);
  const fAfter = maxOffline(nAfter);
  const withinBefore = offBefore <= fBefore;
  const withinAfter = offAfter <= fAfter;
  return {
    before: { n: membersBefore, f: fBefore, offline: offBefore, within: withinBefore },
    after: { n: nAfter, f: fAfter, offline: offAfter, within: withinAfter },
    offlineIds,
    newMemberOffline: !newMemberOnline,
    // **这一下造成的**停摆：之前在容错内，之后不在。
    // 之前就已越界的情况不算在这里 —— 那时链已经停了，要报的是另一件事。
    wouldStopChain: withinBefore && !withinAfter,
  };
}

/**
 * 退一个成员的代价（FR-011 / FR-012）。
 *
 * ## 退比加更容易出错，而且方向是反直觉的
 *
 * 加成员时分母涨、门槛常常不涨（F-5）。**退成员时分母降，门槛可能跟着降** ——
 * 而那意味着"本来还能容忍 2 个离线，退完只能容忍 1 个"。
 * 若此刻恰好已经有 2 个离线，这一退就把链停了 —— 而被退掉的那个可能根本是好的。
 *
 * 所以要分开报两件事，它们的处置不同：
 *
 *   `toleranceDrops`        f 变小了 —— **要人确认**（FR-011）：代价是真实的，但决定权在人
 *   `wouldBreachThreshold`  退完之后离线数会超过新的 f —— **拦下**（FR-012）：
 *                           这不是权衡，是这一步会立刻把链停掉
 *
 * 两者独立：n=8→7 时 f 从 2 降到 1（要确认），但若当前一个都没离线，
 * 退完 0 ≤ 1 仍然安全，不该拦。
 *
 * ## 退掉一个**已经离线**的成员是在改善处境
 *
 * 它本来就不在为共识出力，却占着分母。退掉它 n 降 1、离线数也降 1 ——
 * 常常比退一个在线的更安全。这一条要能从结果里看出来，否则工具会对
 * "清理一台已经坏掉的机器"这件事发出吓人的警告。
 *
 * @param {{membersBefore: number, offlineIds: string[], removingNodeId: string}} args
 *   `offlineIds` 是**当前离线的成员** nodeId；`removingNodeId` 是要退的那个。
 */
export function removalImpact({ membersBefore, offlineIds, removingNodeId }) {
  if (!Number.isInteger(membersBefore) || membersBefore < 1) {
    throw new Error(`membersBefore 是 ${membersBefore} —— 必须是 ≥ 1 的整数`);
  }
  if (!removingNodeId) throw new Error('removalImpact 需要 removingNodeId —— 退的是哪一个决定了离线数怎么变');

  const removingIsOffline = offlineIds.includes(removingNodeId);
  const offBefore = offlineIds.length;
  const offAfter = offlineIds.filter((id) => id !== removingNodeId).length;
  const nAfter = membersBefore - 1;
  const fBefore = maxOffline(membersBefore);
  const fAfter = maxOffline(nAfter);
  const withinBefore = offBefore <= fBefore;
  const withinAfter = nAfter > 0 && offAfter <= fAfter;

  return {
    before: { n: membersBefore, f: fBefore, offline: offBefore, within: withinBefore },
    after: { n: nAfter, f: fAfter, offline: offAfter, within: withinAfter },
    offlineIds,
    removingNodeId,
    /** 退的是一个已经离线的成员 —— 它占着分母却不出力，退掉是在改善处境。 */
    removingIsOffline,
    /** f 变小了。**不是错误，是代价** —— 要人确认（FR-011）。 */
    toleranceDrops: fAfter < fBefore,
    /** 退完之后离线数会超过新的 f。**拦下**（FR-012）—— 这一步会立刻把链停掉。 */
    wouldBreachThreshold: withinBefore && !withinAfter,
    /** 退到一个成员都不剩。没有"缩容到零"这回事 —— 那是销毁这条链。 */
    wouldEmptySet: nAfter < 1,
  };
}
