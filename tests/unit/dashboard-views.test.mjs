// 视图模块的渲染守卫（功能 003）。
//
// ## 为什么补这个文件（2026-09-10）
//
// 用户在页面上看到「此视图渲染失败：Cannot read properties of undefined (reading 'lastChild')」。
// 成因是 `t.append(el('thead')).lastChild.append(head)` —— **`Node.append()` 返回
// `undefined`**，不是被追加的节点。三处同样的写法。
//
// **而当时已经有 456 个单元测试，没有一个执行过 `render()`。** 六个视图模块零覆盖：
// 判定层被穷举测过、文案被逐字断言过、静态守卫连注释都剥了，
// 唯独"把快照画成 DOM"这一段一次都没跑过 —— 于是它成了整个特性里唯一没有守卫的地方，
// 而缺陷恰好就出在那里。这是本特性一路在防的那个形态（守卫不会变红），
// 只不过这次漏在我自己的前端代码上。
//
// ## 做法：一个零依赖的 DOM 桩
//
// 桩**刻意忠实地模仿真实 API 的返回值** —— 尤其 `append()` 返回 `undefined`。
// 若把它写成"返回被追加的节点"（用起来更方便），本文件就抓不到那个 bug 了。
// 桩的意义在于**像**真实 DOM，不在于好用。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot } from '../../tools/dashboard/snapshot.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { toPublicView } from '../../tools/dashboard/public-view.mjs';
import { REPO_ROOT } from '../../tools/protocol/load.mjs';

// 链身份从唯一事实来源读 —— 在夹具里复制一份就多了一个副本（no-hardcode 守卫会抓，
// 而它已经抓过我两次了：dashboard-fork 与 dashboard-public-view 各一次）。
const PROTOCOL = JSON.parse(readFileSync(resolve(REPO_ROOT, 'blockchain/protocol.json'), 'utf8'));

// ---------- 最小 DOM 桩 ----------

class StubNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.className = '';
    this._text = null;
    this.dataset = {};
    this.listeners = [];
  }

  get textContent() {
    if (this._text != null) return this._text;
    return this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
  }

  set textContent(v) { this._text = v == null ? null : String(v); this.children = []; }

  /** **返回 undefined**，与真实 `Node.append()` 一致。不要"顺手"改成返回节点。 */
  append(...nodes) {
    for (const n of nodes) {
      if (n == null) throw new TypeError('append 收到 null/undefined —— 真实 DOM 会把它变成字符串 "null"');
      this.children.push(n);
      if (typeof n !== 'string') n.parentNode = this;
    }
    this._text = null;
  }

  replaceChildren(...nodes) { this.children = []; this._text = null; if (nodes.length) this.append(...nodes); }

  get lastChild() { return this.children.length ? this.children[this.children.length - 1] : null; }

  get firstChild() { return this.children.length ? this.children[0] : null; }

  addEventListener(type, fn) { this.listeners.push({ type, fn }); }

  querySelectorAll() { return []; }

  /** 整棵子树的文字 —— 断言"必含/禁止短语"时用。 */
  get allText() {
    return this.children
      .map((c) => (typeof c === 'string' ? c : c.allText))
      .join('') + (this._text ?? '');
  }

  /** 整棵子树的 class 集合。 */
  get allClasses() {
    const out = new Set(String(this.className).split(/\s+/).filter(Boolean));
    for (const c of this.children) {
      if (typeof c === 'string') continue;
      for (const k of c.allClasses) out.add(k);
    }
    return out;
  }
}

const stubDocument = {
  createElement: (tag) => new StubNode(tag),
  createTextNode: (t) => String(t),
  getElementById: () => new StubNode('div'),
};

// ---------- 快照夹具（用真实的 buildSnapshot，保证结构与生产一致）----------

const BASELINE = '0x19cfde1f02e585020cdae83071bac33c7d81e411cacf7f306b82ceabe98892ed';
const OTHER = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

const validator = (i, over = {}) => ({
  id: `l1-${i}`,
  role: 'l1-validator',
  domain: `d-${i}`,
  address: `10.0.0.${i}`,
  nodeId: `NodeID-fake${i}`,
  reachable: true,
  state: 'healthy',
  detail: '已追平',
  height: 800,
  peers: 6,
  genesisHash: BASELINE,
  countsTowardTolerance: true,
  countsAsOffline: false,
  ...over,
});

const primary = (i, over = {}) => ({
  id: `primary-${i}`,
  role: 'primary',
  domain: `d-${i}`,
  address: `10.0.0.${i}`,
  nodeId: `NodeID-fakep${i}`,
  reachable: true,
  state: 'healthy',
  detail: 'primary 节点在岗',
  height: null,
  peers: 6,
  genesisHash: null,
  countsTowardTolerance: false,
  countsAsOffline: false,
  ...over,
});

const ft = (perDomain, f = 1) => ({
  validatorCount: perDomain.reduce((a, b) => a + b, 0),
  maxOfflineValidators: f,
  domainCount: perDomain.length,
  maxValidatorsPerDomain: f,
  declaredWithinLimit: true,
  effectiveDomainCount: perDomain.length,
  effectiveDomains: perDomain.map((n, i) => ({ ids: [`d-${i + 1}`], factors: [], validators: n })),
  tolerateWholeDomainLoss: perDomain.length > 1,
});

const snap = ({ rows, faultTolerance, observer, baseline = BASELINE, containerFacts, deployment = 'lan' }) =>
  buildSnapshot({
    collectedAt: Date.now(),
    pollIntervalMs: 2000,
    deployment,
    networkHeight: 800,
    rows,
    faultTolerance: faultTolerance ?? ft([1, 1, 1, 1, 1]),
    observer: observer ?? { reachableNodes: rows.length, totalNodes: rows.length, blind: false, pathAlive: [] },
    chain: {
      chainId: PROTOCOL.chain.chainId,
      networkId: PROTOCOL.avalanche.networkId,
      chainAlias: PROTOCOL.chain.blockchainName,
      blockchainId: 'fakeBlockchainId', rpcPath: '/ext/bc/karmachain/rpc',
      publishedHosts: ['127.0.0.1', 'localhost'],
    },
    baselineGenesisHash: baseline,
    containerFacts: containerFacts ?? { available: true, reason: null },
    summaryLine: '5/5 验证者在线',
  });

const five = (over = []) => [1, 2, 3, 4, 5].map((i) => validator(i, over[i - 1] ?? {}));

/**
 * 全部形态 —— 覆盖五个档位、分叉、未知创世、本机路径故障、合并边界、降级，
 * 以及功能 004 的恢复能力三种（blocked×正常 / blocked×停摆 / ok×本机链路故障）。
 */
const SCENARIOS = {
  normal: () => snap({ rows: [...five(), primary(1), primary(2)] }),

  'zero-margin': () => snap({
    rows: [...five([{}, {}, {}, {}, { state: 'stopped', countsAsOffline: true, reachable: false, height: null, peers: null, genesisHash: null, detail: '容器已退出（码 137）' }]), primary(1)],
  }),

  stopped: () => snap({
    rows: five([{}, {}, {},
      { state: 'stopped', countsAsOffline: true, reachable: false, height: null, genesisHash: null },
      { state: 'stalled', countsAsOffline: true, reachable: false, height: null, genesisHash: null }]),
  }),

  starting: () => snap({
    rows: five([{ state: 'bootstrapping', height: null, genesisHash: null, detail: '引导中 —— 要等，不是故障' },
      { state: 'bootstrapping', height: null, genesisHash: null },
      { state: 'bootstrapping', height: null, genesisHash: null },
      { state: 'starting', height: null, genesisHash: null },
      { state: 'starting', height: null, genesisHash: null }]),
  }),

  'observer-blind': () => snap({
    rows: five([...Array(5)].map(() => ({
      state: 'unreachable', countsAsOffline: true, reachable: false, height: null, peers: null, genesisHash: null,
      detail: '边界的全部节点都不应答 —— 整域缺席',
    }))),
    observer: {
      reachableNodes: 0, totalNodes: 5, blind: true,
      pathAlive: [{ domain: 'd-1', alive: true, status: 502 }, { domain: 'd-2', alive: false, status: null }],
    },
  }),

  'observer-blind-no-path': () => snap({
    rows: five([...Array(5)].map(() => ({ state: 'unreachable', countsAsOffline: true, reachable: false, height: null, genesisHash: null }))),
    observer: { reachableNodes: 0, totalNodes: 5, blind: true, pathAlive: [{ domain: 'd-1', alive: false, status: null }] },
  }),

  'local-path-fault': () => snap({
    rows: [...five([{}, {}, {}, {}, {
      state: 'unreachable', countsAsOffline: false, reachable: false, height: null, peers: null, genesisHash: null,
      detail: '本机连不上它，但网络中其他节点与它有连接 —— 是本机到它的网络路径问题',
    }]), primary(1)],
    observer: { reachableNodes: 5, totalNodes: 6, blind: false, pathAlive: [] },
  }),

  forked: () => snap({
    rows: [...five([{}, {}, {}, {}, { genesisHash: OTHER }]), primary(1)],
  }),

  'unknown-genesis': () => snap({
    rows: [...five([{}, {}, {}, {}, { genesisHash: null }]), primary(1)],
  }),

  'catching-up': () => snap({
    rows: [...five([{}, {}, {}, {}, {
      state: 'catching-up', height: 700, detail: '落后 100 块，+300/min, ~1m',
    }]), primary(1)],
  }),

  'merged-domains': () => snap({
    rows: five(),
    faultTolerance: {
      ...ft([1, 1, 3]),
      effectiveDomains: [
        { ids: ['d-1'], factors: [], validators: 1 },
        { ids: ['d-2'], factors: [], validators: 1 },
        { ids: ['d-3', 'd-4', 'd-5'], factors: ['power:rack-A'], validators: 3 },
      ],
      domainCount: 5,
      effectiveDomainCount: 3,
      tolerateWholeDomainLoss: false,
    },
  }),

  degraded: () => snap({
    rows: [...five(), primary(1)],
    containerFacts: { available: false, reason: '缺失、旧格式或已过期（120 秒 TTL）' },
  }),

  'no-baseline': () => snap({ rows: five(), baseline: null }),

  'single-domain': () => snap({
    rows: five(),
    faultTolerance: { ...ft([5]), effectiveDomains: [{ ids: ['d-1'], factors: ['host:single-machine'], validators: 5 }], domainCount: 1, effectiveDomainCount: 1, tolerateWholeDomainLoss: false },
    deployment: 'local',
  }),

  // ---------- 功能 004：恢复能力（与档位正交）----------
  //
  // 既有形态里 zero-margin 与 stopped 已经**偶然**触发了 blocked
  // （前者只挂了一个 primary、后者一个都没有）。偶然覆盖会在别人调整夹具时
  // 悄悄消失而没有任何提示，所以下面三种是**刻意**的。

  // 最要紧的那个组合：链完全正常，而这张网已经无法自愈。它看起来毫无问题。
  'recovery-blocked-normal': () => snap({
    rows: [...five(),
      primary(1, { state: 'stopped', reachable: false, countsAsOffline: true, peers: null, detail: '容器已退出' }),
      primary(2, { state: 'stopped', reachable: false, countsAsOffline: true, peers: null, detail: '容器已退出' })],
  }),

  // 两条信息必须能同时呈现：一条说"链停了"，另一条说"别重启"。
  'recovery-blocked-and-stopped': () => snap({
    rows: [...five([{}, {}, {},
      { state: 'stopped', countsAsOffline: true, reachable: false, height: null, genesisHash: null },
      { state: 'stopped', countsAsOffline: true, reachable: false, height: null, genesisHash: null }]),
      primary(1, { state: 'stopped', reachable: false, countsAsOffline: true, peers: null, detail: '容器已退出' }),
      primary(2, { state: 'stopped', reachable: false, countsAsOffline: true, peers: null, detail: '容器已退出' })],
  }),

  // 本机链路故障不该产生提示：那个 Primary 活着，其余节点看得见它。
  // 写错这一格的后果是"一根网线松了，面板就告诉人现在不能重启任何东西"。
  'recovery-ok-link-fault': () => snap({
    rows: [...five(),
      primary(1),
      primary(2, { state: 'unreachable', reachable: false, countsAsOffline: false, peers: null, detail: '本机视角不可达 —— 其余节点仍看得见它' })],
  }),
};

const VIEWS = ['view-health', 'view-nodes', 'view-observer', 'view-domains', 'view-identity', 'view-public'];

// ---------- 装桩 ----------

const saved = {};
before(() => {
  saved.document = globalThis.document;
  saved.fetch = globalThis.fetch;
  saved.location = globalThis.location;
  globalThis.document = stubDocument;
  globalThis.location = { href: 'http://localhost:21680/' };
  // view-public 会自己取 /api/public —— 用真实的投影函数产出，保证形状与生产一致
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => toPublicView(SCENARIOS.normal()),
  });
});

after(() => {
  globalThis.document = saved.document;
  globalThis.fetch = saved.fetch;
  globalThis.location = saved.location;
});

// ---------- 测试 ----------

describe('六个视图 × 十七种快照形态：渲染不得抛错', () => {
  for (const name of VIEWS) {
    for (const [scenario, build] of Object.entries(SCENARIOS)) {
      test(`${name} 渲染 ${scenario}`, async () => {
        const mod = await import(`../../tools/dashboard/public/${name}.mjs`);
        const root = new StubNode('div');
        // 这一句就是用户看到那条报错的判据 —— 抛错即失败
        mod.render(build(), root);
        assert.ok(root.children.length > 0,
          `${name} 在 ${scenario} 下渲染出了空内容 —— 页面上会是一块空白`);
      });
    }
  }
});

describe('DOM 桩必须忠实模仿真实 API', () => {
  // 桩若"好用过头"，本文件就抓不到那个 bug 了。这几条锁住它的忠实度。
  test('append() 返回 undefined —— 与真实 Node.append 一致', () => {
    const n = new StubNode('div');
    assert.equal(n.append(new StubNode('span')), undefined,
      '桩若返回被追加的节点，链式 .append(x).lastChild 就不会报错，'
      + '于是本文件抓不到用户实际遇到的那个缺陷');
  });

  test('链式取 append 返回值会像真实浏览器一样抛错', () => {
    const t = new StubNode('table');
    assert.throws(
      () => t.append(new StubNode('thead')).lastChild.append(new StubNode('tr')),
      /undefined/,
      '这正是 2026-09-10 那个缺陷的形状 —— 桩必须能复现它',
    );
  });

  test('append(null) 抛错 —— 真实 DOM 会把它渲染成字符串 "null"', () => {
    const n = new StubNode('div');
    assert.throws(() => n.append(null), TypeError);
  });
});

describe('渲染结果的几条内容判据', () => {
  const renderView = async (name, scenario) => {
    const mod = await import(`../../tools/dashboard/public/${name}.mjs`);
    const root = new StubNode('div');
    mod.render(SCENARIOS[scenario](), root);
    return root;
  };

  test('view-health 在 zero-margin 档说"仍在正常出块"，不说"链已停止"', async () => {
    const root = await renderView('view-health', 'zero-margin');
    assert.match(root.allText, /仍在正常出块/);
    assert.doesNotMatch(root.allText, /链已停止|停止出块/);
  });

  test('view-health 在 stopped 档说明成因与恢复所需，且不说"需要重置"', async () => {
    const root = await renderView('view-health', 'stopped');
    assert.match(root.allText, /查询门槛/);
    assert.match(root.allText, /恢复/);
    assert.match(root.allText, /安全停摆|不分叉/);
    assert.doesNotMatch(root.allText, /需要重置|数据.*丢失/);
  });

  test('view-observer 在 observer-blind 下不出现"链已停止"', async () => {
    for (const s of ['observer-blind', 'observer-blind-no-path']) {
      const root = await renderView('view-observer', s);
      assert.doesNotMatch(root.allText, /链已停止|停止出块/, `${s} 的呈现里出现了"链已停止"`);
    }
  });

  test('view-observer 把「本机视角不可达」与节点下线分开呈现', async () => {
    const root = await renderView('view-observer', 'local-path-fault');
    assert.match(root.allText, /本机视角不可达/);
    assert.match(root.allText, /别去动/, '处置方向必须指向本机');
  });

  test('view-nodes 把 Primary 单独成组并说明不计入健康度', async () => {
    const root = await renderView('view-nodes', 'normal');
    assert.match(root.allText, /L1 验证者/);
    assert.match(root.allText, /Primary Network 节点/);
    assert.match(root.allText, /不计入健康度/);
  });

  test('view-nodes 给落后的节点标出落后量', async () => {
    const root = await renderView('view-nodes', 'catching-up');
    assert.match(root.allText, /落后 100 块/);
  });

  test('view-domains 在两个余量不同时说明成因', async () => {
    const root = await renderView('view-domains', 'merged-domains');
    assert.match(root.allText, /两者不同|超过了可容忍/);
    assert.match(root.allText, /有效/, '要说清是按有效边界算的');
  });

  test('view-identity 在分叉时显目报出，并点名是哪个节点', async () => {
    const root = await renderView('view-identity', 'forked');
    assert.match(root.allText, /链身份不一致/);
    assert.match(root.allText, /l1-5/);
    assert.ok(root.allClasses.has('fork-banner'), '必须用 fork-banner 那套显目版式');
  });

  test('view-identity 在创世未取到时**不**报分叉', async () => {
    const root = await renderView('view-identity', 'unknown-genesis');
    assert.doesNotMatch(root.allText, /链身份不一致/);
    assert.match(root.allText, /未取到/);
    assert.ok(!root.allClasses.has('fork-banner'));
  });

  test('view-identity 在基准读不到时也不报分叉（那次真 bug 的呈现侧）', async () => {
    const root = await renderView('view-identity', 'no-baseline');
    assert.doesNotMatch(root.allText, /链身份不一致/,
      '仓库基准读不到不该变成一场五机分叉警报');
  });

  test('view-health 在容器事实降级时显式告知', async () => {
    const root = await renderView('view-health', 'degraded');
    assert.ok(root.allClasses.has('degraded'));
    assert.match(root.allText, /观测降级/);
  });

  // ---------- 功能 004：恢复能力的呈现 ----------

  test('恢复能力已丧失时：档位仍是正常，但另有一条显目提示（最要紧的那个组合）', async () => {
    const root = await renderView('view-health', 'recovery-blocked-normal');
    // 档位那一侧不许变 —— 链在出块（FR-013）
    assert.ok(root.allClasses.has('tier--ok'), '档位应当仍是正常那一档');
    assert.match(root.allText, /100%/, '百分比不该被恢复能力影响');
    // 而提示必须在
    assert.ok(root.allClasses.has('recovery--attention'),
      '缺了恢复能力那条提示 —— 这个形态恰恰是"看起来完全健康却无法自愈"，'
      + '而它要防的是一个本能动作：看到 Primary 停了就去重启点什么');
    assert.match(root.allText, /无法重新加入/, '要说出**后果**，不是只重复"Primary 停了"');
    assert.match(root.allText, /不要重启/, '要说清在那之前别动验证者');
  });

  test('它的版式与停摆报警**可区分**（FR-021）', async () => {
    const root = await renderView('view-health', 'recovery-blocked-normal');
    assert.ok(!root.allClasses.has('tier--critical'),
      '恢复能力用了 critical 那套版式 —— 链在出块，这会**稀释**「链已停止出块」那一档的含义。'
      + '003 期间为此删掉过一条会误报的守卫："噪音会让人开始忽略红灯。"');
    assert.ok(!root.allClasses.has('recovery--critical'),
      '同上 —— 它有自己的等级（attention），不该借用 critical');
  });

  test('链停了 + 无法恢复：两条信息同时在，不互相吃掉', async () => {
    const root = await renderView('view-health', 'recovery-blocked-and-stopped');
    assert.ok(root.allClasses.has('tier--critical'), '链确实停了 —— 那一档不能被盖掉');
    assert.ok(root.allClasses.has('recovery--attention'), '"别重启"那条也必须在');
    assert.match(root.allText, /停止出块/);
    assert.match(root.allText, /无法重新加入/);
  });

  test('只是本机链路故障时**不**呈现 —— 一根网线松了不该叫人别重启', async () => {
    const root = await renderView('view-health', 'recovery-ok-link-fault');
    assert.ok(!root.allClasses.has('recovery--attention'),
      '那个 Primary 是活的（其余节点看得见它），断的是本机到它的路径（FR-018）。'
      + '在这里报"恢复能力已丧失"是一次假提示 —— 002 里 ubuntu-1 的网线故障正是这一类');
    assert.doesNotMatch(root.allText, /无法重新加入/);
  });

  test('恢复能力提示不含"需要重置"这类话（呈现侧再验一遍）', async () => {
    const root = await renderView('view-health', 'recovery-blocked-and-stopped');
    for (const word of ['数据可能丢失', '需要重置', '需要重建']) {
      assert.ok(!root.allText.includes(word),
        `渲染出来的页面里出现了「${word}」。停摆与卡住不损坏任何东西 ——`
        + '003 的 V-04 实证：链停期间那笔 45 秒无回执的交易，恢复后被原样打包进区块 834');
    }
  });

  test('view-domains 在单边界形态说明不做整机失效承诺', async () => {
    const root = await renderView('view-domains', 'single-domain');
    assert.match(root.allText, /不做整机失效容错承诺/);
  });

  test('各档位用了对应的显目版式（FR-009 的版式通道）', async () => {
    const expect = {
      normal: 'tier--ok',
      'zero-margin': 'tier--warn',
      stopped: 'tier--critical',
      starting: 'tier--waiting',
      'observer-blind': 'tier--unknown',
    };
    for (const [scenario, cls] of Object.entries(expect)) {
      const root = await renderView('view-health', scenario);
      assert.ok(root.allClasses.has(cls),
        `${scenario} 应当用 ${cls} 版式 —— 若只换颜色不换版式，FR-009 的三通道就少了一条`);
    }
  });
});
