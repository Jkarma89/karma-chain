// 「它还连得上足够的成员吗」——（功能 005，2026-09-18 实测缺口）。
//
// ## 缺口是怎么暴露的
//
// T033 把 l1-2 加回集合之后，它与**五个 L1 验证者全断**，卡在落后 24 块。
// 而 `devnet-verify` 报的是：
//
//   [OK] node              7/8 nodes serving，1 个在恢复中（l1-2 catching-up）
//   [OK] fault-tolerance   6/6 validators online, tolerance 1, **full margin**
//
// 余量其实是 **0**：l1-2 投不了票，再掉一个就停摆。
//
// 成因不是判定写错了，是**判定者不在场**。classify 的那一支写着
//「是否卡住由容器健康检查判定，它持有超时窗口」—— 而容器级事实**只有本机采得到**。
// l1-2 在 win-2 上，从 win-1 看它永远没有那个判定者，状态就停在 `catching-up`，
// 而按契约 `catching-up` 算"在服务 L1"（FR-011）。
//
// **把判定委托给一个在这台机器上不存在的判定者，而回落是乐观的那一档。**
//
// ## 为什么不去读 /ext/health
//
// 节点自己那句话最直接（`connected to 16.666667%; required at least 80%`），
// 但 `tools/dashboard/README.md` 的四条边界之一就是**不请求 `/ext/health`**：
// 综合健康位含 P 链可达性，两个 Primary 全停时它会全假而 L1 仍在正常出块 ——
// 那是假红灯。那条边界是对的，没有动它。
//
// 同一个结论**本来就能从已有观测算出来**：节点自报的 peer 列表 ∩ 成员集合。
// 算出来 1/6 = 16.67%，与 l1-2 自报的 16.666667% 分毫不差 ——
// 说明这就是 avalanchego 用的那个算式，而且完全不碰 P 链。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { canQuery, maxOffline } from '../../tools/membership/tolerance.mjs';
import { classify } from '../../tools/inspect/node-status.mjs';

describe('① canQuery 就是 ⌊n/4⌋ 那条算式换个问法', () => {
  test('2026-09-18 那一刻的 l1-2：1/6 = 16.67%，判不通过', () => {
    const q = canQuery({ n: 6, disconnectedMembers: 5 });
    assert.equal(q.ok, false);
    assert.equal(q.connected, 1);
    assert.equal(q.percent, 16.67,
      '算出来的百分比要与节点自报的 16.666667% 对得上 —— 对不上说明用的不是同一个算式');
  });

  test('断 1 个（容错之内）仍能发起查询；断 2 个不能', () => {
    assert.equal(canQuery({ n: 6, disconnectedMembers: 1 }).ok, true);
    assert.equal(canQuery({ n: 6, disconnectedMembers: 2 }).ok, false);
  });

  test('穷举 n = 4…12：与 ⌊n/4⌋ 逐格一致（不是第二份定义）', () => {
    for (let n = 4; n <= 12; n += 1) {
      for (let d = 0; d <= n; d += 1) {
        assert.equal(canQuery({ n, disconnectedMembers: d }).ok, d <= maxOffline(n),
          `n=${n} 断 ${d} 个时与 ⌊n/4⌋ 不一致 —— 那就是第二份定义了，两处必然会漂移`);
      }
    }
  });
});

const behindProbe = (peerNodeIds) => ({
  reachable: true, nodeId: 'NodeID-self', bootstrapped: true,
  height: 1309, peers: peerNodeIds.length, peerNodeIds,
});
const NODE = { id: 'l1-2', role: 'l1-validator', domain: 'win-2', nodeId: 'NodeID-self' };
const MEMBERS = new Set(['NodeID-self', 'NodeID-a', 'NodeID-b', 'NodeID-c', 'NodeID-d', 'NodeID-e']);
const ctxOf = (probe, over = {}) => ({
  probe,
  prevHeight: 1309,          // 与 height 相同 → 采样窗口内**无进展**
  networkHeight: 1333,
  seenByPeers: new Set(),
  sampleSeconds: 1,
  container: null,           // 别的机器上的节点：**没有容器级事实**
  memberNodeIds: MEMBERS,
  ...over,
});

describe('② 连不上足够成员的节点是 stalled，不是 catching-up', () => {
  test('一个成员都没连上 → stalled，且计入离线', () => {
    const c = classify(NODE, ctxOf(behindProbe(['NodeID-primary-1', 'NodeID-primary-2'])));
    assert.equal(c.state, 'stalled',
      '它投不了票却被记成 catching-up —— 而 catching-up 按契约算"在服务 L1"，'
      + '于是容错余量被报成满的。那正是 2026-09-18 撞到的那一幕');
    assert.equal(c.countsAsOffline, true, 'stalled 必须计入离线，否则余量照旧是错的');
    assert.match(c.detail, /1\/6|16\.67/, '要把算出来的连接数说出来，而不是只说"卡住了"');
  });

  test('断 1 个（容错之内）仍是 catching-up，不许误报', () => {
    const c = classify(NODE, ctxOf(behindProbe(['NodeID-a', 'NodeID-b', 'NodeID-c', 'NodeID-d'])));
    assert.equal(c.state, 'catching-up',
      '连接数够发起查询时报 stalled 就是假红灯 —— 一个正常追赶的节点会被当成故障');
    assert.equal(c.countsAsOffline, false);
  });

  test('全部连上 → catching-up（它真的在追赶）', () => {
    const c = classify(NODE, ctxOf(behindProbe(['NodeID-a', 'NodeID-b', 'NodeID-c', 'NodeID-d', 'NodeID-e'])));
    assert.equal(c.state, 'catching-up');
  });
});

describe('③ 没有成员集合时行为不变，而且**说出来没有判定者**', () => {
  test('memberNodeIds 缺失 → 仍是 catching-up（不凭空判故障）', () => {
    const c = classify(NODE, ctxOf(behindProbe([]), { memberNodeIds: undefined }));
    assert.equal(c.state, 'catching-up',
      '拿不到成员集合就判 stalled 的话，一次读取失败会把所有落后的节点变成故障');
    assert.equal(c.countsAsOffline, false);
  });

  test('缺失时文案必须点破"此刻没有判定者"', () => {
    const c = classify(NODE, ctxOf(behindProbe([]), { memberNodeIds: undefined }));
    assert.match(c.detail, /没有判定者/,
      '旧文案说"是否卡住由容器健康检查判定" —— 而那台机器上根本没有容器级事实。'
      + '一句指向不存在的判定者的说明，比不说更坏：它让人以为有人在看');
  });

  test('有成员集合且连接够时，文案仍指向容器健康检查（那时它确实是判定者）', () => {
    const c = classify(NODE, ctxOf(behindProbe(['NodeID-a', 'NodeID-b', 'NodeID-c', 'NodeID-d', 'NodeID-e'])));
    assert.match(c.detail, /容器健康检查/);
  });
});

describe('④ 进度优先：在涨就是在追赶，不看连接数', () => {
  test('窗口内高度有进展 → catching-up，带速率', () => {
    const c = classify(NODE, ctxOf(behindProbe([]), { prevHeight: 1300 }));
    assert.equal(c.state, 'catching-up',
      '高度在涨说明它正从某处拿到区块 —— 此时判 stalled 是错的');
    assert.match(c.detail, /\/min/);
  });
});
