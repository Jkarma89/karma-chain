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
import { identityOf, joinedValidators, nodeIdToBytes } from '../verify/lib/identity.mjs';
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
  const { validationID } = initiated;
  notes.push(`① 已发起：validationID = ${validationID}`);

  // ④ 合约侧是否已确认（放在 ③ 之前查：④ 成立必然蕴含 ③ 成立）
  const v = await client.readContract({
    address: PROXY_ADDRESS, abi: VALIDATOR_MANAGER_ABI,
    functionName: 'getValidator', args: [validationID],
  });
  if (Number(v.status) === STATUS_ACTIVE) {
    notes.push(`④ 合约侧已确认：status = ${Number(v.status)}（${STATUS[Number(v.status)]}），weight = ${v.weight}`);
    return { step: 4, nodeId, validationID, notes };
  }
  notes.push(`④ 合约侧**未**确认：status = ${Number(v.status)}（${STATUS[Number(v.status)] ?? '未知'}）`);

  // ③ P 链是否已收录
  const onP = await pchain('platform.getCurrentValidators', { subnetID: subnetId });
  const inP = (onP.validators ?? []).some((x) => x.nodeID === nodeId);
  if (inP) {
    notes.push('③ P 链已收录 —— **停在第四步**：P 链认了、合约还没认');
    return { step: 3, nodeId, validationID, notes };
  }
  notes.push('③ P 链**未**收录');
  return { step: 1, nodeId, validationID, notes };
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

  console.error(`\n第 ${progress.step + 1} 步的实现尚未落地（T027 进行中）。`);
  console.error('这条路径刻意不"先跑起来再说"：写链的代码没有经过变红检查之前，'
    + '不该有机会真的发出交易。');
  process.exit(EXIT_STEP_FAILED);
}
