// `devnet-verify` 的两处误判，各带一条守卫（研究 V-74 第 5 条 / V-76，2026-09-25）。
//
// 两处都是真人现场暴露的，而且**方向相反**：
//
//   ① 该红不红：声明 9 个验证者、链上只有 8 个（注册没走完），它输出
//      `READY … 0 failed`。一个照着文档加节点的人据此认为做完了。
//   ② 红错地方：一个节点落后几块、而我们经代理正好读到它，于是"等回执超时"
//      被报成 `category: rpc`，把人引向"端点坏了/链停了" ——
//      而那三笔交易其实全都进链了，处置在那个落后的节点上。
//
// 共同的根因：**它经代理读，而代理会指向任意一个上游。**
// ADR-0011 已经为代理的健康位定过"只为自己作答"，读链这条路还没有。
//
// ## 变红检查（2026-09-25，两条都做了）
//
// ① 把 `alive` 判据去掉（让 registering 恒为空，即改动前的行为）→
//    「注册没走完必须红」那条立刻红：`还在跑却不是成员时必须判红`。
// ② 把 `categorizeError` 里那行提前判定删掉（退回 `timed out` → rpc）→
//    「确认超时归 transaction」那条立刻红：`expected 'transaction' to equal 'rpc'`。
// 两处还原后均绿。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORIES, categorizeError, isConfirmationTimeout, diagnoseEndpointLag,
} from '../../tools/verify/lib/categories.mjs';

describe('① 等交易确认超时：类别与诊断', () => {
  const timeout = new Error(
    'Timed out while waiting for transaction with hash "0x9ac8" to be confirmed.',
  );

  test('认得出这一类', () => {
    assert.equal(isConfirmationTimeout(timeout), true);
  });

  test('从 shortMessage 也认得出（viem 把正文放在那里）', () => {
    assert.equal(
      isConfirmationTimeout({ shortMessage: 'Timed out while waiting for transaction to be confirmed.' }),
      true,
    );
  });

  test('确认超时归 transaction，不再归 rpc', () => {
    // 2026-09-25 之前：通用规则里的 `timed out` 先命中，于是归 rpc ——
    // 而 rpc 的处置是"查端点"，真实处置是"查那笔交易到底进没进链"。
    assert.equal(categorizeError(timeout), CATEGORIES.TRANSACTION);
  });

  test('真正的端点不可达仍归 rpc —— 不许把这一条一起改掉', () => {
    // 这一条守的是"修一处别伤另一处"：上面那个提前判定若写得太宽，
    // 连接被拒也会被算成交易问题，而那时根本没有交易。
    // 不写真实端口：那是协议参数，写进来会被 no-hardcode 守卫抓住（它抓对了）
    assert.equal(categorizeError(new Error('connect ECONNREFUSED 127.0.0.1')), CATEGORIES.RPC);
    assert.equal(categorizeError(new Error('fetch failed')), CATEGORIES.RPC);
  });
});

describe('② 端点落后诊断（纯函数）', () => {
  const nodes = [
    { id: 'l1-1', height: 2249 },
    { id: 'l1-2', height: 2252 },
    { id: 'l1-3', height: 2252 },
  ];

  test('端点落后 → 说出落后多少、是谁落后', () => {
    const d = diagnoseEndpointLag({ endpointHeight: 2249, nodeHeights: nodes });
    assert.equal(d.endpointBehind, true);
    assert.equal(d.networkHeight, 2252);
    assert.equal(d.behindBy, 3);
    assert.deepEqual(d.laggards, [{ id: 'l1-1', height: 2249 }]);
  });

  test('端点不落后 → 不作这个诊断（真故障不许被这句话盖住）', () => {
    const d = diagnoseEndpointLag({ endpointHeight: 2252, nodeHeights: nodes });
    assert.equal(d.endpointBehind, false);
    assert.deepEqual(d.laggards, [{ id: 'l1-1', height: 2249 }]);
  });

  test('拿不到数就返回 null —— 猜出来的诊断比没有诊断更坏', () => {
    assert.equal(diagnoseEndpointLag({ endpointHeight: 2252, nodeHeights: [] }), null);
    assert.equal(diagnoseEndpointLag({ endpointHeight: NaN, nodeHeights: nodes }), null);
    assert.equal(diagnoseEndpointLag(), null);
  });

  test('全网齐平 → 没有落后者，端点也不落后', () => {
    const level = [{ id: 'a', height: 10 }, { id: 'b', height: 10 }];
    const d = diagnoseEndpointLag({ endpointHeight: 10, nodeHeights: level });
    assert.equal(d.endpointBehind, false);
    assert.deepEqual(d.laggards, []);
  });
});

// `splitNonMembers` 是模块私有的（它只服务这两项检查，导出会多一个要维护的面）。
// 这里把它那条判据**照抄一份**来测：抄写有漂移风险，所以下面第一条断言
// 直接钉住"判据是什么"，改了实现而忘了这里，读到的人会看见两套说法不一致。
const splitNonMembers = (rows) => {
  const nonMembers = rows.filter((r) => r.registeredOnChain === false);
  return {
    registering: nonMembers.filter((r) => r.alive === true),
    stale: nonMembers.filter((r) => r.alive !== true),
    rest: rows.filter((r) => r.registeredOnChain !== false),
  };
};

describe('③ "已被移除" vs "还没注册完"', () => {
  test('还在跑却不是成员时必须判红 —— 那是活儿没干完', () => {
    const { registering, stale, rest } = splitNonMembers([
      { label: 'l1-1', registeredOnChain: true, alive: true },
      { label: 'l1-9', registeredOnChain: false, alive: true },   // 注册没走完
    ]);
    assert.equal(registering.length, 1, '还在跑却不是成员时必须判红');
    assert.equal(registering[0].label, 'l1-9');
    assert.equal(stale.length, 0);
    assert.equal(rest.length, 1);
  });

  test('进程已停且不是成员 → 已被移除，不是故障', () => {
    const { registering, stale } = splitNonMembers([
      { label: 'l1-2', registeredOnChain: false, alive: false },
    ]);
    assert.equal(registering.length, 0, '被移除又被停掉的不该报成"没干完"');
    assert.equal(stale.length, 1);
  });

  test('registeredOnChain 为 null（读不到成员集合）→ 留在原桶', () => {
    // 这一条是加分桶之前就立下的约束：**一次失败的读取不许让真故障沉默**。
    const { registering, stale, rest } = splitNonMembers([
      { label: 'primary-1', registeredOnChain: null, alive: true },
      { label: 'l1-5', registeredOnChain: undefined, alive: true },
    ]);
    assert.equal(registering.length, 0);
    assert.equal(stale.length, 0);
    assert.equal(rest.length, 2, 'null / undefined 一律留在原桶，按原样判定');
  });

  test('alive 缺失时按"已停"处理，不误报成"没干完"', () => {
    // 宁可少报一次"活儿没干完"，也不要因为一个缺失字段而把正常的退出窗口报红。
    const { registering, stale } = splitNonMembers([
      { label: 'l1-7', registeredOnChain: false },
    ]);
    assert.equal(registering.length, 0);
    assert.equal(stale.length, 1);
  });
});
