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
 * 交叉校验建链制品与密钥材料是否同源（FR-017）。
 * @returns {string[]} 不匹配的说明；空数组 = 全部同源
 */
export function crossCheckIdentity(identityArtifact, validatorNodes) {
  const problems = [];
  const byNodeId = new Map(identityArtifact.bootstrapValidators.map((v) => [v.nodeId, v]));

  for (const v of validatorNodes) {
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

  for (const leftover of byNodeId.keys()) {
    problems.push(`artifact lists ${leftover}, but no validator key directory derives it`);
  }
  return problems;
}
