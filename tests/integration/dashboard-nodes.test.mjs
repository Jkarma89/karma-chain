// T036 / T037 —— 节点与故障边界必须与 protocol.json 逐项一致（功能 003 / SC-009、FR-001…003）。
//
// 面板内**零硬编码**：节点数、节点 ID、角色、地址、边界划分全部由
// `blockchain/protocol.json` 经 `deriveTopology()` 派生（宪法第十六条）。
//
// T037 那一条尤其要紧：把 `topology.activeDeployment` 从 `lan` 切到 `local` 之后，
// 面板必须**无需改代码**就正确显示 1 个边界 / 7 个节点（FR-003）。
// 002 在类似的地方踩过两次（`--network karmachain` 写死在单机形态的网络名上），
// 这一条就是那个教训的守卫。
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadContext } from '../../tools/dashboard/poll.mjs';
import { REPO_ROOT } from '../../tools/protocol/load.mjs';

const protocol = JSON.parse(readFileSync(resolve(REPO_ROOT, 'blockchain/protocol.json'), 'utf8'));

describe('活动形态（lan）的节点与边界', () => {
  let ctx;
  before(() => { ctx = loadContext(); });

  test('节点数、ID 与角色逐项等于 topology.nodes', () => {
    const declared = protocol.topology.nodes;
    assert.equal(ctx.nodes.length, declared.length,
      `面板显示 ${ctx.nodes.length} 个节点，声明是 ${declared.length} 个`);
    assert.deepEqual(
      ctx.nodes.map((n) => [n.id, n.role]).sort(),
      declared.map((n) => [n.id, n.role]).sort(),
    );
  });

  test('边界数与各边界地址逐项等于 failureDomains', () => {
    const deployment = protocol.topology.deployments[protocol.topology.activeDeployment];
    assert.equal(ctx.domains.length, deployment.failureDomains.length);
    for (const d of deployment.failureDomains) {
      const got = ctx.domains.find((x) => x.id === d.id);
      assert.ok(got, `缺边界 ${d.id}`);
      assert.equal(got.address, d.address, `边界 ${d.id} 的地址不一致`);
    }
  });

  test('每个节点归属的边界与声明一致', () => {
    const deployment = protocol.topology.deployments[protocol.topology.activeDeployment];
    const declaredDomain = new Map();
    for (const d of deployment.failureDomains) for (const id of d.nodes) declaredDomain.set(id, d.id);
    for (const n of ctx.nodes) {
      assert.equal(n.domain, declaredDomain.get(n.id), `${n.id} 的边界归属不一致`);
    }
  });

  test('容错上限来自 faultTolerance() 的派生，不是面板自己算的', () => {
    // f ≤ ⌊n/4⌋（001 研究 R-05）。面板只消费这个结果。
    const n = ctx.faultTolerance.validatorCount;
    assert.equal(ctx.faultTolerance.maxOfflineValidators, Math.floor(n / 4),
      `f 应当是 ⌊${n}/4⌋ —— 若不等，说明面板或 load.mjs 有一方在自己算`);
  });

  test('对外公布的 RPC 端口与路径取自 endpoints，不写死', () => {
    assert.equal(ctx.publishedRpcPort, protocol.endpoints.hostRpcPort);
    assert.equal(ctx.chain.rpcPath, protocol.endpoints.rpcPath);
    assert.deepEqual(ctx.chain.publishedHosts, protocol.endpoints.publishedHosts);
  });

  test('publishedHosts 不含私网地址 —— 面板不得把它替换成 failureDomains 的地址', () => {
    // 既有 tests/unit/public-artifacts.test.mjs 已守着 protocol.json 这一侧；
    // 这里守面板这一侧：公开投影要用的就是它，一旦被替换就会泄漏局域网地址。
    for (const h of ctx.chain.publishedHosts) {
      assert.doesNotMatch(h, /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/,
        `publishedHosts 里出现私网地址 ${h}`);
    }
  });
});

describe('切换部署形态无需改代码（FR-003 / SC-009 后半）', () => {
  const other = Object.keys(protocol.topology.deployments)
    .find((k) => k !== protocol.topology.activeDeployment);

  test('存在另一个形态可切 —— 否则本组测试在空转', () => {
    assert.ok(other, `topology.deployments 里只有一个形态，无法验证 FR-003`);
  });

  test(`切到 ${other} 形态后，边界与节点分布随之改变`, () => {
    const ctx = loadContext({ deployment: other });
    const declared = protocol.topology.deployments[other];
    assert.equal(ctx.deployment, other);
    assert.equal(ctx.domains.length, declared.failureDomains.length,
      `${other} 形态应当有 ${declared.failureDomains.length} 个边界`);
    // 节点总数不变（同一批节点，换一种摆法），但边界数变了
    assert.equal(ctx.nodes.length, protocol.topology.nodes.length);
    assert.notEqual(ctx.domains.length, loadContext().domains.length,
      '两个形态的边界数应当不同，否则这条对比没有意义');
  });

  test(`${other} 形态下容错上限的派生仍成立`, () => {
    const ctx = loadContext({ deployment: other });
    const n = ctx.faultTolerance.validatorCount;
    assert.equal(ctx.faultTolerance.maxOfflineValidators, Math.floor(n / 4));
    // 单边界形态不做整机失效承诺 —— maxValidatorsPerDomain 等于 n
    if (ctx.domains.length === 1) {
      assert.equal(ctx.faultTolerance.maxValidatorsPerDomain, n,
        '单边界形态下每边界上限即全部验证者（既有 faultTolerance 的语义）');
    }
  });

  test('切形态**不**改动仓库里的任何文件 —— 只是换一个入参', () => {
    const before = readFileSync(resolve(REPO_ROOT, 'blockchain/protocol.json'), 'utf8');
    loadContext({ deployment: other });
    loadContext();
    assert.equal(readFileSync(resolve(REPO_ROOT, 'blockchain/protocol.json'), 'utf8'), before,
      'loadContext 必须是只读的');
  });
});
