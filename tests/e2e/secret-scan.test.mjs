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


// ---------------------------------------------------------------- 运行时日志（FR-026）
//
// 这一段整体是 2026-09-09 重写的。原先的三条测试都是 001 时代的，而且**自 T080 起一直是
// 永久跳过的**（一个安全需求的测试静默失效了）：
//
//   1. 存活判据找的是名为 `karmachain-devnet` 的容器 —— 那是 T080 退役的单容器编排，
//      于是 devnetRunning 恒为 false，整块永远 SKIP。
//   2. 取日志用 `docker compose exec devnet devnet-logs` —— 那个服务不存在了。
//      002 的入口是 `scripts/devnet-logs.sh <node>`。
//   3. 有一条断言"`--raw` 会暴露密钥材料，否则上面那条脱敏测试就是空的"。这条前提在 002 下
//      **已经不成立**：001 时 CLI 用 `--staking-tls-key-file-content` 把私钥**内联**成启动标志，
//      avalanchego 会把全部标志写进 main.log；002 改为传**文件路径**（研究 R-03），
//      main.log 里该类字段零命中 —— 暴露点从构成上就消失了。
//      所以在 002 下 `--raw` 里本就没有密钥可暴露，那条断言只会失败。
//   4. 还有一条读 `docker compose logs devnet` 找 READY 摘要 —— 同样依赖已退役的服务，
//      而 002 的 READY 摘要是 `scripts/devnet-start` 打到终端的，不在容器日志里。
//
// 重写后的三条各自守不同的东西，并且**都能真跑**（跨机形态下按本机承载的节点自行收敛）。
const localNodeContainers = (() => {
  try {
    return execFileSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => /^karmachain-(l1|primary)-\d+$/.test(s))
      .map((s) => s.replace(/^karmachain-/, ''));
  } catch { return []; }
})();

const logsOf = (node, ...args) => execFileSync('sh', ['scripts/devnet-logs.sh', node, ...args], {
  cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MSYS_NO_PATHCONV: '1' },
});
const inNode = (node, ...cmd) => execFileSync('docker', ['exec', `karmachain-${node}`, ...cmd], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MSYS_NO_PATHCONV: '1' },
});

describe('运行时日志脱敏（FR-026）', {
  skip: localNodeContainers.length
    ? undefined
    : '本机没有运行中的节点容器 —— 跨机形态下每台机器只跑本边界的节点；先 scripts/devnet-start',
}, () => {
  test('devnet-logs 的默认输出，对本机每个节点都不含密钥材料', () => {
    const leaks = [];
    for (const node of localNodeContainers) {
      for (const args of [[], ['--chain'], ['--stdout']]) {
        let out;
        try { out = logsOf(node, ...args, '-n', '100000'); } catch { continue; }  // 该日志文件可能还不存在
        const where = `${node}${args.length ? ` ${args.join(' ')}` : ''}`;
        if (PEM_PRIVATE_KEY.test(out)) leaks.push(`${where}: PEM 私钥块`);
        for (const blob of validatorKeyBlobs) {
          if (blob.length > 24 && out.includes(blob)) leaks.push(`${where}: 验证者密钥材料（${blob.slice(0, 16)}…）`);
        }
        for (const key of knownHexKeys) {
          if (out.includes(key)) leaks.push(`${where}: 账户私钥 ${key.slice(0, 12)}…`);
        }
        if (out.includes(knownMnemonic)) leaks.push(`${where}: 助记词`);
      }
    }
    assert.deepEqual(leaks, [], `日志仍然泄漏密钥材料：\n  ${leaks.join('\n  ')}`);
  });

  // 上面那条只能证明"真日志里没有可泄漏的东西"，**证明不了脱敏过滤器本身管用** ——
  // 而 002 的真日志里恰好什么都没有（密钥走文件路径），所以那条测试对过滤器是空的。
  // 这里用一条**合成**日志行直接测过滤器：写进节点的 /data/logs，比对默认输出与 --raw。
  // 这是本会话反复吃到的那个教训的应用：静态/间接的绿灯证明不了机制成立。
  test('脱敏过滤器确实屏蔽 *-content 字段的值，而 --raw 会放出来', () => {
    const node = localNodeContainers[0];
    const probe = 'fr026-redact-probe.log';
    // 刻意不用真密钥：判据是"长度 >= 8 的 *-content 值被屏蔽"，与值本身无关。
    const secret = 'NOT-A-REAL-KEY-0123456789abcdef0123456789';
    try {
      inNode(node, 'sh', '-c', `printf '{"stakingTlsKeyContent":"${secret}"}\n' > /data/logs/${probe}`);
      const def = logsOf(node, '--file', probe, '-n', '10');
      const raw = logsOf(node, '--file', probe, '-n', '10', '--raw');

      assert.match(def, /<已脱敏>/, `默认输出应当出现脱敏标记，实际："${def.trim()}"`);
      assert.equal(def.includes(secret), false, '默认输出不该包含该值');
      assert.equal(raw.includes(secret), true,
        '--raw 应当原样输出 —— 否则无法区分"过滤器生效"与"日志里本来就没有"');
    } finally {
      try { inNode(node, 'rm', '-f', `/data/logs/${probe}`); } catch { /* 清理失败不影响判定 */ }
    }
  });

  test('启动脚本不会把任何私钥打进 READY 摘要', () => {
    // 002 的 READY 摘要由 scripts/devnet-start 打到终端，不在容器日志里（001 那条读
    // `docker compose logs devnet` 的测试因此失效）。改为静态断言：脚本源码里不出现任何
    // 已知私钥／助记词，且仍然保留对公开测试密钥的警告（那句警告在 chain-info 生成物里）。
    for (const s of ['scripts/devnet-start.sh', 'scripts/devnet-start.ps1']) {
      const src = readFileSync(join(REPO_ROOT, s), 'utf8');
      for (const key of knownHexKeys) {
        assert.equal(src.includes(key), false, `${s} 里出现了账户私钥 ${key.slice(0, 12)}…`);
      }
      assert.equal(src.includes(knownMnemonic), false, `${s} 里出现了助记词`);
    }
    // 判据取"含义"而不是"原句"：001 那条测试写死的是 `NEVER use outside this local network`，
    // 而那句措辞早已改掉（现在是 `NEVER use them on any real network`）。
    // 写死原句会让这条断言随文案变动而假失败 —— 我搬过来时就正好踩了一次。
    const info = readFileSync(join(REPO_ROOT, 'docs/public/chain-info.json'), 'utf8');
    assert.match(info, /never use/i, '对外制品必须警告这些密钥不可使用');
    assert.match(info, /(production|real network)/i, '警告须点明"生产／真实网络"，而不只是含糊的提醒');
  });
});
