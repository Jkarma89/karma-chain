// tools/dashboard/poll.mjs —— 观测层（功能 003 / T016–T019）。
//
// 这里是**有副作用**的一半：读文件、发请求。判定全部交给纯函数 snapshot.mjs。
//
// 判据一律复用 002 的既有实现（FR-004）：
//   - probeNode()  取节点自报的事实（从不请求 /ext/health —— 见 ../README.md）
//   - classify()   把观测归入 RecoveryState
//   - summarize()  在线数与容错上限的关系（原样保留供对照）
//   - readContainers() 容器事实，带 120 秒 TTL
//   - deriveTopology() / faultTolerance() 从 protocol.json 派生拓扑与容错上限
//
// **不复用 collect()**：它在两次采样之间睡 3 秒（为算追赶速率），那是一次性命令才需要的。
// 面板天然有上一轮数据，直接把上一轮高度当 prevHeight、真实间隔当 sampleSeconds ——
// 这正是 classify 那两个参数的设计用途。devnet-status 仍然要 collect() 的一次性语义。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadProtocol, deriveTopology, REPO_ROOT } from '../protocol/load.mjs';
import {
  probeNode, classify, summarize, readContainers,
} from '../inspect/node-status.mjs';

const IDENTITY_DIR = resolve(REPO_ROOT, 'blockchain', 'nodes');

const readJson = (rel) => JSON.parse(readFileSync(resolve(REPO_ROOT, rel), 'utf8'));

/** 制品里声明的 NodeID —— 与节点自报的对比即身份校验（既有 collect() 同一做法）。 */
const declaredNodeId = (id) => {
  try { return readJson(`blockchain/nodes/${id}.identity.json`).nodeId; } catch { return null; }
};

/**
 * 一次性读齐不随轮次变化的事实：拓扑、容错上限、链身份、基准创世哈希。
 *
 * 全部从 `blockchain/protocol.json` 派生（宪法第十六条）。地址取自
 * `topology.deployments.<形态>.failureDomains[].address`，并自动继承既有的
 * `KARMACHAIN_ADDRESS_OVERRIDE` 支持 —— 机器 IP 是安装特有数据，换网段不该改代码。
 */
export function loadContext({ deployment } = {}) {
  const protocol = loadProtocol();
  const name = deployment ?? protocol.topology.activeDeployment;
  const derived = deriveTopology({
    ...protocol,
    topology: { ...protocol.topology, activeDeployment: name },
  });

  let blockchainId = null;
  let chainAlias = null;
  let subnetId = null;
  try {
    const identity = readJson('blockchain/chain-identity/karmachain.identity.json');
    blockchainId = identity.blockchainId ?? null;
    chainAlias = identity.blockchainName ?? protocol.chain?.blockchainName ?? null;
    subnetId = identity.subnetId ?? null;
  } catch { /* 尚未建链 —— 面板照样起，只是没有 L1 判据 */ }

  let baselineGenesisHash = null;
  try {
    baselineGenesisHash = readFileSync(
      resolve(REPO_ROOT, 'blockchain/genesis/karmachain.genesis.hash'), 'utf8',
    ).trim();
  } catch { /* 缺基准 → genesisMatchesBaseline 全为 null，不虚报分叉 */ }

  const domains = new Map();
  for (const node of derived.topologyNodes) {
    if (!domains.has(node.domain)) domains.set(node.domain, node.address);
  }

  return {
    deployment: name,
    nodes: derived.topologyNodes.map((n) => ({ ...n, nodeId: declaredNodeId(n.id) })),
    faultTolerance: derived.faultTolerance,
    domains: [...domains].map(([id, address]) => ({ id, address })),
    // 对外公布的 RPC 端口 —— pathAlive 用它探"到那台机器的路径是否通"
    publishedRpcPort: protocol.endpoints.hostRpcPort,
    // L1 的 RPC 入口。经**入口代理**享受 004 那套故障转移。
    rpcUrl: process.env.KARMACHAIN_RPC_URL
      ?? `http://127.0.0.1:${protocol.endpoints.hostRpcPort}${protocol.endpoints.rpcPath}`,
    // 读**共识成员集合**用（T073 + T070 修正）：容错的 n 取自 **P 链**的
    // L1 验证者集合，而 P 链只有 Primary 完整同步 —— 所以必须直连某个 Primary，
    // 不能走 L1 的入口代理（那个代理后面是 L1 验证者，它们不提供 P 链视图）。
    //
    // 取第一个 Primary。它不应答时 readConsensusMembers 会返回 source: unknown，
    // 面板据此判成「成员集合未知」—— 那是对的：读不到就说读不到，不拿另一侧凑。
    pchainUrl: (() => {
      const p = derived.topologyNodes.find((n) => n.role === 'primary');
      return p ? `http://${p.address}:${p.httpPort}` : null;
    })(),
    subnetId,
    blockchainId,
    chain: {
      chainId: protocol.chain.chainId,
      networkId: protocol.avalanche.networkId,
      chainAlias,
      blockchainId,
      rpcPath: protocol.endpoints.rpcPath,
      publishedHosts: protocol.endpoints.publishedHosts,
    },
    baselineGenesisHash,
  };
}

/**
 * 读一次**共识成员集合**（P 链侧），给容错判据用（功能 005 / T073 + T070 修正）。
 *
 * **缓存 30 秒。** 成员变化是稀有事件（一次人工操作），而面板每几秒轮询一次。
 * 30 秒足够让一次注册在下一两轮里显形。
 *
 * **读的是 P 链，不是合约。** 共识权重来自 P 链的 L1 验证者集合 ——
 * 2026-09-16 实测：第三步做完、第四步没做完时合约说 5 个、P 链说 6 个，
 * 而 L1 的 Warp 校验按 **600**（6 个各 100）算权重。按合约算会少一个成员，
 * 方向偏乐观：把"再掉一个就停摆"报成"还有余量"。
 *
 * **读不到时返回 `source: 'unknown'`，绝不退回声明或合约。** 退回声明正是
 * research V-31 那个假警报的成因：声明 6 / 链上 5 / 在线 4 →
 * 按声明算出「链已停止出块」，而链在正常出块（探测交易区块 975 确认）。
 */
const MEMBER_SET_TTL_MS = 30_000;
let memberSetCache = { at: 0, value: null };

export async function readMemberSetCached({ pchainUrl, subnetId, now = Date.now() } = {}) {
  if (memberSetCache.value && now - memberSetCache.at < MEMBER_SET_TTL_MS) return memberSetCache.value;
  // 取回与判形状的活都在 member-set.mjs 的 readConsensusMembers 里 ——
  // `node-status` 也要它，而"成员集合长什么样"不该有两份定义。
  // 本函数只加缓存这一层。
  const { readConsensusMembers } = await import('../membership/member-set.mjs');
  const value = await readConsensusMembers({ pchainUrl, subnetId, now });
  // 失败**不进缓存** —— 否则一次网络抖动会让面板在 30 秒里都说"成员集合未知"
  if (value.source === 'p-chain') memberSetCache = { at: now, value };
  return value;
}

/**
 * **Primary 网络**的权益分布，带同一套缓存策略（功能 005 / T046、FR-023）。
 *
 * 与上面那个是**两次不同的读取**，别合并：上面带 `subnetID` 问的是本条 L1 的成员，
 * 这里不带 `subnetID`，问的是 Primary 网络自己的验证者与各自质押。
 * 前者决定容错的 n，后者决定"被重启的验证者还能不能回来" —— 两个判据，两个来源。
 *
 * 失败同样不进缓存，理由同上。
 */
let primaryStakeCache = { at: 0, value: null };

export async function readPrimaryStakeCached({ pchainUrl, now = Date.now() } = {}) {
  if (primaryStakeCache.value && now - primaryStakeCache.at < MEMBER_SET_TTL_MS) {
    return primaryStakeCache.value;
  }
  const { readPrimaryNetworkStake } = await import('../membership/member-set.mjs');
  const value = await readPrimaryNetworkStake({ pchainUrl, now });
  if (value.source === 'p-chain') primaryStakeCache = { at: now, value };
  return value;
}

/**
 * 一轮探测 + 分类。**无采样休眠。**
 *
 * `prev` 是上一轮的 `{ [nodeId]: height }`；首轮传 `{}`（classify 会据此把
 * `catching-up` 的进度显示为"窗口内无进展"，而不是编一个速率出来）。
 */
export async function pollOnce({ nodes, blockchainId, prev = {}, intervalSeconds }) {
  const probes = await Promise.all(nodes.map((n) => probeNode(n, blockchainId)));

  // 网络高度取全部可达节点的最大值；peer 并集用于区分"我连不上"与"它真没了"
  const heights = probes.map((p) => p.height).filter((h) => Number.isFinite(h));
  const networkHeight = heights.length ? Math.max(...heights) : null;
  const seenByPeers = new Set(probes.flatMap((p) => p.peerNodeIds ?? []));

  const byDomain = new Map();
  for (const [i, n] of nodes.entries()) {
    const cur = byDomain.get(n.domain) ?? { total: 0, down: 0 };
    cur.total += 1;
    if (!probes[i].reachable) cur.down += 1;
    byDomain.set(n.domain, cur);
  }

  const containers = readContainers();
  const rows = nodes.map((n, i) => {
    const dom = byDomain.get(n.domain);
    const verdict = classify(n, {
      probe: probes[i],
      prevHeight: prev[n.id] ?? null,
      networkHeight,
      seenByPeers,
      domainAllUnreachable: dom.down === dom.total,
      container: containers[n.id] ?? null,
      sampleSeconds: intervalSeconds,
    });
    return {
      id: n.id,
      role: n.role,
      domain: n.domain,
      address: n.address,
      nodeId: probes[i].nodeId ?? n.nodeId ?? null,
      reachable: probes[i].reachable === true,
      height: probes[i].height ?? null,
      peers: probes[i].peers ?? null,
      genesisHash: probes[i].genesisHash ?? null,
      ...verdict,
    };
  });

  return {
    rows,
    networkHeight,
    heights: Object.fromEntries(rows.map((r) => [r.id, r.height])),
    reachableNodes: probes.filter((p) => p.reachable).length,
    containerFactsAvailable: Object.keys(containers).length > 0,
    // 原样保留既有 summarize 的那句话，供人对照面板的档位是否与它一致
    summaryLine: summarize(rows, { validatorCount: 0, maxOfflineValidators: 0 }).line,
  };
}

/**
 * 到某台机器的**网络路径**是否通 —— 与"那台机器上的节点是否健康"是两件事。
 *
 * 判据刻意宽松：**任何 HTTP 应答都算通**，包括 502 / 504。
 * nginx 代理与 avalanchego 是不同的进程、不同的端口 —— 节点全停而机器活着时代理会回
 * 502，而一个 502 就足以证明"路径通、机器活着"。
 *
 * **刻意不探 `/ext/health`**：那是被禁的判据（FR-013，见 ../README.md），
 * 而且这里根本不需要健康信息，只需要"有没有人应答"。探根路径即可。
 */
async function pathAliveFor(address, port) {
  try {
    const res = await fetch(`http://${address}:${port}/`, {
      method: 'GET',
      signal: AbortSignal.timeout(2000),
    });
    return { alive: true, status: res.status };
  } catch {
    return { alive: false, status: null };
  }
}

/**
 * 观察者视角 —— **一个独立于链的实体**。
 *
 * 「面板连不上」与「节点坏了」是两件事；把它们混为一谈是 002 实测过的假报警来源
 * （ubuntu-1 的线缆丢包 21–27%）。`blind` 为真时，面板在原理上无法区分
 * "全网真停机"与"本机失去观测能力" —— `pathAlive` 提供一个独立通道，
 * 让措辞能说到可指路的程度。
 *
 * **它只改措辞，永不改档位**（契约第 3 节的 P1 不受它影响）。
 */
export async function observerViewpoint({ reachableNodes, totalNodes, domains, publishedRpcPort }) {
  const blind = reachableNodes === 0;
  // 只在失明时才多发这几个请求 —— 平时它们没有任何信息量，白花时间
  const pathAlive = blind
    ? await Promise.all(domains.map(async (d) => ({
      domain: d.id,
      ...(await pathAliveFor(d.address, publishedRpcPort)),
    })))
    : [];
  return { reachableNodes, totalNodes, blind, pathAlive };
}
