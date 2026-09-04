// tools/protocol/render-developer-quickstart.mjs
//
// 生成 docs/public/developer-quickstart.md —— 面向**外部**合约开发者的接入文档。
// 与 docs/devnet.md（运维本地链的内部手册）区分：本文假定读者不拥有、也访问不到 karma-chain 仓库。
//
// 全部数值由 protocol.json 派生，因此不会与链参数漂移（宪法第十六条）。
//
// 用法：node tools/protocol/render-developer-quickstart.mjs [--check]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { loadProtocol, derive, readJson, REPO_ROOT } from './load.mjs';

export const OUTPUT_PATH = resolve(REPO_ROOT, 'docs', 'public', 'developer-quickstart.md');
const DEV_ACCOUNTS_PATH = resolve(REPO_ROOT, 'blockchain', 'accounts', 'dev-accounts.json');
const GENESIS_HASH_PATH = resolve(REPO_ROOT, 'blockchain', 'genesis', 'karmachain.genesis.hash');

export function renderQuickstart() {
  const p = loadProtocol();
  const d = derive(p);
  const keys = readJson(DEV_ACCOUNTS_PATH);
  const genesisHash = readFileSync(GENESIS_HASH_PATH, 'utf8').trim();
  const first = p.devAccounts.find((a) => a.label !== p.validators.ownerAccount) ?? p.devAccounts[0];
  const firstKey = keys.accounts.find((a) => a.label === first.label).privateKey;
  const second = p.devAccounts.find((a) => a.label !== first.label && a.label !== p.validators.ownerAccount);
  const tokens = (wei) => (BigInt(wei) / 10n ** BigInt(p.nativeToken.decimals)).toLocaleString('en-US');

  return `<!-- GENERATED FROM blockchain/protocol.json by tools/protocol/render-developer-quickstart.mjs — DO NOT EDIT. -->

# 在 ${p.name} 上开发智能合约

面向**外部合约开发者**。你不需要访问链的基础设施仓库——本文加上链本身的 RPC 就是全部所需。
机器可读版本：[\`chain-info.json\`](chain-info.json)。

> 当前环境是 **${p.environment}（开发网）**。链上无真实价值，随时可能被重置。

## 1. 连接信息

| 项 | 值 |
|---|---|
| 网络名称 | ${p.name} ${p.environment === 'dev' ? 'Local' : p.environment} |
| RPC (HTTP) | \`${d.rpcUrl}\` |
| RPC (WebSocket) | \`${d.wsUrl}\` |
| Chain ID | **${p.chain.chainId}**（\`${d.chainIdHex}\`） |
| 原生代币 | ${p.nativeToken.name}（**${p.nativeToken.symbol}**，${p.nativeToken.decimals} 位小数） |
| 区块浏览器 | 暂未提供 |

自检（应返回 \`${d.chainIdHex}\`）：

\`\`\`bash
curl -s -X POST -H 'content-type: application/json' \\
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \\
  ${d.rpcUrl}
\`\`\`

确认连的是同一条链实例（创世哈希应完全一致）：

\`\`\`bash
curl -s -X POST -H 'content-type: application/json' \\
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":["0x0",false]}' \\
  ${d.rpcUrl} | grep -o '"hash":"0x[0-9a-f]*"' | head -1
# 期望: ${genesisHash}
\`\`\`

## 2. ⚠️ 必须设置 \`evmVersion = cancun\`

**这是本链最容易踩的坑，请先读这一节。**

${p.name} 的 EVM 实现到 **Cancun** 分叉，**不支持 Pectra**；而 Solidity 0.8.30 起默认编译目标已是 Pectra。
不显式指定 \`cancun\`，编译出的字节码可能包含本链无法执行的指令——**测试全绿、部署即失败**。

| 工具 | 配置 |
|---|---|
| Foundry | \`foundry.toml\` → \`evm_version = "cancun"\` |
| Hardhat | \`solidity: { settings: { evmVersion: "cancun" } }\` |
| solc (JSON) | \`{ "settings": { "evmVersion": "cancun" } }\` |

可向链求证（\`cancunTime\` 有值、且**不存在** \`prague\`/\`pectra\` 字段）：

\`\`\`bash
curl -s -X POST -H 'content-type: application/json' \\
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_getChainConfig","params":[]}' \\
  ${d.rpcUrl}
\`\`\`

## 3. 获取测试代币

开发网使用**生态公开的测试账户**，与 Foundry Anvil / Hardhat 默认账户一致，因此多数工具的默认配置可直接使用。

> ⚠️ 这些私钥**全网公开**。仅在本开发网有效（Chain ID ${p.chain.chainId} / Network ID ${p.avalanche.networkId}）。
> **绝不可用于任何真实网络，也不要向这些地址转入任何有价值的资产。** 建议在钱包里使用独立的测试 Profile。

助记词：\`${keys.mnemonic.phrase}\`（派生路径 \`${keys.mnemonic.derivationPath}\`）

| 账户 | 地址 | 创世余额 |
|---|---|---|
${p.devAccounts.map((a) => `| \`${a.label}\` | \`${a.address}\` | ${tokens(a.balanceWei)} ${p.nativeToken.symbol} |`).join('\n')}

完整私钥见 [\`chain-info.json\`](chain-info.json) 的 \`testAccounts\`。

## 4. 用 Foundry 部署一个合约

\`\`\`bash
forge init my-karmachain-project && cd my-karmachain-project
\`\`\`

在 \`foundry.toml\` 里加上（**\`evm_version\` 不可省略**）：

\`\`\`toml
[profile.default]
evm_version = "cancun"
chain_id = ${p.chain.chainId}
\`\`\`

部署：

\`\`\`bash
export KARMACHAIN_RPC=${d.rpcUrl}
export PRIVATE_KEY=${firstKey}   # ${first.label}（公开测试账户）

forge create src/Counter.sol:Counter \\
  --rpc-url $KARMACHAIN_RPC --private-key $PRIVATE_KEY --broadcast
\`\`\`

交互：

\`\`\`bash
cast call <合约地址> "number()(uint256)" --rpc-url $KARMACHAIN_RPC
cast send <合约地址> "increment()" --rpc-url $KARMACHAIN_RPC --private-key $PRIVATE_KEY
\`\`\`

## 5. 连接钱包（MetaMask 等）

手动添加网络，或用 \`chain-info.json\` 的 \`wallet\` 字段调用 EIP-3085 \`wallet_addEthereumChain\`：

| 字段 | 值 |
|---|---|
| 网络名称 | ${p.name} ${p.environment === 'dev' ? 'Local' : p.environment} |
| RPC URL | \`${d.rpcUrl}\` |
| 链 ID | ${p.chain.chainId} |
| 货币符号 | ${p.nativeToken.symbol} |

导入上表任一账户的私钥即可看到余额。

## 6. 官方合约与 ABI

| 合约 | 地址 | 说明 |
|---|---|---|
| Validator Manager（代理） | \`0x0Feedc0de0000000000000000000000000000000\` | 对外入口；调用应发往这里 |
| Validator Manager（实现） | \`0x0C0DEbA5E0000000000000000000000000000000\` | 代理当前指向的实现，仅供查验 |

**目前本链尚未发布任何 ABI。** 上面两个是 Avalanche 标准的 PoA ValidatorManager 合约，以字节码形式写入创世；
其源码与 ABI 来自上游的 \`ava-labs/icm-contracts\` 项目，不由我们提供。
创世中还有一个 ValidatorMessages 库和一个 ProxyAdmin，属于上述合约集的内部实现细节，故未列出。

${p.name} **尚未部署任何业务合约**。链上出现的其他合约（名为 Greeter、Counter 之类的）都是示例与探针，
**不是官方合约**，不要在集成中依赖它们。等本链部署自己的业务合约时，其 ABI 会随
[\`chain-info.json\`](chain-info.json) 一并发布。

## 7. 你需要知道的链行为

| 行为 | 说明 |
|---|---|
| **无交易不出块** | 链空闲时区块高度不增长（\`${p.blockProduction.mode}\`）。这是正常的，不要把静止的高度当作故障 |
| **手续费销毁** | ${p.allowFeeRecipients ? '手续费分配给收款方' : '手续费被销毁，不归任何人'} |
| **基础费下限** | ${p.feeConfig.minBaseFee / 1e9} gwei（EIP-1559 动态费的下限） |
| **单区块 gas 上限** | ${p.feeConfig.gasLimit.toLocaleString('en-US')} |
| **无许可** | 任何人都可以部署合约、发送交易 |
| **原生代币不可增发** | 包括链的运营方在内，没有任何人能凭空铸造 ${p.nativeToken.symbol} |
| **Host 头限制** | RPC 只接受 \`Host\` 为 \`localhost\` 或 **IP 字面量** 的请求；用其他主机名会得到 \`403 invalid host specified\`。容器/代理场景请先把主机名解析成 IP |

## 8. 常见问题

**部署交易失败，或合约行为异常**
先确认 \`evmVersion = cancun\`（见第 2 节）。这是最常见的原因。

**\`403 invalid host specified\`**
你的 \`Host\` 头是主机名。改用 \`127.0.0.1\`、\`localhost\` 或直接用 IP。

**区块高度不动**
链空闲时的正常表现，见第 7 节。发一笔交易即会出块。

**余额为 0**
确认导入的是第 3 节表中的账户；开发网被重置后钱包可能缓存旧状态，切换网络再切回可刷新。

**交易 nonce 报错**
开发网重置后钱包缓存的 nonce 会失效。MetaMask：设置 → 高级 → 清除活动标签数据。
`;
}

export function checkQuickstart() {
  const expected = renderQuickstart();
  let actual = null;
  try { actual = readFileSync(OUTPUT_PATH, 'utf8'); } catch { /* absent */ }
  return { same: actual === expected, expected };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { same, expected } = checkQuickstart();
  if (process.argv.includes('--check')) {
    if (same) { console.log(`developer quickstart up to date: ${OUTPUT_PATH}`); process.exit(0); }
    console.error('developer quickstart DRIFT: run npm run protocol:render'); process.exit(1);
  }
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, expected);
  console.log(`wrote ${OUTPUT_PATH}`);
}
