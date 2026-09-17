// 退出的前置检查**不得堵死第四步**（功能 005 / T041 实施期发现）。
//
// ## 这个缺陷长什么样
//
// 退出的第三步做的正是"把它从 P 链摘掉"。所以第三步之后，目标**本来就不在**
// P 链成员集合里了 —— 而那恰恰是第四步（让合约认下这次摘除）唯一该跑的时刻。
//
// 而前置检查里有一条「它不在 P 链集合里 → 无可退」。不区分进度的话：
//
//   第三步成功 → 目标离开 P 链 → 前置检查报"无可退" → **第四步永远进不去**
//
// 链就停在「P 链摘了、合约没认」的中间态。更讽刺的是工具自己在第三步的输出里
// 写着"可直接重跑本命令重试" —— 那条重试路径被它自己的前置检查堵死了。
//
// **2026-09-17 跑 T041 时实地撞到**，链当时正停在那个中间态。
//
// ## 为什么加入那一侧没有同样的毛病
//
// 方向相反：加入的成员检查读**合约事件**，而加入的第三步动的是 **P 链** ——
// 两者不打架。退出这边两个都落在 P 链上，才撞上。
// 所以这条守卫只对退出立，不对加入立；而下面那条反向断言保证它不是空跑。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { removalPrecheck } from '../../tools/membership/remove-validator.mjs';
import { loadProtocol, deriveTopology } from '../../tools/protocol/load.mjs';
import { identityOf } from '../../tools/verify/lib/identity.mjs';

const config = loadProtocol();
const topo = deriveTopology(config);
const SUBNET = 'SubnetIdForTest';

/** 声明里第一个 L1 验证者的 NodeID —— 拿真实声明，不编一个。 */
const validators = config.validators.nodes.map((v) => identityOf(v).nodeId);
const TARGET = validators[0];

/** 所有 Primary 都在线、所有节点都答得上话。 */
const okFetch = async () => ({ ok: true, json: async () => ({}) });

/**
 * 造一次前置检查。`onPChain` 决定目标还在不在 P 链集合里。
 *
 * 其余成员一律当作在 P 链上且在线 —— 本文件只测"进度感知"这一条，
 * 别的判据由 membership-removal.test.mjs 覆盖。
 */
const precheckWith = ({ onPChain, resuming }) => {
  const members = validators
    .filter((id) => onPChain || id !== TARGET)
    .map((nodeId) => ({ nodeId, weight: 100n, validationID: null, balance: null }));
  return removalPrecheck({
    client: { getBlockNumber: async () => 100n, getLogs: async () => [] },
    pchain: async (method) => {
      assert.equal(method, 'platform.getCurrentValidators');
      return { validators: members.map((m) => ({ nodeID: m.nodeId, weight: '100' })) };
    },
    nodeId: TARGET,
    config,
    subnetId: SUBNET,
    resumingAfterPChainRemoval: resuming,
    // precheck 内部用全局 fetch 探活；这里全判在线，把变量收敛到那一条判据上
    fetchImpl: okFetch,
  });
};

describe('第三步之后，前置检查必须放行第四步', () => {
  test('**已从 P 链摘除 + 正在续做第四步 → 不得报"无可退"**', async () => {
    const pre = await precheckWith({ onPChain: false, resuming: true });
    const blocked = pre.problems.filter((p) => /不在 P 链的成员集合里/.test(p));
    assert.deepEqual(blocked, [],
      '第三步之后目标本来就不在 P 链集合里 —— 这时报"无可退"会把第四步永远堵死，\n'
      + '  而链正停在「P 链摘了、合约没认」的中间态。\n'
      + '  removalPrecheck 必须接受 resumingAfterPChainRemoval 并据此跳过这一条。');
  });

  test('**反向断言**：还没走第三步时，"不在集合里"仍然要拦', async () => {
    // 少了这一条，上面那条可以靠"把这个检查整个删掉"来满足 —— 那是另一个缺陷。
    const pre = await precheckWith({ onPChain: false, resuming: false });
    assert.ok(pre.problems.some((p) => /不在 P 链的成员集合里/.test(p)),
      '一个根本不在集合里、也没走过第三步的 nodeID，必须被拦下 —— '
      + '否则工具会去"退"一个不存在的成员');
    assert.equal(pre.ok, false);
  });

  test('正常情形（在集合里、没在续做）照旧放行', async () => {
    const pre = await precheckWith({ onPChain: true, resuming: false });
    assert.deepEqual(pre.problems.filter((p) => /不在 P 链的成员集合里/.test(p)), [],
      '目标好端端在集合里，不该有这条问题');
  });

  test('参数默认为 false —— 忘了传不会静默放行', async () => {
    // 这一条守的是"少传一个参数"这类错误的方向：默认必须是**更严**的那一侧。
    // subnetId 那次的教训是反的（漏参数导致一整个来源静默消失），这里不重蹈。
    // 集合非空但不含 TARGET —— 空集合会让 signerAvailability 先抛，
    // 那样测的就不是"默认值"而是"空集合怎么办"了。
    const others = validators.filter((id) => id !== TARGET);
    const pre = await removalPrecheck({
      client: { getBlockNumber: async () => 100n, getLogs: async () => [] },
      pchain: async () => ({ validators: others.map((id) => ({ nodeID: id, weight: '100' })) }),
      nodeId: TARGET,
      config,
      subnetId: SUBNET,
      fetchImpl: okFetch,
    });
    assert.ok(pre.problems.some((p) => /不在 P 链的成员集合里/.test(p)),
      '不传 resumingAfterPChainRemoval 时必须按 false 处理（更严的那一侧）');
  });
});

describe('前提：夹具没有把判据构造空（防空跑）', () => {
  test('声明里确实有验证者，且 TARGET 是其中之一', () => {
    assert.ok(validators.length >= 2, `声明里只有 ${validators.length} 个验证者，构造不出"退一个"的场景`);
    assert.ok(validators.includes(TARGET));
  });

  test('拓扑里有两个 Primary —— 否则那条 Primary 在线检查会空过', () => {
    const primaries = topo.topologyNodes.filter((n) => n.role === 'primary');
    assert.equal(primaries.length, 2,
      'Primary 数变了：那条"两个都必须在线"的检查与 004 的 V-08 绑在一起，要一起重看');
  });
});
