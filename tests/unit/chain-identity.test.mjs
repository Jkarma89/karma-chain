// T011：建链制品（blockchain/chain-identity/）的正确性与提取器行为。
// 制品是「第二类事实」——建链动作的产物，不是协议参数。它必须与 protocol.json 同源，
// 否则运行期会带着错误的链身份启动（FR-017）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadProtocol, readJson, REPO_ROOT } from '../../tools/protocol/load.mjs';
import { extractIdentity, validateIdentity } from '../../tools/protocol/extract-identity.mjs';
import { extractPrimaryGenesis } from '../../tools/protocol/extract-primary-genesis.mjs';

const P = loadProtocol();
const IDENTITY = readJson(resolve(REPO_ROOT, 'blockchain/chain-identity/karmachain.identity.json'));
const PRIMARY_GENESIS = readJson(resolve(REPO_ROOT, 'blockchain/chain-identity/primary-network.genesis.json'));
const SIDECAR_FIXTURE = readJson(resolve(REPO_ROOT, 'tests/fixtures/002/measured-sidecar.json'));
const PRIMARY_FIXTURE = readJson(resolve(REPO_ROOT, 'tests/fixtures/002/measured-primary-genesis.json'));

describe('chain-identity 制品', () => {
  test('符合 chain-identity.schema.json', () => {
    assert.deepEqual(validateIdentity(IDENTITY), []);
  });

  test('标记为生成物，禁止手改', () => {
    assert.match(IDENTITY.$comment, /^GENERATED/);
  });

  test('与 protocol.json 交叉一致：版本、协议号、网络', () => {
    assert.equal(IDENTITY.vmVersion, P.avalanche.subnetEvmVersion);
    assert.equal(IDENTITY.rpcVersion, P.avalanche.rpcChainVmProtocol);
    assert.equal(IDENTITY.networkId, P.avalanche.networkId);
    assert.equal(IDENTITY.vm, 'Subnet-EVM');
  });

  test('链别名等于对外公布的 RPC 路径中的那一段', () => {
    assert.equal(IDENTITY.chainAlias, P.chain.blockchainName);
    assert.ok(P.endpoints.rpcPath.includes(`/${IDENTITY.chainAlias}/`),
      `endpoints.rpcPath (${P.endpoints.rpcPath}) 必须包含链别名 ${IDENTITY.chainAlias}`);
  });

  test('引导验证者数量等于 validators.count', () => {
    assert.equal(IDENTITY.bootstrapValidators.length, P.validators.count);
  });

  test('引导验证者必须等权 —— 容错上限的推导以此为前提', () => {
    const weights = new Set(IDENTITY.bootstrapValidators.map((v) => v.weight));
    assert.equal(weights.size, 1, `权重不一致：${[...weights].join(', ')}`);
  });

  test('NodeID 与 BLS 公钥两两不重复', () => {
    const ids = IDENTITY.bootstrapValidators.map((v) => v.nodeId);
    const keys = IDENTITY.bootstrapValidators.map((v) => v.blsPublicKey);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(new Set(keys).size, keys.length);
  });
});

describe('primary-network 创世制品', () => {
  test('networkID 与 initialStakers 数量与 protocol.json 一致', () => {
    assert.equal(PRIMARY_GENESIS.networkID, P.avalanche.networkId);
    assert.equal(PRIMARY_GENESIS.initialStakers.length, P.primaryNetwork.nodeCount);
  });

  test('initialStakers 的 NodeID 不重复，且与 L1 验证者集合不相交', () => {
    const primary = PRIMARY_GENESIS.initialStakers.map((s) => s.nodeID);
    assert.equal(new Set(primary).size, primary.length);
    const l1 = new Set(IDENTITY.bootstrapValidators.map((v) => v.nodeId));
    for (const id of primary) assert.ok(!l1.has(id), `${id} 同时出现在 Primary 与 L1 验证者集合中`);
  });
});

describe('提取器', () => {
  test('从实测 sidecar 提取出的制品符合 schema', () => {
    const got = extractIdentity(SIDECAR_FIXTURE, P, { createdAt: '2026-09-05T15:47:51Z' });
    assert.deepEqual(validateIdentity(got), []);
  });

  test('建链是确定性的：故障前的 sidecar 与当前制品身份一致', () => {
    // 卷被删除并重建 3 次（跨天），SubnetID / BlockchainID / ValidationID 全部不变。
    // 见 research.md R-04 的实测修正。
    const got = extractIdentity(SIDECAR_FIXTURE, P, { createdAt: IDENTITY.createdAt });
    assert.equal(got.subnetId, IDENTITY.subnetId);
    assert.equal(got.blockchainId, IDENTITY.blockchainId);
    assert.deepEqual(got.bootstrapValidators, IDENTITY.bootstrapValidators);
  });

  test('sidecar 与 protocol.json 不同源时拒绝提取，并列出全部不符项', () => {
    const bad = JSON.parse(JSON.stringify(SIDECAR_FIXTURE));
    bad.VMVersion = 'v0.7.0';
    bad.Networks['Local Network'].BootstrapValidators.pop();
    assert.throws(() => extractIdentity(bad, P), (err) => {
      assert.match(err.message, /VM version/);
      assert.match(err.message, /bootstrap validators/);
      return true;
    });
  });

  test('引导验证者权重不等时拒绝提取', () => {
    const bad = JSON.parse(JSON.stringify(SIDECAR_FIXTURE));
    bad.Networks['Local Network'].BootstrapValidators[0].Weight = 200;
    assert.throws(() => extractIdentity(bad, P), /equal-weight/);
  });

  test('网络名不存在时报错并列出可用项', () => {
    assert.throws(() => extractIdentity(SIDECAR_FIXTURE, P, { network: 'Mainnet' }), /available: Local Network/);
  });

  test('Primary 创世提取器能解 base64 并交叉校验', () => {
    const b64 = Buffer.from(JSON.stringify(PRIMARY_FIXTURE)).toString('base64');
    const got = extractPrimaryGenesis({ 'genesis-file-content': b64 }, P);
    assert.equal(got.networkID, P.avalanche.networkId);
    assert.equal(got.initialStakers.length, P.primaryNetwork.nodeCount);
  });

  test('Primary 创世的 networkID 不符时拒绝', () => {
    const wrong = { ...PRIMARY_FIXTURE, networkID: 9999 };
    const b64 = Buffer.from(JSON.stringify(wrong)).toString('base64');
    assert.throws(() => extractPrimaryGenesis({ 'genesis-file-content': b64 }, P), /networkID/);
  });

  test('flags 缺少 genesis-file-content 时报错', () => {
    assert.throws(() => extractPrimaryGenesis({ 'network-id': String(P.avalanche.networkId) }, P), /genesis-file-content/);
  });
});
