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
import { loadProtocol, readJson, REPO_ROOT, deriveTopology } from '../protocol/load.mjs';
import {
  identityOf, joinedValidators, nodeIdToBytes, cb58Encode,
} from '../verify/lib/identity.mjs';
import {
  VALIDATOR_MANAGER_ABI, PROXY_ADDRESS, TOPICS, STATUS,
  readMemberSet, classifyDrift, nodeIdFromBytes20, readPChainMembers, classifyPChainDrift,
} from './member-set.mjs';
// 容错算术在 tolerance.mjs —— 加与退用同一套，两份会各自漂移（见那个文件顶部）
import { toleranceChange, toleranceAfterAdd } from './tolerance.mjs';

// 退出码在 exit-codes.mjs —— 加入、退出、只读报告三个工具共用一套。
// 各挑各的号会让"退出码 12"在一处是"节点数据不属于这条链"、在另一处是"P 链交易失败"。
export { EXIT_OK, EXIT_PRECHECK, EXIT_STEP_FAILED, EXIT_ABORTED } from './exit-codes.mjs';
import { EXIT_OK, EXIT_PRECHECK, EXIT_STEP_FAILED, EXIT_ABORTED } from './exit-codes.mjs';
import { ask } from './ask.mjs';
import { assertChainReachable, reportUnexpected } from './cli-failure.mjs';

// 这四样搬到了 pchain-verification-set.mjs —— **加入与退出都要用它们**
//（研究 V-34：落后一格的那个验证集合，两个方向各撞过一次）。
// 这里再导出，既有的导入路径与测试因此不变。
export {
  BASE_QUORUM_NUM, parseInsufficientWeight, quorumForChainTotal,
  readVerificationWeights, nudgePChainHeight,
} from './pchain-verification-set.mjs';
import {
  BASE_QUORUM_NUM, parseInsufficientWeight, quorumForChainTotal,
  readVerificationWeights, nudgePChainHeight,
} from './pchain-verification-set.mjs';



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
  //
  // **已经被退掉的那次注册不算。** 事件是**追加**的：一个成员加入、退出、再加入，
  // 历史里会留下两条 InitiatedValidatorRegistration，而第一条对应的 validationID
  // 早已走完退出。取到旧那条的后果不是报错，是**报出一个错的进度**：
  //
  //   2026-09-19（T034）实测：l1-2 退完之后再加，工具报"已完成 1/4 步"并直接去发
  //   第三步，而那条注册消息 11 小时前就过期了 ——
  //   `warp message expired at 1789747643 and it is currently 1789787980`。
  //   真实进度是 **0/4**：那一轮的第一步压根还没做。
  //
  // 判据取自链上：validationID 有过 CompletedValidatorRemoval 的，那一轮已经结束。
  // 与 classifyDrift 里"退出已经走完"用的是同一条证据（member-set.mjs）。
  const set = await readMemberSet({ client });
  const removed = new Set(set.history
    .filter((h) => h.eventName === 'CompletedValidatorRemoval' && h.validationID)
    .map((h) => String(h.validationID).toLowerCase()));
  const initiated = [...set.history]
    .reverse()          // 最近的那一轮优先 —— 同一个 nodeID 可能注册过多次
    .find((h) => h.eventName === 'InitiatedValidatorRegistration'
      && h.nodeId === nodeId
      && !removed.has(String(h.validationID ?? '').toLowerCase()));
  if (!initiated) {
    const everHad = set.history.some(
      (h) => h.eventName === 'InitiatedValidatorRegistration' && h.nodeId === nodeId,
    );
    return {
      step: 0,
      nodeId,
      validationID: null,
      notes: [everHad
        ? '合约上这个 nodeID **此前的注册已经走完退出**，本轮还没发起 —— 从第一步开始'
        : '合约上没有这个 nodeID 的注册记录'],
    };
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
 * 问**某个节点自己**要它那条链的创世区块哈希与 chainId（FR-014 用）。
 *
 * 走那台机器的 `/ext/bc/<blockchainId>/rpc`，不经集群入口 —— 经入口问到的是
 * 集群的答案，而这里要判断的恰恰是"这一台是不是跑在同一条链上"。
 *
 * 失败一律归到 `error`，由调用方决定怎么处置；本函数不抛。
 */
export async function readNodeGenesis({ node, blockchainId, fetchImpl = fetch, timeoutMs = 8000 }) {
  const url = `http://${node.address}:${node.httpPort}/ext/bc/${blockchainId}/rpc`;
  const call = async (method, params) => {
    const r = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j.error) throw new Error(j.error.message ?? String(j.error));
    return j.result;
  };
  try {
    const block0 = await call('eth_getBlockByNumber', ['0x0', false]);
    const chainId = await call('eth_chainId', []);
    if (!block0?.hash) throw new Error('eth_getBlockByNumber(0) 没有返回区块哈希');
    return { genesisHash: block0.hash, chainId: Number(chainId), error: null };
  } catch (err) {
    return { genesisHash: null, chainId: null, error: err.message };
  }
}

/**
 * 注册一个成员需要的**公开材料**，两个来源统一在这里（功能 005 / T033 实施期补）。
 *
 * ## 为什么需要第二个来源
 *
 * 加入流程当初只认**一个**来源：声明里 `origin=joined` 的那种成员（T069 的路子）。
 * 那对"从未是成员的新机器"是对的，但它处理不了另一种真实情形：
 *
 *   **把一个被退掉的创世验证者加回来。**
 *
 * 创世那批（l1-1…l1-5）在声明里**没有 `identity` 块** —— 它们的身份从
 * `keyDir` 里的密钥派生。于是 2026-09-17 把 l1-2 退掉之后再想加回来，
 * 前置检查报的是「声明里没有 origin=joined 的 …」，
 * 建议去 `gen-node-keys.sh` 生成材料 —— **而那会给它换一个新身份**，
 * 那不是"加回来"，是"换一台新的进来"。
 *
 * 材料本来就在仓库里：建链制品 `chain-identity.bootstrapValidators[]`
 * 带着创世那批的 `blsPublicKey` 与 `blsProofOfPossession`。
 * 缺的只是"去那儿看一眼"。
 *
 * @returns {{source: 'declaration'|'genesis-bootstrap', blsPublicKey: string,
 *            proofOfPossession: string}|null} 找不到返回 `null`
 */
export function publicMaterialFor({ nodeId, config, chainIdentity }) {
  // ① 声明里显式报过公开材料的（创世后加入的成员）
  const joined = joinedValidators(config.validators.nodes)
    .find((x) => x.identity.nodeId === nodeId);
  if (joined) {
    return {
      source: 'declaration',
      blsPublicKey: joined.identity.blsPublicKey,
      proofOfPossession: joined.identity.proofOfPossession,
    };
  }
  // ② 创世那批 —— 身份从密钥派生，公开材料在建链制品里
  const boot = (chainIdentity?.bootstrapValidators ?? []).find((x) => x.nodeId === nodeId);
  if (boot?.blsPublicKey && boot?.blsProofOfPossession) {
    return {
      source: 'genesis-bootstrap',
      blsPublicKey: boot.blsPublicKey,
      proofOfPossession: boot.blsProofOfPossession,
    };
  }
  return null;
}

/**
 * 前置检查（FR-013 / FR-014 / FR-015）。任一不过则**拦下且不动链**。
 *
 * 刻意在动链之前全部查完，而不是边做边查 —— 走到一半才发现拦不住的问题，
 * 留下的是一个需要人工收拾的中间态。
 */
export async function precheck({
  client, pchain, nodeId, config, subnetId, blockchainId, genesisHash, chainIdentity,
  fetchImpl = fetch,
}) {
  // **subnetId 必填。** 第一版漏了它：函数体里引用 `subnetId` 抛 ReferenceError，
  // 而那句话在 try 里，被当成"读不到 P 链"吞掉 —— 第二个事实来源**静默消失**，
  // 前置检查照样报"全部通过"。漏参数的代价不该是少一整个来源。
  if (!subnetId) {
    throw new Error('precheck 需要 subnetId —— 少了它读不到 P 链侧那个事实来源，'
      + '而「别的成员卡在第四步」只有那一侧看得见');
  }
  // blockchainId / genesisHash 同样必填 —— 少了它们 FR-014 那条检查会**静默消失**，
  // 而前置检查照样报"全部通过"。这正是 subnetId 那次的教训，不重犯第二遍。
  if (!chainIdentity) {
    throw new Error('precheck 需要 chainIdentity —— 少了它，创世那批验证者的公开材料'
      + '（bootstrapValidators）这个来源会静默消失，于是"把退掉的创世成员加回来"'
      + '会被误报成"声明里没有这一项"');
  }
  if (!blockchainId || !genesisHash) {
    throw new Error('precheck 需要 blockchainId 与 genesisHash —— 少了它们就核对不了'
      + '新节点跑的是不是同一条链（FR-014），而"没核对"不该长得像"核对通过"');
  }
  const problems = [];
  const d = deriveTopology(config);

  // ── 必须能拿到这个成员的公开材料（两个来源，见 publicMaterialFor）─────────
  const material = publicMaterialFor({ nodeId, config, chainIdentity });
  if (!material) {
    problems.push(`拿不到 ${nodeId} 的公开材料 —— 两个来源都没有它：`
      + ' 声明里没有 origin=joined 的这一项，建链制品的 bootstrapValidators 里也没有。'
      + ' 若这是一台新机器，先在**那台机器上**跑 tools/membership/gen-node-keys.sh，'
      + ' 把它输出的 identity 块贴进 blockchain/deployment.json 的 validators.nodes[]。');
  }

  // ── T-5：每个故障边界的验证者数不得超过 ⌊n/4⌋（FR-013）──────────────────
  if (!d.faultTolerance.declaredWithinLimit && d.faultTolerance.domainCount > 1) {
    problems.push('声明的拓扑违反 T-5（某个故障边界的验证者数超过 ⌊n/4⌋）—— '
      + '先跑 node tools/protocol/validate-topology.mjs 看是哪个边界');
  }

  // ── 恢复能力：两个 Primary 都必须在线（FR-015）────────────────────────────
  //
  // 不是"最好在线"。但**理由不是第四步的签名** —— 那条我判断错过：
  // 链配置里有 requirePrimaryNetworkSigners=true，研究 V-32 据此断定确认消息要由
  // 两个 Primary 签。实测（2026-09-16）证伪：节点 debug 日志里的
  // `signature weight is insufficient: 67*600 > 100*200` 表明验证用的是
  // **L1 自己的验证者集合**（总权重 600），Primary 的签名在那里折算不出权重。
  //
  // 两个 Primary 仍然必须在线，理由是 004 的 V-08：P 链引导要求连上 ≥ 80% 权益，
  // 而它们各握 50% —— 少一个，新成员就引导不起来，第三步的 P 链交易也没人处理。
  const reachable = async (n) => {
    try {
      const r = await fetchImpl(`http://${n.address}:${n.httpPort}/ext/info`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"jsonrpc":"2.0","id":1,"method":"info.getNodeID","params":[]}',
        signal: AbortSignal.timeout(5000),
      });
      return r.ok;
    } catch { return false; }
  };

  const primaries = d.topologyNodes.filter((n) => n.role === 'primary');
  const offline = [];
  for (const n of primaries) {
    if (!(await reachable(n))) offline.push(n.id);
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

  // ── 注册这一下会不会把链推过容错上限（FR-037 / F-5）──────────────────────
  //
  // 加成员会让容错的**分母**涨，而 ⌊n/4⌋ 常常不跟着涨（5→6→7 都是 1）。
  // 于是"加一个成员"这个动作本身能把一条正在出块的链停掉。
  // 2026-09-15 停电后就差一步：链上 5 个、win-2 离线（正好到上限），
  // 而新成员所在的 ubuntu-4 也断着电 —— 注册完会是 6 个里离线 2 个。
  const l1s = d.topologyNodes.filter((n) => n.role === 'l1-validator');
  const byKeyDir = new Map(config.validators.nodes.map((v) => [v.keyDir, v]));
  const nodeOf = new Map();          // 链上成员的 nodeId → 拓扑节点
  let newMemberNode = null;
  for (const n of l1s) {
    const v = byKeyDir.get(n.keyDir);
    if (!v) continue;
    let id;
    try { id = identityOf(v); } catch { continue; }
    if (id.nodeId === nodeId) newMemberNode = n;
    nodeOf.set(id.nodeId, n);
  }

  // 只探链上成员 + 新成员，不探全部 —— 未注册的其它声明成员与容错无关
  const toProbe = [...new Set(set.members.map((m) => m.nodeId).filter((x) => nodeOf.has(x)))];
  const memberOffline = [];
  for (const id of toProbe) {
    const n = nodeOf.get(id);
    if (!(await reachable(n))) memberOffline.push(n.id);
  }
  // 认不出是谁的链上成员（nodeID 未知）无法探测 —— 当作**未知**而不是在线，
  // 否则一个认不出的缺席成员会让这条判断给出偏乐观的结论。
  const unidentified = set.members.filter((m) => !m.nodeId || !nodeOf.has(m.nodeId)).length;

  const newMemberOnline = newMemberNode ? await reachable(newMemberNode) : false;
  const tol = toleranceAfterAdd({
    membersBefore: set.members.length,
    offlineIds: memberOffline,
    newMemberOnline,
  });

  if (!newMemberNode) {
    problems.push(`拓扑里找不到 ${nodeId} 对应的节点 —— 声明写了验证者但没写进 topology.nodes`);
  } else if (tol.newMemberOffline) {
    problems.push(`新成员 ${newMemberNode.id}（${newMemberNode.domain} / ${newMemberNode.address}）`
      + '**不应答** —— 先把那台机器和它的容器起来。'
      + '注册一个没起来的成员，它从注册的那一刻就是个缺席成员：'
      + '既拖低在线权重，又没法引导（引导要连上 ≥ 75% 的权重）。');
  }

  // ── FR-014：新节点跑的必须是**同一条链** ──────────────────────────────────
  //
  // 这条此前只写在函数头的注释里（"FR-013 / FR-014 / FR-015"），而实现里根本没有 ——
  // 一条声称存在的判定不存在，比没有声称更坏：读注释的人以为已经守住了。
  //
  // 问的是新节点**自己**，不是集群入口：集群入口一定答得对，那证明不了任何事。
  // 比两样东西，都来自那台机器上真正初始化出来的链：
  //   ① 创世区块哈希 —— 创世文件差一个字节就变，对应 stamp 六项里的 genesisBlockHash
  //   ② eth_chainId —— 哈希相同而 chainId 不同在理论上不可能，但两个都读一次近乎免费
  //
  // 读不到也拦。"没核对"不是"核对通过"：读不到的常见成因恰恰是那台机器根本没在
  // track 这个 subnet，或者链还没初始化 —— 两种都不该让它进集合。
  if (newMemberNode && !tol.newMemberOffline) {
    const g = await readNodeGenesis({ node: newMemberNode, blockchainId, fetchImpl });
    if (g.error) {
      problems.push(`读不到 ${newMemberNode.id} 上那条链的创世信息（${g.error}）——`
        + ' **不核对就不注册**（FR-014）。常见成因：那台机器没有 track 这个 subnet，'
        + ' 或者链还没在它上面初始化完。先确认它的 flags 里有本链的 track-subnets 与链配置。');
    } else if (g.genesisHash !== genesisHash) {
      problems.push(`${newMemberNode.id} 的创世区块哈希是 ${g.genesisHash}，基准是 ${genesisHash}`
        + ' —— **它跑的是另一条链**，不得进入集合（FR-014）。');
    } else if (g.chainId !== config.chain.chainId) {
      problems.push(`${newMemberNode.id} 报的 chainId 是 ${g.chainId}，本链是 ${config.chain.chainId}`
        + ' —— 创世哈希相同而 chainId 不同，说明读到的不是本链（FR-014）。');
    }
  }

  if (tol.wouldStopChain) {
    problems.push(`**注册这一下会让链停止出块。** 现在链上 ${tol.before.n} 个成员、`
      + `离线 ${tol.before.offline} 个（${tol.offlineIds.join('、') || '无'}），上限 ${tol.before.f} —— 在容错内。`
      + ` 注册后 n = ${tol.after.n}，而上限**仍是** ${tol.after.f}（⌊n/4⌋ 不跟着涨，见 F-5），`
      + `离线会变成 ${tol.after.offline} 个 > ${tol.after.f}。`
      + ' 先把离线的机器弄回来再注册 —— 停摆的原因会是这次注册，不是故障。');
  }
  if (unidentified) {
    problems.push(`链上有 ${unidentified} 个成员认不出是谁（nodeID 未知或不在拓扑里）——`
      + ' 探测不到它们在不在线，容错判断就不可靠。先跑 npm run membership:status 看清楚。');
  }

  // ── 其它漂移要先说清（不阻断，但必须看见）────────────────────────────────
  const drift = classifyDrift(set.members, config.validators.nodes, set.history);
  const others = drift.drifts.filter((x) => x.nodeId !== nodeId);

  // ── 第二个事实来源：合约侧 vs P 链侧（T070）──────────────────────────────
  //
  // 为什么注册之前要看这个：如果**别的**成员正卡在第四步，那它在 P 链上带着权重、
  // 在合约侧却不算成员。此时两侧的成员数不同，而容错该按 P 链算 ——
  // 不看这一侧就等于按一个偏小的 n 去判断"注册会不会把链停掉"。
  //
  // 读不到时如实标记，不静默当作"没问题"。
  let split = null;
  let splitError = null;
  try {
    const pset = await readPChainMembers({ pchain, subnetId });
    split = classifyPChainDrift({ contractMembers: set.members, pchainMembers: pset.members });
  } catch (err) {
    splitError = err.message;
  }
  // 本次要注册的这个成员出现在 P 链侧、合约侧还没有，是**正常的中间态**
  //（第三步做完、第四步没做完），不该算进"别人的问题"里。
  const otherSplits = (split?.splits ?? []).filter((s) => s.nodeId !== nodeId);

  return {
    ok: problems.length === 0,
    problems,
    otherDrifts: others,
    tolerance: tol,
    split,
    splitError,
    otherSplits,
  };
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
export async function step1Inputs({ client, pchain, nodeId, config, subnetId, chainIdentity }) {
  // 两个来源（见 publicMaterialFor）：声明里 origin=joined 的，或创世那批。
  // 把一个被退掉的**创世**验证者加回来时走的是后者。
  const material = publicMaterialFor({ nodeId, config, chainIdentity });
  if (!material) throw new Error(`拿不到 ${nodeId} 的公开材料（声明与建链制品里都没有）`);

  // 20 字节 nodeID：cb58Decode 会验 4 字节校验和与 20 字节长度
  const nodeIdBytes = `0x${nodeIdToBytes(nodeId).toString('hex')}`;
  const blsPublicKey = material.blsPublicKey;

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
export async function step1({
  client, pchain, nodeId, config, subnetId, ownerAccount, chainIdentity,
}) {
  const inputs = await step1Inputs({ client, pchain, nodeId, config, subnetId, chainIdentity });

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
 * ## 加入与退出共用这一步
 *
 * 参数叫 `messageID` 而不是 `registrationMessageID`：**退出的第二步是同一件事** ——
 * 拿一条链上的 Warp 消息去收集 L1 验证者的签名。加入时那条消息来自
 * `InitiatedValidatorRegistration.registrationMessageID`，退出时来自
 * `InitiatedValidatorRemoval.validatorWeightMessageID`。
 * 名字若绑在"注册"上，退出那边就会出现第二份同样的实现。
 *
 * @param {string} messageID 链上那条 Warp 消息的 ID（合约事件给出，bytes32 或 CB58）
 * @param {number} quorumNum 权重门槛的分子，取自链配置的 `quorumNumerator`（实测 67）
 */


export async function step2({
  config, identity, messageID, registeredCount,
  // 超时从 45 秒收到 12 秒：实测成功的调用是 **0.05–2 秒**，45 秒只会让
  // 一个坏节点把整轮拖死（4 轮 × 6 节点最坏要几分钟）。
  quorumNum = 67, timeoutMs = 12_000, rounds = 4, delayMs = 4_000,
  // 给了就能报出**是哪几个没签**（见 identifySigners）；不给只报个数。
  members = null,
}) {
  if (!registeredCount) throw new Error('step2 需要 registeredCount（链上注册的成员数）来折算权重占比');
  const d = deriveTopology(config);
  const validators = d.topologyNodes.filter((n) => n.role === 'l1-validator');
  const messageId = messageIdToCb58(messageID);
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
export function payerExpectation(validators, { initialBalances } = {}) {
  const list = validators ?? [];
  if (!list.length) {
    throw new Error('P 链上这条 subnet 没有任何既有成员 —— 推不出新成员该用的续费地址与余额。'
      + ' 第一个成员的这两个值要由人来定，本工具不猜。');
  }

  // 地址必须唯一 —— 这是**真不变量**：谁替这批成员付持续费用，只能有一个答案。
  // 出现两个说明这套成员集合已经不同质了，"新成员该跟谁一致"要人来定。
  const owners = new Set(list.flatMap((v) => v.remainingBalanceOwner?.addresses ?? []));
  if (owners.size !== 1) {
    throw new Error(`既有成员的续费地址不唯一（${owners.size} 个）`
      + ' —— 新成员该跟谁一致需要人来定，本工具不猜。');
  }

  // 余额**不能**这样比。
  //
  // 第一版要求既有成员的**当前余额**也唯一，那是拿当前余额去代替"初始押金" ——
  // 而当前余额必然分化：成员按各自加入的时长持续扣费。
  // 注册 l1-6 那次五个创世成员同龄、余额相同，检查侥幸通过；
  // **2026-09-17 第二次加入（把 l1-2 加回来）时它就永久触发了** ——
  // 那时 l1-6 的余额与创世那批已经不同。
  // 这是一个**只在"第二次加入"才会显形**的缺陷。
  //
  // 正确的不变量是「每个成员的**初始押金**相同」，而初始押金是**声明值**：
  // 建链制品 chain-identity.bootstrapValidators[].balance（本仓库为 100000000）。
  // 用它，每个成员的初始押金由构造保证相同 —— 那才是原检查想抓的东西。
  // **先滤空再转字符串。** 反过来写会把 `null` 变成字符串 `"null"`（真值），
  // 于是它通过过滤、一路走到 `BigInt("null")` 才抛 —— 报出来是
  // `Cannot convert null to a BigInt`，看不出根因是"声明里有一项是空的"。
  const declared = new Set(
    (initialBalances ?? [])
      .filter((b) => b !== null && b !== undefined && b !== '')
      .map(String),
  );
  if (declared.size !== 1) {
    throw new Error(`拿不到唯一的初始押金（声明里有 ${declared.size} 种取值）`
      + ' —— 它来自建链制品的 bootstrapValidators[].balance。'
      + ' 不唯一或缺失时不猜：新成员该存多少要人来定。');
  }
  return { expectedPAddress: [...owners][0], balance: BigInt([...declared][0]) };
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




/**
 * subnet-evm 的 Warp 预编译地址。
 *
 * 这是 **subnet-evm 的协议常量**（激活的预编译落在固定地址上），不是本部署的取值 ——
 * 和 PROXY_ADDRESS 一样属于"链上摆在那儿的东西"，没有第二个来源可以推导。
 */
export const WARP_PRECOMPILE_ADDRESS = '0x0200000000000000000000000000000000000005';

/**
 * P 链发回的**注册确认消息**（第四步的输入）。
 *
 * ## 结构是实测逼出来的，不是照着规范猜的
 *
 * 第一版把 `L1ValidatorRegistration`（typeID 2）直接当作 Warp 消息的 payload。
 * 两个 Primary 都拒签，回的是同一句：
 *
 *   `failed to parse warp addressed call: couldn't unmarshal interface: unknown type ID 2`
 *
 * 也就是说 P 链用 `warp/payload` 那套编解码器解析 payload，而那里只注册了
 * `Hash(0)` 与 `AddressedCall(1)` —— ACP-77 的消息必须**包在 AddressedCall 里**。
 * 与第一步那条入站消息同构（AddressedCall(1) 套 RegisterL1Validator(1)），
 * 区别只是 P 链没有源地址，所以地址长度为 0。
 *
 * 实测尺寸：内层 39 字节 → AddressedCall 53 字节 → 整条 95 字节。
 * 拿这三个数当断言，比"按规范应该是这样"可靠。
 *
 * @param {{validationID: string, networkId: number, registered?: boolean}} args
 * @returns {string} 0x 前缀的未签名 Warp 消息
 */
export function registrationConfirmationMessage({ validationID, networkId, registered = true }) {
  const vid = Buffer.from(validationID.replace(/^0x/, ''), 'hex');
  if (vid.length !== 32) throw new Error(`validationID 是 ${vid.length} 字节，应当是 32 字节`);
  if (!Number.isInteger(networkId) || networkId <= 0) {
    throw new Error(`networkId 不是正整数：${networkId}`);
  }

  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const CODEC = Buffer.from([0, 0]);

  // 内层：L1ValidatorRegistration（ACP-77 消息命名空间的 typeID 2）
  const inner = Buffer.concat([CODEC, u32(2), vid, Buffer.from([registered ? 1 : 0])]);

  // AddressedCall（warp/payload 的 typeID 1）。P 链没有源地址 → 长度 0
  const addressedCall = Buffer.concat([CODEC, u32(1), u32(0), u32(inner.length), inner]);

  // 未签名消息：codec + networkID + sourceChainID + payload
  // sourceChainID 是 P 链的 blockchainID，解码后正是 **32 个零字节**
  const unsigned = Buffer.concat([
    CODEC, u32(networkId), Buffer.alloc(32), u32(addressedCall.length), addressedCall,
  ]);

  // 三个尺寸都是实测值。对不上说明布局理解变了，**那时不要继续**：
  // 带着结构不对的消息去要签名，Primary 只会拒签，而拒签的理由要翻它们的日志才看得到。
  if (inner.length !== 39 || addressedCall.length !== 53 || unsigned.length !== 95) {
    throw new Error(`消息尺寸与实测不符：内层 ${inner.length}（期望 39）、`
      + `AddressedCall ${addressedCall.length}（期望 53）、整条 ${unsigned.length}（期望 95）`);
  }
  return `0x${unsigned.toString('hex')}`;
}

/**
 * 向签名聚合器要 P 链确认消息的签名。
 *
 * ## 签名者是 **L1 自己的验证者**，不是 Primary —— 这一条我判断错过
 *
 * 链配置里有 `requirePrimaryNetworkSigners: true`，研究 V-32 据此断定
 * 「第四步的确认消息要由两个 Primary 签名」。我照这个做了，收齐了两个 Primary
 * 的签名（100% 的 Primary 权重），**交易照样 revert**。
 *
 * 节点日志把话说死了（2026-09-16，l1-1 开 debug 后抓到）：
 *
 *   `failed to verify warp signature`
 *   `err="signature weight is insufficient: 67*600 > 100*200"`
 *
 * `totalWeight = 600` —— 那是 **L1 自己六个验证者**的总权重（每个 100，
 * 含第三步刚进 P 链的 l1-6）。也就是说验证用的是 L1 的集合，
 * 而两个 Primary 的签名在这个集合里只折算出 200。
 *
 * 所以门槛是 **67% × 600 = 402**，需要六个里至少 5 个签。实测 5/6 = 83% 通过。
 *
 * **教训**：`requirePrimaryNetworkSigners` 这个名字与它在本链上的实际效果不一致，
 * 而我从名字推出了签名者是谁。权重那句报错是唯一说得清的证据，
 * 它只在节点的 **debug** 日志里 —— info 级下这一步失败是完全静默的。
 *
 * ## 为什么非要一个外部进程
 *
 * 收签名**没有 HTTP 路可走**（2026-09-16 逐个实测）：L1 节点的
 * `warp_getMessageAggregateSignature` 只能聚合它自己库里有的消息（`not found`），
 * P 链的 `platform.*` 没有对应方法，avalanchego 级端点全是 404。
 * 签名请求只走 P2P。见 docker/aggregator/。
 *
 * @param {string} signingSubnetId 由**哪个集合**签。本链的 subnetID —— 见上面那段。
 */
/**
 * @param {string|null} justification 只有**否定性**断言需要它。
 *   `registered: true` 节点能从 P 链状态直接读出，不需要；
 *   `registered: false` 读不出来 —— 节点无法区分"被摘除了"与"从来没有过"，
 *   所以要额外材料说明"它本来是什么"。缺了就回
 *   `invalid justification type: <nil>`（2026-09-16 实测）。
 *   构造见 remove-validator.mjs 的 removalJustification。
 */
/**
 * 聚合器**连上了签名集合多少权重** —— 这才是"可用了没有"的判据。
 *
 * ## `/health` 说 up 的时候，它可能一个验证者都没连上
 *
 * 2026-09-19 实测（研究 V-48）：重启聚合器后 13 秒就用它 →
 * `accumulatedWeight: 0`、`Failed to connect to a threshold of stake`，
 * 而同一时刻 `curl /health` **已经是** `{"status":"up"}`。等约 90 秒后同一条命令就过了。
 *
 * **`up` 只说进程活着**：它还要先与两个 Primary 握手、再经 gossip 学到各 L1 验证者的
 * IP 声明，才谈得上收签名。而文档当时只教人 `curl /health` 必须是 up ——
 * 一个恒真的就绪信号，等于没有就绪信号。
 *
 * 真正可判的数在它自己的指标里（端口 8647，与 API 的 8646 同主机）：
 *
 *   signature_aggregator_connected_stake_weight_percentage{subnetID="…"} 100
 *
 * 刚起来时是 0，连齐了是 100。**低于门槛就收不齐签名**，与网络配置无关。
 *
 * 读不到时返回 `null` —— **"没读到"与"是 0"是两件事**，不得混淆
 *（指标端口可能没发布，或它在别的机器上）。
 */
export async function aggregatorConnectedStake({
  aggregatorUrl, subnetId = null, fetchImpl = fetch, timeoutMs = 5000,
}) {
  const base = String(aggregatorUrl).replace(/\/$/, '').replace(/:\d+$/, '');
  try {
    const r = await fetchImpl(`${base}:8647/metrics`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const rows = (await r.text()).split('\n')
      .filter((l) => l.startsWith('signature_aggregator_connected_stake_weight_percentage'));
    if (!rows.length) return null;
    // 有 subnetId 就取那一条；没有就取第一条
    const row = (subnetId && rows.find((l) => l.includes(subnetId))) || rows[0];
    const pct = Number(row.trim().split(/\s+/).pop());
    return Number.isFinite(pct) ? pct : null;
  } catch {
    return null;
  }
}

export async function aggregateConfirmationSignatures({
  aggregatorUrl, unsignedMessage, signingSubnetId, justification = null,
  quorumPercentage = 67, timeoutMs = 90_000,
}) {
  if (!signingSubnetId) {
    throw new Error('aggregateConfirmationSignatures 需要 signingSubnetId'
      + ' —— 由哪个验证者集合签是这一步的关键，不能靠默认值'
      + '（按 Primary Network 要签名会收齐 100% 的 Primary 权重，而合约那边照样判不过）。');
  }
  let r;
  try {
    r = await fetch(`${aggregatorUrl.replace(/\/$/, '')}/aggregate-signatures`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: unsignedMessage.replace(/^0x/, ''),
        'signing-subnet-id': signingSubnetId,
        'quorum-percentage': quorumPercentage,
        // 只在真有 justification 时带上这个字段。传 null 会让聚合器把它当成
        // "给了一个空的 justification"，而节点对空值与缺字段的回答不同
        // （前者 proto 解析失败，后者 `invalid justification type: <nil>`）。
        ...(justification ? { justification: justification.replace(/^0x/, '') } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`连不上签名聚合器 ${aggregatorUrl}：${err.message}。`
      + ' 它是按需起的，没在跑就先起来：见 docker/aggregator/entrypoint.sh 顶部的用法。');
  }
  const body = await r.json();
  if (body.error) {
    // **先问聚合器它自己连上了多少** —— 那一个数能把两种完全不同的成因分开：
    //「它刚起来还没连上」与「某个验证者不签」。此前这条消息只会把人指向
    // allow-private-ips，而 2026-09-19 那次的真因是**起来才 13 秒**（研究 V-48）。
    const pct = await aggregatorConnectedStake({
      aggregatorUrl, subnetId: signingSubnetId,
    });
    const reach = pct === null
      ? '  （读不到聚合器的连通性指标 —— 端口 8647 没发布，或它在别的机器上）'
      : `  **此刻它连上了签名集合 ${pct}% 的权重**（门槛 ${quorumPercentage}%）。`
        + (pct < quorumPercentage
          ? '\n  低于门槛 —— **它多半是刚起来还没连上**：要先与两个 Primary 握手、'
            + '再经 gossip 学到各验证者的 IP 声明，实测约需 60–90 秒。等一会儿重跑。'
            + '\n  若长期停在 0，那才去查 allow-private-ips。'
          : '\n  已达门槛 —— 那问题不在连通性，而在某个验证者不签'
            + '（它自己能签、HTTP 也通，但别人经 P2P 要不到 —— 实测修法是'
            + ' up -d --force-recreate 重建那个容器）。');
    throw new Error(`聚合器没能收齐签名：${body.error}\n`
      + '  签名者是 **L1 自己的验证者**（见本函数顶部那段），等权 n 个、门槛 67%。\n'
      + reach);
  }
  const signed = body['signed-message'];
  if (!signed) {
    throw new Error(`聚合器的回包里没有 signed-message：${JSON.stringify(body).slice(0, 200)}`);
  }
  return `0x${signed.replace(/^0x/, '')}`;
}

/**
 * 把签名后的 Warp 消息编码成 access list 的 storage key（subnet-evm 的**谓词**）。
 *
 * 消息不是普通参数 —— `completeValidatorRegistration(uint32)` 收的是**下标**，
 * 消息本身通过交易的 access list 交给 Warp 预编译。编码规则：
 * 追加一个 `0xff` 分隔符，右补零到 32 的整数倍，再切成 32 字节一段。
 *
 * 分隔符不可省：补的零与消息末尾的零无法区分，没有它就不知道消息到哪儿结束。
 */
export function packWarpPredicate(signedMessageHex) {
  const raw = Buffer.from(signedMessageHex.replace(/^0x/, ''), 'hex');
  if (!raw.length) throw new Error('packWarpPredicate: 消息是空的');
  const withDelimiter = Buffer.concat([raw, Buffer.from([0xff])]);
  const padded = Buffer.alloc(Math.ceil(withDelimiter.length / 32) * 32);
  withDelimiter.copy(padded);
  const keys = [];
  for (let i = 0; i < padded.length; i += 32) {
    keys.push(`0x${padded.subarray(i, i + 32).toString('hex')}`);
  }
  return keys;
}

/**
 * 第四步：把 P 链的确认消息交给合约（`completeValidatorRegistration`）。
 *
 * ## 它比第三步安全，但不是没有代价
 *
 * 这一步是**合约交易**：失败就是回滚，链上不留新的中间态。真正的风险在它**之前** ——
 * 第三步做完而这一步没做完时，链上是「P 链认了、合约没认」。本步就是去消掉那个状态。
 * 失败可以直接重试；消息还能重新聚合（聚合不写链），也可以用
 * `resendRegisterValidatorMessage` 让合约重发第一步那条消息。
 *
 * `dryRun` 只做模拟（`simulateContract`），不发交易 —— 于是"会不会 revert"
 * 可以在批准之前知道。
 */
export async function step4({
  client, validationID, networkId, subnetId, aggregatorUrl, ownerAccount, dryRun = false,
}) {
  const unsignedMessage = registrationConfirmationMessage({ validationID, networkId });
  const signedMessage = await aggregateConfirmationSignatures({
    aggregatorUrl, unsignedMessage, signingSubnetId: subnetId,
  });
  const counted = countSigners(signedMessage, unsignedMessage);
  const storageKeys = packWarpPredicate(signedMessage);

  const accessList = [{ address: WARP_PRECOMPILE_ADDRESS, storageKeys }];
  const plan = {
    unsignedBytes: (unsignedMessage.length - 2) / 2,
    signedBytes: (signedMessage.length - 2) / 2,
    signers: counted.signers,
    bitsetHex: counted.bitsetHex,
    storageKeys: storageKeys.length,
    signedMessage,
  };

  // 模拟只能排除**一部分**失败，不能证明会成功。
  //
  // 2026-09-16 实测：模拟通过，真实交易照样 revert。追踪那笔失败交易看到，
  // 合约 STATICCALL Warp 预编译拿回的是 `valid = false` —— 也就是**谓词验证没过**。
  // 而 `eth_call` 会自行为这次调用准备谓词结果，真实出块时则要按区块的
  // P 链高度去验签名，两条路不是同一件事。
  //
  // 更坏的是那次模拟还跑在一个**落后两个块**的节点上（本机代理指向的 l1-1 卡在 991，
  // 其余五个已到 993）—— 于是"模拟通过"同时踩了两个坑。
  // 所以这里**不说**"不会 revert"，只说"合约调用本身的形状没问题"。
  // messageIndex = 0：谓词里只放了这一条消息。
  await client.simulateContract({
    address: PROXY_ADDRESS,
    abi: VALIDATOR_MANAGER_ABI,
    functionName: 'completeValidatorRegistration',
    args: [0],
    account: ownerAccount,
    accessList,
  });

  if (dryRun) return { ...plan, dryRun: true, txHash: null };

  const { createWalletClient, http } = await import('viem');
  const wallet = createWalletClient({
    account: ownerAccount,
    transport: http(client.transport.url ?? client.transport.value?.url),
  });
  const hash = await wallet.writeContract({
    address: PROXY_ADDRESS,
    abi: VALIDATOR_MANAGER_ABI,
    functionName: 'completeValidatorRegistration',
    args: [0],
    accessList,
    chain: null,
  });
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== 'success') {
    throw new Error(`交易被回滚（${hash}）—— 第四步未完成。`
      + ' 链上仍是「P 链认了、合约没认」，可以直接重试。');
  }
  return { ...plan, dryRun: false, txHash: hash, blockNumber: receipt.blockNumber };
}


// ── 以下是命令行部分 ────────────────────────────────────────────────────────

// ask() 在 ./ask.mjs —— 加入与退出共用一份。
// 抽出去的理由不是"少几行"：原先两份拷贝都有同一个只在非交互环境显形的缺陷
// （stdin 关闭时 rl.question() 永不落定 → Node 以 13 退出，而 13 是本仓库
// 保留给「拓扑违反容错约束」的码）。两份拷贝会各自漂移。

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : (args[i + 1] ?? true);
  };
  const autoYes = args.includes('--yes');
  // 推进 P 链那一格是**工具自己提议的额外交易**，不在用户要做的四步里。
  // 所以它不吃 --yes：--yes 的意思是"我要做的这些步别再问我"，
  // 不是"你可以替我多发一笔我没提过的交易"。要它就显式写 --nudge。
  const allowNudge = args.includes('--nudge');
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
      : '声明里没有 origin=joined 的成员。两种情形：\n'
        + '  · 新机器 → 先在**那台机器上**跑 gen-node-keys.sh，把 identity 块写进 deployment.json\n'
        + '  · 把一个**被退掉的创世验证者**加回来 → 用 --node-id 显式指定它，\n'
        + '    它的公开材料在建链制品的 bootstrapValidators 里（见 publicMaterialFor）');
    process.exit(EXIT_PRECHECK);
  }

  const rpcUrl = process.env.KARMACHAIN_RPC_URL
    ?? `http://127.0.0.1:${config.endpoints.hostRpcPort}${config.endpoints.rpcPath}`;
  // **兜底：未预料的抛出不许变成一段 stack trace 加退出码 1。**
  //
  // 命令行主体是顶层 await，没有 try/catch 包得住它 —— 用进程级处理器接。
  // 这么接还有一个好处：回调里抛出的也接得住，而 try/catch 接不住那些。
  // T031 场景 N 注入实测（2026-09-21）：入口代理一停，此前拿到的是
  // `getaddrinfo ENOTFOUND` 的原始堆栈 + exit 1，而 1 在本仓库没有含义。
  const onFatal = (err) => reportUnexpected(err, { command: 'devnet-member add' });
  process.on('unhandledRejection', onFatal);
  process.on('uncaughtException', onFatal);

  const client = createPublicClient({ transport: http(rpcUrl) });
  // 在动任何东西之前问一次链可不可达 —— 那时"一步都没动链"是确定为真的，
  // 而这正是退出码 30 的含义。
  await assertChainReachable({ client, rpcUrl });

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
  const genesisHash = readFileSync(
    resolve(REPO_ROOT, 'blockchain', 'genesis', 'karmachain.genesis.hash'), 'utf8',
  ).trim();
  const pre = await precheck({
    client, pchain, nodeId, config,
    subnetId: identity.subnetId,
    blockchainId: identity.blockchainId,
    genesisHash,
    chainIdentity: identity,
  });
  for (const p of pre.problems) console.error(`  ✗ ${p}`);
  for (const dr of pre.otherDrifts) console.error(`  ⚠ 另有漂移 [${dr.kind}] ${dr.nodeId ?? ''}`);
  if (pre.splitError) {
    console.error(`  ⚠ **读不到 P 链侧**：${pre.splitError}`);
    console.error('     于是「别的成员是否卡在第四步」本次无法判断 —— 不是没问题，是没看。');
  } else if (pre.split) {
    console.error(`  ✓ 两个事实来源：合约 ${pre.split.contractCount} 个 / P 链 ${pre.split.pchainCount} 个`);
    for (const s of pre.otherSplits) console.error(`  ⚠ 两侧分歧 [${s.kind}] ${s.nodeId ?? ''}`);
  }
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
      r = await step1({
        client, pchain, nodeId, config, subnetId: identity.subnetId, ownerAccount,
        chainIdentity: identity,
      });
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
        config, identity, messageID: messageId,
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
    const material = publicMaterialFor({ nodeId, config, chainIdentity: identity });
    if (!material) {
      console.error(`拿不到 ${nodeId} 的公开材料 —— 前置检查本该拦下这种情况`);
      process.exit(EXIT_PRECHECK);
    }
    const accounts = readJson('blockchain/accounts/dev-accounts.json').accounts;
    const entry = accounts.find((a) => a.label === config.validators.ownerAccount);
    if (!entry) {
      console.error(`dev-accounts.json 里没有 label = ${config.validators.ownerAccount} 的账户`);
      process.exit(EXIT_PRECHECK);
    }

    // ── 门槛的分母**跟链学，而不是用 67 这个常量** ──────────────────────────
    //
    // P 链验证 warp 消息用的是「当前高度之前一格」的 L1 集合（见
    // readVerificationWeights）。刚退过成员时那个集合更大，于是同一条消息
    // 需要的签名权重更高 —— 而聚合器按**当前**集合折算百分比，
    // 会在"够了"的地方收手，带着一条 P 链必然拒绝的消息走到花钱那一步。
    //
    // 所以在收签名**之前**就把分母问清楚，把折算后的百分比交给第二步。
    let weights = await readVerificationWeights({ pchain, subnetId: identity.subnetId });
    const perMember = weights.currentCount > 0 ? weights.currentTotal / BigInt(weights.currentCount) : 100n;
    const needWeight = (total) => (BigInt(BASE_QUORUM_NUM) * total + 99n) / 100n;
    const needSigners = (total) => Number((needWeight(total) + perMember - 1n) / perMember);
    let quorumNum = weights.lagging
      ? (quorumForChainTotal({
        quorumNum: BASE_QUORUM_NUM, chainTotal: weights.verifyTotal, localTotal: weights.currentTotal,
      }) ?? BASE_QUORUM_NUM)
      : BASE_QUORUM_NUM;

    if (weights.lagging) {
      console.error('\n⚠ **P 链验证用的集合比当前集合落后一格**（这是刚退过成员的正常状态）：');
      console.error(`  当前集合    高度 ${weights.height}：${weights.currentCount} 个，合计权重 ${weights.currentTotal}`);
      console.error(`  验证用集合  高度 ${weights.verifyHeight}：${weights.verifyCount} 个，合计权重 ${weights.verifyTotal}`);
      console.error(`  于是门槛按 ${weights.verifyTotal} 算：${BASE_QUORUM_NUM}% × ${weights.verifyTotal} = ${needWeight(weights.verifyTotal)}`
        + `（工具会按当前集合折算成 ${quorumNum}% 去要签名）。`);
      // **落后一格就必须先推进 —— 多收签名过不去。** 2026-09-17 两次实测：
      //   4/5 → signature weight is insufficient: 67*600 > 100*400
      //   5/5 → signature is invalid
      // 第二条才是根因：BitSetSignature 的位索引是对**验证高度那个集合**编号的，
      // 而聚合方按**当前**集合建位图。两个集合不同，聚合公钥就对不上 ——
      // 所以这跟"收几个签名"无关，收满也不合法。
      {
        console.error(`\n  **必须先把 P 链推进一格** —— 多收签名过不去：`);
        console.error(`  位图是按当前 ${weights.currentCount} 个成员编号的，而链按 ${weights.verifyCount} 个验，`
          + '两个集合不同，聚合公钥就对不上（实测：4 个报权重不够，5 个报 signature is invalid）。');
        console.error(`  推进一格之后验证集合就是当前这 ${weights.currentCount} 个，`
          + `门槛 ${needSigners(weights.currentTotal)}/${weights.currentCount}，位图也对得上。`);
        console.error('  P 链**不会自己出块**（没有交易就没有新高度），所以"等一会儿"不管用。');
        console.error('  本命令可以发一笔最无害的交易把它推一格：转一点 AVAX **给自己**，');
        console.error('  不碰任何成员、权益与合约，代价只有一笔手续费。');

        const nudgeArgs = {
          privateKeyHex: entry.privateKey,
          pchainUri: `http://${primary.address}:${primary.httpPort}`,
        };
        let nudgePlan;
        try {
          nudgePlan = await nudgePChainHeight({ ...nudgeArgs, dryRun: true });
        } catch (err) {
          console.error(`\n  （推进一格的构造失败：${err.message} —— 跳过，按零容错继续）`);
          nudgePlan = null;
        }
        if (nudgePlan) {
          console.error(`\n  干跑：付款 ${nudgePlan.pAddress}，手续费 ${nudgePlan.fee} nAVAX，`
            + `转给自己 ${nudgePlan.amount} nAVAX（动用 ${nudgePlan.utxoCount} 个 UTXO）`);
          if (!allowNudge) {
            console.error('\n  要推进就带 --nudge 重跑本命令（它会先推掉这一格，再继续注册）：');
            console.error(`  scripts/devnet-member.sh add --node-id ${nodeId} --nudge`);
          } else {
            let nudged;
            try {
              nudged = await nudgePChainHeight(nudgeArgs);
            } catch (err) {
              console.error(`\n✗ 推进失败：${err.message}`);
              console.error('  这一笔与注册无关，失败不会留下任何中间态 —— 可直接重跑。');
              process.exit(EXIT_STEP_FAILED);
            }
            console.error(`  ✓ 交易 ${nudged.txId}，手续费 ${nudged.fee} nAVAX`);
            // **等它真的进块** —— 高度没涨就等于没推进，而那时门槛照旧。
            let after = weights;
            for (let i = 0; i < 30 && after.height <= weights.height; i += 1) {
              await new Promise((r) => setTimeout(r, 2_000));
              // eslint-disable-next-line no-await-in-loop
              after = await readVerificationWeights({ pchain, subnetId: identity.subnetId });
            }
            if (after.height <= weights.height) {
              console.error('  ✗ 等了 60 秒 P 链高度没涨 —— 交易还没被接受。稍后重跑本命令。');
              process.exit(EXIT_STEP_FAILED);
            }
            console.error(`  ✓ 高度 ${weights.height} → ${after.height}，`
              + `验证分母 ${weights.verifyTotal} → ${after.verifyTotal}`
              + `（当前集合 ${after.currentTotal}）`);
            weights = after;
            quorumNum = after.lagging
              ? (quorumForChainTotal({
                quorumNum: BASE_QUORUM_NUM, chainTotal: after.verifyTotal, localTotal: after.currentTotal,
              }) ?? BASE_QUORUM_NUM)
              : BASE_QUORUM_NUM;
            console.error(`  ✓ 门槛降到 ${quorumNum}%，要 ${needSigners(after.verifyTotal)}/${after.currentCount} 个签名`);
          }
        }
      }
    }

    const set = await readMemberSet({ client });
    let s2;
    try {
      s2 = await step2({
        config, identity, messageID: progress.registrationMessageID,
        registeredCount: set.members.length,
        members: memberCandidates({ config, memberSet: set }),
        quorumNum,
      });
    } catch (err) {
      console.error(`\n✗ 第三步需要第二步的聚合签名，而它失败了：${err.message}`);
      process.exit(EXIT_STEP_FAILED);
    }

    // 既有成员的续费地址 —— 新成员必须跟它一致（见 step3 里那条断言）
    const onP = await pchain('platform.getCurrentValidators', { subnetID: identity.subnetId });
    const localTotalWeight = weights.currentTotal;
    let expectedPAddress; let balance;
    try {
      ({ expectedPAddress, balance } = payerExpectation(onP.validators, {
        initialBalances: (identity.bootstrapValidators ?? []).map((v) => v.balance),
      }));
    } catch (err) {
      console.error(`\n✗ ${err.message}`);
      process.exit(EXIT_PRECHECK);
    }

    const args = {
      config, identity, signedMessage: s2.signedMessage,
      blsSignature: material.proofOfPossession,
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
      // ── P 链与聚合器用了**不同的分母** —— 自纠正一次（T033 实施期）──────────
      //
      // 这不是罕见情形：刚退过一个成员的链正处在这种状态里。报错长这样
      //
      //   signature weight is insufficient: 67*600 > 100*400
      //
      // 而上面那行干跑刚说过「签名者 4/5（80%，门槛 67%）」。**两句都对**：
      // 聚合器按当前 5 个成员（本地总权重 500）算，P 链按它回看的那个高度上的
      // 6 个成员（600）算。4 个签名 = 400，够 80% 但不够 402。
      //
      // 修法是**从链的报错里读出它的分母**，据此折算出该向聚合器要多少，
      // 再重聚合、重提交。不猜一个更高的门槛 —— 猜出来的数下次就不对了。
      const insuf = parseInsufficientWeight(err.message);
      const needed = insuf
        ? quorumForChainTotal({ quorumNum: insuf.quorumNum, chainTotal: insuf.total, localTotal: localTotalWeight })
        : null;
      if (!insuf || needed === null || needed <= s2.quorum.quorumNum) {
        console.error(`\n✗ 第三步失败：${err.message}`);
        if (insuf) {
          console.error(`  链用的分母是 ${insuf.total}，而本地集合总权重是 ${localTotalWeight}，`);
          console.error(`  折算下来需要 ${needed}% —— 提不上去（已经是 ${s2.quorum.quorumNum}%），`);
          console.error('  说明**再多收签名也不够**：本地能出的签名上限低于链的门槛。');
        }
        console.error('  若失败发生在**提交**阶段，去 P 链核一下这个 nodeID 有没有被收录：');
        console.error('  再跑一次本命令，它会从链上读出真实进度。');
        process.exit(EXIT_STEP_FAILED);
      }

      // 这次提交**被 P 链在验证阶段拒了 —— 没有进块，一分钱没花**。
      // （若是进块之后才失败，报错不会是 "failed verifying warp messages"。）
      console.error(`\n⚠ P 链拒了这条消息：签名权重 ${insuf.got} 不足 ——`);
      console.error(`  它按总权重 ${insuf.total} 的 ${insuf.quorumNum}% = `
        + `${(insuf.quorumNum * Number(insuf.total) + 99) / 100 | 0} 判，`);
      console.error(`  而聚合器按本地总权重 ${localTotalWeight} 算，${s2.quorum.percent}% 就收手了。`);
      console.error('  **这笔交易没有进块，没有花钱。** 按链的分母重新折算门槛后重试一次：');
      console.error(`  ${insuf.quorumNum}% × ${insuf.total} ÷ ${localTotalWeight} → 要 ${needed}%`);

      let s2b;
      try {
        s2b = await step2({
          config, identity, messageID: progress.registrationMessageID,
          registeredCount: set.members.length,
          members: memberCandidates({ config, memberSet: set }),
          quorumNum: needed,
        });
      } catch (e2) {
        console.error(`\n✗ 按 ${needed}% 重新聚合失败：${e2.message}`);
        console.error('  本地集合凑不出链要求的权重 —— 先把没签的那些节点弄回在线。');
        process.exit(EXIT_STEP_FAILED);
      }
      console.error(`  重新聚合：签名者 ${s2b.signers}/${s2b.quorum.registeredCount}`
        + `（${s2b.quorum.percent}%，门槛 ${s2b.quorum.quorumNum}%）`);
      if (s2b.signedBy) console.error(`  没签        ${s2b.missing.join('  ') || '无（全员签名）'}`);

      try {
        r = await step3({ ...args, signedMessage: s2b.signedMessage });
      } catch (e3) {
        console.error(`\n✗ 重试后第三步仍然失败：${e3.message}`);
        console.error('  再跑一次本命令，它会从链上读出真实进度。');
        process.exit(EXIT_STEP_FAILED);
      }
    }

    console.error('\n✅ 第三步完成');
    console.error(`  P 链交易    ${r.txId}`);
    console.error(`  花费        balance ${r.balance} + 手续费 ${r.fee} nAVAX`);
    console.error('\n**停在这里。** 第四步要把 P 链发回的确认消息交给合约');
    console.error('  （completeValidatorRegistration）—— 那条消息要由**两个 Primary**签名。');
    console.error('  再跑一次本命令即可继续。');
    process.exit(EXIT_OK);
  }
  if (progress.step === 3) {
    // 第四步：合约交易。**失败就是回滚，不留新的中间态** —— 风险在它之前那一步。
    const accounts = readJson('blockchain/accounts/dev-accounts.json').accounts;
    const entry = accounts.find((a) => a.label === config.validators.ownerAccount);
    if (!entry) {
      console.error(`dev-accounts.json 里没有 label = ${config.validators.ownerAccount} 的账户`);
      process.exit(EXIT_PRECHECK);
    }
    const ownerAccount = privateKeyToAccount(entry.privateKey);
    const aggregatorUrl = process.env.KARMACHAIN_AGGREGATOR_URL ?? 'http://127.0.0.1:8646';

    const args4 = {
      client,
      validationID: progress.validationID,
      networkId: config.avalanche.networkId,
      subnetId: identity.subnetId,   // 由**本 L1 的验证者集合**签，不是 Primary
      aggregatorUrl,
      ownerAccount,
    };

    let plan;
    try {
      plan = await step4({ ...args4, dryRun: true });
    } catch (err) {
      console.error(`\n✗ 第四步的**准备**阶段失败（还没发交易）：${err.message}`);
      process.exit(EXIT_STEP_FAILED);
    }

    console.error(`\n签名聚合器 ${aggregatorUrl}`);
    console.error('干跑（已聚合、已模拟，**尚未发交易**）：');
    console.error(`  确认消息    ${plan.unsignedBytes} → ${plan.signedBytes} 字节`);
    console.error(`  签名者      ${plan.signers} 个（bitset ${plan.bitsetHex}）`
      + ` —— 由 **L1 自己的验证者**签，门槛 67% 的总权重`);
    console.error(`  谓词        ${plan.storageKeys} 个 storage key（access list 交给 Warp 预编译）`);
    console.error('  合约模拟    ✓ 调用形状没问题');
    console.error('              **但模拟不能证明会成功** —— eth_call 会自行准备谓词结果，'
      + '而真实出块要按区块的 P 链高度验签名。');
    console.error('              2026-09-16 实测：模拟通过、交易照样 revert'
      + '（预编译返回 valid = false）。');
    // 这里的 n 原先是**写死的**「n 从 5 到 6」—— 而本文件开头那句是算出来的。
    // 2026-09-22 注册 l1-7 时实测到它已经过期：实际是 6 → 7，它还在说 5 → 6。
    // 同一次运行里一处算得对、一处写死，于是过期的那处看起来同样权威。
    // 复用上面已经算好的 t，不另算一遍。
    console.error('\n**这一步做完，成员才算真正生效** —— 合约与 P 链两侧一致，'
      + `面板与容错判据也会跟着变（n ${t.before.n} → ${t.after.n}，`
      + `可离线数 ${t.before.f} → ${t.after.f}${t.changed ? '' : '（**没变**）'}，见 F-5）。`);

    if (!autoYes && !(await ask('\n发出这笔合约交易？'))) {
      console.error('已中止 —— 只做了聚合与模拟，链未改动。');
      process.exit(EXIT_ABORTED);
    }

    let r;
    try {
      r = await step4(args4);
    } catch (err) {
      console.error(`\n✗ 第四步失败：${err.message}`);
      console.error('  链上仍是「P 链认了、合约没认」—— 可以直接重跑本命令重试。');
      process.exit(EXIT_STEP_FAILED);
    }

    console.error('\n✅ 第四步完成 —— 注册流程走完');
    console.error(`  交易        ${r.txHash}（区块 ${r.blockNumber}）`);
    console.error('\n再跑一次本命令会报出"这个成员已经注册完成"。');
    process.exit(EXIT_OK);
  }

  console.error(`\n第 ${progress.step + 1} 步的实现尚未落地（T027 进行中）。`);
  console.error('这条路径刻意不"先跑起来再说"：写链的代码没有经过变红检查之前，'
    + '不该有机会真的发出交易。');
  process.exit(EXIT_STEP_FAILED);
}
