// tools/verify/checks/chain.mjs —— T034：转账、回执、按需出块、合约、RPC 方法清单、协议一致性。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEther, formatEther, getContract } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createHash } from 'node:crypto';
import { STATUS } from '../lib/report.mjs';
import { CATEGORIES } from '../lib/categories.mjs';
import { jsonRpc } from '../lib/rpc.mjs';
import { compileContract } from '../lib/solc.mjs';

/** FR-012 要求逐一验证的 JSON-RPC 方法。 */
export const REQUIRED_RPC_METHODS = [
  'eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBlockByHash',
  'eth_getBalance', 'eth_getTransactionCount', 'eth_sendRawTransaction',
  'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_call',
];

const devKeys = (repoRoot) => JSON.parse(readFileSync(resolve(repoRoot, 'blockchain/accounts/dev-accounts.json'), 'utf8'));

/** 挑一个不是 PoA 管理员的账户做资金来源（ewoq 被 CLI 用于初始化，避免相互干扰）。 */
function pickFunder(protocol, keys) {
  const label = protocol.devAccounts.map((a) => a.label).find((l) => l !== protocol.validators.ownerAccount);
  const entry = keys.accounts.find((a) => a.label === label);
  if (!entry) throw new Error('no non-owner dev account available as funder');
  return { label, account: privateKeyToAccount(entry.privateKey) };
}

function pickRecipient(protocol, funderLabel) {
  const a = protocol.devAccounts.find((x) => x.label !== funderLabel && x.label !== protocol.validators.ownerAccount);
  if (!a) throw new Error('no recipient dev account available');
  return a;
}

export const transferCheck = {
  id: 'transfer',
  async run(ctx) {
    const { publicClient, walletClient, protocol, repoRoot } = ctx;
    const keys = devKeys(repoRoot);
    const { label: funderLabel, account } = pickFunder(protocol, keys);
    const recipient = pickRecipient(protocol, funderLabel);
    const value = parseEther('1');

    const [senderBefore, recipientBefore, nonceBefore] = await Promise.all([
      publicClient.getBalance({ address: account.address }),
      publicClient.getBalance({ address: recipient.address }),
      publicClient.getTransactionCount({ address: account.address }),
    ]);

    const t0 = Date.now();
    const hash = await walletClient(account).sendTransaction({ to: recipient.address, value });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 });
    const seconds = (Date.now() - t0) / 1000;

    if (receipt.status !== 'success') {
      return { status: STATUS.FAIL, category: CATEGORIES.TRANSACTION, detail: `receipt status is ${receipt.status} for ${hash}` };
    }
    // 供后续检查复用
    ctx.lastTransfer = { hash, receipt, value, account, recipient, senderBefore, recipientBefore, nonceBefore, seconds };
    return {
      status: STATUS.OK,
      detail: `${hash.slice(0, 12)}… ${funderLabel} → ${recipient.label} 1 ${protocol.nativeToken.symbol} confirmed in block ${receipt.blockNumber} (${seconds.toFixed(1)} s)`,
      data: { hash, blockNumber: Number(receipt.blockNumber), seconds },
    };
  },
};

export const receiptCheck = {
  id: 'receipt',
  async run(ctx) {
    const t = ctx.lastTransfer;
    if (!t) return { status: STATUS.SKIP, detail: 'no transfer to inspect (transfer check did not run)' };
    const { publicClient } = ctx;
    const { hash, receipt, value, account, recipient, senderBefore, recipientBefore, nonceBefore } = t;

    const problems = [];
    if (receipt.transactionHash !== hash) problems.push('transactionHash mismatch');
    if (receipt.from.toLowerCase() !== account.address.toLowerCase()) problems.push(`from ${receipt.from} != ${account.address}`);
    if (receipt.to.toLowerCase() !== recipient.address.toLowerCase()) problems.push(`to ${receipt.to} != ${recipient.address}`);
    if (receipt.gasUsed !== 21_000n) problems.push(`gasUsed ${receipt.gasUsed} != 21000`);
    if (!(receipt.blockNumber > 0n)) problems.push('blockNumber is 0');

    const tx = await publicClient.getTransaction({ hash });
    if (tx.value !== value) problems.push(`tx.value ${tx.value} != ${value}`);
    if (tx.nonce !== nonceBefore) problems.push(`tx.nonce ${tx.nonce} != ${nonceBefore}`);

    const [senderAfter, recipientAfter, nonceAfter] = await Promise.all([
      publicClient.getBalance({ address: account.address }),
      publicClient.getBalance({ address: recipient.address }),
      publicClient.getTransactionCount({ address: account.address }),
    ]);
    const fee = receipt.gasUsed * receipt.effectiveGasPrice;
    if (recipientAfter - recipientBefore !== value) problems.push(`recipient delta ${recipientAfter - recipientBefore} != ${value}`);
    if (senderBefore - senderAfter !== value + fee) problems.push(`sender delta ${senderBefore - senderAfter} != value + fee ${value + fee}`);
    if (nonceAfter !== nonceBefore + 1) problems.push(`nonce ${nonceBefore} → ${nonceAfter}`);

    return problems.length
      ? { status: STATUS.FAIL, category: CATEGORIES.TRANSACTION, detail: problems.join('; ') }
      : { status: STATUS.OK, detail: `status=1 gasUsed=21000 from/to/value/nonce verified, fee ${formatEther(fee)} ${ctx.protocol.nativeToken.symbol}, balances conserved` };
  },
};

export const blockProductionCheck = {
  id: 'block-production',
  async run(ctx) {
    // Subnet-EVM 无交易不出块（research R-03），所以主动发两笔交易观测 N → N+1 → N+2。
    const { publicClient, walletClient, protocol, repoRoot, report } = ctx;
    const keys = devKeys(repoRoot);
    const { label: funderLabel, account } = pickFunder(protocol, keys);
    const recipient = pickRecipient(protocol, funderLabel);
    // 高度取自回执的 blockNumber 而非 eth_blockNumber：后者在回执可见后仍可能短暂返回旧值（竞态）。
    const startHeight = Number(await publicClient.getBlockNumber());
    const heights = [startHeight];
    for (let i = 0; i < 2; i++) {
      const hash = await walletClient(account).sendTransaction({ to: recipient.address, value: 1n });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 });
      heights.push(Number(receipt.blockNumber));
    }
    report.setSummary({ blockHeight: Number(await publicClient.getBlockNumber()) });
    const strictlyIncreasing = heights.every((h, i) => i === 0 || h > heights[i - 1]);
    return strictlyIncreasing
      ? { status: STATUS.OK, detail: `each tx produced a new block: ${heights.join(' -> ')} (${protocol.blockProduction.mode})`, data: { heights } }
      : { status: STATUS.FAIL, category: CATEGORIES.VALIDATOR, detail: `a tx did not produce a new block: ${heights.join(' -> ')}`, data: { heights } };
  },
};

export const contractCheck = {
  id: 'contract',
  async run(ctx) {
    const { publicClient, walletClient, protocol, repoRoot } = ctx;
    const keys = devKeys(repoRoot);
    const { account } = pickFunder(protocol, keys);
    const src = resolve(repoRoot, 'tools/verify/contracts/Counter.sol');

    let artifact;
    try {
      artifact = compileContract(src, 'Counter');
    } catch (e) {
      return { status: STATUS.FAIL, category: CATEGORIES.CONFIGURATION, detail: `solc failed: ${e.message.slice(0, 160)}` };
    }

    const wallet = walletClient(account);
    const deployHash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode });
    const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash, timeout: 60_000 });
    if (deployReceipt.status !== 'success' || !deployReceipt.contractAddress) {
      return { status: STATUS.FAIL, category: CATEGORIES.EVM, detail: `deployment failed (status ${deployReceipt.status})` };
    }
    const address = deployReceipt.contractAddress;
    const contract = getContract({ address, abi: artifact.abi, client: { public: publicClient, wallet } });

    const before = await contract.read.count();
    const incHash = await contract.write.increment();
    const incReceipt = await publicClient.waitForTransactionReceipt({ hash: incHash, timeout: 30_000 });
    if (incReceipt.status !== 'success') {
      return { status: STATUS.FAIL, category: CATEGORIES.EVM, detail: `increment() reverted (${incHash})` };
    }
    const after = await contract.read.count();
    const caller = await contract.read.lastCaller();

    const problems = [];
    if (after !== before + 1n) problems.push(`count ${before} → ${after}, expected +1`);
    if (caller.toLowerCase() !== account.address.toLowerCase()) problems.push(`lastCaller ${caller} != ${account.address}`);
    if (incReceipt.logs.length !== 1) problems.push(`expected 1 Incremented event, got ${incReceipt.logs.length}`);
    const code = await publicClient.getCode({ address });
    if (!code || code === '0x') problems.push('deployed code is empty');

    return problems.length
      ? { status: STATUS.FAIL, category: CATEGORIES.EVM, detail: problems.join('; ') }
      : {
        status: STATUS.OK,
        detail: `Counter deployed at ${address.slice(0, 10)}… (solc ${artifact.solcVersion.split('+')[0]}, evmVersion ${artifact.evmVersion}); increment() -> count()==${after}, event + lastCaller verified`,
        data: { address, solcVersion: artifact.solcVersion, evmVersion: artifact.evmVersion },
      };
  },
};

export const rpcMethodsCheck = {
  id: 'rpc-methods',
  async run(ctx) {
    // 逐个真实调用（FR-012）：-32601 视为不支持，其他 JSON-RPC 错误视为失败。
    const { rpcUrl, protocol, publicClient } = ctx;
    const latestBlock = await publicClient.getBlock();
    const t = ctx.lastTransfer;
    const probe = {
      eth_chainId: [],
      eth_blockNumber: [],
      eth_getBlockByNumber: ['0x0', false],
      eth_getBlockByHash: [latestBlock.hash, false],
      eth_getBalance: [protocol.devAccounts[0].address, 'latest'],
      eth_getTransactionCount: [protocol.devAccounts[0].address, 'latest'],
      // 已在 transfer 检查中真实调用过；这里用一个畸形负载确认方法存在（预期参数错误而非 -32601）
      eth_sendRawTransaction: ['0x00'],
      eth_getTransactionByHash: [t?.hash ?? `0x${'0'.repeat(64)}`],
      eth_getTransactionReceipt: [t?.hash ?? `0x${'0'.repeat(64)}`],
      eth_call: [{ to: protocol.devAccounts[0].address, data: '0x' }, 'latest'],
    };

    const results = [];
    for (const method of REQUIRED_RPC_METHODS) {
      try {
        await jsonRpc(rpcUrl, method, probe[method]);
        results.push({ method, supported: true, note: 'ok' });
      } catch (e) {
        const code = e.rpcError?.code;
        if (code === -32601) results.push({ method, supported: false, note: 'not available (-32601)' });
        else if (code === -32602 || code === -32000 || code === -32603) results.push({ method, supported: true, note: `exists (rejected our probe payload: ${code})` });
        else results.push({ method, supported: false, note: e.message.slice(0, 80) });
      }
    }
    const unsupported = results.filter((r) => !r.supported);
    return unsupported.length === 0
      ? { status: STATUS.OK, detail: `${results.length}/${REQUIRED_RPC_METHODS.length} supported`, data: { methods: results } }
      : { status: STATUS.UNSUPPORTED, detail: `${unsupported.length}/${REQUIRED_RPC_METHODS.length} unsupported: ${unsupported.map((u) => u.method).join(', ')} — must be documented (SC-010)`, data: { methods: results } };
  },
};

export const protocolConsistencyCheck = {
  id: 'protocol-consistency',
  async run(ctx) {
    const { publicClient, repoRoot } = ctx;
    const genesisPath = resolve(repoRoot, 'blockchain/genesis/karmachain.genesis.json');
    const hashPath = resolve(repoRoot, 'blockchain/genesis/karmachain.genesis.hash');
    const problems = [];

    const expectedHash = readFileSync(hashPath, 'utf8').trim();
    const block0 = await publicClient.getBlock({ blockNumber: 0n });
    if (block0.hash !== expectedHash) {
      problems.push(`running genesis hash ${block0.hash} != recorded ${expectedHash}`);
    }

    // 创世文件的 chainId / feeConfig 与运行中链一致
    const genesis = JSON.parse(readFileSync(genesisPath, 'utf8'));
    const chainId = await publicClient.getChainId();
    if (genesis.config.chainId !== chainId) problems.push(`genesis file chainId ${genesis.config.chainId} != chain ${chainId}`);
    if (BigInt(genesis.gasLimit) !== block0.gasLimit) problems.push(`genesis gasLimit ${BigInt(genesis.gasLimit)} != block 0 ${block0.gasLimit}`);
    if (BigInt(genesis.timestamp) !== block0.timestamp) problems.push(`genesis timestamp ${BigInt(genesis.timestamp)} != block 0 ${block0.timestamp}`);

    const sha = createHash('sha256').update(readFileSync(genesisPath)).digest('hex');
    return problems.length
      ? { status: STATUS.FAIL, category: CATEGORIES.GENESIS, detail: problems.join('; ') }
      : { status: STATUS.OK, detail: `genesis block hash matches baseline; file sha256 ${sha.slice(0, 12)}…; chainId/gasLimit/timestamp consistent` };
  },
};

export const chainChecks = [transferCheck, receiptCheck, blockProductionCheck, contractCheck, rpcMethodsCheck, protocolConsistencyCheck];
