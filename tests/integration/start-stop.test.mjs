// T021：对运行中的开发网络做 US1 集成验收（需先 scripts/devnet-start）。
// 运行：docker compose run --rm verify npm run test:integration   （或宿主：npm run test:integration）
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEther, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { protocol, derived, rpcUrl, publicClient, walletClient, info, health } from '../../tools/verify/lib/rpc.mjs';
import { REPO_ROOT } from '../../tools/protocol/load.mjs';

const keys = JSON.parse(readFileSync(resolve(REPO_ROOT, 'blockchain/accounts/dev-accounts.json'), 'utf8'));
const keyOf = (label) => keys.accounts.find((a) => a.label === label);
const balanceAtGenesis = (label) => BigInt(protocol.devAccounts.find((a) => a.label === label).balanceWei);

describe(`US1 — live devnet at ${rpcUrl}`, () => {
  before(async () => {
    try { await publicClient.getChainId(); } catch (e) {
      assert.fail(`devnet not reachable at ${rpcUrl} — run scripts/devnet-start first (${e.message})`);
    }
  });

  test('eth_chainId matches protocol.json (20189 / 0x4edd)', async () => {
    assert.equal(await publicClient.getChainId(), protocol.chain.chainId);
    assert.equal(derived.chainIdHex, '0x4edd');
  });

  test('Avalanche info.getNetworkID matches protocol.json (1337) and node is healthy', async () => {
    assert.equal(await info.networkID(), protocol.avalanche.networkId);
    const h = await health();
    assert.equal(h.healthy, true, JSON.stringify(h).slice(0, 300));
  });

  test('genesis allocations are exact at block 0 for every dev account', async () => {
    for (const acct of protocol.devAccounts) {
      const bal = await publicClient.getBalance({ address: acct.address, blockNumber: 0n });
      assert.equal(bal, balanceAtGenesis(acct.label), `${acct.label} genesis balance`);
    }
  });

  test('anvil-1 → anvil-2 transfer is confirmed; receipt fields and balances are consistent (FR-013/FR-015)', async () => {
    // 用 anvil-1/anvil-2（不是 ewoq，ewoq 被 CLI 用于 PoA 初始化）
    const sender = privateKeyToAccount(keyOf('anvil-1').privateKey);
    const receiver = keyOf('anvil-2').address;
    const value = parseEther('1');

    const [s0, r0, nonce0] = await Promise.all([
      publicClient.getBalance({ address: sender.address }),
      publicClient.getBalance({ address: receiver }),
      publicClient.getTransactionCount({ address: sender.address }),
    ]);

    const t0 = Date.now();
    const hash = await walletClient(sender).sendTransaction({ to: receiver, value });
    assert.match(hash, /^0x[0-9a-f]{64}$/);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 });
    const seconds = (Date.now() - t0) / 1000;

    assert.equal(receipt.status, 'success');
    assert.equal(receipt.transactionHash, hash);
    assert.equal(receipt.from.toLowerCase(), sender.address.toLowerCase());
    assert.equal(receipt.to.toLowerCase(), receiver.toLowerCase());
    assert.equal(receipt.gasUsed, 21_000n);
    assert.ok(receipt.blockNumber > 0n);
    assert.ok(seconds <= 10, `confirmation took ${seconds}s (SC-006 ≤ 10s)`);

    const tx = await publicClient.getTransaction({ hash });
    assert.equal(tx.value, value);
    assert.equal(tx.nonce, nonce0);

    const [s1, r1, nonce1] = await Promise.all([
      publicClient.getBalance({ address: sender.address }),
      publicClient.getBalance({ address: receiver }),
      publicClient.getTransactionCount({ address: sender.address }),
    ]);
    const fee = receipt.gasUsed * receipt.effectiveGasPrice;
    assert.equal(r1 - r0, value, 'receiver gained exactly value');
    assert.equal(s0 - s1, value + fee, `sender paid value + fee (fee ${formatEther(fee)} ${protocol.nativeToken.symbol})`);
    assert.equal(nonce1, nonce0 + 1);
  });

  test('block height advances when transactions are sent (on-demand block production)', async () => {
    // 高度取自回执而不是 eth_blockNumber：回执可见后，节点的 latest 指针仍可能短暂返回旧值，
    // 在刚跑过一批交易（例如紧接 devnet-verify）时会导致 h1 == h0 的假失败。
    const sender = privateKeyToAccount(keyOf('anvil-3').privateKey);
    const to = keyOf('anvil-4').address;

    const first = await publicClient.waitForTransactionReceipt({
      hash: await walletClient(sender).sendTransaction({ to, value: 1n }),
      timeout: 30_000,
    });
    const second = await publicClient.waitForTransactionReceipt({
      hash: await walletClient(sender).sendTransaction({ to, value: 1n }),
      timeout: 30_000,
    });

    assert.equal(first.status, 'success');
    assert.equal(second.status, 'success');
    assert.ok(second.blockNumber > first.blockNumber,
      `each transaction must land in a new block: ${first.blockNumber} → ${second.blockNumber}`);
  });
});
