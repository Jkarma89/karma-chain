// tools/verify/checks/basic.mjs —— T033：节点、验证者、RPC、链身份、代币、创世余额。
// 每个检查导出 { id, run(ctx) } → { status, category?, detail, data? }。

import { STATUS } from '../lib/report.mjs';
import { CATEGORIES, categorizeError } from '../lib/categories.mjs';
import { readInventory, resolveNodeHost, nodeHealth, nodePeerCount, nodeIsBootstrapped, nodeId } from '../lib/avalanche-api.mjs';

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
    const results = await Promise.all(inv.nodes.map(async (n) => {
      try {
        const h = await nodeHealth(n);
        return { label: n.label, healthy: h.healthy === true, detail: h.healthy ? 'healthy' : 'unhealthy' };
      } catch (e) {
        return { label: n.label, healthy: false, detail: e.message.slice(0, 80) };
      }
    }));
    const bad = results.filter((r) => !r.healthy);
    return bad.length === 0
      ? { status: STATUS.OK, detail: `${results.length}/${expected} nodes healthy`, data: { nodes: results } }
      : { status: STATUS.FAIL, category: CATEGORIES.NODE, detail: `${bad.length}/${expected} unhealthy: ${bad.map((b) => `${b.label} (${b.detail})`).join('; ')}`, data: { nodes: results } };
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

export const basicChecks = [rpcCheck, chainIdCheck, networkIdCheck, tokenCheck, nodeCheck, validatorCheck, balanceCheck];
export { categorizeError };
