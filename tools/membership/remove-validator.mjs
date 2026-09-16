// tools/membership/remove-validator.mjs —— ACP-77 退一个 L1 验证者（功能 005 / T036 / US3）。
//
// ## 与加入镜像，但有三处实质不同
//
//   ① 第三步是 `SetL1ValidatorWeightTx`（权重置 0），不是 `RegisterL1ValidatorTx`。
//      它只要一条已签名的 Warp 消息 —— 没有 balance、没有 BLS 证明。
//   ② 第四步的确认消息是 `L1ValidatorRegistration{registered: **false**}`。
//   ③ **代价的方向相反。** 加成员时分母涨、门槛常常不涨（F-5）；
//      退成员时分母降，**门槛可能跟着降** —— 见 tolerance.mjs 的 removalImpact。
//
// ## 四步，进度仍然从链上读
//
//   ① 合约 `initiateValidatorRemoval(validationID)`  → 发出一条 Warp 消息
//   ② 收集 L1 验证者的 BLS 签名                       → 与加入共用 step2
//   ③ P 链 `SetL1ValidatorWeightTx`（权重 0）          → 成员失去权重
//   ④ 合约 `completeValidatorRemoval(messageIndex)`   → 合约侧确认
//
// 可观测的判据（不落盘，每次运行重新观测）：
//
//   ① 完成 → `getValidator(validationID).status` 为 3（pending-removed）
//   ③ 完成 → P 链 `getCurrentValidators({subnetID})` 里**不再有**该 nodeID
//   ④ 完成 → status 为 4（completed）
//
// 与加入一样，②不可观测（聚合签名是临时产物，可无代价重做），
// 所以 progress 永远不会等于 2，第二、三步合成一次调用、两次确认。
//
// ## 顺序不能反：先从集合移除 → 等确认 → 再停进程
//
// 契约第 4 节。先停进程再移除 = 制造一段"集合里有个死节点"的窗口，
// 容错余量在那段时间里被白白吃掉 —— 而那段窗口恰好是最脆弱的时候：
// 一边少了一个能出力的节点，一边分母还没降。
//
// **本工具刻意不停任何容器。** 它只管链上的集合。停进程是第四步完成之后
// 另一条命令的事（`scripts/devnet-node.sh stop <节点>`）—— 把两件事放进
// 同一个命令，就等于把"顺序不能反"这条约束交给实现细节去保证，
// 而它应当由**人看得见的两步**来保证。
//
// 用法：
//   node tools/membership/remove-validator.mjs --node-id NodeID-… [--yes]
//
// 退出码：0 完成/无需操作 | 3 用户中止 | 11 前置检查未过 | 12 某一步失败
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { loadProtocol, readJson, REPO_ROOT, deriveTopology } from '../protocol/load.mjs';
import { identityOf, cb58Decode } from '../verify/lib/identity.mjs';
import {
  VALIDATOR_MANAGER_ABI, PROXY_ADDRESS, STATUS,
  readMemberSet, readPChainMembers, classifyPChainDrift,
} from './member-set.mjs';
import { removalImpact, maxOffline } from './tolerance.mjs';
// 第二步、确认消息的构造、谓词编码、Primary/L1 签名聚合 —— 与加入共用。
// 复制一份的后果不是多几行字，是两条路径对"消息长什么样"各有一套理解。
import {
  step2, registrationConfirmationMessage, aggregateConfirmationSignatures,
  packWarpPredicate, WARP_PRECOMPILE_ADDRESS, memberCandidates,
} from './add-validator.mjs';

export const EXIT_OK = 0;
export const EXIT_ABORTED = 3;
export const EXIT_PRECHECK = 11;
export const EXIT_STEP_FAILED = 12;

/**
 * 从链上观测退出进度。**不读任何状态文件。**
 *
 * 与加入那边同一套理由：状态文件会过期、会与链不一致，而"重试时先信文件还是先信链"
 * 是个没有好答案的问题。
 */
export async function assessRemovalProgress({ client, pchain, nodeId, subnetId }) {
  const set = await readMemberSet({ client });
  const member = set.members.find((m) => m.nodeId === nodeId);
  const removal = set.history
    .filter((h) => h.eventName === 'InitiatedValidatorRemoval' && h.nodeId === nodeId)
    .at(-1);

  // 合约上从来没有过这个 nodeID —— 与"已经退完"是两件事，处置不同
  const everRegistered = set.history.some((h) => h.nodeId === nodeId);
  if (!everRegistered) {
    return {
      step: null, nodeId, validationID: null,
      notes: ['合约上没有这个 nodeID 的任何记录 —— 它从来不是成员，无可退'],
    };
  }

  const validationID = member?.validationID
    ?? set.history.filter((h) => h.nodeId === nodeId).at(-1)?.validationID
    ?? null;
  const notes = [];

  let status = null;
  if (validationID) {
    const v = await client.readContract({
      address: PROXY_ADDRESS, abi: VALIDATOR_MANAGER_ABI, functionName: 'getValidator',
      args: [validationID],
    });
    status = Number(v.status);
    notes.push(`合约侧 status = ${status}（${STATUS[status] ?? '未登记的取值'}）`);
  }

  const onP = await pchain('platform.getCurrentValidators', { subnetID: subnetId });
  const onPChain = (onP.validators ?? []).some((v) => v.nodeID === nodeId);
  notes.push(onPChain ? '③ P 链上**仍有**它（还带着权重）' : '③ P 链上**已无**它');

  // status 4 = completed —— 退出走完
  if (status === 4) {
    notes.push('④ 合约侧已确认退出');
    return { step: 4, nodeId, validationID, weightMessageID: removal?.validatorWeightMessageID ?? null, notes };
  }

  // status 3 = pending-removed —— 第一步做过了
  if (status === 3) {
    if (!onPChain) {
      notes.push('④ 合约侧**未**确认 —— **停在第四步**：P 链已摘除、合约还没认');
      return { step: 3, nodeId, validationID, weightMessageID: removal?.validatorWeightMessageID ?? null, notes };
    }
    notes.push('① 已发起退出，等第二、三步');
    return { step: 1, nodeId, validationID, weightMessageID: removal?.validatorWeightMessageID ?? null, notes };
  }

  // status 2 = active —— 还没开始退
  notes.push('① 尚未发起退出');
  return { step: 0, nodeId, validationID, weightMessageID: null, notes };
}

/**
 * 退出前的前置检查。**阻断项与告知项分开**。
 *
 * 阻断（不动链）：
 *   - 它不是当前成员
 *   - 退完会跌破查询门槛（FR-012）—— 这一步会立刻把链停掉
 *   - 会退到一个成员都不剩
 *   - 两个 Primary 不都在线 —— 第三步要 P 链，而 P 链引导要 ≥ 80% 权益（004 V-08）
 *
 * 告知（要人确认，但决定权在人）：
 *   - f 下降（FR-011）
 */
export async function removalPrecheck({ client, pchain, nodeId, config, subnetId }) {
  if (!subnetId) throw new Error('removalPrecheck 需要 subnetId —— P 链那一侧读不到就判不了门槛');
  const problems = [];
  const d = deriveTopology(config);

  const reachable = async (n) => {
    try {
      const r = await fetch(`http://${n.address}:${n.httpPort}/ext/info`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"jsonrpc":"2.0","id":1,"method":"info.getNodeID","params":[]}',
        signal: AbortSignal.timeout(5000),
      });
      return r.ok;
    } catch { return false; }
  };

  // 两个 Primary：第三步是 P 链交易，而 P 链引导要求连上 ≥ 80% 权益，
  // 它们各握 50% —— 少一个，P 链这一侧就没人处理（004 的 V-08）。
  const offlinePrimaries = [];
  for (const n of d.topologyNodes.filter((x) => x.role === 'primary')) {
    if (!(await reachable(n))) offlinePrimaries.push(n.id);
  }
  if (offlinePrimaries.length) {
    problems.push(`Primary 节点 ${offlinePrimaries.join('、')} 不应答 —— **两个都必须在线**。`
      + ' 第三步是 P 链交易，而 P 链引导要求连上 ≥ 80% 权益，它们各握 50%（004 的 V-08）。');
  }

  // 成员集合取 **P 链**（共识按它算，T070）。合约侧单独比对，分歧照实报。
  let pset;
  try {
    pset = await readPChainMembers({ pchain, subnetId });
  } catch (err) {
    problems.push(`读不到 P 链侧成员：${err.message} —— 判不了退完会不会跌破门槛，不敢往下走`);
    return { ok: false, problems, impact: null, split: null };
  }

  if (!pset.members.some((m) => m.nodeId === nodeId)) {
    problems.push(`${nodeId} **不在 P 链的成员集合里** —— 它没有在共识里带权重，无可退。`
      + ' 若合约侧仍认它，那是「合约认了、P 链没认」的分歧，跑 npm run membership:status 看清楚。');
  }

  // 哪些成员当前离线 —— 只探 P 链认的那批
  const byKeyDir = new Map(config.validators.nodes.map((v) => [v.keyDir, v]));
  const nodeOf = new Map();
  for (const n of d.topologyNodes.filter((x) => x.role === 'l1-validator')) {
    const v = byKeyDir.get(n.keyDir);
    if (!v) continue;
    let id;
    try { id = identityOf(v); } catch { continue; }
    nodeOf.set(id.nodeId, n);
  }
  const offlineIds = [];
  const unknown = [];
  for (const m of pset.members) {
    const n = m.nodeId ? nodeOf.get(m.nodeId) : null;
    if (!n) { unknown.push(m.nodeId ?? '(nodeID 未知)'); continue; }
    if (!(await reachable(n))) offlineIds.push(m.nodeId);
  }
  if (unknown.length) {
    problems.push(`P 链上有 ${unknown.length} 个成员在拓扑里找不到（${unknown.join('、')})——`
      + ' 探测不到它们在不在线，门槛判断就不可靠。');
  }

  const impact = pset.members.some((m) => m.nodeId === nodeId)
    ? removalImpact({ membersBefore: pset.members.length, offlineIds, removingNodeId: nodeId })
    : null;

  if (impact?.wouldEmptySet) {
    problems.push('这是最后一个成员 —— 退掉它不是缩容，是销毁这条链。本工具不做这件事。');
  }
  if (impact?.wouldBreachThreshold) {
    problems.push(`**这一退会让链停止出块。** 现在 P 链上 ${impact.before.n} 个成员、`
      + `离线 ${impact.before.offline} 个（${impact.offlineIds.join('、') || '无'}），上限 ${impact.before.f} —— 在容错内。`
      + ` 退完 n = ${impact.after.n}，上限降到 ${impact.after.f}，而离线仍有 ${impact.after.offline} 个 > ${impact.after.f}。`
      + ' 先把离线的机器弄回来，或者**先退掉那个离线的** —— 它占着分母却不出力。');
  }

  // 两侧分歧照实报（不阻断，但退出过程中它会变化，先看清起点）
  let split = null;
  try {
    const set = await readMemberSet({ client });
    split = classifyPChainDrift({ contractMembers: set.members, pchainMembers: pset.members });
  } catch { /* 读不到合约侧不阻断退出 —— P 链那一侧才是门槛依据 */ }

  return { ok: problems.length === 0, problems, impact, split };
}

/** 第一步：合约 `initiateValidatorRemoval(validationID)`。失败即回滚，链上不留中间态。 */
export async function step1Remove({ client, validationID, ownerAccount }) {
  const onChainOwner = await client.readContract({
    address: PROXY_ADDRESS, abi: VALIDATOR_MANAGER_ABI, functionName: 'owner',
  });
  if (onChainOwner.toLowerCase() !== ownerAccount.address.toLowerCase()) {
    throw new Error(`本地密钥的地址是 ${ownerAccount.address}，而合约的 owner 是 ${onChainOwner}`
      + ' —— 用它签名会被合约 revert。检查 validators.ownerAccount 指向的开发账户。');
  }

  const { createWalletClient, http: httpTransport } = await import('viem');
  const wallet = createWalletClient({
    account: ownerAccount,
    transport: httpTransport(client.transport.url ?? client.transport.value?.url),
  });
  const hash = await wallet.writeContract({
    address: PROXY_ADDRESS, abi: VALIDATOR_MANAGER_ABI,
    functionName: 'initiateValidatorRemoval', args: [validationID], chain: null,
  });
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== 'success') {
    throw new Error(`交易被回滚（${hash}）—— 第一步未完成，可以直接重试`);
  }
  return { txHash: hash, blockNumber: receipt.blockNumber };
}

/**
 * 第三步：把已签名的权重消息提交到 P 链（`SetL1ValidatorWeightTx`）。
 *
 * 比注册那一步简单：`SetL1ValidatorWeightTxProps` 只要 `{ message }` ——
 * 没有 balance、没有 BLS 证明。但它仍是**四步里唯一花钱的一步**，
 * 且成功之后若第四步失败会留下「P 链摘了、合约没认」的中间态。
 *
 * 所以同样分三段：构造 + 算费（不碰链）→ 签名（不碰链）→ 提交（只有这段动链）。
 */
export async function step3Remove({
  signedMessage, privateKeyHex, pchainUri, expectedPAddress, dryRun = false,
}) {
  const { Context, pvm, utils, secp256k1, addTxSignatures } = await import('@avalabs/avalanchejs');
  const { assertPayerAccount, computeFee } = await import('./add-validator.mjs');

  const priv = Buffer.from(privateKeyHex.replace(/^0x/i, ''), 'hex');
  const addrBytes = secp256k1.publicKeyBytesToAddress(secp256k1.getPublicKey(priv));
  const api = new pvm.PVMApi(pchainUri);

  // 顺序有依赖：P 链地址的 bech32 要用 context 的 hrp，UTXO 要按地址查。
  // 并发会引用还没赋值的 context，而拿错 hrp 会查出**空 UTXO** —— 报出来是"余额不足"。
  const context = await Context.getContextFromURI(pchainUri);
  const pAddress = utils.format('P', context.hrp, addrBytes);
  assertPayerAccount({ pAddress, expectedPAddress });

  const [feeState, utxoResp] = await Promise.all([
    api.getFeeState(),
    api.getUTXOs({ addresses: [pAddress] }),
  ]);
  const { utxos } = utxoResp;
  if (!utxos?.length) {
    throw new Error(`P 链地址 ${pAddress} 上没有任何 UTXO —— 用这个密钥付不了费用。`);
  }

  const unsignedTx = pvm.newSetL1ValidatorWeightTx({
    feeState,
    fromAddressesBytes: [addrBytes],
    message: Buffer.from(signedMessage.replace(/^0x/i, ''), 'hex'),
    utxos,
  }, context);

  // 退出不给新成员拨 balance，所以 balance 传 0 —— 费用就是花掉减找零。
  const { spent, change, fee } = computeFee({
    inputAmounts: unsignedTx.getInputUtxos().map((u) => u.output.amount()),
    outputAmounts: unsignedTx.getTx().baseTx.outputs.map((o) => o.output.amount()),
    balance: 0n,
  });

  const plan = { pAddress, utxoCount: utxos.length, spent, change, fee, networkId: context.networkID };
  if (dryRun) return { ...plan, dryRun: true, txId: null };

  await addTxSignatures({ unsignedTx, privateKeys: [priv] });
  const { txID } = await api.issueSignedTx(unsignedTx.getSignedTx());
  return { ...plan, dryRun: false, txId: txID };
}

/**
 * `registered: false` 的签名请求**必须带 justification**（2026-09-16 实测）。
 *
 * ## 这一条是一路问出来的，每一步都有节点给的确切回答
 *
 *   不给 justification            → `invalid justification type: <nil>`
 *   给裸的 warp 字节              → `failed to parse justification: proto: cannot parse invalid wire-format data`
 *                                   —— 于是知道它是 **protobuf**，不是裸字节
 *   protobuf 字段2 ← 216B AddressedCall → `packer has insufficient length for input`
 *   protobuf 字段2 ← 258B 整条消息       → `unknown type ID 1337` —— 它把 networkID 当成了 typeID
 *   protobuf 字段2 ← **182B 内层注册消息** → **解析通过**，改报 `validation "…" exists`
 *
 * 最后那句才是应有的拒签理由：l1-6 确实还是成员，`registered: false` 是假陈述。
 * 格式于是被定死，而**整个过程没有动过链** —— 签名请求是只读的。
 *
 * ## 为什么"不存在"需要额外材料，而"存在"不需要
 *
 * 加入的第四步断言的是 `registered: true`，节点从 P 链状态直接读得出。
 * 退出断言的是 `registered: false` —— **"不存在"读不出来**：
 * 节点无法区分"这个 validationID 被摘除了"与"这个 validationID 从来没有过"。
 * justification 提供的正是"它本来是什么"，节点据此重算 validationID 再确认它不在集合里。
 *
 * ## 两个变体，按**证据**选而不是信声明
 *
 *   创世成员    `SubnetIDIndex{subnetID, index}` —— validationID 由
 *               `sha256(subnetID ‖ uint32BE(index))` 派生（同上实测，五个逐一命中）
 *   后加入成员  当初那条 `RegisterL1Validator` 消息的 **182 字节内层**
 *
 * 选哪一支由 `genesisValidationIndex` 拿 validationID 去试公式决定 ——
 * **不读声明里的 `origin`**。声明可以写错，而公式对得上就是对得上。
 */
export function removalJustification({ registerMessage, subnetId, index } = {}) {
  const varint = (n) => {
    const out = [];
    let v = n;
    do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; out.push(b); } while (v);
    return Buffer.from(out);
  };
  const lenField = (fieldNo, buf) => Buffer.concat([
    Buffer.from([(fieldNo << 3) | 2]), varint(buf.length), buf,
  ]);
  const varField = (fieldNo, n) => Buffer.concat([Buffer.from([(fieldNo << 3) | 0]), varint(n)]);

  if (registerMessage) {
    const bytes = Buffer.from(String(registerMessage).replace(/^0x/i, ''), 'hex');
    if (!bytes.length) throw new Error('removalJustification: registerMessage 是空的');
    // 字段 2 = register_l1_validator_message（实测命中的那一支）
    return `0x${lenField(2, bytes).toString('hex')}`;
  }

  if (subnetId !== undefined && index !== undefined) {
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(`removalJustification: index 是 ${index} —— 必须是 ≥ 0 的整数`);
    }
    const subnetBytes = Buffer.from(cb58Decode(subnetId));
    if (subnetBytes.length !== 32) {
      throw new Error(`subnetID 解码后是 ${subnetBytes.length} 字节，应当是 32 字节`);
    }
    // 字段 1 = convert_subnet_to_l1_tx_data（SubnetIDIndex{subnet_id=1, index=2}）
    const inner = Buffer.concat([lenField(1, subnetBytes), varField(2, index)]);
    return `0x${lenField(1, inner).toString('hex')}`;
  }

  throw new Error('removalJustification 需要 registerMessage（后加入的成员）'
    + '或 subnetId + index（创世成员）—— 两者都没给的话，节点会回'
    + ' `invalid justification type: <nil>`，而那句话不会告诉你缺的是哪一支');
}

/**
 * 这个 validationID 是不是**创世派生**的？是则给出它的 index。
 *
 * 公式 `sha256(subnetID ‖ uint32BE(index))` 由节点自己的报错反推并验证：
 * 拿一个 `SubnetIDIndex{subnetID, index:5}` 去问，节点回
 * `validationID "…" != justificationID "y9QvY…"` —— 那个 justificationID
 * 就是它算出的值，四种候选写法里只有这一种命中。
 * 随后五个创世成员的真实 validationID 逐一命中 index 0…4，公式即被独立验证。
 *
 * **按公式判而不是读声明的 `origin`**：声明可以写错，公式对得上就是对得上。
 */
export function genesisValidationIndex({ subnetId, validationID, maxIndex = 64 }) {
  const subnetBytes = Buffer.from(cb58Decode(subnetId));
  const want = String(validationID).replace(/^0x/i, '').toLowerCase();
  for (let i = 0; i <= maxIndex; i += 1) {
    const idx = Buffer.alloc(4);
    idx.writeUInt32BE(i);
    const got = createHash('sha256').update(Buffer.concat([subnetBytes, idx])).digest('hex');
    if (got === want) return i;
  }
  return null;
}

/**
 * 从一条 AddressedCall 包着的未签名 Warp 消息里切出**内层 ACP-77 消息**。
 *
 * 布局（与 add-validator 里 registrationConfirmationMessage 的构造互逆）：
 *   codec(2) + networkID(4) + sourceChainID(32) + payloadLen(4) + AddressedCall
 *   AddressedCall = codec(2) + typeID(4) + srcAddrLen(4) + srcAddr + payloadLen(4) + 内层
 *
 * 实测的三个尺寸：整条 258 / AddressedCall 216 / 内层 182。
 * 切错一层的后果都试过：给 216 报 `packer has insufficient length`，
 * 给 258 报 `unknown type ID 1337`（把 networkID 当成了 typeID）。
 */
export function innerMessageOf(unsignedWarpMessageHex) {
  const b = Buffer.from(String(unsignedWarpMessageHex).replace(/^0x/i, ''), 'hex');
  if (b.length < 42 + 14) throw new Error(`消息只有 ${b.length} 字节，装不下 Warp 头加 AddressedCall 头`);
  const payloadLen = b.readUInt32BE(38);
  const addressedCall = b.subarray(42, 42 + payloadLen);
  if (addressedCall.length !== payloadLen) {
    throw new Error(`payload 声明 ${payloadLen} 字节，实际只有 ${addressedCall.length} —— 消息被截断了`);
  }
  if (addressedCall.readUInt32BE(2) !== 1) {
    throw new Error(`payload 的 typeID 是 ${addressedCall.readUInt32BE(2)}，不是 1（AddressedCall）`);
  }
  const srcAddrLen = addressedCall.readUInt32BE(6);
  const innerOffset = 2 + 4 + 4 + srcAddrLen + 4;
  const innerLen = addressedCall.readUInt32BE(2 + 4 + 4 + srcAddrLen);
  const inner = addressedCall.subarray(innerOffset, innerOffset + innerLen);
  if (inner.length !== innerLen) {
    throw new Error(`内层声明 ${innerLen} 字节，实际只有 ${inner.length}`);
  }
  return `0x${inner.toString('hex')}`;
}

/**
 * 第四步：把 P 链的摘除确认交给合约（`completeValidatorRemoval`）。
 *
 * 确认消息与加入那步同构，只是 `registered: **false**`。
 * 签名者仍是 **L1 自己的验证者**（研究 V-34 —— 名字叫
 * `requirePrimaryNetworkSigners` 的那个配置项与实际效果不一致，我判断错过一轮）。
 */
export async function step4Remove({
  client, validationID, networkId, subnetId, aggregatorUrl, ownerAccount,
  registerMessage = null, dryRun = false,
}) {
  const unsignedMessage = registrationConfirmationMessage({
    validationID, networkId, registered: false,
  });

  // **justification 按证据选支**，不读声明的 origin：
  // 拿 validationID 去试创世公式，命中就是创世成员（用 SubnetIDIndex），
  // 不命中才是后加入的（用当初那条注册消息）。
  const genesisIndex = genesisValidationIndex({ subnetId, validationID });
  const justification = genesisIndex === null
    ? removalJustification({ registerMessage })
    : removalJustification({ subnetId, index: genesisIndex });

  const signedMessage = await aggregateConfirmationSignatures({
    aggregatorUrl, unsignedMessage, signingSubnetId: subnetId, justification,
  });
  const storageKeys = packWarpPredicate(signedMessage);
  const accessList = [{ address: WARP_PRECOMPILE_ADDRESS, storageKeys }];

  const plan = {
    unsignedBytes: (unsignedMessage.length - 2) / 2,
    signedBytes: (signedMessage.length - 2) / 2,
    justificationKind: genesisIndex === null ? 'register-message' : `subnet-index(${genesisIndex})`,
    storageKeys: storageKeys.length,
  };

  // 模拟只能排除一部分失败，**不能证明会成功** —— eth_call 会自行准备谓词结果，
  // 真实出块要按区块的 P 链高度验签名。加入那一步实测过：模拟通过、交易照样 revert。
  await client.simulateContract({
    address: PROXY_ADDRESS, abi: VALIDATOR_MANAGER_ABI,
    functionName: 'completeValidatorRemoval', args: [0],
    account: ownerAccount, accessList,
  });

  if (dryRun) return { ...plan, dryRun: true, txHash: null };

  const { createWalletClient, http: httpTransport } = await import('viem');
  const wallet = createWalletClient({
    account: ownerAccount,
    transport: httpTransport(client.transport.url ?? client.transport.value?.url),
  });
  const hash = await wallet.writeContract({
    address: PROXY_ADDRESS, abi: VALIDATOR_MANAGER_ABI,
    functionName: 'completeValidatorRemoval', args: [0], accessList, chain: null,
  });
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== 'success') {
    throw new Error(`交易被回滚（${hash}）—— 第四步未完成。`
      + ' 链上仍是「P 链摘了、合约没认」，可以直接重试。');
  }
  return { ...plan, dryRun: false, txHash: hash, blockNumber: receipt.blockNumber };
}

// ── 命令行 ──────────────────────────────────────────────────────────────────

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
  const nodeId = flag('--node-id');
  if (!nodeId || nodeId === true) {
    console.error('用法: node tools/membership/remove-validator.mjs --node-id NodeID-… [--yes]');
    console.error('  先跑 npm run membership:status 看当前成员。');
    process.exit(EXIT_PRECHECK);
  }

  const config = loadProtocol();
  const identity = readJson(resolve(REPO_ROOT, 'blockchain', 'chain-identity', 'karmachain.identity.json'));
  const rpcUrl = process.env.KARMACHAIN_RPC_URL
    ?? `http://127.0.0.1:${config.endpoints.hostRpcPort}${config.endpoints.rpcPath}`;
  const client = createPublicClient({ transport: http(rpcUrl) });
  const d = deriveTopology(config);
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

  console.error(`目标: ${nodeId}（**退出**）`);
  console.error(`L1 RPC: ${rpcUrl}`);
  console.error(`P 链: http://${primary.address}:${primary.httpPort}/ext/bc/P（经 ${primary.id}）\n`);

  console.error('前置检查…');
  const pre = await removalPrecheck({ client, pchain, nodeId, config, subnetId: identity.subnetId });
  for (const p of pre.problems) console.error(`  ✗ ${p}`);
  if (pre.split && !pre.split.ok) {
    console.error(`  ⚠ 两侧分歧：合约 ${pre.split.contractCount} / P 链 ${pre.split.pchainCount}`);
    for (const s of pre.split.splits) console.error(`     [${s.kind}] ${s.nodeId ?? ''}`);
  }
  if (!pre.ok) {
    console.error('\n**前置检查未通过 —— 一步都没动链。** 修好上面这些再来。');
    process.exit(EXIT_PRECHECK);
  }
  console.error('  ✓ 全部通过');

  // ── 代价告知（FR-011）──────────────────────────────────────────────────────
  const im = pre.impact;
  console.error(`\n这次退出的代价：n = ${im.before.n} → ${im.after.n}，`
    + `可离线数 ${im.before.f} → ${im.after.f}`
    + (im.toleranceDrops ? '（**下降了**）' : '（没有变化）'));
  if (im.removingIsOffline) {
    console.error('  注：要退的这个**当前离线** —— 它占着分母却不为共识出力，'
      + `退掉它离线数会从 ${im.before.offline} 降到 ${im.after.offline}。`);
  }
  if (im.toleranceDrops) {
    console.error('  可离线数下降意味着：退出之后，这条链能承受的同时离线数变少了。');
    if (!autoYes && !(await ask('\n知道这个代价，继续？'))) {
      console.error('已中止 —— 链未改动。');
      process.exit(EXIT_ABORTED);
    }
  }

  const progress = await assessRemovalProgress({
    client, pchain, nodeId, subnetId: identity.subnetId,
  });
  if (progress.step === null) {
    console.error(`\n${progress.notes[0]}`);
    process.exit(EXIT_PRECHECK);
  }
  console.error(`\n当前进度：已完成 ${progress.step}/4 步`);
  for (const n of progress.notes) console.error(`  ${n}`);

  if (progress.step === 4) {
    console.error('\n✅ 这个成员已经退出完成。');
    console.error('**现在才可以停它的进程**（顺序不能反，见契约第 4 节）：');
    console.error('  在那台机器上跑 scripts/devnet-node.sh stop <节点>');
    process.exit(EXIT_OK);
  }

  console.error(`\n接下来要做的是第 ${progress.step + 1} 步。`);
  console.error('**本次只做这一步，做完停下来。**');
  console.error('**注意：本工具不会停任何容器。** 进程要等第四步完成之后再停 ——'
    + '先停进程等于制造一段"集合里有个死节点"的窗口。');

  if (!autoYes && !(await ask(`\n执行第 ${progress.step + 1} 步？`))) {
    console.error('已中止，链未改动。');
    process.exit(EXIT_ABORTED);
  }

  const accounts = readJson('blockchain/accounts/dev-accounts.json').accounts;
  const entry = accounts.find((a) => a.label === config.validators.ownerAccount);
  if (!entry) {
    console.error(`dev-accounts.json 里没有 label = ${config.validators.ownerAccount} 的账户`);
    process.exit(EXIT_PRECHECK);
  }
  const ownerAccount = privateKeyToAccount(entry.privateKey);
  const aggregatorUrl = process.env.KARMACHAIN_AGGREGATOR_URL ?? 'http://127.0.0.1:8646';

  if (progress.step === 0) {
    let r;
    try {
      r = await step1Remove({ client, validationID: progress.validationID, ownerAccount });
    } catch (err) {
      console.error(`\n✗ 第一步失败：${err.message}`);
      console.error('  链上没有留下中间态 —— 修好原因后直接重跑本命令即可。');
      process.exit(EXIT_STEP_FAILED);
    }
    console.error('\n✅ 第一步完成');
    console.error(`  交易        ${r.txHash}（区块 ${r.blockNumber}）`);
    console.error('\n**停在这里。** 再跑一次本命令即可继续 —— 进度从链上读。');
    process.exit(EXIT_OK);
  }

  if (progress.step === 1) {
    // 第二、三步：聚合（不写链）+ P 链交易（花钱）。一次调用、两次确认。
    if (!progress.weightMessageID) {
      console.error('\n✗ 第一步的事件里没有 validatorWeightMessageID —— 无法进行第二步。');
      process.exit(EXIT_STEP_FAILED);
    }
    const set = await readMemberSet({ client });
    let s2;
    try {
      s2 = await step2({
        config, identity, messageID: progress.weightMessageID,
        registeredCount: set.members.length,
        members: memberCandidates({ config, memberSet: set }),
      });
    } catch (err) {
      console.error(`\n✗ 第三步需要第二步的聚合签名，而它失败了：${err.message}`);
      process.exit(EXIT_STEP_FAILED);
    }

    const onP = await pchain('platform.getCurrentValidators', { subnetID: identity.subnetId });
    const owners = new Set((onP.validators ?? [])
      .flatMap((v) => v.remainingBalanceOwner?.addresses ?? []));
    if (owners.size !== 1) {
      console.error(`\n✗ 既有成员的续费地址不唯一（${owners.size} 个）—— 该用哪个付费要人来定。`);
      process.exit(EXIT_PRECHECK);
    }

    const args3 = {
      signedMessage: s2.signedMessage,
      privateKeyHex: entry.privateKey,
      expectedPAddress: [...owners][0],
      pchainUri: `http://${primary.address}:${primary.httpPort}`,
    };

    let plan;
    try {
      plan = await step3Remove({ ...args3, dryRun: true });
    } catch (err) {
      console.error(`\n✗ 第三步的**构造**阶段失败（还没碰链）：${err.message}`);
      process.exit(EXIT_STEP_FAILED);
    }

    console.error('\n干跑（已构造、已算费，**尚未提交**）：');
    console.error(`  付款地址    ${plan.pAddress}`);
    console.error(`  交易费      ${plan.fee} nAVAX = ${Number(plan.fee) / 1e9} AVAX`);
    console.error(`  动用 UTXO   ${plan.utxoCount} 个，花 ${plan.spent}、找零 ${plan.change}`);
    console.error(`  签名者      ${s2.signers}/${s2.quorum.registeredCount}`
      + `（${s2.quorum.percent}%，门槛 ${s2.quorum.quorumNum}%）`);
    if (s2.signedBy) {
      console.error(`  签了        ${s2.signedBy.join('  ')}`);
      console.error(`  没签        ${s2.missing.join('  ') || '无（全员签名）'}`);
    }
    console.error('\n**提交之后**：这个成员在 P 链上失去权重，n 立刻变成 '
      + `${im.after.n}，可离线数 ${im.after.f}。若随后第四步失败，`
      + '链上会是「P 链摘了、合约没认」—— 可直接重跑本命令重试。');

    if (!autoYes && !(await ask('\n**提交这笔 P 链交易？**'))) {
      console.error('已中止 —— 只做了构造与算费，链未改动。');
      process.exit(EXIT_ABORTED);
    }

    let r;
    try {
      r = await step3Remove(args3);
    } catch (err) {
      console.error(`\n✗ 第三步失败：${err.message}`);
      console.error('  再跑一次本命令，它会从链上读出真实进度。');
      process.exit(EXIT_STEP_FAILED);
    }
    console.error('\n✅ 第三步完成');
    console.error(`  P 链交易    ${r.txId}（手续费 ${r.fee} nAVAX）`);
    console.error('\n**停在这里。** 第四步把 P 链的摘除确认交给合约。再跑一次本命令即可继续。');
    process.exit(EXIT_OK);
  }

  if (progress.step === 3) {
    const args4 = {
      client,
      validationID: progress.validationID,
      networkId: config.avalanche.networkId,
      subnetId: identity.subnetId,
      aggregatorUrl,
      ownerAccount,
    };
    let plan;
    try {
      plan = await step4Remove({ ...args4, dryRun: true });
    } catch (err) {
      console.error(`\n✗ 第四步的**准备**阶段失败（还没发交易）：${err.message}`);
      process.exit(EXIT_STEP_FAILED);
    }
    console.error(`\n签名聚合器 ${aggregatorUrl}`);
    console.error('干跑（已聚合、已模拟，**尚未发交易**）：');
    console.error(`  确认消息    ${plan.unsignedBytes} → ${plan.signedBytes} 字节`
      + '（registered = **false**）');
    console.error(`  谓词        ${plan.storageKeys} 个 storage key`);
    console.error('  合约模拟    ✓ 调用形状没问题');
    console.error('              **但模拟不能证明会成功** —— 加入那一步实测过：'
      + '模拟通过、交易照样 revert（预编译返回 valid = false）。');

    if (!autoYes && !(await ask('\n发出这笔合约交易？'))) {
      console.error('已中止 —— 只做了聚合与模拟，链未改动。');
      process.exit(EXIT_ABORTED);
    }

    let r;
    try {
      r = await step4Remove(args4);
    } catch (err) {
      console.error(`\n✗ 第四步失败：${err.message}`);
      process.exit(EXIT_STEP_FAILED);
    }
    console.error('\n✅ 第四步完成 —— 退出流程走完');
    console.error(`  交易        ${r.txHash}（区块 ${r.blockNumber}）`);
    console.error('\n**现在才可以停它的进程**（顺序不能反，见契约第 4 节）：');
    console.error('  在那台机器上跑 scripts/devnet-node.sh stop <节点>');
    console.error('  然后把它从 blockchain/deployment.json 的 validators.nodes[] 与 topology 里移除，'
      + '并重新渲染 —— 否则声明与链上会有一处漂移。');
    process.exit(EXIT_OK);
  }

  console.error(`\n第 ${progress.step + 1} 步的实现尚未落地。`);
  process.exit(EXIT_STEP_FAILED);
}
