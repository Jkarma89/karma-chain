// docs/public/ 是 karma-chain 对第三方开发者的唯一参数接口。
// 它必须（a）与 protocol.json 同步，（b）只含公开信息，（c）覆盖第三方真正需要的每一项。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadProtocol, derive, readJson, REPO_ROOT } from '../../tools/protocol/load.mjs';
import { checkChainInfo, OUTPUT_PATH as CHAIN_INFO_PATH, SCHEMA_VERSION } from '../../tools/protocol/render-chain-info.mjs';
import { checkQuickstart, OUTPUT_PATH as QUICKSTART_PATH } from '../../tools/protocol/render-developer-quickstart.mjs';

const protocol = loadProtocol();
const derived = derive(protocol);
const info = readJson(CHAIN_INFO_PATH);
const quickstart = readFileSync(QUICKSTART_PATH, 'utf8');
const genesisHash = readFileSync(resolve(REPO_ROOT, 'blockchain/genesis/karmachain.genesis.hash'), 'utf8').trim();

describe('docs/public artifacts stay in sync with protocol.json', () => {
  test('chain-info.json has no drift', () => {
    assert.ok(checkChainInfo().same, 'chain-info drift — run: npm run protocol:render');
  });

  test('developer-quickstart.md has no drift', () => {
    assert.ok(checkQuickstart().same, 'quickstart drift — run: npm run protocol:render');
  });

  test('both carry the GENERATED marker', () => {
    assert.match(info.$comment, /GENERATED/);
    assert.match(quickstart, /GENERATED FROM blockchain\/protocol\.json/);
  });

  test('chain-info.json does not expose internal file paths to third parties', () => {
    // 它是对外接口：消费者（含以第三方视角工作的 karma-sc）不该依赖、也不该看到内部结构。
    const serialized = JSON.stringify(info);
    for (const path of ['blockchain/protocol.json', 'blockchain/accounts', 'tools/protocol', 'docs/protocol-parameters.md']) {
      assert.equal(serialized.includes(path), false, `chain-info.json must not reference the internal path "${path}"`);
    }
  });
});

describe('chain-info.json exposes what a third party needs', () => {
  test('identity matches protocol.json', () => {
    assert.equal(info.schemaVersion, SCHEMA_VERSION);
    assert.equal(info.chainId, protocol.chain.chainId);
    assert.equal(info.networkId, protocol.avalanche.networkId);
    assert.equal(info.environment, protocol.environment);
    assert.deepEqual(info.nativeCurrency, {
      name: protocol.nativeToken.name,
      symbol: protocol.nativeToken.symbol,
      decimals: protocol.nativeToken.decimals,
    });
  });

  test('endpoints match the derived values', () => {
    assert.deepEqual(info.rpc.http, [derived.rpcUrl]);
    assert.deepEqual(info.rpc.ws, [derived.wsUrl]);
    assert.match(info.rpc.hostHeaderPolicy, /Host header/);
  });

  test('the EVM version and its rationale are stated (the most common third-party pitfall)', () => {
    assert.equal(info.evm.version, 'cancun');
    assert.match(info.evm.note, /Pectra/);
    assert.match(info.evm.solidityConfig.foundry, /evm_version = "cancun"/);
    assert.ok(info.evm.solidityConfig.hardhat && info.evm.solidityConfig.solcJson);
  });

  test('fee config is copied field-by-field and marks fee burning', () => {
    for (const [k, v] of Object.entries(protocol.feeConfig)) assert.equal(info.fees[k], v, `fees.${k}`);
    assert.equal(info.fees.feesBurned, !protocol.allowFeeRecipients);
  });

  test('block production mode is documented (it is not discoverable over RPC)', () => {
    assert.equal(info.blockProduction.mode, protocol.blockProduction.mode);
    assert.match(info.blockProduction.note, /only when there are pending transactions/i);
  });

  test('the permissioning model is stated (ADR-0005)', () => {
    assert.equal(info.permissioning.contractDeployment, 'permissionless');
    assert.equal(info.permissioning.transactions, 'permissionless');
    assert.equal(info.permissioning.nativeTokenMinting, 'disabled');
  });

  test('the genesis hash anchor matches the recorded baseline', () => {
    assert.equal(info.genesis.blockHash, genesisHash);
  });

  test('the EIP-3085 wallet block is well formed', () => {
    assert.equal(info.wallet.chainId, derived.chainIdHex);
    assert.deepEqual(info.wallet.rpcUrls, [derived.rpcUrl]);
    assert.equal(info.wallet.nativeCurrency.symbol, protocol.nativeToken.symbol);
    assert.ok(Array.isArray(info.wallet.blockExplorerUrls));
  });

  test('test accounts match protocol.json and carry the public-key warning', () => {
    assert.deepEqual(info.testAccounts.accounts.map((a) => a.label), protocol.devAccounts.map((a) => a.label));
    for (const a of protocol.devAccounts) {
      const pub = info.testAccounts.accounts.find((x) => x.label === a.label);
      assert.equal(pub.address, a.address);
      assert.equal(pub.genesisBalanceWei, a.balanceWei);
      assert.match(pub.privateKey, /^0x[0-9a-f]{64}$/);
    }
    assert.match(info.testAccounts.warning, /DEVELOPMENT ONLY/);
    assert.match(info.testAccounts.$comment, /NEVER use them on any real network/);
  });
});

describe('chain-info.json leaks nothing internal', () => {
  // 第三方接口只能含公开信息：不得出现内部路径、验证者密钥材料、内部版本锁定等
  const serialized = JSON.stringify(info);

  test('no validator key material', () => {
    for (const needle of ['staker.key', 'signer.key', 'BEGIN PRIVATE KEY', 'blockchain/validators']) {
      assert.equal(serialized.includes(needle), false, `chain-info must not mention ${needle}`);
    }
  });

  test('no internal repo paths or tooling details', () => {
    for (const needle of ['.avalanche-cli', 'docker/devnet', 'protocol-rationale', 'karmachain.stamp']) {
      assert.equal(serialized.includes(needle), false, `chain-info must not leak ${needle}`);
    }
  });

  test('no pinned internal component versions (third parties do not depend on them)', () => {
    for (const needle of [protocol.avalanche.avalancheCliVersion, protocol.avalanche.avalanchegoVersion]) {
      assert.equal(serialized.includes(needle), false, `chain-info must not pin ${needle} for third parties`);
    }
  });

  test('does not expose the reserved mainnet chain id as if it were usable', () => {
    assert.equal(serialized.includes(String(protocol.chain.reservedMainnetChainId)), false);
  });
});

describe('developer-quickstart.md answers the third-party essentials', () => {
  test('leads with the connection table', () => {
    assert.ok(quickstart.includes(derived.rpcUrl));
    assert.ok(quickstart.includes(String(protocol.chain.chainId)));
    assert.ok(quickstart.includes(protocol.nativeToken.symbol));
  });

  test('gives the evmVersion warning its own prominent section', () => {
    assert.match(quickstart, /必须设置 `evmVersion = cancun`/);
    assert.match(quickstart, /Pectra/);
  });

  test('explains how to get test tokens and warns the keys are public', () => {
    assert.ok(quickstart.includes(readJson(resolve(REPO_ROOT, 'blockchain/accounts/dev-accounts.json')).mnemonic.phrase));
    assert.match(quickstart, /全网公开/);
    assert.match(quickstart, /绝不可用于任何真实网络/);
  });

  test('states the chain behaviours a newcomer will otherwise misread', () => {
    assert.match(quickstart, /无交易不出块/);
    assert.match(quickstart, /403 invalid host specified|Host 头限制/);
    assert.match(quickstart, /原生代币不可增发/);
  });

  test('includes the genesis hash so a developer can confirm the chain instance', () => {
    assert.ok(quickstart.includes(genesisHash));
  });
});
