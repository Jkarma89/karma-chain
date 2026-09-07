// T092：补回 001 退役 e2e 丢失的覆盖之三 —— 创世 fixture（`validator-manager.alloc.json`）的漂移。
//
// 这个 fixture 是 Avalanche CLI 注入 Subnet-EVM 创世的 ValidatorManager 合约账户
// （PoA 验证者管理），由 `tools/protocol/extract-vm-alloc.sh` 一次性提取并提交进仓库，
// 之后作为**输入**参与创世生成。
//
// ## 哪个方向已经被保护，哪个方向没有
//
// **fixture → 创世**：已被保护。fixture 一改，生成的创世就变，`karmachain.genesis.hash`
// 与 `devnet-verify` 的 `protocol-consistency` 会立刻失败。
//
// **CLI 版本 → fixture**：**此前完全没有保护。** fixture 的 `$comment` 写着
// "re-extract when avalancheCliVersion changes"，但那只是一句话 —— 没有任何东西强制它。
// 把 `protocol.json` 的 `avalancheCliVersion` 一改，fixture 会静默地继续用旧版本提取的
// 字节码与存储；链照样起得来、创世哈希照样自洽，但那条链的 ValidatorManager 与
// 新版 CLI 期望的**不是同一份合约**。这类偏差不会有任何测试失败，只会在某次
// 验证者集合变更时表现为难以定位的行为差异。
//
// 本测试把那句注释变成约束：出处版本与唯一事实来源不符即失败，并给出重新提取的命令。
//
// 纯文件比对，不需要活链 —— 因此它属于单元测试，而不是像 001 那样的 e2e。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadProtocol, REPO_ROOT } from '../../tools/protocol/load.mjs';

const ALLOC_PATH = resolve(REPO_ROOT, 'blockchain/genesis/validator-manager.alloc.json');
const alloc = JSON.parse(readFileSync(ALLOC_PATH, 'utf8'));
const p = loadProtocol();

describe('ValidatorManager 创世 fixture 的出处（T092）', () => {
  test('fixture 记录了它是用哪个版本的 CLI 与 subnet-evm 提取的', () => {
    assert.ok(alloc.extractedFrom, '缺少 extractedFrom —— 没有出处就无法判断是否过期');
    for (const k of ['avalancheCliVersion', 'subnetEvmVersion', 'command', 'date']) {
      assert.ok(alloc.extractedFrom[k], `extractedFrom.${k} 缺失`);
    }
  });

  test('出处的 CLI 版本必须等于 protocol.json 声明的版本', () => {
    assert.equal(
      alloc.extractedFrom.avalancheCliVersion,
      p.avalanche.avalancheCliVersion,
      `fixture 是用 CLI ${alloc.extractedFrom.avalancheCliVersion} 提取的，`
      + `而 protocol.json 现在声明 ${p.avalanche.avalancheCliVersion}。\n`
      + '  ValidatorManager 的字节码与存储由 CLI 版本决定 —— 版本变了必须重新提取：\n'
      + '    tools/protocol/extract-vm-alloc.sh\n'
      + '  然后 npm run protocol:render 重新生成创世，并更新 blockchain/genesis/karmachain.genesis.hash。',
    );
  });

  test('出处的 subnet-evm 版本必须等于 protocol.json 声明的版本', () => {
    assert.equal(
      alloc.extractedFrom.subnetEvmVersion,
      p.avalanche.subnetEvmVersion,
      `fixture 是在 subnet-evm ${alloc.extractedFrom.subnetEvmVersion} 下提取的，`
      + `而 protocol.json 现在声明 ${p.avalanche.subnetEvmVersion} —— 同上，须重新提取`,
    );
  });

  test('提取脚本仍在仓库里 —— 否则"重新提取"这条修正路径不可执行', () => {
    const script = resolve(REPO_ROOT, 'tools/protocol/extract-vm-alloc.sh');
    assert.ok(existsSync(script), '缺少 tools/protocol/extract-vm-alloc.sh');
    assert.ok(alloc.extractedFrom.command.includes('avalanche'),
      'extractedFrom.command 应记录实际执行的 CLI 命令，供人复核');
  });

  test('fixture 的内容结构完好：账户非空、地址与代码格式正确', () => {
    const accounts = Object.entries(alloc.alloc ?? {});
    assert.ok(accounts.length > 0, 'alloc 不得为空');
    for (const [addr, entry] of accounts) {
      assert.match(addr, /^(0x)?[0-9a-fA-F]{40}$/, `账户地址格式不对：${addr}`);
      // 至少要有 code 或 balance 之一，否则这条 alloc 没有意义
      assert.ok(entry.code || entry.balance, `${addr} 既无 code 也无 balance`);
      if (entry.code) assert.match(entry.code, /^0x[0-9a-fA-F]+$/, `${addr} 的 code 不是十六进制`);
    }
  });

  test('fixture 确实被创世生成消费了 —— 否则本测试守的是一份死文件', () => {
    const renderer = readFileSync(resolve(REPO_ROOT, 'tools/protocol/render-genesis.mjs'), 'utf8');
    assert.match(renderer, /validator-manager\.alloc\.json/,
      'render-genesis.mjs 应当读取该 fixture；若已改名或不再使用，本测试须一并更新');
    // 而且 fixture 里的账户应当出现在生成的创世里
    const genesis = JSON.parse(readFileSync(resolve(REPO_ROOT, 'blockchain/genesis/karmachain.genesis.json'), 'utf8'));
    const genesisAddrs = new Set(Object.keys(genesis.alloc ?? {}).map((a) => a.toLowerCase().replace(/^0x/, '')));
    for (const addr of Object.keys(alloc.alloc)) {
      assert.ok(genesisAddrs.has(addr.toLowerCase().replace(/^0x/, '')),
        `fixture 中的账户 ${addr} 未出现在生成的创世里`);
    }
  });
});
