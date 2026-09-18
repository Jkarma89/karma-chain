// T008 —— 对 002 代码那两处追加改动的回归守卫（功能 003 / 研究 R-07）。
//
// 003 只碰 `tools/inspect/node-status.mjs` 两处，都是**追加**：
//
//   ① `probeNode()` 多取一次创世区块哈希，产出 `probe.genesisHash`
//      —— FR-024/FR-025 的分叉检测没有别的原料来源
//   ② `readContainers()` 由模块私有改为 `export`，函数体一字不动
//      —— 面板必须能读容器事实，否则在本机停掉唯一验证者时会误报
//        「整域缺席，去看那台机器」，而人正站在那台机器上
//
// 这两处都不该改变 `devnet-status` 的任何行为。本文件就是那句"不该"的判据。
//
// **为什么不能只靠"跑一遍 devnet-status 看着还行"**：那证明的是"这次没炸"，
// 不是"判定没变"。9 个状态里只有少数几个在日常运行中出现，回归要逐状态断言。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  ALL_STATES, classify, summarize, probeNode, readContainers,
} from '../../tools/inspect/node-status.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// 地址与端口对本文件毫无意义（测的是 classify 的分支），因此用明显的假值 ——
// 写真实的协议参数会让它们在测试里多出一个副本（tests/unit/no-hardcode 会抓）。
const node = (over = {}) => ({
  id: 'l1-1', role: 'l1-validator', domain: 'domain-a', address: 'node.invalid', httpPort: 1, ...over,
});

/** 覆盖 classify 全部分支的输入组合 —— 每一条都要在加/不加 genesisHash 时给出相同结果。 */
const BRANCHES = [
  ['容器退出码 12 且提到身份 → identity-mismatch',
    node({ nodeId: 'NodeID-A' }), { probe: { reachable: false }, container: { status: 'exited', exitCode: 12, lastError: 'NodeID mismatch' } }],
  ['容器退出码 12 其他原因 → data-corrupt',
    node(), { probe: { reachable: false }, container: { status: 'exited', exitCode: 12, lastError: 'db mismatch' } }],
  ['容器退出码 10 → stopped',
    node(), { probe: { reachable: false }, container: { status: 'exited', exitCode: 10, lastError: '' } }],
  ['容器自报 stalled → stalled',
    node(), { probe: { reachable: false }, container: { status: 'running', selfState: 'stalled', detail: '卡住' } }],
  ['容器未在运行且正常退出 → stopped（本机主动停的）',
    node(), { probe: { reachable: false }, container: { status: 'exited', exitCode: 0 } }],
  ['可达但 NodeID 不符 → identity-mismatch',
    node({ nodeId: 'NodeID-A' }), { probe: { reachable: true, nodeId: 'NodeID-B' }, container: null }],
  ['可达且是 primary → healthy',
    node({ role: 'primary' }), { probe: { reachable: true, nodeId: null }, container: null }],
  ['可达但未引导 → bootstrapping',
    node(), { probe: { reachable: true, nodeId: null, bootstrapped: false }, container: null }],
  ['已引导但尚未服务 L1 → bootstrapping',
    node(), { probe: { reachable: true, nodeId: null, bootstrapped: true, height: null }, container: null }],
  ['落后于网络高度 → catching-up',
    node(), { probe: { reachable: true, nodeId: null, bootstrapped: true, height: 700 }, networkHeight: 748, prevHeight: 690, sampleSeconds: 2, container: null }],
  ['已追平 → healthy',
    node(), { probe: { reachable: true, nodeId: null, bootstrapped: true, height: 748 }, networkHeight: 748, container: null }],
  ['不可达但其他节点看得见它 → unreachable（不计入离线）',
    node({ nodeId: 'NodeID-A' }), { probe: { reachable: false }, seenByPeers: new Set(['NodeID-A']), container: null }],
  ['不可达且整域缺席 → unreachable（计入离线）',
    node({ nodeId: 'NodeID-A' }), { probe: { reachable: false }, seenByPeers: new Set(), domainAllUnreachable: true, container: null }],
  ['不可达但同边界其他节点在应答 → stopped',
    node({ nodeId: 'NodeID-A' }), { probe: { reachable: false }, seenByPeers: new Set(), domainAllUnreachable: false, container: null }],
];

describe('改动一：probeNode 增加 genesisHash 字段', () => {
  test('classify 对每条分支的判定，不因 probe 多带 genesisHash 而改变', () => {
    for (const [label, n, ctx] of BRANCHES) {
      const without = classify(n, ctx);
      const withHash = classify(n, {
        ...ctx,
        probe: { ...ctx.probe, genesisHash: '0x19cfde1f02e585020cdae83071bac33c7d81e411cacf7f306b82ceabe98892ed' },
      });
      assert.deepEqual(withHash, without, `分支「${label}」的判定被 genesisHash 改变了`);
    }
  });

  test('genesisHash 为 null（取不到）同样不改变任何判定', () => {
    for (const [label, n, ctx] of BRANCHES) {
      const without = classify(n, ctx);
      const withNull = classify(n, { ...ctx, probe: { ...ctx.probe, genesisHash: null } });
      assert.deepEqual(withNull, without, `分支「${label}」的判定被 genesisHash=null 改变了`);
    }
  });

  test('上面这组分支确实覆盖了 ALL_STATES 里可由 classify 产出的每个取值', () => {
    // 若哪天 classify 多了一个状态而这里没覆盖，本条会变红 —— 否则回归守卫会静默留下缺口。
    const produced = new Set(BRANCHES.map(([, n, ctx]) => classify(n, ctx).state));
    const missing = [...ALL_STATES].filter((s) => !produced.has(s) && s !== 'starting');
    assert.deepEqual(missing, [],
      `未覆盖的状态：${missing.join('、')}（starting 由容器健康检查产出，不经 classify）`);
  });

  test('summarize 的输出结构不变', () => {
    const rows = [
      classify(node(), { probe: { reachable: true, nodeId: null, bootstrapped: true, height: 748 }, networkHeight: 748, container: null }),
      classify(node({ id: 'l1-2' }), { probe: { reachable: false }, seenByPeers: new Set(), domainAllUnreachable: true, container: null }),
    ];
    const s = summarize(rows, { validatorCount: 5, maxOfflineValidators: 1 });
    for (const k of ['online', 'offline', 'offlineIds', 'withinTolerance', 'margin', 'line']) {
      assert.ok(k in s, `summarize 的输出少了 ${k}`);
    }
  });

  test('probeNode 对不可达节点仍返回 { reachable: false } 而不抛', async () => {
    // 端口取一个确定关闭的高位端口。判据是"不抛且 reachable 为 false" ——
    // 既有实现把全部子请求的失败都吞在 try/catch 里，加了 genesisHash 之后必须仍然如此。
    const probe = await probeNode(node({ address: '127.0.0.1' }), null);
    assert.equal(probe.reachable, false);
  });
});

describe('改动二：readContainers 由模块私有改为 export', () => {
  test('已导出且可调用', () => {
    assert.equal(typeof readContainers, 'function');
  });

  test('返回对象 —— 文件缺失/格式旧/过期一律降级为空，不抛', () => {
    // 这是既有行为，不是 003 新增的：`.devnet/containers.json` 可能不存在
    // （从未跑过 devnet-status），也可能是两天前留下的。
    const got = readContainers();
    assert.equal(typeof got, 'object');
    assert.notEqual(got, null);
  });

  test('过期的事实被丢弃 —— "过期的事实比没有事实更坏"', () => {
    // 既有注释的原话：它看起来像证据，而且恰好把判定推向错误的分支。
    // 2026-09-09 实测踩到过：一份两天前的旧文件把 7 个节点全标成 running，
    // 于是刚被 devnet-stop 停掉的本机节点报出 unreachable「整域缺席，去看那台机器」。
    const stale = { collectedAt: Math.floor(Date.now() / 1000) - 3600, nodes: { 'l1-1': { status: 'running' } } };
    assert.deepEqual(readContainers(JSON.stringify(stale)), {}, '一小时前的事实必须被丢弃');
  });

  test('无 collectedAt 的旧格式被丢弃', () => {
    assert.deepEqual(readContainers(JSON.stringify({ nodes: { 'l1-1': { status: 'running' } } })), {});
  });

  test('新鲜的事实被接受', () => {
    const fresh = { collectedAt: Math.floor(Date.now() / 1000), nodes: { 'l1-1': { status: 'running' } } };
    assert.deepEqual(readContainers(JSON.stringify(fresh)), { 'l1-1': { status: 'running' } });
  });
});

describe('改动的范围确实只有这两处', () => {
  test('collect() 未被改动 —— devnet-status 仍需要它的一次性语义（含采样休眠）', () => {
    const src = readFileSync(resolve(REPO, 'tools/inspect/node-status.mjs'), 'utf8');
    assert.match(src, /await new Promise\(\(r\) => setTimeout\(r, opts\.sampleSeconds \* 1000\)\)/,
      'collect() 的两次采样与中间的休眠必须保留 —— 面板另用 pollOnce()，不改这里');
    assert.match(src, /export async function collect\(/);
  });

  // 这条原本是 003 的**范围栅栏**：那次把面板抽出去时，node-status 不该被牵动，
  // 所以断言它的 import 清单一个字都不变。
  //
  // 005 / T073 让它必须变：容错的 n 要收敛到**链上注册成员**，而那需要读链。
  // 不读链的代价是 V-31 那个假警报 —— 声明 6 / 链上 5 / 在线 4 →
  // 报「链已停止出块」，而同一次 devnet-verify 里三行之后就是
  // `block-production 977 -> 978 -> 979`。
  //
  // 栅栏没有拆掉，只是移到了它真正要守的东西上：**清单是白名单**。
  // 白名单外的 import 仍然会红 —— 尤其是任何会让 node-status 变"重"的东西
  // （它被 devnet-verify、devnet-status 两条命令在现场调用）。
  test('node-status.mjs 的依赖限定在白名单内（新增要经过这条）', () => {
    const src = readFileSync(resolve(REPO, 'tools/inspect/node-status.mjs'), 'utf8');
    const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    const allowed = [
      'node:fs', 'node:path', 'node:url',
      '../protocol/load.mjs',
      // T073：读链上成员集合（读不到就说读不到，绝不退回声明）
      '../membership/member-set.mjs',
      // T073：把容错收敛到链上成员的判定只有一份，在这里引用而不是重写。
      // snapshot.mjs **自身零 import**，所以引它不会带进任何传递依赖 ——
      // 这是能接受这个方向的前提，别在 snapshot.mjs 里加 import。
      '../dashboard/snapshot.mjs',
      // 2026-09-18：classify 要回答"这个节点还连得上足够的成员吗"，
      // 而那条判据（连接权重 ≥75% ⟺ 断开数 ≤ ⌊n/4⌋）在 tolerance.mjs 里已经有了 ——
      // 在这里引用而不是重写第二份。准入理由与 snapshot.mjs 逐字相同：
      // **tolerance.mjs 自身零 import**（下面有一条守卫钉住它）。
      '../membership/tolerance.mjs',
    ];
    const extra = imports.filter((i) => !allowed.includes(i));
    assert.deepEqual(extra, [],
      `node-status.mjs 引入了白名单外的依赖：${extra.join('、')}。`
      + '它被 devnet-verify / devnet-status 在现场调用，'
      + '每一个新依赖都是一次"排查工具自己起不来"的机会。');
  });

  // ## 这条守的是**接线**，不是判定
  //
  // `summarize` 的判定由 tests/unit/status-format.test.mjs 守着 —— 但那些测试
  // 直接喂它一个**已收敛**的 faultTolerance，所以 `collect` 把未收敛的那份传进去
  // 也照样全绿。而那正是 V-31 假警报的真实形状：判定是对的，**接错了线**。
  //
  // 变红检查里这一条最初没红，就是因为只有判定测试、没有接线测试。
  // `collect` 要连真链才能跑，所以这里退到源码层面断言 —— 弱一些，
  // 但它对这个确切的回归会红。
  test('collect() 把**收敛后**的成员基准传给 summarize（T073 的接线）', () => {
    const src = readFileSync(resolve(REPO, 'tools/inspect/node-status.mjs'), 'utf8');
    assert.match(src, /summary:\s*summarize\(scoped\.rows,\s*scoped\.faultTolerance/,
      'summarize 没有收到 scopeToChainMembers 的输出 —— 容错会按**声明数**算，'
      + '而声明多于链上注册时（有成员正在加入）就会报出「链已停止出块」这句假话');
    // `\b` 不可省：没有它，`scoped.faultTolerance`（**正确**的那个）里的
    // "d.faultTolerance" 也会被匹配上 —— 第一版就是这样，让这条守卫
    // 对着未改动的源码就报红，于是那一轮变红检查全部作废。
    assert.doesNotMatch(src, /summarize\([^)]*\bd\.faultTolerance/,
      '还有地方把未收敛的 d.faultTolerance 传给 summarize');
    assert.match(src, /scopeToChainMembers\(\{\s*rows,\s*faultTolerance: d\.faultTolerance,\s*memberSet\s*\}\)/,
      '收敛的输入应当是**声明派生**的那份（d.faultTolerance）加上链上成员集合');
  });

  test('读不到链上成员时**不退回声明**，而是如实标记', () => {
    const src = readFileSync(resolve(REPO, 'tools/inspect/node-status.mjs'), 'utf8');
    assert.match(src, /memberSet:\s*\{\s*source:\s*memberSet\.source/,
      '输出里没有带上成员集合的来源 —— 调用方就分不清"按链上算"与"按声明算"，'
      + '而这两者在有成员加入时结论相反');
  });

  test('canQuery 的来源 tolerance.mjs 必须保持零 import', () => {
    // 与下一条同一个理由。tolerance.mjs 的文件头本来就写着"零 import 是 node-status 能引用它的前提" ——
    // 那句话此前没有守卫，2026-09-18 真的引用它时才补上。
    // **一条写在注释里、没有守卫的前提，和没有前提一样。**
    const src = readFileSync(resolve(REPO, 'tools/membership/tolerance.mjs'), 'utf8');
    const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    assert.deepEqual(imports, [],
      `tolerance.mjs 有了 import（${imports.join('、')}）—— node-status 引它的前提就没了，`
      + '后果是 devnet-verify / devnet-status 悄悄背上一串传递依赖。');
  });

  test('scopeToChainMembers 的来源 snapshot.mjs 必须保持零 import', () => {
    // 上一条允许 inspect → dashboard 这个方向，**前提**就是被引的那个模块是纯的。
    // 哪天有人往 snapshot.mjs 里加一个 import，这个前提就没了，而后果是
    // node-status 悄悄背上一串传递依赖。
    const src = readFileSync(resolve(REPO, 'tools/dashboard/snapshot.mjs'), 'utf8');
    const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    assert.deepEqual(imports, [],
      `snapshot.mjs 有了 import（${imports.join('、')}）—— 它是纯判定模块，`
      + 'node-status 与面板都引它。要加依赖的话，先把那部分判定挪出去。');
  });
});
