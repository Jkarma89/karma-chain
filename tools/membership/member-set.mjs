// tools/membership/member-set.mjs —— 读**链上实际成员**，并与声明比对（功能 005 / T026）。
//
// ## 事实来源在链上，而链上没有枚举函数
//
// data-model 第 2 节：本期之后成员**运行期可变**，文件回答不了「现在有几个验证者」，
// 它只能回答「我们打算有几个」。事实来源是 PoA 合约的验证者集合。
//
// 而实测（research V-21）：**实现合约里没有任何枚举函数** —— 只有按 NodeID 查的
// `registeredValidators(bytes)`。这一点决定了实现路径：
//
//   按声明的 NodeID 逐个去查，**查不出你不知道的成员**。
//
// 而「链上有、声明里没有」（有人绕过工具加了一个）正是三种漂移的**第一种**。
// 所以成员集合只能从**事件**重建：
//
//   RegisteredInitialValidator      创世那批（区块 4 上 5 条，实测）
//   InitiatedValidatorRegistration  加入流程的第一步 —— 带 nodeID
//   CompletedValidatorRegistration  加入生效 —— 只带 validationID，靠上一条配对出 nodeID
//   CompletedValidatorRemoval       退出生效 —— 从集合里去掉
//
// 九个事件签名都对着创世字节码的 `PUSH32` 常量核验过（tests/unit/validator-manager-abi.test.mjs），
// 所以事件名写错会在离线守卫里红，而不是等到读出一个空集合才发现 ——
// **空集合不报错，只会让第一种漂移永远检测不到。**
//
// ## 为什么解析与读取分开
//
// `memberSetFromLogs()` 是纯函数：喂日志，出集合。`readMemberSet()` 才碰网络。
// 这样三种漂移的分类可以**离线**测（tests/unit/member-set.test.mjs），
// 而不必起一条链才能验证「链上有、声明里没有」这种情形 ——
// 那种情形恰恰最难在真实环境里造出来。
import { decodeEventLog, keccak256, toHex } from 'viem';
import { readJson, REPO_ROOT, loadProtocol } from '../protocol/load.mjs';
import { identityOf, cb58Encode } from '../verify/lib/identity.mjs';
import { resolve } from 'node:path';

const ABI_DOC = readJson(resolve(REPO_ROOT, 'tools', 'membership', 'abi', 'validator-manager.json'));
export const VALIDATOR_MANAGER_ABI = ABI_DOC.abi;

/** 代理地址（入口）。合约调用一律走代理，不直接打实现。 */
export const PROXY_ADDRESS = '0x0feedc0de0000000000000000000000000000000';

/** `ValidatorStatus` 枚举 —— 取值由 getValidator 的实测返回确认（research V-24：Active = 2）。 */
export const STATUS = Object.freeze({
  0: 'unknown', 1: 'pending-added', 2: 'active', 3: 'pending-removed', 4: 'completed', 5: 'invalidated',
});

/** 事件名 → topic0。名字写错会在 ABI 守卫里红（那条对着字节码核验）。 */
const topicOf = (name) => {
  const e = VALIDATOR_MANAGER_ABI.find((x) => x.type === 'event' && x.name === name);
  if (!e) throw new Error(`ABI 里没有事件 ${name} —— tools/membership/abi/validator-manager.json 被改过？`);
  const sig = `${name}(${e.inputs.map((i) => i.type).join(',')})`;
  return keccak256(toHex(sig));
};

export const TOPICS = Object.freeze({
  registeredInitial: topicOf('RegisteredInitialValidator'),
  initiated: topicOf('InitiatedValidatorRegistration'),
  completedRegistration: topicOf('CompletedValidatorRegistration'),
  completedRemoval: topicOf('CompletedValidatorRemoval'),
});

/**
 * ABI 里认得、但**不改变成员集合**的事件：治理与初始化。
 *
 * 单独列出来，是为了让「真的不认识的 topic」那个列表能保持为空 ——
 * 一个恒定非空的告警列表等于没有告警。
 */
const NON_MEMBERSHIP_TOPICS = new Map(
  ['OwnershipTransferred', 'Initialized', 'InitiatedValidatorRemoval']
    .filter((name) => VALIDATOR_MANAGER_ABI.some((x) => x.type === 'event' && x.name === name))
    .map((name) => [topicOf(name), name]),
);

/** 事件里的 `bytes20` nodeID（左对齐在 32 字节 topic 里）→ `NodeID-<cb58>`。 */
export const nodeIdFromBytes20 = (hex) => {
  const b = Buffer.from(hex.replace(/^0x/, '').slice(0, 40), 'hex');
  if (b.length !== 20) throw new Error(`nodeID 应为 20 字节，得到 ${b.length}`);
  return `NodeID-${cb58Encode(b)}`;
};

/**
 * 从日志重建链上成员集合。**纯函数。**
 *
 * @param {{topics: string[], data: string, blockNumber?: bigint}[]} logs 代理地址上的全部日志，按块序
 * @returns {{members: object[], history: object[], unknownTopics: string[]}}
 *   `members` 是当前在集合里的；`history` 是逐条解出来的事件（排查用）；
 *   `unknownTopics` 是解不出来的 topic —— **照实报出，不吞掉**。
 */
export function memberSetFromLogs(logs) {
  const byValidationId = new Map();
  const history = [];
  const unknownTopics = [];

  for (const log of logs) {
    const t = log.topics?.[0];
    const at = log.blockNumber;

    if (t === TOPICS.registeredInitial || t === TOPICS.initiated) {
      const { eventName, args } = decodeEventLog({ abi: VALIDATOR_MANAGER_ABI, data: log.data, topics: log.topics });
      const nodeId = nodeIdFromBytes20(args.nodeID);
      const prev = byValidationId.get(args.validationID);
      byValidationId.set(args.validationID, {
        validationID: args.validationID,
        nodeId,
        weight: args.weight,
        // 创世那批一出现就是生效的；走注册流程的要等 Completed
        active: eventName === 'RegisteredInitialValidator' ? true : (prev?.active ?? false),
        origin: eventName === 'RegisteredInitialValidator' ? 'genesis' : 'joined',
        at,
      });
      // registrationMessageID 只有 Initiated 事件带 —— 第二步要用它去聚合签名，
      // 而进度是从链上读的，所以它必须能从事件里恢复，不能靠上一次运行传下来。
      history.push({
        eventName, validationID: args.validationID, nodeId, at,
        registrationMessageID: args.registrationMessageID ?? null,
      });
      continue;
    }

    if (t === TOPICS.completedRegistration) {
      const { args } = decodeEventLog({ abi: VALIDATOR_MANAGER_ABI, data: log.data, topics: log.topics });
      const e = byValidationId.get(args.validationID);
      if (e) {
        // 权重以 Completed 为准：中途可能被改过（initiateValidatorWeightUpdate）
        byValidationId.set(args.validationID, { ...e, active: true, weight: args.weight, at });
      } else {
        // **没有配对的 Initiated 就出现 Completed** —— 照实记下，不静默丢掉。
        // 可能是日志起点晚于那次注册（fromBlock 给得太大），也可能是合约被改过。
        byValidationId.set(args.validationID, {
          validationID: args.validationID,
          nodeId: null,
          weight: args.weight,
          active: true,
          origin: 'joined',
          at,
          incomplete: 'CompletedValidatorRegistration 没有配对的 Initiated —— nodeID 未知',
        });
      }
      history.push({ eventName: 'CompletedValidatorRegistration', validationID: args.validationID, at });
      continue;
    }

    if (t === TOPICS.completedRemoval) {
      const { args } = decodeEventLog({ abi: VALIDATOR_MANAGER_ABI, data: log.data, topics: log.topics });
      const e = byValidationId.get(args.validationID);
      if (e) byValidationId.set(args.validationID, { ...e, active: false, removedAt: at });
      history.push({ eventName: 'CompletedValidatorRemoval', validationID: args.validationID, at });
      continue;
    }

    if (t) unknownTopics.push(t);
  }

  // **「ABI 里有但与成员无关」和「真的不认识」要分开。**
  // 第一版把两者混成一个 unknownTopics，于是它恒定含 OwnershipTransferred 与
  // Initialized 那两条 —— 一个永远非空的告警列表，第三条出现时没人会注意。
  const ignored = new Set(NON_MEMBERSHIP_TOPICS.keys());
  const unknown = [...new Set(unknownTopics)];
  return {
    members: [...byValidationId.values()].filter((m) => m.active),
    history,
    /** ABI 里认得、但不影响成员集合的事件（治理、初始化）。 */
    ignoredTopics: unknown.filter((t) => ignored.has(t)).map((t) => ({ topic: t, event: NON_MEMBERSHIP_TOPICS.get(t) })),
    /** **真的不认识**的 topic —— 非空就意味着合约发出了我们没登记的事件。 */
    unknownTopics: unknown.filter((t) => !ignored.has(t)),
  };
}

/** 漂移的三种（data-model 第 2 节）。名字沿用面板既有的 incident 形状，不新建一套。 */
export const DRIFT = Object.freeze({
  ON_CHAIN_ONLY: 'member-unexpected',   // 链上有、声明里没有 —— 有人绕过工具加了一个
  DECLARED_ONLY: 'member-missing',      // 声明里有、链上没有 —— 加入没走完，或退出只做了一半
  ATTRIBUTES: 'member-attributes',      // 两边都有但属性不同
});

/**
 * 比对「链上实际成员」与「声明的期望成员」，给出三种漂移的分类。
 *
 * @param {object[]} onChain  memberSetFromLogs().members
 * @param {object[]} declared loadProtocol().validators.nodes
 */
export function classifyDrift(onChain, declared) {
  const declaredById = new Map();
  for (const v of declared) {
    // identityOf：创世成员从密钥派生，创世后加入的凭声明的公开材料（T069）
    declaredById.set(identityOf(v).nodeId, v);
  }
  const chainById = new Map();
  for (const m of onChain) if (m.nodeId) chainById.set(m.nodeId, m);

  const drifts = [];

  for (const [nodeId, m] of chainById) {
    if (declaredById.has(nodeId)) continue;
    drifts.push({
      kind: DRIFT.ON_CHAIN_ONLY,
      nodeId,
      validationID: m.validationID,
      detail: '链上是成员，声明里没有 —— 有人绕过工具加了一个。'
        + '处置：补进 blockchain/deployment.json 的 validators.nodes[]，或把它退出。',
    });
  }

  for (const [nodeId, v] of declaredById) {
    if (chainById.has(nodeId)) continue;
    drifts.push({
      kind: DRIFT.DECLARED_ONLY,
      nodeId,
      validatorIndex: v.index,
      detail: '声明里是成员，链上不是 —— 加入流程没走完，或退出只做了一半。'
        + '处置：看多步流程停在哪一步（FR-016），重试那一步。',
    });
  }

  // 属性不同：链上能比的只有权重与状态。端口、故障边界这些只存在于声明侧，
  // 链上没有对应物 —— 拿它们来比会得到一个永远为真的"漂移"。
  const weights = new Set(onChain.filter((m) => m.nodeId).map((m) => String(m.weight)));
  if (weights.size > 1) {
    drifts.push({
      kind: DRIFT.ATTRIBUTES,
      nodeId: null,
      detail: `链上成员的权重不一致：${[...weights].join(' / ')}。`
        + '容错上限 ⌊n/4⌋ 的推导以**等权**为前提（research V-22 实测五个各 100）——'
        + '权重不等时那条推导不成立，面板给出的余量会是错的。',
    });
  }

  for (const m of onChain) {
    if (m.incomplete) {
      drifts.push({ kind: DRIFT.ATTRIBUTES, nodeId: m.nodeId, validationID: m.validationID, detail: m.incomplete });
    }
  }

  return {
    ok: drifts.length === 0,
    onChainCount: chainById.size,
    declaredCount: declaredById.size,
    drifts,
  };
}

/**
 * 对着活链读一次成员集合。
 *
 * `fromBlock` 默认 0 —— **必须从创世扫**，否则会漏掉 `RegisteredInitialValidator`，
 * 于是创世那批全部变成「声明里有、链上没有」。这条链只有一千来个块，成本可忽略；
 * 换到长链上要另想办法（那时得记住一个已知的起点高度，并把它当成事实来源之一）。
 */
export async function readMemberSet({ client, address = PROXY_ADDRESS, fromBlock = 0n } = {}) {
  if (!client) throw new Error('readMemberSet 需要一个 viem publicClient');
  const toBlock = await client.getBlockNumber();
  const logs = await client.getLogs({ address, fromBlock, toBlock });
  return { ...memberSetFromLogs(logs), toBlock, address };
}

/** 读一个视图函数（无参）。返回已解码的值。 */
export async function readView(client, name, address = PROXY_ADDRESS) {
  return client.readContract({ address, abi: VALIDATOR_MANAGER_ABI, functionName: name });
}

/**
 * 链上注册成员的 **nodeID 集合**，给容错判据用（功能 005 / T073）。
 *
 * 容错的 n 必须是**链上注册数**，不是声明数。research V-31 的假警报就出在这里：
 * 声明 6 / 链上 5 / 在线 4 → 按声明算出「链已停止出块」，
 * 而同一时刻探测交易在区块 975 里 8.7 秒确认。
 *
 * **读不到时返回 `source: 'unknown'`，绝不退回声明。** 退回声明就是把
 * "不知道"说成"知道"，而那个说法恰好是错的那一个。
 *
 * 这里只负责取回集合与它的形状 —— 怎么用它收敛容错，在
 * `tools/dashboard/snapshot.mjs` 的 `scopeToChainMembers` 里（只有一份，
 * 那个模块零 import，所以 `node-status` 引它不会背上传递依赖）。
 * 本函数存在的理由是：面板与 `node-status` 都要它，而"成员集合长什么样"
 * 这件事不该有两份定义。
 */
export async function readRegisteredMembers({ rpcUrl, now = Date.now() } = {}) {
  try {
    const { createPublicClient, http } = await import('viem');
    const client = createPublicClient({ transport: http(rpcUrl) });
    const set = await readMemberSet({ client });
    return {
      source: 'chain',
      registeredNodeIds: set.members.map((m) => m.nodeId).filter(Boolean),
      readAt: now,
      // nodeID 未知的成员（Completed 没配对 Initiated）单独计数 ——
      // 它们确实在集合里，但认不出是谁，所以不能进 registeredNodeIds。
      // 不说出来的话，链上注册数与这个数组的长度会静默不等。
      unidentified: set.members.filter((m) => !m.nodeId).length,
    };
  } catch (err) {
    return { source: 'unknown', error: err.message, readAt: now };
  }
}

/** 命令行：打印链上成员与漂移分类。 */
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const { createPublicClient, http } = await import('viem');
  const p = loadProtocol();
  const url = process.env.KARMACHAIN_RPC_URL
    ?? `http://127.0.0.1:${p.endpoints.hostRpcPort}${p.endpoints.rpcPath}`;
  const client = createPublicClient({ transport: http(url) });

  const set = await readMemberSet({ client });
  const cls = classifyDrift(set.members, p.validators.nodes);

  console.log(`链上成员 ${cls.onChainCount}，声明成员 ${cls.declaredCount}（扫到高度 ${set.toBlock}）\n`);
  for (const m of set.members.sort((a, b) => (a.nodeId ?? '').localeCompare(b.nodeId ?? ''))) {
    console.log(`  ${m.nodeId ?? '(nodeID 未知)'}  weight=${m.weight}  ${m.origin}`);
  }
  if (set.ignoredTopics.length) {
    console.log(`\n与成员无关的事件 ${set.ignoredTopics.length} 条：${set.ignoredTopics.map((x) => x.event).join('、')}`);
  }
  if (set.unknownTopics.length) {
    console.log(`\n⚠ **不认识**的 topic ${set.unknownTopics.length} 个 —— 合约发出了我们没登记的事件：`);
    for (const t of set.unknownTopics) console.log(`  ${t}`);
  }
  if (cls.ok) {
    console.log('\n✅ 无漂移：链上成员与声明一致');
  } else {
    console.log(`\n⚠ ${cls.drifts.length} 处漂移：`);
    for (const d of cls.drifts) console.log(`  [${d.kind}] ${d.nodeId ?? ''}\n      ${d.detail}`);
    process.exitCode = 13;
  }
}
