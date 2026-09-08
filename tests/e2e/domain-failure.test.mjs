// quickstart 场景 F / T056 / SC-005：**一个故障边界整体失效**时链继续出块。
//
// 与 single-validator-window.test.mjs（SC-003）的分工：那个杀掉一个**容器**，机器还在；
// 本文件停掉本机**整个边界**上的全部节点 —— 那是"这台机器没了"的形态。
// 两者在容错算式上都只是 1 个验证者离线，但可观测性完全不同：
// 前者是节点级故障，后者是边界缺席，运维要去看的东西不一样（FR-031 / FR-034）。
//
// T056 要求断言三件事：
//   1. 整域失效时链继续出块           → 测试一（30 分钟窗口，每分钟一笔，100%）
//   2. 缺席节点标记为 unreachable 而非节点故障 → 测试二
//   3. 恢复后自动追平                 → 测试三（2 分钟内，且期间不得误报为故障）
//
// ## 为什么必须从**别的机器**观测
//
// 被停掉的那台机器上，本地 nginx 代理也随之消失 —— `127.0.0.1` 那条入口不存在了。
// "链是否还在出块"只能由**存活的**边界回答。因此本测试全程经存活边界的 RPC 发交易，
// 而不是 lib/devnet.mjs 默认的本机入口。
//
// ## 测试二的视角问题（重要，别误读）
//
// `unreachable` 是**存活机器**的判定。从故障机器自己看，`docker inspect` 能看到容器
// 是被主动停止的，于是 node-status 报 `stopped`（"本机上被主动停止，非故障"）——
// 那是对的，容器事实优先于网络推断（devnet-stop 曾误报"整域缺席，去看那台机器"，
// 就是因为这个优先级反了）。
//
// 而本测试跑在故障机器上（它只能停自己这个边界）。要诚实地断言存活机器的判定，
// 就用**真实网络探测**（probeNode）配**真实分类器**（classify），只把"本机容器知识"
// 拿掉 —— 那恰好是两种视角的唯一差别。不是构造假数据：探测是真发 RPC 的。
//
// 时长按 SC-005 取 30 分钟，可用 KARMACHAIN_SC005_MINUTES 缩短（沿用既有约定：
// 日常回归短跑，正式验收跑满）。**先短跑一次再跑满** —— 曾因为一个笔误白等 30 分钟。
//
// 本测试制造并恢复整域失效。1 个边界离线在容错上限内，链全程可用；
// 但余量为 0，因此期间不要再动别的机器。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DOMAIN, DOMAIN_COUNT, DOMAIN_ADDRESSES, MAX_OFFLINE_VALIDATORS,
  clientsFor, rpcOfDomain, nodesOfDomain, validatorsOfDomain,
  sendTxVia, sh, devnetAvailable,
} from './lib/devnet.mjs';
import { probeNode, classify } from '../../tools/inspect/node-status.mjs';
import { CATEGORY_OF_RECOVERY_STATE } from '../../tools/verify/lib/categories.mjs';
import { REPO_ROOT, loadProtocol, deriveTopology } from '../../tools/protocol/load.mjs';

const MINUTES = Number(process.env.KARMACHAIN_SC005_MINUTES ?? 30);

const containerState = (id) => {
  try { return sh('docker', ['inspect', '--format', '{{.State.Status}}', `karmachain-${id}`]).trim(); }
  catch { return 'missing'; }
};
const isRunning = (id) => containerState(id) === 'running';

const LOCAL_NODES = nodesOfDomain(DOMAIN);
const LOCAL_VALIDATORS = validatorsOfDomain(DOMAIN);
const OTHER_DOMAINS = Object.keys(DOMAIN_ADDRESSES).filter((d) => d !== DOMAIN);

/** 拓扑里全部节点，带上制品声明的期望 NodeID 之外的信息由 probeNode 现场取。 */
const TOPOLOGY_NODES = deriveTopology(loadProtocol()).topologyNodes;
const BLOCKCHAIN_ID = (() => {
  try {
    return JSON.parse(readFileSync(
      resolve(REPO_ROOT, 'blockchain/chain-identity/karmachain.identity.json'), 'utf8')).blockchainId;
  } catch { return null; }
})();

/**
 * 存活机器会看到的那份判定：真实网络探测 + 真实分类器，`container: null`
 * （别人的容器它看不到）。返回 id → classify 结果。
 */
async function survivorView() {
  const probes = await Promise.all(TOPOLOGY_NODES.map((n) => probeNode(n, BLOCKCHAIN_ID)));
  const heights = probes.map((p) => p.height).filter((h) => Number.isFinite(h));
  const networkHeight = heights.length ? Math.max(...heights) : null;
  const seenByPeers = new Set(probes.flatMap((p) => p.peerNodeIds ?? []));

  const perDomain = new Map();
  TOPOLOGY_NODES.forEach((n, i) => {
    const cur = perDomain.get(n.domain) ?? { total: 0, down: 0 };
    cur.total += 1;
    if (!probes[i].reachable) cur.down += 1;
    perDomain.set(n.domain, cur);
  });

  const view = {};
  TOPOLOGY_NODES.forEach((n, i) => {
    const dd = perDomain.get(n.domain);
    view[n.id] = classify(n, {
      probe: probes[i],
      prevHeight: probes[i].height,
      networkHeight,
      seenByPeers,
      domainAllUnreachable: dd.down === dd.total,
      container: null,
    });
  });
  return view;
}

// —— 跳过条件 ——
let SKIP;
let observer = null;
if (DOMAIN_COUNT < 2) {
  SKIP = `单边界形态（activeDeployment 只有 1 个边界）—— 停掉唯一的边界等于停链，场景 F 不成立`;
} else if (!await devnetAvailable()) {
  SKIP = '本机的开发网未运行 —— 先 scripts/devnet-start';
} else if (LOCAL_VALIDATORS.length > MAX_OFFLINE_VALIDATORS) {
  // T-5 守卫本该保证这一点；真发生了说明拓扑和容错上限对不上，此时跑下去会把链停摆
  SKIP = `边界 ${DOMAIN} 承载 ${LOCAL_VALIDATORS.length} 个验证者，超过容错上限 ${MAX_OFFLINE_VALIDATORS}`
    + ' —— 停掉它会导致链安全停摆，那是 SC-006 的场景，不是本测试的';
} else {
  for (const d of OTHER_DOMAINS) {
    const c = clientsFor(rpcOfDomain(d));
    try {
      // 存活边界必须真的能应答；否则我们无从判断"链还在出块"
      await c.pub.getBlockNumber();
      observer = { domain: d, ...c };
      break;
    } catch { /* 这个边界现在到不了，试下一个 */ }
  }
  if (!observer) {
    SKIP = `没有可用作观测点的存活边界（试过 ${OTHER_DOMAINS.join('、')}）——`
      + ' 跨机验证需要至少一台别的机器在跑，且它的 RPC 端口对本机放行';
  }
}

describe(`场景 F —— 边界 ${DOMAIN} 整体失效，${MINUTES} 分钟观测窗口`,
  { skip: SKIP, concurrency: 1 }, () => {
    before(() => {
      for (const id of LOCAL_NODES) {
        assert.ok(isRunning(id), `${id} 应当在运行，测试才有意义（当前 ${containerState(id)}）`);
      }
    });

    after(() => {
      // 无论断言成败都把这个边界放回去：测试不该留下一个缺席的机器
      try { sh('sh', ['scripts/devnet-start.sh']); } catch { /* 交给下一次启动 */ }
    });

    test(`停掉 ${DOMAIN} 全部节点后，经 ${observer?.domain} 每分钟一笔交易连续 ${MINUTES} 分钟全部确认`,
      async (t) => {
        t.diagnostic(`观测点：${observer.domain} @ ${observer.RPC}`);
        t.diagnostic(`本边界节点：${LOCAL_NODES.join('、')}（其中验证者 ${LOCAL_VALIDATORS.join('、')}）`);

        const heightBefore = Number(await observer.pub.getBlockNumber());

        sh('sh', ['scripts/devnet-stop.sh']);
        for (const id of LOCAL_NODES) {
          assert.ok(!isRunning(id), `${id} 应已停止（当前 ${containerState(id)}）`);
        }
        // 这台机器上的对外入口也随之消失 —— 这正是"整域失效"与"杀一个容器"的区别
        assert.equal(await devnetAvailable(), false,
          '本机 RPC 代理应当随边界一起消失；它还在说明 devnet-stop 没有停掉整个边界');

        const failures = [];
        const heights = [];
        let sent = 0;

        for (let minute = 1; minute <= MINUTES; minute++) {
          const roundStart = Date.now();

          // SC-005 要的是 100%，因此不重试 —— 重试会把"第一次失败"藏起来。
          sent += 1;
          try {
            heights.push(await sendTxVia(observer));
          } catch (e) {
            failures.push(`第 ${minute} 分钟：交易未确认（${e.message.slice(0, 120)}）`);
            try { heights.push(Number(await observer.pub.getBlockNumber())); }
            catch { heights.push(heights.at(-1) ?? heightBefore); }   // 占位，保持与分钟对齐
          }

          // 靶子边界必须全程缺席，否则这段窗口测的不是整域失效
          for (const id of LOCAL_NODES) {
            if (isRunning(id)) failures.push(`第 ${minute} 分钟：${id} 又起来了，窗口不成立`);
          }

          if (minute % 5 === 0 || minute === 1) {
            t.diagnostic(`  第 ${minute}/${MINUTES} 分钟：高度 ${heights.at(-1)}，失败 ${failures.length} 次`);
          }

          if (minute < MINUTES) {
            const wait = 60_000 - (Date.now() - roundStart);
            if (wait > 0) await new Promise((r) => setTimeout(r, wait));
          }
        }

        assert.deepEqual(failures, [],
          `成功率必须是 100%，实际有 ${failures.length}/${sent} 次问题：\n  ${failures.join('\n  ')}`);

        for (let i = 1; i < heights.length; i++) {
          assert.ok(heights[i] >= heights[i - 1],
            `高度回退：第 ${i} 分钟 ${heights[i - 1]} → 第 ${i + 1} 分钟 ${heights[i]}`);
        }
        assert.ok(heights.at(-1) >= heightBefore + MINUTES,
          `${MINUTES} 分钟内应至少新增 ${MINUTES} 个区块：${heightBefore} → ${heights.at(-1)}`);

        t.diagnostic(`窗口结束：${sent} 笔全部确认，高度 ${heightBefore} → ${heights.at(-1)}`);
      });

    test('存活机器看到的是"整域缺席（unreachable）"，不是节点故障', async (t) => {
      for (const id of LOCAL_NODES) {
        assert.ok(!isRunning(id), `${id} 应仍处于停止状态（上一个测试留下的窗口）`);
      }

      const view = await survivorView();

      for (const id of LOCAL_NODES) {
        const r = view[id];
        assert.equal(r.state, 'unreachable',
          `${id} 在存活机器眼里应当是 unreachable（整域缺席），实际 ${r.state} —— ${r.detail}`);
        assert.match(r.detail, new RegExp(DOMAIN),
          `${id} 的说明须点名是哪个边界，实际："${r.detail}"`);
      }
      for (const id of LOCAL_VALIDATORS) {
        assert.equal(view[id].countsAsOffline, true,
          `${id} 整域缺席时确实不在线，必须计入离线 —— 否则会虚报余量`);
      }

      // 区分性：存活边界的验证者不受影响 —— 判据取自模型（分类表里映射为 null 即"非故障"），
      // 不是枚举状态名。
      //
      // 刻意**不**断言它们必须是 `healthy`：初稿那样写，短跑时被 l1-3 打回 ——
      // 它当时落后 1 块、3 秒采样窗口内无进展，于是报 `catching-up`。那不是故障：
      // 本链无交易不出块，空闲时落后一个传播尾巴是正常的，而 catching-up 的契约含义
      // 正是"要等，不是要处置"。写死 healthy 是把采样时机当成了判据。
      const survivors = TOPOLOGY_NODES
        .filter((n) => n.domain !== DOMAIN && n.role === 'l1-validator');
      for (const n of survivors) {
        const r = view[n.id];
        assert.equal(CATEGORY_OF_RECOVERY_STATE[r.state], null,
          `${n.id}（${n.domain}）应当不受影响（非故障状态），实际 ${r.state} —— ${r.detail}`);
        assert.equal(r.countsAsOffline, false,
          `${n.id} 不该被算作离线 —— 否则余量会被虚报`);
      }
      t.diagnostic(`存活验证者 ${survivors.length} 个均为非故障状态`
        + `（${survivors.map((n) => `${n.id}=${view[n.id].state}`).join('、')}）；`
        + `${DOMAIN} 的 ${LOCAL_NODES.length} 个节点均为 unreachable`);

      // 同一时刻，**故障机器自己**看到的是"本机主动停止"，不是边界缺席 ——
      // 容器事实优先于网络推断（devnet-stop 曾因这个优先级反了而误报"去看那台机器"）。
      //
      // 必须走 scripts/devnet-status 而**不是**直接调 tools/inspect/node-status.mjs：
      // 容器事实由脚本在宿主侧现采并写入 .devnet/containers.json，工具只是读它
      // （工具设计上跑在 verify 容器里，那儿没有 docker）。直接调工具会读到一份陈旧的
      // 事实，从而把"本机主动停止"误判成"整域缺席" —— 初稿正是这么写的，被本测试打回。
      //
      // 该命令在有验证者离线时**按契约以退出码 1 结束**，而这里正是那种局面 ——
      // 所以要容忍非零退出并仍读 stdout，否则 execFileSync 抛异常，看起来像工具坏了。
      let local;
      try {
        local = sh('sh', ['scripts/devnet-status.sh', '--json', '--sample-seconds', '1']);
      } catch (e) {
        local = e.stdout ?? '';
        assert.equal(e.status, 1,
          `devnet-status 应以 0 或 1 结束（1 = 有须处置的节点），实际 ${e.status}：${e.stderr ?? ''}`);
      }
      const mine = JSON.parse(local).nodes.filter((r) => r.domain === DOMAIN);
      assert.ok(mine.length > 0, 'node-status 的输出里应当有本边界的行');
      for (const r of mine) {
        assert.notEqual(r.state, 'unreachable',
          `在故障机器自己身上不该报 unreachable（它看得见容器是被主动停的），实际 ${r.state}`);
      }
      t.diagnostic(`故障机器自身视角：${mine.map((r) => `${r.id}=${r.state}`).join('、')}`);
    });

    test(`${DOMAIN} 恢复后 2 分钟内追平，且期间不得被误报为故障（SC-012）`, async (t) => {
      // 用 devnet-node start 而不是 devnet-start：后者会阻塞到就绪，
      // 那样就错过了追赶过程 —— 而 SC-012 要看的正是这段。
      for (const id of LOCAL_NODES) sh('sh', ['scripts/devnet-node.sh', 'start', id]);

      const FAILURE_STATES = new Set(['stalled', 'data-corrupt', 'identity-mismatch']);
      const deadline = Date.now() + 120_000;
      const seen = new Set();
      const misreported = [];
      let caughtUp = false;

      while (Date.now() < deadline) {
        const view = await survivorView();
        for (const id of LOCAL_VALIDATORS) {
          const r = view[id];
          seen.add(r.state);
          if (FAILURE_STATES.has(r.state)) {
            misreported.push(`${id} 在恢复过程中被报为 ${r.state} —— ${r.detail}`);
          }
        }
        if (LOCAL_VALIDATORS.every((id) => view[id].state === 'healthy')) { caughtUp = true; break; }
        await new Promise((r) => setTimeout(r, 2_000));
      }

      // SC-012 的正题：追赶**不得**被归成故障。这是硬判据。
      assert.deepEqual(misreported, [],
        `恢复过程中出现误报：\n  ${misreported.join('\n  ')}`);
      // SC-005 的后半段：2 分钟内追平
      assert.ok(caughtUp, `120 秒内未追平，观测到的状态：${[...seen].join('、')}`);

      // catching-up 能否被"抓到"取决于落后量与采样时机；抓到就记一笔，
      // 抓不到不判失败 —— 判据是"不误报"，不是"必须慢到能被看见"。
      t.diagnostic(`恢复期观测到的状态：${[...seen].join('、')}`
        + (seen.has('catching-up') ? '（含 catching-up ✅ SC-012 正向观测）' : '（追平太快，未取到 catching-up 样本）'));

      // 收尾：链恢复满余量
      sh('sh', ['scripts/devnet-start.sh']);
      assert.equal(await devnetAvailable(), true, '本机 RPC 代理应随边界一起回来');
      for (const id of LOCAL_NODES) assert.ok(isRunning(id), `${id} 应当在运行`);
    });
  });
