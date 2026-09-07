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
    const results = s.nodes.map((n) => ({
      label: n.id, state: n.state, healthy: n.state === 'healthy',
      waiting: ['catching-up', 'bootstrapping', 'starting'].includes(n.state),
      detail: n.detail,
    }));
    const bad = results.filter((r) => !r.healthy && !r.waiting);
    const waiting = results.filter((r) => r.waiting);

    if (bad.length) {
      return {
        status: STATUS.FAIL,
        category: CATEGORIES.NODE,
        detail: `${bad.length}/${expected} 须处置：${bad.map((b) => `${b.label} ${b.state}（${b.detail}）`).join('; ')}`,
        data: { nodes: results },
      };
    }
    const note = waiting.length ? `，${waiting.length} 个在恢复中（${waiting.map((w) => `${w.label} ${w.state}`).join('、')}）` : '';
    return {
      status: STATUS.OK,
      detail: `${results.length - waiting.length}/${expected} nodes serving${note}`,
      data: { nodes: results },
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
    const results = await Promise.all(l1.map(async (n) => {
      try {
        const [bootstrapped, peers, id] = await Promise.all([
          nodeIsBootstrapped(n, chainAlias),
          nodePeerCount(n),
          nodeId(n),
        ]);
        return { label: n.label, bootstrapped: bootstrapped === true, peers, nodeId: id, matchesInventory: id === n.nodeId };
      } catch (e) {
        return { label: n.label, bootstrapped: false, peers: 0, error: e.message.slice(0, 80) };
      }
    }));
    const notBootstrapped = results.filter((r) => !r.bootstrapped);
    const lowPeers = results.filter((r) => r.peers < MIN_L1_PEERS);
    const wrongId = results.filter((r) => r.matchesInventory === false);
    if (notBootstrapped.length) {
      return { status: STATUS.FAIL, category: CATEGORIES.VALIDATOR, detail: `${notBootstrapped.length}/${l1.length} not bootstrapped on '${chainAlias}': ${notBootstrapped.map((r) => r.label + (r.error ? ` (${r.error})` : '')).join(', ')}`, data: { validators: results } };
    }
    if (lowPeers.length) {
      return { status: STATUS.FAIL, category: CATEGORIES.P2P, detail: `${lowPeers.length}/${l1.length} below the ${MIN_L1_PEERS}-peer floor: ${lowPeers.map((r) => `${r.label}=${r.peers}`).join(', ')}`, data: { validators: results } };
    }
    if (wrongId.length) {
      return { status: STATUS.FAIL, category: CATEGORIES.VALIDATOR, detail: `node id mismatch vs committed dev keys: ${wrongId.map((r) => r.label).join(', ')}`, data: { validators: results } };
    }
    const peerRange = [...new Set(results.map((r) => r.peers))].sort((a, b) => a - b);
    return { status: STATUS.OK, detail: `${l1.length}/${l1.length} L1 validators bootstrapped, peers>=${MIN_L1_PEERS} each (observed ${peerRange.join('/')})`, data: { validators: results } };
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
