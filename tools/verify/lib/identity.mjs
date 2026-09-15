// tools/verify/lib/identity.mjs
//
// 从 staking 材料派生节点身份，供启动期校验（docker/node/entrypoint.sh）与测试共用。
//
// 为什么必须能离线派生（研究 R-03 / data-model §5）：建链制品里的 nodeId 与 blsPublicKey
// 必须与 blockchain/validators/dev/node-N/ 下的密钥同源。不能同源就说明制品与密钥来自
// 不同的两次建链 —— 这类错误若不在启动早期拦下，会表现为几分钟后难以诊断的"连不上"。
//
// NodeID 的算法来自 avalanchego：ids.NodeID = Hash160(SHA256(cert.Raw))，再以 CB58 编码。
// 正确性由 tests/unit/identity-crosscheck.test.mjs 对 5 组真实密钥与已知 NodeID 逐一比对。

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bls12_381 } from '@noble/curves/bls12-381';
import { REPO_ROOT } from '../../protocol/load.mjs';

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const sha256 = (buf) => createHash('sha256').update(buf).digest();
const ripemd160 = (buf) => createHash('ripemd160').update(buf).digest();

/** base58（比特币字母表），前导零字节编码为 '1'。 */
export function base58Encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58_ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out || '1';
}

/** base58 解码（比特币字母表）。前导 '1' 还原为前导零字节。 */
export function base58Decode(str) {
  let n = 0n;
  for (const c of str) {
    const i = B58_ALPHABET.indexOf(c);
    if (i < 0) throw new Error(`非法的 base58 字符 ${JSON.stringify(c)}`);
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const body = n === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex');
  let lead = 0;
  for (const c of str) { if (c === '1') lead += 1; else break; }
  return Buffer.concat([Buffer.alloc(lead), body]);
}

/**
 * CB58 解码，**并校验 4 字节 checksum**。
 *
 * 校验是这个函数存在的主要理由：NodeID 是人手抄来抄去的东西（从生成脚本的输出
 * 贴进 deployment.json、再贴进注册命令），而抄错一个字符得到的是一个**格式合法**
 * 的 NodeID。不验校验和的话，注册会成功地注册一个**不存在的节点** ——
 * 链上多一个永远不上线的成员，而容错判据把它算成"该在线但掉了"。
 */
export function cb58Decode(str) {
  const raw = base58Decode(str);
  if (raw.length < 5) throw new Error(`CB58 太短（${raw.length} 字节），至少要 4 字节校验和加 1 字节负载`);
  const payload = raw.subarray(0, raw.length - 4);
  const want = raw.subarray(raw.length - 4);
  const got = sha256(payload).subarray(28, 32);
  if (!got.equals(want)) {
    throw new Error(`CB58 校验和不符：期望 ${want.toString('hex')}，算出 ${got.toString('hex')}`
      + ' —— 这个标识抄错了字符');
  }
  return payload;
}

/**
 * `NodeID-<cb58>` → 20 字节。合约的 `initiateValidatorRegistration` 要的就是这 20 字节。
 *
 * 长度也要验：NodeID 的负载是 `ripemd160(sha256(cert))`，**恒为 20 字节**。
 * 不验的话，一个校验和恰好对得上的短标识会被当成合法 nodeID 传进合约。
 */
export function nodeIdToBytes(nodeId) {
  if (!nodeId.startsWith('NodeID-')) throw new Error(`NodeID 必须以 NodeID- 开头，得到 ${nodeId}`);
  const bytes = cb58Decode(nodeId.slice('NodeID-'.length));
  if (bytes.length !== 20) throw new Error(`NodeID 负载应为 20 字节，得到 ${bytes.length}`);
  return bytes;
}

/** CB58 = base58(payload ‖ sha256(payload) 的后 4 字节)，Avalanche 的标准短标识编码。 */
export function cb58Encode(bytes) {
  const checksum = sha256(bytes).subarray(-4);
  return base58Encode(Buffer.concat([Buffer.from(bytes), checksum]));
}

/**
 * 由链名派生 VM ID —— avalanchego 在 plugin-dir 中按该 ID 查找 VM 插件。
 * Avalanche CLI 对自定义链使用「链名右侧补零到 32 字节再 CB58」的规则；
 * 实测 "karmachain" → pHttaRrmCUWpVxAnVWEShJwEDzUtWeM4hfzc4JPLJHFhmDwXy，与 CLI 产出的插件文件名一致。
 * 有了它，插件文件名可由 protocol.json 推导，不必在镜像里写死。
 */
export function vmIdFromChainName(name) {
  const b = Buffer.alloc(32);
  const raw = Buffer.from(name, 'utf8');
  if (raw.length > 32) throw new Error(`chain name "${name}" exceeds 32 bytes`);
  raw.copy(b, 0);
  return cb58Encode(b);
}

/** PEM 证书 → DER 字节。 */
export function pemToDer(pem) {
  const m = pem.replace(/\r/g, '').match(/-----BEGIN CERTIFICATE-----\n([\s\S]+?)\n-----END CERTIFICATE-----/);
  if (!m) throw new Error('not a PEM certificate');
  return Buffer.from(m[1].replace(/\n/g, ''), 'base64');
}

/**
 * 由 staker.crt 派生 NodeID。
 * @param {string|Buffer} pem 证书内容
 * @returns {string} 形如 NodeID-7SEb6yKycVKCyJF79RELEUWYcq6Zt5V59
 */
export function nodeIdFromCert(pem) {
  const der = pemToDer(typeof pem === 'string' ? pem : pem.toString('utf8'));
  return `NodeID-${cb58Encode(ripemd160(sha256(der)))}`;
}

/**
 * 由 signer.key（32 字节裸 BLS 私钥）派生 BLS 公钥。
 * @param {Buffer} key
 * @returns {string} 0x 前缀的 48 字节压缩 G1 点（96 个十六进制字符）
 */
export function blsPublicKeyFromSignerKey(key) {
  if (key.length !== 32) throw new Error(`signer.key must be 32 bytes, got ${key.length}`);
  return `0x${Buffer.from(bls12_381.getPublicKey(key)).toString('hex')}`;
}

/**
 * 读取一个验证者密钥目录，派生其身份。
 * @param {string} keyDir 形如 blockchain/validators/dev/node-1/（相对仓库根）
 */
export function identityFromKeyDir(keyDir) {
  const dir = resolve(REPO_ROOT, keyDir);
  return {
    keyDir,
    nodeId: nodeIdFromCert(readFileSync(resolve(dir, 'staker.crt'), 'utf8')),
    blsPublicKey: blsPublicKeyFromSignerKey(readFileSync(resolve(dir, 'signer.key'))),
  };
}

/**
 * 一个验证者的身份 —— **创世成员从本地密钥派生，创世后加入的凭声明的公开材料**。
 *
 * ## 为什么需要两条路
 *
 * `identityFromKeyDir()` 读 `signer.key`（**BLS 私钥**）来派生公钥。对创世那五个
 * 没问题：它们的密钥按宪法第四条 v1.1.0 的例外提交在仓库里。
 *
 * 但功能 005 的安全约束对**新**验证者更严：私钥**必须在目标机器上生成、
 * 不得经过仓库、对话或任何中间环节**，只有公开材料参与注册。
 * 所以创世后加入的成员，仓库里根本没有它的 `signer.key` —— 派生这条路走不通。
 *
 * ## 声明里放什么（全部是公开材料）
 *
 *   nodeId / blsPublicKey     —— 注册时链上要的就是这两样
 *   certSha256                —— 证书本身是公开的
 *   keySha256 / signerSha256  —— **私钥文件的 sha256 指纹，不是私钥**
 *
 * 后两个为什么可以放：`docker/node/entrypoint.sh` 的 `check_key_material()`
 * 会把三个文件的 sha256 逐一比对，**字段缺了 `jq` 返回 null、直接退出 12**。
 * 另一条路是给入口加一条"字段不存在就跳过"的分支 —— 那是静默关掉守卫的典型做法。
 * 取指纹这条：完整性校验保持统一、不加分支，而私钥一步都不离开那台机器。
 * 32 字节熵的秘密，公开它的 sha256 只能用来**核对一个猜测**，不构成可行攻击。
 *
 * @param {object} v `validators.nodes[]` 里的一项
 */
export function identityOf(v) {
  if (v.identity) {
    // `proofOfPossession` 也在必需之列：P 链的 `RegisterL1ValidatorTx` 要它
    // （avalanchejs 的 `newRegisterL1ValidatorTx` 有一个 `blsSignature` 参数）。
    // 当初把它列为"只为留档"是个失误 —— 少了它会通过这里，而在注册第三步才炸，
    // 那时已经走到花钱的那一步了。
    const missing = ['nodeId', 'blsPublicKey', 'proofOfPossession', 'certSha256', 'keySha256', 'signerSha256']
      .filter((k) => !v.identity[k]);
    if (missing.length) {
      throw new Error(`validators.nodes[${v.index}].identity 缺字段：${missing.join(', ')} —— `
        + '创世后加入的成员必须把全部公开材料一次报齐，否则渲染出的身份制品是半份的');
    }
    return { ...v.identity, keyDir: v.keyDir, derived: false };
  }
  return { ...identityFromKeyDir(v.keyDir), derived: true };
}

/**
 * 声明里的**创世**验证者 —— 建链制品（`karmachain.identity.json` 的
 * `bootstrapValidators`）记录的是链的**出生**，只有这些该出现在其中。
 *
 * 功能 005 之前这个函数不存在，因为"声明的成员"与"创世的成员"是同一批。
 * 之后成员运行期可变，两者分开了 —— 而**把它们当成同一批的代码会静默出错**：
 * 拿 6 个声明成员去和 5 条制品记录比数量，报出来的是"建链制品与声明不符"，
 * 而真实情况是"链后来多了一个成员，制品理应不含它"。
 *
 * **判据是显式声明的 `origin`，不是"制品里查不到"** —— 理由见 crossCheckIdentity。
 */
export function genesisValidators(validatorNodes) {
  return validatorNodes.filter((v) => v.identity?.origin !== 'joined');
}

/** 声明里**创世之后加入**的成员。它们的身份凭公开材料声明，见 identityOf。 */
export function joinedValidators(validatorNodes) {
  return validatorNodes.filter((v) => v.identity?.origin === 'joined');
}

/**
 * 交叉校验建链制品与密钥材料是否同源（FR-017）。
 * @returns {string[]} 不匹配的说明；空数组 = 全部同源
 */
export function crossCheckIdentity(identityArtifact, validatorNodes) {
  const problems = [];
  const byNodeId = new Map(identityArtifact.bootstrapValidators.map((v) => [v.nodeId, v]));

  for (const v of validatorNodes) {
    // 创世**之后**加入的成员：这份制品里永远不会有它 —— 它记录的是链的**出生**，
    // 不是当前成员。所以这里跳过，改由「链上实际成员」那条比对来验
    // （tools/membership/member-set.mjs，data-model 第 2 节的三种漂移）。
    //
    // **必须靠显式声明判断，不能靠"制品里查不到就当成新成员"** ——
    // 那样一来，创世成员的材料被换掉时（证书打错、密钥目录指错），
    // 派生出的 NodeID 查不到，就会被当成"新加入的"而静默放行。
    // 下方"制品里还剩谁"那一轮是这条的兜底：五个创世成员必须被逐个认领。
    if (v.identity?.origin === 'joined') continue;

    let derived;
    try {
      derived = identityFromKeyDir(v.keyDir);
    } catch (err) {
      problems.push(`${v.keyDir}: ${err.message}`);
      continue;
    }
    const entry = byNodeId.get(derived.nodeId);
    if (!entry) {
      problems.push(`${v.keyDir} derives ${derived.nodeId}, which is not in the artifact's bootstrapValidators`);
      continue;
    }
    if (entry.blsPublicKey.toLowerCase() !== derived.blsPublicKey.toLowerCase()) {
      problems.push(`${v.keyDir}: BLS public key mismatch — signer.key derives ${derived.blsPublicKey}, artifact has ${entry.blsPublicKey}`);
    }
    byNodeId.delete(derived.nodeId);
  }

  // 兜底：制品里的每个创世验证者都必须被某个声明认领。
  // 少认领一个，说明要么有人删了声明，要么某个创世成员的材料被换掉了 ——
  // 后者若只看上一轮，会因为"查不到"而看起来像新成员。
  for (const leftover of byNodeId.keys()) {
    problems.push(`artifact lists ${leftover}, but no validator key directory derives it`);
  }
  return problems;
}
