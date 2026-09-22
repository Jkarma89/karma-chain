// 「故障扩散了」这个结论必须被**求证**过（功能 005 / dod 第六节第 27 条①）。
//
// ## 这条待办的由来
//
// 2026-09-19 的 SC-003 三十分钟窗口：**30 笔交易全部确认**，而第 8 分钟
// 三台不同机器（win-2、ubuntu-1、ubuntu-2）**同时**报"不可达"一次，
// 整轮被判成「故障扩散了」。三台同时挂的概率远低于观测方抖了一下。
// dod 把待办写成一句话：**把观测做到与说法一样强，不是放宽断言。**
//
// 第一步（V-53 那轮）加了"3 秒后复核"，挡住了瞬时抖动。
// 但持续的观测方问题挡不住 —— 路径坏五秒，两次都失败，照样宣布扩散。
// 第二步就是本文件守的这一条：**向还在服务的节点求证**。
// 004 的判据本来就是两半：本机探不到 **且** 其余节点的对等列表里也没有。
//
// ## 为什么"求证不了"不算失败
//
// 「故障扩散」是很重的结论，而求证不了**不等于确认**。把不确定当成定论正是原先的毛病。
// 但"一个证人都没有"是另一回事 —— 那不是求证不了，是验证者全都不在服务，要报。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spreadProblems } from '../e2e/lib/devnet.mjs';

/** 造一行。serving 为假时 detail 取"不可达"，与真实现一致。 */
const row = (id, { serving = true, nodeId = `NodeID-${id}`, peers = [] } = {}) => ({
  id,
  domain: `dom-${id}`,
  serving,
  nodeId,
  peerNodeIds: peers,
  detail: serving ? '服务中（高度 100）' : '不可达',
});

/** 两轮都返回同一批行 —— 即"复核之后依然如此"。 */
const stable = (rows) => async () => rows;

const run = (rows, opts = {}) => {
  const notes = [];
  return spreadProblems([], '', {
    confirmAfterMs: 0, probe: stable(rows), onNote: (m) => notes.push(m), ...opts,
  }).then((failures) => ({ failures, notes }));
};

describe('求证之后才敢说「故障扩散了」', () => {
  test('证人看得见它 → 不算失败，只留诊断', async () => {
    // l1-2 探不到，但 l1-1 与 l1-3 的对等列表里都有它 —— 链里还有它。
    const { failures, notes } = await run([
      row('l1-1', { peers: ['NodeID-l1-2', 'NodeID-l1-3'] }),
      row('l1-2', { serving: false }),
      row('l1-3', { peers: ['NodeID-l1-2', 'NodeID-l1-1'] }),
    ]);
    assert.deepEqual(failures, [], '证人看得见它，就不该算失败');
    assert.equal(notes.length, 1);
    assert.match(notes[0], /看得见它/);
    assert.match(notes[0], /不是故障扩散/);
    assert.match(notes[0], /观测方到它的路径问题/);
  });

  test('证人也看不见 → 这才是故障扩散', async () => {
    const { failures, notes } = await run([
      row('l1-1', { peers: ['NodeID-l1-3'] }),
      row('l1-2', { serving: false }),
      row('l1-3', { peers: ['NodeID-l1-1'] }),
    ]);
    assert.deepEqual(notes, [], '这一路不该只留诊断');
    assert.equal(failures.length, 1);
    assert.match(failures[0], /故障扩散了/);
    assert.match(failures[0], /对等列表里\*\*也没有\*\*它/);
  });

  test('一个证人都没有 → 失败，但说的是"全部验证者都不在服务"', async () => {
    // 不是"求证不了"就放过 —— 全倒了本身就是要报的事。
    const { failures, notes } = await run([
      row('l1-1', { serving: false }),
      row('l1-2', { serving: false }),
    ]);
    assert.deepEqual(notes, []);
    assert.equal(failures.length, 2);
    for (const f of failures) {
      assert.match(f, /全部验证者都不在服务/);
      assert.doesNotMatch(f, /故障扩散了/, '没有证人时不得宣布扩散 —— 那是另一个结论');
    }
  });

  test('拿不到 NodeID → 求证不了，**不宣布**扩散', async () => {
    const { failures, notes } = await run([
      row('l1-1', { peers: ['NodeID-l1-3'] }),
      row('l1-2', { serving: false, nodeId: null }),
      row('l1-3', { peers: ['NodeID-l1-1'] }),
    ]);
    assert.deepEqual(failures, [], '求证不了不等于确认 —— 不该算失败');
    assert.equal(notes.length, 1);
    assert.match(notes[0], /求证不了/);
    assert.match(notes[0], /不据此宣布故障扩散/);
  });

  test('复核时恢复了 → 一句话都不报', async () => {
    // 第一轮 l1-2 不可达，第二轮它好了 —— 瞬时抖动，V-53 那半已经在管。
    let round = 0;
    const probe = async () => {
      round += 1;
      return round === 1
        ? [row('l1-1'), row('l1-2', { serving: false })]
        : [row('l1-1'), row('l1-2')];
    };
    const { failures, notes } = await run([], { probe });
    assert.deepEqual(failures, []);
    assert.deepEqual(notes, []);
  });

  test('有可疑对象时**确实**探了两次 —— 数调用，不看源码文本', async () => {
    // one-read-is-not-a-verdict 里那条是**文本**匹配：它只能证明"写着两次"。
    // 有了注入点就能真的数一遍 —— 这才是那条性质本身。
    let calls = 0;
    const probe = async () => {
      calls += 1;
      return [row('l1-1', { peers: ['NodeID-l1-2'] }), row('l1-2', { serving: false })];
    };
    await run([], { probe });
    assert.equal(calls, 2, '有可疑对象就必须复核一次 —— 一次抖动不作数');
  });

  test('没有可疑对象时连复核都不做', async () => {
    let calls = 0;
    const probe = async () => { calls += 1; return [row('l1-1'), row('l1-2')]; };
    const { failures } = await run([], { probe });
    assert.deepEqual(failures, []);
    assert.equal(calls, 1, '正常路径上不该产生第二次探测 —— 否则每轮都多等一次');
  });
});
