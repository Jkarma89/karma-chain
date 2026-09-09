// T042 / quickstart 场景 D（V-05）：离线验证者超过容错上限时的行为（FR-009）。
//
// 这一场景验证的是**安全性**，不是可用性：停摆是正确行为，分叉才是事故。
// 5 个等权验证者、发起查询需已连接权重 ≥ 75%（001 研究 R-05）：
//   4/5 = 80% ≥ 75% → 继续出块
//   3/5 = 60% < 75% → 停止出块
// 恢复到上限内后必须自动继续，且**此前已确认的区块一个都不许回滚**。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  pub, sendTx, sh, devnetAvailable, VALIDATOR_IDS, wallet, RECIPIENT,
  pickLocalVictims, localVictimSkip,
} from './lib/devnet.mjs';
import { parseEther } from 'viem';

// 需要**两个**靶子才能超出容错上限（f=1），而且两个都得在本机 —— docker 只能操作本机容器。
// 原先按下标取 VALIDATOR_IDS[3]、[4]，单机形态下都在本机；跨机形态下每个边界至多 1 个
// 验证者（T-5 守卫保证），因此**任何一台机器都凑不出 2 个** —— 本场景在跨机形态下
// 只能靠人工（在两台机器上各执行一次 devnet-stop），或在单机形态下跑。
// docs/devnet.md 9.6 的演练清单里记着人工做法。
const VICTIMS = pickLocalVictims(2);
const node = (...args) => sh('sh', ['scripts/devnet-node.sh', ...args]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('场景 D —— 超出容错上限后停摆而非分叉',
  { skip: VICTIMS ? undefined : localVictimSkip(2), concurrency: 1 }, () => {
  let checkpoint;   // 越界前的最后一个已确认区块

  before(async () => {
    if (!await devnetAvailable()) throw new Error('开发网不可用 —— 先运行 scripts/devnet-start.sh');
  });

  after(() => {
    // 无论断言结果如何都要把节点放回来，否则后续测试全部失败
    for (const v of VICTIMS) { try { node('start', v); } catch { /* ignore */ } }
  });

  test('越界前先立一个检查点：记录已确认区块的哈希', async () => {
    const height = await sendTx();
    const block = await pub.getBlock({ blockNumber: BigInt(height) });
    checkpoint = { height, hash: block.hash };
    assert.match(checkpoint.hash, /^0x[0-9a-f]{64}$/);
  });

  test(`杀死 ${VICTIMS.join(' 与 ')}（3/5 在线 = 60% < 75%）后停止出块`, async (t) => {
    for (const v of VICTIMS) node('kill', v);
    t.diagnostic(`已强制终止 ${VICTIMS.length} 个验证者，剩余 ${VALIDATOR_IDS.length - VICTIMS.length}/5`);
    await sleep(5000);

    const before = Number(await pub.getBlockNumber());

    // 交易应当发不出去或确认不了 —— 关键是**不能**产生新区块
    let confirmed = false;
    try {
      const hash = await wallet.sendTransaction({ to: RECIPIENT, value: parseEther('0.001') });
      await pub.waitForTransactionReceipt({ hash, timeout: 25_000, pollingInterval: 1000 });
      confirmed = true;
    } catch { /* 预期：确认不了 */ }

    const after = Number(await pub.getBlockNumber());
    assert.equal(confirmed, false, '越界时不应有交易被确认');
    assert.equal(after, before, `越界期间高度不得增长：${before} -> ${after}`);
  });

  test('停摆期间既有数据仍可读，且与检查点一致（没有分叉）', async () => {
    const block = await pub.getBlock({ blockNumber: BigInt(checkpoint.height) });
    assert.equal(block.hash, checkpoint.hash,
      '停摆不得改写历史 —— 同一高度的区块哈希必须不变');
  });

  test('恢复到上限内后自动继续出块，无需人工干预', async (t) => {
    node('start', VICTIMS[0]);   // 只恢复一个 → 4/5 在线 = 80% ≥ 75%
    t.diagnostic(`已恢复 ${VICTIMS[0]}，剩余离线 ${VICTIMS.length - 1} 个（在上限内）`);

    const before = Number(await pub.getBlockNumber());
    let height = before;
    for (let i = 0; i < 30 && height <= before; i += 1) {
      await sleep(4000);
      try { height = await sendTx(); } catch { /* 还没恢复，继续等 */ }
    }
    assert.ok(height > before, `恢复后应当继续出块：${before} -> ${height}`);
  });

  test('已确认区块零回滚（SC-006）', async () => {
    const block = await pub.getBlock({ blockNumber: BigInt(checkpoint.height) });
    assert.equal(block.hash, checkpoint.hash,
      `高度 ${checkpoint.height} 的区块哈希在整个停摆-恢复过程中必须不变`);
    assert.ok(Number(await pub.getBlockNumber()) >= checkpoint.height, '高度不得低于检查点');
  });
});
