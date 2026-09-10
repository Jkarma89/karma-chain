// T022 —— 面板服务的端点契约（功能 003）。
//
// 判据来自 `specs/003-chain-health-dashboard/contracts/dashboard-api.md` 第 2 节。
//
// ## 本文件守的最要紧一条
//
// `/api/*` **恒返回 200**。观测失败是快照的**内容**（`observer.blind`、
// `tier: "observer-blind"`），不是 HTTP 错误 —— 用 5xx 表达"我连不上节点"会让前端
// 无法区分「服务挂了」与「服务好着但看不见链」，而那两者正是 FR-020 要求区分的东西。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs, validateInterval, createDashboardServer,
} from '../../tools/dashboard/server.mjs';
import { loadContext } from '../../tools/dashboard/poll.mjs';

/** 起一个只监听环回、端口由系统分配的实例 —— 不占用 21680，也不影响运行中的面板。 */
async function withServer(ctx, intervalSeconds, fn) {
  const { server, poller } = createDashboardServer({ ctx, intervalSeconds });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn({ base, poller });
  } finally {
    poller.stop();
    await new Promise((r) => server.close(r));
  }
}

const get = (base, path) => fetch(`${base}${path}`, { signal: AbortSignal.timeout(15_000) });

describe('参数解析与间隔上限', () => {
  test('默认端口 21680、默认间隔 5 秒', () => {
    const o = parseArgs([]);
    assert.equal(o.port, 21680);
    assert.equal(o.intervalSeconds, 5);
  });

  test('出厂默认间隔本身必须满足 FR-018 的预算', () => {
    // **这一条守的是"默认值不许被调到违规"** —— 改默认值时最容易忘的就是回头核对预算。
    const { intervalSeconds } = parseArgs([]);
    assert.equal(validateInterval(intervalSeconds), null,
      `出厂默认间隔 ${intervalSeconds}s 超出上限 —— 用户什么都不配就会违反 FR-018`);
  });

  test('--port / --interval / --deployment 被解析', () => {
    const o = parseArgs(['--port', '9999', '--interval', '3', '--deployment', 'local']);
    assert.equal(o.port, 9999);
    assert.equal(o.intervalSeconds, 3);
    assert.equal(o.deployment, 'local');
  });

  test('间隔 2 秒合法', () => {
    assert.equal(validateInterval(2), null);
  });

  test('间隔 6 秒恰好合法（= 10s 预算 − 4s 探测超时）', () => {
    assert.equal(validateInterval(6), null);
  });

  test('间隔 7 秒被拒绝 —— 会违反 FR-018 的 10 秒发现时延', () => {
    const err = validateInterval(7);
    assert.ok(err, '必须拒绝');
    assert.match(err, /FR-018/, '拒绝理由要指向那条要求，而不是只说"不行"');
  });

  test('非正数被拒绝', () => {
    assert.ok(validateInterval(0));
    assert.ok(validateInterval(-1));
    assert.ok(validateInterval(Number.NaN));
  });

  test('拒绝而不是悄悄夹取 —— 悄悄改成合法值会让运维以为自己设的间隔生效了', () => {
    // 判据：validateInterval 返回错误字符串（由 main() 转成退出码 2），
    // 而不是返回一个被夹取后的数字。
    assert.equal(typeof validateInterval(30), 'string');
  });
});

describe('loadContext —— 拓扑与容错上限全部从 protocol.json 派生', () => {
  let ctx;
  before(() => { ctx = loadContext(); });

  test('节点、边界、容错上限齐备且自洽', () => {
    assert.ok(ctx.nodes.length > 0, '至少要有节点');
    assert.ok(ctx.domains.length > 0, '至少要有故障边界');
    assert.equal(
      ctx.faultTolerance.validatorCount,
      ctx.nodes.filter((n) => n.role === 'l1-validator').length,
      'validatorCount 应与拓扑里 l1-validator 的数量一致',
    );
    assert.ok(ctx.faultTolerance.maxOfflineValidators >= 1);
  });

  test('每个节点都带 address 与 httpPort —— 否则探测会静默把全部节点判成不可达', () => {
    // 002 踩过：字段名写成 node.host 时主机名成了 undefined，全部节点被误判 unreachable。
    for (const n of ctx.nodes) {
      assert.ok(n.address, `${n.id} 缺 address`);
      assert.ok(n.httpPort, `${n.id} 缺 httpPort`);
    }
  });

  test('链身份与基准创世哈希被读到', () => {
    assert.ok(ctx.chain.chainId, '缺 chainId');
    assert.ok(ctx.chain.networkId, '缺 networkId');
    assert.match(ctx.baselineGenesisHash, /^0x[0-9a-f]{64}$/i, '基准创世哈希格式不对');
  });

  test('未知部署形态直接抛错 —— 由 main() 转成退出码 10', () => {
    assert.throws(() => loadContext({ deployment: 'no-such-deployment' }));
  });
});

describe('GET /api/snapshot', () => {
  let ctx;
  before(() => { ctx = loadContext(); });

  test('首轮未完成时返回 collectedAt:null / tier:null，而不是一个看起来正常的空快照', async () => {
    await withServer(ctx, 2, async ({ base }) => {
      // 刻意不调 poller.start()：此刻还没有任何一轮完成
      const res = await get(base, '/api/snapshot');
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.collectedAt, null);
      assert.equal(body.tier, null);
      assert.equal(body.phase, 'first-poll');
      assert.ok(!('healthPercent' in body), '首轮未完成时不得给出百分比 —— 那会被当成真值渲染');
    });
  });

  test('一轮完成后给出完整快照，且恒 200（无论探测成败）', async () => {
    await withServer(ctx, 2, async ({ base, poller }) => {
      await poller.round();
      const res = await get(base, '/api/snapshot');
      assert.equal(res.status, 200, '观测失败是快照的内容，不是 HTTP 错误');
      const s = await res.json();

      for (const k of [
        'collectedAt', 'pollIntervalMs', 'deployment', 'networkHeight',
        'tier', 'healthPercent', 'participating', 'threshold',
        'validatorMargin', 'domainMargin', 'faultTolerance', 'observer',
        'chainIdentity', 'nodes', 'incidents', 'containerFacts',
      ]) {
        assert.ok(k in s, `快照缺字段 ${k}（data-model 第 7 节）`);
      }

      assert.equal(s.nodes.length, ctx.nodes.length, '每个声明的节点都要有一行');
      assert.ok(
        ['normal', 'zero-margin', 'stopped', 'starting', 'observer-blind'].includes(s.tier),
        `档位取值非法：${s.tier}`,
      );
      assert.equal(typeof s.collectedAt, 'number');
      assert.ok(s.collectedAt <= Date.now(), 'collectedAt 不能在未来');
    });
  });

  test('collectedAt 在探测完成时打戳，不随后续请求变化', async () => {
    await withServer(ctx, 2, async ({ base, poller }) => {
      await poller.round();
      const a = await (await get(base, '/api/snapshot')).json();
      await new Promise((r) => setTimeout(r, 300));
      const b = await (await get(base, '/api/snapshot')).json();
      assert.equal(b.collectedAt, a.collectedAt,
        'collectedAt 必须反映数据年龄，不是请求年龄 —— 否则陈旧数据会永远显示"刚刚"');
    });
  });

  test('每个节点行都带既有 classify 的字段，不改名', async () => {
    await withServer(ctx, 2, async ({ base, poller }) => {
      await poller.round();
      const s = await (await get(base, '/api/snapshot')).json();
      for (const n of s.nodes) {
        for (const k of ['id', 'role', 'domain', 'state', 'countsAsOffline', 'countsTowardTolerance']) {
          assert.ok(k in n, `节点 ${n.id} 缺既有字段 ${k}（FR-004：不得另立一套）`);
        }
        for (const k of ['participatesInConsensus', 'behindBlocks', 'genesisMatchesBaseline', 'incidentClass']) {
          assert.ok(k in n, `节点 ${n.id} 缺 003 派生字段 ${k}`);
        }
      }
    });
  });

  test('容器事实缺失时显式标注降级，不静默接受（FR-030）', async () => {
    await withServer(ctx, 2, async ({ base, poller }) => {
      await poller.round();
      const s = await (await get(base, '/api/snapshot')).json();
      assert.equal(typeof s.containerFacts.available, 'boolean');
      assert.equal(s.containerFacts.degraded, !s.containerFacts.available);
      if (s.containerFacts.degraded) {
        assert.ok(s.containerFacts.note, '降级必须带一句可读的说明');
        assert.ok(s.containerFacts.reason, '降级必须说明原因');
      }
    });
  });
});

describe('静态托管', () => {
  let ctx;
  before(() => { ctx = loadContext(); });

  test('public/ 下已存在的文件可取', async () => {
    // 刻意不测 /index.html —— 它由 US1 的 T027 创建。这里测的是**静态处理器本身**。
    await withServer(ctx, 2, async ({ base }) => {
      const res = await get(base, '/README.md');
      assert.equal(res.status, 200);
      assert.ok((await res.text()).length > 0);
    });
  });

  test('不存在的路径返回 404，不是 500', async () => {
    await withServer(ctx, 2, async ({ base }) => {
      assert.equal((await get(base, '/definitely-not-here.txt')).status, 404);
    });
  });

  test('目录穿越取不到 public/ 之外的文件', async () => {
    await withServer(ctx, 2, async ({ base }) => {
      for (const path of ['/../snapshot.mjs', '/..%2Fsnapshot.mjs', '/../../package.json']) {
        const res = await get(base, path);
        assert.notEqual(res.status, 200, `${path} 不应当可取`);
      }
    });
  });

  test('非 GET 方法被拒（面板是只读的）', async () => {
    await withServer(ctx, 2, async ({ base }) => {
      const res = await fetch(`${base}/`, { method: 'PUT', signal: AbortSignal.timeout(10_000) });
      assert.equal(res.status, 405);
    });
  });
});

describe('轮询循环不因单轮失败而倒下', () => {
  let ctx;
  before(() => { ctx = loadContext(); });

  test('探测抛错时服务仍然应答 —— 否则"面板挂了"与"链挂了"无法分辨', async () => {
    // 给一个地址全部指向黑洞的上下文：探测会全部失败（但不抛）。
    const broken = {
      ...ctx,
      nodes: ctx.nodes.map((n) => ({ ...n, address: '127.0.0.1', httpPort: 1 })),
      domains: ctx.domains.map((d) => ({ ...d, address: '127.0.0.1' })),
    };
    await withServer(broken, 2, async ({ base, poller }) => {
      await poller.round();
      const res = await get(base, '/api/snapshot');
      assert.equal(res.status, 200);
      const s = await res.json();
      assert.equal(s.observer.blind, true, '一个都探不到 → 观察者失明');
      assert.equal(s.tier, 'observer-blind', '**不得**报 stopped（FR-020）');
      assert.notEqual(s.tier, 'stopped');
    });
  });
});
