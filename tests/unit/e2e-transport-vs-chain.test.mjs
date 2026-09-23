// 「入口没有应答」与「链给出了判决」是两类失败，必须分开（功能 005 / 2026-09-23）。
//
// ## 由来
//
// 第四轮完整 e2e：场景 F 的 30 分钟窗口里 **29 分钟全部确认**，只有第 30 分钟报
// `HTTP request failed` —— **没有状态码**，而链一直在出块（高度 2165 → 2184 → …）。
// 断的是 win-1 → win-2 那条链路，也就是**观测方自己的网络**，当天第三次抖
// （另两次：V-60 的 l1-1 P2P、同一轮空闲用例里五个节点同时 observation）。
//
// 那两条 30 分钟用例原先写着「SC-003/SC-005 要的是 100%，因此**不重试**」——
// 那条决定对**链给出的判决**（5xx、回执没来）成立，重试确实会把真问题磨平。
// 但它覆盖不到"根本没有应答"那一类：那不是关于链的结论，而真实客户端就会重试。
//
// 所以：**传输层重试一次，链侧一次都不重试**。本文件守的正是这条分界 ——
// 一旦 `attemptTx` 开始重试链侧失败，那条既有决定就被悄悄推翻了。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isTransportFailure, attemptTx, TRANSPORT_BUDGET } from '../e2e/lib/devnet.mjs';

/** 造一个带 cause 链的错误 —— viem 就是这么包的：外层丢了 status，里层才有。 */
const wrapped = (message, status) => {
  const inner = new Error('HTTP request failed.');
  if (status !== undefined) inner.status = status;
  const outer = new Error(message);
  outer.cause = inner;
  return outer;
};

describe('分类：没有应答 vs 链给出了判决', () => {
  test('cause 链里有 5xx → 链侧（代理活着，是它背后没有健康上游）', () => {
    assert.equal(isTransportFailure(wrapped('HTTP request failed.', 502)), false);
    assert.equal(isTransportFailure(wrapped('HTTP request failed.', 503)), false);
  });

  test('回执超时 → 链侧（交易进去了，只是没被确认）', () => {
    const e = new Error('Timed out while waiting for transaction with hash "0xabc" to be confirmed.');
    assert.equal(isTransportFailure(e), false);
  });

  test('既无状态码、也不是链上的判决 → 传输层', () => {
    assert.equal(isTransportFailure(wrapped('HTTP request failed.')), true);
    assert.equal(isTransportFailure(new Error('fetch failed')), true);
  });

  test('状态码藏在 cause 的第二层也要找得到', () => {
    // 外层 → 中层 → 内层带 status。只看顶层会把 502 误判成"没有应答"，
    // 而那正是 probe-tx.mjs 里记着的那个坑。
    const inner = Object.assign(new Error('HTTP request failed.'), { status: 504 });
    const mid = Object.assign(new Error('HTTP request failed.'), { cause: inner });
    const outer = Object.assign(new Error('TransactionExecutionError'), { cause: mid });
    assert.equal(isTransportFailure(outer), false);
  });
});

describe('attemptTx：传输层重试一次，链侧一次都不重试', () => {
  test('一次就成 → 不标 retried', async () => {
    let calls = 0;
    const r = await attemptTx(async () => { calls += 1; return 42; });
    assert.deepEqual({ ok: r.ok, height: r.height, retried: r.retried }, { ok: true, height: 42, retried: undefined });
    assert.equal(calls, 1);
  });

  test('传输层失败 → 重试一次 → 成功', async () => {
    let calls = 0;
    const r = await attemptTx(async () => {
      calls += 1;
      if (calls === 1) throw wrapped('HTTP request failed.');
      return 7;
    }, { retryDelayMs: 0 });
    assert.equal(r.ok, true);
    assert.equal(r.height, 7);
    assert.equal(r.retried, true, '重试过就要标出来 —— 否则诊断里看不出这一分钟其实抖过');
    assert.equal(calls, 2);
  });

  test('传输层连着失败两次 → kind = transport', async () => {
    let calls = 0;
    const r = await attemptTx(async () => { calls += 1; throw wrapped('HTTP request failed.'); },
      { retryDelayMs: 0 });
    assert.equal(r.ok, false);
    assert.equal(r.kind, 'transport');
    assert.equal(calls, 2, '只重试一次 —— 再多就成了把问题磨平');
  });

  test('**链侧失败一次都不重试** —— 这条是既有决定，不得被悄悄推翻', async () => {
    let calls = 0;
    const r = await attemptTx(async () => { calls += 1; throw wrapped('HTTP request failed.', 502); },
      { retryDelayMs: 0 });
    assert.equal(r.ok, false);
    assert.equal(r.kind, 'chain');
    assert.equal(calls, 1,
      '链侧失败被重试了 —— 那会把"第一次失败"藏起来，而 SC-003/SC-005 要的 100% 正是要抓它');
  });

  test('第一次传输层、第二次变成链侧 → 按链侧记', async () => {
    let calls = 0;
    const r = await attemptTx(async () => {
      calls += 1;
      throw calls === 1 ? wrapped('HTTP request failed.') : wrapped('HTTP request failed.', 503);
    }, { retryDelayMs: 0 });
    assert.equal(r.kind, 'chain', '重试之后拿到的是链上的判决，那就是链侧的结论');
  });
});

describe('预算', () => {
  test('传输层预算是 1 —— 一次是抖动，两次说明链路才是主角', () => {
    assert.equal(TRANSPORT_BUDGET, 1,
      '改这个数等于改"多少次算环境噪声"的口径 —— 要改就连同两条窗口用例的说法一起改');
  });
});
