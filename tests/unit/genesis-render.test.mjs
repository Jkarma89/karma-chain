// T015：创世生成器测试 —— 幂等、漂移、与 protocol.json 逐项对应、fixture 完整保留、时间常量固定。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  renderGenesis, serializeGenesis, renderGenesisText, checkGenesis,
  GENESIS_TIMESTAMP, FIXTURE_PATH, GENESIS_PATH,
} from '../../tools/protocol/render-genesis.mjs';
import { loadProtocol, readJson } from '../../tools/protocol/load.mjs';

const protocol = loadProtocol();
const fixture = readJson(FIXTURE_PATH);
const genesis = renderGenesis(protocol, fixture);
const noHex = (a) => a.toLowerCase().replace(/^0x/, '');

describe('determinism', () => {
  test('rendering twice yields byte-identical output', () => {
    assert.equal(renderGenesisText(), renderGenesisText());
    assert.equal(serializeGenesis(renderGenesis(protocol, fixture)), serializeGenesis(genesis));
  });

  test('committed karmachain.genesis.json matches render(protocol.json, fixture) — no drift', () => {
    const { same, expected, actual } = checkGenesis(GENESIS_PATH);
    assert.ok(actual !== null, `committed genesis missing at ${GENESIS_PATH}; run: npm run protocol:render`);
    if (!same) {
      const h = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);
      assert.fail(`genesis drift (committed ${h(actual)} vs rendered ${h(expected)}); run: npm run protocol:render`);
    }
  });

  test('all time fields are the fixed GENESIS_TIMESTAMP (no wall-clock leakage)', () => {
    assert.equal(parseInt(genesis.timestamp, 16), GENESIS_TIMESTAMP);
    assert.equal(genesis.config.warpConfig.blockTimestamp, GENESIS_TIMESTAMP);
    assert.equal(GENESIS_TIMESTAMP, Date.UTC(2026, 8, 1) / 1000);
  });

  test('alloc keys are lowercase, un-prefixed and sorted', () => {
    const keys = Object.keys(genesis.alloc);
    assert.deepEqual(keys, [...keys].sort());
    for (const k of keys) assert.match(k, /^[0-9a-f]{40}$/);
  });
});

describe('protocol.json → genesis mapping', () => {
  test('chainId and gasLimit', () => {
    assert.equal(genesis.config.chainId, protocol.chain.chainId);
    assert.equal(parseInt(genesis.gasLimit, 16), protocol.feeConfig.gasLimit);
  });

  test('feeConfig copied field-by-field', () => {
    assert.deepEqual(genesis.config.feeConfig, protocol.feeConfig);
  });

  test('allowFeeRecipients omitted when false (fees burned), present when true', () => {
    assert.equal(protocol.allowFeeRecipients, false);
    assert.equal('allowFeeRecipients' in genesis.config, false);
    const alt = renderGenesis({ ...protocol, allowFeeRecipients: true }, fixture);
    assert.equal(alt.config.allowFeeRecipients, true);
  });

  test('every dev account is allocated exactly its balanceWei', () => {
    for (const acct of protocol.devAccounts) {
      const entry = genesis.alloc[noHex(acct.address)];
      assert.ok(entry, `missing alloc for ${acct.label}`);
      assert.equal(BigInt(entry.balance), BigInt(acct.balanceWei));
      assert.equal(entry.code, undefined, 'dev accounts must not carry code');
    }
  });

  test('sum of dev balances equals 6,000,000 KARMA', () => {
    const total = protocol.devAccounts.reduce((s, a) => s + BigInt(genesis.alloc[noHex(a.address)].balance), 0n);
    assert.equal(total, 6_000_000n * 10n ** 18n);
  });

  test('all hard forks active from block 0', () => {
    for (const k of ['homesteadBlock', 'eip150Block', 'eip155Block', 'eip158Block', 'byzantiumBlock', 'constantinopleBlock', 'petersburgBlock', 'istanbulBlock', 'muirGlacierBlock', 'berlinBlock', 'londonBlock']) {
      assert.equal(genesis.config[k], 0, k);
    }
  });
});

describe('fixture (ValidatorManager contracts) preserved', () => {
  test('every fixture account is present with identical code/storage/nonce and zero balance', () => {
    for (const [addr, entry] of Object.entries(fixture.alloc)) {
      const out = genesis.alloc[noHex(addr)];
      assert.ok(out, `fixture account ${addr} missing`);
      assert.equal(out.code, entry.code);
      assert.equal(out.nonce, entry.nonce ?? '0x1');
      assert.deepEqual(out.storage, entry.storage);
      assert.equal(out.balance, '0x0');
    }
  });

  test('fixture has the 4 expected contract accounts and warp config', () => {
    assert.equal(Object.keys(fixture.alloc).length, 4);
    assert.ok(fixture.alloc['0c0deba5e0000000000000000000000000000000'], 'ValidatorManager proxy/logic slot');
    assert.equal(fixture.warpConfig.quorumNumerator, 67);
    assert.equal(fixture.warpConfig.requirePrimaryNetworkSigners, true);
    assert.equal(fixture.extractedFrom.avalancheCliVersion, protocol.avalanche.avalancheCliVersion);
  });

  test('a fixture contract colliding with a dev account is rejected', () => {
    const bad = structuredClone(fixture);
    bad.alloc[protocol.devAccounts[0].address] = { code: '0x00', balance: '0x0' };
    assert.throws(() => renderGenesis(protocol, bad), /collides/);
  });
});
