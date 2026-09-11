// T051 —— 面板的边界判定必须与既有 `devnet-topology` 一致（功能 003 / US4）。
//
// ## 为什么要交叉校验而不是各算一遍
//
// `scripts/devnet-topology` 已经在做边界并查集与 T-5 判定，输出那句
// 「每边界至多 N 个验证者 → 可容忍 1 个边界整体失效 [OK]」。
// 面板若自己算一套，两者漂移的那天不会有任何东西报错 —— 而漂移的方向大概率是
// 面板更乐观（少考虑了共享失效因素），也就是 `load.mjs:259` 注释里那个
// 「在现实里为假的绿灯」。
//
// 所以两边都从 `faultTolerance()` 取同一个 `effectiveDomains`，本文件守住这一点。
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadContext } from '../../tools/dashboard/poll.mjs';
import { deriveTier } from '../../tools/dashboard/snapshot.mjs';
import { loadProtocol, deriveTopology, REPO_ROOT } from '../../tools/protocol/load.mjs';

const protocol = loadProtocol();   // 功能 005：合并视图（topology 已在 deployment.json）

describe('面板与 load.mjs 的容错视图是同一个对象', () => {
  let ctx; let fromLoad;
  before(() => {
    ctx = loadContext();
    fromLoad = deriveTopology(loadProtocol()).faultTolerance;
  });

  test('faultTolerance 的每一项都逐字相同 —— 面板不自己算', () => {
    assert.deepEqual(ctx.faultTolerance, fromLoad,
      '面板必须原样消费 faultTolerance()，不得重算任何一项');
  });

  test('effectiveDomains 是并查集之后的分组，不是声明的 failureDomains', () => {
    const declared = protocol.topology.deployments[protocol.topology.activeDeployment].failureDomains;
    const eff = ctx.faultTolerance.effectiveDomains;
    // 当前 lan 形态无共享失效因素，两者数量相等；但结构必须是"组"而非"边界"
    for (const g of eff) {
      assert.ok(Array.isArray(g.ids), '有效边界是一组 id，不是单个 id');
      assert.equal(typeof g.validators, 'number');
      assert.ok(Array.isArray(g.factors), '要带上把它们合并起来的共享因素');
    }
    const idsInGroups = eff.flatMap((g) => g.ids).sort();
    assert.deepEqual(idsInGroups, declared.map((d) => d.id).sort(),
      '每个声明的边界都必须恰好出现在一个有效分组里');
  });

  test('T-5 判定与既有 tolerateWholeDomainLoss 一致', () => {
    const ft = ctx.faultTolerance;
    const worst = Math.max(...ft.effectiveDomains.map((g) => g.validators));
    const expected = ft.effectiveDomainCount > 1 && worst <= ft.maxOfflineValidators;
    assert.equal(ft.tolerateWholeDomainLoss, expected,
      `最大有效边界承载 ${worst} 个验证者，上限 ${ft.maxOfflineValidators}`);
  });
});

describe('边界余量与 tolerateWholeDomainLoss 的关系自洽', () => {
  let ctx;
  before(() => { ctx = loadContext(); });

  const allHealthy = (n) => Array.from({ length: n }, (_, i) => ({
    id: `l1-${i + 1}`, role: 'l1-validator', state: 'healthy',
    countsTowardTolerance: true, countsAsOffline: false,
  }));

  test('满员时：tolerateWholeDomainLoss 为真 ⟺ 边界余量 ≥ 1', () => {
    const got = deriveTier({
      rows: allHealthy(ctx.faultTolerance.validatorCount),
      faultTolerance: ctx.faultTolerance,
      observer: { reachableNodes: ctx.nodes.length, totalNodes: ctx.nodes.length, blind: false, pathAlive: [] },
    });
    assert.equal(
      got.domainMargin >= 1,
      ctx.faultTolerance.tolerateWholeDomainLoss,
      `边界余量 ${got.domainMargin} 与 tolerateWholeDomainLoss=${ctx.faultTolerance.tolerateWholeDomainLoss} 不自洽`,
    );
  });

  test('当前 lan 形态：验证者余量与边界余量都应当是 1', () => {
    const got = deriveTier({
      rows: allHealthy(ctx.faultTolerance.validatorCount),
      faultTolerance: ctx.faultTolerance,
      observer: { reachableNodes: ctx.nodes.length, totalNodes: ctx.nodes.length, blind: false, pathAlive: [] },
    });
    assert.equal(got.validatorMargin, ctx.faultTolerance.maxOfflineValidators);
    assert.equal(got.domainMargin, 1,
      '5 台各 1 个验证者、f=1 → 可容忍 1 个边界整体失效（与 devnet-topology 的 [OK] 一致）');
  });

  test('单边界形态：边界余量为 0，且这不算违规', () => {
    const other = Object.keys(protocol.topology.deployments)
      .find((k) => protocol.topology.deployments[k].failureDomains.length === 1);
    if (!other) return;                       // 没有单边界形态可测
    const single = loadContext({ deployment: other });
    const got = deriveTier({
      rows: allHealthy(single.faultTolerance.validatorCount),
      faultTolerance: single.faultTolerance,
      observer: { reachableNodes: single.nodes.length, totalNodes: single.nodes.length, blind: false, pathAlive: [] },
    });
    assert.equal(got.domainMargin, 0, '该形态不做整机失效容错承诺');
    assert.equal(single.faultTolerance.tolerateWholeDomainLoss, false);
    // 但验证者级余量仍然成立 —— 两个余量是两件事
    assert.equal(got.validatorMargin, single.faultTolerance.maxOfflineValidators);
  });
});
