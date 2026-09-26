// `primaryNetwork.alsoValidatedBy` 里的节点**不得**带 partial-sync（功能 005 / US4 / F-7）。
//
// ## 为什么这条必须是自动化的
//
// avalanchego 对「既是 Primary 网络验证者、又开着 partial sync」的节点是**启动即致命**：
//
//     partial sync should not be configured for a validator
//
// 由此得出一条顺序约束（研究 R-07a 实测）：必须**先**去掉这个标志并重建、
// **再**把它加进 P 链验证者集合。而加进集合那一步走的是 `AddPermissionlessValidatorTx`，
// **质押 24 小时不可逆**（`minStakeDuration = 86400s`，P 链没有提前解除质押的交易）。
//
// 所以这两者一旦不一致，**代价要到 24 小时不可逆之后、那个节点下次重启时才现形**。
// 这不是"跑一跑就能发现"的那类错误 —— 它必须在渲染阶段就被挡住。
//
// ## 三条判据
//
//   ① 名单里的：不得有 partial-sync
//   ② 不在名单里的 L1 验证者：必须仍然有（**不是放宽，是分桶**）
//   ③ 空名单：渲染结果与"没有这个字段"逐字节相同 —— 机制必须是惰性的
//
// ## 变红检查（2026-09-26）
//
// 把渲染器那一支改回无条件 `flags['partial-sync-primary-network'] = 'true'` →
// 第 ① 条立刻红（`l1-1 兼任 P 链验证者，却仍带着 partial-sync-primary-network`）。
// 再把它改成无条件**不设** → 第 ② 条红。两次还原后均绿。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT, loadProtocol, validateConstraints } from '../../tools/protocol/load.mjs';
import { renderNodeFlags } from '../../tools/protocol/render-node-flags.mjs';

const FLAG = 'partial-sync-primary-network';

/** 拿一份把 alsoValidatedBy 换成 `ids` 的协议视图 —— 不落盘，只在内存里改。 */
const withDualRole = (ids) => {
  const p = loadProtocol();
  return { ...p, primaryNetwork: { ...p.primaryNetwork, alsoValidatedBy: ids } };
};

const l1Ids = loadProtocol().topology.nodes
  .filter((n) => n.role === 'l1-validator').map((n) => n.id);

describe('兼任 Primary 网络验证者的节点不得开 partial sync', () => {
  test('前提：确实有 L1 验证者', () => {
    assert.ok(l1Ids.length >= 2, `只解出 ${l1Ids.length} 个 L1 验证者 —— 夹具或声明变了`);
  });

  // 2026-09-26：原先这里断言"当前声明里名单是空的"。F-7 落地之后它当然不成立了，
  // 而**把它删掉了事就等于少了一条**。换成一条更强的：
  // **声明里列了谁，落盘的 flags 就必须与之一致。**
  //
  // 上面几条比的都是"渲染器在内存里给出什么"，而节点真正读的是
  // `blockchain/nodes/<形态>/<id>.flags.json` 那份文件。漂移测试保证它们是渲染出来的，
  // 这一条保证**渲染的依据（声明）与结果（文件）说的是同一件事** ——
  // 手改一份 flags.json 就会在这里红，而那种手改正是 24 小时之后才现形的那类错误。
  test('声明里的名单与落盘的 flags 一致（两个形态都查）', () => {
    const declared = JSON.parse(readFileSync(resolve(REPO_ROOT, 'blockchain/deployment.json'), 'utf8'));
    const listed = new Set(declared.primaryNetwork.alsoValidatedBy ?? []);
    const bad = [];
    for (const deployment of ['lan', 'local']) {
      for (const id of l1Ids) {
        const f = JSON.parse(readFileSync(
          resolve(REPO_ROOT, `blockchain/nodes/${deployment}/${id}.flags.json`), 'utf8'));
        const has = f[FLAG] !== undefined;
        if (listed.has(id) && has) bad.push(`${deployment}/${id}：列在名单里却仍带着 ${FLAG}`);
        if (!listed.has(id) && !has) bad.push(`${deployment}/${id}：不在名单里却没有 ${FLAG}`);
      }
    }
    assert.deepEqual(bad, [],
      '声明与落盘的 flags 不一致 —— 节点读的是文件，而人看的是声明；'
      + '两者分叉时，代价要到那个节点下次重启才现形，而那时质押已经锁死 24 小时');
  });

  test('① 名单里的节点不得带 partial-sync', () => {
    const target = l1Ids[0];
    const flags = renderNodeFlags(withDualRole([target]), undefined, 'lan');
    assert.equal(flags[target][FLAG], undefined,
      `${target} 兼任 P 链验证者，却仍带着 ${FLAG} —— 它下次启动会直接致命退出，`
      + '而那时质押已经锁死 24 小时');
  });

  test('② 不在名单里的 L1 验证者必须仍然带着它', () => {
    const target = l1Ids[0];
    const flags = renderNodeFlags(withDualRole([target]), undefined, 'lan');
    for (const id of l1Ids.slice(1)) {
      assert.equal(flags[id][FLAG], 'true',
        `${id} 不在兼任名单里，却被摘掉了 ${FLAG} —— 这是放宽，不是分桶：`
        + '它会白白全量同步主网络，而那正是 partial sync 要省下的东西');
    }
  });

  test('③ 空名单时，渲染结果与"没有这个字段"逐字节相同', () => {
    // 机制必须是**惰性**的：没启用 F-7 之前，它不许改动任何一份 flags.json。
    // 2026-09-26 落地时就是靠这一条确认的 —— `npm run render` 之后
    // blockchain/nodes/ 下零差异。
    const p = loadProtocol();
    const withField = renderNodeFlags({ ...p, primaryNetwork: { ...p.primaryNetwork, alsoValidatedBy: [] } }, undefined, 'lan');
    const without = renderNodeFlags({ ...p, primaryNetwork: { nodeCount: p.primaryNetwork.nodeCount } }, undefined, 'lan');
    assert.equal(JSON.stringify(withField), JSON.stringify(without),
      '空名单改变了渲染结果 —— 这个机制不该在没启用时动任何东西');
  });

  test('④ 名单里写了不存在的节点 id → 加载时就失败', () => {
    // 拼写错误不会有任何可见后果：渲染器查不到、照旧给那个节点设上 partial-sync，
    // 而人以为已经把它摘出来了。要到 24 小时不可逆之后才现形，所以必须在这里挡住。
    //
    // 断言打在 `validateConstraints` 上，而不是 `renderNodeFlags` 上：
    // 校验属于**加载**，渲染器接的是已经加载好的对象。第一版写成断言渲染器会抛，
    // 于是红了 —— 红得对：那说明我把断言打在了一个根本不做这件事的地方。
    // 真实路径（`npm run render` → `loadProtocol()`）是过这一关的。
    // `validateConstraints` **收集**错误后返回数组，不抛 —— 第二版写成 assert.throws
    // 又红了一次。同一个毛病犯了两遍：**断言写在我以为的行为上，而不是它实际的行为上。**
    const errs = validateConstraints(withDualRole(['l1-does-not-exist']));
    assert.ok(errs.some((e) => /alsoValidatedBy/.test(e)),
      `名单里的未知节点 id 必须在加载阶段被拒，而不是静默忽略。实际收到：${JSON.stringify(errs)}`);
    // 反向：合法 id 不许被拦（否则这条闸门等于把 F-7 堵死）
    assert.deepEqual(
      validateConstraints(withDualRole([l1Ids[0]])).filter((e) => /alsoValidatedBy/.test(e)),
      [], '合法的兼任节点被拦下了 —— 这条闸门会把 F-7 堵死');
  });
});
