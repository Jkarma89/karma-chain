// SC-012 的最后一块证据：在**活链**上目击 `catching-up`，并确认它与故障可区分。
//
// ## 为什么这一项一直缺证据，以及为什么"停节点再拉回"取不到
//
// DoD 里 SC-012 长期是"⚠️ 多数"：状态机全部分支有单元测试，真实故障的归类也在活链上
// 验证过，但 **`catching-up` 从未被现场目击**。两次 30 分钟窗口的恢复阶段都取不到样本，
// 起初以为是"追平太快"，其实原因更根本：
//
//   `catching-up` 的判据是"**已完成引导**且在服务 L1，但高度低于网络高度"。
//   而节点被 stop 之后重启，avalanchego 会**先把链引导完才开始服务 RPC** ——
//   那段时间 info.isBootstrapped 为 false，分类器报的是 `bootstrapping`。
//
// 所以"停节点 → 攒一堆块 → 重启"这条路**结构上**就产不出 `catching-up`，
// 无论攒多少块。真正能产生它的是**已在服务的节点暂时落后**。
//
// ## 本测试的做法
//
// **逐笔串行**发交易（每笔等回执），同时以高频（默认 150ms）探测全部节点。
// 每次出块的瞬间总有节点比最快的那个慢一个传播尾巴，那一刻它就是 `catching-up`。
// 取够样本即提前收工。**不停任何节点**，因此不占用容错名额，链全程满余量。
//
// 为什么是串行而不是并发突发（初稿的写法，两处都错了）：
//   * subnet-evm 把大量交易**批成极少的块** —— 实测 40 笔只出 2 个块、120 笔只出 3 个块。
//     要的是"多次出块事件"，不是"多笔交易"；按需出块下逐笔串行恰好一笔一块。
//   * 用显式 nonce 并发提交时，任一笔提交失败就留下 **nonce 空洞**，其后的交易
//     永远不会上链，等"最后一笔"的回执必然超时（实测：300 笔那轮
//     WaitForTransactionReceiptTimeoutError）。串行 + 等回执不存在这个问题。
//
// 2026-09-09 实测：取到 catching-up 样本，例如
//   l1-2(win-2) h=67 net=68 offline=false | 落后 1 块
//
// ## 这个证据的边界（不要过度解读）
//
// 它证明的是：该分支在活链上**可达**、输出符合契约（状态名 + 落后块数 + 不计入离线 +
// 非故障类别），运维能据此把"要等"与"要处置"分开。
//
// 它**不**证明"某节点落后数百块后逐步追平"那种长过程 —— 如上所述，那条路径上
// avalanchego 在服务之前就已引导完毕，观测不到。本链又是无交易不出块的，
// 空闲时也不存在持续落后。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RPC, clientsFor, sendTxVia, devnetAvailable } from './lib/devnet.mjs';
import { probeNode, classify } from '../../tools/inspect/node-status.mjs';
import { CATEGORY_OF_RECOVERY_STATE } from '../../tools/verify/lib/categories.mjs';
import { REPO_ROOT, loadProtocol, deriveTopology } from '../../tools/protocol/load.mjs';

const POLL_MS = Number(process.env.KARMACHAIN_CATCHUP_POLL_MS ?? 150);
/** 取够这么多样本就收工 —— 判据是"该分支可达且输出符合契约"，不是样本越多越好。 */
const TARGET_SAMPLES = Number(process.env.KARMACHAIN_CATCHUP_SAMPLES ?? 3);
/** 最多发这么多笔。每笔一个块，因此这也是"出块事件"的上限。 */
const MAX_TX = Number(process.env.KARMACHAIN_CATCHUP_TX ?? 60);

const NODES = deriveTopology(loadProtocol()).topologyNodes;
const BLOCKCHAIN_ID = (() => {
  try {
    return JSON.parse(readFileSync(
      resolve(REPO_ROOT, 'blockchain/chain-identity/karmachain.identity.json'), 'utf8')).blockchainId;
  } catch { return null; }
})();

/** 只有这三个是"要处置"。`unreachable` 不在其中 —— 见下方说明。 */
const MUST_NOT_APPEAR = new Set(['stalled', 'data-corrupt', 'identity-mismatch']);

const SKIP = await devnetAvailable()
  ? undefined
  : `开发网未运行（${RPC}）—— 先执行 scripts/devnet-start`;

describe('SC-012 —— 在活链上目击 catching-up，且它与故障可区分', { skip: SKIP, concurrency: 1 }, () => {
  test('交易突发期间应能取到 catching-up 样本，且不被算作离线或故障', async (t) => {
    const c = clientsFor(RPC);
    const samples = [];
    const forbidden = [];
    let stop = false;

    const poll = (async () => {
      let prev = new Map();
      while (!stop) {
        const probes = await Promise.all(NODES.map((n) => probeNode(n, BLOCKCHAIN_ID)));
        const heights = probes.map((p) => p.height).filter((h) => Number.isFinite(h));
        const networkHeight = heights.length ? Math.max(...heights) : null;
        const seenByPeers = new Set(probes.flatMap((p) => p.peerNodeIds ?? []));
        const per = new Map();
        NODES.forEach((n, i) => {
          const cur = per.get(n.domain) ?? { total: 0, down: 0 };
          cur.total += 1;
          if (!probes[i].reachable) cur.down += 1;
          per.set(n.domain, cur);
        });

        NODES.forEach((n, i) => {
          const dd = per.get(n.domain);
          const r = classify(n, {
            probe: probes[i],
            prevHeight: prev.get(n.id) ?? probes[i].height,
            networkHeight,
            seenByPeers,
            domainAllUnreachable: dd.down === dd.total,
            container: null,
            sampleSeconds: POLL_MS / 1000,
          });
          if (r.state === 'catching-up') {
            samples.push({ id: n.id, domain: n.domain, height: probes[i].height, networkHeight, ...r });
          } else if (MUST_NOT_APPEAR.has(r.state)) {
            forbidden.push(`${n.id}（${n.domain}）被报为 ${r.state} —— ${r.detail}`);
          }
        });
        prev = new Map(NODES.map((n, i) => [n.id, probes[i].height]));
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    })();

    let sent = 0;
    try {
      // 逐笔串行：每笔一个块，于是有 MAX_TX 次出块事件、每次一个传播窗口。
      // 取够样本即停，通常十几笔就够，不必发满。
      for (; sent < MAX_TX && samples.length < TARGET_SAMPLES; sent += 1) {
        await sendTxVia(c);
      }
    } finally {
      stop = true;
      await poll;
    }
    t.diagnostic(`发了 ${sent}/${MAX_TX} 笔（每笔一个块），取到 ${samples.length} 条 catching-up 样本`);

    assert.ok(samples.length > 0,
      `发了 ${sent} 笔（即 ${sent} 次出块）仍未取到 catching-up 样本。\n`
      + '  这不一定是回归：若各节点每次都在一个采样周期内跟上，就不存在可观测的"落后"瞬间。\n'
      + `  可加大 KARMACHAIN_CATCHUP_TX（当前 ${MAX_TX}）或减小 `
      + `KARMACHAIN_CATCHUP_POLL_MS（当前 ${POLL_MS}ms）。`);

    // 契约三条（002 contracts/cli-interface.md）：带进度、不计入离线、非故障
    for (const s of samples.slice(0, 20)) {
      assert.match(s.detail, /落后 \d+ 块/, `${s.id} 的 catching-up 必须给出进度，实际："${s.detail}"`);
      assert.equal(s.countsAsOffline, false,
        `${s.id} 追赶中不该被算作离线（会虚报余量不足）—— detail：${s.detail}`);
      assert.equal(CATEGORY_OF_RECOVERY_STATE[s.state], null,
        'catching-up 必须映射为"非故障"，否则运维会去处置一个只需等待的节点');
      assert.ok(Number.isFinite(s.height) && s.height < s.networkHeight,
        `${s.id} 报 catching-up 时应当确实落后：h=${s.height} net=${s.networkHeight}`);
    }

    // 全程不得出现"要处置"的状态。
    //
    // 刻意**不**把 `unreachable` 列进禁止集：本测试探测的是真实网络，链路真有丢包时
    // 某个边界会瞬时看起来全体不应答 —— 那是**如实的观测**，不是分类错误，
    // 而本测试要守的是分类的正确性。
    //
    // 这条注释的初稿把它归因为"高频探测导致的探测层抖动"，**那个解释是错的**：
    // 首轮运行时出现的 2 条 unreachable 样本，事后查明是 ubuntu-1 的**网线故障**
    // （对该机 21% ICMP 丢包、TCP 连接时间出现 3s/7s/15s 的 SYN 重传退避，
    // 而 NIC 计数器全零 —— 包是根本没到，不是到了被丢）。换线后归零。
    // 我把一个真实的硬件故障解释成了测量噪声，这里留个记录：
    // **"高频探测所以有抖动"是个太顺手的解释，用它之前先量一下丢包。**
    assert.deepEqual(forbidden, [],
      `突发期间出现了"要处置"的状态：\n  ${forbidden.slice(0, 10).join('\n  ')}`);

    const byNode = [...new Set(samples.map((s) => `${s.id}(${s.domain})`))];
    t.diagnostic(`共 ${samples.length} 条 catching-up 样本，涉及 ${byNode.join('、')}`);
    t.diagnostic(`样例：${samples[0].id} h=${samples[0].height} net=${samples[0].networkHeight} `
      + `offline=${samples[0].countsAsOffline} | ${samples[0].detail}`);
  });
});
