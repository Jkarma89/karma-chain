// T023 / T024 —— 面板在 10 秒内发现验证者离线（功能 003 / SC-002、SC-004、SC-010）。
//
// ## 本文件的要点：面板所报必须与链的**真实**出块能力一致
//
// 光断言"面板显示某个百分比"是不够的 —— 一个恒返回那个数的实现也能过。所以每个档位都
// **同时**用一笔真实交易验证链的实际行为：
//
//   - `zero-margin`（(n-1)/n）→ 交易**能**确认。这是 FR-008 的判据：链仍在正常出块
//   - 恢复过程中的 `catching-up` → 档位**不变**（FR-011 / SC-010）
//
// `stopped` 档需要停 ⌊n/4⌋+1 个验证者，而 T-5 保证每台机器至多 ⌊n/4⌋ 个 ——
// 那一条在 `dashboard-stopped-tier.test.mjs`（跨机形态下带说明跳过）。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  pub, sendTx, sh, devnetAvailable, pickLocalVictims, localVictimSkip, validatorsServing,
  script,
  SHELL_SKIP,
  restoreOrReport,
 acquireDestructiveLock,
} from './lib/devnet.mjs';
import { maxOffline } from '../../tools/membership/tolerance.mjs';
import { startDashboard, waitForSnapshot, waitFirstPoll } from './lib/dashboard.mjs';

const node = (...args) => script('devnet-node.sh', ...args);

// `localVictimSkip` 只**生成跳过说明**，判定要靠 `pickLocalVictims` 是否返回 null。
// （2026-09-10 踩过：直接把前者当判定用，于是本文件在靶子充足时也恒跳过。）
const SKIP = !(await devnetAvailable())
  ? '开发网未运行 —— 先 scripts/devnet-start'
  : (pickLocalVictims(1) ? undefined : localVictimSkip(1));

// **没有可用的 POSIX shell 时整套跳过**（研究 V-44）。
// 本套件会改变系统状态，而恢复走 `scripts/devnet-*.sh` —— 跑不了那些脚本就收不了场。
// 毁坏走 docker（总能跑）而恢复走 sh（可能起不来）的那处不对称，
// 2026-09-18 真的把 win-1 的 l1-1 与代理留在了停止状态。
const SUITE_LABEL = 'dashboard-detection';
describe('面板 —— 10 秒内发现验证者离线', { skip: SKIP ?? SHELL_SKIP, concurrency: 1 }, () => {
  // **兜底恢复。** 断言在毁坏之后、恢复之前抛出时，旧写法会把节点留在停止状态 ——
  // 而报出来的是"断言失败"，不是"我改了什么"。`after` 无论成败都跑。
  // 它自己不抛（见 restoreOrReport）：在 after 里抛会盖掉真正的失败原因。
  after(() => restoreOrReport(SUITE_LABEL));
  // **破坏性套件必须串行**（研究 V-44）。`--test-concurrency=1` 只保证一次运行内
  // 文件串行，挡不住"两次运行同时打同一条链" —— 2026-09-19 我就是那么干的。
  // 一条只写在文档里的规矩，不会在有人违反时变红。
  before(() => acquireDestructiveLock(SUITE_LABEL));
  let dash;
  let victim;
  /** 在服务的验证者数 —— 第一条用例测出来，后面几条按它算期望值 */
  let served;

  before(async () => {
    dash = await startDashboard();
    await waitFirstPoll(dash);
    [victim] = pickLocalVictims(1);
  });

  after(async () => {
    // 无论断言成败都放回去 —— 别把链留在缺一个验证者的状态
    try { node('start', victim); } catch { /* 交给下一次 devnet-start */ }
    await dash?.stop();
  });

  test('前置：满员时 100% / normal / 余量 = ⌊n/4⌋（SC-001）', async (t) => {
    // n 由**独立探测**得到，不取面板自己的数字 —— 否则这是在用面板验证面板。
    // 2026-09-16 加了第六个验证者之后，写死的 80% 当场失效（5/6 = 83%）；
    // 那正是本特性预言的「成员变化后 003/004 的判据要跟着动」。
    served = (await validatorsServing()).length;
    assert.ok(served >= 2, `只探到 ${served} 个在服务的验证者，构造不出"停一个"的场景`);
    const f = maxOffline(served);
    t.diagnostic(`在服务的验证者 ${served} 个，⌊n/4⌋ = ${f}`);

    const { snapshot: s } = await waitForSnapshot(dash, (x) => x.tier === 'normal', { label: '满员 normal' });
    assert.equal(s.healthPercent, 100);
    assert.equal(s.tier, 'normal');
    assert.equal(s.validatorMargin, f, `还可容忍 ${f} 个离线`);
    assert.equal(s.domainMargin, f, '边界级余量同为 ⌊n/4⌋');
    assert.equal(s.observer.blind, false);
    assert.equal(s.chainIdentity.forkDetected, false, '五台创世应当一致');
  });

  test('停 1 个验证者 → ≤10 秒内 (n-1)/n / zero-margin，且链仍能确认交易（SC-002）', async (t) => {
    // 停**一个**能落到 zero-margin，前提是 ⌊n/4⌋ = 1。n 到 8 时上限变 2，
    // 停一个只会把余量从 2 降到 1，档位仍是 normal —— 下面的 waitForSnapshot
    // 会一直等不到而超时，那种失败读起来像面板坏了，其实是用例的前提不再成立。
    // 所以先把前提说出来。
    assert.equal(maxOffline(served), 1,
      `现在 n = ${served}，⌊n/4⌋ = ${maxOffline(served)} —— 停 1 个不再是"用尽余量"。`
      + ' 本用例要改成停 ⌊n/4⌋ 个，或把这一档交给 dashboard-stopped-tier 那套跨机构造。');

    const before = Number(await pub.getBlockNumber());
    node('kill', victim);

    const { snapshot: s, elapsedMs, samples } = await waitForSnapshot(
      dash, (x) => x.tier === 'zero-margin', { label: 'zero-margin' },
    );
    t.diagnostic(`档位序列：${samples.map((x) => `${x.at}ms:${x.tier}/${x.healthPercent}%`).join(' → ')}`);
    t.diagnostic(`发现时延 ${elapsedMs} ms`);

    assert.ok(elapsedMs <= 10_000,
      `发现时延 ${elapsedMs} ms 超过 10 秒（FR-018 / SC-002）`);
    // 期望值当场算出来，而不是抄一个 n=5 时代的常数。
    // 面板那边也是算的（deriveTier 的"零字面阈值"），两边各算一次才有交叉验证的意义。
    const expected = Math.round(((served - 1) / served) * 100);
    assert.equal(s.healthPercent, expected,
      `停 1 个之后应为 ${served - 1}/${served} = ${expected}%`);
    assert.equal(s.validatorMargin, 0, '余量已用尽');
    assert.equal(s.participating, s.threshold, '参与数恰好等于查询门槛');

    // **这一半才是本用例的意义所在**：面板说"仍在出块"，就必须真的能出块。
    const height = await sendTx();
    assert.ok(height > before,
      `zero-margin 档下链必须仍在出块：${before} -> ${height}。`
      + '若这里失败，说明 80% 那一档的文案在骗人');
    t.diagnostic(`链仍在出块：${before} → ${height}`);

    // 该节点必须被归入"须处置"的一类，而不是"要等"
    const row = s.nodes.find((n) => n.id === victim);
    assert.equal(row.participatesInConsensus, false);
    assert.equal(row.incidentClass, 'node-infra', `${victim} 的异常分类应指向"去那台机器"`);
    assert.ok(
      s.incidents.some((i) => i.class === 'consensus-margin'),
      '零余量必须产生一条 consensus-margin 异常',
    );
  });

  test('恢复期间 catching-up 不改变档位与百分比（SC-010）', async (t) => {
    node('start', victim);

    // 该节点会经过 starting → bootstrapping → catching-up → healthy。
    // 全程只允许两种档位出现：zero-margin（它还没参与）与 normal（它已参与）。
    // **不允许**出现 stopped —— 那会把"正在回来"说成"链停了"。
    const seen = new Set();
    const { snapshot: s, elapsedMs } = await waitForSnapshot(dash, (x) => {
      seen.add(x.tier);
      return x.tier === 'normal' && x.healthPercent === 100;
    }, { timeoutMs: 180_000, label: '恢复到 normal/100' });

    t.diagnostic(`恢复过程中出现过的档位：${[...seen].join(' / ')}，耗时 ${Math.round(elapsedMs / 1000)}s`);
    assert.ok(!seen.has('stopped'),
      `恢复过程中出现了 stopped —— 一个正在回来的节点不该让面板报"链已停止"。实际序列含：${[...seen].join(' / ')}`);
    assert.equal(s.validatorMargin, 1);
    assert.equal(s.tier, 'normal');
  });

  test('恢复后链照常出块（SC-004）', async () => {
    const before = Number(await pub.getBlockNumber());
    const height = await sendTx();
    assert.ok(height > before, `全员归队后应当照常出块：${before} -> ${height}`);
  });
});
