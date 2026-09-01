// T016：开发账户密钥文件与 protocol.json 的一致性，以及密钥本身的正确性（V-7）。
// 密钥正确性不依赖外部文档：Anvil 账户从公开助记词按 BIP-44 路径重新推导；ewoq 从私钥推导地址。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { privateKeyToAccount, mnemonicToAccount } from 'viem/accounts';
import { getAddress } from 'viem';
import { loadProtocol, readJson, REPO_ROOT } from '../../tools/protocol/load.mjs';

const protocol = loadProtocol();
const keys = readJson(resolve(REPO_ROOT, 'blockchain', 'accounts', 'dev-accounts.json'));

describe('dev-accounts.json', () => {
  test('carries the DEVELOPMENT ONLY warning (constitution Art. 4 v1.1.0)', () => {
    assert.match(keys.warning, /DEVELOPMENT ONLY/);
    assert.match(keys.warning, /never use in production/i);
  });

  test('labels match protocol.json devAccounts one-to-one', () => {
    assert.deepEqual(keys.accounts.map((a) => a.label), protocol.devAccounts.map((a) => a.label));
  });

  test('addresses match protocol.json for every label and are EIP-55 checksummed', () => {
    for (const p of protocol.devAccounts) {
      const k = keys.accounts.find((a) => a.label === p.label);
      assert.ok(k, `no key entry for ${p.label}`);
      assert.equal(k.address, p.address);
      assert.equal(getAddress(k.address), k.address);
    }
  });

  test('every private key derives exactly its stated address', () => {
    for (const k of keys.accounts) {
      assert.match(k.privateKey, /^0x[0-9a-f]{64}$/, `${k.label}: private key must be 0x + 64 lowercase hex`);
      assert.equal(privateKeyToAccount(k.privateKey).address, k.address, `${k.label}: privateKey → address mismatch`);
    }
  });

  test('anvil-N accounts are the BIP-44 derivations of the public test mnemonic', () => {
    for (const k of keys.accounts.filter((a) => a.source.startsWith('foundry-anvil'))) {
      const derived = mnemonicToAccount(keys.mnemonic.phrase, { addressIndex: k.derivationIndex });
      assert.equal(derived.address, k.address, `${k.label}: mnemonic index ${k.derivationIndex} address mismatch`);
      const derivedPk = '0x' + Buffer.from(derived.getHdKey().privateKey).toString('hex');
      assert.equal(derivedPk, k.privateKey, `${k.label}: mnemonic-derived private key mismatch`);
    }
  });

  test('ewoq is the PoA validator-manager owner', () => {
    assert.equal(protocol.validators.ownerAccount, 'ewoq');
    const ewoq = keys.accounts.find((a) => a.label === 'ewoq');
    assert.equal(ewoq.address, '0x8db97C7cEcE249c2b98bDC0226Cc4C2A57BF52FC');
  });
});
