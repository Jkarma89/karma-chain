// 验证器区分「故障」与「已被移除」（功能 005 / T041 实施期发现、FR-028）。
//
// ## 缺口是怎么暴露的
//
// 2026-09-17 退掉 l1-2（四步走完 + 停进程）之后，`devnet-verify` 报 NOT READY：
//
//   [FAIL] node       l1-2 unreachable（整域缺席，**去看那台机器**）
//   [FAIL] validator  1/6 not bootstrapped
//   [OK]   fault-tolerance   5/5 validators online     ← 这一项一直是对的
//
// 而那台机器没什么可查：那个节点是**被主动移除、又被主动停掉**的。
// 面板早就分得清（`membership` 分类 + 容错按链上成员收敛），**而验证器不知道
// 「成员集合」这回事** —— FR-028 因此只做了一半。
//
// 这个窗口不是异常状态，**它是规程规定的**：先从集合移除 → 等确认 → 再停进程 →
// 最后才改声明。中间必然有一段「声明里有、链上没有」，每次退成员都会撞到。
//
// ## 本文件守的是"分桶不是放宽"
//
// 最容易写坏的方向是把它做成一次放宽 —— 那样任何 unreachable 都能靠
// "它可能不是成员"混过去。所以三条约束各有一条断言，其中第一条最重要：
// **成员集合读不到时，行为必须与加这段之前逐字相同。**
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from '../../tools/protocol/load.mjs';

const SRC = readFileSync(resolve(REPO_ROOT, 'tools/verify/checks/basic.mjs'), 'utf8');

// 判据函数没有单独导出（它是两项检查的内部细节），所以这里按**源码性质**断言。
// 这比导出一个只为测试而存在的符号更诚实：要守的正是"那两项检查确实用了它"。
describe('① 读不到成员集合时不许放过任何故障', () => {
  test('判据是 `=== false`，不是 `!== true`', () => {
    // `registeredOnChain` 是三值：true / false / null（读不到）。
    // 写成 `!== true` 会把 **null 也摘出去** —— 于是一次失败的 P 链读取
    // 会让所有 unreachable 节点集体免判，而那正是最该报的时刻。
    assert.match(SRC, /registeredOnChain === false/,
      '摘出判据必须是 `=== false`。写成 `!== true` 会连 null（读不到）一起摘掉，\n'
      + '  于是一次失败的成员集合读取变成一次全局免判 —— 真故障全部沉默。');
    assert.doesNotMatch(SRC, /registeredOnChain !== true/,
      '出现了 `!== true` —— 那会把 null 当成"不是成员"');
  });

  test('留在故障桶里的判据是 `!== false`（对称的那一半）', () => {
    assert.match(SRC, /registeredOnChain !== false/,
      '`rest` 必须用 `!== false`，与摘出判据严格互补 —— '
      + '两边都写 `=== false` / `=== true` 会让 null 既不在这边也不在那边');
  });
});

describe('② 摘出来的必须被说出来', () => {
  test('有一个专门的说明函数，且四处结论都带上它', () => {
    assert.match(SRC, /const nonMemberNote =/, '缺少那句说明的构造函数');
    // node 的两条结论（FAIL / OK）+ validator 的四条结论，一处都不能漏 ——
    // 漏掉的那处就是"静默放过"，而静默放过会掩盖一份过期的声明。
    const uses = SRC.split('nonMemberNote(nonMembers)').length - 1;
    assert.ok(uses >= 6,
      `nonMemberNote 只被用了 ${uses} 次 —— node 的 2 条结论加 validator 的 4 条，`
      + '至少 6 处。漏掉的那处就是静默放过');
  });

  test('那句话把处置指向仓库，而不是机房', () => {
    assert.match(SRC, /不是去那台机器查进程/,
      '这正是原缺陷的要害：旧文案说"去看那台机器"，而那台机器上没什么可查');
    assert.match(SRC, /清理声明|续完注册/, '要给出真正该做的事');
    assert.match(SRC, /不是故障/, 'FR-028 的原话要出现在文案里');
  });
});

describe('③ 成员集合只有一个来源', () => {
  test('验证器不自己读成员集合，而是用 node-status 已算好的字段', () => {
    // 在验证器里另读一遍会引入第二个 notion，两处必然会分歧。
    // 我第一版就是那么写的（在 verify-network.mjs 里加了一个 readChainMembers），
    // 发现 node-status 的行**本来就带** registeredOnChain 之后撤掉了。
    // **扫的是导入，不是裸名字** —— 那个名字在本文件的注释里出现过一次
    //（说明 registeredOnChain 是从哪来的）。按裸名字断言会被注释误伤，
    // 而这正是本期踩过的坑："字段名出现在注释里"让一条守卫误报过。
    const importsMemberSet = (text) => /(?:import|from)\s*\(?\s*['"][^'"]*member-set\.mjs['"]/.test(
      text.replace(/^\s*(\/\/|\*|\/\*).*$/gm, ''),
    );
    assert.equal(importsMemberSet(SRC), false,
      'tools/verify/checks/basic.mjs 不该自己导入 member-set —— '
      + 'node-status 的行已经带 registeredOnChain，那是同一个读取的结果');
    const orchestrator = readFileSync(resolve(REPO_ROOT, 'tools/verify/verify-network.mjs'), 'utf8');
    assert.equal(importsMemberSet(orchestrator), false,
      'verify-network.mjs 也不该导入 —— 同上。我第一版就是在这里加了一个 '
      + 'readChainMembers()，发现 node-status 本来就带那个字段之后撤掉了');
  });

  test('两项检查共用**同一次** nodeStatus()（它是记忆化的）', () => {
    assert.match(SRC, /nodeStatusPromise \?\?=/,
      'nodeStatus 必须记忆化 —— 否则 validator 那项会再探一遍全部节点并再读一次成员集合');
    const calls = SRC.split('await nodeStatus()').length - 1;
    assert.ok(calls >= 2, `只有 ${calls} 处调用 nodeStatus —— validator 那项也要用它取 registeredOnChain`);
  });
});

describe('④ 分母跟着摘出后的数走', () => {
  test('OK 的那句话用 results.length，不用 expected / l1.length', () => {
    // 摘掉一个之后还说 "5/6 serving" 会被读成"少了一个" —— 而那恰恰是要消除的误读。
    assert.match(SRC, /\$\{results\.length - waiting\.length\}\/\$\{results\.length\} nodes serving/,
      'node 那项的 OK 文案分母应当是摘出后的 results.length，而不是 expected —— '
      + '摘掉一个之后还说 "5/6 serving" 会被读成"少了一个"，而那恰恰是要消除的误读');
  });
});
