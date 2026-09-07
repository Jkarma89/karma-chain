// T013：身份交叉校验 —— 仓库里的 staking 材料必须与建链制品同源（data-model §5、FR-017）。
//
// 这组测试同时是 tools/verify/lib/identity.mjs 的正确性证明：派生算法的输出与
// 一次真实建链产出的 NodeID / BLS 公钥逐一比对，5 组全中才算实现正确。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadProtocol, readJson, REPO_ROOT } from '../../tools/protocol/load.mjs';
import {
  identityFromKeyDir, nodeIdFromCert, blsPublicKeyFromSignerKey,
  crossCheckIdentity, base58Encode, cb58Encode, pemToDer,
} from '../../tools/verify/lib/identity.mjs';

const P = loadProtocol();
const IDENTITY = readJson(resolve(REPO_ROOT, 'blockchain/chain-identity/karmachain.identity.json'));

describe('身份派生（对照真实建链的已知值）', () => {
  test('5 个密钥目录派生出的 NodeID 全部命中制品', () => {
    const inArtifact = new Set(IDENTITY.bootstrapValidators.map((v) => v.nodeId));
    for (const v of P.validators.nodes) {
      const { nodeId } = identityFromKeyDir(v.keyDir);
      assert.match(nodeId, /^NodeID-[1-9A-HJ-NP-Za-km-z]+$/, `${v.keyDir} 派生出的 NodeID 格式不对`);
      assert.ok(inArtifact.has(nodeId), `${v.keyDir} 派生出 ${nodeId}，但制品中没有`);
    }
  });

  test('5 个 signer.key 派生出的 BLS 公钥与制品逐一相等', () => {
    const byId = new Map(IDENTITY.bootstrapValidators.map((v) => [v.nodeId, v]));
    for (const v of P.validators.nodes) {
      const { nodeId, blsPublicKey } = identityFromKeyDir(v.keyDir);
      assert.equal(blsPublicKey, byId.get(nodeId).blsPublicKey, `${v.keyDir} 的 BLS 公钥与制品不符`);
      assert.match(blsPublicKey, /^0x[0-9a-f]{96}$/, 'BLS 公钥应为 48 字节压缩 G1 点');
    }
  });

  test('crossCheckIdentity 在全部同源时返回空', () => {
    assert.deepEqual(crossCheckIdentity(IDENTITY, P.validators.nodes), []);
  });
});

describe('Primary Network 节点身份', () => {
  const PRIMARY_GENESIS = readJson(resolve(REPO_ROOT, 'blockchain/chain-identity/primary-network.genesis.json'));
  const primaries = P.topology.nodes.filter((n) => n.role === 'primary');

  test('每个 primary 节点都声明了 keyDir', () => {
    assert.equal(primaries.length, P.primaryNetwork.nodeCount);
    for (const n of primaries) assert.match(n.keyDir, /^blockchain\/validators\//);
  });

  // primary-network.genesis.json 的 initialStakers 把 NodeID 钉死在创世里。
  // 拿不到对应的 staking 材料就复现不出这些 NodeID，主网络起不来 —— 这是 001 依赖
  // Avalanche CLI 内联注入、而 002 必须显式化的那部分（研究 R-03）。
  test('派生出的 NodeID 与创世 initialStakers 逐一对应', () => {
    const inGenesis = new Set(PRIMARY_GENESIS.initialStakers.map((s) => s.nodeID));
    assert.equal(inGenesis.size, primaries.length);
    for (const n of primaries) {
      const { nodeId } = identityFromKeyDir(n.keyDir);
      assert.ok(inGenesis.has(nodeId), `${n.keyDir} 派生出 ${nodeId}，不在创世 initialStakers 中`);
    }
  });

  test('派生出的 BLS 公钥与创世声明一致', () => {
    const byId = new Map(PRIMARY_GENESIS.initialStakers.map((s) => [s.nodeID, s]));
    for (const n of primaries) {
      const { nodeId, blsPublicKey } = identityFromKeyDir(n.keyDir);
      assert.equal(blsPublicKey, byId.get(nodeId).signer.publicKey, `${n.keyDir} 的 BLS 公钥与创世不符`);
    }
  });

  test('Primary 与 L1 验证者的身份材料互不重用', () => {
    const l1 = new Set(P.validators.nodes.map((v) => identityFromKeyDir(v.keyDir).nodeId));
    for (const n of primaries) {
      assert.ok(!l1.has(identityFromKeyDir(n.keyDir).nodeId), `${n.keyDir} 与某个 L1 验证者共用了身份`);
    }
  });
});

describe('crossCheckIdentity 能抓住不同源', () => {
  test('制品中的 NodeID 被篡改 → 报出多出的与找不到的', () => {
    const bad = JSON.parse(JSON.stringify(IDENTITY));
    bad.bootstrapValidators[0].nodeId = 'NodeID-111111111111111111116DBWJs';
    const problems = crossCheckIdentity(bad, P.validators.nodes);
    assert.ok(problems.length >= 2, `应当同时报出两侧的问题，实际：${problems.join('; ')}`);
    assert.ok(problems.some((x) => x.includes('not in the artifact')));
    assert.ok(problems.some((x) => x.includes('no validator key directory derives it')));
  });

  test('BLS 公钥被篡改 → 精确指出是哪个密钥目录', () => {
    const bad = JSON.parse(JSON.stringify(IDENTITY));
    bad.bootstrapValidators[0].blsPublicKey = `0x${'ab'.repeat(48)}`;
    const problems = crossCheckIdentity(bad, P.validators.nodes);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /BLS public key mismatch/);
    assert.match(problems[0], /blockchain\/validators\/dev\/node-\d\//);
  });

  test('密钥目录不存在 → 报出该目录而非崩溃', () => {
    const problems = crossCheckIdentity(IDENTITY, [{ keyDir: 'blockchain/validators/dev/node-99/' }, ...P.validators.nodes]);
    assert.ok(problems.some((x) => x.includes('node-99')));
  });
});

describe('编码原语', () => {
  test('base58 前导零字节编码为 1', () => {
    assert.equal(base58Encode(Buffer.from([0, 0, 1])), '112');
    assert.equal(base58Encode(Buffer.from([0])), '1');
  });

  test('cb58 在 payload 后附加 sha256 校验和的后 4 字节', () => {
    const payload = Buffer.alloc(20, 0);
    const encoded = cb58Encode(payload);
    // 20 字节全零 + 4 字节校验和 → 前 20 个字符应为 '1'
    assert.ok(encoded.startsWith('1'.repeat(20)), `意外的编码：${encoded}`);
  });

  test('pemToDer 拒绝非证书内容', () => {
    assert.throws(() => pemToDer('not a pem'), /not a PEM certificate/);
  });

  test('signer.key 长度不是 32 字节时拒绝', () => {
    assert.throws(() => blsPublicKeyFromSignerKey(Buffer.alloc(31)), /must be 32 bytes/);
  });

  test('nodeIdFromCert 对同一证书稳定（重启后身份不变的基础，FR-016）', () => {
    const pem = readFileSync(resolve(REPO_ROOT, P.validators.nodes[0].keyDir, 'staker.crt'), 'utf8');
    assert.equal(nodeIdFromCert(pem), nodeIdFromCert(pem));
  });
});
