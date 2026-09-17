// P 链与聚合器用**不同分母**算同一个门槛（功能 005 / T033 实施期实测）。
//
// ## 事情是怎么暴露的
//
// 2026-09-17 把 l1-2 加回来时，第三步被 P 链拒绝：
//
//   signature weight is insufficient: 67*600 > 100*400
//
// 而工具同一屏上刚打印过「签名者 4/5（80%，门槛 67%）」。**两句话都对**：
//
//   聚合器按**当前** L1 集合算：5 个 × 100 = 500，4 个签名 = 80% ≥ 67% ✓
//   P 链按它**回看那一格**的集合算：6 个 × 100 = 600，门槛 402 > 400 ✗
//
// 落差的来源是 P 链验证 warp 消息时用的是「当前高度**之前一格**」的集合
//（实测：getValidatorsAt(9) = 500，getValidatorsAt(8) = 600，getHeight = 9）。
// 刚退过成员的链必然处在这个状态里 —— 所以这不是罕见情形，**每次退完再加都会撞到**。
//
// ## 本文件守什么
//
// 守的不是"能解出那串数字"，而是**解出来之后折算的门槛真的够**。
// 少写一个向上取整就会得到一个"看起来更严、实际还是不够"的门槛，
// 而那种错的代价是：带着一条链必然拒绝的消息，一遍遍走到花钱那一步。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseInsufficientWeight, quorumForChainTotal, readVerificationWeights,
} from '../../tools/membership/add-validator.mjs';

/** 2026-09-17 实测原文（P 链 issueTx 的返回）。 */
const REAL = "couldn't issue tx: failed verifying warp messages: "
  + 'signature weight is insufficient: 67*600 > 100*400';

describe('① 从链的报错里读出它用的分母', () => {
  test('实测原文能解出四个数', () => {
    const r = parseInsufficientWeight(REAL);
    assert.deepEqual(
      { q: r.quorumNum, total: String(r.total), got: String(r.got) },
      { q: 67, total: '600', got: '400' },
    );
  });

  test('无关报错解不出 —— 不许把别的失败也当成分母不一致', () => {
    for (const m of ['execution reverted', '', null, undefined, 'insufficient funds']) {
      assert.equal(parseInsufficientWeight(m), null, `${m} 被误解成了权重不足`);
    }
  });

  test('分母不是 100 时返回 null（那套折算不成立）', () => {
    assert.equal(
      parseInsufficientWeight('signature weight is insufficient: 2*600 > 3*400'),
      null,
      '链若换了 quorumDenominator，百分比折算就不对了 —— '
      + '此时必须解不出来、走原来的失败路径，而不是算出一个错的门槛',
    );
  });

  test('权重是 bigint —— 权重会超过 2^53', () => {
    const r = parseInsufficientWeight(
      'signature weight is insufficient: 67*90071992547409920 > 100*1',
    );
    assert.equal(typeof r.total, 'bigint');
    assert.equal(String(r.total), '90071992547409920');
  });
});

describe('② 折算出来的门槛**必须真的够**', () => {
  test('实测那一次：67% × 600 ÷ 500 → 81%', () => {
    const r = parseInsufficientWeight(REAL);
    assert.equal(quorumForChainTotal({ quorumNum: r.quorumNum, chainTotal: r.total, localTotal: 500n }), 81);
  });

  // 这一条是本文件的要害。向下取整会给出 80% —— 而 80% × 500 = 400，
  // **正是被拒绝的那个数**：门槛"提高"了却一点用没有。
  test('穷举：折算后的权重恒 ≥ 链要求的权重', () => {
    const fails = [];
    for (let chain = 100; chain <= 2000; chain += 100) {
      for (let local = 100; local <= 2000; local += 100) {
        for (const q of [51, 67, 75, 80]) {
          const pct = quorumForChainTotal({ quorumNum: q, chainTotal: BigInt(chain), localTotal: BigInt(local) });
          if (pct === null) continue;
          const needByChain = Math.ceil((q * chain) / 100);
          const gotIfMet = Math.floor((pct * local) / 100);
          // pct 被 100 截顶时，本地集合**凑不出**链要求的权重 —— 那是真相，不是 bug
          if (pct === 100 && local < needByChain) continue;
          if (gotIfMet < needByChain) fails.push(`q=${q} chain=${chain} local=${local} → ${pct}% 只有 ${gotIfMet}，要 ${needByChain}`);
        }
      }
    }
    assert.deepEqual(fails, [],
      '折算出的门槛不够 —— 少了向上取整的话会得到一个"看起来更严、实际还是不够"的数，\n'
      + '  而它的代价是带着一条链必然拒绝的消息反复走到花钱那一步：\n  '
      + fails.slice(0, 3).join('\n  '));
  });

  test('截顶在 100，不会要 120%', () => {
    assert.equal(quorumForChainTotal({ quorumNum: 67, chainTotal: 6000n, localTotal: 500n }), 100);
  });

  test('本地总权重为 0 时返回 null（不构造出除零的门槛）', () => {
    assert.equal(quorumForChainTotal({ quorumNum: 67, chainTotal: 600n, localTotal: 0n }), null);
  });
});

describe('③ 两个分母都从 P 链读，落后与否是**算出来的**', () => {
  const fakePchain = (byHeight, height) => async (method, params) => {
    if (method === 'platform.getHeight') return { height: String(height) };
    if (method === 'platform.getValidatorsAt') {
      const set = byHeight[params.height];
      if (!set) throw new Error(`没有高度 ${params.height} 的夹具`);
      return Object.fromEntries(set.map((w, i) => [`NodeID-${i}`, { weight: String(w) }]));
    }
    throw new Error(`没料到的方法 ${method}`);
  };

  test('退过成员之后：当前 500 / 验证 600，lagging = true', async () => {
    const w = await readVerificationWeights({
      pchain: fakePchain({ 9: [100, 100, 100, 100, 100], 8: [100, 100, 100, 100, 100, 100] }, 9),
      subnetId: 'x',
    });
    assert.equal(String(w.currentTotal), '500');
    assert.equal(String(w.verifyTotal), '600');
    assert.equal(w.currentCount, 5);
    assert.equal(w.verifyCount, 6);
    assert.equal(w.verifyHeight, 8);
    assert.equal(w.lagging, true);
  });

  test('稳定状态：两格相同 → lagging = false（不许恒为真）', async () => {
    const same = [100, 100, 100, 100, 100];
    const w = await readVerificationWeights({
      pchain: fakePchain({ 12: same, 11: same }, 12), subnetId: 'x',
    });
    assert.equal(w.lagging, false,
      'lagging 恒为真的话，每一次加入都会去要一个更高的门槛 —— '
      + '而恒定非空的告警等于没有告警');
  });

  test('高度 0 时不去查 -1', async () => {
    const w = await readVerificationWeights({
      pchain: fakePchain({ 0: [100] }, 0), subnetId: 'x',
    });
    assert.equal(w.verifyHeight, 0);
    assert.equal(w.lagging, false);
  });
});
