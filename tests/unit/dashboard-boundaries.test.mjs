// T013a —— 面板的三条静态边界守卫（功能 003）。
//
// 本文件是 `/speckit-analyze` 补上的缺口。三条被守的规则原先都**没有会变红的守卫**：
//
// ## ① 不得请求 `/ext/health`（FR-013）
//
// 5 个 L1 验证者带 `partial-sync-primary-network=true`，其节点自报的综合健康位
// **包含 P 链可达性**。002 实测：停掉两个 Primary 之后这些健康位全部转假，
// 而 L1 仍在正常出块（4 笔交易全部 1.0s 确认）；`devnet-status` 当时报
// "7/7 nodes NOT healthy" 而链完全可用。
//
// 2026-09-10 又原地复现了一次：ubuntu-1/2 离线时 l1-1 的 `/ext/health` 返回 **503**，
// 而它自己 `healthy / 高度 748`。
//
// 这条免疫是从 002 的 `probeNode` **继承**来的（它只取 info.* 与 eth_blockNumber）。
// 原先唯一的守卫是 `tests/e2e/dashboard-primary-loss.test.mjs`，而它在跨机形态下
// **必然跳过**（两个 Primary 分处 ubuntu-1/ubuntu-2，docker 只能操作本机容器）——
// 也就是说在实际的五机部署上，这条规则一个长期运行的守卫都没有。
// quickstart 场景 F 自己写着"必须由本场景守住"，而那恰好是会跳过的那个场景。
//
// ## ② 不得调用容器运行时（FR-030 / FR-032）
//
// 核心判据不得依赖 docker 访问；面板也不得对节点执行任何操作类动作。
// 这两条都是"不得有某能力"型要求 —— 原先**零守卫**，因为"没有某功能"不会自己报错。
//
// ## ③ 上面两条守卫本身会变红吗
//
// 002 的第一条教训：静态守卫只证明了"没用错写法"，没证明"用对了"。
// 所以每条都配一个反向用例。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { REPO_ROOT } from '../../tools/protocol/load.mjs';

const DASHBOARD = join(REPO_ROOT, 'tools', 'dashboard');

function collectSources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { collectSources(full, out); continue; }
    if (/\.(mjs|html)$/.test(name)) out.push(full);
  }
  return out;
}

/** 只剥注释 —— 这里要连字符串一起扫（`'/ext/health'` 正是要抓的东西）。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

const RULES = [
  {
    re: /\/ext\/health/,
    fr: 'FR-013',
    why: '节点自报的综合健康位包含 P 链可达性 —— Primary 一挂，5 个工作正常的验证者会被同时判为不健康。'
       + '判据必须以"本节点能否参与 L1 出块"为准（既有 probeNode 只取 info.* 与 eth_blockNumber）',
    violation: "const r = await fetch(base + '/ext/health');",
  },
  {
    re: /\bnode:child_process\b|\bchild_process\b/,
    fr: 'FR-030 / FR-032',
    why: '核心判据不得依赖 docker 访问；面板也不得对节点执行操作类动作。'
       + '容器事实只能经 readContainers() 读那份由 devnet-status 写出的快照，面板自己不起进程',
    violation: "import { execFileSync } from 'node:child_process';",
  },
  {
    re: /\bexecFileSync?\s*\(|\bspawnSync?\s*\(|\bexecSync\s*\(/,
    fr: 'FR-030 / FR-032',
    why: '同上 —— 起子进程就是通往 docker 的路',
    violation: "spawnSync('docker', ['restart', 'karmachain-l1-1']);",
  },
  {
    re: /(^|[^\w-])docker\s+(run|exec|inspect|restart|stop|start|kill|compose)\b/,
    fr: 'FR-032',
    why: '面板对节点只读。重启/停止/改配置一律不做 —— 那是 scripts/devnet-node 的职责',
    violation: "const cmd = 'docker restart karmachain-l1-1';",
  },
];

describe('面板的静态边界守卫', () => {
  const files = collectSources(DASHBOARD);

  test('存在待扫描的源码 —— 否则本守卫在空转', () => {
    assert.ok(files.length > 0, 'tools/dashboard 下没有可扫描的源码');
  });

  for (const { re, fr, why } of RULES) {
    test(`不出现 ${re.source}（${fr}）`, () => {
      const hits = [];
      for (const file of files) {
        const code = stripComments(readFileSync(file, 'utf8'));
        code.split('\n').forEach((line, i) => {
          if (re.test(line)) hits.push(`${relative(REPO_ROOT, file)}:${i + 1}  ${line.trim().slice(0, 90)}`);
        });
      }
      assert.deepEqual(hits, [], `违反 ${fr}：\n  ${hits.join('\n  ')}\n\n  ${why}`);
    });
  }

  test('面板确实**不**从 /ext/health 取判据，而是从 info.* 与 eth_*', () => {
    // 正向断言：光"没有 /ext/health"还不够 —— 也要确认它真的走了另一条路。
    // 若哪天判据被换成别的东西，这一条会提醒；只靠禁止式断言则不会。
    const poll = readFileSync(join(DASHBOARD, 'poll.mjs'), 'utf8');
    assert.match(poll, /probeNode/, '探测必须复用既有 probeNode（FR-004），不另写一套');
  });
});

describe('这些守卫本身会变红吗', () => {
  for (const { re, fr, violation } of RULES) {
    test(`能抓到 ${fr} 的违规写法：${violation.slice(0, 46)}…`, () => {
      assert.ok(re.test(stripComments(violation)),
        `规则 ${re.source} 抓不到违规源码 —— 这道守卫是假的`);
    });
  }

  test('注释里提到 /ext/health 不算违规 —— 否则会逼人删掉唯一的解释', () => {
    assert.doesNotMatch(stripComments('// 刻意不请求 /ext/health，理由见 FR-013'), /\/ext\/health/);
    assert.doesNotMatch(stripComments('/* 不用 /ext/health */'), /\/ext\/health/);
  });

  test('剥注释不会把代码一起剥掉', () => {
    assert.match(stripComments("fetch('/ext/health')"), /\/ext\/health/, '代码里的必须保留');
    assert.match(stripComments("fetch('http://a/b')"), /fetch/, 'http:// 不得被当成行注释起点');
  });
});
