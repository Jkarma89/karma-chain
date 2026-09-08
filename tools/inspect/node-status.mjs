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

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProtocol, deriveTopology, REPO_ROOT } from '../protocol/load.mjs';

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
      return out('catching-up',
        `落后 ${behind} 块，${secs}s 采样窗口内无进展（是否卡住由容器健康检查判定，它持有超时窗口）`);
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

/** 在线数与容错上限的关系。契约第 3 条。 */
export function summarize(rows, faultTolerance) {
  const counted = rows.filter((r) => r.countsTowardTolerance);
  const offline = counted.filter((r) => r.countsAsOffline);
  const total = faultTolerance.validatorCount;
  const max = faultTolerance.maxOfflineValidators;
  // 分子分母都以**声明的**验证者总数为基准（契约示例即"4/5"）：
  // 拿观测到的行数当分母，会在少了一行时把缺失悄悄算成在线。
  const online = total - offline.length;
  const withinTolerance = offline.length <= max;
  const margin = Math.max(0, max - offline.length);

  let line = `${online}/${total} 验证者在线（上限：可容忍 ${max} 个离线）`;
  // 观测行数与声明不符本身就是异常，必须说出来而不是让算式吸收掉
  if (counted.length !== total) {
    line += ` [注意：只观测到 ${counted.length} 个验证者节点，声明为 ${total} 个]`;
  }
  if (!withinTolerance) {
    line += ` —— **超出上限**：${offline.map((r) => r.id).join('、')} 离线，链已停止出块`
      + '（安全停摆：不分叉、区块零回滚，恢复后自动继续）';
  } else if (margin === 0) {
    line += ` —— 链继续出块，但**余量为 0**：再有一个验证者离线即停摆`;
  } else {
    line += ` —— 链继续出块，余量 ${margin}`;
  }
  return { online, offline: offline.length, offlineIds: offline.map((r) => r.id), withinTolerance, margin, line };
}

/** 渲染人读表格。 */
export function formatReport(rows, meta) {
  const s = summarize(rows, meta.faultTolerance);
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
    const probe = { reachable: true, nodeId, bootstrapped: null, height: null, peers: null, peerNodeIds: [] };
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
function readContainers() {
  try {
    const raw = JSON.parse(readFileSync(CONTAINERS_PATH, 'utf8'));
    const at = Number(raw?.collectedAt);
    if (!Number.isFinite(at)) return {};                                  // 旧格式：不可信
    if (Date.now() - at * 1000 > CONTAINER_FACTS_TTL_MS) return {};       // 过期：不可信
    return raw.nodes ?? {};
  } catch { return {}; }
}

const expectedNodeId = (id) => {
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
      domainAllUnreachable: dom.down === dom.total,
      container: containers[n.id] ?? null,
      sampleSeconds: opts.sampleSeconds,
    });
    return {
      id: n.id, role: n.role, domain: n.domain, address: n.address,
      height: second[i].height ?? null, peers: second[i].peers ?? null,
      ...c,
    };
  });

  return {
    deployment: name,
    height: networkHeight,
    faultTolerance: d.faultTolerance,
    nodes: rows,
    summary: summarize(rows, d.faultTolerance),
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
