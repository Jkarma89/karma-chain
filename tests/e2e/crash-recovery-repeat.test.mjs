// T033 / quickstart 场景 B：反复强制终止（SC-002）。
//
// 单次恢复成功可能是运气；这组测试要的是**次次都成功**。SC-002 的目标是 50 轮，
// 每轮约 15 秒，跑满约 13 分钟 —— 因此轮数可由环境变量调整，默认按 spec 取 50。
// 日常回归可用 KARMACHAIN_CRASH_ROUNDS=5 快速验证，正式验收才跑满。
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { pub, sendTx, killAll, start, waitReady, devnetAvailable, RECIPIENT } from './lib/devnet.mjs';

const ROUNDS = Number(process.env.KARMACHAIN_CRASH_ROUNDS ?? 50);

describe(`场景 B —— ${ROUNDS} 轮强制终止后仍不丢状态`, { concurrency: 1 }, () => {
  before(async () => {
    if (!await devnetAvailable()) throw new Error('开发网不可用 —— 先运行 scripts/devnet-start.sh');
  });

  test(`${ROUNDS} 轮「强制终止 → 重启 → 发交易」，状态丢失与重置次数均为 0`, async (t) => {
    // 轮数 × 单轮上限，留出余量
    t.diagnostic(`预计耗时约 ${Math.ceil(ROUNDS * 20 / 60)} 分钟`);

    let losses = 0;
    let maxRecoverMs = 0;
    let height = Number(await pub.getBlockNumber());
    const balance0 = await pub.getBalance({ address: RECIPIENT });

    for (let i = 1; i <= ROUNDS; i += 1) {
      killAll();
      start();
      const ms = await waitReady();
      maxRecoverMs = Math.max(maxRecoverMs, ms);

      const got = Number(await pub.getBlockNumber());
      if (got < height) {
        losses += 1;
        t.diagnostic(`第 ${i} 轮丢块：崩溃前 ${height}，恢复后 ${got}`);
      }

      // 恢复后必须还能继续出块，否则"活着"没有意义
      height = await sendTx();
    }

    const balance = await pub.getBalance({ address: RECIPIENT });
    assert.equal(losses, 0, `${ROUNDS} 轮中有 ${losses} 轮丢失了链上状态`);
    assert.ok(balance > balance0, '每轮都发了交易，余额应当单调增加');
    assert.ok(maxRecoverMs < 300_000, `最慢一轮恢复 ${Math.round(maxRecoverMs / 1000)}s，应当 ≤ 5 分钟`);
    t.diagnostic(`最慢恢复 ${Math.round(maxRecoverMs / 1000)}s，最终高度 ${height}`);
  });
});
