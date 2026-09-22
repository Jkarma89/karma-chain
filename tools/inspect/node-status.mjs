// tools/inspect/node-status.mjs
//
// 逐节点报告 RecoveryState、高度、peers、所属故障边界（功能 002 / US6、T075–T077）。
// 输出格式见 specs/002-resilient-validator-network/contracts/cli-interface.md。
// 状态机见 specs/002-resilient-validator-network/data-model.md §7。
//
// 它取代 001 的 `docker/devnet/bin/devnet-status`：那个版本假设 7 个节点在同一个容器里，
// 既表达不了"节点分处不同机器"，也区分不了"边界缺席"与"节点故障"。
//
// ## 三条硬性要求（契约）与它们各自的实现
//
// 1. **`catching-up` 与故障可区分，且给出进度**：采样两次高度算速率与预计追平时间。
//    落后但在增长 → 要等；落后且无进展 → 仍报 catching-up 并注明，因为**超时窗口在容器
//    健康检查那边**（它有持久的等待起点，见 docker/node/healthcheck.sh 的 .health-progress），
//    一个瞬时命令不该凭 3 秒的观察宣布"卡死"。容器自报 stalled 时以它为准。
//
// 2. **`unreachable`（边界缺席）与节点故障可区分**：这里用了三个独立信号，而不是只看"我能不能连上"——
//    "连不上"同时可能意味着「节点挂了」「整台机器没了」「我到它的网络路径断了」，三者的处置完全不同。
//      - 直连该节点的 HTTP 端口
//      - **其他可达节点的 peer 列表里有没有它的 NodeID** —— 网络里还在，就说明是本机路径问题
//      - 同边界的其他节点是否也都不应答 —— 都不应答才是整域缺席
//
// 3. **显示在线数与容错上限的关系**：余量为 0 时必须说出来，越限时必须指出后果。
//
// 容器级事实（是否退出、退出码、自报状态）由宿主侧的 scripts/devnet-status 采集后
// 经 .devnet/containers.json 传入 —— 本工具在 verify 容器内跑，那里没有 docker 可用，
// 而宿主只装 Docker（README 的前置依赖）。文件不存在时降级为纯 HTTP 判定，不报错。
//
// 用法：node tools/inspect/node-status.mjs [--json] [--deployment <name>] [--sample-seconds <n>]

import { canQuery } from '../membership/tolerance.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProtocol, deriveTopology, REPO_ROOT } from '../protocol/load.mjs';
import { readConsensusMembers } from '../membership/member-set.mjs';
// 容错收敛到链上成员的判定只有一份，在面板那边（T073）。
// 这里引用它而不是再写一遍 —— 同一个判定有两份实现，迟早会各自漂移。
import { scopeToChainMembers } from '../dashboard/snapshot.mjs';

const CONTAINERS_PATH = resolve(REPO_ROOT, '.devnet', 'containers.json');
const IDENTITY_DIR = resolve(REPO_ROOT, 'blockchain', 'nodes');

/** data-model §7 状态机的全部状态。分类表（categories.mjs）须逐一覆盖（T079 / FR-034）。 */
export const ALL_STATES = new Set([
  'stopped', 'starting', 'bootstrapping', 'catching-up',
  'healthy', 'unreachable', 'identity-mismatch', 'data-corrupt', 'stalled',
]);

/** 不计入"离线"的状态：它们都是"要等"，不是"要处置"。 */
const NOT_OFFLINE = new Set(['healthy', 'catching-up', 'bootstrapping', 'starting']);

/** 解析命令行开关。每次调用时解析，不在模块加载时定格。 */
export function parseArgs(argv = process.argv.slice(2)) {
  const at = (n) => { const i = argv.indexOf(n); return i !== -1 ? argv[i + 1] : undefined; };
  const s = Number(at('--sample-seconds'));
  return {
    asJson: argv.includes('--json'),
    deployment: at('--deployment'),
    sampleSeconds: Number.isFinite(s) && s > 0 ? s : 3,
  };
}

/**
 * 把一个节点的观测归入 RecoveryState。纯函数 —— 状态机分支太多，必须能不靠活链测。
 *
 * @param {{id,role,domain,nodeId}} node 拓扑解析出的节点（nodeId 为制品声明的期望值）
 * @param {object} ctx 观测上下文，见文件头说明
 * @returns {{state,detail,countsAsOffline,countsTowardTolerance}}
 */
/**
 * 这个验证者**还连得上足够的成员吗** —— 以及连不上的话，**该怪谁**。
 *
 * ## 两个条件，缺一不可
 *
 * 002 的 data-model §7 给 `stalled` 定的是：
 *
 * > 未在服务 L1 且超过窗口，**且其余验证者全部在场**。后一个条件是必需的：
 * > 跨机分批启动时先起来的机器无法服务 L1，成因在别的机器未启动
 * >（未达 α/k=75% 查询门槛），**本机无可处置之处**。
 *
 * 所以只算"连上了几个"是不够的 —— 还要问那些没连上的**是不是本来就不在**。
 * 三台机器真的下线时，每个幸存节点都会"连不上 75%"，而它们一个都没错；
 * 把它们逐个判成 stalled 就是一屋子假红灯，而容错那边已经把下线的那几个算过一次了。
 *
 * ## 「不在」怎么判
 *
 * 沿用 004 那条区分：**本机探不到 + 其余节点的对等列表里也没有** 才算真的不在。
 * 只是本机探不到的，是本机到它的路径问题（那种情况下链里还有它）。
 *
 * @returns {{ok: boolean, connected: number, n: number, percent: number,
 *            blamed: string[], absentUnseen: string[]}|null} 材料不全时返回 null
 */
/** 连不上 quorum 时那句话 —— 把数字、该怪谁、不该怪谁三样都说出来。 */
function reachNote(r) {
  const absent = r.absentUnseen.length
    ? `（另有 ${r.absentUnseen.length} 个成员本来就不在，不算它的问题）`
    : '';
  return `**只连上 ${r.connected}/${r.n} 个成员（${r.percent}%）** —— 发起共识查询要 ≥75%，`
    + `最多断 ${r.allowed} 个。它现在投不了票。`
    + `看不见 ${r.blamed.join('、')}，而**它们是活着的**${absent} —— `
    + '先查这个节点到它们的 P2P 连通性。';
}

export function quorumReach({ probe, memberNodeIds, absentMemberIds }) {
  if (!memberNodeIds?.size || !probe?.peerNodeIds) return null;
  const seen = new Set(probe.peerNodeIds);
  const unseen = [...memberNodeIds].filter((id) => id !== probe.nodeId && !seen.has(id));
  const absent = absentMemberIds ?? new Set();
  const q = canQuery({ n: memberNodeIds.size, disconnectedMembers: unseen.length });
  return {
    ...q,
    // 看不见、而它**其实活着** —— 这些才算得到这个节点头上
    blamed: unseen.filter((id) => !absent.has(id)),
    // 看不见、而它本来就不在 —— 这些不算它的错
    absentUnseen: unseen.filter((id) => absent.has(id)),
  };
}

export function classify(node, ctx) {
  const isValidator = node.role === 'l1-validator';
  /**
   * @param offline 显式覆盖"是否计入离线"。默认由状态名推出，但 `unreachable` 必须显式 ——
   *   它有两种含义且离线语义**相反**：本机路径断了（网络里它还在，链有它）vs 整域缺席（链没有它）。
   *   只看状态名会把前者也算成离线，从而虚报余量不足。
   */
  const out = (state, detail, offline) => ({
    state,
    detail: detail ?? '',
    countsAsOffline: isValidator && (offline ?? !NOT_OFFLINE.has(state)),
    // Primary 不参与 L1 出块，不计入容错计算（研究 R-09）
    countsTowardTolerance: isValidator,
  });

  const { probe, container } = ctx;

  // --- 容器级终态优先：进程已经退出，HTTP 判定说明不了原因 ---
  if (container?.status === 'exited' && container.exitCode) {
    const err = container.lastError ?? '';
    if (container.exitCode === 12) {
      return /nodeId|NodeID|BLS|身份/i.test(err)
        ? out('identity-mismatch', `退出码 12：${err || '身份与制品不符'} —— 须修正声明或密钥（FR-017）`)
        : out('data-corrupt', `退出码 12：${err || '数据与声明不一致'} —— 重建该节点即可，不需全链重置（FR-006）`);
    }
    if (container.exitCode === 10) {
      return out('stopped', `退出码 10：前置依赖缺失${err ? `（${err}）` : ''}`);
    }
    return out('stopped', `容器已退出（码 ${container.exitCode}）${err ? `：${err}` : ''}`);
  }

  // 容器健康检查自报 stalled 时以它为准 —— 只有它持有超时窗口
  if (container?.selfState === 'stalled') {
    return out('stalled', container.detail || '容器健康检查判定为卡住，须处置');
  }

  // 容器**不在运行**且是正常退出：这是本机上有人主动停的（devnet-stop / docker stop）。
  // 必须在下面的 unreachable 判定之前 —— 否则整台机器的节点全被停掉时会报
  // "整域缺席，去看那台机器"，而运维刚在这台机器上执行过 stop，那条建议是错的。
  // 容器级事实只有本机知道，但正因如此它比网络推断更权威。
  if (container?.status && container.status !== 'running') {
    return out('stopped', `容器状态 ${container.status} —— 本机上被主动停止，非故障`);
  }

  // --- 可达：按节点自身的 API 判定 ---
  if (probe?.reachable) {
    if (node.nodeId && probe.nodeId && probe.nodeId !== node.nodeId) {
      return out('identity-mismatch',
        `实际 NodeID ${probe.nodeId}，制品声明 ${node.nodeId} —— 挂载的密钥与声明不同源（FR-017）`);
    }
    // Primary 能应答即在岗：它不服务 L1，也没有"追平"可言（研究 R-09）
    if (!isValidator) return out('healthy', 'primary 节点在岗');
    if (probe.bootstrapped === false) return out('bootstrapping', '引导中 —— 要等，不是故障');
    if (probe.height == null) return out('bootstrapping', '尚未开始服务 L1 —— 要等');

    const net = ctx.networkHeight;
    if (net != null && probe.height < net) {
      const behind = net - probe.height;
      const gained = ctx.prevHeight == null ? null : probe.height - ctx.prevHeight;
      const secs = ctx.sampleSeconds || 3;
      if (gained != null && gained > 0) {
        const perMin = Math.round((gained / secs) * 60);
        const eta = perMin > 0 ? Math.max(1, Math.ceil(behind / perMin)) : null;
        return out('catching-up', `落后 ${behind} 块，+${perMin}/min${eta ? `, ~${eta}m` : ''}`);
      }
      // **它还连得上足够的成员吗** —— 这一问原先没人回答。
      //
      // 这一支此前把"是否卡住"全部委托给容器健康检查（只有它持有超时窗口），
      // 而容器级事实**只有本机采得到**：别的机器上的节点，那个判定者根本不存在，
      // 状态于是一直停在 catching-up —— 而按契约 catching-up 算"在服务 L1"（FR-011），
      // 容错余量因此被报成满的。
      //
      // 2026-09-18 实测：l1-2 重新入集后与五个 L1 验证者全断、卡在落后 24 块，
      // 而 devnet-verify 照报 `6/6 validators online, full margin`。
      //
      // 判据不新造：发起查询要求已连接权重 ≥ 75%，等价于**断开数 ≤ ⌊n/4⌋** ——
      // 与 maxOffline 同一个算式（canQuery）。算出来的 1/6 = 16.67% 与那一刻
      // l1-2 自己 /ext/health 报的 16.666667% 分毫不差。
      //
      // 用 peer 列表算而**不去读 /ext/health**：那个端点的综合健康位含 P 链可达性，
      // 两个 Primary 全停时会全假而 L1 仍在出块（dashboard/README 的四条边界之一）。
      // peer 列表只说 L1 这一层，正是 FR-013 要的那个口径。
      const members = ctx.memberNodeIds;
      const reach = quorumReach({
        probe, memberNodeIds: members, absentMemberIds: ctx.absentMemberIds,
      });
      if (reach && !reach.ok && reach.blamed.length) {
        return out('stalled', `落后 ${behind} 块且无进展；${reachNote(reach)}`);
      }
      return out('catching-up',
        `落后 ${behind} 块，${secs}s 采样窗口内无进展`
        + (members?.size
          ? '（与成员的连接数够发起查询 —— 是否卡住由容器健康检查判定，它持有超时窗口）'
          : '（**没有成员集合可比对**，也没有容器级事实 —— 卡没卡这件事此刻没有判定者）'));
    }
    // **追平了不等于投得了票。**（研究 V-49，2026-09-19 实测）
    //
    // 2026-09-18 我把这条判定挂在了"落后且无进展"那一支上。而第二天撞到的是另一种：
    // l1-1 高度**没落后**（和大家都在 1503），它自己却报
    // `not connected to enough stake: 66.666667%` —— 投不了票，而面板照报 100% / 参与 6。
    //
    // "连不上 quorum"与"落后"是两件事：一个跟得上高度的节点同样可能发不起查询。
    // 判定被我挂在了一个太窄的前提上。
    const reachHealthy = quorumReach({
      probe, memberNodeIds: ctx.memberNodeIds, absentMemberIds: ctx.absentMemberIds,
    });
    if (reachHealthy && !reachHealthy.ok && reachHealthy.blamed.length) {
      return out('stalled', `高度已追平（${probe.height}），但${reachNote(reachHealthy)}`);
    }
    return out('healthy', net != null ? `已追平（高度 ${probe.height}）` : `高度 ${probe.height}`);
  }

  // --- 不可达：区分三种成因 ---
  if (node.nodeId && ctx.seenByPeers?.has(node.nodeId)) {
    // 链里有它 → 不算离线。把这种情况算成离线会虚报余量不足，
    // 让运维以为链快停了，而实际上要修的是本机的网络路径。
    return out('unreachable',
      '本机连不上它，但网络中其他节点与它有连接 —— 是本机到它的网络路径问题，不是节点故障', false);
  }
  if (ctx.domainAllUnreachable) {
    return out('unreachable', `边界 ${node.domain} 的全部节点都不应答 —— 整域缺席，去看那台机器`, true);
  }
  return out('stopped', `同边界的其他节点在应答，只有本节点不应答 —— 节点级故障`);
}

/**
 * 在线数与容错上限的关系。契约第 3 条。
 *
 * ## 两处措辞是实测逼出来的
 *
 * **① n 必须是链上注册数。** 2026-09-15：声明 6（l1-6 已写进 descriptor 但还没注册完）
 * / 链上 5 / 在线 4 → 按声明算出「超出上限，链已停止出块」，而同一次
 * `devnet-verify` 里三行之后就是 `block-production 977 -> 978 -> 979`。
 * 一条自相矛盾的报告比没有报告更坏 —— 它训练人忽略这个工具。
 * 收敛由 `scopeToChainMembers` 做（只有一份），本函数只接受它的结果。
 *
 * **② 不断言没测过的事。** "链已停止出块"是**推断**，不是观测。
 * 而本函数手上恰好有观测：两次采样之间高度有没有涨。
 *   涨了 → 判据与现实矛盾，要报的是**矛盾本身**（成员集合或谓词错了），不是停摆
 *   没涨 → 说不出停没停：本网按需出块，闲着时高度本来就不涨
 *
 * @param {object} observed `{ blocksAdvanced: boolean|null }` —— 采样窗口内高度涨没涨
 */
export function summarize(rows, faultTolerance, observed = {}) {
  const counted = rows.filter((r) => r.countsTowardTolerance);
  const offline = counted.filter((r) => r.countsAsOffline);
  const total = faultTolerance.validatorCount;
  const max = faultTolerance.maxOfflineValidators;
  // 分子分母都以**注册的**验证者总数为基准（契约示例即"4/5"）：
  // 拿观测到的行数当分母，会在少了一行时把缺失悄悄算成在线。
  const online = total - offline.length;
  const withinTolerance = offline.length <= max;
  const margin = Math.max(0, max - offline.length);
  const declared = faultTolerance.declaredValidatorCount;

  let line = `${online}/${total} 验证者在线（上限：可容忍 ${max} 个离线）`;
  // 声明多于 P 链成员是正常的中间态（有成员正在加入），但必须说出来 ——
  // 否则"6 个机器却按 5 算"看着像少算了一个。
  if (Number.isFinite(declared) && declared !== total) {
    line += ` [按 P 链上带权重的 ${total} 个算；声明 ${declared} 个，差额是尚未注册完的成员]`;
  }
  // **等权是 ⌊n/4⌋ 的前提**（research R-05 / V-22）。不等时那条推导不成立，
  // 而上面那个"可容忍 N 个离线"就是按它算出来的 —— 必须当场说破，
  // 否则给出的是一个看着确定的错数。`undefined` 表示这一侧没提供权重信息，不妄断。
  if (faultTolerance.equalWeights === false) {
    line += ' ⚠ **上限不可信**：P 链上各成员权重**不相等**，'
      + `而 ⌊n/4⌋ 的推导以等权为前提 —— 这个 ${max} 是按不成立的前提算出来的`;
  }
  // 观测行数与基准不符本身就是异常，必须说出来而不是让算式吸收掉
  if (counted.length !== total) {
    line += ` [注意：只观测到 ${counted.length} 个计入容错的验证者，基准为 ${total} 个]`;
  }
  if (!withinTolerance) {
    const who = offline.map((r) => r.id).join('、');
    line += observed.blocksAdvanced === true
      ? ` —— **判据与观测矛盾**：按参数算已超出上限（${who} 离线），`
        + '但采样窗口内高度**还在上涨**。要查的是判据，不是链：'
        + '成员集合是不是算错了（声明 vs 链上注册），或者离线谓词把在跑的节点判成了离线。'
      : ` —— **超出上限**：${who} 离线，按共识参数**推断**已停止出块`
        + '（安全停摆：不分叉、区块零回滚，恢复后自动继续）。'
        + '本次未观测到出块，而本网按需出块 —— 闲着时高度不涨，所以这不是停摆的证据。';
  } else if (margin === 0) {
    line += ' —— 链继续出块，但**余量为 0**：再有一个验证者离线即停摆';
  } else {
    line += ` —— 链继续出块，余量 ${margin}`;
  }
  return {
    online,
    offline: offline.length,
    offlineIds: offline.map((r) => r.id),
    withinTolerance,
    margin,
    line,
    // 判据与观测矛盾时，调用方不该把它当成"链挂了"来报
    contradiction: !withinTolerance && observed.blocksAdvanced === true,
  };
}

/** 渲染人读表格。 */
export function formatReport(rows, meta) {
  // 观测也要传给它 —— 否则人读的这份报告会在"越限但高度在涨"时
  // 仍旧说"已停止出块"，而 JSON 那份说的是矛盾。同一次运行两种说法，更坏。
  const s = summarize(rows, meta.faultTolerance, { blocksAdvanced: meta.blocksAdvanced ?? null });
  const dash = '—';
  const w = (v, n) => String(v).padEnd(n);
  const r = (v, n) => String(v).padStart(n);

  const L = [];
  L.push(`\nKarmaChain nodes   deployment: ${meta.deployment}   height ${meta.height ?? dash}\n`);
  L.push(`  ${w('node', 12)}${w('domain', 11)}${w('role', 15)}${w('state', 19)}${r('height', 7)}${r('peers', 7)}`);
  for (const n of rows) {
    const extra = n.detail ? `   (${n.detail})` : '';
    L.push(`  ${w(n.id, 12)}${w(n.domain, 11)}${w(n.role, 15)}${w(n.state, 19)}`
      + `${r(n.height ?? dash, 7)}${r(n.peers ?? dash, 7)}${extra}`);
  }
  L.push('');
  L.push(`  ${s.line}`);
  L.push('');
  return L.join('\n');
}

// --- 观测（有副作用的部分，与上面的纯函数分开）---

const post = async (url, method, params = {}) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(j.error.message ?? 'rpc error');
  return j.result;
};

/** 探测一个节点。不可达时返回 { reachable: false }，不抛。 */
export async function probeNode(node, blockchainId) {
  // 字段名用 address：deriveTopology 的输出用的是 address，readInventory 才叫 host。
  // 早先写成 node.host 时主机名成了 undefined，全部节点被误判为 unreachable。
  const base = `http://${node.address}:${node.httpPort}`;
  try {
    const nodeId = (await post(`${base}/ext/info`, 'info.getNodeID')).nodeID;
    const probe = {
      reachable: true, nodeId, bootstrapped: null, height: null, peers: null, peerNodeIds: [],
      // 功能 003 / 研究 R-07 追加：该节点**自报的**创世区块哈希，供跨机分叉检测使用。
      // 与其余事实取自**同一次**探测 —— 分两轮取会让"节点状态"与"它的创世哈希"
      // 来自两个时刻的两次连接，链路抖动时可能一成一败，产生自相矛盾的展示。
      // classify() 不读这个字段，因此 devnet-status 的判定不受影响（tests/unit/node-status-genesis）。
      genesisHash: null,
    };
    try {
      const peers = await post(`${base}/ext/info`, 'info.peers');
      probe.peers = Number(peers.numPeers);
      probe.peerNodeIds = (peers.peers ?? []).map((x) => x.nodeID).filter(Boolean);
    } catch { /* peers 拿不到不影响其余判定 */ }
    if (node.role === 'l1-validator' && blockchainId) {
      try {
        probe.bootstrapped = (await post(`${base}/ext/info`, 'info.isBootstrapped', { chain: blockchainId })).isBootstrapped;
      } catch { probe.bootstrapped = null; }
      if (probe.bootstrapped) {
        try {
          const hex = await post(`${base}/ext/bc/${blockchainId}/rpc`, 'eth_blockNumber', []);
          probe.height = Number(hex);
        } catch { /* 已引导但还没开始服务 */ }
        try {
          const genesis = await post(`${base}/ext/bc/${blockchainId}/rpc`, 'eth_getBlockByNumber', ['0x0', false]);
          probe.genesisHash = genesis?.hash ?? null;
        } catch { /* 取不到就留 null —— null（未知）与"不匹配"是两件事，不得混淆 */ }
      }
    }
    return probe;
  } catch {
    return { reachable: false };
  }
}

/** 容器事实的有效期。采集与判定之间只隔一次 docker run，2 分钟是很宽的余量。 */
const CONTAINER_FACTS_TTL_MS = 120_000;

/**
 * 宿主采集的容器事实。文件缺失、旧格式（无时间戳）、或**已过期**都降级为纯网络判定 ——
 * 少一路证据，不报错。
 *
 * 为什么必须判过期（2026-09-09 实测踩到）：这个文件由 `scripts/devnet-status` 在每次运行
 * 前重写，但**直接调用本工具时不会**。一份两天前留下的旧文件把 7 个节点全标成 running，
 * 于是刚被 `devnet-stop` 停掉的本机节点没有走下面"容器不在运行"那个分支，而落进网络推断，
 * 报出 `unreachable`「整域缺席，去看那台机器」—— 正是 classify 里那段注释说要避免的误报。
 *
 * **过期的事实比没有事实更坏**：它看起来像证据，而且恰好把判定推向错误的分支。
 */
// 功能 003 / 研究 R-07 改动二：由模块私有改为 `export`，并加一个只为测试留的可选入参
// （`rawText`，默认仍读 CONTAINERS_PATH）。**下面的 TTL 与旧格式判定一行未改。**
//
// 为什么要导出：面板必须能读容器事实，否则在跨机形态下停掉本机唯一的验证者时，
// classify() 会落进 `domainAllUnreachable` 分支报「整域缺席，去看那台机器」——
// 而人正站在那台机器上、刚亲手停的。走到正确分支的前提就是有容器事实。
//
// 为什么要接缝：这段判定恰好是 2026-09-09 咬过我们的逻辑，而它原先无法离线测试
// （要么去写真实的 .devnet/containers.json 从而踩踏运行中的开发网，要么不测）。
// 仓库对此已有先例 —— _devnet-common.ps1 的 KARMACHAIN_ENV_FILE 注明"只为测试留的接缝"。
export function readContainers(rawText) {
  try {
    const raw = JSON.parse(rawText ?? readFileSync(CONTAINERS_PATH, 'utf8'));
    const at = Number(raw?.collectedAt);
    if (!Number.isFinite(at)) return {};                                  // 旧格式：不可信
    if (Date.now() - at * 1000 > CONTAINER_FACTS_TTL_MS) return {};       // 过期：不可信
    return raw.nodes ?? {};
  } catch { return {}; }
}

// 导出：e2e 的 spreadProblems 要用它给**不可达**的节点补上 NodeID ——
// 探不到自报值时回落到生成物里声明的那个，才能向对等求证（面板同一做法）。
export const expectedNodeId = (id) => {
  try { return JSON.parse(readFileSync(resolve(IDENTITY_DIR, `${id}.identity.json`), 'utf8')).nodeId; } catch { return null; }
};

export async function collect(opts = parseArgs()) {
  const p = loadProtocol();
  const name = opts.deployment ?? p.topology.activeDeployment;
  const d = deriveTopology({ ...p, topology: { ...p.topology, activeDeployment: name } });
  let blockchainId = null;
  try {
    blockchainId = JSON.parse(readFileSync(resolve(REPO_ROOT, 'blockchain/chain-identity/karmachain.identity.json'), 'utf8')).blockchainId;
  } catch { /* 尚未建链 */ }

  const nodes = d.topologyNodes.map((n) => ({ ...n, nodeId: expectedNodeId(n.id) }));
  const containers = readContainers();

  // 两次采样：算追赶速率需要两个时间点
  const first = await Promise.all(nodes.map((n) => probeNode(n, blockchainId)));
  await new Promise((r) => setTimeout(r, opts.sampleSeconds * 1000));
  const second = await Promise.all(nodes.map((n) => probeNode(n, blockchainId)));

  // 网络高度取全部可达节点的最大值；peer 并集用于区分"我连不上"与"它真没了"
  const heights = second.map((x) => x.height).filter((h) => Number.isFinite(h));
  const networkHeight = heights.length ? Math.max(...heights) : null;
  const seenByPeers = new Set(second.flatMap((x) => x.peerNodeIds ?? []));
  // L1 成员的 NodeID（观测优先、声明兜底，与下面 rows 里同一条理由）——
  // classify 用它算"这个节点连上了几个成员"。
  const memberNodeIds = new Set(nodes
    .map((n, i) => (n.role === 'l1-validator' ? (second[i].nodeId ?? n.nodeId) : null))
    .filter(Boolean));
  // **谁是真的不在** —— 沿用 004 那条区分（data-model §7）：
  // 本机探不到**且**其余节点的对等列表里也没有，才算它真的缺席；
  // 只是本机探不到的，是本机到它的路径问题，链里还有它。
  //
  // quorumReach 用它来回答"连不上 quorum 该怪谁"：把本来就不在的那些排除掉，
  // 否则三台机器真的下线时，每个幸存节点都会被判成 stalled —— 一屋子假红灯，
  // 而容错那边已经把下线的那几个算过一次了。
  const absentMemberIds = new Set([...memberNodeIds].filter((id) => {
    const i = nodes.findIndex((n, k) => (second[k].nodeId ?? n.nodeId) === id);
    if (i < 0) return true;                       // 拓扑里都找不到 → 当作不在
    return !second[i].reachable && !seenByPeers.has(id);
  }));

  const unreachableByDomain = new Map();
  for (const [i, n] of nodes.entries()) {
    const cur = unreachableByDomain.get(n.domain) ?? { total: 0, down: 0 };
    cur.total += 1;
    if (!second[i].reachable) cur.down += 1;
    unreachableByDomain.set(n.domain, cur);
  }

  const rows = nodes.map((n, i) => {
    const dom = unreachableByDomain.get(n.domain);
    const c = classify(n, {
      probe: second[i],
      prevHeight: first[i].height ?? null,
      networkHeight,
      seenByPeers,
      memberNodeIds,
      absentMemberIds,
      domainAllUnreachable: dom.down === dom.total,
      container: containers[n.id] ?? null,
      sampleSeconds: opts.sampleSeconds,
    });
    return {
      id: n.id, role: n.role, domain: n.domain, address: n.address,
      // 观测优先、声明兜底 —— 与 poll.mjs 同一条理由：容错问的是
      // "现在跑着的这个节点算不算共识成员"，所以身份不符的节点不该被算进去。
      // 离线节点观测不到 NodeID，但声明值仍在制品里，所以它照样能被认出来。
      nodeId: second[i].nodeId ?? n.nodeId ?? null,
      height: second[i].height ?? null, peers: second[i].peers ?? null,
      ...c,
    };
  });

  // 容错的 n 收敛到 **P 链上带权重的成员**（T073 + T070 修正）。读不到就不收敛，
  // 并在 summarize 里如实说基准是哪一个 —— 退回声明是 V-31 那个假警报的成因，
  // 退回合约是 T070 查实的那个偏乐观口径（共识按 P 链算，`67*600` 是直接证据）。
  //
  // 必须直连某个 Primary：P 链只有它们完整同步，L1 的入口代理后面是 L1 验证者，
  // 它们不提供 P 链视图。
  const primaryNode = d.topologyNodes.find((n) => n.role === 'primary');
  const memberSet = await readConsensusMembers({
    pchainUrl: primaryNode ? `http://${primaryNode.address}:${primaryNode.httpPort}` : null,
    subnetId: (() => {
      try {
        return JSON.parse(readFileSync(
          resolve(REPO_ROOT, 'blockchain/chain-identity/karmachain.identity.json'), 'utf8',
        )).subnetId ?? null;
      } catch { return null; }   // 尚未建链 —— 让它走 source: unknown，不猜
    })(),
  });
  const scoped = scopeToChainMembers({ rows, faultTolerance: d.faultTolerance, memberSet });

  // 采样窗口内高度涨没涨 —— summarize 用它避免断言"链已停止出块"。
  // 只看**可达节点的最大高度**：单个节点落后是它自己的事，链在不在出块看全网。
  const firstHeights = first.map((x) => x.height).filter((h) => Number.isFinite(h));
  const prevNetworkHeight = firstHeights.length ? Math.max(...firstHeights) : null;
  const blocksAdvanced = (networkHeight === null || prevNetworkHeight === null)
    ? null
    : networkHeight > prevNetworkHeight;

  return {
    deployment: name,
    height: networkHeight,
    memberSet: { source: memberSet.source, scoped: scoped.scoped, error: memberSet.error ?? null },
    blocksAdvanced,
    faultTolerance: scoped.faultTolerance,
    nodes: scoped.rows,
    summary: summarize(scoped.rows, scoped.faultTolerance, { blocksAdvanced }),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const opts = parseArgs();
  const result = await collect(opts);
  if (opts.asJson) console.log(JSON.stringify(result, null, 2));
  else process.stdout.write(formatReport(result.nodes, result));
  // 退出码沿用 001 的 devnet-status 语义：0 全部健康 | 1 存在须处置的节点
  process.exit(result.nodes.some((n) => n.countsAsOffline) ? 1 : 0);
}
