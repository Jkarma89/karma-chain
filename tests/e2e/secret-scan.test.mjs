// T044 / FR-024 / FR-026 / SC-009：秘密扫描。
//
// 设计要点：**不按路径白名单，而是按密钥取值白名单**。仓库里任何"私钥形态的赋值"都必须解析为
// 一组已知的 DEVELOPMENT ONLY 密钥之一；出现任何未登记的密钥即失败。这比"某些目录允许有密钥"
// 强得多——它允许文档里放可复制的示例私钥（那是公开测试密钥），同时挡住真正的秘密被误提交。
//
// 运行：npm run test:secrets
// 日志相关的检查需要开发网络在运行；未运行时自动跳过。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { REPO_ROOT } from '../../tools/protocol/load.mjs';

const DEV_ACCOUNTS = join(REPO_ROOT, 'blockchain/accounts/dev-accounts.json');
const VALIDATOR_DIR = join(REPO_ROOT, 'blockchain/validators/dev');
const MARKER = 'DEVELOPMENT ONLY';

// ---------------------------------------------------------------- 已知开发密钥集合
const devAccounts = JSON.parse(readFileSync(DEV_ACCOUNTS, 'utf8'));
const knownHexKeys = new Set(devAccounts.accounts.map((a) => a.privateKey.toLowerCase()));
const knownMnemonic = devAccounts.mnemonic.phrase;

/** 验证者密钥材料（PEM 与 32 字节 BLS key）及其 base64 形式 —— avalanchego 会把它们打进日志。 */
const validatorKeyBlobs = new Set();
for (const dir of readdirSync(VALIDATOR_DIR).filter((d) => d.startsWith('node-'))) {
  for (const f of ['staker.key', 'signer.key']) {
    const buf = readFileSync(join(VALIDATOR_DIR, dir, f));
    validatorKeyBlobs.add(buf.toString('base64'));
    validatorKeyBlobs.add(buf.toString('utf8').trim());
  }
}

// ---------------------------------------------------------------- 仓库遍历
const SKIP_DIRS = new Set(['.git', 'node_modules', '.devnet', '.claude', '.specify', '.vscode', '.idea']);
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gz', '.zip', '.crt', '.pem']);
const SKIP_FILES = new Set(['package-lock.json']);

function* walk(dir = REPO_ROOT) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(REPO_ROOT, full).replace(/\\/g, '/');
    if (statSync(full).isDirectory()) { if (!SKIP_DIRS.has(name)) yield* walk(full); continue; }
    if (SKIP_FILES.has(name) || SKIP_EXT.has(extname(name))) continue;
    yield rel;
  }
}

/** 只匹配"作为私钥使用"的上下文，避免把交易哈希/创世哈希误判为密钥。 */
const KEY_ASSIGNMENT_PATTERNS = [
  /"privateKey"\s*:\s*"(0x[0-9a-fA-F]{64})"/g,
  /--private-key[= ]\s*(0x[0-9a-fA-F]{64})/g,
  /\bPRIVATE_KEY\s*=\s*"?(0x[0-9a-fA-F]{64})"?/g,
  /\bprivate[_-]?key\s*[:=]\s*"?(0x[0-9a-fA-F]{64})"?/gi,
];
const PEM_PRIVATE_KEY = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;
const MNEMONIC_LIKE = /\b(?:[a-z]{3,10}\s+){11,23}[a-z]{3,10}\b/g;

describe('secret scan (FR-024 / SC-009)', () => {
  test('every private-key assignment in the repo is a known DEVELOPMENT ONLY key', () => {
    const violations = [];
    for (const rel of walk()) {
      const content = readFileSync(join(REPO_ROOT, rel), 'utf8');
      for (const pattern of KEY_ASSIGNMENT_PATTERNS) {
        for (const m of content.matchAll(pattern)) {
          const key = m[1].toLowerCase();
          if (!knownHexKeys.has(key)) {
            const line = content.slice(0, m.index).split('\n').length;
            violations.push(`${rel}:${line}: unknown private key ${key.slice(0, 12)}…`);
          }
        }
      }
    }
    assert.deepEqual(violations, [], `unregistered private keys found:\n${violations.join('\n')}\n→ 真实私钥绝不可提交（宪法第四条）；若确为新的本地开发密钥，请加入 blockchain/accounts/dev-accounts.json`);
  });

  test('PEM private key blocks only appear in the DEVELOPMENT ONLY validator directory', () => {
    const violations = [];
    for (const rel of walk()) {
      if (rel.startsWith('blockchain/validators/dev/')) continue;
      const content = readFileSync(join(REPO_ROOT, rel), 'utf8');
      if (PEM_PRIVATE_KEY.test(content)) violations.push(rel);
    }
    assert.deepEqual(violations, [], `PEM private keys outside blockchain/validators/dev/:\n${violations.join('\n')}`);
  });

  test('any mnemonic-looking phrase is the public Anvil/Hardhat test mnemonic', () => {
    const violations = [];
    for (const rel of walk()) {
      const content = readFileSync(join(REPO_ROOT, rel), 'utf8');
      for (const m of content.matchAll(MNEMONIC_LIKE)) {
        const words = m[0].trim().split(/\s+/);
        if (words.length !== 12 && words.length !== 15 && words.length !== 18 && words.length !== 24) continue;
        // 只在出现 mnemonic/seed 语境时才当作助记词，避免把普通英文句子误判
        const around = content.slice(Math.max(0, m.index - 120), m.index + m[0].length + 40);
        if (!/mnemonic|seed[ _-]?phrase|助记词/i.test(around)) continue;
        if (m[0].trim() !== knownMnemonic) {
          const line = content.slice(0, m.index).split('\n').length;
          violations.push(`${rel}:${line}: ${words.slice(0, 3).join(' ')}… (${words.length} words)`);
        }
      }
    }
    assert.deepEqual(violations, [], `unregistered mnemonic phrases found:\n${violations.join('\n')}`);
  });

  test('the files holding key material carry the DEVELOPMENT ONLY marker', () => {
    assert.match(readFileSync(DEV_ACCOUNTS, 'utf8'), new RegExp(MARKER), `${DEV_ACCOUNTS} must be marked`);
    for (const dir of readdirSync(VALIDATOR_DIR).filter((d) => d.startsWith('node-'))) {
      const readme = join(VALIDATOR_DIR, dir, 'README.md');
      assert.match(readFileSync(readme, 'utf8'), new RegExp(MARKER), `${readme} must be marked`);
    }
  });

  test('runtime chain data is git-ignored (no node databases or keys can be committed)', () => {
    const ignored = ['.devnet/nodes.json', '.devnet/verify-report.json', 'node_modules/x', '.env'];
    for (const p of ignored) {
      const out = execFileSync('git', ['check-ignore', '-q', p], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] , encoding: 'utf8'});
      assert.equal(out, '', `${p} should be ignored`);   // check-ignore -q exits 0 with no output when ignored
    }
  });
});

// ---------------------------------------------------------------- 运行时日志
const devnetRunning = (() => {
  try {
    const out = execFileSync('docker', ['compose', 'ps', '--format', '{{.Name}} {{.State}}'], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return /karmachain-devnet\s+running/.test(out);
  } catch { return false; }
})();

const devnetLogs = (...args) => execFileSync('docker', ['compose', 'exec', '-T', 'devnet', 'devnet-logs', ...args],
  { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

describe('runtime log redaction (FR-026)', { skip: !devnetRunning && 'devnet is not running (scripts/devnet-start)' }, () => {
  test('devnet-logs output contains no key material for any node', () => {
    const leaks = [];
    for (const node of ['primary-1', 'primary-2', 'l1-1', 'l1-2', 'l1-3', 'l1-4', 'l1-5']) {
      const out = devnetLogs(node, '-n', '100000');
      if (PEM_PRIVATE_KEY.test(out)) leaks.push(`${node}: PEM private key block`);
      for (const blob of validatorKeyBlobs) {
        if (blob.length > 24 && out.includes(blob)) leaks.push(`${node}: validator key material (${blob.slice(0, 16)}…)`);
      }
      for (const key of knownHexKeys) {
        if (out.includes(key)) leaks.push(`${node}: account private key ${key.slice(0, 12)}…`);
      }
    }
    assert.deepEqual(leaks, [], `redacted logs still leak key material:\n${leaks.join('\n')}`);
  });

  test('--raw does expose the material, proving redaction is what makes the default safe', () => {
    const raw = devnetLogs('l1-1', '--raw', '-n', '100000');
    const exposed = [...validatorKeyBlobs].some((b) => b.length > 24 && raw.includes(b));
    assert.equal(exposed, true, 'expected --raw to contain the node key material (avalanchego logs its provided flags); if this fails, the redaction test above is vacuous');
  });

  test('the READY summary does not print any private key', () => {
    const logs = execFileSync('docker', ['compose', 'logs', '--no-log-prefix', 'devnet'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    const summary = logs.slice(logs.lastIndexOf('KarmaChain local devnet is READY'));
    for (const key of knownHexKeys) assert.equal(summary.includes(key), false, `READY summary leaks ${key.slice(0, 12)}…`);
    assert.match(summary, /NEVER use outside this local network/, 'the summary must still warn about the public keys');
  });
});
