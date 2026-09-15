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
  return {
    signers,
    bitsetHex: `0x${bitset.toString('hex')}`,
    signatureBytes: sig.length - 8 - bitsetLen,
    aggregateSignature: `0x${sig.subarray(sig.length - 96).toString('hex')}`,
  };
}

/**
 * **哪些成员签了** —— 用密码学判定，不靠位序推断。
 *
 * ## 为什么不能从 bitset 的位序读出来
 *
 * 2026-09-15 聚合卡在 3/5 时，我需要知道是哪两个没签，于是去推 bitset 的位序：
 *
 *   第一次按 NodeID 的 CB58 字符串排序 → 算出「l1-3 与 l1-4 没签」
 *   第二次按 BLS 公钥字节排序           → 算出「l1-2 与 l1-3 没签」
 *
 * **两个都是错的**，而且各自都违反一条硬不变式：发起聚合的那个节点必然会
 * 计入自己的本地签名，可两种排序下都出现了「发起方不在自己的 bitset 里」。
 * 我拿这两个结论中的第一个向人报过，那是一次错误的汇报。
 *
 * 真正的签名者由这个函数算出来（唯一命中）：**l1-1 与 l1-3 没签**。
 *
 * 位序是 avalanchego 的实现细节，会随版本与规范排序规则而变；而
 * 「这条聚合签名能被哪一组公钥之和验过」是**数学事实**，不依赖任何约定。
 * 所以这里只从 bitset 取**个数**（个数与顺序无关），身份靠验签定。
 *
 * ## 代价与它的界
 *
 * 枚举 C(n, k) 个子集，每个做一次 BLS 验签（毫秒级）。n=5 时最多 10 次。
 * 成员多起来会爆，所以设了上界：超过就报错，**不静默跑很久**。
 *
 * ## 为什么用 avalanchejs 的 bls 而不是直接调 @noble/curves
 *
 * 仓库里 `identity.mjs` 已经直接用 `@noble/curves` 派生公钥，所以第一版也那么写了 ——
 * 结果**验不过**，而验不过看起来和"没签"一模一样。
 *
 * 实测（2026-09-15）：avalanchego 的普通签名用的是
 * `..._SSWU_RO_POP_` 那套密码组件，**不是** noble 的默认 `..._SSWU_RO_NUL_`。
 * 与名字给人的直觉相反（POP 听着像只给 proof of possession 用的）。
 *
 * 把这个 DST 字符串抄进代码是个陷阱：抄错不会报错，只会让判定**永远说没签**。
 * 所以这里用 avalanchejs 的封装 —— 它自带正确的组件，且正是第三步构造
 * P 链交易的同一个库，两处不会漂移。
 *
 * @param {{signedMessage: string, unsignedMessage: string,
 *          members: Array<{id: string, blsPublicKey: string}>, maxCombinations?: number}} args
 * @returns {Promise<{signed: string[], missing: string[], tried: number}>}
 */
export async function identifySigners({
  signedMessage, unsignedMessage, members, maxCombinations = 20_000,
}) {
  const { bls } = await import('@avalabs/avalanchejs');
  const { signers, aggregateSignature } = countSigners(signedMessage, unsignedMessage);
  const msg = Buffer.from(unsignedMessage.replace(/^0x/, ''), 'hex');
  const sig = Buffer.from(aggregateSignature.replace(/^0x/, ''), 'hex');
  const n = members.length;
  if (signers > n) {
    throw new Error(`聚合签名里有 ${signers} 个签名者，而已知成员只有 ${n} 个`
      + ' —— 传进来的成员集合不完整，判定不了身份。');
  }
  const choose = (a, b) => {
    let r = 1;
    for (let i = 0; i < b; i += 1) r = (r * (a - i)) / (i + 1);
    return Math.round(r);
  };
  const total = choose(n, signers);
  if (total > maxCombinations) {
    throw new Error(`${n} 个成员里选 ${signers} 个有 ${total} 种组合，超过上限 ${maxCombinations}`
      + ' —— 逐个验签会跑很久。要用就提高 maxCombinations，但先想清楚值不值。');
  }

  const points = members.map((m) => bls
    .publicKeyFromBytes(Buffer.from(m.blsPublicKey.replace(/^0x/, ''), 'hex')));
  const sigPoint = bls.signatureFromBytes(sig);
  let tried = 0;
  let hit = null;
  const idx = [];
  const walk = (start) => {
    if (hit) return;
    if (idx.length === signers) {
      tried += 1;
      // 聚合公钥就是各公钥的点之和 —— BLS 聚合签名正是对着这个和验的
      const agg = idx.slice(1).reduce((p, i) => p.add(points[i]), points[idx[0]]);
      if (bls.verify(agg, sigPoint, msg)) hit = [...idx];
      return;
    }
    for (let i = start; i < n && !hit; i += 1) {
      idx.push(i);
      walk(i + 1);
      idx.pop();
    }
  };
  if (signers > 0) walk(0);

  if (!hit) {
    throw new Error(`${total} 种组合都验不过这条聚合签名（成员 ${n} 个，签名者 ${signers} 个）。`
      + ' 可能的原因：传进来的公钥与链上注册的不是同一批，'
      + ' 或者这条消息的签名覆盖范围不是整条未签名消息。'
      + ' **不要据此断言谁没签** —— 验不过就是判定不出来，不是"都没签"。');
  }
  const signed = hit.map((i) => members[i].id);
  return { signed, missing: members.filter((_, i) => !hit.includes(i)).map((m) => m.id), tried };
}

/**
 * 把**链上注册的成员**配上公钥与可读名字，喂给 `identifySigners`。
 *
 * 候选集合必须正好是链上那一批：
 *   多了（比如把还没注册的新成员算进去）只是白试几个子集，不影响结论；
 *   **少了一个就永远找不到匹配** —— 而那看起来和"验不过"一模一样。
 *
 * 所以只要有任何一个链上成员在声明里找不到，就返回 null（不报名字），
 * 而不是拿一个残缺的集合去判定。谁多谁少由 precheck 的漂移检查去报。
 */
export function memberCandidates({ config, memberSet }) {
  const d = deriveTopology(config);
  const byNodeId = new Map();
  for (const n of d.topologyNodes.filter((x) => x.role === 'l1-validator')) {
    const v = config.validators.nodes.find((x) => x.keyDir === n.keyDir);
    if (!v) continue;
    let id;
    try { id = identityOf(v); } catch { continue; }
    byNodeId.set(id.nodeId, { id: `${n.id}/${n.domain}`, blsPublicKey: id.blsPublicKey });
  }
  const out = [];
  for (const m of memberSet.members) {
    const hit = m.nodeId ? byNodeId.get(m.nodeId) : null;
    if (!hit) return null;
    out.push(hit);
  }
  return out;
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
  // 超时从 45 秒收到 12 秒：实测成功的调用是 **0.05–2 秒**，45 秒只会让
  // 一个坏节点把整轮拖死（4 轮 × 6 节点最坏要几分钟）。
  quorumNum = 67, timeoutMs = 12_000, rounds = 4, delayMs = 4_000,
  // 给了就能报出**是哪几个没签**（见 identifySigners）；不给只报个数。
  members = null,
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

  // **多轮重试。** 签名收集有截止时间，收到几个签名取决于那一刻各验证者的 P2P 响应 ——
  // 2026-09-15 实测同一条消息在 3 与 4 个签名者之间**来回波动**（门槛要 4）。
  // 这一步只读且便宜（单次几十毫秒到 2 秒），所以重试是对的答案：
  // 与其让人看见一次"没到门槛"就去排查一个不存在的故障，不如多试几轮。
  // 上一轮**超时**过的节点，后面几轮直接跳过：超时是这台机器的网络问题，
  // 不会在几秒内自愈，而每次重试都要再赔上一个完整的超时。
  const timedOut = new Set();
  for (let round = 1; round <= rounds; round += 1) {
    for (const node of validators) {
      if (timedOut.has(node.id)) continue;
      try {
      const unsigned = await call(node, 'warp_getMessage', [messageId]);
      const signed = await call(node, 'warp_getMessageAggregateSignature',
        [messageId, quorumNum, identity.subnetId]);
      const counted = countSigners(signed, unsigned);
      if (counted.signers < 1) throw new Error('bitset 里一个签名者都没有');

      // **谁签了** —— 只在给了成员公钥时算，且算不出来不影响聚合本身的结论。
      // 判定失败可能只是候选集合与链上注册的不是同一批（见 identifySigners）。
      let who = null;
      if (members?.length) {
        try {
          who = await identifySigners({
            signedMessage: signed, unsignedMessage: unsigned, members,
          });
        } catch { who = null; }
      }
      const whoNote = who
        ? ` 没签的是：${who.missing.join('、') || '无'}。`
        : '';

      // **门槛要自己验** —— 实测那个 quorumNum 参数不是硬门槛（见 meetsQuorum 的注释）
      const q = meetsQuorum({ signers: counted.signers, registeredCount, quorumNum });
      if (!q.ok) {
        throw new Error(`只聚合到 ${q.signers}/${q.registeredCount} 个签名者（${q.percent}%），`
          + `低于 quorum 门槛 ${q.quorumNum}% —— 这条消息 P 链会拒绝。${whoNote}`
          + ' 常见成因：某些验证者离线，或它的 P2P 签名请求不通'
          + '（2026-09-15 实测过一次：节点自己能签、HTTP 也通，但别人经 P2P 要不到，'
          + '而链照常出块 —— 那次是网络设备重启后自愈的）。');
      }
      attempts.push({ node: node.id, round, ok: true, ...counted });
      return {
        messageId,
        round,
        signedMessage: signed,
        unsignedMessage: unsigned,
        unsignedBytes: (unsigned.length - 2) / 2,
        signedBytes: (signed.length - 2) / 2,
        via: node.id,
        ...counted,
        quorum: q,
        signedBy: who?.signed ?? null,
        missing: who?.missing ?? null,
        attempts,
      };
      } catch (err) {
        if (/timeout|aborted/i.test(err.message)) timedOut.add(node.id);
        attempts.push({ node: node.id, round, ok: false, error: err.message.slice(0, 120) });
      }
    }
    if (round < rounds) await new Promise((r) => setTimeout(r, delayMs));
  }

  // 只列**最后一轮**的失败：前几轮的同类失败没有新信息，全列会把真正的原因埋掉。
  const last = attempts.filter((a) => a.round === rounds);
  throw new Error(`${rounds} 轮都没有拿到达标的聚合签名（下列为最后一轮）：\n`
    + last.map((a) => `  ${a.node}: ${a.error}`).join('\n')
    + '\n  这一步不写链，修好之后直接重跑即可。'
    + '\n  常见成因：某个节点的 Warp API 没开（看它日志里 WarpAPIEnabled），'
    + '或在线权重不到 quorum 门槛。');
}

/**
 * 新成员该跟谁一致：既有成员的**续费地址**与**余额**。
 *
 * 这条规则原先内联在命令行分支里 —— 也就是**只有真跑一次 CLI 才会被执行**，
 * 测不到。而它判的是一件错了要花钱收拾的事：付款账户选错，第三步会
 * 在构造阶段报"余额不足"，看不出根因；余额选错，新成员的续费节奏与
 * 既有的不同，几个月后才暴露。
 *
 * **不唯一时不猜。** 既有成员的续费地址或余额出现分叉，说明这套成员集合
 * 已经不是同质的了，"新成员该跟谁一致"需要人来定。
 *
 * @param {Array<{remainingBalanceOwner?: {addresses?: string[]}, balance?: string|number}>} validators
 *        P 链 `platform.getCurrentValidators({subnetID})` 返回的既有成员
 */
export function payerExpectation(validators) {
  const list = validators ?? [];
  if (!list.length) {
    throw new Error('P 链上这条 subnet 没有任何既有成员 —— 推不出新成员该用的续费地址与余额。'
      + ' 第一个成员的这两个值要由人来定，本工具不猜。');
  }
  const owners = new Set(list.flatMap((v) => v.remainingBalanceOwner?.addresses ?? []));
  const balances = new Set(list.map((v) => String(v.balance)));
  if (owners.size !== 1 || balances.size !== 1) {
    throw new Error(`既有成员的续费地址或余额不唯一（地址 ${owners.size} 个 / 余额 ${balances.size} 种）`
      + ' —— 新成员该跟谁一致需要人来定，本工具不猜。');
  }
  return { expectedPAddress: [...owners][0], balance: BigInt([...balances][0]) };
}

/**
 * 用来签名的密钥，必须对应**持有那笔钱**的 P 链地址。
 *
 * ## 为什么两个参数都是必需的
 *
 * 初版写成 `if (expectedPAddress && pAddress !== expectedPAddress)` ——
 * **调用方忘了传期望值，检查就静默不做**，而调用处读起来一模一样。
 * 那是一条不会变红的守卫，比没有守卫更坏：它让人以为核过了。
 *
 * 所以缺期望值本身就是错误，且与"地址不符"分开报 —— 两者的修法不同：
 * 前者改调用方，后者换账户。
 */
export function assertPayerAccount({ pAddress, expectedPAddress }) {
  if (!pAddress) throw new Error('assertPayerAccount: 没有传入本次要用的 P 链地址');
  if (!expectedPAddress) {
    throw new Error('assertPayerAccount: 没有传入期望的 P 链地址（既有成员的 remainingBalanceOwner）'
      + ' —— 缺了它就无法核对付款账户，而"核不了"不等于"核过了"。');
  }
  if (pAddress !== expectedPAddress) {
    throw new Error(`用这个密钥算出的 P 链地址是 ${pAddress}，`
      + `而既有成员的 remainingBalanceOwner 是 ${expectedPAddress} —— 不是同一个账户。`
      + ' 新成员的续费地址会与既有的分叉，而那不会报错。'
      + ' 核对 validators.ownerAccount 指向的开发账户。');
  }
  return true;
}

/**
 * 费用 = 花掉的 UTXO 总额 − 找零 − 给新成员的 balance。
 *
 * ## 为什么这个算式需要自己的守卫
 *
 * 它是**唯一**在批准之前告诉人"会花多少"的东西，而"它会花钱"和
 * "它会花多少"是两句不同的话 —— 只有后者能让人做判断。
 *
 * 算式依赖 avalanchejs 的交易形状（`getInputUtxos()` 与 `baseTx.outputs`）。
 * 形状变了，算出来的不会是报错，而是**一个看着像费用的错数**。
 * 所以这里对结果本身设界：费用必须为正，且不得超过花掉的总额。
 * 负费用只可能来自算式或形状理解有误 —— 那时应当停下，而不是打印出来。
 */
export function computeFee({ inputAmounts, outputAmounts, balance }) {
  const spent = inputAmounts.reduce((n, a) => n + BigInt(a), 0n);
  const change = outputAmounts.reduce((n, a) => n + BigInt(a), 0n);
  const fee = spent - change - BigInt(balance);
  if (fee <= 0n) {
    throw new Error(`算出的交易费是 ${fee} nAVAX（花 ${spent}、找零 ${change}、`
      + `给新成员 ${balance}）—— 费用不可能为零或负数。`
      + ' 这说明算式或对交易形状的理解有误（avalanchejs 的输入/输出取法变了？），'
      + ' 而不是这笔交易真的免费。**不要带着这个数去批准。**');
  }
  if (fee >= spent) {
    throw new Error(`算出的交易费 ${fee} nAVAX 不小于花掉的总额 ${spent} —— 算式有误。`);
  }
  return { spent, change, fee };
}

/**
 * 第三步：把已签名的 Warp 消息提交到 P 链（`RegisterL1ValidatorTx`）。
 *
 * ## 这是四步里唯一"做错要收拾"的一步
 *
 *   第一步  L1 合约交易，失败就是回滚，**链上不留中间态**
 *   第二步  只读聚合，失败可无代价重做
 *   **第三步  P 链交易，花 AVAX；成功之后若第四步失败，链上留下「P 链认了、合约没认」**
 *   第四步  L1 合约交易，失败可用 resendRegisterValidatorMessage 重试
 *
 * 所以它分三段，**前两段不碰链**：
 *
 *   构造  向 P 链查 feeState 与 UTXO，算出交易与**费用** → 失败在这里最安全
 *   签名  本地用 ewoq 的密钥签 → 失败也不碰链
 *   提交  issueSignedTx → **只有这一段动链**
 *
 * `dryRun` 让前两段照常跑、第三段不做，于是**费用可以在批准之前算给人看**。
 *
 * ## 为什么要核 P 链地址
 *
 * 用来签名的密钥必须对应**持有那笔钱**的 P 链地址，也就是既有成员的
 * `remainingBalanceOwner`。不核的话，UTXO 会查出空集，而报出来的是一句
 * 「余额不足」或构造失败 —— 而真实原因是"你用错了账户"。
 */
export async function step3({
  config, identity, signedMessage, blsSignature, privateKeyHex,
  balance, pchainUri, expectedPAddress, dryRun = false,
}) {
  const { Context, pvm, utils, secp256k1, addTxSignatures } = await import('@avalabs/avalanchejs');

  const priv = Buffer.from(privateKeyHex.replace(/^0x/, ''), 'hex');
  const pubKey = secp256k1.getPublicKey(priv);
  const addrBytes = secp256k1.publicKeyBytesToAddress(pubKey);

  const api = new pvm.PVMApi(pchainUri);

  // **顺序有依赖，不能并发。** P 链地址的 bech32 编码要用 context 里的 hrp
  // （本网是 custom），而 UTXO 要按地址查。第一版图省一次请求把它们塞进
  // Promise.all，于是引用了还没赋值的 context —— 拿错 hrp 会查出**空 UTXO**，
  // 而空 UTXO 报出来的是"余额不足"，看不出根因在地址编码上。
  const context = await Context.getContextFromURI(pchainUri);
  const pAddress = utils.format('P', context.hrp, addrBytes);
  const [feeState, utxoResp] = await Promise.all([
    api.getFeeState(),
    api.getUTXOs({ addresses: [pAddress] }),
  ]);
  const { utxos } = utxoResp;

  // **这条断言是上面那段注释说的检查。**
  // 第一版只写了注释没写代码 —— 文档写了而代码没做，比不写更坏：
  // 读注释的人会以为它被检查过。
  // 第二版写了代码但让期望值可选，于是**忘了传就静默不检查** ——
  // 现在它在 assertPayerAccount 里，缺期望值本身就报错，并且测得到。
  assertPayerAccount({ pAddress, expectedPAddress });

  if (!utxos?.length) {
    throw new Error(`P 链地址 ${pAddress} 上没有任何 UTXO —— 用这个密钥付不了费用。`
      + ' 核对 validators.ownerAccount 指向的开发账户，以及既有成员的 remainingBalanceOwner。');
  }

  const unsignedTx = pvm.newRegisterL1ValidatorTx({
    balance,
    blsSignature: Buffer.from(blsSignature.replace(/^0x/, ''), 'hex'),
    feeState,
    fromAddressesBytes: [addrBytes],
    message: Buffer.from(signedMessage.replace(/^0x/, ''), 'hex'),
    utxos,
  }, context);

  // 费用 = 花掉的 UTXO 总额 − 找零 − 给验证者的 balance。
  // 在批准之前必须能报出来 —— "它会花钱"和"它会花多少"是两句不同的话。
  // 算式与它的上下界都在 computeFee 里（那里说明了为什么要设界）。
  const { spent, change, fee } = computeFee({
    inputAmounts: unsignedTx.getInputUtxos().map((u) => u.output.amount()),
    outputAmounts: unsignedTx.getTx().baseTx.outputs.map((o) => o.output.amount()),
    balance,
  });

  const plan = {
    pAddress,
    utxoCount: utxos.length,
    spent,
    change,
    balance,
    fee,
    networkId: context.networkID,
    blockchainId: context.pBlockchainID,
  };

  if (dryRun) return { ...plan, dryRun: true, txId: null };

  await addTxSignatures({ unsignedTx, privateKeys: [priv] });
  const signed = unsignedTx.getSignedTx();
  const { txID } = await api.issueSignedTx(signed);
  return { ...plan, dryRun: false, txId: txID };
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

  // **第二步不写链，所以 progress 永远不会等于 2。**
  // 初版把第三步写成 progress.step === 2 的分支 —— 那个分支永远进不去。
  // 进度从链上读的代价就在这里：不留痕迹的步骤在进度上是不可见的。
  //
  // 所以第二、三步合成**一次调用、两次确认**：先把聚合结果给人看，
  // 再把费用给人看，最后才提交。这比分成两次更贴合每步之间停下来——
  // 批准唯一那个写链动作之前，签名者数与费用都已摆在眼前。
  // --aggregate-only 保留只聚合、不往下走，排查时用。
  if (progress.step === 1 && args.includes('--aggregate-only')) {
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
        members: memberCandidates({ config, memberSet: set }),
      });
    } catch (err) {
      console.error(`\n✗ 第二步失败：${err.message}`);
      process.exit(EXIT_STEP_FAILED);
    }
    console.error('\n✅ 第二步完成');
    console.error(`  经 ${r.via} 聚合（逐个验证者试，第一个给出有效结果的就用）`);
    console.error(`  签名者 ${r.signers}/${r.quorum.registeredCount} 个`
      + `（${r.quorum.percent}%，门槛 ${r.quorum.quorumNum}%），bitset ${r.bitsetHex}`);
    if (r.signedBy) {
      console.error(`  签了      ${r.signedBy.join('  ')}`);
      console.error(`  没签      ${r.missing.join('  ') || '无（全员签名）'}`);
      console.error('  （身份由聚合签名验签定出，**不是**从 bitset 的位序推的 ——'
        + ' 位序推过两次，两次都错）');
    }
    console.error(`  消息 ${r.unsignedBytes} → ${r.signedBytes} 字节（多出 ${r.signedBytes - r.unsignedBytes}：bitset + 96 字节 BLS 聚合签名）`);
    for (const a of r.attempts.filter((x) => !x.ok)) console.error(`  （${a.node} 没给出结果：${a.error}）`);
    console.error('\n**停在这里。** 第三步要把这条已签名的消息提交到 P 链（RegisterL1ValidatorTx）——');
    console.error('  那一步**花钱**（持续费用），且成功之后若第四步失败，链上会留下');
    console.error('  「P 链认了、合约没认」的中间态。');
    console.error('\n  这一步不写链，所以它的产物不落盘 —— 第三步会重新聚合一次（成本是毫秒级）。');
    process.exit(EXIT_OK);
  }
  if (progress.step === 1) {
    // 第三步：P 链交易。**四步里唯一花钱、且做错要收拾的一步。**
    //
    // 先干跑（构造 + 算费，不提交），把费用打出来再问一次 —— 「它会花钱」
    // 和「它会花多少」是两句不同的话，而只有后者能让人做判断。
    const declared = joinedValidators(config.validators.nodes)
      .find((v) => v.identity.nodeId === nodeId);
    const accounts = readJson('blockchain/accounts/dev-accounts.json').accounts;
    const entry = accounts.find((a) => a.label === config.validators.ownerAccount);
    if (!entry) {
      console.error(`dev-accounts.json 里没有 label = ${config.validators.ownerAccount} 的账户`);
      process.exit(EXIT_PRECHECK);
    }

    const set = await readMemberSet({ client });
    let s2;
    try {
      s2 = await step2({
        config, identity, registrationMessageID: progress.registrationMessageID,
        registeredCount: set.members.length,
        members: memberCandidates({ config, memberSet: set }),
      });
    } catch (err) {
      console.error(`\n✗ 第三步需要第二步的聚合签名，而它失败了：${err.message}`);
      process.exit(EXIT_STEP_FAILED);
    }

    // 既有成员的续费地址 —— 新成员必须跟它一致（见 step3 里那条断言）
    const onP = await pchain('platform.getCurrentValidators', { subnetID: identity.subnetId });
    let expectedPAddress; let balance;
    try {
      ({ expectedPAddress, balance } = payerExpectation(onP.validators));
    } catch (err) {
      console.error(`\n✗ ${err.message}`);
      process.exit(EXIT_PRECHECK);
    }

    const args = {
      config, identity, signedMessage: s2.signedMessage,
      blsSignature: declared.identity.proofOfPossession,
      privateKeyHex: entry.privateKey,
      balance, expectedPAddress,
      pchainUri: `http://${primary.address}:${primary.httpPort}`,
    };

    let plan;
    try {
      plan = await step3({ ...args, dryRun: true });
    } catch (err) {
      console.error(`\n✗ 第三步的**构造**阶段失败（还没碰链）：${err.message}`);
      process.exit(EXIT_STEP_FAILED);
    }

    console.error('\n干跑（已构造、已算费，**尚未提交**）：');
    console.error(`  付款地址    ${plan.pAddress}（与既有成员的续费地址一致）`);
    console.error(`  给新成员    ${plan.balance} nAVAX = ${Number(plan.balance) / 1e9} AVAX（与既有成员相同）`);
    console.error(`  交易费      ${plan.fee} nAVAX = ${Number(plan.fee) / 1e9} AVAX`);
    console.error(`  动用 UTXO   ${plan.utxoCount} 个，花 ${plan.spent}、找零 ${plan.change}`);
    console.error(`  签名者      ${s2.signers}/${s2.quorum.registeredCount}（${s2.quorum.percent}%，门槛 ${s2.quorum.quorumNum}%）`);
    if (s2.signedBy) {
      console.error(`  签了        ${s2.signedBy.join('  ')}`);
      console.error(`  没签        ${s2.missing.join('  ') || '无（全员签名）'}`);
    }
    console.error('\n**提交之后**：成员进入 P 链的权益集合。若随后第四步失败，');
    console.error('  链上会是「P 链认了、合约没认」—— 可用 resendRegisterValidatorMessage 重试，');
    console.error('  而本命令再跑一次会准确报出"停在第四步"。');

    if (!autoYes && !(await ask('\n**提交这笔 P 链交易？**'))) {
      console.error('已中止 —— 只做了构造与算费，链未改动。');
      process.exit(EXIT_ABORTED);
    }

    let r;
    try {
      r = await step3(args);
    } catch (err) {
      console.error(`\n✗ 第三步失败：${err.message}`);
      console.error('  若失败发生在**提交**阶段，去 P 链核一下这个 nodeID 有没有被收录：');
      console.error('  再跑一次本命令，它会从链上读出真实进度。');
      process.exit(EXIT_STEP_FAILED);
    }

    console.error('\n✅ 第三步完成');
    console.error(`  P 链交易    ${r.txId}`);
    console.error(`  花费        balance ${r.balance} + 手续费 ${r.fee} nAVAX`);
    console.error('\n**停在这里。** 第四步要把 P 链发回的确认消息交给合约');
    console.error('  （completeValidatorRegistration）—— 那条消息要由**两个 Primary**签名。');
    console.error('  再跑一次本命令即可继续。');
    process.exit(EXIT_OK);
  }
  console.error(`\n第 ${progress.step + 1} 步的实现尚未落地（T027 进行中）。`);
  console.error('这条路径刻意不"先跑起来再说"：写链的代码没有经过变红检查之前，'
    + '不该有机会真的发出交易。');
  process.exit(EXIT_STEP_FAILED);
}
