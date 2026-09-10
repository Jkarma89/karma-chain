// tools/dashboard/snapshot.mjs —— 判定层（功能 003 / T009–T012、T018–T020）。
//
// **本文件全是纯函数**：不读文件、不发请求、不看时钟。理由见 ../README.md ——
// 其中两条最重要的分支（观察者失明、全员启动中）在活链上很难制造，
// 若判定不能离线测试就只能靠"希望它对"。002 的 classify() 已采用同一做法。
//
// 判据来源（不在此处重新发明）：
//   - 节点状态与 countsAsOffline / countsTowardTolerance → 既有 ../inspect/node-status.mjs 的 classify()
//   - validatorCount / maxOfflineValidators / effectiveDomains → 既有 ../protocol/load.mjs 的 faultTolerance()
//
// 契约：specs/003-chain-health-dashboard/contracts/health-tier.md
//       specs/003-chain-health-dashboard/data-model.md

/** 档位取值。三个健康度档位 + 两个"此刻不该用健康度回答"的状态（FR-007）。 */
export const TIERS = Object.freeze({
  OBSERVER_BLIND: 'observer-blind',
  STARTING: 'starting',
  STOPPED: 'stopped',
  ZERO_MARGIN: 'zero-margin',
  NORMAL: 'normal',
});

/** 异常分类。宪法第九条要求区分，因为**处置方式完全不同**。 */
export const INCIDENT_CLASSES = new Set([
  'observation', 'node-infra', 'sync-lag', 'consensus-margin', 'chain-identity',
]);

/** 已引导且在服务 L1 —— 只有这两个状态本身就代表"在提供连接权益"。 */
const SERVING_L1 = new Set(['healthy', 'catching-up']);

/** 尚未服务 L1 的"要等"状态。它们**不**提供连接权益，但也不是故障。 */
const WAITING = new Set(['bootstrapping', 'starting']);

const SYNC_LAG_STATES = new Set(['catching-up', 'bootstrapping', 'starting']);
const NODE_INFRA_STATES = new Set(['stopped', 'stalled', 'identity-mismatch', 'data-corrupt']);

/**
 * 这个节点是否**在为共识提供连接权益**。
 *
 * **不能直接用 `countsAsOffline`**（data-model 第 0 节）：那个谓词回答的是
 * "这节点须不须要处置"，其 `NOT_OFFLINE` 集合**包含 `bootstrapping`** —— 对
 * `devnet-status` 是对的（引导中是"要等"，不是故障），但对健康度是错的：
 * 引导中的验证者对 α/k 查询门槛毫无贡献。直接复用会把
 * 「1 个健康 + 4 个引导中」算成 100% 正常，而链一个块都出不了。
 *
 * 两个谓词各自服务一个问题，都要保留。本函数是从既有 `state` + `countsAsOffline`
 * **派生**的，不重新观测、不重新判断节点状态 —— 因此没有第二个事实来源。
 */
export function participatesInConsensus(row) {
  if (!row.countsTowardTolerance) return false;          // Primary 不参与 L1 出块（研究 R-09）
  if (SERVING_L1.has(row.state)) return true;            // FR-011：catching-up 在服务 L1
  // `unreachable` 有两种含义且离线语义**相反**（既有契约 data-model §7）：
  // 其余节点的对等列表里有它 → 链里有它，断的是本机到它的路径 → **算参与**（FR-012）。
  if (row.state === 'unreachable') return row.countsAsOffline === false;
  return false;
}

/**
 * 边界级余量：最大的 k，使任意 k 个**有效**边界同时整体失效后，
 * 不参与共识的验证者数仍 ≤ maxOfflineValidators。
 *
 * 按 validators **降序**贪心 —— 取最坏边界，不取平均。容错承诺必须按最坏情况给。
 *
 * 必须用 `effectiveDomains`（并查集之后）而非声明的 `failureDomains`：
 * load.mjs:259 就此留了注释 —— 按声明边界判会得到「可容忍 1 个边界整体失效 [OK]」
 * 这样**在现实里为假的绿灯**，因为共享失效因素（同一路供电、同一台交换机）会被掩盖。
 */
function deriveDomainMargin(faultTolerance, alreadyDown) {
  const sizes = (faultTolerance.effectiveDomains ?? [])
    .map((g) => g.validators ?? 0)
    .sort((a, b) => b - a);
  let used = alreadyDown;
  let k = 0;
  for (const size of sizes) {
    if (used + size > faultTolerance.maxOfflineValidators) break;
    used += size;
    k += 1;
  }
  return k;
}

/**
 * 档位、百分比与两个余量。
 *
 * **判定顺序是严格优先级，不得调换**（契约第 3 节）。每一条调换的后果都写在下面，
 * 因为其中两条恰好会产生"看起来正常"的错误：
 *
 *   P1  观察者失明                          → observer-blind
 *   P2  低于门槛且缺口全由"要等"造成         → starting
 *   P3  低于门槛                            → stopped
 *   P4  余量为 0                            → zero-margin
 *   P5  其余                                → normal
 *
 * **零字面阈值**：threshold 与 healthPercent 全部由 validatorCount 与
 * maxOfflineValidators 算出。80% / 60% 是 n=5,f=1 时的**结果**，不是输入 ——
 * n=9,f=2 时同一判定式给出 78% / 67%（契约第 4b 节）。
 */
export function deriveTier({ rows, faultTolerance, observer }) {
  const { validatorCount, maxOfflineValidators } = faultTolerance;
  const counted = rows.filter((r) => r.countsTowardTolerance);
  const notParticipating = counted.filter((r) => !participatesInConsensus(r));
  const participating = counted.length - notParticipating.length;

  const threshold = validatorCount - maxOfflineValidators;
  // 分母恒为**声明的** validatorCount，不是观测到的行数 —— 沿用既有 summarize() 的理由：
  // 拿观测行数当分母，会在少了一行时把缺失悄悄算成在线。
  const healthPercent = validatorCount > 0
    ? Math.round((participating / validatorCount) * 100)
    : 0;
  const validatorMargin = Math.max(0, maxOfflineValidators - notParticipating.length);
  const domainMargin = deriveDomainMargin(faultTolerance, notParticipating.length);

  const tier = (() => {
    // P1 —— 必须最先判。若放到 P3 之后：观察者本机断网 → 7 个节点全不可达 →
    // seenByPeers 为空、每边界 domainAllUnreachable → 验证者全判离线 → 落进 P3
    // 报「链已停止」。**这正是 FR-020 明令禁止的假报警，也是既有代码孤立使用时的默认行为。**
    if (observer?.blind ?? (observer?.reachableNodes === 0)) return TIERS.OBSERVER_BLIND;

    if (participating < threshold) {
      // P2 —— 必须先于 P3。若放到 P3 之后：跨机分批启动期间报「链已停止」，
      // 而正确结论是"还在等其余边界"。002 实测过 ubuntu-1 单独启动时的这一处境。
      //
      // 未观测到的验证者按**保守侧**处理（不算作"要等"）：看不见的节点不能被当成
      // "正在启动"，那会把观测缺口说成一个乐观结论。
      const unobserved = validatorCount - counted.length;
      const allWaiting = unobserved <= 0 && notParticipating.every((r) => WAITING.has(r.state));
      return allWaiting ? TIERS.STARTING : TIERS.STOPPED;
    }

    // P4 —— 必须在 P3 之后。逻辑上 margin===0 时 participating 必 ≥ threshold，
    // 所以写反不会立刻报错，而是让 stopped 这一档**永远不出现** —— 一个永不变红的报警。
    if (validatorMargin === 0) return TIERS.ZERO_MARGIN;
    return TIERS.NORMAL;
  })();

  return {
    tier,
    healthPercent,
    participating,
    threshold,
    validatorCount,
    maxOfflineValidators,
    observedValidators: counted.length,
    validatorMargin,
    domainMargin,
    notParticipatingIds: notParticipating.map((r) => r.id),
  };
}

/**
 * 单个节点的异常分类。分类**决定处置方式**，所以必须机器可读（枚举），
 * 不能只靠既有 `detail` 的自由文本 —— 页面要按分类分组，测试要按分类断言。
 */
export function incidentClass(row) {
  if (row.state === 'healthy') return null;
  // 同一个状态名，两种含义，两种处置：修本机网络 vs 去那台机器
  if (row.state === 'unreachable') return row.countsAsOffline ? 'node-infra' : 'observation';
  if (SYNC_LAG_STATES.has(row.state)) return 'sync-lag';
  if (NODE_INFRA_STATES.has(row.state)) return 'node-infra';
  return null;
}

const ACTIONS = Object.freeze({
  observation: '修本机到该节点的网络路径。链是好的，别去动那台机器',
  'node-infra': '到那台机器上查节点进程、数据卷与挂载的密钥',
  'sync-lag': '等。这不是故障，不要处置',
  'consensus-margin': '恢复验证者数量 —— 这不是修某一个节点能解决的',
  'chain-identity': '那台机器跑在另一条链上。核对它的创世与协议参数',
});

const incident = (cls, message, nodeId) => ({
  class: cls,
  message,
  action: ACTIONS[cls],
  ...(nodeId ? { nodeId } : {}),
});

/**
 * 整条链层面的异常清单。每条都带分类与处置方向（宪法第九条）。
 *
 * 两条刻意的"不产生"：
 *   - `observer-blind` **不**产生 consensus-margin —— 面板自己瞎了不是共识问题。
 *     归错类会让人去看验证者，而要修的是本机网络。
 *   - `starting` **不**产生 consensus-margin —— 它是"要等"，不是"须处置"。
 */
export function buildIncidents({ rows, tier, observer, chainIdentity }) {
  const out = [];

  for (const row of rows) {
    const cls = incidentClass(row);
    if (!cls) continue;
    out.push(incident(cls, `${row.id}：${row.detail || row.state}`, row.id));
  }

  if (tier === TIERS.OBSERVER_BLIND) {
    const alive = (observer?.pathAlive ?? []).filter((p) => p.alive);
    out.push(incident(
      'observation',
      alive.length > 0
        ? `本机连不上任何节点，但到 ${alive.length} 台机器的网络路径是通的 —— 节点确实不应答，请到机器上确认节点进程`
        : '本机连不上任何节点，且各机器的端口全部无应答 —— 更像本机网络问题，请先检查本机网卡与交换机',
    ));
  } else if (tier === TIERS.ZERO_MARGIN || tier === TIERS.STOPPED) {
    out.push(incident(
      'consensus-margin',
      tier === TIERS.STOPPED
        ? '连接权益低于查询门槛，链已停止出块'
        : '容错余量为 0：再有一个验证者离线即停摆，链目前仍在正常出块',
    ));
  }

  // 分叉与档位**并列**，不相互影响（FR-025）：那个节点自己活得很好，健康度可以是 100%。
  // `genesisMatchesBaseline === null`（未取到）**不**触发 —— 虚报一次分叉，这条警报就再没人信。
  if (chainIdentity?.forkDetected) {
    const bad = rows.filter((r) => r.genesisMatchesBaseline === false).map((r) => r.id);
    out.push(incident('chain-identity', `创世哈希与仓库基准不一致：${bad.join('、')}`));
  }

  return out;
}

/**
 * 链身份与分叉判定。**纯函数** —— 文件读取由调用方（poll.mjs / server.mjs）负责，
 * 因为本文件必须保持可离线测试。
 *
 * `genesisMatchesBaseline` 保持**三值**：null（未取到）≠ false（不匹配）。
 * 把取不到当成不匹配，会在链路抖动时虚报分叉。
 */
export function buildChainIdentity({ chain, baselineGenesisHash, rows }) {
  const observed = rows.filter((r) => r.countsTowardTolerance);
  return {
    ...chain,
    baselineGenesisHash,
    forkDetected: observed.some((r) => r.genesisMatchesBaseline === false),
    unknownGenesis: observed.some((r) => r.reachable && r.genesisMatchesBaseline === null),
  };
}

/**
 * 逐节点补齐派生字段：落后量、创世哈希比对、异常分类、参与共识。
 * 既有 classify() 给出的字段一律原样保留，不改名、不覆盖。
 */
export function enrichRows({ rows, networkHeight, baselineGenesisHash }) {
  // **基准读不到时一律为 null，不是 false。**
  // 早先写成 `String(baselineGenesisHash).toLowerCase()`，于是基准为 null 时
  // 每个节点都拿自己的哈希去和字符串 "null" 比 —— 全判不匹配，面板会报
  // 「五台机器全跑在不同链上」。一个仓库文件读不到，不该变成一场分叉警报。
  // （2026-09-10 由 tests/unit/dashboard-fork.test.mjs 抓到。）
  const baseline = typeof baselineGenesisHash === 'string' && baselineGenesisHash.length > 0
    ? baselineGenesisHash.toLowerCase()
    : null;

  return rows.map((r) => ({
    ...r,
    behindBlocks: networkHeight != null && r.height != null ? networkHeight - r.height : null,
    genesisMatchesBaseline: (r.genesisHash == null || baseline == null)
      ? null                                                   // 未取到 ≠ 不匹配
      : r.genesisHash.toLowerCase() === baseline,
    participatesInConsensus: participatesInConsensus(r),
    incidentClass: incidentClass(r),
  }));
}

/**
 * 组装完整快照（data-model 第 7 节）。
 *
 * `collectedAt` 由**调用方在探测完成时**打戳后传入 —— 不是请求到达时，
 * 也不在本文件里取时钟（纯函数）。页面的新鲜度判定依赖它反映数据年龄。
 */
export function buildSnapshot({
  collectedAt, pollIntervalMs, deployment, networkHeight,
  rows, faultTolerance, observer, chain, baselineGenesisHash,
  containerFacts, summaryLine,
}) {
  const enriched = enrichRows({ rows, networkHeight, baselineGenesisHash });
  const chainIdentity = buildChainIdentity({ chain, baselineGenesisHash, rows: enriched });
  const tierInfo = deriveTier({ rows: enriched, faultTolerance, observer });
  const incidents = buildIncidents({
    rows: enriched, tier: tierInfo.tier, observer, chainIdentity,
  });

  return {
    collectedAt,
    pollIntervalMs,
    deployment,
    networkHeight,
    ...tierInfo,
    faultTolerance,
    observer,
    chainIdentity,
    nodes: enriched,
    incidents,
    // T020：容器事实是**可选增强**（FR-030）。缺失时核心判据仍成立，但本机节点的
    // `stopped` 与 `unreachable` 会退化为后者 —— 这个降级必须**可见**，不静默接受。
    containerFacts: {
      available: Boolean(containerFacts?.available),
      reason: containerFacts?.reason ?? null,
      degraded: !containerFacts?.available,
      note: containerFacts?.available
        ? null
        : '未取到容器级事实：本机节点"被主动停止"与"整域缺席"无法区分，'
          + '前者会显示为后者。跑一次 scripts/devnet-status 可刷新这份事实。',
    },
    summaryLine: summaryLine ?? null,
  };
}
