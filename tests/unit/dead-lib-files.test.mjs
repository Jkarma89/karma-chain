// `docker/lib/` 里哪些是活的、哪些是死的（功能 005 / T066）。
//
// ## 为什么把这件事写成守卫，而不是写成一句注释
//
// 001 是单容器时代，`docker/lib/` 下曾经七个文件一起用。002 拆成一节点一容器之后，
// 其中三个（`runtime.sh` / `nodes.sh` / `health.sh`）**没有进任何镜像、
// 也没有被任何脚本 source** —— 它们还在仓库里，但没人执行。
//
// T012 枚举时查实了这一点，并顺手把 `nodes.sh:72` 里过时的 `proto_get` 改成了
// `deploy_get`。**而一个没人执行的文件里的正确调用毫无价值** —— 那次修改的唯一
// 作用是让人以为这个文件是活的。
//
// 所以这里把"谁活谁死"变成机器可读的断言。它守两件事：
//
//   死文件**开始被引用**时变红 —— 那是一次需要有人决定的事（复活它，还是删掉它）
//   活文件**不再被引用**时变红 —— 否则本守卫会慢慢退化成"什么都没在用"的空跑
//
// **本条只记录并核实，不删除。** 宪法要求删除既有制品走明示流程，
// 而功能 005 的承诺里没有这一项 —— 删除留给单独一次清理。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, globSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { REPO_ROOT } from '../../tools/protocol/load.mjs';

/** 001 单容器时代的遗留：还在仓库里，但没人执行。 */
const DEAD = ['runtime.sh', 'nodes.sh', 'health.sh'];
/** 仍被 bootstrap 镜像 COPY 进去的。 */
const LIVE = ['protocol.sh', 'binaries.sh', 'avalanche.sh', 'preflight.sh'];

/** 受跟踪 + 未跟踪但未被忽略的文本文件（与 avalanchejs 那条守卫同一个理由）。 */
const scanFiles = () => execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard'],
  { cwd: REPO_ROOT, encoding: 'utf8' },
)
  .split(/\r?\n/)
  .filter(Boolean)
  .map((p) => p.replace(/\\/g, '/'))
  .filter((p, i, a) => a.indexOf(p) === i)
  // 只看**会执行它们**的地方：Dockerfile 与 shell 脚本。
  // spec/研究文档里提到文件名是在记述历史，不是引用。
  .filter((p) => /(^|\/)Dockerfile$/.test(p) || p.endsWith('.sh'))
  // 文件自己提到自己不算引用
  .filter((p) => !p.startsWith('docker/lib/'));

/** 某个 lib 文件有没有被"真的用起来"：被 COPY 进镜像，或被 source。 */
const referencedBy = (name) => {
  const hits = [];
  for (const p of scanFiles()) {
    const text = readFileSync(resolve(REPO_ROOT, p), 'utf8');
    // COPY docker/lib/x.sh …   或   . "…/x.sh"   或   source …/x.sh
    if (new RegExp(String.raw`(COPY[^\n]*|\.\s+|source\s+)[^\n]*\blib/${name.replace('.', '\\.')}`).test(text)) {
      hits.push(p);
    }
  }
  return hits;
};

describe('前提：扫描范围与文件都还在（防空跑）', () => {
  test('扫到的 Dockerfile 与 .sh 数量合理', () => {
    const files = scanFiles();
    assert.ok(files.length >= 10,
      `只扫到 ${files.length} 个可执行文件 —— git ls-files 的过滤可能写错了，`
      + '而在一个几乎为空的集合上断言"没人引用"毫无意义');
  });

  test(`docker/lib/ 下的 ${DEAD.length + LIVE.length} 个文件都还在`, () => {
    for (const f of [...DEAD, ...LIVE]) {
      assert.ok(existsSync(resolve(REPO_ROOT, 'docker/lib', f)), `docker/lib/${f} 不见了`);
    }
  });

  test('docker/lib/ 下没有本表之外的文件（新增要先归类）', () => {
    const actual = globSync('*.sh', { cwd: resolve(REPO_ROOT, 'docker/lib') }).sort();
    assert.deepEqual(actual, [...DEAD, ...LIVE].sort(),
      '有文件没被归进"活"或"死" —— 新增一个 lib 文件时要先回答它属于哪一类');
  });
});

describe('**反向断言**：活文件确实被引用（否则本守卫是空跑）', () => {
  for (const name of LIVE) {
    test(`${name} 被引用`, () => {
      const hits = referencedBy(name);
      assert.ok(hits.length > 0,
        `docker/lib/${name} 没有任何引用 —— 要么它也死了（那就挪进 DEAD 并说明），`
        + '要么 referencedBy 的匹配写坏了，而那会让下面"死文件没人用"的断言全部恒真');
    });
  }

  test('活文件确实是被 bootstrap 镜像 COPY 的那四个', () => {
    const dockerfile = readFileSync(resolve(REPO_ROOT, 'docker/bootstrap/Dockerfile'), 'utf8');
    for (const name of LIVE) {
      assert.match(dockerfile, new RegExp(`docker/lib/${name.replace('.', '\\.')}`),
        `bootstrap/Dockerfile 不再 COPY ${name}`);
    }
  });
});

describe('死文件：没有进任何镜像，也没有被任何脚本 source', () => {
  for (const name of DEAD) {
    test(`${name} 仍然没人执行`, () => {
      const hits = referencedBy(name);
      assert.deepEqual(hits, [],
        `docker/lib/${name} 被引用了：${hits.join('、')}\n`
        + '  它是 001 单容器时代的遗留，002 之后就没人执行了。\n'
        + '  开始用它是一次需要有人决定的事：要么确认复活它（那就把它移出本表），\n'
        + '  要么这是误用 —— 那个文件里的逻辑对当前架构可能已经不成立。');
    });
  }

  test('**bootstrap 镜像没有 COPY 任何死文件**', () => {
    const dockerfile = readFileSync(resolve(REPO_ROOT, 'docker/bootstrap/Dockerfile'), 'utf8');
    for (const name of DEAD) {
      assert.doesNotMatch(dockerfile, new RegExp(`docker/lib/${name.replace('.', '\\.')}`),
        `bootstrap/Dockerfile 开始 COPY ${name} 了`);
    }
  });

  test('节点镜像不 COPY docker/lib/ 下的任何东西', () => {
    // 节点镜像刻意不带编排层的东西（ADR-0008 / FR-015）——
    // 这一条顺带守住那个边界。
    const dockerfile = readFileSync(resolve(REPO_ROOT, 'docker/node/Dockerfile'), 'utf8');
    assert.doesNotMatch(dockerfile, /^COPY[^\n]*docker\/lib\//m,
      '节点镜像开始 COPY docker/lib/ 了 —— 那是编排层的东西，'
      + 'ADR-0008 的结构性保证正是"镜像里没有编排工具"');
  });
});
