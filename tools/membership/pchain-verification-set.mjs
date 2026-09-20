// tools/membership/pchain-verification-set.mjs —— P 链**验证 warp 消息时用的那个集合**。
//
// ## 这个文件存在的理由（研究 V-34，2026-09-17 起两次实测）
//
// P 链验证 L1 warp 消息时，用的**不是当前的 L1 成员集合**，而是
// `platform.getHeight() - 1` 那一格的集合 —— 它比成员变更**落后一格**。
//
// 两次实测把这条钉死了，而且方向相反：
//
// | 什么时候 | 当前集合 | 链验证用的 | 报错 |
// |---|---|---|---|
// | 退完成员紧接着加入（T033） | 5 个 / 500 | 6 个 / 600 | `signature weight is insufficient: 67*600 > 100*400`，收满签名后变成 `signature is invalid` |
// | 加完成员紧接着退出（T034 准备期） | 6 个 | 5 个 | `unknown validator: NumIndices (5) >= NumFilteredValidators (5)` |
//
// 所以落后一格影响的**不只是分母**，是**整个集合** —— 权重（门槛算不对）与
// 位序（BitSetSignature 的索引指向不存在的成员）两者都会错。
// 第二条报错尤其说明问题：它压根不是"权重不够"，是位图越界。
//
// **收多少签名都过不去**：位图是按当前集合编号的，而链按另一个集合解。
// 唯一的办法是把 P 链**推进一格**，让验证集合追上来。
// 而 P 链**不会自己出块** —— 没有交易就没有新高度，所以"等一会儿"不管用。
//
// 加入与退出**都**要过这一关，所以这两个函数放在这里、只有一份。
/**
 * P 链验证 L1 warp 消息时用的权重门槛分子（分母恒为 100）。
 *
 * 它**不是**读创世来的：创世 `warpConfig.quorumNumerator` 管的是 subnet-evm 里
 * Warp 预编译的校验，而这里说的是 **P 链**验证 `RegisterL1ValidatorTx` 里那条消息 ——
 * 那个数在 avalanchego 里是常量。两边此刻都是 67（2026-09-16 从节点 debug 日志的
 * `signature weight is insufficient: 67*600 > 100*400` 实测确认），所以写 67，
 * 但**不靠它**：真正的门槛在失败时从链的报错里解出来（见 parseInsufficientWeight），
 * 工具跟链学，而不是拿一个常量去猜。
 */
export const BASE_QUORUM_NUM = 67;

/**
 * 从 P 链的「签名权重不足」报错里**解出它用的分母**（功能 005 / T033 实施期）。
 *
 * ## 为什么需要这件事
 *
 * 聚合器与 P 链可以用**不同的分母**，而两边都没错：
 *
 *   聚合器按 **当前** L1 验证者集合算（2026-09-17：5 × 100 = 500）
 *   P 链按它**回看的那个高度**上的集合算（那时是 6 × 100 = 600）
 *
 * 于是 4 个签名 = 400：聚合器说 80% ≥ 67%（够），P 链说 400/600 = 66.7%（不够）。
 * 报出来是 `signature weight is insufficient: 67*600 > 100*400`，
 * 而工具那一行还写着"4/5（80%，门槛 67%）" —— **两句话都对，分母不同。**
 *
 * 一个刚退过成员的集合正处在这种状态里，所以这不是罕见情形。
 *
 * **不猜一个更高的门槛**：链已经把它的分母写在报错里了，读出来算就行。
 *
 * @returns {{quorumNum: number, total: bigint, got: bigint}|null} 解不出返回 null
 */
export function parseInsufficientWeight(message) {
  const m = /signature weight is insufficient:\s*(\d+)\*(\d+)\s*>\s*(\d+)\*(\d+)/.exec(String(message ?? ''));
  if (!m) return null;
  const [, qNum, total, qDen, got] = m;
  if (Number(qDen) !== 100) return null;            // 分母不是 100 时这套折算不成立
  return { quorumNum: Number(qNum), total: BigInt(total), got: BigInt(got) };
}

/**
 * 按**链的分母**折算出该向聚合器要多少百分比。
 *
 * 聚合器的百分比是对**它自己那份集合权重**（`localTotal`）算的，
 * 而要满足的是 `got * 100 >= quorumNum * chainTotal`。所以：
 *
 *   needed% = ⌈ quorumNum × chainTotal / localTotal ⌉
 *
 * 2026-09-17 的那次：⌈67 × 600 / 500⌉ = 81 —— 81% × 500 = 405 ≥ 402 ✅，
 * 而 4 个签名只有 400，于是聚合器会去多收一个。
 */
export function quorumForChainTotal({ quorumNum, chainTotal, localTotal }) {
  if (!localTotal || localTotal <= 0n) return null;
  const pct = (BigInt(quorumNum) * BigInt(chainTotal) + localTotal - 1n) / localTotal;
  const n = Number(pct);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(100, n);
}

/**
 * 读出**两个分母**：当前的 L1 集合权重，和 P 链**验证 warp 消息时实际用的**那个。
 *
 * ## 为什么它们会不一样
 *
 * 2026-09-17（T033）实测：退掉 l1-2 之后，
 *
 *   platform.getHeight               → 9
 *   getValidatorsAt(9)  5 个 × 100  → 500   ← 当前集合
 *   getValidatorsAt(8)  6 个 × 100  → 600   ← P 链验证时用的
 *
 * 而 P 链拒绝第三步的话是 `signature weight is insufficient: 67*600 > 100*400`。
 * 也就是说**验证用的是"当前高度之前"那一格的集合** —— 它比成员变更落后一格。
 *
 * ## 后果：退成员之后，紧接着的那次加入门槛更高
 *
 * 退一个之后分母还是退之前的 600，而能出签名的只剩 5 个 × 100 = 500：
 * 门槛 67% × 600 = 402，**必须五个全签**（4 个只有 400）——
 * 也就是那一次加入**零容错**，任何一个节点的 P2P 签名不通就做不成。
 *
 * 推进一格 P 链（任何一笔 P 链交易）之后分母变成 500，门槛 335，4/5 就够。
 * 见 nudgePChainHeight。
 */
export async function readVerificationWeights({ pchain, subnetId }) {
  const totalAt = async (height) => {
    const r = await pchain('platform.getValidatorsAt', { height, subnetID: subnetId });
    const set = r?.validators ?? r ?? {};
    let total = 0n;
    let count = 0;
    for (const k of Object.keys(set)) { total += BigInt(set[k].weight ?? set[k]); count += 1; }
    return { total, count };
  };
  const { height } = await pchain('platform.getHeight', {});
  const h = Number(height);
  const now = await totalAt(h);
  const verify = h > 0 ? await totalAt(h - 1) : now;
  return {
    height: h,
    currentTotal: now.total,
    currentCount: now.count,
    verifyHeight: h > 0 ? h - 1 : h,
    verifyTotal: verify.total,
    verifyCount: verify.count,
    lagging: verify.total !== now.total,
  };
}

/**
 * 把 P 链**推进一格** —— 一笔给自己的转账，只为了让上面那个落后一格的分母追上来。
 *
 * P 链**不会自己出块**：没有交易就没有新高度。所以"等一会儿"不管用，
 * 必须真发一笔。这里用最无害的那种：`BaseTx`，把一点 AVAX 转给**自己**，
 * 不碰任何成员、任何权益、任何合约。代价只有一笔手续费。
 *
 * **它写链。** 所以调用方必须先问过人 —— 与第三步同一条规矩。
 */
export async function nudgePChainHeight({
  privateKeyHex, pchainUri, amount = 1_000_000n, dryRun = false,
}) {
  const { Context, pvm, utils, secp256k1, addTxSignatures, TransferableOutput } = await import('@avalabs/avalanchejs');
  const priv = Buffer.from(privateKeyHex.replace(/^0x/, ''), 'hex');
  const addrBytes = secp256k1.publicKeyBytesToAddress(secp256k1.getPublicKey(priv));
  const api = new pvm.PVMApi(pchainUri);
  const context = await Context.getContextFromURI(pchainUri);
  // **这里没有 expectedPAddress，而这不是漏掉的。** 第三步要核对付款地址，
  // 因为新成员的续费地址必须与既有成员一致 —— 那是一条外部期望，弄错要花钱收拾。
  // 这一笔只是把 AVAX 转给**自己**：地址由我们手上的私钥导出，按构造就是对的，
  // 没有可核对的期望值。带一个可空的参数反而会退回那条旧缺陷
  //（忘了传就静默不检查）—— 所以这里干脆不收它。
  const pAddress = utils.format('P', context.hrp, addrBytes);
  const [feeState, utxoResp] = await Promise.all([
    api.getFeeState(),
    api.getUTXOs({ addresses: [pAddress] }),
  ]);
  const unsignedTx = pvm.newBaseTx({
    feeState,
    fromAddressesBytes: [addrBytes],
    outputs: [TransferableOutput.fromNative(context.avaxAssetID, amount, [addrBytes])],
    utxos: utxoResp.utxos,
  }, context);
  const inputs = unsignedTx.getInputUtxos()
    .reduce((t, u) => t + BigInt(u.output.amount()), 0n);
  const outputs = unsignedTx.getTx().baseTx.outputs
    .reduce((t, o) => t + BigInt(o.output.amount()), 0n);
  const plan = { pAddress, fee: inputs - outputs, amount, utxoCount: utxoResp.utxos.length };
  if (dryRun) return { ...plan, dryRun: true, txId: null };
  await addTxSignatures({ unsignedTx, privateKeys: [priv] });
  const { txID } = await api.issueSignedTx(unsignedTx.getSignedTx());
  return { ...plan, dryRun: false, txId: txID };
}
