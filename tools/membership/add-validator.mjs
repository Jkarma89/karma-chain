// tools/membership/add-validator.mjs —— ACP-77 加一个 L1 验证者（功能 005 / T027）。
//
// ## 四步，每一步的完成**从链上读**，不靠状态文件
//
//   ① 合约 `initiateValidatorRegistration(...)`  → 发出一条 Warp 消息
//   ② 收集 L1 验证者的 BLS 签名并聚合            → `warp_getMessageAggregateSignature`
//   ③ P 链 `RegisterL1ValidatorTx`               → 成员进入 P 链的权益集合
//   ④ 合约 `completeValidatorRegistration(...)`  → 合约侧确认，成员生效
//
// **进度不落盘，从链上推断。** 状态文件会过期、会与链不一致，而"重试时先信文件还是先信链"
// 是个没有好答案的问题。每一步的完成都是链上可观测的：
//
//   ① 完成 → 合约发出过 `InitiatedValidatorRegistration`（带该 nodeID）
//   ③ 完成 → P 链 `platform.getCurrentValidators({subnetID})` 里出现该 nodeID
//   ④ 完成 → 合约的 `getValidator(validationID).status` 为 active（= 2，research V-24）
//
// 于是 FR-016（失败可见、可重试、能报出停在哪一步）不是靠记账实现的，
// 而是**每次运行都重新观测一遍**。中断、换机器、隔一天再来，结论都一样。
//
// ② 是唯一不可观测的一步（聚合签名是个临时产物）。它**可以无代价重做** ——
// 消息还在链上，重新聚合一次即可。所以不需要为它记账。
//
// ## 每步之间停下来
//
// 默认在每一步之前打印它要做什么、要花什么，然后等确认。
// `--yes` 可以跳过确认，但**第一次真做的时候不要用** ——
// 第三步是花钱的（P 链持续费用），第四步失败会留下"P 链认了、合约没认"的中间态。
//
// ## 第四步要求两个 Primary 都在线
//
// 链配置里 `requirePrimaryNetworkSigners: true`、`quorumNumerator: 67`：
// P 链发回的确认消息必须由 **Primary Network 验证者**签名，而两个 Primary
// 各握 50% P 链权益 —— 67% 的门槛意味着**两个都必须在**。
// 这正是 004 的 V-08 查实的那个 AND 依赖，延伸到了注册流程的最后一步。
// 所以前置检查会核这一条：少一个 Primary 时**拦下且不动链**，而不是走到第四步才卡住。
import { createPublicClient, createWalletClient, http, keccak256, toHex, decodeEventLog } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { loadProtocol, readJson, REPO_ROOT, deriveTopology } from '../protocol/load.mjs';
import {
  identityOf, joinedValidators, nodeIdToBytes, cb58Encode,
} from '../verify/lib/identity.mjs';
import {
  VALIDATOR_MANAGER_ABI, PROXY_ADDRESS, TOPICS, STATUS,
  readMemberSet, classifyDrift, nodeIdFromBytes20,
} from './member-set.mjs';

export const EXIT_OK = 0;
export const EXIT_PRECHECK = 13;      // 前置检查不过 —— **一步都没动链**
export const EXIT_STEP_FAILED = 14;   // 某一步失败 —— 报出停在哪一步，可重试
export const EXIT_ABORTED = 20;       // 人工中止

/** 链上成员的状态码：2 = Active（research V-24 实测确认）。 */
const STATUS_ACTIVE = 2;

/**
 * 观测「现在走到第几步」。**只读，不动链。**
 *
 * @returns {{step: number, nodeId: string, validationID: string|null, notes: string[]}}
 *   `step` 是**已完成**的步数：0 = 还没开始，4 = 已完成
 */
export async function assessProgress({ client, pchain, nodeId, subnetId }) {
  const notes = [];

  // ① 合约有没有为这个 nodeID 发过 InitiatedValidatorRegistration
  const set = await readMemberSet({ client });
  const initiated = set.history.find(
    (h) => h.eventName === 'InitiatedValidatorRegistration' && h.nodeId === nodeId,
  );
  if (!initiated) {
    return { step: 0, nodeId, validationID: null, notes: ['合约上没有这个 nodeID 的注册记录'] };
  }
  const { validationID, registrationMessageID } = initiated;
  notes.push(`① 已发起：validationID = ${validationID}`);

  // ④ 合约侧是否已确认（放在 ③ 之前查：④ 成立必然蕴含 ③ 成立）
  const v = await client.readContract({
    address: PROXY_ADDRESS, abi: VALIDATOR_MANAGER_ABI,
    functionName: 'getValidator', args: [validationID],
  });
  if (Number(v.status) === STATUS_ACTIVE) {
    notes.push(`④ 合约侧已确认：status = ${Number(v.status)}（${STATUS[Number(v.status)]}），weight = ${v.weight}`);
    return { step: 4, nodeId, validationID, registrationMessageID, notes };
  }
  notes.push(`④ 合约侧**未**确认：status = ${Number(v.status)}（${STATUS[Number(v.status)] ?? '未知'}）`);

  // ③ P 链是否已收录
  const onP = await pchain('platform.getCurrentValidators', { subnetID: subnetId });
  const inP = (onP.validators ?? []).some((x) => x.nodeID === nodeId);
  if (inP) {
    notes.push('③ P 链已收录 —— **停在第四步**：P 链认了、合约还没认');
    return { step: 3, nodeId, validationID, registrationMessageID, notes };
  }
  notes.push('③ P 链**未**收录');
  return { step: 1, nodeId, validationID, registrationMessageID, notes };
}

/**
 * 前置检查（FR-013 / FR-014 / FR-015）。任一不过则**拦下且不动链**。
 *
 * 刻意在动链之前全部查完，而不是边做边查 —— 走到一半才发现拦不住的问题，
 * 留下的是一个需要人工收拾的中间态。
 */
export async function precheck({ client, pchain, nodeId, config }) {
  const problems = [];
  const d = deriveTopology(config);

  // ── 声明里必须有这个成员，且是 origin=joined ─────────────────────────────
  const declared = joinedValidators(config.validators.nodes)
    .find((x) => x.identity.nodeId === nodeId);
  if (!declared) {
    problems.push(`声明里没有 origin=joined 的 ${nodeId} —— 先把它写进 blockchain/deployment.json`
      + '（公开材料由 tools/membership/gen-node-keys.sh 在目标机器上生成）');
  }

  // ── T-5：每个故障边界的验证者数不得超过 ⌊n/4⌋（FR-013）──────────────────
  if (!d.faultTolerance.declaredWithinLimit && d.faultTolerance.domainCount > 1) {
    problems.push('声明的拓扑违反 T-5（某个故障边界的验证者数超过 ⌊n/4⌋）—— '
      + '先跑 node tools/protocol/validate-topology.mjs 看是哪个边界');
  }

  // ── 恢复能力：两个 Primary 都必须在线（FR-015）────────────────────────────
  //
  // 不是"最好在线"。链配置里 requirePrimaryNetworkSigners=true、quorumNumerator=67，
  // 而两个 Primary 各握 50% P 链权益 —— 第四步的确认消息要 67% 的 Primary 权重签名，
  // 少一个就永远聚合不出来。走到第四步才卡住的话，链上已经是
  // "P 链认了、合约没认" 的中间态（004 的 V-08 查实了这个 AND 依赖）。
  const primaries = d.topologyNodes.filter((n) => n.role === 'primary');
  const offline = [];
  for (const n of primaries) {
    try {
      const r = await fetch(`http://${n.address}:${n.httpPort}/ext/info`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"jsonrpc":"2.0","id":1,"method":"info.getNodeID","params":[]}',
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) offline.push(n.id);
    } catch { offline.push(n.id); }
  }
  if (offline.length) {
    problems.push(`Primary 节点 ${offline.join('、')} 不应答 —— **两个都必须在线**。`
      + '第四步的确认消息需要 67% 的 Primary 权重签名，而两个各握 50%，'
      + '少一个就永远聚合不出来（004 的 V-08）。先把它们弄回来。');
  }

  // ── 链上不得已经有这个成员 ────────────────────────────────────────────────
  const set = await readMemberSet({ client });
  if (set.members.some((m) => m.nodeId === nodeId)) {
    problems.push(`${nodeId} **已经是链上成员** —— 不要重复注册。`
      + '若要改权重，那是 initiateValidatorWeightUpdate，不是本流程。');
  }

  // ── 其它漂移要先说清（不阻断，但必须看见）────────────────────────────────
  const drift = classifyDrift(set.members, config.validators.nodes);
  const others = drift.drifts.filter((x) => x.nodeId !== nodeId);

  return { ok: problems.length === 0, problems, otherDrifts: others };
}

/**
 * 第一步的入参，**全部从声明与链上取**，不接受命令行传值。
 *
 * 为什么不让人传：nodeID / BLS 公钥是抄来抄去最容易出错的东西，而抄错一个字符
 * 得到的是一个**格式合法**的标识。让它们只能来自声明（且声明本身过 schema 与
 * CB58 校验和），就把"抄错"这类错误挡在了写链之前。
 *
 * `remainingBalanceOwner` / `disableOwner` 取**既有成员用的那个 P 链地址** ——
 * 新成员的持续费用与停用权限跟既有的一致，而不是另起一个。
 * 不一致的后果不是报错，是几个月后没人知道该去哪儿续费。
 */
export async function step1Inputs({ client, pchain, nodeId, config, subnetId }) {
  const declared = joinedValidators(config.validators.nodes).find((v) => v.identity.nodeId === nodeId);
  if (!declared) throw new Error(`声明里没有 ${nodeId}`);

  // 20 字节 nodeID：cb58Decode 会验 4 字节校验和与 20 字节长度
  const nodeIdBytes = `0x${nodeIdToBytes(nodeId).toString('hex')}`;
  const blsPublicKey = declared.identity.blsPublicKey;

  // 权重取既有成员的值，并要求它们**本来就等权** ——
  // ⌊n/4⌋ 那套推导的前提是等权（research V-22 实测五个各 100）。
  // 不等权时这套判据不成立，此时宁可停下来让人决定，也不要挑一个数继续。
  const onP = await pchain('platform.getCurrentValidators', { subnetID: subnetId });
  const existing = onP.validators ?? [];
  if (!existing.length) throw new Error('P 链上一个成员都没有 —— 这条链还没转成 L1？');
  const weights = new Set(existing.map((v) => String(v.weight)));
  if (weights.size > 1) {
    throw new Error(`既有成员权重不等（${[...weights].join(' / ')}）—— `
      + '⌊n/4⌋ 的容错推导以等权为前提，此时不该自动挑一个权重继续。'
      + '先决定新成员该用什么权重，以及不等权之后容错怎么算。');
  }
  const weight = BigInt(existing[0].weight);

  // P 链侧的两个 owner：沿用既有成员的那一个
  const owners = new Set(existing.flatMap((v) => v.remainingBalanceOwner?.addresses ?? []));
  if (owners.size !== 1) {
    throw new Error(`既有成员的 remainingBalanceOwner 不唯一（${[...owners].join(' / ')}）——`
      + ' 新成员该跟谁一致需要人来定');
  }
  const pAddr = [...owners][0];
  const { utils } = await import('@avalabs/avalanchejs');
  const pOwnerBytes = `0x${Buffer.from(utils.bech32ToBytes(pAddr)).toString('hex')}`;
  const pchainOwner = { threshold: 1, addresses: [pOwnerBytes] };

  return { nodeIdBytes, blsPublicKey, weight, pchainOwner, pAddr, existingCount: existing.length };
}

/**
 * 第一步：合约 `initiateValidatorRegistration`。
 *
 * **签名密钥必须就是合约的 owner** —— 先读 `owner()` 与本地密钥的地址比对，
 * 不符就停。不比的话，交易会被合约 revert，而 revert 的原因要去读 trace 才知道。
 */
export async function step1({ client, pchain, nodeId, config, subnetId, ownerAccount }) {
  const inputs = await step1Inputs({ client, pchain, nodeId, config, subnetId });

  const onChainOwner = await client.readContract({
    address: PROXY_ADDRESS, abi: VALIDATOR_MANAGER_ABI, functionName: 'owner',
  });
  if (onChainOwner.toLowerCase() !== ownerAccount.address.toLowerCase()) {
    throw new Error(`本地密钥的地址是 ${ownerAccount.address}，而合约的 owner 是 ${onChainOwner}`
      + ' —— 用它签名会被合约 revert。检查 validators.ownerAccount 指向的开发账户。');
  }

  const { createWalletClient, http } = await import('viem');
  const wallet = createWalletClient({
    account: ownerAccount,
    transport: http(client.transport.url ?? client.transport.value?.url),
  });

  const hash = await wallet.writeContract({
    address: PROXY_ADDRESS,
    abi: VALIDATOR_MANAGER_ABI,
    functionName: 'initiateValidatorRegistration',
    args: [
      inputs.nodeIdBytes,
      inputs.blsPublicKey,
      inputs.pchainOwner,   // remainingBalanceOwner
      inputs.pchainOwner,   // disableOwner
      inputs.weight,
    ],
    chain: null,
  });
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== 'success') {
    throw new Error(`交易被回滚（${hash}）—— 第一步未完成，可以直接重试`);
  }

  // 从**事件**读结果，不读返回值：返回值只有交易模拟能拿到，而事件是链上事实。
  const log = receipt.logs.find((l) => l.topics[0] === TOPICS.initiated);
  if (!log) {
    throw new Error(`交易成功但没有 InitiatedValidatorRegistration 事件（${hash}）——`
      + ' 合约版本与 ABI 不符？先跑 npm test 看 validator-manager-abi 那条守卫');
  }
  const { args } = decodeEventLog({ abi: VALIDATOR_MANAGER_ABI, data: log.data, topics: log.topics });
  return {
    txHash: hash,
    blockNumber: receipt.blockNumber,
    validationID: args.validationID,
    registrationMessageID: args.registrationMessageID,
    expiry: args.registrationExpiry,
    weight: args.weight,
    inputs,
  };
}

/** Warp 消息 ID：合约事件给的是 32 字节 hex，而 Warp API 要的是 **CB58**。 */
export const messageIdToCb58 = (hex) => cb58Encode(Buffer.from(hex.replace(/^0x/, ''), 'hex'));

/**
 * 从一条已签名的 Warp 消息里数出**有多少个验证者签了名**。
 *
 * 结构（avalanchego 的 warp 包）：未签名消息 ‖ 签名类型(4) ‖ bitset 长度(4) ‖ bitset ‖ BLS 聚合签名(96)。
 * bitset 里置位的个数就是签名者数。
 *
 * 为什么要数：**"返回了一条消息"不等于"聚合到了签名"**。若 API 因为某种原因
 * 把未签名消息原样返回，我们会带着一条 P 链必然拒绝的消息走到第三步 ——
 * 而第三步是花钱且会留下中间态的那一步。
 */
export function countSigners(signedHex, unsignedHex) {
  const signed = Buffer.from(signedHex.replace(/^0x/, ''), 'hex');
  const unsigned = Buffer.from(unsignedHex.replace(/^0x/, ''), 'hex');
  if (signed.length <= unsigned.length) {
    throw new Error(`聚合后的消息（${signed.length} 字节）不比未签名的（${unsigned.length} 字节）长`
      + ' —— 没有附上任何签名。带着它走到第三步，P 链会拒绝，而那一步是花钱的。');
  }
  const sig = signed.subarray(unsigned.length);
  // 4 字节类型 + 4 字节 bitset 长度 + bitset + 96 字节签名
  if (sig.length < 4 + 4 + 1 + 96) {
    throw new Error(`签名段只有 ${sig.length} 字节，装不下 bitset 加 96 字节 BLS 签名`);
  }
  const bitsetLen = sig.readUInt32BE(4);
  const bitset = sig.subarray(8, 8 + bitsetLen);
  let signers = 0;
  for (const b of bitset) for (let i = 0; i < 8; i += 1) if (b & (1 << i)) signers += 1;
  return { signers, bitsetHex: `0x${bitset.toString('hex')}`, signatureBytes: sig.length - 8 - bitsetLen };
}

/**
 * 聚合到的签名权重够不够 quorum 门槛。
 *
 * ## 这条是实测逼出来的（2026-09-15）
 *
 * `warp_getMessageAggregateSignature` 传了 `quorumNum = 67`，**它照样返回了一条
 * 只有 3 个签名者的消息** —— 五个等权验证者，3/5 = 60% < 67%。
 * 也就是说那个参数不是它的硬门槛，**返回成功不代表达到了门槛**。
 *
 * 带着一条不够门槛的消息走到第三步，P 链会拒绝 —— 而第三步是四步里唯一花钱、
 * 且成功之后若第四步失败会留下中间态的那一步。所以门槛必须在这边自己验。
 *
 * 按**个数**折算权重成立的前提是**等权**（research V-22 实测五个各 100，
 * 且 step1Inputs 在权重不等时就已经拦下了）。
 */
export function meetsQuorum({ signers, registeredCount, quorumNum }) {
  if (!registeredCount) throw new Error('registeredCount 为 0 —— 算不出权重占比');
  const percent = Math.floor((signers * 100) / registeredCount);
  return { ok: percent >= quorumNum, percent, signers, registeredCount, quorumNum };
}

/**
 * 第二步：把第一步发出的 Warp 消息拿去**收集 L1 验证者的 BLS 签名并聚合**。
 *
 * **这一步不写链。** 聚合签名是临时产物 —— 消息还在链上，失败可以无代价重做。
 * 所以它既不需要记账，也不会留下中间态。
 *
 * 逐个验证者试，**第一个给出有效结果的就用**。不是冗余设计过度：
 * 2026-09-15 实测 win-1 上的节点在这个调用上**挂住 45 秒**（同一台机器的第四次
 * 网络故障，前三次分别是入站端口空回复两次、出站连不上一次），
 * 而 ubuntu-1 / ubuntu-2 在 50 毫秒内返回。钉在单个节点上就会被这台机器拖死。
 *
 * @param {number} quorumNum 权重门槛的分子，取自链配置的 `quorumNumerator`（实测 67）
 */
export async function step2({
  config, identity, registrationMessageID, registeredCount,
  quorumNum = 67, timeoutMs = 45_000,
}) {
  if (!registeredCount) throw new Error('step2 需要 registeredCount（链上注册的成员数）来折算权重占比');
  const d = deriveTopology(config);
  const validators = d.topologyNodes.filter((n) => n.role === 'l1-validator');
  const messageId = messageIdToCb58(registrationMessageID);
  const attempts = [];

  const call = async (node, method, params) => {
    const r = await fetch(`http://${node.address}:${node.httpPort}/ext/bc/${identity.blockchainId}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  };

  for (const node of validators) {
    try {
      const unsigned = await call(node, 'warp_getMessage', [messageId]);
      const signed = await call(node, 'warp_getMessageAggregateSignature',
        [messageId, quorumNum, identity.subnetId]);
      const counted = countSigners(signed, unsigned);
      if (counted.signers < 1) throw new Error('bitset 里一个签名者都没有');
      // **门槛要自己验** —— 实测那个 quorumNum 参数不是硬门槛（见 meetsQuorum 的注释）
      const q = meetsQuorum({ signers: counted.signers, registeredCount, quorumNum });
      if (!q.ok) {
        throw new Error(`只聚合到 ${q.signers}/${q.registeredCount} 个签名者（${q.percent}%），`
          + `低于 quorum 门槛 ${q.quorumNum}% —— 这条消息 P 链会拒绝。`
          + ' 常见成因：某些验证者离线，或消息还没传到它们那里（稍等再试）。');
      }
      attempts.push({ node: node.id, ok: true, ...counted });
      return {
        messageId,
        signedMessage: signed,
        unsignedBytes: (unsigned.length - 2) / 2,
        signedBytes: (signed.length - 2) / 2,
        via: node.id,
        ...counted,
        quorum: q,
        attempts,
      };
    } catch (err) {
      attempts.push({ node: node.id, ok: false, error: err.message.slice(0, 120) });
    }
  }

  throw new Error('没有任何验证者给出可用的聚合签名：\n'
    + attempts.map((a) => `  ${a.node}: ${a.error}`).join('\n')
    + '\n  这一步不写链，修好之后直接重跑即可。'
    + '\n  常见成因：某个节点的 Warp API 没开（看它日志里 WarpAPIEnabled），'
    + '或在线权重不到 quorum 门槛。');
}

/** 容错会不会变？加成员时 n 增大，⌊n/4⌋ **可能不变** —— 这一条必须说出来（FR-037 / F-5）。 */
export function toleranceChange(before, after) {
  const f = (n) => Math.floor(n / 4);
  return {
    before: { n: before, f: f(before) },
    after: { n: after, f: f(after) },
    changed: f(before) !== f(after),
  };
}

// ── 以下是命令行部分 ────────────────────────────────────────────────────────

const ask = async (question) => {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const a = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return a === 'y' || a === 'yes';
  } finally {
    rl.close();
  }
};

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : (args[i + 1] ?? true);
  };
  const autoYes = args.includes('--yes');
  const config = loadProtocol();
  const identity = readJson(resolve(REPO_ROOT, 'blockchain', 'chain-identity', 'karmachain.identity.json'));

  // 目标 nodeID：显式给，或者声明里恰好只有一个 joined 成员时自动取
  const joined = joinedValidators(config.validators.nodes);
  const nodeId = flag('--node-id') ?? (joined.length === 1 ? joined[0].identity.nodeId : undefined);
  if (!nodeId) {
    console.error('用法: node tools/membership/add-validator.mjs --node-id NodeID-… [--yes]');
    console.error(joined.length
      ? `声明里有 ${joined.length} 个 origin=joined 的成员，必须显式指定是哪一个：\n  `
        + joined.map((x) => x.identity.nodeId).join('\n  ')
      : '声明里没有 origin=joined 的成员 —— 先在目标机器上生成材料并写进 deployment.json');
    process.exit(EXIT_PRECHECK);
  }

  const rpcUrl = process.env.KARMACHAIN_RPC_URL
    ?? `http://127.0.0.1:${config.endpoints.hostRpcPort}${config.endpoints.rpcPath}`;
  const client = createPublicClient({ transport: http(rpcUrl) });

  // P 链走某个 Primary 节点。它们是 P 链的权益持有者，也是唯一完整同步主网络的节点。
  const d = deriveTopology(config);
  const primary = d.topologyNodes.find((n) => n.role === 'primary');
  const pchain = async (method, params) => {
    const r = await fetch(`http://${primary.address}:${primary.httpPort}/ext/bc/P`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  };

  console.error(`目标: ${nodeId}`);
  console.error(`L1 RPC: ${rpcUrl}`);
  console.error(`P 链: http://${primary.address}:${primary.httpPort}/ext/bc/P（经 ${primary.id}）\n`);

  // ── 前置检查 ──────────────────────────────────────────────────────────────
  console.error('前置检查…');
  const pre = await precheck({ client, pchain, nodeId, config });
  for (const p of pre.problems) console.error(`  ✗ ${p}`);
  for (const dr of pre.otherDrifts) console.error(`  ⚠ 另有漂移 [${dr.kind}] ${dr.nodeId ?? ''}`);
  if (!pre.ok) {
    console.error('\n**前置检查未通过 —— 一步都没动链。** 修好上面这些再来。');
    process.exit(EXIT_PRECHECK);
  }
  console.error('  ✓ 全部通过');

  // ── 容错会不会变（F-5：加成员**可能**买不到任何提升）──────────────────────
  const set = await readMemberSet({ client });
  const t = toleranceChange(set.members.length, set.members.length + 1);
  console.error(`\n容错：n = ${t.before.n} → ${t.after.n}，可离线数 ${t.before.f} → ${t.after.f}`
    + (t.changed ? '（**提高了**）' : '（**没有变化** —— 加这个成员买不到任何容错提升，见 F-5）'));

  // ── 观测进度 ──────────────────────────────────────────────────────────────
  const progress = await assessProgress({ client, pchain, nodeId, subnetId: identity.subnetId });
  console.error(`\n当前进度：已完成 ${progress.step}/4 步`);
  for (const n of progress.notes) console.error(`  ${n}`);

  if (progress.step === 4) {
    console.error('\n✅ 这个成员已经注册完成，无需操作。');
    process.exit(EXIT_OK);
  }

  console.error('\n接下来要做的是第 ' + (progress.step + 1) + ' 步。');
  console.error('**本次只做这一步，做完停下来。** 第三步会花钱（P 链持续费用），'
    + '第四步失败会留下「P 链认了、合约没认」的中间态。');

  if (!autoYes && !(await ask(`\n执行第 ${progress.step + 1} 步？`))) {
    console.error('已中止，链未改动。');
    process.exit(EXIT_ABORTED);
  }

  if (progress.step === 0) {
    // 第一步：合约调用。**代价最小、可直接重试** —— 失败就是交易回滚，链上没有中间态。
    const accounts = readJson('blockchain/accounts/dev-accounts.json').accounts;
    const label = config.validators.ownerAccount;
    const entry = accounts.find((a) => a.label === label);
    if (!entry) {
      console.error(`dev-accounts.json 里没有 label = ${label} 的账户`
        + `（validators.ownerAccount 指向它）`);
      process.exit(EXIT_PRECHECK);
    }
    const ownerAccount = privateKeyToAccount(entry.privateKey);

    let r;
    try {
      r = await step1({ client, pchain, nodeId, config, subnetId: identity.subnetId, ownerAccount });
    } catch (err) {
      console.error(`\n✗ 第一步失败：${err.message}`);
      console.error('  链上没有留下中间态 —— 修好原因后直接重跑本命令即可。');
      process.exit(EXIT_STEP_FAILED);
    }

    console.error('\n✅ 第一步完成');
    console.error(`  交易        ${r.txHash}（区块 ${r.blockNumber}）`);
    console.error(`  validationID        ${r.validationID}`);
    console.error(`  Warp 消息 ID        ${r.registrationMessageID}`);
    console.error(`  权重 ${r.weight}，与既有 ${r.inputs.existingCount} 个成员一致`);
    console.error(`  P 链 owner  ${r.inputs.pAddr}（沿用既有成员的）`);
    console.error('\n**停在这里。** 第二步要把那条 Warp 消息拿去收集 L1 验证者的 BLS 签名。');
    console.error('  再跑一次本命令即可继续 —— 进度从链上读，不依赖本次运行留下的任何东西。');
    process.exit(EXIT_OK);
  }

  if (progress.step === 1) {
    // 第二步：收集签名并聚合。**不写链** —— 失败可无代价重做，消息还在链上。
    const messageId = progress.registrationMessageID;
    if (!messageId) {
      console.error('\n✗ 第一步的事件里没有 registrationMessageID —— 无法进行第二步。');
      process.exit(EXIT_STEP_FAILED);
    }
    let r;
    try {
      const set = await readMemberSet({ client });
      r = await step2({
        config, identity, registrationMessageID: messageId,
        registeredCount: set.members.length,
      });
    } catch (err) {
      console.error(`\n✗ 第二步失败：${err.message}`);
      process.exit(EXIT_STEP_FAILED);
    }
    console.error('\n✅ 第二步完成');
    console.error(`  经 ${r.via} 聚合（逐个验证者试，第一个给出有效结果的就用）`);
    console.error(`  签名者 ${r.signers}/${r.quorum.registeredCount} 个`
      + `（${r.quorum.percent}%，门槛 ${r.quorum.quorumNum}%），bitset ${r.bitsetHex}`);
    console.error(`  消息 ${r.unsignedBytes} → ${r.signedBytes} 字节（多出 ${r.signedBytes - r.unsignedBytes}：bitset + 96 字节 BLS 聚合签名）`);
    for (const a of r.attempts.filter((x) => !x.ok)) console.error(`  （${a.node} 没给出结果：${a.error}）`);
    console.error('\n**停在这里。** 第三步要把这条已签名的消息提交到 P 链（RegisterL1ValidatorTx）——');
    console.error('  那一步**花钱**（持续费用），且成功之后若第四步失败，链上会留下');
    console.error('  「P 链认了、合约没认」的中间态。');
    console.error('\n  这一步不写链，所以它的产物不落盘 —— 第三步会重新聚合一次（成本是毫秒级）。');
    process.exit(EXIT_OK);
  }
  console.error(`\n第 ${progress.step + 1} 步的实现尚未落地（T027 进行中）。`);
  console.error('这条路径刻意不"先跑起来再说"：写链的代码没有经过变红检查之前，'
    + '不该有机会真的发出交易。');
  process.exit(EXIT_STEP_FAILED);
}
