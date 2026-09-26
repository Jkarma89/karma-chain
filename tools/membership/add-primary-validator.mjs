#!/usr/bin/env node
// tools/membership/add-primary-validator.mjs —— 把一个 L1 验证者加进 **Primary 网络**
// 的验证者集合（功能 005 / US4 / T045，方案 F-7）。
//
// ## 它解决的问题
//
// P 链引导要求连上 **≥80%** 的权益。今天 2 个 Primary 各握 50% ——
// **掉任意一个，引导就失败**（004 的 V-08 实测：0 个在线失败、1 个 50% 仍失败、
// 2 个 100% 才成功）。让若干 L1 验证者兼任 P 链验证者，把持有者数推到 6，
// 每个 16.67%，掉任意一台剩 83.33%。
//
// ## 这一步是不可逆的
//
// `minStakeDuration = 86400s` —— **质押最少 24 小时，P 链没有提前解除质押的交易**。
// 而且被加进集合的节点**从此不能再带 `partial-sync-primary-network` 启动**
// （avalanchego 对那个组合是启动即致命）。所以：
//
//   **顺序必须是：先去标志、重建容器 → 再跑本工具。** 反过来做，那个节点
//   下一次重启就起不来了，而那时质押已经锁死 24 小时。
//
// 本工具的前置检查按这个顺序**逐条**查，任一条不过就退出 30（**一步都不动链**）。
// 其中最要紧的是第 ④ 条：它不看文件，看**那个节点自己报的 C/X 链引导状态** ——
// 文件改了而容器没重建时，前三条都会过，只有这一条会拦住。
//
// ## 用法
//
//   node tools/membership/add-primary-validator.mjs --node l1-5 [--days 365]
//        [--stake-avax 1000000] [--dry-run] [--yes]
//
// 退出码与其余成员工具同一套（tools/membership/exit-codes.mjs）。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT, deriveTopology, readJson } from '../protocol/load.mjs';
import { identityOf } from '../verify/lib/identity.mjs';
import { ask } from './ask.mjs';
import { EXIT_OK, EXIT_PRECHECK, EXIT_STEP_FAILED, EXIT_ABORTED } from './exit-codes.mjs';
import { loadConfigOrExit } from './load-or-exit.mjs';

/** Primary 网络的 subnetID —— 全零，固定值。 */
export const PRIMARY_NETWORK_ID = '11111111111111111111111111111111LpoYY';

/** 委托手续费，单位是百万分之一（PercentDenominator = 1e6），2% 是链上的下限。 */
export const DELEGATION_SHARES = 20_000;

const AVAX = 1_000_000_000n;

/**
 * 加入之后，**掉任意一台机器**还剩多少权益 —— 纯函数。
 *
 * 判据按**机器**算，不按持有者算：本部署的失效单位是机器（ADR-0007 的由来），
 * 而 ubuntu-1 / ubuntu-2 各同时承载一个 Primary 和一个 L1 验证者。
 * 按持有者算会得出一个在现实里为假的结论 —— 8 个等权持有者看着满足
 * 「掉任意 1 个 ≥80%」，而那两台机器各握 25%，掉一台就剩 75%。
 *
 * @param {{domain:string, weight:bigint}[]} holders 每个权益持有者及其所在机器
 * @returns {{total:bigint, byDomain:Record<string,bigint>, worstDomain:string,
 *            worstShare:number, remainingPercent:number}|null}
 */
export function worstCaseAfterDomainLoss(holders) {
  if (!holders?.length) return null;
  const total = holders.reduce((t, h) => t + h.weight, 0n);
  if (total === 0n) return null;
  const byDomain = {};
  for (const h of holders) byDomain[h.domain] = (byDomain[h.domain] ?? 0n) + h.weight;
  let worstDomain = null;
  let worstWeight = -1n;
  for (const [d, w] of Object.entries(byDomain)) {
    if (w > worstWeight) { worstWeight = w; worstDomain = d; }
  }
  const pct = (x) => Number((x * 10_000n) / total) / 100;
  return {
    total,
    byDomain,
    worstDomain,
    worstShare: pct(worstWeight),
    remainingPercent: pct(total - worstWeight),
  };
}

/** P 链引导门槛（avalanchego 自报，004 的 V-08 实测）。 */
export const BOOTSTRAP_QUORUM_PERCENT = 80;

/**
 * 造一个「P 链的 NodeID → 我们的节点 id 与所在机器」的映射。
 *
 * 两处要用它（本工具的影响预测、`devnet-verify` 的 `stake-expiry` 检查），
 * 所以放在一处导出 —— **两处各写一份必然分歧**，而分歧出来的那份会在
 * "哪台机器握多少权益"上给出不同答案，那正是整个 F-7 的判据。
 *
 * 认不出的 NodeID **不吞掉**：`domain` 退化成 `(未知:…)`，于是它在按机器分组时
 * 自成一组。这是刻意的 —— 把一个认不出的持有者悄悄并进别人那一组，
 * 会让"掉一台还剩多少"算出一个偏乐观的数。
 */
export function holderMapper(p, d) {
  const domainOf = new Map(d.topologyNodes.map((n) => [n.id, n.domain ?? '(未归属)']));
  const nodeIdToId = new Map();
  for (const v of p.validators.nodes) {
    try {
      nodeIdToId.set(identityOf(v).nodeId, d.topologyNodes.find((n) => n.keyDir === v.keyDir)?.id ?? null);
    } catch { /* 身份不全（创世成员缺密钥目录之类）—— 跳过，别让它把整张表带崩 */ }
  }
  // Primary 的 NodeID 只在建链制品里，按数组位置对应（与 render-node-flags 同一约定）
  const primaryGenesis = readJson(resolve(REPO_ROOT, 'blockchain/chain-identity/primary-network.genesis.json'));
  const primaries = d.topologyNodes.filter((n) => n.role === 'primary');
  primaryGenesis.initialStakers.forEach((s, i) => {
    if (primaries[i]) nodeIdToId.set(s.nodeID, primaries[i].id);
  });
  return (nodeID, weight) => ({
    nodeID,
    weight: BigInt(weight ?? 0),
    ourId: nodeIdToId.get(nodeID) ?? null,
    domain: domainOf.get(nodeIdToId.get(nodeID)) ?? `(未知:${String(nodeID).slice(0, 12)}…)`,
  });
}

const pchainCall = (uri) => async (method, params) => {
  const r = await fetch(`${uri.replace(/\/$/, '')}/ext/bc/P`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
};

const infoCall = async (endpoint, method, params = {}) => {
  const r = await fetch(`${endpoint}/ext/info`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
};

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

async function main() {
  const nodeArg = arg('node');
  if (!nodeArg) {
    console.error('用法：node tools/membership/add-primary-validator.mjs --node <l1-N> [--days 365] [--stake-avax 1000000] [--dry-run] [--yes]');
    process.exit(EXIT_PRECHECK);
  }
  const days = Number(arg('days', '365'));
  const stakeAvax = BigInt(arg('stake-avax', '1000000'));
  const dryRun = flag('dry-run');

  const p = loadConfigOrExit();
  const d = deriveTopology(p);
  const node = d.topologyNodes.find((n) => n.id === nodeArg);

  console.error(`目标：${nodeArg}`);

  // ── 前置检查：任一条不过就退出 30，**一步都不动链** ───────────────────────
  console.error('\n前置检查…');

  // ① 它得是个 L1 验证者
  if (!node || node.role !== 'l1-validator') {
    console.error(`  ✗ ${nodeArg} 不是声明里的 L1 验证者`);
    process.exit(EXIT_PRECHECK);
  }

  // ② 它得已经列在兼任名单里 —— 名单是**声明**，不是这个工具的参数。
  //    先改声明再重建容器，是整条规程的第一步；跳过它意味着 flags 里还留着
  //    partial-sync，而那个组合会让节点下次启动直接致命退出。
  const listed = new Set(p.primaryNetwork.alsoValidatedBy ?? []);
  if (!listed.has(nodeArg)) {
    console.error(`  ✗ ${nodeArg} 不在 primaryNetwork.alsoValidatedBy 里`);
    console.error('    先把它写进 blockchain/deployment.json、npm run render、重建那个容器，再来跑本工具。');
    console.error('    顺序反了会让那个节点下次启动直接致命退出，而那时质押已锁死 24 小时。');
    process.exit(EXIT_PRECHECK);
  }

  // ③ 渲染出来的 flags 里确实没有那个标志
  const active = p.topology.activeDeployment;
  const flags = readJson(resolve(REPO_ROOT, `blockchain/nodes/${active}/${nodeArg}.flags.json`));
  if (flags['partial-sync-primary-network'] !== undefined) {
    console.error(`  ✗ blockchain/nodes/${active}/${nodeArg}.flags.json 里仍有 partial-sync-primary-network`);
    console.error('    跑一次 npm run render。');
    process.exit(EXIT_PRECHECK);
  }

  // ④ **最要紧的一条**：那个节点自己说它在全量同步主网络。
  //    前三条查的都是仓库里的文件；只有这一条能发现"文件改了而容器没重建"。
  const endpoint = `http://${node.address}:${node.httpPort}`;
  let live;
  try {
    const [id, c, x] = await Promise.all([
      infoCall(endpoint, 'info.getNodeID'),
      infoCall(endpoint, 'info.isBootstrapped', { chain: 'C' }),
      infoCall(endpoint, 'info.isBootstrapped', { chain: 'X' }),
    ]);
    live = { nodeID: id.nodeID, pop: id.nodePOP, c: c.isBootstrapped, x: x.isBootstrapped };
  } catch (err) {
    console.error(`  ✗ 连不上 ${endpoint}：${err.message}`);
    process.exit(EXIT_PRECHECK);
  }
  if (!live.c || !live.x) {
    console.error(`  ✗ ${nodeArg} 的 C/X 链还没引导完（C=${live.c} X=${live.x}）`);
    console.error('    这说明容器还在用旧配置跑 —— 文件改了不等于容器改了。');
    console.error(`    在那台机器上：docker compose -f docker/compose/${active}-<边界>.yml up -d --force-recreate ${nodeArg}`);
    console.error('    刚重建完的话，等它把两条链引导完再来（几十秒）。');
    process.exit(EXIT_PRECHECK);
  }

  // ⑤ 活节点报的 NodeID 必须与声明一致 —— 否则我们要质押的是**另一个节点**
  // 按 `keyDir` 找回声明里的那一项 —— `deriveTopology` 合并之后节点对象上
  // **没有** validatorIndex（它把 validators.nodes[] 的字段摊平进来，索引不在其中）。
  // 第一版按 validatorIndex 找，于是 find 返回 undefined，报在 identityOf 里 ——
  // 错误信息指向身份库，而真正错的是我这里的匹配键。
  const declaredEntry = p.validators.nodes.find((v) => v.keyDir === node.keyDir);
  if (!declaredEntry) {
    console.error(`  ✗ 在 validators.nodes[] 里找不到 keyDir = ${node.keyDir} 的那一项`);
    process.exit(EXIT_PRECHECK);
  }
  const declared = identityOf(declaredEntry);
  if (declared.nodeId !== live.nodeID) {
    console.error(`  ✗ NodeID 对不上：声明 ${declared.nodeId}，活节点报 ${live.nodeID}`);
    process.exit(EXIT_PRECHECK);
  }
  if (!live.pop?.publicKey || !live.pop?.proofOfPossession) {
    console.error('  ✗ 活节点没有报出 nodePOP —— 缺了它构造不出这笔交易');
    process.exit(EXIT_PRECHECK);
  }

  const primary = d.topologyNodes.find((n) => n.role === 'primary');
  const pchainUri = `http://${primary.address}:${primary.httpPort}`;
  const pchain = pchainCall(pchainUri);

  // ⑥ 已经是成员就直接成功返回（可重跑，不产生第二笔质押）
  const cur = await pchain('platform.getCurrentValidators', { subnetID: PRIMARY_NETWORK_ID });
  if (cur.validators.some((v) => v.nodeID === live.nodeID)) {
    console.error(`  ✓ ${nodeArg} 已经是 Primary 网络的验证者 —— 无需操作`);
    process.exit(EXIT_OK);
  }
  console.error(`  ✓ 全部通过（C/X 已引导，NodeID 一致，尚未在集合里）`);

  // ── 影响：加入前后，掉任意一台机器还剩多少权益 ────────────────────────────
  const holderOf = holderMapper(p, d);
  const before = cur.validators.map((v) => holderOf(v.nodeID, v.weight ?? v.stakeAmount ?? 0));
  const weight = stakeAvax * AVAX;
  const after = [...before, holderOf(live.nodeID, weight)];

  const b = worstCaseAfterDomainLoss(before);
  const a = worstCaseAfterDomainLoss(after);
  const verdict = (x) => (x.remainingPercent >= BOOTSTRAP_QUORUM_PERCENT ? '✓ 够' : '✗ 不够');
  console.error(`\n掉任意一台机器之后，P 链引导还能连上多少权益（门槛 ${BOOTSTRAP_QUORUM_PERCENT}%）：`);
  console.error(`  加入前：${before.length} 个持有者 / ${Object.keys(b.byDomain).length} 台机器 —— `
    + `最差是掉 ${b.worstDomain}（握 ${b.worstShare}%），剩 ${b.remainingPercent}%  ${verdict(b)}`);
  console.error(`  加入后：${after.length} 个持有者 / ${Object.keys(a.byDomain).length} 台机器 —— `
    + `最差是掉 ${a.worstDomain}（握 ${a.worstShare}%），剩 ${a.remainingPercent}%  ${verdict(a)}`);
  if (a.remainingPercent < BOOTSTRAP_QUORUM_PERCENT) {
    console.error('  （这一笔本身不会让处境变坏，但单靠它还不够 —— 名单里其余几个也要做完。）');
  }

  // ── 构造交易 ──────────────────────────────────────────────────────────────
  const { Context, pvm, utils, secp256k1, addTxSignatures } = await import('@avalabs/avalanchejs');
  const accounts = readJson('blockchain/accounts/dev-accounts.json').accounts;
  const label = p.validators.ownerAccount;
  const entry = accounts.find((x) => x.label === label);
  if (!entry) {
    console.error(`dev-accounts.json 里没有 label = ${label} 的账户`);
    process.exit(EXIT_PRECHECK);
  }
  const priv = Buffer.from(entry.privateKey.replace(/^0x/, ''), 'hex');
  const addrBytes = secp256k1.publicKeyBytesToAddress(secp256k1.getPublicKey(priv));
  const api = new pvm.PVMApi(pchainUri);
  const context = await Context.getContextFromURI(pchainUri);
  const pAddress = utils.format('P', context.hrp, addrBytes);

  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const start = nowSec;
  const end = nowSec + BigInt(Math.round(days * 86_400));

  const [feeState, utxoResp] = await Promise.all([
    api.getFeeState(),
    api.getUTXOs({ addresses: [pAddress] }),
  ]);
  const hexToBytes = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));

  let unsignedTx;
  try {
    unsignedTx = pvm.newAddPermissionlessValidatorTx({
      feeState,
      fromAddressesBytes: [addrBytes],
      utxos: utxoResp.utxos,
      nodeId: live.nodeID,
      start,
      end,
      weight,
      subnetId: PRIMARY_NETWORK_ID,
      rewardAddresses: [addrBytes],
      delegatorRewardsOwner: [addrBytes],
      shares: DELEGATION_SHARES,
      publicKey: hexToBytes(live.pop.publicKey),
      signature: hexToBytes(live.pop.proofOfPossession),
    }, context);
  } catch (err) {
    console.error(`\n✗ 构造交易失败：${err.message}`);
    process.exit(EXIT_STEP_FAILED);
  }

  const inputs = unsignedTx.getInputUtxos().reduce((t, u) => t + BigInt(u.output.amount()), 0n);
  const outputs = unsignedTx.getTx().baseTx.outputs.reduce((t, o) => t + BigInt(o.output.amount()), 0n);
  const fee = inputs - outputs - weight;

  const iso = (s) => new Date(Number(s) * 1000).toISOString().replace('T', ' ').slice(0, 16);
  console.error('\n干跑（已构造、已算费，**尚未提交**）：');
  console.error(`  付款地址    ${pAddress}`);
  console.error(`  质押        ${stakeAvax} AVAX（与既有 Primary 同量级 —— 不等权时 ⌊n/4⌋ 那套推导不成立）`);
  console.error(`  交易费      ${fee} nAVAX`);
  console.error(`  起止        ${iso(start)} → ${iso(end)}（${days} 天）`);
  console.error(`  委托费率    ${DELEGATION_SHARES / 10_000}%`);
  console.error(`  动用 UTXO   ${utxoResp.utxos.length} 个`);
  console.error('\n⚠ **提交之后 24 小时内无法撤回**（minStakeDuration = 86400s，P 链没有提前解除质押的交易）。');
  console.error(`⚠ 到期之后它会**自动退出**集合，权益分布悄悄退回去 —— 到期日 ${iso(end)} 要记在别处，链上不会提醒。`);

  if (dryRun) {
    console.error('\n--dry-run：到此为止，链未改动。');
    process.exit(EXIT_OK);
  }
  if (!flag('yes')) {
    const yes = await ask(`\n提交这笔质押交易？（${nodeArg} → Primary 网络验证者） [y/N] `);
    if (!yes) {
      console.error('已中止，链未改动。');
      process.exit(EXIT_ABORTED);
    }
  }

  await addTxSignatures({ unsignedTx, privateKeys: [priv] });
  let txID;
  try {
    ({ txID } = await api.issueSignedTx(unsignedTx.getSignedTx()));
  } catch (err) {
    console.error(`\n✗ 提交失败：${err.message}`);
    console.error('  链上没有留下中间态 —— 改完直接重跑本命令。');
    process.exit(EXIT_STEP_FAILED);
  }
  console.error(`\n✅ 已提交：${txID}`);
  console.error('  用 npm run membership:status 或本命令重跑确认它已进入集合（P 链出块后可见）。');
  process.exit(EXIT_OK);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('add-primary-validator.mjs')) {
  main().catch((err) => {
    console.error(`add-primary-validator: ${err?.stack ?? err}`);
    process.exit(EXIT_STEP_FAILED);
  });
}
