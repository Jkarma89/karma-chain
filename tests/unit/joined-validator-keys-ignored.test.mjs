// 创世**之后**加入的验证者，私钥**不得进版本库**（功能 005 / T030 / FR-019）。
//
// ## 这条差点没有
//
// `.gitignore` 里原本有一行 `!blockchain/validators/dev/**/*.key` —— 把那个目录下的
// `.key` 全部放行。对创世那五个是对的：它们按宪法第四条 v1.1.0 的例外条款提交入库
// （公开的开发密钥、仅在本地网络有效、在密钥扫描白名单里、生产技术上无法接受）。
//
// 但对**创世之后加入**的验证者，005 的安全约束是：私钥必须在目标机器上生成、
// **不得经过仓库、对话或任何中间环节**。那一行会让新节点的 `staker.key` 与 `signer.key`
// 被一次 `git add -A` 直接提交 —— 而提交进 git 的密钥，删掉也还在历史里。
//
// 修法用的是 git 的一条性质：**忽略规则不影响已跟踪的文件**。
// 去掉那条否定之后，创世那五个（已在索引里）照旧跟踪，新生成的被忽略。
//
// ## 为什么用 git 本身来断言
//
// 只扫 `.gitignore` 的文本会漏 —— 忽略规则有优先级、有后置否定、有目录级覆盖，
// 读文本推断不出最终结果。所以这里跑 `git check-ignore`：**问 git 它自己怎么判**。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { loadProtocol, REPO_ROOT } from '../../tools/protocol/load.mjs';

const git = (...args) => {
  try {
    return { ok: true, out: execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim() };
  } catch (e) {
    return { ok: false, out: (e.stdout ?? '').toString().trim() };
  }
};

/** 造一个**未来的**验证者密钥目录来问 git：这些文件会被忽略吗？ */
const PROBE_INDEX = 99;
const PROBE_DIR = resolve(REPO_ROOT, 'blockchain', 'validators', 'dev', `node-${PROBE_INDEX}`);

const withProbeDir = (fn) => {
  const created = !existsSync(PROBE_DIR);
  mkdirSync(PROBE_DIR, { recursive: true });
  try {
    for (const f of ['staker.key', 'signer.key', 'staker.crt']) writeFileSync(join(PROBE_DIR, f), '');
    return fn();
  } finally {
    if (created) rmSync(PROBE_DIR, { recursive: true, force: true });
  }
};

describe('新验证者的**私钥**必须被 git 忽略', () => {
  test('git 本身确认 staker.key 与 signer.key 被忽略', () => {
    withProbeDir(() => {
      for (const f of ['staker.key', 'signer.key']) {
        const rel = `blockchain/validators/dev/node-${PROBE_INDEX}/${f}`;
        const r = git('check-ignore', '-q', rel);
        assert.ok(r.ok,
          `\`${rel}\` **没有**被 git 忽略。\n`
          + '  创世之后加入的验证者，私钥必须留在目标机器上 ——\n'
          + '  一次 `git add -A` 就会把它提交进去，而提交进 git 的密钥，删掉也还在历史里。\n'
          + '  检查 .gitignore 里有没有重新出现 `!blockchain/validators/dev/**/*.key` 这类否定。');
      }
    });
  });

  test('**公开**材料不被忽略（staker.crt 要能进库）', () => {
    withProbeDir(() => {
      const rel = `blockchain/validators/dev/node-${PROBE_INDEX}/staker.crt`;
      const r = git('check-ignore', '-q', rel);
      assert.ok(!r.ok,
        `\`${rel}\` 被忽略了 —— 证书是**公开**材料，NodeID 就是从它派生的。\n`
        + '  把它一起挡掉，等于把"只有公开材料进仓库"这条路也堵了。');
    });
  });
});

describe('创世那五个**仍然**被跟踪（这条改动不许把它们踢出去）', () => {
  const p = loadProtocol();

  test('每个创世验证者的三个文件都在索引里', () => {
    const tracked = new Set(git('ls-files', 'blockchain/validators/dev/').out.split('\n'));
    for (const v of p.validators.nodes) {
      if (v.identity?.origin === 'joined') continue;   // 新成员本就不该在库里
      for (const f of ['staker.crt', 'staker.key', 'signer.key']) {
        assert.ok(tracked.has(`${v.keyDir}${f}`),
          `${v.keyDir}${f} 不在索引里 —— 创世成员的材料是建链制品的一部分，\n`
          + '  丢了它，identity-crosscheck 与节点启动都没法核对身份。\n'
          + '  注意：git 的忽略规则**不影响已跟踪的文件**，所以正常情况下改 .gitignore\n'
          + '  不会踢掉它们；这条红了说明有人真的 git rm 过。');
      }
    }
  });

  test('工作区里这些文件没有待提交的改动（不是被误改过）', () => {
    assert.equal(git('status', '--short', '--', 'blockchain/validators/dev/').out, '',
      '验证者密钥目录里有未提交的改动 —— 密钥材料不该被改动，'
      + '改了它就换了身份，而链上注册的是旧的那个');
  });
});

describe('哪条规则在生效要说得出来', () => {
  test('git 能指出是 .gitignore 的第几行在挡（排查时要能直接定位）', () => {
    // 这条不是凑数：忽略规则有优先级、后置否定、目录级覆盖，
    // 出问题时最要紧的是知道**是哪一行**在生效。-v 给出文件与行号。
    withProbeDir(() => {
      const r = git('check-ignore', '-v', `blockchain/validators/dev/node-${PROBE_INDEX}/signer.key`);
      assert.ok(r.ok, 'signer.key 竟然没被忽略 —— 见上一组断言');
      assert.match(r.out, /^\.gitignore:\d+:/,
        `git 没有指出是哪条规则在生效，拿到的是：${r.out}`);
    });
  });
});
