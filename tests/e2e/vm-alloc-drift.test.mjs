// T045：ValidatorManager fixture 漂移哨兵。
//
// blockchain/genesis/validator-manager.alloc.json 是从 Avalanche CLI 生成的参考创世里提取的
// （CLI 对 --genesis 原样导入，不会注入 PoA 合约，所以我们必须自己把这些合约放进创世 —— research R-07）。
// 一旦 CLI 版本变化，这些合约的字节码/地址可能改变；本测试在容器内重新提取并与提交的 fixture 比对，
// 使"升级 CLI 却忘了重提取 fixture"这件事无法悄悄发生。
//
// 需要 devnet 容器在运行（提取脚本调用容器内的 avalanche CLI）：
//   node --test tests/e2e/vm-alloc-drift.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT, loadProtocol } from '../../tools/protocol/load.mjs';

const FIXTURE = resolve(REPO_ROOT, 'blockchain/genesis/validator-manager.alloc.json');
const EXTRACT = resolve(REPO_ROOT, 'tools/protocol/extract-vm-alloc.sh');
const protocol = loadProtocol();

const devnetRunning = (() => {
  try {
    const out = execFileSync('docker', ['compose', 'ps', '--format', '{{.Name}} {{.State}}'], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return /karmachain-devnet\s+running/.test(out);
  } catch { return false; }
})();

describe('ValidatorManager fixture drift', { skip: !devnetRunning && 'devnet is not running (scripts/devnet-start)', timeout: 600_000 }, () => {
  const committed = JSON.parse(readFileSync(FIXTURE, 'utf8'));

  test('the committed fixture records which CLI version produced it', () => {
    assert.equal(committed.extractedFrom.avalancheCliVersion, protocol.avalanche.avalancheCliVersion,
      'fixture was extracted with a different Avalanche CLI than protocol.json pins — re-extract it');
    assert.equal(committed.extractedFrom.subnetEvmVersion, protocol.avalanche.subnetEvmVersion);
  });

  test('re-extracting inside the container reproduces the committed fixture', () => {
    // 把提取脚本喂给容器内的 bash（脚本不在镜像里，只在仓库中）
    const script = readFileSync(EXTRACT);
    const fresh = execFileSync('docker', ['compose', 'exec', '-T', 'devnet', 'bash', '-s'], {
      cwd: REPO_ROOT, input: script, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const extracted = JSON.parse(fresh);

    // 元数据里的 date 每次不同，比对时忽略
    const strip = (o) => ({ ...o, extractedFrom: { ...o.extractedFrom, date: undefined } });
    assert.deepEqual(strip(extracted).alloc, strip(committed).alloc,
      'ValidatorManager contract allocation drifted — the Avalanche CLI now injects different contracts.\n'
      + '→ 这是协议级变更（创世内容会变）：重新提取 fixture、npm run protocol:render、更新创世哈希基准、重置并跑全部回归（宪法第十五条）。');
    assert.deepEqual(extracted.warpConfig, committed.warpConfig, 'warpConfig drifted');
  });

  test('the fixture contains exactly the four PoA contracts at their fixed addresses', () => {
    const addresses = Object.keys(committed.alloc).sort();
    assert.equal(addresses.length, 4, `expected 4 contract accounts, got ${addresses.length}`);
    for (const a of addresses) {
      assert.match(a, /^[0-9a-f]{40}$/, 'addresses must be lowercase and un-prefixed');
      const entry = committed.alloc[a];
      assert.match(entry.code, /^0x[0-9a-f]+$/i, `${a} must carry bytecode`);
      assert.equal(entry.balance, '0x0', `${a} must have zero balance`);
    }
  });

  test('the generated genesis still contains every fixture contract', () => {
    const genesis = JSON.parse(readFileSync(resolve(REPO_ROOT, 'blockchain/genesis/karmachain.genesis.json'), 'utf8'));
    for (const [addr, entry] of Object.entries(committed.alloc)) {
      const inGenesis = genesis.alloc[addr];
      assert.ok(inGenesis, `fixture contract ${addr} missing from the generated genesis`);
      assert.equal(inGenesis.code, entry.code, `bytecode mismatch for ${addr}`);
    }
  });
});
