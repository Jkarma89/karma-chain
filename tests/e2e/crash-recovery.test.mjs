// T032 / quickstart 场景 A：强制终止全部节点后，链从自身数据卷恢复（US1，本特性的 MVP）。
//
// 这是触发整个功能 002 的那次故障的直接复现。对照组是 001：同样的操作会让链彻底起不来，
// 唯一出路是丢弃全链状态；002 应当在数十秒内自己回来，且高度、余额、合约一字不差。
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  pub, sendTx, killAll, start, waitReady, genesisHash, devnetAvailable, RECIPIENT, NODE_IDS,
  localNodeIds,
} from './lib/devnet.mjs';

describe('场景 A —— 强制终止后链自己回来', { concurrency: 1 }, () => {
  let available = false;
  before(async () => {
    available = await devnetAvailable();
    if (!available) throw new Error('开发网不可用 —— 先运行 scripts/devnet-start.sh');
  });

  test('高度、余额与创世哈希全部保持，且无需重置', async () => {
    // 1. 制造可验证的链上状态
    await sendTx();
    const before = {
      height: Number(await pub.getBlockNumber()),
      balance: await pub.getBalance({ address: RECIPIENT }),
      genesis: (await pub.getBlock({ blockNumber: 0n })).hash,
    };
    assert.equal(before.genesis, genesisHash(), '前置条件：创世哈希应与提交值一致');
    assert.ok(before.height > 0, '前置条件：链上应当已有区块');

    // 2. 最粗暴的终止 —— 不发送任何终止信号
    const killed = killAll();
    // 按**本机实际承载**的节点数断言，不是拓扑声明的总数：killAll 只能杀本机的容器。
    // 单机形态下两者相等（7 个都在本机）；跨机形态下本机只有本边界那几个 ——
    // 写死 NODE_IDS.length 会在每台机器上都失败（2026-09-09 实测）。
    const local = localNodeIds();
    assert.equal(killed, local.length + 1,
      `应当杀死本机的 ${local.length} 个节点（${local.join("、")}）+ 1 个 RPC 代理`);

    // 3. 直接重启，**不执行任何重置**
    start();
    const ms = await waitReady();

    const after = {
      height: Number(await pub.getBlockNumber()),
      balance: await pub.getBalance({ address: RECIPIENT }),
      genesis: (await pub.getBlock({ blockNumber: 0n })).hash,
    };

    assert.equal(after.genesis, before.genesis, '创世哈希不得变化（FR-024）');
    assert.ok(after.height >= before.height,
      `高度不得回退：崩溃前 ${before.height}，恢复后 ${after.height}`);
    assert.equal(after.balance, before.balance, '账户余额不得变化');
    assert.ok(ms < 300_000, `恢复耗时 ${Math.round(ms / 1000)}s，应当 ≤ 5 分钟（SC-001）`);
  });

  test('恢复后链继续接受交易', async () => {
    const h = Number(await pub.getBlockNumber());
    const block = await sendTx();
    assert.ok(block > h, `新交易应当产生新区块：${h} -> ${block}`);
  });

  test('恢复过程本身被明确告知，而不是静默进行（FR-033）', async () => {
    const { execFileSync } = await import('node:child_process');
    // 同理：取**本机**的第一个节点，NODE_IDS[0] 可能在别的机器上。
    const logs = execFileSync('docker', ['logs', `karmachain-${localNodeIds()[0]}`], { encoding: 'utf8' });
    assert.match(logs, /existing chain data found — recovering from this node's own volume/,
      '入口应当明确告知这是崩溃恢复及数据来源');
    // 恢复路径里不得出现编排工具 —— 缺陷 A 的修复方式是让它不再是必经环节（研究 R-01）
    assert.ok(!/avalanche network|network start|network stop/i.test(logs),
      '恢复路径中不应出现任何 Avalanche CLI 编排调用');
  });
});
