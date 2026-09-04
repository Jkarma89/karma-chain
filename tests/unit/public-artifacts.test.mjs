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

  test('endpoints list every published host, in protocol.json order', () => {
    assert.deepEqual(info.rpc.http, derived.rpcUrls);
    assert.deepEqual(info.rpc.ws, derived.wsUrls);
    assert.equal(info.rpc.http.length, protocol.endpoints.publishedHosts.length);
    protocol.endpoints.publishedHosts.forEach((host, i) => {
      assert.ok(info.rpc.http[i].includes(`//${host}:`), `rpc.http[${i}] should use host ${host}`);
      assert.ok(info.rpc.ws[i].includes(`//${host}:`), `rpc.ws[${i}] should use host ${host}`);
    });
    assert.equal(info.rpc.http[0], derived.rpcUrl, 'the first entry is the preferred endpoint');
    assert.match(info.rpc.hostHeaderPolicy, /Host header/);
  });

  test('published hosts are machine-independent (no LAN or per-developer addresses)', () => {
    // 这些只在某台机器上成立，提交进来会让不同开发者的产物不一致 —— 属于消费者侧覆盖的范畴
    for (const host of protocol.endpoints.publishedHosts) {
      assert.equal(/^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(host), false,
        `publishedHosts must not contain the private/LAN address ${host}; use a consumer-side override instead`);
    }
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

describe('the contracts block is honest about what is and is not published', () => {
  test('states plainly that no ABIs are published yet, and where these ABIs come from', () => {
    assert.match(info.contracts.$abi, /No ABIs are published here yet/);
    assert.match(info.contracts.$abi, /ava-labs\/icm-contracts/, 'must point at the upstream source');
    assert.match(info.contracts.$abi, /as bytecode/, 'must explain why we do not have them');
    assert.match(info.contracts.$abi, /not from us/, 'must be clear about who owns these ABIs');
  });

  test('explains that only the interactable addresses are listed', () => {
    assert.match(info.contracts.$listed, /ValidatorMessages|ProxyAdmin/);
    assert.match(info.contracts.$listed, /intentionally omitted/);
  });

  test('warns that unlisted on-chain contracts are not official', () => {
    assert.match(info.contracts.$comment, /NOT official/);
    assert.match(info.contracts.$comment, /Greeter|Counter/, 'name the example contracts a newcomer will actually find');
  });

  test('lists the proxy as the entry point alongside its implementation', () => {
    assert.match(info.contracts.validatorManagerProxy, /^0x[0-9a-fA-F]{40}$/);
    assert.match(info.contracts.validatorManagerImplementation, /^0x[0-9a-fA-F]{40}$/);
    assert.notEqual(info.contracts.validatorManagerProxy, info.contracts.validatorManagerImplementation);
  });

  test('the quickstart carries the same statement for human readers', () => {
    assert.match(quickstart, /## 6\. 官方合约与 ABI/);
    assert.match(quickstart, /尚未发布任何 ABI/);
    assert.match(quickstart, /尚未部署任何业务合约/);
    assert.match(quickstart, /不是官方合约/);
  });

  test('quickstart section cross-references point at the right sections', () => {
    // 章节编号变化时最容易留下失效引用
    const sections = [...quickstart.matchAll(/^## (\d+)\. (.+)$/gm)].map((m) => ({ n: Number(m[1]), title: m[2] }));
    assert.deepEqual(sections.map((s) => s.n), sections.map((_, i) => i + 1), 'section numbers must be contiguous from 1');
    for (const m of quickstart.matchAll(/见第 (\d+) 节/g)) {
      const n = Number(m[1]);
      assert.ok(sections.some((s) => s.n === n), `cross-reference to section ${n} but no such section exists`);
    }
    // 具体核对两处指向
    const behaviours = sections.find((s) => s.title.includes('链行为'));
    assert.ok(quickstart.includes(`链空闲时的正常表现，见第 ${behaviours.n} 节`), 'the idle-height answer must point at the chain-behaviour section');
    const evm = sections.find((s) => s.title.includes('evmVersion'));
    assert.ok(quickstart.includes(`见第 ${evm.n} 节`), 'the deployment-failure answer must point at the evmVersion section');
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
