// devnet-contracts（tools/inspect/list-contracts.mjs）对运行中的链的行为。
// 需要开发网在运行；不可达时跳过。
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { publicClient, protocol, REPO_ROOT_HINT } from '../../tools/verify/lib/rpc.mjs';
import { collect } from '../../tools/inspect/list-contracts.mjs';

const chainInfo = JSON.parse(readFileSync(resolve(REPO_ROOT_HINT, 'docs/public/chain-info.json'), 'utf8'));
const genesis = JSON.parse(readFileSync(resolve(REPO_ROOT_HINT, 'blockchain/genesis/karmachain.genesis.json'), 'utf8'));
const genesisContractCount = Object.values(genesis.alloc).filter((a) => a.code).length;

describe('list-contracts against the live chain', () => {
  let data;

  before(async () => {
    try { await publicClient.getChainId(); } catch (e) {
      assert.fail(`devnet not reachable — run scripts/devnet-start first (${e.message})`);
    }
    data = await collect();
  });

  test('reports the current height and finds every genesis contract', async () => {
    assert.equal(data.height, Number(await publicClient.getBlockNumber()));
    const fromGenesis = data.entries.filter((e) => e.origin === 'genesis');
    assert.equal(fromGenesis.length, genesisContractCount,
      `expected ${genesisContractCount} genesis contracts, got ${fromGenesis.length}`);
    for (const e of fromGenesis) {
      assert.equal(e.block, 0);
      assert.ok(e.codeSize > 0, `${e.address} should have code`);
      assert.equal(e.live, true);
    }
  });

  test('every genesis contract address actually holds that much code on chain', async () => {
    for (const e of data.entries.filter((x) => x.origin === 'genesis')) {
      const code = await publicClient.getCode({ address: e.address });
      assert.equal((code.length - 2) / 2, e.codeSize, `code size mismatch for ${e.address}`);
    }
  });

  test('addresses published in chain-info are marked official, others are not', () => {
    const published = Object.entries(chainInfo.contracts)
      .filter(([k, v]) => !k.startsWith('$') && typeof v === 'string')
      .map(([, v]) => v.toLowerCase());
    for (const e of data.entries) {
      const shouldBeOfficial = published.includes(e.address.toLowerCase());
      assert.equal(e.official, shouldBeOfficial, `${e.address} official flag is wrong`);
      if (shouldBeOfficial) assert.ok(e.officialName, 'an official contract must carry its published name');
    }
    assert.equal(data.entries.filter((e) => e.official).length, published.length,
      'every published address must be found on chain');
  });

  test('runtime deployments carry their block, deployer and transaction', () => {
    for (const e of data.entries.filter((x) => x.origin === 'deployed')) {
      assert.ok(e.block > 0, 'a deployment must have a block number');
      assert.match(e.deployer, /^0x[0-9a-fA-F]{40}$/);
      assert.match(e.txHash, /^0x[0-9a-f]{64}$/);
      assert.equal(e.official, false, 'no runtime deployment is official yet on this chain');
    }
  });

  test('interface probing finds owner() on the validator proxy but not on the library', () => {
    const proxy = data.entries.find((e) => e.officialName === 'validatorManagerProxy');
    assert.ok(proxy, 'the validator proxy must be listed');
    assert.ok(proxy.signals.some((s) => s.startsWith('owner=')), 'the proxy exposes owner()');
    // ValidatorMessages 是纯库，没有 owner()
    const library = data.entries.find((e) => e.role?.includes('library'));
    assert.ok(library, 'the ValidatorMessages library must be listed');
    assert.equal(library.signals.some((s) => s.startsWith('owner=')), false, 'a pure library has no owner()');
  });

  test('--from narrows the deployment scan without dropping genesis contracts', async () => {
    const height = Number(await publicClient.getBlockNumber());
    if (height < 2) return;   // 链太短，无从验证
    const original = process.argv;
    process.argv = [original[0], original[1], '--from', String(height), '--no-probe'];
    try {
      const narrowed = await collect();
      assert.equal(narrowed.entries.filter((e) => e.origin === 'genesis').length, genesisContractCount,
        'genesis contracts come from the genesis file and must not depend on --from');
      assert.ok(narrowed.entries.filter((e) => e.origin === 'deployed').every((e) => e.block >= height));
    } finally { process.argv = original; }
  });

  test('the total matches protocol expectations: 4 genesis contracts, all with code', () => {
    assert.equal(genesisContractCount, 4, 'the PoA ValidatorManager set is four contracts');
    assert.equal(data.entries.length, genesisContractCount + data.entries.filter((e) => e.origin === 'deployed').length);
    assert.equal(protocol.chain.chainId, chainInfo.chainId);
  });
});
