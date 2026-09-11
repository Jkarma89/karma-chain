// 代理容器的健康判定**只回答代理自己**，不许借用链的健康位。
//
// ## 这条守卫为什么存在
//
// 2026-09-10，两个 Primary 全停时 RPC 入口间歇性返回 502，而五个 L1 验证者在各自
// 端口上全部 200、高度一致、直连提交的交易确认于区块 835（4108 ms）。**链好着，门坏了。**
//
// 成因链（每一环都有 nginx 与容器日志证据）：
//
//  1. 两个 Primary 停 → 五个 L1 自报的**综合**健康位返回 503（它含 P 链可达性）
//  2. 代理容器的 Docker healthcheck 是 `wget … http://127.0.0.1:<port>/ext/health`
//     —— **经由代理自己**打到上游（日志里 User-Agent 为 `Wget`、client 为 127.0.0.1）
//  3. `proxy_next_upstream … http_503` 把上游的 503 应答**计为一次失败**
//  4. `max_fails=1 fail_timeout=60s` —— 一次失败就关该上游 60 秒
//  5. `proxy_next_upstream_tries 5` 让**同一个** healthcheck 依次试完五个上游
//     → **一次探测毒遍全部**（日志里一条请求连续四行 `upstream server temporarily disabled`）
//  6. healthcheck 间隔 10 秒 < 60 秒惩罚期 → 惩罚期永不排空
//  7. 真实客户端流量随之 `no live upstreams` → **502**
//
// ## 这是同一个陷阱下沉了一层
//
// 003 的 FR-013 在**面板**里禁掉了综合健康位（`tests/unit/dashboard-boundaries.test.mjs`）；
// 002 的**节点** healthcheck（`docker/node/healthcheck.sh`）当年也刻意避开了它并写明理由
// （`specs/002-resilient-validator-network/contracts/node-runtime.md`）。
// 而 002 的**代理** healthcheck 用的正是它 —— **一个地方记住了教训，另一个地方没有。**
//
// 所以这套件守两件事：
//   ① 任何容器的健康判定都不得请求 `/ext/health`（FR-001 / FR-024）
//   ② 代理的探测位置**不得 `proxy_pass`** —— 不接触上游，就没有东西在制造失败（FR-003）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT, loadProtocol } from '../../tools/protocol/load.mjs';
import { PROXY_PROBE_PATH } from '../../tools/protocol/render-rpc-proxy.mjs';

const protocol = loadProtocol();
const DEPLOYMENTS = Object.keys(protocol.topology.deployments);

/**
 * 剥注释 —— **扫源码前必须先做这一步**。
 *
 * 003 期间这一条栽过三次：解释性注释里出现的字符串被守卫当成了真配置
 * （端口范围写在注释里、`/workspace/node_modules` 写在注释里、地址写在注释里）。
 * 而本文件顶上那一大段说明**正好**反复提到 `/ext/health` —— 不剥注释的话，
 * 这个守卫会把自己的说明文字判为违规。
 *
 * 同时剥 JS（`//`、块注释）、YAML/nginx（`#`）与 HTML 三种形态。
 * `//` 的那条前面留一个"不是冒号"的字符，避免把 `http://` 剥掉。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/^[ \t]*#[^\n]*/gm, ' ');
}

const composeFiles = () =>
  readdirSync(resolve(REPO_ROOT, 'docker', 'compose'))
    .filter((f) => f.endsWith('.yml'))
    .map((f) => ({ name: f, text: readFileSync(resolve(REPO_ROOT, 'docker', 'compose', f), 'utf8') }));

/**
 * 本来就**没有** healthcheck 的 compose —— 逐个列名，不用模式匹配。
 *
 * `bootstrap.yml` 是一次性建链容器（跑完即退，唯一用到 Avalanche CLI 的地方），
 * 它没有长期运行的服务，也就没有健康位。
 *
 * **为什么要显式列出来而不是"没有就跳过"**：003 期间踩过一次 ——
 * 一条 e2e 用 `localVictimSkip` 当跳过条件，而那个函数只负责生成消息，
 * 于是用例**永远**跳过、永远绿。静默跳过会把"这里没有守卫"伪装成"这里守卫通过了"。
 * 列成白名单之后，任何**新增**的无健康位 compose 都会让 §"覆盖面"那条断言变红。
 */
const NO_HEALTHCHECK = new Set(['bootstrap.yml']);

const confOf = (deployment) =>
  readFileSync(resolve(REPO_ROOT, 'blockchain', 'nodes', deployment, 'rpc-proxy.conf'), 'utf8');

/** 抽出 compose 里所有 healthcheck 的 `test:` 行（节点的与代理的都算）。 */
const healthcheckLines = (yaml) =>
  stripComments(yaml).split('\n').filter((l) => /^\s*test:\s*\[/.test(l));

describe('健康判定不得借用 avalanchego 的综合健康位（FR-001 / FR-024）', () => {
  test('有 compose 可扫 —— 否则本套件在空转', () => {
    const files = composeFiles();
    assert.ok(files.length >= 1, `期望至少 1 份 compose，实际 ${files.length}`);
  });

  test('覆盖面：每一份 compose 要么有 healthcheck，要么在白名单里', () => {
    const without = composeFiles()
      .filter(({ text }) => healthcheckLines(text).length === 0)
      .map(({ name }) => name);
    const unexpected = without.filter((n) => !NO_HEALTHCHECK.has(n));
    assert.equal(unexpected.length, 0,
      `以下 compose 没有任何 healthcheck，也不在白名单里：${unexpected.join(', ')}\n`
      + '  要么它该有一个健康位，要么它是一次性容器 —— 后者请登记进 NO_HEALTHCHECK 并写明理由。\n'
      + '  **静默跳过会把"这里没有守卫"伪装成"这里守卫通过了"。**');
    // 反向：白名单里的项如果哪天长出了 healthcheck，也要被发现（白名单会过期）
    const stale = [...NO_HEALTHCHECK].filter((n) => !without.includes(n));
    assert.equal(stale.length, 0,
      `白名单已过期：${stale.join(', ')} 现在有 healthcheck 了（或文件已不存在）。\n`
      + '  过期的白名单等于一个不会变红的豁免 —— 请把它从 NO_HEALTHCHECK 里去掉。');
  });

  for (const { name, text } of composeFiles().filter(({ name: n }) => !NO_HEALTHCHECK.has(n))) {
    test(`${name} 的 healthcheck 不请求 /ext/health`, () => {
      const lines = healthcheckLines(text);
      assert.ok(lines.length >= 1, `${name} 里没有找到任何 healthcheck 的 test: 行 —— 断言在空转`);
      const bad = lines.filter((l) => l.includes('/ext/health'));
      assert.equal(bad.length, 0,
        `${name} 的健康判定请求了综合健康位：\n  ${bad.join('\n  ')}\n`
        + '  那个位包含 P 链可达性 —— 两个 Primary 一停，五个**工作正常**的 L1 会同时被判不健康。\n'
        + '  更坏的是：这个请求经由代理自己打到上游，nginx 把 503 计为上游失败，\n'
        + '  max_fails=1 一次就关 60 秒，而探测间隔 10 秒 —— 惩罚期永不排空，真实流量一起吃 502。\n'
        + '  2026-09-10 实测过。改用一个由 nginx 自己应答、不碰上游的位置。');
    });
  }

  test('生成器里也不留这个字符串（剥注释后）', () => {
    const src = stripComments(readFileSync(resolve(REPO_ROOT, 'tools', 'protocol', 'render-compose.mjs'), 'utf8'));
    assert.doesNotMatch(src, /\/ext\/health/,
      'render-compose.mjs 的**代码**里仍出现 /ext/health —— 生成物会跟着回去。\n'
      + '  （注释里解释"为什么不用它"是允许的，本断言已剥注释。）');
  });

  test('剥注释这件事本身是有效的 —— 否则上一条会把自己的说明判为违规', () => {
    assert.doesNotMatch(stripComments('// 刻意不用 /ext/health，理由见 FR-001'), /\/ext\/health/);
    assert.doesNotMatch(stripComments('# 其余路径原样转发（/ext/health、/ext/info）'), /\/ext\/health/);
    // 但真正的配置不能被剥掉。
    // 样例串里**不写**端口与地址 —— 002 的 no-hardcode 守卫会把协议取值的副本抓出来，
    // 而它是对的：测试夹具里的字面量和真配置一样会漂移。
    assert.match(stripComments('test: ["CMD", "wget", "-q", "-O", "-", "http://host/ext/health"]'), /\/ext\/health/);
  });
});

describe('代理的探测位置不接触上游（FR-003）', () => {
  test('探测路径由生成器**单一导出**，不是各处各写一份', () => {
    assert.equal(typeof PROXY_PROBE_PATH, 'string');
    assert.ok(PROXY_PROBE_PATH.startsWith('/'), `探测路径应是一个绝对路径，实际 ${PROXY_PROBE_PATH}`);
    // 它必须落在 avalanchego 的路径空间之外 —— 否则会和真实 API 撞车
    assert.doesNotMatch(PROXY_PROBE_PATH, /^\/ext\b/,
      `${PROXY_PROBE_PATH} 落在 avalanchego 的 /ext 命名空间里 —— 会和真实 API 路径撞车`);
  });

  for (const d of DEPLOYMENTS) {
    describe(`部署形态 ${d}`, () => {
      const conf = confOf(d);

      test('配置里有那个探测位置，且是精确匹配', () => {
        assert.match(conf, new RegExp(`location\\s+=\\s+${PROXY_PROBE_PATH}\\s*\\{`),
          `缺 \`location = ${PROXY_PROBE_PATH}\`。\n`
          + '  **必须用 `=` 精确匹配**：前缀匹配会被 `location /` 那个 catch-all 抢走，\n'
          + '  于是探测又被转发到上游 —— 回到缺陷本身。');
      });

      test('探测位置的块里没有 proxy_pass —— 一行都不许有', () => {
        const m = conf.match(new RegExp(`location\\s+=\\s+${PROXY_PROBE_PATH}\\s*\\{([^}]*)\\}`));
        assert.ok(m, `取不到 \`location = ${PROXY_PROBE_PATH}\` 的块内容`);
        const body = stripComments(m[1]);
        assert.doesNotMatch(body, /proxy_pass/,
          `探测位置里出现了 proxy_pass：\n  ${body.trim()}\n`
          + '  那就又接触上游了 —— 而"探测在制造上游失败"正是本期要修的病因。\n'
          + '  这个位置必须由 nginx **自己**应答（return）。');
        assert.match(body, /\breturn\s+200\b/,
          '探测位置应当由 nginx 自己 `return 200` —— 否则它什么也不回答');
      });

      test('探测位置不影响既有的两个 location', () => {
        // 既有行为一律保持（FR-010）：改写块与 catch-all 都还在，且仍然 proxy_pass
        assert.match(conf, /location\s+\/ext\/bc\/[^/]+\/\s*\{/, '改写块不见了');
        assert.match(conf, /location\s+\/\s*\{/, 'catch-all 块不见了');
        const blocks = [...conf.matchAll(/location[^{]*\{([^}]*)\}/g)].map((x) => x[1]);
        const passing = blocks.filter((b) => /proxy_pass/.test(b));
        assert.equal(passing.length, 2,
          `期望恰好 2 个 location 仍在 proxy_pass（改写块 + catch-all），实际 ${passing.length}。\n`
          + '  多了说明探测位置也在转发；少了说明既有转发被动了。');
      });
    });
  }
});

describe('compose 的 healthcheck 指向那个探测位置', () => {
  test('至少有一份 compose 带走 HTTP 的代理健康位 —— 否则下面整组在空转', () => {
    const n = composeFiles().filter(({ text }) => healthcheckLines(text).some((l) => /http:\/\//.test(l))).length;
    assert.ok(n >= 1, `没有任何 compose 的 healthcheck 走 HTTP —— 本组断言无对象（实际 ${n} 份）`);
  });

  for (const { name, text } of composeFiles().filter(({ name: n }) => !NO_HEALTHCHECK.has(n))) {
    test(`${name} 的代理 healthcheck 用的是探测位置`, () => {
      const lines = healthcheckLines(text);
      // 代理的那条是走 HTTP 的；节点的那条是跑镜像里的脚本
      const http = lines.filter((l) => /http:\/\//.test(l));
      // 不用 `if (…) return` 静默跳过：那会让"这份 compose 没有代理"和
      // "这份 compose 的代理健康位写对了"在结果里长得一模一样。
      assert.ok(http.length >= 1,
        `${name} 的 healthcheck 里没有一条走 HTTP —— 代理服务不见了？\n`
        + '  每一份非一次性 compose 都应当带一个 RPC 代理（002 的 FR：每个故障边界一个入口）。');
      for (const l of http) {
        assert.ok(l.includes(PROXY_PROBE_PATH),
          `${name} 的代理 healthcheck 没有指向 ${PROXY_PROBE_PATH}：\n  ${l.trim()}`);
      }
    });
  }
});
