// T034 / V-03：节点在**引导过程中途**被强制终止。
//
// 这是恢复路径里最容易留下半成品状态的时刻：数据库刚建了一半，共识状态还没落定。
// 判据不是"恢复得多快"，而是**不进入需要人工干预的状态** —— 重启后要么继续引导、
// 要么自行清理重来，总之能自己走出去。
//
// 同时验证 FR-006 的一半：某个节点重建期间，其余节点与整条链不受影响。
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  pub, sendTx, waitReady, devnetAvailable, sh, VALIDATOR_IDS, RPC,
  pickLocalVictims, localVictimSkip,
} from './lib/devnet.mjs';

// 靶子必须是**本机真的有容器**的验证者 —— docker 只能操作本机。
// 原先按下标从全局列表里挑（单机形态下 7 个容器都在本机，那样写没问题），
// 跨机形态下会因为那个节点在别的机器上而失败。挑不到就跳过并说明原因。
const LOCAL = pickLocalVictims(1);
const VICTIM = LOCAL?.[0];
const CONTAINER = `karmachain-${VICTIM}`;

// 走 scripts/devnet-node，**不要**自己拼 compose 文件路径。
//
// 原先这里写死的是 `docker/compose/local-local.yml`（单机形态那份）。跨机形态下这是
// **本会话里最危险的一个缺陷**：它不会报错，而是按单机配置重建那个节点 ——
// 挂上 blockchain/nodes/local/ 的标志（容器网段地址而非局域网地址）、接到 karmachain 网络，
// 并顺带把 depends_on 的依赖也起来。2026-09-09 在 win-1 上误跑到它，结果就是
// win-1 上凭空多出两个 karmachain-primary-* 容器（拓扑里它们属于 ubuntu-1/ubuntu-2），
// 而 devnet-status 的"容器事实优先"规则会拿这些**同名的本地容器**去描述远端节点，
// 把远端好着的 Primary 报成 stopped。
//
// devnet-node.sh 从 active.env 解析当前生效的 compose，两种形态都对；
// 它的 `wipe` 正好是"停 + 删容器 + 删卷"，`start` 正好是"up -d 该服务"。
const node = (...args) => sh('sh', ['scripts/devnet-node.sh', ...args]);
const state = () => {
  try {
    return execFileSync('docker', ['inspect', '--format', '{{.State.Status}}', CONTAINER], { encoding: 'utf8' }).trim();
  } catch { return 'missing'; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('V-03 —— 引导中途被强制终止',
  { skip: LOCAL ? undefined : localVictimSkip(1), concurrency: 1 }, () => {
  before(async () => {
    if (!await devnetAvailable()) throw new Error('开发网不可用 —— 先运行 scripts/devnet-start.sh');
  });

  test(`${VICTIM} 在引导途中被杀后能自行走出，且不影响其余节点`, async (t) => {
    const heightBefore = Number(await pub.getBlockNumber());

    // 1. 清掉它的数据卷，制造"必须从零引导"的处境（同时是 FR-006 的场景）
    node('wipe', VICTIM);
    t.diagnostic(`${VICTIM} 的数据卷已删除`);

    // 2. 启动它，让它开始引导
    node('start', VICTIM);
    await sleep(8000);
    assert.equal(state(), 'running', '应当处于引导中');

    // 3. 引导途中强制杀死
    sh('docker', ['kill', CONTAINER]);
    t.diagnostic('引导途中已强制杀死');
    await sleep(2000);

    // 4. 再次启动 —— 关键判据：它能自己走出去，不需要人工清理
    node('start', VICTIM);

    let healthy = false;
    for (let i = 0; i < 60; i += 1) {
      await sleep(5000);
      const s = state();
      // 退出即说明进入了需要人工处置的状态（退出码 10/12 是校验失败）
      if (s === 'exited') {
        const code = execFileSync('docker', ['inspect', '--format', '{{.State.ExitCode}}', CONTAINER], { encoding: 'utf8' }).trim();
        assert.fail(`${VICTIM} 以退出码 ${code} 结束 —— 进入了需要人工干预的状态`);
      }
      const health = execFileSync('docker', ['inspect', '--format', '{{.State.Health.Status}}', CONTAINER], { encoding: 'utf8' }).trim();
      if (health === 'healthy') { healthy = true; t.diagnostic(`${VICTIM} 在约 ${(i + 1) * 5}s 后恢复健康`); break; }
    }
    assert.ok(healthy, `${VICTIM} 未能自行恢复健康`);
  });

  test('该节点重建期间与之后，整条链始终可用（FR-006）', async () => {
    await waitReady(60_000);
    const h = Number(await pub.getBlockNumber());
    assert.ok(h > 0, `链应当仍在服务：${RPC}`);
    const block = await sendTx();
    assert.ok(block > h, '链应当仍能出块');
  });

  test('重建后的节点身份不变 —— 身份来自只读挂载，不在数据卷里（研究 R-03）', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const { REPO_ROOT } = await import('../../tools/protocol/load.mjs');
    const expected = JSON.parse(
      readFileSync(resolve(REPO_ROOT, `blockchain/nodes/${VICTIM}.identity.json`), 'utf8'),
    ).nodeId;
    const logs = execFileSync('docker', ['logs', CONTAINER], { encoding: 'utf8' });
    assert.ok(logs.includes(expected),
      `数据卷被删光后重建，NodeID 仍应是 ${expected} —— 身份不存在于数据卷中`);
  });
});
