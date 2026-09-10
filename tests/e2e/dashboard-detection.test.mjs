// T023 / T024 —— 面板在 10 秒内发现验证者离线（功能 003 / SC-002、SC-004、SC-010）。
//
// ## 本文件的要点：面板所报必须与链的**真实**出块能力一致
//
// 光断言"面板显示 80%"是不够的 —— 一个恒返回 80% 的实现也能过。所以每个档位都
// **同时**用一笔真实交易验证链的实际行为：
//
//   - `zero-margin`（80%）→ 交易**能**确认。这是 FR-008 的判据：链仍在正常出块
//   - 恢复过程中的 `catching-up` → 档位**不变**（FR-011 / SC-010）
//
// 60% 的 `stopped` 档需要停 2 个验证者，而 T-5 保证每台机器至多 1 个 ——
// 那一条在 `dashboard-stopped-tier.test.mjs`（跨机形态下带说明跳过）。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  pub, sendTx, sh, devnetAvailable, pickLocalVictims, localVictimSkip,
} from './lib/devnet.mjs';
import { startDashboard, waitForSnapshot, waitFirstPoll } from './lib/dashboard.mjs';

const node = (...args) => sh('sh', ['scripts/devnet-node.sh', ...args]);

// `localVictimSkip` 只**生成跳过说明**，判定要靠 `pickLocalVictims` 是否返回 null。
// （2026-09-10 踩过：直接把前者当判定用，于是本文件在靶子充足时也恒跳过。）
const SKIP = !(await devnetAvailable())
  ? '开发网未运行 —— 先 scripts/devnet-start'
  : (pickLocalVictims(1) ? undefined : localVictimSkip(1));

describe('面板 —— 10 秒内发现验证者离线', { skip: SKIP, concurrency: 1 }, () => {
  let dash;
  let victim;

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

  test('前置：满员时 100% / normal / 余量 1（SC-001）', async () => {
    const { snapshot: s } = await waitForSnapshot(dash, (x) => x.tier === 'normal', { label: '满员 normal' });
    assert.equal(s.healthPercent, 100);
    assert.equal(s.tier, 'normal');
    assert.equal(s.validatorMargin, 1, '还可容忍 1 个离线');
    assert.equal(s.domainMargin, 1, '边界级余量同为 1');
    assert.equal(s.observer.blind, false);
    assert.equal(s.chainIdentity.forkDetected, false, '五台创世应当一致');
  });

  test('停 1 个验证者 → ≤10 秒内 80% / zero-margin，且链仍能确认交易（SC-002）', async (t) => {
    const before = Number(await pub.getBlockNumber());
    node('kill', victim);

    const { snapshot: s, elapsedMs, samples } = await waitForSnapshot(
      dash, (x) => x.tier === 'zero-margin', { label: 'zero-margin' },
    );
    t.diagnostic(`档位序列：${samples.map((x) => `${x.at}ms:${x.tier}/${x.healthPercent}%`).join(' → ')}`);
    t.diagnostic(`发现时延 ${elapsedMs} ms`);

    assert.ok(elapsedMs <= 10_000,
      `发现时延 ${elapsedMs} ms 超过 10 秒（FR-018 / SC-002）`);
    assert.equal(s.healthPercent, 80);
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
