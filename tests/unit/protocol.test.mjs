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
  mergedSchema,
  RPC_CHAIN_VM_PROTOCOL,
} from '../../tools/protocol/load.mjs';

// 功能 005 之后，"一份完整的配置"来自**两个文件的合并** ——
// 协议参数（本文件校验的重点）与部署描述各住一份，由装载层合并成一个视图。
// 本套件校验的是**完整形状**上的业务约束（如 T-5 同时需要验证者数与边界划分），
// 所以用合并视图 + 合并 schema；而"分家是否干净"由
// tests/unit/deployment-split.test.mjs 守着，两者各管一段。
const schema = mergedSchema();
const good = loadProtocol();

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
    assert.equal(p.environment, 'dev');
    // **validators.count 不再列在这里。** 本组断言刻意双写「关键身份值」——
    // 改了它们就是另一条链，所以值得在测试里再写一遍防止事实来源被误改。
    // 但功能 005 之后成员是**运行期可变**的：加一个验证者不换链。
    // 继续写死一个数字，只会让每次成员变化都红在一条与被测性质无关的断言上。
    // 「声明的成员数与节点数一致」由 validateConstraints 保证（T-1），
    // 「创世成员数与建链制品一致」由 tests/unit/chain-identity.test.mjs 保证。
  });

  test('derived values are consistent', () => {
    const d = derive(good);
    assert.equal(d.chainIdHex, '0x4edd');
    assert.equal(d.rpcUrl, 'http://127.0.0.1:8545/ext/bc/karmachain/rpc');
    assert.equal(d.wsUrl, 'ws://127.0.0.1:8545/ext/bc/karmachain/ws');
    // 与**拓扑声明**交叉核对，不写死数字 —— derive() 走的是
    // validators.count + primaryNetwork.nodeCount，而 topology.nodes 是另一条路径，
    // 两者相等才说明派生没漂。写死 7 的话，加一个成员就红在这里。
    assert.equal(d.totalNodeCount, good.topology.nodes.length);
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
    expectConstraintFailure(mutate((p) => { p.validators.nodes[1].httpPort = p.validators.nodes[0].httpPort; }), 'unique');
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

// 005 / T021：理由列的惯例是"复述当前值再说为什么"（`primaryNetwork.nodeCount` →
// "2：…"、`validators.management` → "proof-of-authority：…"）。对**不会变**的参数，
// 这个惯例很好读。但 `validators.count` 从 005 起会随成员增删而变 ——
// 它的理由在实测中确实过期了：值已经是 6，理由还写着"5：…"，
// 而 T021 的离线测量（加第 7 台机器重新生成）会让它变成"5：" 挨着值 7。
// 只守这一个参数，而不是给整张理由表加一条通用规则：探针量过，
// 29 行里有 7 行的"不符"是千分位与单位造成的假阳性（"15,000,000" vs 15000000、
// "25 gwei" vs 25000000000）—— 恒定非空的告警等于没有告警。
test('随成员变化的参数，理由里不得复述当前值（否则必然过期）', () => {
  const { rationale } = readJson(
    new URL('../../blockchain/protocol-rationale.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  );
  const why = rationale['validators.count'];
  assert.equal(typeof why, 'string', 'validators.count 必须有理由');
  assert.doesNotMatch(
    why,
    /^\s*\d/,
    'validators.count 的理由不得以数字开头复述当前值 —— 成员一变它就过期（当前值见生成的表格）',
  );
});
