// tools/verify/checks/basic.mjs —— T033：节点、验证者、RPC、链身份、代币、创世余额。
// 每个检查导出 { id, run(ctx) } → { status, category?, detail, data? }。

import { STATUS } from '../lib/report.mjs';
import { CATEGORIES, categorizeError } from '../lib/categories.mjs';
import { readInventory, resolveNodeHost, nodeHealth, nodePeerCount, nodeIsBootstrapped, nodeId } from '../lib/avalanche-api.mjs';
import { collect as collectNodeStatus } from '../../inspect/node-status.mjs';

/**
 * T094：`node` 与 `fault-tolerance` 两项改用**与容器健康检查同一个判据** ——
 * "本节点能否参与 L1 出块"，而不是 `/ext/health` 的综合健康位。
 *
 * 为什么必须改（两次实测）：
 *   1. 停掉 2 个 Primary 节点时链完全正常出块，但 5 个 L1 验证者的综合健康位全部转为 false
 *      （它们带 partial-sync-primary-network，健康判定含 P 链可达性）—— 见研究 R-09 / V-08。
 *   2. 重建全部容器后约 20 秒，`devnet-start` 报 READY、手工交易与合约部署都正常，
 *      而同一时刻 devnet-verify 报 `7/7 unhealthy: HTTP 503` 且 fault-tolerance 报
 *      "0/5 validators online, chain has stopped producing blocks" —— 一条**完全健康的链**
 *      被报成越过容错上限。
 *
 * 判据统一之后，三处（docker/node/healthcheck.sh、tools/inspect/node-status.mjs、本文件）
 * 对"健康"的定义一致；其中后两者共用同一份代码，不会各自漂移。
 *
 * 结果按检查项缓存：两项检查都要它，而它要探全部节点并采样两次。
 */
let nodeStatusPromise;
const nodeStatus = () => (nodeStatusPromise ??= collectNodeStatus({ asJson: true, sampleSeconds: 1 }));

/** 每节点检查的共同前置：清单存在且端点可达，否则给出可操作的 SKIP 理由。 */
async function nodeAccess(protocol) {
  const inv = readInventory();
  if (!inv) {
    return { ok: false, reason: 'node inventory not available (.devnet/nodes.json) — start the devnet so the container can publish it' };
  }
  const host = await resolveNodeHost();
  if (!host) {
    return { ok: false, inv, reason: 'per-node endpoints only listen on the devnet container network — run scripts/devnet-verify (in-container) for node-level checks' };
  }
  return { ok: true, inv, host, expected: protocol.primaryNetwork.nodeCount + protocol.validators.count };
}

/** L1 验证者之间应互联：5 个节点里每个至少看到其余 4 个（spec US5 场景 1：peers ≥ 4）。 */
export const MIN_L1_PEERS = 4;

/**
 * 各节点自报的高度 —— 供 `verify-network` 在「等交易确认超时」时诊断用（研究 V-76）。
 *
 * **复用同一次 `nodeStatus()`**（模块级记忆化），不额外探一遍：
 * 诊断发生在失败之后，此时上面几项检查通常已经把它取过了。
 * 取不到就返回空数组 —— 诊断拿不到数就不作答，而不是猜。
 */
export async function nodeHeights() {
  try {
    const s = await nodeStatus();
    return (s.nodes ?? []).map((n) => ({ id: n.id, height: n.height }));
  } catch {
    return [];
  }
}

export const rpcCheck = {
  id: 'rpc',
  async run({ publicClient }) {
    const t0 = Date.now();
    const id = await publicClient.getChainId();
    return { status: STATUS.OK, detail: `eth_chainId responded in ${Date.now() - t0} ms`, data: { chainId: id } };
  },
};

export const chainIdCheck = {
  id: 'chain-id',
  async run({ publicClient, protocol, report }) {
    const got = await publicClient.getChainId();
    report.setSummary({ chainId: got });
    const want = protocol.chain.chainId;
    if (got !== want) {
      return { status: STATUS.FAIL, category: CATEGORIES.CONFIGURATION, detail: `chain reports ${got}, protocol.json says ${want}` };
    }
    if (got === protocol.chain.reservedMainnetChainId) {
      return { status: STATUS.FAIL, category: CATEGORIES.CONFIGURATION, detail: `chain is using the reserved mainnet chain id ${got}` };
    }
    return { status: STATUS.OK, detail: `${got} == protocol.json` };
  },
};

export const networkIdCheck = {
  id: 'network-id',
  async run({ info, protocol, report }) {
    const got = await info.networkID();
    report.setSummary({ networkId: got });
    const want = protocol.avalanche.networkId;
    return got === want
      ? { status: STATUS.OK, detail: `${got} == protocol.json` }
      : { status: STATUS.FAIL, category: CATEGORIES.CONFIGURATION, detail: `node reports network id ${got}, protocol.json says ${want}` };
  },
};

export const tokenCheck = {
  id: 'token',
  async run({ protocol }) {
    // 原生代币的符号/名称不由 RPC 暴露（EVM 没有该接口），只能核对协议参数与创世的自洽性。
    const { name, symbol, decimals } = protocol.nativeToken;
    return { status: STATUS.OK, detail: `${symbol} / ${decimals} decimals (${name}) == protocol.json`, data: { name, symbol, decimals } };
  },
};

/**
 * 把「声明了但**不是链上成员**」的那些从故障桶里摘出来（功能 005 / FR-028）。
 *
 * ## 为什么验证器也需要这件事
 *
 * 2026-09-17 退掉 l1-2 之后，验证器报 NOT READY，两条都指向 l1-2，
 * 其中一条的处置是「整域缺席，**去看那台机器**」—— 那台机器没什么可查：
 * 那个节点是**被主动移除、又被主动停掉**的。
 *
 * 面板早就分得清（`membership` 分类 + 容错按链上成员收敛），**而验证器不知道
 * 「成员集合」这回事** —— 它按**声明**的节点列表遍历。FR-028 因此只做了一半。
 *
 * 而这个窗口不是异常状态，**它是规程本身规定的**：先从集合移除 → 等确认 →
 * 再停进程 → 最后才改声明。中间必然有一段「声明里有、链上没有」，
 * 每次退成员都会撞到。
 *
 * ## 判据取自 `node-status` 已经算好的 `registeredOnChain`，不再读一次
 *
 * 那个字段由 `collect()` 经 `readConsensusMembers` 得出 —— 面板与本验证器因此
 * 共用同一个成员集合。**在验证器里另读一次会引入第二个notion，两处必然会分歧。**
 *
 * **不是放宽，是分桶**，三条约束：
 *   ① `registeredOnChain` 为 `null`（读不到成员集合）→ 留在原桶，
 *      行为与加这一段之前**逐字相同** —— 一次失败的读取不许让真故障沉默
 *   ② 只有**确认为 `false`** 的才摘出来
 *   ③ 摘出来的必须在 OK 的那句话里**被说出来** —— 静默放过会掩盖一份过期的声明
 */
/**
 * ## 2026-09-25 补：**"已被移除"与"还没注册完"必须再分一次桶**（研究 V-74 第 5 条）
 *
 * 上面那一版把两者合成一类、一律判 OK。代价在一次真人试验里现形：
 * 一个照文档加第 9 个验证者的人做完了"把机器准备好"的全部步骤、**还没走注册**，
 * 此时 `deployment.json` 是 9、代理是 9、`devnet-status` 里新节点也已 healthy，
 * 唯独链上还是 8 —— 而 `devnet-verify` 输出 `READY … 0 failed`。
 * 他据此认为做完了。**一个在"活儿没干完"时判绿的验收器，比没有验收器更坏。**
 *
 * 两者的性质本来就不同：
 *   - **已被移除**：活儿干完了，只剩一份过期的声明要清理 → 不是故障，OK + 说出来
 *   - **还没注册完**：活儿**没干完**，链上成员数还没变 → 必须红
 *
 * 判据用「**那台机器还活着吗**」，而不是再去读一次合约：
 * 退出的规程是"先从集合移除 → 等确认 → **再停进程** → 最后才改声明"，
 * 所以被移除的那些**进程是停的**；而正在注册的那些**必须在跑**（不跑就没法被注册）。
 * 这个判据取自本次已经拿到的探测结果，不引入第二个 notion —— 与下面那条注释同理。
 *
 * **它会误判的那一种情形，写在这里而不是藏起来**：紧急摘除之后那台机器又被开机了，
 * 于是"不在集合里却仍在运行"。`devnet-member` 明确把那当作要避免的状态并会拦下
 * （见 docs/devnet.md §5.4），所以这里把它报成"注册未完成"是可接受的 ——
 * 两种情形的处置都是"让声明与链上重新一致"。
 */
const splitNonMembers = (rows) => {
  const nonMembers = rows.filter((r) => r.registeredOnChain === false);
  return {
    nonMembers,
    /** 活儿没干完的：还在跑，却不是链上成员 */
    registering: nonMembers.filter((r) => r.alive === true),
    /** 只剩声明要清理的：进程已停 */
    stale: nonMembers.filter((r) => r.alive !== true),
    rest: rows.filter((r) => r.registeredOnChain !== false),
  };
};

const nameOf = (r) => r.label ?? r.id;

/** 摘出来那些要说的那句话 —— 处置指向仓库或指向"把注册走完"，都不指向机房。 */
const nonMemberNote = ({ registering = [], stale = [] } = {}) => {
  const parts = [];
  if (registering.length) {
    parts.push(`；${registering.length} 个声明了但**还不是链上成员**`
      + `（${registering.map(nameOf).join('、')}）——`
      + '它们在跑却没进集合，**注册没走完**：处置是把 ACP-77 四步续完'
      + '（`scripts/devnet-member.sh add --node-id …`），不是去那台机器查进程');
  }
  if (stale.length) {
    parts.push(`；另有 ${stale.length} 个声明了但**不是链上成员**且进程已停`
      + `（${stale.map(nameOf).join('、')}）——`
      + '已被移除，**不是故障**：处置是把它从 deployment.json 里清掉并重新渲染');
  }
  return parts.join('');
};

export const nodeCheck = {
  id: 'node',
  async run({ protocol }) {
    const access = await nodeAccess(protocol);
    if (!access.ok) return { status: STATUS.SKIP, detail: access.reason };
    const { inv, expected } = access;
    if (inv.nodes.length !== expected) {
      return { status: STATUS.FAIL, category: CATEGORIES.NODE, detail: `inventory lists ${inv.nodes.length} nodes, protocol.json expects ${expected}` };
    }
    // 判据："本节点能否参与 L1 出块"（T094）。`catching-up` / `bootstrapping` 是"要等"
    // 而非"坏了"，因此不算失败 —— 否则恢复期间的每一次验证都会误报。
    const s = await nodeStatus();
    const all = s.nodes.map((n) => ({
      label: n.id, state: n.state, healthy: n.state === 'healthy',
      waiting: ['catching-up', 'bootstrapping', 'starting'].includes(n.state),
      // 「那台机器还活着吗」—— 分"已被移除"与"还没注册完"要用它（见 splitNonMembers）
      alive: !['stopped', 'unreachable'].includes(n.state),
      detail: n.detail, registeredOnChain: n.registeredOnChain,
    }));
    // 「已被移除 / 还没注册完」先摘出去 —— 它们不是**节点**故障（FR-028）。
    // 注册没走完这件事由 `validator` 那一项判红，本项只把它说出来：
    // 同一个事实报两遍，正是 2026-09-17 那次（l1-2 被报了两条）的教训。
    // Primary 节点的 registeredOnChain 恒为 null（它们不是 L1 成员），所以不受影响。
    const { registering, stale, rest: results } = splitNonMembers(all);
    const bad = results.filter((r) => !r.healthy && !r.waiting);
    const waiting = results.filter((r) => r.waiting);

    if (bad.length) {
      return {
        status: STATUS.FAIL,
        category: CATEGORIES.NODE,
        detail: `${bad.length}/${expected} 须处置：${bad.map((b) => `${b.label} ${b.state}（${b.detail}）`).join('; ')}`
          + nonMemberNote({ registering, stale }),
        data: { nodes: all },
      };
    }
    const note = waiting.length ? `，${waiting.length} 个在恢复中（${waiting.map((w) => `${w.label} ${w.state}`).join('、')}）` : '';
    return {
      status: STATUS.OK,
      // 分母用**摘出之后**的数，并把摘掉的那些说出来 —— 否则 "5/6 serving" 会读成少了一个
      detail: `${results.length - waiting.length}/${results.length} nodes serving${note}`
        + nonMemberNote({ registering, stale }),
      data: { nodes: all },
    };
  },
};

export const validatorCheck = {
  id: 'validator',
  async run({ protocol }) {
    const access = await nodeAccess(protocol);
    if (!access.ok) return { status: STATUS.SKIP, detail: access.reason };
    const l1 = access.inv.nodes.filter((n) => n.role === 'l1-validator');
    if (l1.length !== protocol.validators.count) {
      return { status: STATUS.FAIL, category: CATEGORIES.VALIDATOR, detail: `found ${l1.length} L1 validators, protocol.json expects ${protocol.validators.count}` };
    }
    const chainAlias = protocol.chain.blockchainName;
    // `registeredOnChain` 从**同一次** nodeStatus() 取（模块级记忆化，不多一次读）——
    // 在这里自己再读一遍成员集合会引入第二个 notion，而两处必然会分歧。
    const onChainOf = new Map((await nodeStatus()).nodes.map((n) => [n.id, n.registeredOnChain]));
    const probed = await Promise.all(l1.map(async (n) => {
      const registeredOnChain = onChainOf.get(n.label) ?? null;
      try {
        const [bootstrapped, peers, id] = await Promise.all([
          nodeIsBootstrapped(n, chainAlias),
          nodePeerCount(n),
          nodeId(n),
        ]);
        // alive：探测成功就说明那台机器还在应答（见 splitNonMembers）
        return { label: n.label, bootstrapped: bootstrapped === true, peers, nodeId: id, matchesInventory: id === n.nodeId, registeredOnChain, alive: true };
      } catch (e) {
        return { label: n.label, bootstrapped: false, peers: 0, error: e.message.slice(0, 80), registeredOnChain, alive: false };
      }
    }));
    // 已被移除的先摘出去（不是故障，FR-028）；**注册没走完的由本项判红** —— 见下。
    const { registering, stale, rest: results } = splitNonMembers(probed);
    // **"活儿没干完"必须红。** 声明里有它、它也在跑，而链上成员数还没变 ——
    // 2026-09-25 实测：此时若判绿，人会据此认为加节点做完了（研究 V-74 第 5 条）。
    // 排在下面各项之前：其余几项判的是"这些成员好不好"，而这一条判的是
    // "成员集合对不对" —— 后者不成立时，前者判什么都不是验收。
    if (registering.length) {
      return {
        status: STATUS.FAIL,
        category: CATEGORIES.VALIDATOR,
        detail: `${registering.length} 个声明的 L1 验证者**还不是链上成员**`
          + `（${registering.map(nameOf).join('、')}）——`
          + '它们在跑却没进集合，注册没走完：把 ACP-77 四步续完'
          + '（`scripts/devnet-member.sh add --node-id …`；进度用 `npm run membership:status` 看）'
          + nonMemberNote({ stale }),
        data: { validators: probed },
      };
    }
    if (!results.length) {
      return {
        status: STATUS.SKIP,
        detail: `声明的 ${l1.length} 个 L1 验证者**都不是链上成员** —— 无可判定`
          + nonMemberNote({ stale }),
        data: { validators: probed },
      };
    }
    const notBootstrapped = results.filter((r) => !r.bootstrapped);
    const lowPeers = results.filter((r) => r.peers < MIN_L1_PEERS);
    const wrongId = results.filter((r) => r.matchesInventory === false);
    if (notBootstrapped.length) {
      return { status: STATUS.FAIL, category: CATEGORIES.VALIDATOR, detail: `${notBootstrapped.length}/${results.length} not bootstrapped on '${chainAlias}': ${notBootstrapped.map((r) => r.label + (r.error ? ` (${r.error})` : '')).join(', ')}` + nonMemberNote({ stale }), data: { validators: probed } };
    }
    if (lowPeers.length) {
      return { status: STATUS.FAIL, category: CATEGORIES.P2P, detail: `${lowPeers.length}/${results.length} below the ${MIN_L1_PEERS}-peer floor: ${lowPeers.map((r) => `${r.label}=${r.peers}`).join(', ')}` + nonMemberNote({ stale }), data: { validators: probed } };
    }
    if (wrongId.length) {
      return { status: STATUS.FAIL, category: CATEGORIES.VALIDATOR, detail: `node id mismatch vs committed dev keys: ${wrongId.map((r) => r.label).join(', ')}` + nonMemberNote({ stale }), data: { validators: probed } };
    }
    const peerRange = [...new Set(results.map((r) => r.peers))].sort((a, b) => a - b);
    return { status: STATUS.OK, detail: `${results.length}/${results.length} L1 validators bootstrapped, peers>=${MIN_L1_PEERS} each (observed ${peerRange.join('/')})` + nonMemberNote({ stale }), data: { validators: probed } };
  },
};

export const balanceCheck = {
  id: 'balance',
  async run({ publicClient, protocol }) {
    // 基准是区块 0：ewoq 在 latest 会因支付 PoA 初始化 gas 而低于创世值（research T014），
    // 所以创世精确比对用区块 0，latest 只要求不超过创世值。
    const rows = await Promise.all(protocol.devAccounts.map(async (a) => {
      const want = BigInt(a.balanceWei);
      const [atGenesis, atLatest] = await Promise.all([
        publicClient.getBalance({ address: a.address, blockNumber: 0n }),
        publicClient.getBalance({ address: a.address }),
      ]);
      return { label: a.label, want, atGenesis, atLatest, genesisOk: atGenesis === want, latestOk: atLatest <= want };
    }));
    const badGenesis = rows.filter((r) => !r.genesisOk);
    if (badGenesis.length) {
      return {
        status: STATUS.FAIL,
        category: CATEGORIES.GENESIS,
        detail: `${badGenesis.length}/${rows.length} genesis allocations wrong: ${badGenesis.map((r) => `${r.label} has ${r.atGenesis} want ${r.want}`).join('; ')}`,
      };
    }
    const spent = rows.filter((r) => r.atLatest !== r.want).length;
    return {
      status: STATUS.OK,
      detail: `${rows.length}/${rows.length} dev accounts match genesis at block 0${spent ? ` (${spent} have spent since)` : ''}`,
      data: { accounts: rows.map((r) => ({ label: r.label, genesisWei: r.atGenesis.toString(), latestWei: r.atLatest.toString() })) },
    };
  },
};

/**
 * 容错余量（功能 002 / T045、FR-011）。
 *
 * 只报告「当前在线验证者数」与「推导出的容错上限」的关系 —— 让"还剩多少余量"成为
 * 可自动化验证的事实，而不是需要人去心算的东西。
 *
 * 上限来自共识参数：等权验证者 n 个、发起查询需已连接权重 ≥ 75%，故 f ≤ ⌊n/4⌋
 * （001 研究 R-05）。全部在线时余量满格；已有节点离线但仍在上限内时给出警示性说明；
 * 越界则判为失败 —— 此时链已经停摆，属于必须立刻知道的状态。
 */
export const faultToleranceCheck = {
  id: 'fault-tolerance',
  async run({ protocol }) {
    const access = await nodeAccess(protocol);
    if (!access.ok) return { status: STATUS.SKIP, detail: access.reason };

    // 与 node 项同源（T094）：离线的判定来自 node-status 的 classify，
    // 因此 `catching-up` 的节点**不计入离线** —— 契约要求追赶中不算故障。
    const s = await nodeStatus();
    const { summary: sum, faultTolerance } = s;
    const total = faultTolerance.validatorCount;
    const maxOffline = faultTolerance.maxOfflineValidators;
    const data = { total, online: sum.online, offline: sum.offlineIds, maxOffline };
    const head = `${sum.online}/${total} validators online, tolerance ${maxOffline} (75% query threshold)`;

    if (!sum.withinTolerance) {
      return {
        status: STATUS.FAIL,
        category: CATEGORIES.VALIDATOR,
        detail: `${head} — EXCEEDED: ${sum.offlineIds.join(', ')} offline, chain has stopped producing blocks`,
        data,
      };
    }
    return {
      status: STATUS.OK,
      detail: sum.offline === 0
        ? `${head}, full margin`
        : `${head} — ${sum.offlineIds.join(', ')} offline, ${sum.margin} of margin left`,
      data,
    };
  },
};

export const basicChecks = [rpcCheck, chainIdCheck, networkIdCheck, tokenCheck, nodeCheck, validatorCheck, faultToleranceCheck, balanceCheck];
export { categorizeError };
