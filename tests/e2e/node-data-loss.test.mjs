// T043 / quickstart 场景 E（V-04）：单个节点的数据彻底损坏（FR-006、SC-011）。
//
// 判据是**故障被限制在一个节点内**：删掉它的数据卷，其余节点与整条链毫不受影响，
// 该节点从对等节点重新同步后自行归队 —— 全程不需要全链重置。
//
// 这条性质的实现基础是「卷即故障单元」：每个节点独占一个数据卷，且身份不在卷里
// （staking 材料由仓库只读挂载，研究 R-03），所以卷删光了 NodeID 依然不变。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  pub, sendTx, sh, devnetAvailable, VALIDATOR_IDS, pickLocalVictims, localVictimSkip, spreadProblems,
} from './lib/devnet.mjs';
import { REPO_ROOT } from '../../tools/protocol/load.mjs';

// 靶子必须是**本机真的有容器**的验证者 —— docker 只能操作本机。
// 原先按下标从全局列表里挑（单机形态下 7 个容器都在本机，那样写没问题），
// 跨机形态下会因为那个节点在别的机器上而失败。挑不到就跳过并说明原因。
const LOCAL = pickLocalVictims(1);
const VICTIM = LOCAL?.[0];
const CONTAINER = `karmachain-${VICTIM}`;
const VOLUME = `karmachain-${VICTIM}-data`;
const node = (...args) => sh('sh', ['scripts/devnet-node.sh', ...args]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inspect = (fmt) => {
  try { return execFileSync('docker', ['inspect', '--format', fmt, CONTAINER], { encoding: 'utf8' }).trim(); } catch { return ''; }
};
const expectedNodeId = () => JSON.parse(
  readFileSync(resolve(REPO_ROOT, `blockchain/nodes/${VICTIM}.identity.json`), 'utf8'),
).nodeId;

describe('场景 E —— 单节点数据损坏，故障不外溢',
  { skip: LOCAL ? undefined : localVictimSkip(1), concurrency: 1 }, () => {
  let heightAtWipe;

  before(async () => {
    if (!await devnetAvailable()) throw new Error('开发网不可用 —— 先运行 scripts/devnet-start.sh');
  });

  after(() => { try { node('start', VICTIM); } catch { /* ignore */ } });

  test(`删除 ${VICTIM} 的数据卷，其余节点不受影响`, async (t) => {
    heightAtWipe = await sendTx();
    node('wipe', VICTIM);
    t.diagnostic(`${VICTIM} 的数据卷已删除（高度 ${heightAtWipe}）`);

    const volumes = execFileSync('docker', ['volume', 'ls', '--format', '{{.Name}}'], { encoding: 'utf8' });
    assert.ok(!volumes.split(/\r?\n/).includes(VOLUME), `${VOLUME} 应当已不存在`);

    // "故障没扩散"的判据是**其余验证者是否仍在服务 L1**（网络层探测），
    // 不是"它的容器是否 running" —— 跨机形态下别的验证者在别的机器上，
    // 本机 docker inspect 返回 missing，那样写会把"看不见"当成"挂了"（2026-09-09 实测）。
    const spread = await spreadProblems([VICTIM]);
    assert.deepEqual(spread, [], `其余验证者应当不受影响：\n  ${spread.join('\n  ')}`);
  });

  test('该节点缺席期间，链照常出块 —— 无需全链重置（SC-011）', async () => {
    const before = Number(await pub.getBlockNumber());
    const height = await sendTx();
    assert.ok(height > before, `链应当继续出块：${before} -> ${height}`);
  });

  test(`${VICTIM} 从空卷启动后由对等节点补齐，自行恢复健康`, async (t) => {
    node('start', VICTIM);
    const t0 = Date.now();
    let healthy = false;
    for (let i = 0; i < 90; i += 1) {
      await sleep(3000);
      if (inspect('{{.State.Status}}') === 'exited') {
        const code = inspect('{{.State.ExitCode}}');
        assert.fail(`${VICTIM} 以退出码 ${code} 结束 —— 空卷不应导致启动失败`);
      }
      if (inspect('{{if .State.Health}}{{.State.Health.Status}}{{end}}') === 'healthy') { healthy = true; break; }
    }
    assert.ok(healthy, `${VICTIM} 未能从空卷恢复`);
    t.diagnostic(`${VICTIM} 在 ${Math.round((Date.now() - t0) / 1000)}s 后重新同步完毕`);
  });

  test('重建后 NodeID 不变 —— 身份不存在于数据卷中（研究 R-03）', () => {
    const want = expectedNodeId();
    const logs = execFileSync('docker', ['logs', CONTAINER], { encoding: 'utf8' });
    assert.ok(logs.includes(want), `卷删光后 NodeID 仍应是 ${want}`);
    assert.match(logs, /identity OK/, '启动期身份校验应当通过');
  });

  test('重建后的节点补齐了它缺席期间的区块', async () => {
    const height = Number(await pub.getBlockNumber());
    assert.ok(height >= heightAtWipe, `链高度不得回退：删卷时 ${heightAtWipe}，现在 ${height}`);
    const block = await sendTx();
    assert.ok(block > height, '全员归队后链应当照常出块');
  });
});
