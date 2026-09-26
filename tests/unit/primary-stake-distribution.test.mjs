// 「掉任意一台机器之后还剩多少权益」—— 按**机器**算，不按持有者算（功能 005 / US4）。
//
// ## 为什么这条必须是自动化的
//
// P 链引导要求连上 ≥80% 的权益（004 的 V-08 实测：50% 失败、100% 成功）。
// F-7 的整个价值就是把这个数推过 80%，而**判断它有没有推过去的那段算术，
// 正是最容易算错的地方** —— 算错的代价是 4 笔各 100 万 AVAX、24 小时不可逆的质押，
// 换来一个以为达成、实际没达成的结论。
//
// ## 按机器算，不按持有者算
//
// 本部署的失效单位是**机器**（ADR-0007 的由来），而 ubuntu-1 / ubuntu-2
// 各同时承载一个 Primary 和一个 L1 验证者。按持有者算会给出一个
// **在现实里为假的绿灯**：8 个等权持有者看着满足「掉任意 1 个 ≥80%」，
// 而那两台机器各握 25%，掉一台就剩 75%。
// T044 当初正是因此否掉了"让全部 6 个 L1 验证者都兼任"那个写法。
//
// ## 变红检查（2026-09-26）
//
// 把 `worstCaseAfterDomainLoss` 里的分组键从 `h.domain` 改成 `h.nodeID`
//（即退回"按持有者算"）→ 第 ③ 条立刻红：两台各握两份的那个夹具会报出
// 剩 87.5% 而不是 75%。改回即绿。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { worstCaseAfterDomainLoss, BOOTSTRAP_QUORUM_PERCENT } from '../../tools/membership/add-primary-validator.mjs';

const holder = (domain, avax) => ({ domain, weight: BigInt(avax) * 1_000_000_000n });

describe('掉一台机器之后的剩余权益', () => {
  test('① 今天的形态：2 个持有者各 50% —— 掉一台剩 50%，不够', () => {
    const r = worstCaseAfterDomainLoss([holder('ubuntu-1', 1e6), holder('ubuntu-2', 1e6)]);
    assert.equal(r.worstShare, 50);
    assert.equal(r.remainingPercent, 50);
    assert.ok(r.remainingPercent < BOOTSTRAP_QUORUM_PERCENT, '50% 必须判为不够 —— 这正是 F-7 要解决的处境');
  });

  test('② F-7 做完的形态：6 个持有者各 16.67%，每台一个 —— 掉一台剩 83.33%，够', () => {
    const six = ['ubuntu-1', 'ubuntu-2', 'ubuntu-3', 'ubuntu-4', 'ubuntu-5', 'ubuntu-6']
      .map((d) => holder(d, 1e6));
    const r = worstCaseAfterDomainLoss(six);
    assert.equal(r.worstShare, 16.66);      // 1/6，两位小数截断
    assert.equal(r.remainingPercent, 83.33);
    assert.ok(r.remainingPercent >= BOOTSTRAP_QUORUM_PERCENT);
  });

  test('③ **按机器算**：两台各握两份时，剩的是 75% 而不是 87.5%', () => {
    // T044 否掉的那个写法：让全部 L1 验证者都兼任，而 ubuntu-1/ubuntu-2
    // 各同时承载一个 Primary 和一个 L1 验证者。
    // 8 个等权持有者，按**持有者**算掉 1 个剩 87.5%（看着够）；
    // 按**机器**算掉 ubuntu-1 就剩 75%（不够）。后者才是真的。
    const eight = [
      holder('ubuntu-1', 1e6), holder('ubuntu-1', 1e6),   // primary-1 + l1-3
      holder('ubuntu-2', 1e6), holder('ubuntu-2', 1e6),   // primary-2 + l1-4
      holder('ubuntu-3', 1e6), holder('ubuntu-4', 1e6),
      holder('ubuntu-5', 1e6), holder('ubuntu-6', 1e6),
    ];
    const r = worstCaseAfterDomainLoss(eight);
    assert.equal(r.worstShare, 25, '两台各握两份 ⇒ 最差的那台占 25%');
    assert.equal(r.remainingPercent, 75,
      '按持有者算会得出 87.5% —— 那是一个在现实里为假的绿灯');
    assert.ok(r.remainingPercent < BOOTSTRAP_QUORUM_PERCENT);
  });

  test('④ 权重不等时照实算，不假设等权', () => {
    // 等权是 ⌊n/4⌋ 那套推导的前提，但这个函数不依赖它 —— 它按实际权重算。
    const r = worstCaseAfterDomainLoss([
      holder('a', 9e6), holder('b', 1e6), holder('c', 1e6),
    ]);
    assert.equal(r.worstDomain, 'a');
    assert.equal(r.worstShare, 81.81);
    assert.equal(r.remainingPercent, 18.18);
  });

  test('⑤ 空输入 / 零总权重 → null，不作答', () => {
    // 拿不到数就不给结论。一个猜出来的百分比会被当成判据用。
    assert.equal(worstCaseAfterDomainLoss([]), null);
    assert.equal(worstCaseAfterDomainLoss(), null);
    assert.equal(worstCaseAfterDomainLoss([holder('a', 0)]), null);
  });

  test('⑥ 恰好 80% 的那条线：≥ 判为够，79.99 判为不够', () => {
    // 5 个等权持有者、每台一个 ⇒ 掉一台剩恰好 80%。
    // T044 记过一句"不要把拓扑设计在恰好 80% 上"，那是**选型**上的告诫；
    // 这个函数按判据如实作答，不替人把线挪走。
    const five = ['a', 'b', 'c', 'd', 'e'].map((x) => holder(x, 1e6));
    const r = worstCaseAfterDomainLoss(five);
    assert.equal(r.remainingPercent, 80);
    assert.ok(r.remainingPercent >= BOOTSTRAP_QUORUM_PERCENT, '恰好 80% 按判据是够的');
  });
});
