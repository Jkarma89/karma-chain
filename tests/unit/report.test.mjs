// T038：验证报告的结构契约 —— 必须通过 contracts/verification-report.schema.json，
// 且"失败项必须带 FR-030 类别"这条规则必须真的被强制。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { REPO_ROOT, loadProtocol, derive } from '../../tools/protocol/load.mjs';
import { Report, STATUS } from '../../tools/verify/lib/report.mjs';
import { ALL_CATEGORIES, CATEGORIES, categorizeError } from '../../tools/verify/lib/categories.mjs';
import { REQUIRED_RPC_METHODS } from '../../tools/verify/checks/chain.mjs';

// 样例数据一律从 protocol.json 派生，避免在测试里复写协议字面量（SC-007）
const protocol = loadProtocol();
const derived = derive(protocol);

const SCHEMA_PATH = resolve(REPO_ROOT, 'specs/001-local-avalanche-devnet/contracts/verification-report.schema.json');
// 功能 002 在 001 的契约上追加了检查项；基线不改写，增量单独声明后在此合并。
const ADDITIONS_PATH = resolve(REPO_ROOT, 'specs/002-resilient-validator-network/contracts/verification-report.additions.json');
export const CHECK_IDS = (() => {
  const base = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  const added = JSON.parse(readFileSync(ADDITIONS_PATH, 'utf8')).addedCheckIds ?? [];
  return [...base.properties.checks.items.properties.id.enum, ...added];
})();

const validate = (() => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  schema.properties.checks.items.properties.id.enum = CHECK_IDS;
  return ajv.compile(schema);
})();

const assertValid = (json, label) => {
  const ok = validate(json);
  assert.ok(ok, `${label} violates the report schema: ${JSON.stringify(validate.errors)}`);
};

/** 关闭彩色输出并吞掉逐项打印，避免污染测试输出。 */
function quietReport() {
  const report = new Report({ rpcUrl: derived.rpcUrl });
  const log = console.log;
  console.log = () => {};
  return { report, restore: () => { console.log = log; } };
}

describe('verification report', () => {
  test('a passing report validates against the contract schema', () => {
    const { report, restore } = quietReport();
    try {
      report.add({ id: 'rpc', status: STATUS.OK, detail: 'ok' });
      report.add({ id: 'chain-id', status: STATUS.OK, detail: String(protocol.chain.chainId) });
      report.add({ id: 'rpc-methods', status: STATUS.UNSUPPORTED, detail: 'x unsupported', data: { methods: [] } });
      report.add({ id: 'node', status: STATUS.SKIP, detail: 'not reachable' });
      report.setSummary({ chainId: protocol.chain.chainId, networkId: protocol.avalanche.networkId, blockHeight: 4 });
    } finally { restore(); }
    const json = report.toJSON();
    assertValid(json, 'passing report');
    assert.equal(json.overall, 'ready', 'unsupported/skip alone must not fail the run');
    assert.equal(json.schemaVersion, 1);
    assert.equal(json.chainId, protocol.chain.chainId);
  });

  test('a failing report validates and reports overall=failed', () => {
    const { report, restore } = quietReport();
    try {
      report.add({ id: 'rpc', status: STATUS.FAIL, category: CATEGORIES.RPC, detail: 'connection refused' });
    } finally { restore(); }
    const json = report.toJSON();
    assertValid(json, 'failing report');
    assert.equal(json.overall, 'failed');
    assert.equal(json.checks[0].category, 'rpc');
  });

  test('a failing check without a valid category is rejected at the source (FR-030)', () => {
    const { report, restore } = quietReport();
    try {
      assert.throws(() => report.add({ id: 'node', status: STATUS.FAIL, detail: 'no category' }), /valid FR-030 category/);
      assert.throws(() => report.add({ id: 'node', status: STATUS.FAIL, category: 'made-up', detail: 'bad category' }), /valid FR-030 category/);
    } finally { restore(); }
  });

  test('schema rejects a fail entry with no category', () => {
    const bad = {
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      rpcUrl: derived.rpcUrl,
      overall: 'failed',
      checks: [{ id: 'rpc', status: 'fail', detail: 'boom' }],
    };
    assert.equal(validate(bad), false, 'schema must require category on failing checks');
  });

  test('category set matches the nine FR-030 categories', () => {
    assert.deepEqual([...ALL_CATEGORIES].sort(), ['configuration', 'evm', 'genesis', 'node', 'p2p', 'rpc', 'storage', 'transaction', 'validator']);
  });

  test('categorizeError maps common failures to sensible categories', () => {
    assert.equal(categorizeError(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })), CATEGORIES.RPC);
    assert.equal(categorizeError(new Error('the method anvil_setBalance does not exist/is not available')), CATEGORIES.RPC);
    assert.equal(categorizeError(new Error('execution reverted')), CATEGORIES.EVM);
    assert.equal(categorizeError(new Error('no space left on device')), CATEGORIES.STORAGE);
    assert.equal(categorizeError(new Error('nonce too low')), CATEGORIES.TRANSACTION);
  });

  test('the FR-012 method list is exactly the ten required methods', () => {
    assert.deepEqual(REQUIRED_RPC_METHODS, [
      'eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBlockByHash',
      'eth_getBalance', 'eth_getTransactionCount', 'eth_sendRawTransaction',
      'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_call',
    ]);
  });

  test('the last generated report (if any) is schema-valid and has 14 checks', () => {
    const path = resolve(REPO_ROOT, '.devnet/verify-report.json');
    if (!existsSync(path)) return;   // 未跑过验证器时跳过
    const json = JSON.parse(readFileSync(path, 'utf8'));
    assertValid(json, '.devnet/verify-report.json');
    assert.equal(json.checks.length, 14, 'the verifier must run all 14 checks (13 from 001 + fault-tolerance from 002)');
  });
});
