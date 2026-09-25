// T061 第二轮实测缺陷：工具说"这条路走不通"，然后又请人上路（2026-09-25）。
//
// ## 现场
//
// P 链按 `getHeight()-1` 验 Warp 消息，验证集合整体落后一格。工具**正确地**检测到了，
// 并且**正确地**说明了：位图按当前成员编号、链按上一格的集合验，聚合公钥对不上，
// **多收签名也过不去**，而 P 链不会自己出块，所以等也没用 —— 必须先推进一格。
//
// 然后它继续往下走：收签名、算干跑、弹出「**提交这笔 P 链交易？** [y/N]」。
//
// 一个照着提示走的人连按了三次 y：
//   ① couldn't issue tx: … unknown validator: NumIndices (7) >= NumFilteredValidators (7)
//   ② couldn't issue tx: … signature is invalid
//   ③ couldn't issue tx: … signature is invalid
//
// 三次都是必然的。**问题不在他身上** —— 工具把自己刚刚断言不可能成功的动作
// 递到了他面前。一个自己说走不通、然后又请你上路的工具，比不说话更坏：
// 不说话的话他还会去查为什么，而一个 y/N 提示暗示着"这是可以走的一步"。
//
// ## 判据
//
// 落后一格、没带 --nudge、而推进那条路可用 —— 就**到此为止**，不再往下问。
// 唯一的例外是推进本身构造不出来（拿不到 UTXO 之类）：那时拦下等于把人堵死，
// 按零容错继续仍是唯一选择，所以那一支必须放行。
//
// ## 变红检查（2026-09-25）
//
// 把 `needsNudgeFirst` 改回 `() => false`（即缺陷当时的行为：不拦、继续往下问），
// 本文件第 1、2 条立刻红：
//   AssertionError: 落后一格又没带 --nudge 时必须停下 —— 再往下问只会换来一次必然失败的 y
// 改回来即绿。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { needsNudgeFirst } from '../../tools/membership/add-validator.mjs';

describe('P 链落后一格时的闸门（needsNudgeFirst）', () => {
  test('落后 + 没带 --nudge + 能推进 → 停下', () => {
    assert.equal(
      needsNudgeFirst({ lagging: true, allowNudge: false, nudgePlanAvailable: true }),
      true,
      '落后一格又没带 --nudge 时必须停下 —— 再往下问只会换来一次必然失败的 y',
    );
  });

  test('这一条与"收几个签名"无关：签名再多也不放行', () => {
    // 这里不传签名数是**故意的** —— 判定里就不该有这个量。
    // 2026-09-17 两次实测：4/5 报权重不够、5/5 报 signature is invalid，
    // 第二条说明收满也不合法。若哪天有人给这个闸门加上"签名够了就放行"，
    // 这条注释与上一条断言一起构成反对意见。
    assert.equal(
      needsNudgeFirst({ lagging: true, allowNudge: false, nudgePlanAvailable: true }),
      true,
    );
  });

  test('带了 --nudge → 放行（它会先推进再继续）', () => {
    assert.equal(
      needsNudgeFirst({ lagging: true, allowNudge: true, nudgePlanAvailable: true }),
      false,
    );
  });

  test('没落后 → 放行', () => {
    assert.equal(
      needsNudgeFirst({ lagging: false, allowNudge: false, nudgePlanAvailable: true }),
      false,
    );
  });

  test('落后但**推进这条路本身不可用** → 放行，不能把人堵死', () => {
    // 构造推进交易失败时（拿不到 UTXO、P 链读不通…），拦下就等于没有出路。
    // 那一支工具会打印"跳过，按零容错继续"，那是当时唯一能走的路。
    assert.equal(
      needsNudgeFirst({ lagging: true, allowNudge: false, nudgePlanAvailable: false }),
      false,
      '拦截只在"有别的路可走"时成立 —— 否则是把人堵死，不是保护他',
    );
  });

  test('缺字段按假处理，不因 undefined 而误拦', () => {
    assert.equal(needsNudgeFirst({}), false);
    assert.equal(needsNudgeFirst({ lagging: true }), false, 'nudgePlanAvailable 未知时不拦');
  });
});
