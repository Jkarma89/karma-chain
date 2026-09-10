// tools/dashboard/public-view.mjs —— 公开投影（功能 003 / T065、L8）。
//
// **纯函数，显式字段白名单。**
//
// ## 方向必须是白名单，不是黑名单
//
// 黑名单（"删掉 nodeId 和 address"）在有人给快照加一个新字段时**默认放行** ——
// 而那正是泄漏发生的方式。白名单方向是唯一能随快照结构演进而保持安全的方向：
// 新字段默认**不**公开，要公开就得有人显式把它加进这里，而那一刻
// `tests/unit/dashboard-public-view.test.mjs` 的结构断言会强迫他做这个决定。
//
// ## 允许公开的九个字段，逐个说明为什么安全
//
// | 字段 | 为什么可以公开 |
// |---|---|
// | chainId / networkId / chainAlias | 链的公开身份，第三方接入必需 |
// | rpcPath | 公开的 RPC 路径，`docs/public/chain-info.json` 已经在公布 |
// | publishedHosts | 取自 `endpoints.publishedHosts`，既有测试已禁止它含私网地址 |
// | networkHeight | 公开链的当前高度，任何人查一下 RPC 都能得到 |
// | tier / healthPercent | 链的可用性 —— **刻意公开**：对外视图不隐瞒链停了这件事 |
// | collectedAt | 采集时刻，让看的人能判断新鲜度 |
//
// ## 刻意**不**公开的东西
//
// 逐节点明细（含 NodeID、局域网地址、容器名、`detail` 里的仓库路径）、
// 异常清单（含地址与容器名）、观察者视角（内部事实）、容错的边界结构（含机器 id）、
// `blockchainId`、`genesisHash`、`summaryLine`（可能含组件版本）、`deployment`
// （形态名会暴露部署规模）。
//
// 契约：specs/003-chain-health-dashboard/contracts/dashboard-api.md 第 4 节。

/** 允许公开的字段。**改动这个集合就是一次对外披露决策**，不是重构。 */
export const PUBLIC_FIELDS = new Set([
  'chainId', 'networkId', 'chainAlias', 'rpcPath', 'publishedHosts',
  'networkHeight', 'tier', 'healthPercent', 'collectedAt',
]);

/**
 * 把完整快照投影成对外安全的精简视图。
 *
 * 实现方式刻意是**逐字段挑出**，而不是"拷贝再删除" —— 后者是黑名单，
 * 新字段会默认跟着出去。
 */
export function toPublicView(snapshot) {
  const id = snapshot?.chainIdentity ?? {};

  // 逐字段构造。每一行都是一次显式的公开决定。
  const out = {
    chainId: id.chainId ?? null,
    networkId: id.networkId ?? null,
    chainAlias: id.chainAlias ?? null,
    rpcPath: id.rpcPath ?? null,
    publishedHosts: Array.isArray(id.publishedHosts) ? [...id.publishedHosts] : [],
    networkHeight: snapshot?.networkHeight ?? null,
    tier: snapshot?.tier ?? null,
    healthPercent: snapshot?.healthPercent ?? null,
    collectedAt: snapshot?.collectedAt ?? null,
  };

  // 自检：键集合必须恰好等于白名单。写错一行会在这里立刻炸，
  // 而不是等到某天有人发现对外视图多了个字段。
  const keys = Object.keys(out);
  if (keys.length !== PUBLIC_FIELDS.size || keys.some((k) => !PUBLIC_FIELDS.has(k))) {
    throw new Error(
      `公开投影的字段与白名单不符：输出 [${keys.join(', ')}]，`
      + `白名单 [${[...PUBLIC_FIELDS].join(', ')}]`,
    );
  }
  return out;
}
