// T007：protocol.json 的 schema 与业务约束测试。
// 每一条 data-model.md §1 约束都有一个"违例样本必须失败"的用例。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadProtocol,
  validateProtocol,
  validateSchema,
  validateConstraints,
  derive,
  readJson,
  DEFAULT_PROTOCOL_PATH,
  DEFAULT_SCHEMA_PATH,
  RPC_CHAIN_VM_PROTOCOL,
} from '../../tools/protocol/load.mjs';

const schema = readJson(DEFAULT_SCHEMA_PATH);
const good = readJson(DEFAULT_PROTOCOL_PATH);

/** 深拷贝后应用一次变更，返回违例样本。 */
function mutate(fn) {
  const copy = structuredClone(good);
  fn(copy);
  return copy;
}

function expectConstraintFailure(sample, needle) {
  assert.deepEqual(validateSchema(sample, schema), [], 'sample must still be schema-valid so the constraint layer is what fails');
  const errors = validateConstraints(sample);
  assert.ok(errors.length > 0, 'expected at least one constraint error');
  assert.ok(errors.some((e) => e.includes(needle)), `expected an error mentioning "${needle}", got:\n${errors.join('\n')}`);
}

function expectSchemaFailure(sample, needle) {
  const errors = validateSchema(sample, schema);
  assert.ok(errors.length > 0, 'expected schema errors');
  assert.ok(errors.some((e) => e.includes(needle)), `expected a schema error mentioning "${needle}", got:\n${errors.join('\n')}`);
}

describe('committed protocol.json', () => {
  test('passes schema and all constraints', () => {
    const result = validateProtocol(good, schema);
    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);
  });

  test('loadProtocol returns a frozen object with the agreed identity', () => {
    const p = loadProtocol();
    assert.ok(Object.isFrozen(p));
    assert.equal(p.chain.chainId, 20189);
    assert.equal(p.chain.reservedMainnetChainId, 20188);
    assert.equal(p.avalanche.networkId, 1337);
    assert.equal(p.nativeToken.symbol, 'KARMA');
    assert.equal(p.validators.count, 5);
    assert.equal(p.environment, 'dev');
  });

  test('derived values are consistent', () => {
    const d = derive(good);
    assert.equal(d.chainIdHex, '0x4edd');
    assert.equal(d.rpcUrl, 'http://127.0.0.1:8545/ext/bc/karmachain/rpc');
    assert.equal(d.wsUrl, 'ws://127.0.0.1:8545/ext/bc/karmachain/ws');
    assert.equal(d.totalNodeCount, 7);
    // ewoq 1M + anvil-0 1M + anvil-1 10M + anvil-2 7.5M + anvil-3 10M + anvil-4 10M（configVersion 1.1.0）
    assert.equal(d.initialSupplyTokens, 39_500_000n);
    assert.equal(BigInt(good.devAccounts[0].balanceWei), 10n ** 24n);   // ewoq = 1,000,000 KARMA
  });

  test('version compatibility table agrees with the chosen versions', () => {
    const { avalanchegoVersion, subnetEvmVersion, rpcChainVmProtocol } = good.avalanche;
    assert.equal(RPC_CHAIN_VM_PROTOCOL.avalanchego[avalanchegoVersion], rpcChainVmProtocol);
    assert.equal(RPC_CHAIN_VM_PROTOCOL.subnetEvm[subnetEvmVersion], rpcChainVmProtocol);
  });
});

describe('schema layer rejects', () => {
  test('unknown top-level key', () => {
    expectSchemaFailure(mutate((p) => { p.extra = 1; }), 'additional properties');
  });
  test('non-dev environment', () => {
    expectSchemaFailure(mutate((p) => { p.environment = 'prod'; }), 'allowed values');
  });
  test('real network id (mainnet=1)', () => {
    expectSchemaFailure(mutate((p) => { p.avalanche.networkId = 1; }), '/avalanche/networkId');
  });
  test('token decimals other than 18', () => {
    expectSchemaFailure(mutate((p) => { p.nativeToken.decimals = 6; }), '/nativeToken/decimals');
  });
  test('lowercase token symbol', () => {
    expectSchemaFailure(mutate((p) => { p.nativeToken.symbol = 'karma'; }), '/nativeToken/symbol');
  });
  test('malformed address', () => {
    expectSchemaFailure(mutate((p) => { p.devAccounts[0].address = '0x1234'; }), '/devAccounts/0/address');
  });
  test('decimal balance instead of 0x hex', () => {
    expectSchemaFailure(mutate((p) => { p.devAccounts[0].balanceWei = '1000000'; }), '/devAccounts/0/balanceWei');
  });
  test('missing feeConfig field', () => {
    expectSchemaFailure(mutate((p) => { delete p.feeConfig.gasLimit; }), 'gasLimit');
  });
});

describe('constraint layer rejects', () => {
  test('chainId equal to reserved mainnet id', () => {
    expectConstraintFailure(mutate((p) => { p.chain.chainId = 20188; }), 'reservedMainnetChainId');
  });
  test('avalanchego / subnet-evm protocol mismatch', () => {
    expectConstraintFailure(mutate((p) => { p.avalanche.avalanchegoVersion = 'v1.14.2'; }), 'protocol mismatch');
  });
  test('rpcChainVmProtocol not matching the table', () => {
    expectConstraintFailure(mutate((p) => { p.avalanche.rpcChainVmProtocol = 45; }), 'rpcChainVmProtocol');
  });
  test('unknown avalanchego version', () => {
    expectConstraintFailure(mutate((p) => { p.avalanche.avalanchegoVersion = 'v9.9.9'; }), 'compatibility table');
  });
  test('targetBlockRateSeconds != feeConfig.targetBlockRate', () => {
    expectConstraintFailure(mutate((p) => { p.blockProduction.targetBlockRateSeconds = 5; }), 'targetBlockRate');
  });
  test('validators.count != nodes.length', () => {
    expectConstraintFailure(mutate((p) => { p.validators.count = 4; }), 'validators.count');
  });
  test('non-contiguous node indexes', () => {
    expectConstraintFailure(mutate((p) => { p.validators.nodes[4].index = 7; }), 'index must be 1..count');
  });
  test('keyDir not matching node index', () => {
    expectConstraintFailure(mutate((p) => { p.validators.nodes[1].keyDir = 'blockchain/validators/dev/node-9/'; }), 'keyDir');
  });
  test('duplicate validator ports', () => {
    expectConstraintFailure(mutate((p) => { p.validators.nodes[1].httpPort = 9660; }), 'unique');
  });
  test('validator port colliding with reserved container port', () => {
    expectConstraintFailure(mutate((p) => { p.validators.nodes[0].httpPort = 9650; }), 'reserved container port');
  });
  test('duplicate devAccount label', () => {
    expectConstraintFailure(mutate((p) => { p.devAccounts[1].label = 'ewoq'; }), 'label must be unique');
  });
  test('duplicate devAccount address (case-insensitive)', () => {
    expectConstraintFailure(mutate((p) => { p.devAccounts[1].address = p.devAccounts[0].address.toLowerCase(); }), 'address must be unique');
  });
  test('non-checksummed address', () => {
    expectConstraintFailure(mutate((p) => { p.devAccounts[1].address = p.devAccounts[1].address.toLowerCase(); }), 'EIP-55');
  });
  test('ownerAccount not a known label', () => {
    expectConstraintFailure(mutate((p) => { p.validators.ownerAccount = 'nobody'; }), 'ownerAccount');
  });
  test('rpcPath not derived from blockchainName', () => {
    expectConstraintFailure(mutate((p) => { p.endpoints.rpcPath = '/ext/bc/other/rpc'; }), 'rpcPath');
  });
});

test('loadProtocol throws with all errors listed for an invalid file', () => {
  const bad = mutate((p) => { p.chain.chainId = 20188; p.validators.ownerAccount = 'nobody'; });
  const { errors } = validateProtocol(bad, schema);
  assert.equal(errors.length, 2);
  assert.ok(errors.every((e) => e.startsWith('constraint: ')));
});
