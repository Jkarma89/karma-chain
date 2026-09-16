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
import { readJson, REPO_ROOT, loadProtocol, deriveTopology } from '../protocol/load.mjs';
import { identityOf, cb58Encode, cb58Decode } from '../verify/lib/identity.mjs';
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
  initiatedRemoval: topicOf('InitiatedValidatorRemoval'),
  completedRemoval: topicOf('CompletedValidatorRemoval'),
});

/**
 * ABI 里认得、但**不改变成员集合**的事件：治理与初始化。
 *
 * 单独列出来，是为了让「真的不认识的 topic」那个列表能保持为空 ——
 * 一个恒定非空的告警列表等于没有告警。
 */
// 注意 `InitiatedValidatorRemoval` **不在**这份名单里 —— 它确实不改变成员集合，
// 但它带着退出第二步要用的 `validatorWeightMessageID`，所以被真正解析（见上面那段）。
// 「不改变集合」不等于「不需要记下来」。
const NON_MEMBERSHIP_TOPICS = new Map(
  ['OwnershipTransferred', 'Initialized']
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

    // **不改变成员集合，但进 history。** 这两件事必须分开：
    // 合约侧要到 CompletedValidatorRemoval 才把成员移出集合，所以这条事件
    // 不该动 `active`；但它带着 `validatorWeightMessageID` ——
    // **退出的第二步要拿它去收集签名**。
    //
    // 第一版把它归进 NON_MEMBERSHIP_TOPICS（"认得但不影响集合"），于是它
    // 完全不进 history，`assessRemovalProgress` 永远拿不到那个消息 ID，
    // 退出流程卡在第二步而报的是"事件里没有 validatorWeightMessageID"。
    // 写 T036 时才发现 —— 「不改变集合」不等于「不需要记下来」。
    if (t === TOPICS.initiatedRemoval) {
      const { args } = decodeEventLog({ abi: VALIDATOR_MANAGER_ABI, data: log.data, topics: log.topics });
      // 这条事件**不带 nodeID**（只有 validationID），nodeId 从既有条目里取
      const e = byValidationId.get(args.validationID);
      history.push({
        eventName: 'InitiatedValidatorRemoval',
        validationID: args.validationID,
        nodeId: e?.nodeId ?? null,
        validatorWeightMessageID: args.validatorWeightMessageID ?? null,
        weight: args.weight,
        at,
      });
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
 * 合约侧与 **P 链侧**之间的分歧（T070 / research V-28）。
 *
 * 与 `DRIFT` 分开命名，因为这三种**不都是错**：`PCHAIN_ONLY` 是 ACP-77
 * 第三步做完、第四步没做完时的正常中间态。把它和"有人绕过工具加了一个"
 * 归成同一类，就等于让一个已知的、有明确处置的状态长期亮红灯 ——
 * 而恒定的红灯等于没有灯。
 */
export const SPLIT = Object.freeze({
  PCHAIN_ONLY: 'split-pchain-only',       // P 链有、合约没有 —— 停在第四步
  CONTRACT_ONLY: 'split-contract-only',   // 合约有、P 链没有 —— 第三步没做，或退出做了一半
  WEIGHT: 'split-weight',                 // 两侧都有，权重不同
  VALIDATION_ID: 'split-validation-id',   // 两侧都有，validationID 不同 —— 重复注册过
});

/**
 * 把 P 链的 validationID 归一化成合约侧的表示。
 *
 * 同一个值两种编码（research V-28 实测）：
 *   P 链    CB58，如 `jbVejeab5dHjhakduNgg8vFh6iMrHJ9MsMDSzFLdedp7KQ2sL`
 *   合约    hex，如 `0x60b76e92…`
 *
 * 不归一化就比，会得到"每个成员的 validationID 都不一样"——
 * 一个**恒为真**的漂移，也就是一条永远亮着的告警。
 */
export function normalizeValidationId(value) {
  if (value === null || value === undefined) return null;
  const s = String(value);
  if (/^0x[0-9a-fA-F]{64}$/.test(s)) return s.toLowerCase();
  // CB58：32 字节 + 4 字节校验和
  const bytes = cb58Decode(s);
  if (bytes.length !== 32) {
    throw new Error(`validationID 解码后是 ${bytes.length} 字节，应当是 32 字节：${s.slice(0, 24)}…`);
  }
  return `0x${Buffer.from(bytes).toString('hex')}`;
}

/**
 * 读 **P 链侧**的成员集合 —— 第二个事实来源（T070 / research V-28）。
 *
 * 合约侧是「PoA owner 注册了谁」，P 链侧是「谁真的在共识里带权重」。
 * **两者可以合法地不一致**，而那恰恰是最需要看清的中间态：
 * 2026-09-16 实测，第三步做完、第四步没做完时，合约说 5 个、P 链说 6 个。
 *
 * 这个差额还有一层后果：**容错的分母该按 P 链算**（共识权重来自 P 链的 L1
 * 验证者集合），而面板当前按合约事件算。两者不等时按合约算是**偏乐观**的 ——
 * 见 classifyPChainDrift 里那条说明。
 */
export async function readPChainMembers({ pchain, subnetId }) {
  if (typeof pchain !== 'function') throw new Error('readPChainMembers 需要一个 pchain(method, params) 调用器');
  if (!subnetId) throw new Error('readPChainMembers 需要 subnetId');
  const res = await pchain('platform.getCurrentValidators', { subnetID: subnetId });
  const members = (res.validators ?? []).map((v) => ({
    nodeId: v.nodeID,
    weight: BigInt(v.weight),
    validationID: normalizeValidationId(v.validationID),
    balance: v.balance === undefined ? null : BigInt(v.balance),
  }));
  return { source: 'p-chain', subnetId, members };
}

/**
 * 比对**合约侧**与 **P 链侧**（T070）。
 *
 * 纯函数：两侧的成员数组进来，分歧出去。`stoppedAtStepFour` 单独给出来，
 * 因为它是**有明确处置**的那一种（跑第四步），不该和真正的异常混在一起。
 */
export function classifyPChainDrift({ contractMembers, pchainMembers }) {
  const byId = (list) => {
    const m = new Map();
    for (const x of list) if (x.nodeId) m.set(x.nodeId, x);
    return m;
  };
  const contract = byId(contractMembers);
  const pchain = byId(pchainMembers);
  const splits = [];

  for (const [nodeId, m] of pchain) {
    if (contract.has(nodeId)) continue;
    splits.push({
      kind: SPLIT.PCHAIN_ONLY,
      nodeId,
      validationID: m.validationID,
      detail: 'P 链已收录、合约侧还没确认 —— 这是 ACP-77 **停在第四步**的样子'
        + '（第三步做完、第四步没做完）。处置：跑 add-validator，它会从链上读出进度并继续。'
        + ' 注意此时**容错的分母按 P 链算才对**：合约少算一个成员，'
        + '会把"再掉一个就停摆"报成"还有余量"。',
    });
  }

  for (const [nodeId, m] of contract) {
    if (pchain.has(nodeId)) continue;
    splits.push({
      kind: SPLIT.CONTRACT_ONLY,
      nodeId,
      validationID: m.validationID,
      detail: '合约侧是成员、P 链上不是 —— 第三步没做（P 链交易没提交或被拒），'
        + '或者退出流程只做了一半。处置：跑 add-validator 看它报出停在哪一步。'
        + ' 这个方向更危险：合约以为它是成员，而它在共识里**不带权重**。',
    });
  }

  for (const [nodeId, c] of contract) {
    const p = pchain.get(nodeId);
    if (!p) continue;
    if (c.weight !== undefined && p.weight !== undefined && BigInt(c.weight) !== BigInt(p.weight)) {
      splits.push({
        kind: SPLIT.WEIGHT,
        nodeId,
        detail: `权重两侧不同：合约 ${c.weight}、P 链 ${p.weight}。`
          + ' 共识按 P 链的算，而容错上限 ⌊n/4⌋ 的推导以等权为前提 —— 不等时那条推导不成立。',
      });
    }
    // **两侧都归一化。** 只归一合约那一侧，就等于假设 pchainMembers 一定来自
    // readPChainMembers（它归一过）—— 一个隐藏耦合：这个纯函数换个调用方就失效，
    // 而失效的样子是"每个成员都报一处 validationID 不一致"。守卫抓到过这一版。
    const cid = normalizeValidationId(c.validationID);
    const pid = normalizeValidationId(p.validationID);
    if (cid && pid && cid !== pid) {
      splits.push({
        kind: SPLIT.VALIDATION_ID,
        nodeId,
        detail: `validationID 两侧不同：合约 ${cid}、P 链 ${p.validationID}。`
          + ' 同一个 nodeID 被注册过两次（中间退出过一次？）——'
          + ' 两侧各记着不同的那一次，后续任何按 validationID 的操作都会打错目标。',
      });
    }
  }

  const stoppedAtStepFour = splits
    .filter((s) => s.kind === SPLIT.PCHAIN_ONLY)
    .map((s) => s.nodeId);

  return {
    ok: splits.length === 0,
    contractCount: contract.size,
    pchainCount: pchain.size,
    splits,
    /** 只差第四步的成员。非空时不算"坏"，算"没做完"。 */
    stoppedAtStepFour,
  };
}

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
 * **共识成员**的 nodeID 集合，给容错判据用（功能 005 / T073 + T070 修正）。
 *
 * ## 为什么读 P 链，而不是合约
 *
 * 容错的 n 必须是**共识里真的带权重的那一批**。而那是 **P 链的 L1 验证者集合** ——
 * 不是声明，也不是合约事件。
 *
 * 声明不行（research V-31 的假警报）：声明 6 / 链上 5 / 在线 4 →
 * 按声明算出「链已停止出块」，而同一时刻探测交易在区块 975 里 8.7 秒确认。
 *
 * 合约也不行（2026-09-16 实测）：第三步做完、第四步没做完时，
 * 合约说 5 个、P 链说 6 个。而那一刻 L1 的 Warp 校验报的是
 * `signature weight is insufficient: 67*600 > 100*200` —— **600**，
 * 也就是 6 个验证者的总权重。**共识按 P 链算，这是直接证据，不是推断。**
 * 按合约算会少一个成员，方向是**偏乐观**的：把"再掉一个就停摆"报成"还有余量"。
 *
 * **读不到时返回 `source: 'unknown'`，绝不退回声明或合约。** 退回任何一侧都是把
 * "不知道"说成"知道"，而在有成员正在加入时，那个说法恰好是错的那一个。
 *
 * 这里只负责取回集合与它的形状 —— 怎么用它收敛容错，在
 * `tools/dashboard/snapshot.mjs` 的 `scopeToChainMembers` 里（只有一份，
 * 那个模块零 import，所以 `node-status` 引它不会背上传递依赖）。
 * 本函数存在的理由是：面板与 `node-status` 都要它，而"成员集合长什么样"
 * 这件事不该有两份定义。
 *
 * @param {{pchainUrl: string, subnetId: string, now?: number}} args
 *   `pchainUrl` 形如 `http://<Primary 地址>:<httpPort>` —— Primary 是 P 链的权益方，
 *   也是唯一完整同步主网络的节点。
 */
export async function readConsensusMembers({ pchainUrl, subnetId, now = Date.now() } = {}) {
  try {
    if (!pchainUrl) throw new Error('缺 pchainUrl（某个 Primary 的 http 地址）');
    if (!subnetId) throw new Error('缺 subnetId');
    const pchain = async (method, params) => {
      const r = await fetch(`${pchainUrl.replace(/\/$/, '')}/ext/bc/P`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(10_000),
      });
      const j = await r.json();
      if (j.error) throw new Error(`${method}: ${j.error.message}`);
      return j.result;
    };
    const set = await readPChainMembers({ pchain, subnetId });
    const weights = [...new Set(set.members.map((m) => String(m.weight)))];
    return {
      source: 'p-chain',
      registeredNodeIds: set.members.map((m) => m.nodeId).filter(Boolean),
      readAt: now,
      // nodeID 认不出的成员单独计数 —— 它们确实带着权重，但认不出是谁，
      // 所以不能进 registeredNodeIds。不说出来的话，成员数与这个数组的长度会静默不等。
      unidentified: set.members.filter((m) => !m.nodeId).length,
      /**
       * 等权是 ⌊n/4⌋ 那条推导的**前提**（research R-05 / V-22）。
       * 不等时那条推导不成立，而按它算出的余量会是错的 —— 所以这里照实报出，
       * 让调用方能说"前提不成立"，而不是给一个看着确定的错数。
       */
      equalWeights: weights.length <= 1,
      weights,
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

  // ── 第二个事实来源：P 链（T070 / research V-28）──────────────────────────
  //
  // 合约侧是「PoA owner 注册了谁」，P 链侧是「谁真的在共识里带权重」。
  // 读不到 P 链时**说读不到**，不静默跳过 —— 少了这一侧，
  // "停在第四步"这个中间态在本工具里完全不可见。
  const identity = readJson(resolve(REPO_ROOT, 'blockchain', 'chain-identity', 'karmachain.identity.json'));
  const d = deriveTopology(p);
  const primary = d.topologyNodes.find((n) => n.role === 'primary');
  const pchain = async (method, params) => {
    const r = await fetch(`http://${primary.address}:${primary.httpPort}/ext/bc/P`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(15_000),
    });
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  };

  let pset;
  try {
    pset = await readPChainMembers({ pchain, subnetId: identity.subnetId });
  } catch (err) {
    console.log(`\n⚠ **读不到 P 链侧**（经 ${primary.id}）：${err.message}`);
    console.log('  于是"停在第四步"这个中间态本次无法判断 —— 不是"没有问题"，是"没看"。');
    process.exitCode = 13;
  }

  if (pset) {
    const split = classifyPChainDrift({ contractMembers: set.members, pchainMembers: pset.members });
    console.log(`\nP 链侧成员 ${split.pchainCount}（经 ${primary.id}），合约侧 ${split.contractCount}`);
    for (const m of [...pset.members].sort((a, b) => a.nodeId.localeCompare(b.nodeId))) {
      console.log(`  ${m.nodeId}  weight=${m.weight}`
        + (m.balance === null ? '' : `  balance=${m.balance}`));
    }
    if (split.ok) {
      console.log('\n✅ 两侧一致：合约认的与 P 链上带权重的是同一批');
    } else {
      if (split.stoppedAtStepFour.length) {
        console.log(`\n⏸ ${split.stoppedAtStepFour.length} 个成员**停在第四步**（不是故障，是没做完）`);
      }
      console.log(`\n⚠ ${split.splits.length} 处两侧分歧：`);
      for (const s of split.splits) console.log(`  [${s.kind}] ${s.nodeId ?? ''}\n      ${s.detail}`);
      process.exitCode = 13;
    }
  }
}
