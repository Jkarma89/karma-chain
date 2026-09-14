// avalanchego 的 Host 头策略：**IP 字面量无条件放行，名字必须在清单里**（功能 005 / V-19）。
//
// ## 为什么这条必须是行为测试
//
// 功能 005 把各机器地址从 `http-allowed-hosts` 里去掉了，理由是它们**不产生任何约束**：
// 001 的 acceptance.md 第 76 行已记着「默认只放行 localhost 与 IP 字面量」，
// 2026-09-14 又在活节点上复核过一遍。去掉之后，加一台机器对既有节点是零改动
// （见 tests/unit/add-machine-noop.test.mjs）。
//
// **但这是上游的行为，不是我们的代码。** 哪天某个 avalanchego 版本开始对 IP 字面量
// 也查清单，去掉那些地址就会让面板直连与跨机访问一起断 —— 而**没有任何静态守卫
// 能预见这件事**。所以那条实测必须变成一条会变红的断言，钉在活节点上。
//
// 它红了意味着：先把地址加回 `render-node-flags.mjs` 的清单，再重新评估
// 「加机器零改动」这个承诺还剩多少。**不要改本文件的断言去迁就新行为。**
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { loadProtocol, deriveTopology } from '../../tools/protocol/load.mjs';

const p = loadProtocol();
const d = deriveTopology(p);

const DATA = '{"jsonrpc":"2.0","id":1,"method":"info.getNodeID","params":[]}';

/**
 * 用给定的 Host 头请求某个节点的 /ext/info，返回 HTTP 状态码（连不上返回 null）。
 *
 * **必须用 `node:http`，不能用 `fetch`。** undici 把 `Host` 当成禁止头直接丢掉，
 * 于是发出去的仍是真实的 `<ip>:<port>` —— 而那是 IP 字面量，**一律 200**。
 * 第一版用 fetch 写的，三条断言里两条"通过"的全是空跑，
 * 是下面那条 403 对照组把整套测量顶了回来。
 */
const probe = (base, host) => new Promise((resolve) => {
  const u = new URL(base);
  const req = request({
    hostname: u.hostname,
    port: u.port,
    path: '/ext/info',
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(DATA), host },
    timeout: 5000,
  }, (res) => {
    res.resume();
    resolve(res.statusCode);
  });
  req.on('error', () => resolve(null));
  req.on('timeout', () => { req.destroy(); resolve(null); });
  req.end(DATA);
});

// 找一个**本进程连得上**的节点。跨机形态下通常是本机承载的那个。
const candidates = d.topologyNodes.map((n) => ({ id: n.id, base: `http://${n.address}:${n.httpPort}` }));
let target = null;
for (const c of candidates) {
  // 用节点自己的地址当 Host —— 那是 IP 字面量，无论策略如何都该通
  if (await probe(c.base, `${new URL(c.base).host}`) === 200) { target = c; break; }
}

const SKIP = target ? undefined : [
  '本进程连不上任何节点的 HTTP 端点，无法验证 Host 头策略。',
  '在一台承载节点的机器上运行本文件；单机形态须在容器网络内运行：',
  '    docker run --rm --network karmachain -v "$PWD:/workspace" karmachain/verify:local',
  "      node --test tests/integration/host-header-policy.test.mjs",
].join(' / ');

describe('Host 头策略（V-19，对活节点实测）', { skip: SKIP }, () => {
  const allowed = p.endpoints.publishedHosts;

  test('清单里的名字 → 200', async () => {
    for (const h of allowed) {
      assert.equal(await probe(target.base, h), 200,
        `已发布主机 \`${h}\` 被拒了 —— 它在 http-allowed-hosts 里却不通，清单没生效？`);
    }
  });

  test('**未列出的 IP 字面量 → 200**（005 去掉机器地址的全部依据）', async () => {
    // 刻意取三类：同网段、另一个私网段、一个公网段（TEST-NET-3，RFC 5737 保留给文档用）。
    // 三类都通才能说"IP 字面量无条件放行"，只试同网段证不了这一点。
    const seed = new URL(target.base).hostname;
    const ips = [
      seed.replace(/\.\d+$/, '.251'),   // 同网段，未在任何清单里
      '10.251.251.251',                 // 另一个私网段
      '203.0.113.251',                  // RFC 5737 文档保留段，不会误伤真实主机
    ];
    for (const ip of ips) {
      assert.ok(!allowed.includes(ip), `夹具失效：${ip} 竟在清单里，这条证不了任何东西`);
      const code = await probe(target.base, ip);
      assert.equal(code, 200,
        `Host: ${ip}（**未列出**）返回 ${code}，不是 200。\n`
        + '  **上游改了 Host 头策略。** 功能 005 把各机器地址从 http-allowed-hosts 里\n'
        + '  去掉，依据正是"IP 字面量无条件放行"。这条不成立了，那些地址必须加回\n'
        + '  tools/protocol/render-node-flags.mjs —— 否则面板直连与跨机 RPC 会一起断。\n'
        + '  **不要改本断言去迁就新行为**：先修渲染器，再重新评估"加机器零改动"这个承诺。');
    }
  });

  test('未列出的**名字** → 403（清单确实还在起作用，不是形同虚设）', async () => {
    // 这条是上一条的对照组。少了它，"IP 全通"可能只是因为清单被完全忽略 ——
    // 那时去掉地址虽然无害，但结论的依据是错的，而错的依据会在下一次改动里害人。
    for (const name of ['not-allowed.example.com', 'karmachain.invalid']) {
      assert.ok(!allowed.includes(name), `夹具失效：${name} 竟在清单里`);
      const code = await probe(target.base, name);
      assert.equal(code, 403,
        `Host: ${name}（未列出的**名字**）返回 ${code}，不是 403。\n`
        + '  清单对名字也不起作用了 —— 那么"IP 全通"就不是"IP 特殊"，\n'
        + '  而是整个清单被忽略。此时 localhost 也不再受保护，\n'
        + '  RPC 代理那条 Host 改写的前提需要重新确认。');
    }
  });
});
