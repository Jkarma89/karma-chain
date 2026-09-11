// RPC 代理的**故障转移必须够快**。
//
// 生成的 rpc-proxy.conf 里写着一句承诺："某个验证者不可用时自动换下一个 ——
// RPC 入口不随单个验证者一起挂掉"。2026-09-09 实测发现这句话当时是**不成立**的：
// 转移能转，但每个请求要 21 秒，而任何客户端的正常超时（viem 20s、MetaMask ~30s）
// 都短于它 —— 也就是说对使用者而言入口确实是挂了。
//
// 三个原因叠在一起，缺一个都会把延迟带回去：
//
// 1. **没设 `proxy_connect_timeout`**（nginx 默认 60s）。机器整台没了时，Windows 的 WFP
//    对关闭端口**静默丢包**（不回 RST），nginx 只能等满超时才判失败。
// 2. **`max_fails=2`** 在低频请求下等于没生效：请求间隔一旦超过 `fail_timeout`，
//    窗口内只累积到 1 次失败，永远到不了 2 次，死节点因此从不被标记下线。
// 3. **upstream 没有 `zone`** —— 失败状态是**每个 worker 各记一份**的。
//    nginx:alpine 默认 `worker_processes auto`，实测起了 18 个 worker，
//    于是请求散开后几乎每次都命中一个"还不知道那台已死"的 worker。
//    这一条最隐蔽：修了前两条之后 8 次请求仍然 8 次都是 2 秒，就是它。
//
// 实测效果（win-2 整域缺席期间，win-1 的代理，间隔 6 秒发 10 次）：
//   修复前：21s × 5/5
//   只修 1+2：2.01s × 8/8
//   三条齐全：~7ms × 7/10，2s × 3/10（fail_timeout 到期重探那台死节点）
//
// 本套件守的是这三条，不是具体数值 —— 数值可以调，但"故障转移要在客户端超时之内完成"
// 这个性质不能丢。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT, loadProtocol, deriveTopology } from '../../tools/protocol/load.mjs';

const protocol = loadProtocol();
const DEPLOYMENTS = Object.keys(protocol.topology.deployments);

/** 客户端能容忍的上限。viem 在本仓库配的是 20s，MetaMask 约 30s —— 取更严的那个。 */
const CLIENT_TIMEOUT_S = 20;

const confOf = (deployment) =>
  readFileSync(resolve(REPO_ROOT, 'blockchain', 'nodes', deployment, 'rpc-proxy.conf'), 'utf8');

describe('RPC 代理的故障转移在客户端超时之内完成', () => {
  test('存在部署形态可测 —— 否则本套件在空转', () => {
    assert.ok(DEPLOYMENTS.length >= 1, `期望至少 1 个部署形态，实际 ${DEPLOYMENTS.length}`);
  });

  for (const d of DEPLOYMENTS) {
    describe(`部署形态 ${d}`, () => {
      const conf = confOf(d);

      test('upstream 声明了共享内存区 zone —— 否则失败状态每个 worker 各记一份', () => {
        assert.match(conf, /^\s*zone\s+\S+\s+\S+;/m,
          'upstream 缺 `zone`。nginx 默认 worker_processes auto（实测 18 个 worker），\n'
          + '  没有共享区时 max_fails 的计数不跨 worker —— 一台机器整域缺席时，请求散到各 worker，\n'
          + '  几乎每次都命中一个"还不知道那台已死"的 worker，重新付一遍连接超时。\n'
          + '  `zone` 是开源 nginx 的指令（1.9.0+），不需要 Plus。');
      });

      test('显式设了 proxy_connect_timeout，且短于客户端超时', () => {
        const m = conf.match(/proxy_connect_timeout\s+(\d+)(m?s);/);
        assert.ok(m, 'server 段缺 `proxy_connect_timeout`。nginx 默认 60s，而机器整台没了时\n'
          + '  Windows 对关闭端口静默丢包（不回 RST），nginx 只能等满这个超时才判失败去试下一个。\n'
          + '  实测：不设它 → 每个请求 21 秒，客户端全部超时。');
        const secs = m[2] === 'ms' ? Number(m[1]) / 1000 : Number(m[1]);
        assert.ok(secs > 0 && secs < CLIENT_TIMEOUT_S / 2,
          `proxy_connect_timeout=${m[1]}${m[2]} 太长：客户端超时约 ${CLIENT_TIMEOUT_S}s，`
          + '而最坏情况是"依次试完每个后端 × 该超时"，必须留出余量。');
      });

      test('后端 max_fails=1 —— 低频请求下 max_fails>1 等于没生效', () => {
        const servers = [...conf.matchAll(/^\s*server\s+\S+\s+max_fails=(\d+)\s+fail_timeout=(\d+)s;/gm)];
        assert.ok(servers.length > 0, 'upstream 里应当有带 max_fails/fail_timeout 的 server 行');
        const bad = servers.filter(([, mf]) => Number(mf) !== 1);
        assert.equal(bad.length, 0,
          `以下后端的 max_fails 不是 1：${bad.map(([l]) => l.trim()).join(' / ')}\n`
          + '  请求间隔一旦超过 fail_timeout，窗口内就只累积到 1 次失败，永远到不了阈值 ——\n'
          + '  死节点因此从不被标记下线，每个请求都要重新付一遍连接超时。实测踩过。');
      });

      test('宣告了在 error/timeout 时转下一个后端，且尝试次数覆盖全部验证者', () => {
        assert.match(conf, /proxy_next_upstream\s+[^;]*\berror\b/, '应在 error 时转下一个');
        assert.match(conf, /proxy_next_upstream\s+[^;]*\btimeout\b/, '应在 timeout 时转下一个');

        const validators = deriveTopology({ ...protocol, topology: { ...protocol.topology, activeDeployment: d } })
          .topologyNodes.filter((n) => n.role === 'l1-validator');
        const tries = conf.match(/proxy_next_upstream_tries\s+(\d+);/);
        assert.ok(tries, '缺 `proxy_next_upstream_tries` —— 不限次数时最坏情况不可预测');
        assert.ok(Number(tries[1]) >= validators.length,
          `proxy_next_upstream_tries=${tries[1]} 少于验证者数 ${validators.length}：`
          + '最后一个健康后端可能永远轮不到');
      });

      test('upstream 列出了该形态的全部 L1 验证者', () => {
        const d2 = deriveTopology({ ...protocol, topology: { ...protocol.topology, activeDeployment: d } });
        const validators = d2.topologyNodes.filter((n) => n.role === 'l1-validator');
        for (const v of validators) {
          assert.match(conf, new RegExp(`server\\s+${v.address.replace(/\./g, '\\.')}:${v.httpPort}\\b`),
            `${v.id}（${v.address}:${v.httpPort}）不在 upstream 里 —— 少一个后端就少一分冗余`);
        }
      });
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 功能 004 追加：**这一组守的是"什么都没改"。**
//
// 上面那套件守的是"故障转移要够快"，它的值可以调。下面这一组相反 ——
// 它守的是 004 期间**一个字符都不许动**：`max_fails` / `fail_timeout` /
// `proxy_next_upstream` / `zone` / `ip_hash` / 三项超时。
//
// ## 为什么要专门写一组"测试没改的东西"
//
// 004 修的缺陷是"代理的健康探测在制造上游失败"。看到成因链里那句
// `max_fails=1 fail_timeout=60s —— 一次失败就关 60 秒`，
// **最本能的反应是"太激进了，放宽一点"。**
//
// 但那是 002 在 2026-09-09 **实测后**定下的，推导写在 render-rpc-proxy.mjs 的注释里：
//
//   - `max_fails=2 fail_timeout=10s` 在**低频请求下等于没生效**：请求间隔一旦超过
//     fail_timeout，窗口内只累积到 1 次失败，永远到不了 2 次 —— 死节点因此从不被标记，
//     每个请求都要重新付一遍连接超时。**5 次测量 5 次都付了。**
//   - `fail_timeout` 15s → 60s：反复去探一个持续死着的后端没有收益；而 `ip_hash`
//     在后端被标记/恢复时会重新分配，每分钟 4 次重探 = 每分钟 4 次机会打断
//     "读到自己刚写的"那份亲和性。
//
// **当前的 502 不是这些参数的错，是探测在制造失败。先去病因，再谈剂量。**
// 放宽它们会把 002 已经解决的另一个问题放回来 ——
// 而"改一个自己没有量过的参数"，是在用别人量过的结论换自己的直觉。
//
// 若将来真要调，做法是：**先删掉本套件里对应的那条断言并写明新的实测依据**，
// 而不是让断言跟着实现一起改。判据先于实现，不是反过来。
// ─────────────────────────────────────────────────────────────────────────────

/** 004 期间必须逐字符不变的配置片段。改动任一条都要先有新的实测依据。 */
const FROZEN_BY_004 = [
  {
    re: /^\s*server\s+\S+\s+max_fails=1\s+fail_timeout=60s;/m,
    what: 'server … max_fails=1 fail_timeout=60s',
    why: 'max_fails=2 在低频请求下等于没生效（5 次测量 5 次都付了连接超时）；'
       + 'fail_timeout=60s 是为了少打断 ip_hash 的客户端亲和性',
  },
  {
    re: /proxy_next_upstream\s+error\s+timeout\s+http_502\s+http_503\s+http_504;/,
    what: 'proxy_next_upstream error timeout http_502 http_503 http_504',
    why: '这一行让 503 应答被计为上游失败 —— 它正是 004 缺陷链的第 3 环。'
       + '但去掉 http_503 会改变**真实流量**的故障转移语义，'
       + '为了修探测的问题去动业务路径，方向是错的。004 选择去掉病因（探测不碰上游），'
       + '而不是改这一行',
  },
  {
    re: /zone\s+karmachain_rpc\s+64k;/,
    what: 'zone karmachain_rpc 64k',
    why: '失败计数必须在所有 worker 之间共享（实测 18 个 worker）。'
       + '注意它同时是 004 那个缺陷的**放大器** —— 一次探测毒遍全体 worker 的共享状态。'
       + '但 zone 本身是对的：不加它，整域缺席时几乎每次请求都命中一个"还不知道那台已死"的 worker。'
       + '**一个正确的修复放大了另一个缺陷，不等于那个修复错了**',
  },
  {
    re: /^\s*ip_hash;/m,
    what: 'ip_hash',
    why: '客户端亲和：避免"发完交易立刻读高度却读到旧视图"（实测过）',
  },
  {
    re: /proxy_connect_timeout\s+2s;/,
    what: 'proxy_connect_timeout 2s',
    why: '局域网内健康连接 < 5ms，2 秒是 400 倍余量；不设它则整台机器没了时要等满 nginx 默认的 60s',
  },
  {
    re: /proxy_next_upstream_timeout\s+15s;/,
    what: 'proxy_next_upstream_timeout 15s',
    why: '最坏情况的总预算，须短于客户端超时（viem 20s）',
  },
  {
    re: /proxy_read_timeout\s+300s;/,
    what: 'proxy_read_timeout 300s',
    why: '长轮询/订阅需要它；与故障转移无关，但同属"既有行为一律保持"（FR-010）',
  },
];

describe('功能 004：故障转移相关配置一律不动（FR-010 / research R-02）', () => {
  for (const d of DEPLOYMENTS) {
    describe(`部署形态 ${d}`, () => {
      const conf = confOf(d);
      for (const { re, what, why } of FROZEN_BY_004) {
        test(`${what} 保持原样`, () => {
          assert.match(conf, re,
            `\`${what}\` 不在生成的配置里，或被改动了。\n`
            + `  这一条是 002 在 2026-09-09 实测后定下的：${why}。\n`
            + '  功能 004 承诺**一个字符都不动**（research.md R-02）—— 当前的 502 不是这些\n'
            + '  参数的错，是健康探测在制造上游失败。先去病因，再谈剂量。\n'
            + '  若确实要调：先删掉本断言并写明新的实测依据，不要让断言跟着实现改。');
        });
      }

      test('upstream 里每一个后端都带同样的 max_fails / fail_timeout', () => {
        const servers = [...conf.matchAll(/^\s*server\s+(\S+)\s+max_fails=(\d+)\s+fail_timeout=(\d+)s;/gm)];
        assert.ok(servers.length > 0, 'upstream 里应当有带 max_fails/fail_timeout 的 server 行');
        const odd = servers.filter(([, , mf, ft]) => mf !== '1' || ft !== '60');
        assert.equal(odd.length, 0,
          `以下后端的取值与其余不一致：${odd.map(([l]) => l.trim()).join(' / ')}\n`
          + '  取值不齐会让故障转移的最坏延迟随"命中哪个后端"变化 —— 那是最难复现的一类问题。');
      });
    });
  }
});
