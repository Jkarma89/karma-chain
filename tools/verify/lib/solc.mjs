// tools/verify/lib/solc.mjs —— 用 solc-js 编译探针合约。
// evmVersion 固定为 cancun：Subnet-EVM 与 C-Chain 目前实现到 Cancun，尚不支持 Pectra；
// 而 Solidity 0.8.30 起默认目标已是 Pectra，不显式指定会产出节点无法执行的字节码
// （来源：ava-labs/subnet-evm README 的 Compatibility 小节）。

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const EVM_VERSION = 'cancun';

export function compileContract(sourcePath, contractName) {
  const solc = require('solc');
  const fileName = sourcePath.split(/[\\/]/).pop();
  const input = {
    language: 'Solidity',
    sources: { [fileName]: { content: readFileSync(sourcePath, 'utf8') } },
    settings: {
      evmVersion: EVM_VERSION,
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error(`solc: ${errors.map((e) => e.formattedMessage ?? e.message).join('\n')}`);
  const artifact = out.contracts?.[fileName]?.[contractName];
  if (!artifact) throw new Error(`solc: contract ${contractName} not found in ${fileName}`);
  return {
    abi: artifact.abi,
    bytecode: `0x${artifact.evm.bytecode.object}`,
    solcVersion: solc.version(),
    evmVersion: EVM_VERSION,
  };
}
