// tools/protocol/render-chain-info.mjs
//
// 生成 docs/public/chain-info.json —— **面向第三方开发者的公开链元数据**。
//
// 这是 karma-chain 对外的唯一参数接口：外部开发者（以及以第三方视角工作的 karma-sc）只消费本文件
// 与链上 RPC，不需要、也不应该访问 blockchain/protocol.json 等内部制品。
//
// 设计原则：
//   1. 只包含公开信息。任何"内部才该知道的东西"都不得出现在这里。
//   2. 每一项都可被第三方独立求证 —— 通过 eth_chainId / eth_getChainConfig / eth_feeConfig
//      与链本身比对（karma-sc 的 verify-chain-info 就是这么做的，任何人都能照做）。
//   3. 仍然由 protocol.json 生成，因此不构成第二份事实来源（宪法第十六条）。
//
// 用法：node tools/protocol/render-chain-info.mjs [--check]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { loadProtocol, derive, readJson, REPO_ROOT } from './load.mjs';

export const OUTPUT_PATH = resolve(REPO_ROOT, 'docs', 'public', 'chain-info.json');
const GENESIS_HASH_PATH = resolve(REPO_ROOT, 'blockchain', 'genesis', 'karmachain.genesis.hash');
const DEV_ACCOUNTS_PATH = resolve(REPO_ROOT, 'blockchain', 'accounts', 'dev-accounts.json');

/** 本文件的结构版本；第三方可据此判断兼容性。字段含义变更时递增。 */
export const SCHEMA_VERSION = 1;

export function renderChainInfo() {
  const p = loadProtocol();
  const d = derive(p);
  const keys = readJson(DEV_ACCOUNTS_PATH);
  const genesisHash = readFileSync(GENESIS_HASH_PATH, 'utf8').trim();


  const info = {
    // 刻意不提任何内部文件路径：这是对外接口，消费者不该、也不需要了解链仓库的内部结构。
    $comment:
      'GENERATED artifact published by the KarmaChain team — DO NOT EDIT. '
      + 'Public chain metadata for third-party developers. Every value here can be independently '
      + 'confirmed against the chain via eth_chainId / net_version / eth_getChainConfig / eth_feeConfig / '
      + 'eth_getBlockByNumber / eth_getBalance / eth_getCode.',
    schemaVersion: SCHEMA_VERSION,

    // --- 身份 ---
    name: `${p.name} ${p.environment === 'dev' ? 'Local Devnet' : p.environment}`,
    shortName: 'karmachain',
    environment: p.environment,
    chainId: p.chain.chainId,
    networkId: p.avalanche.networkId,
    nativeCurrency: {
      name: p.nativeToken.name,
      symbol: p.nativeToken.symbol,
      decimals: p.nativeToken.decimals,
    },

    // --- 端点 ---
    rpc: {
      // 多端点：按 protocol.json 的 publishedHosts 顺序给出，消费者应依次尝试。
      // 不在这里列出局域网/机器专属地址——那属于消费者侧的覆盖（如 KARMACHAIN_RPC_URL）。
      http: d.rpcUrls,
      ws: d.wsUrls,
      // avalanchego 的 --http-allowed-hosts 默认只放行 localhost 与 IP 字面量，其余返回 403。
      hostHeaderPolicy: 'Only "localhost" or an IP literal is accepted in the HTTP Host header; other hostnames get 403 "invalid host specified". Resolve hostnames to an IP before connecting.',
      // 明确告诉消费者：不要盲目使用 http[0]。可达地址取决于链跑在哪台机器上，不是链的属性。
      reachability:
        `The endpoints above are loopback addresses (${p.endpoints.publishedHosts.join(', ')}) and only work `
        + 'on the machine running the chain. From anywhere else, ask the chain operator for a reachable '
        + 'address — on a LAN that is the host machine\'s IP with the same port and path. It must be an IP, '
        + 'not a hostname, because of the Host header policy above. A reachable address is not published '
        + 'here because it depends on where the chain is running, which is not a property of the chain.',
    },

    // --- EVM 能力（第三方最容易踩坑的一项）---
    evm: {
      // 由 protocol.json 锁定的 Subnet-EVM 版本决定；可用 eth_getChainConfig 求证：
      // cancunTime 已设置、且不存在 prague/pectra 字段
      version: 'cancun',
      note: 'Compile with evmVersion=cancun. Subnet-EVM implements up to the Cancun fork and does not support Pectra, while solc 0.8.30+ targets Pectra by default — omitting this produces bytecode this chain cannot execute.',
      solidityConfig: {
        foundry: 'evm_version = "cancun"',
        hardhat: 'solidity: { settings: { evmVersion: "cancun" } }',
        solcJson: '{ "settings": { "evmVersion": "cancun" } }',
      },
    },

    // --- 费用（求证：eth_feeConfig）---
    fees: {
      ...p.feeConfig,
      feesBurned: !p.allowFeeRecipients,
      note: 'Fees are burned (allowFeeRecipients=false). minBaseFee is the EIP-1559 base fee floor, in wei.',
    },

    // --- 出块行为（不可通过 RPC 发现，必须明示）---
    blockProduction: {
      mode: p.blockProduction.mode,
      targetBlockRateSeconds: p.blockProduction.targetBlockRateSeconds,
      note: 'Blocks are produced only when there are pending transactions. An idle chain does not advance its block height — this is Subnet-EVM behaviour, not a fault. Do not treat a static block height as unhealthy.',
    },

    // --- 权限模型（ADR-0005）---
    permissioning: {
      contractDeployment: 'permissionless',
      transactions: 'permissionless',
      nativeTokenMinting: 'disabled',
      note: 'Anyone may deploy contracts and send transactions. The native token cannot be minted by anyone, including the chain operators.',
    },

    // --- 创世（可复现性锚点）---
    genesis: {
      blockHash: genesisHash,
      note: 'eth_getBlockByNumber("0x0", false).hash must equal this value. Use it to confirm you are talking to the intended chain instance.',
    },

    // --- 钱包一键添加（EIP-3085 wallet_addEthereumChain）---
    wallet: {
      chainId: d.chainIdHex,
      chainName: `${p.name} ${p.environment === 'dev' ? 'Local' : p.environment}`,
      nativeCurrency: {
        name: p.nativeToken.name,
        symbol: p.nativeToken.symbol,
        decimals: p.nativeToken.decimals,
      },
      rpcUrls: [d.rpcUrl],
      blockExplorerUrls: [],
    },

    // --- 官方合约（第三方集成的锚点）---
    contracts: {
      $comment:
        'Official contracts. Today this is only the genesis-embedded validator-management '
        + 'infrastructure — KarmaChain has not deployed any application contracts yet, and anything '
        + 'you find on chain that is not listed here is NOT official (contracts named Greeter, Counter '
        + 'and the like are examples and probes, not part of the chain).',
      // ABI 尚未由本链发布 —— 明确写出来，免得第三方以为漏了或去反编译
      // 只说第三方需要知道的来源，不提我们用的工具版本 —— 那是内部选择，变了也不影响他们
      $abi:
        'No ABIs are published here yet. The contracts below are Avalanche\'s standard PoA '
        + 'ValidatorManager set, embedded in the genesis as bytecode; their source and ABIs come from '
        + 'the upstream ava-labs/icm-contracts project, not from us. When KarmaChain deploys its own '
        + 'application contracts, their ABIs will be published as part of this artifact.',
      $listed:
        'Only the two addresses a third party would interact with or inspect are listed. The genesis '
        + 'also contains a ValidatorMessages library and a ProxyAdmin, which are internal implementation '
        + 'details of the set below and are intentionally omitted.',
      // 对外入口：所有调用都应发往代理，而不是实现合约
      validatorManagerProxy: '0x0Feedc0de0000000000000000000000000000000',
      // 代理当前指向的实现，仅用于查验/审计
      validatorManagerImplementation: '0x0C0DEbA5E0000000000000000000000000000000',
    },

    // --- 测试账户（开发网专用；公开已知）---
    testAccounts: {
      $comment: 'PUBLIC, WIDELY KNOWN development keys — valid only on this local devnet. NEVER use them on any real network or fund them with anything of value.',
      warning: keys.warning,
      mnemonic: keys.mnemonic,
      accounts: p.devAccounts.map((a) => {
        const k = keys.accounts.find((x) => x.label === a.label);
        if (!k) throw new Error(`dev account ${a.label} has no key entry`);
        return {
          label: a.label,
          address: a.address,
          privateKey: k.privateKey,
          genesisBalanceWei: a.balanceWei,
          source: a.source,
        };
      }),
    },
  };

  return `${JSON.stringify(info, null, 2)}\n`;
}

export function checkChainInfo() {
  const expected = renderChainInfo();
  let actual = null;
  try { actual = readFileSync(OUTPUT_PATH, 'utf8'); } catch { /* absent */ }
  return { same: actual === expected, expected };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { same, expected } = checkChainInfo();
  if (process.argv.includes('--check')) {
    if (same) { console.log(`chain-info up to date: ${OUTPUT_PATH}`); process.exit(0); }
    console.error('chain-info DRIFT: run npm run protocol:render'); process.exit(1);
  }
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, expected);
  const i = JSON.parse(expected);
  console.log(`wrote ${OUTPUT_PATH}`);
  console.log(`  ${i.name}  chainId ${i.chainId}  evmVersion ${i.evm.version}  accounts ${i.testAccounts.accounts.length}`);
}
