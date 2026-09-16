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
  // 功能 005 / T073：读不到链上成员集合时的档位。
  // **不退回声明去凑一个结论** —— 那正是 research V-31 那次假警报的成因
  // （声明 6 / 链上 5 / 在线 4 → 按声明算出「链已停止」，而链在正常出块）。
  // 宁可承认不知道，也不要给出一个看起来确定的错结论。
  MEMBERS_UNKNOWN: 'members-unknown',
  STARTING: 'starting',
  STOPPED: 'stopped',
  ZERO_MARGIN: 'zero-margin',
  NORMAL: 'normal',
});

/**
 * 异常分类。宪法第九条要求区分，因为**处置方式完全不同**。
 *
 * 功能 004 追加第六类 `recovery-blocked`：它与 `node-infra` 并存而不重复 ——
 * 后者说"哪个东西坏了（去那台机器上查）"，前者说"因此现在不能做什么（别重启验证者）"。
 */
export const INCIDENT_CLASSES = new Set([
  'observation', 'node-infra', 'sync-lag', 'consensus-margin', 'chain-identity',
  'recovery-blocked',
  // 声明里有、链上没有 —— 正在加入或已退出。**都不是故障**（FR-028 / T038）
  'membership',
  // 某个**有效**故障边界的验证者数超过 ⌊n/4⌋（005 / FR-029）。
  // 它不是节点故障也不是链故障 —— 是**声明本身**有问题，处置在仓库里而不在机房里。
  'topology-limit',
  // 链上成员权重不等 → ⌊n/4⌋ 那条推导的前提不成立，上面所有余量数字都不可信
  //（005 / FR-024 的前提，research R-05 / V-22）。
  'tolerance-basis',
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
 * 这个 **Primary** 是否**在为 P 链提供服务**。
 *
 * ## 这是本仓库第三个「在线」谓词 —— 三个各回答一个不同的问题
 *
 * | 谓词 | 问题 | `bootstrapping` | Primary |
 * |---|---|---|---|
 * | `countsAsOffline`（002） | 这节点**须不须要处置**？ | 不算离线 | 按同一套规则判 |
 * | `participatesInConsensus`（003） | **还能再掉几个**验证者？ | 不算参与 | **恒 `false`** |
 * | `servesPChain`（004，本函数） | 验证者**还能不能重新加入**？ | 不算在服务 | 只对它有意义 |
 *
 * **不能拿 `participatesInConsensus` 去数 Primary。** 它第一行就是
 * `if (!row.countsTowardTolerance) return false`，而 Primary 的该字段**恒为 `false`** ——
 * 所以它对**任何** Primary 都返回 `false`，不管活着还是停着。拿它数"有几个 Primary 在服务"，
 * 答案恒为 0，于是恢复能力提示会**永远亮着**。
 * 一个永远亮着的提示和一个永远不亮的提示一样没用 —— 区别只是前者还额外教会人忽略它。
 *
 * 这是同一个坑的**第三种**踩法（前两种记在 003 的 data-model §0）。
 *
 * ## 为什么对非 Primary 返回 null 而不是 false
 *
 * `false` 会让一次**使用错误**（把验证者传进来）伪装成一个正常结论"它没在服务 P 链"，
 * 于是恢复能力被算错而没有任何东西变红。返回 `null` 让误用可被断言
 * （`tests/unit/recovery-capability.test.mjs` 就断言它是 `null` 而非 `false`）。
 *
 * 本函数与前两个一样是从既有 `state` + `countsAsOffline` **派生**的 ——
 * 不重新观测、不重新判断节点状态，因此没有第二个事实来源（FR-017）。
 *
 * @returns {boolean|null} `null` = 传进来的不是 Primary（使用错误）
 */
export function servesPChain(row) {
  if (row?.role !== 'primary') return null;
  if (SERVING_L1.has(row.state)) return true;          // healthy / catching-up：在服务
  // `unreachable` 的两种含义离线语义**相反**（002 的 data-model §7）：
  // 其余节点的对等列表里有它 → 它活着，断的是**本机到它的路径** → 算在服务（FR-018）。
  // 这一格写错的后果是：**一根网线松了，面板就告诉人"现在不能重启任何东西"**。
  if (row.state === 'unreachable') return row.countsAsOffline === false;
  return false;                                         // bootstrapping / starting / 各类故障
}

/**
 * 让一个已停的验证者能**重新加入**所需的在服务 Primary 数。
 *
 * **这个 2 来自权益门槛，不是"Primary 总数"。** 两个 Primary 各握 P 链 50% 权益，
 * 而 avalanchego 引导要求连上 ≥80% —— 所以两个都得在。
 * 2026-09-10 实测：只起回一个之后被重启的 l1-1 仍然卡死，它自报
 * `percentConnected: 0.5` / `"required at least 80.000000%"`。
 *
 * **写成 `primaries.length` 看起来更通用，实际会在拓扑变化时静悄悄给出错误结论**：
 * 3 个 Primary（各 33%）时 80% 门槛仍需 3 个全在；5 个（各 20%）时需要 4 个。
 * 真正的通用化（按权益算）属于"增加 Primary 节点数"那个特性，不在本期 ——
 * 本期把数字写死并把来源写清。
 *
 * 80% 这个百分比**不进判据**：它是 avalanchego 的内部门控参数，
 * 不在 blockchain/protocol.json 里，也可能随版本变化。
 */
export const PRIMARIES_REQUIRED_FOR_REJOIN = 2;

/**
 * 恢复能力 —— **与三档健康度正交**的一个维度：这张网现在还能不能让验证者重新加入。
 *
 * 它**不进**档位枚举。003 的五个状态（observer-blind / starting / stopped /
 * zero-margin / normal）是互斥的、靠严格优先级判定；而链可以是
 * 「正常出块 + 无法恢复」，也可以是「已停止 + 无法恢复」——
 * 两条信息必须能同时呈现，塞进同一个枚举会丢掉一半。
 *
 * **返回值不得影响档位**：调用点只把它作为附加字段，`deriveTier` 完全不读它（FR-013，
 * 由 tests/unit/recovery-tier-isolation.test.mjs 守）。
 *
 * @returns {'ok'|'blocked'|'unknown'}
 */
export function deriveRecoveryCapability({ rows, tier }) {
  // 观察者失明时**不作任何断言**（FR-019）。这一刻面板知道得最少 ——
  // 一个在本机网线松了时仍然断言"别重启任何东西"的面板，
  // 会把一次局部链路故障变成一次不必要的停手。
  if (tier === TIERS.OBSERVER_BLIND) return 'unknown';
  const serving = rows.filter((r) => servesPChain(r) === true).length;
  return serving < PRIMARIES_REQUIRED_FOR_REJOIN ? 'blocked' : 'ok';
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
 * 把容错判据**收敛到链上注册的成员**（功能 005 / T073）。
 *
 * ## 为什么必须这么做：实测到的假警报
 *
 * 2026-09-15 的状态：声明 6 个验证者（l1-6 已声明、未注册、未启动）、
 * 链上注册 5 个、win-2 整机离线导致 l1-2 缺席。面板按**声明的 6 个**算：
 *
 *   threshold = 6 - ⌊6/4⌋ = 5，participating = 4 < 5 → 判定「链已停止出块」
 *
 * **而链一直在出块** —— 一笔探测交易在区块 975 确认，耗时 8.7 秒。
 * 真实账是 5 个注册成员掉 1 个 = 80% ≥ 75%，仍在门槛之上（research V-31）。
 *
 * 这不是"数字不准"，是**结论方向错了**。假警报会让人去排查一个不存在的故障，
 * 而反复的假警报会训练人忽略面板 —— 那比少一个告警更坏。
 *
 * ## 谁是共识集合：**P 链**，不是声明，也不是合约
 *
 * 功能 005 之后成员运行期可变，**声明只是"我们打算有几个"**（data-model 第 2 节）。
 * 容错判据问的是"再掉几个就停摆"，那只能按**共识里真正带权重的成员**算 ——
 * 而那是 P 链的 L1 验证者集合。
 *
 * 合约侧也不行（2026-09-16 实测，T070）：第三步做完、第四步没做完时，
 * 合约说 5 个、P 链说 6 个。而那一刻 L1 的 Warp 校验报的是
 * `signature weight is insufficient: 67*600 > 100*200` —— **600**，
 * 即 6 个验证者的总权重。共识按 P 链算，这是直接证据。
 * 按合约算会少一个成员，方向**偏乐观**：把"再掉一个就停摆"报成"还有余量"。
 *
 * 声明与 P 链的差额、合约与 P 链的差额，都是**漂移/分歧**，单独呈现（FR-030 / T070），
 * 不该混进容错结论。
 *
 * ## 读不到时：说"不知道"，不要拿声明或合约凑
 *
 * 退回声明正是上面那个假警报的成因。`source !== 'p-chain'` 时本函数**原样返回**，
 * 并让调用方据此把档位判成"成员集合未知" —— 宁可承认不知道，
 * 也不要给出一个看起来确定的错结论。
 *
 * @param {object[]} rows                    已 enrich 的节点行（带 nodeId 与 domain）
 * @param {object}   faultTolerance          按**声明**派生的容错（deriveTopology 的输出）
 * @param {{source:'p-chain', registeredNodeIds:string[], equalWeights?:boolean}
 *        |{source:'unknown', error?:string}} memberSet
 */
export function scopeToChainMembers({ rows, faultTolerance, memberSet }) {
  if (memberSet?.source !== 'p-chain') {
    return {
      rows: rows.map((r) => ({ ...r, registeredOnChain: null })),
      faultTolerance,
      scoped: false,
    };
  }

  const registered = new Set(memberSet.registeredNodeIds);

  // 逐行判"这一行对应的节点在链上注册了吗"。
  // 用的是 `row.nodeId` —— poll.mjs 里它是**观测到的** NodeID，取不到时回落到声明值。
  // 观测优先是对的：容错问的是"现在跑着的这个节点算不算共识成员"，
  // 所以身份不符的节点应当**不**计入（它跑的不是我们注册的那个身份），
  // 而那种情形本来就另有 identity-mismatch 报出来。
  const scopedRows = rows.map((r) => {
    if (!r.countsTowardTolerance) return { ...r, registeredOnChain: null };  // Primary 本就不计
    const isRegistered = r.nodeId ? registered.has(r.nodeId) : null;
    return {
      ...r,
      registeredOnChain: isRegistered,
      // **未注册的声明成员不参与容错判据**。它照旧显示（见 view-nodes 的分组），
      // 但不进分子也不进分母 —— 它还不是共识成员，把它算进去就是上面那个假警报。
      countsTowardTolerance: isRegistered === true,
    };
  });

  // n 取 **P 链上带权重的成员数**，不是声明数，也不是行数。
  //
  // 不用行数的理由沿用 deriveTier 里那条：拿观测行数当分母，会在少了一行时
  // 把缺失悄悄算成在线。P 链上有 5 个而只看见 4 行时，第 5 个应当算**不参与**。
  const n = registered.size;
  const maxOfflineValidators = Math.floor(n / 4);

  // 有效边界的验证者数也要收敛 —— 否则某个只有"已声明未注册"验证者的边界
  // 会贡献一个不存在的余量。按 scopedRows 的 domain 重新数。
  const effectiveDomains = (faultTolerance.effectiveDomains ?? []).map((g) => ({
    ...g,
    validators: scopedRows.filter((r) => r.countsTowardTolerance && g.ids.includes(r.domain)).length,
  }));

  return {
    rows: scopedRows,
    faultTolerance: {
      ...faultTolerance,
      validatorCount: n,
      maxOfflineValidators,
      effectiveDomains,
      // 保留声明侧的数字，供呈现"声明 6 / P 链 5"这种差额用
      declaredValidatorCount: faultTolerance.validatorCount,
      /**
       * ⌊n/4⌋ 成立的**前提**：等权（research R-05 / V-22 实测各 100）。
       * 权重不等时那条推导不成立 —— 照实传上去，让呈现层能说"前提不成立"，
       * 而不是给一个看着确定的错数。`undefined` 表示这一侧没提供权重信息。
       */
      equalWeights: memberSet.equalWeights,
    },
    scoped: true,
  };
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
export function deriveTier({ rows, faultTolerance, observer, memberSet }) {
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

    // P1b —— 紧随观察者失明之后，且必须**先于**所有数值判据。
    // 两者同类：都是"我们看不见"，不是"链坏了"。读不到 P 链的成员集合时，
    // 下面每一条数值判据的 n 都只能取自声明，而那会算出 V-31 那个假警报。
    if (memberSet && memberSet.source !== 'p-chain') return TIERS.MEMBERS_UNKNOWN;

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
  // **不是共识成员的节点，一律不算故障**（FR-028 / T038）。必须最先判。
  //
  // 声明里有、链上没有的节点有两种来历，而**两种都不是故障**：
  //   正在加入 —— 还没走完注册（ACP-77 四步里的某一步）
  //   已退出   —— 被主动移除，按规程接下来才停进程、才改声明
  //
  // 放到后面判的后果：一个刚被移除、进程已停的节点会落进 `stopped` →
  // NODE_INFRA_STATES → `node-infra`，而那一类的处置是
  // "到那台机器上查节点进程、数据卷与挂载的密钥" —— 那台机器上**没什么可查**，
  // 它是被有意摘掉的。FR-028 要的正是这个区分：两者处置完全不同。
  //
  // 而且这条红灯会一直亮到有人去改 deployment.json —— 一个不会自己消失的
  // 假故障，比没有告警更坏（它会训练人忽略清单）。
  //
  // **只认显式的 `false`。** `null` 意味着"读不到成员集合"或"这一行不计入容错"
  // （Primary），那时不能断言它不是成员 —— 把"不知道"说成"已退出"会
  // 在成员集合读不到时把全部故障都藏起来。
  if (row.registeredOnChain === false) return 'membership';

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
  // 三个成分都不能少，每个对应一次 2026-09-10 的实测：
  //   「两个」—— 只起回一个时 percentConnected 仍是 0.5 < 80%，验证者照样卡死
  //   「不要重启」—— l1-1 重启后 P 链引导 5 分钟毫无进展
  //   顺序 —— 与 docs/devnet.md §9.5 一致（有守卫）
  // 刻意**不写**「不会丢数据」这类否定句：否定式对子串守卫天然敌对
  // （003 期间 starting 的文案写了「也不是"须处置"」，那个词触发了一条子串断言，
  //  当时的处理是改文案而不是改守卫）。这里正面说"恢复后自动继续"。
  'recovery-blocked': '先启动两个 Primary —— 只起一个不够；在那之前不要重启任何验证者。'
    + '两个都回来后，卡住的验证者约半分钟自行追上',
  // **不要写成"查一下那台机器"**。这一类的全部意义就是把它与 node-infra 分开：
  // 那台机器上没什么可查，链上的成员集合才是事实来源。
  // 两种来历（正在加入 / 已退出）从这一行分不出来，所以指向能分出来的工具 ——
  // 它们从链上读进度，会直接说停在第几步。
  membership: '它不是当前的共识成员，**不是故障**。'
    + '跑 npm run membership:status 看它是正在加入还是已退出；'
    + '加入没走完用 add-validator 续，已退出则停掉它的进程并从 deployment.json 里移除',
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
export function buildIncidents({
  rows, tier, observer, chainIdentity, recoveryCapability, membership,
}) {
  const out = [];

  for (const row of rows) {
    const cls = incidentClass(row);
    if (!cls) continue;
    out.push(incident(cls, `${row.id}：${row.detail || row.state}`, row.id));
  }

  // 恢复能力：**链层面**的一条，说的是那些 Primary 的 node-infra 合起来的**后果**。
  // 与每个 Primary 各自那条 node-infra 并存是对的，不是重复 ——
  // 前者说"哪个东西坏了"，后者说"因此现在不能做什么"。
  if (recoveryCapability === 'blocked') {
    const stalled = rows.filter((r) => r.role === 'primary' && servesPChain(r) !== true);
    out.push(incident(
      'recovery-blocked',
      `Primary 在服务的不足 ${PRIMARIES_REQUIRED_FOR_REJOIN} 个（${stalled.map((r) => r.id).join('、') || '—'}）——`
      + '此刻任何 L1 验证者一旦重启都**无法重新加入**：它要先引导 P 链，'
      + '而 P 链引导要求连上足够的 P 链权益，两个 Primary 各握一半。'
      + '链本身仍按上面的档位出块，这两件事互不影响',
    ));
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

  // T-5 越界（FR-029）：**不静默通过**。
  // 按**有效**边界判，不按声明边界 —— 后者会给出一个在现实里为假的绿灯
  //（002 load.mjs 那条注释记的就是这件事）。
  if (membership?.domainOverLimit?.over) {
    const d = membership.domainOverLimit;
    out.push(incident(
      'topology-limit',
      `故障边界 ${d.domains.map((g) => `${g.ids.join('+')}（${g.validators} 个）`).join('、')}`
      + ` 承载的验证者数超过上限 ${d.limit}（${membership.chainCount} 个等权成员 → ⌊n/4⌋）——`
      + '那台机器一旦整体失效，一次就会失去超过可容忍的数量。'
      + '这不是节点故障，是**声明本身**越界了',
    ));
  }

  // 「链上有、声明里没有」（FR-030 的第三种漂移）。
  //
  // 这一侧**没有行可挂** —— 逐行的 membership 分类只看得见声明里的节点，
  // 而这种漂移恰恰是声明里没有的那个。不单独报的话，它在面板上只剩一个数字差
  // （"链上 7 / 声明 6"），没有处置方向。
  if (membership && membership.chainCount > membership.declaredCount) {
    out.push(incident(
      'membership',
      `链上有 ${membership.chainCount} 个成员，声明里只有 ${membership.declaredCount} 个 ——`
      + '**有成员没写进声明**。它照样在共识里带权重、照样算进容错分母，'
      + '但面板列不出它是谁（因为节点清单来自声明）'
      + (membership.unidentified ? `；其中 ${membership.unidentified} 个连 nodeID 都认不出` : ''),
    ));
  }

  // 权重不等 → 上面那些余量数字的前提不成立。
  // 不报的话，面板会给出一个**看着确定的错数** —— 那比不给更坏。
  if (membership && membership.toleranceTrustworthy === false) {
    out.push(incident(
      'tolerance-basis',
      `链上成员的权重不一致（${(membership.weights ?? []).join(' / ') || '取值未知'}）——`
      + ' ⌊n/4⌋ 成立的前提是等权，所以本页面的两个余量与门槛**此刻都不可信**。'
      + '档位与百分比仍按权重计算的共识规则成立，但"还能掉几个"这句话不成立',
    ));
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
/**
 * 成员维度的呈现数据（功能 005 / T049 / T051、FR-025 / FR-029 / FR-030）。
 *
 * ## 为什么需要这一块，而不是让视图自己算
 *
 * `scopeToChainMembers()` 已经把 `declaredValidatorCount` 与 `equalWeights` 算好了，
 * 但 `buildSnapshot` 一直返回**未收敛**的那份 faultTolerance —— 算出来了却没传出去。
 * 于是视图拿不到"声明 6 / 链上 5"这个差额，只能看见一个没有来历的数字。
 *
 * ## FR-025 要的那句话，落地成什么
 *
 * 面板不知道"刚刚发生了一次成员变化"（它只看得见当下的状态）。能说、且必须说的是
 * **当下这个 n 的邻域**：
 *
 *   加一个 → f 变不变     减一个 → f 变不变     要让 f 提高，n 得到几
 *
 * 这三句合起来就回答了"这次变化有没有改变容错"，而且**不给"节点更多了就更抗"
 * 留下解释空间** —— n=5→6→7 时第一句的答案都是"不变"。
 *
 * ⌊n/4⌋ 的前提是等权。权重不等时那条推导不成立，此处照实标记
 * （`toleranceTrustworthy: false`），让呈现层能说"前提不成立"，
 * 而不是给一个看着确定的错数。
 */
export function buildMembership({ faultTolerance, memberSet }) {
  const f = (n) => Math.floor(n / 4);
  const n = faultTolerance.validatorCount;
  const declared = faultTolerance.declaredValidatorCount ?? n;
  const current = faultTolerance.maxOfflineValidators;

  // 要让 f 提高，n 至少得到几 —— 说"加到 7 也还是 1"不如直接说"要到 8"
  let nextIncreaseAt = null;
  for (let m = n + 1; m <= n + 8; m += 1) {
    if (f(m) > current) { nextIncreaseAt = m; break; }
  }

  // T-5：某个**有效**边界的验证者数超过 f。按有效边界算 ——
  // 按声明边界算会得到一个在现实里为假的绿灯（002 load.mjs:259 的那条注释）。
  const domains = faultTolerance.effectiveDomains ?? [];
  const worstDomain = Math.max(0, ...domains.map((g) => g.validators ?? 0));
  const overLimit = domains
    .filter((g) => (g.validators ?? 0) > current)
    .map((g) => ({ ids: g.ids, validators: g.validators }));

  return {
    source: memberSet?.source ?? 'unknown',
    // 三个数分开报。它们相等是常态，不等的那一刻恰恰是最需要看清的
    //（加入走到第三步、第四步没做完时，链上有而合约/声明还没有）。
    declaredCount: declared,
    chainCount: n,
    unidentified: memberSet?.unidentified ?? 0,
    inSync: declared === n,

    maxOffline: current,
    /** 加一个成员之后的上限，以及它**变不变**（FR-025 的正面回答）。 */
    ifAdded: { n: n + 1, maxOffline: f(n + 1), changed: f(n + 1) !== current },
    /** 减一个成员之后的上限。减少**可能砍半**（8→7 是 2→1），必须在动手前说出来。 */
    ifRemoved: n > 0
      ? { n: n - 1, maxOffline: f(n - 1), changed: f(n - 1) !== current }
      : null,
    /** 要让上限提高，n 得到几。null 表示往上八格之内都不会变。 */
    nextIncreaseAt,

    /** ⌊n/4⌋ 的前提是等权；不等时上面这些数都不可信。undefined 表示这一侧没给权重。 */
    toleranceTrustworthy: memberSet?.equalWeights !== false,
    weights: memberSet?.weights ?? null,

    /** T-5（FR-029）：不静默通过 —— 超限的边界逐个报出来。 */
    domainOverLimit: {
      over: overLimit.length > 0,
      limit: current,
      worst: worstDomain,
      domains: overLimit,
    },
  };
}

export function buildSnapshot({
  collectedAt, pollIntervalMs, deployment, networkHeight,
  rows, faultTolerance, observer, chain, baselineGenesisHash,
  containerFacts, summaryLine, memberSet,
}) {
  const enrichedAll = enrichRows({ rows, networkHeight, baselineGenesisHash });
  // **容错判据必须先收敛到链上注册的成员**（T073 / research V-31）。
  // 放在 deriveTier 之前，是因为 tier 的每一条数值判据都要用收敛后的 n。
  const scope = scopeToChainMembers({ rows: enrichedAll, faultTolerance, memberSet });
  const enriched = scope.rows;
  const chainIdentity = buildChainIdentity({ chain, baselineGenesisHash, rows: enriched });
  const tierInfo = deriveTier({
    rows: enriched, faultTolerance: scope.faultTolerance, observer, memberSet,
  });
  // 恢复能力在档位**之后**算，且 deriveTier 不读它 —— 单向依赖，档位不受影响（FR-013）
  const recoveryCapability = deriveRecoveryCapability({ rows: enriched, tier: tierInfo.tier });
  const membership = buildMembership({ faultTolerance: scope.faultTolerance, memberSet });
  const incidents = buildIncidents({
    rows: enriched, tier: tierInfo.tier, observer, chainIdentity, recoveryCapability, membership,
  });

  return {
    collectedAt,
    pollIntervalMs,
    deployment,
    networkHeight,
    ...tierInfo,
    // 与档位**正交**的一个维度（'ok' | 'blocked' | 'unknown'）。
    // 附加字段：既有字段的语义与取值一律不变；**不进**对外精简视图（FR-022）。
    recoveryCapability,
    primariesRequiredForRejoin: PRIMARIES_REQUIRED_FOR_REJOIN,
    // **收敛后的那份**，不是声明的那份。
    // 此前这里返回未收敛的 faultTolerance，而 tier / 两个余量是按收敛后算的 ——
    // 注册进行中（链上 5、声明 6）时，视图里的解释文字会和它上面的数字互相矛盾。
    // 声明侧的数字没有丢：它在 declaredValidatorCount 里，也在 membership 块里。
    faultTolerance: scope.faultTolerance,
    /** 成员维度（005 / FR-025 / FR-029 / FR-030）。 */
    membership,
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
