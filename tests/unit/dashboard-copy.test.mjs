// T026a —— 档位文案的必含与禁止短语（功能 003 / FR-008、FR-020、SC-006）。
//
// **这是 `/speckit-analyze` 补上的一个完整缺口。** FR-008 / FR-020 / SC-006 的判据
// 本质是"文案里不得出现某些话"：
//
//   - `zero-margin` 必须说"链仍在正常出块"，**不得**出现"链已停止"
//   - `observer-blind` 全程**不得**出现"链已停止"
//   - `stopped` **不得**写"数据可能丢失""需要重置"（002 已证明恢复不需要重置）
//
// 这类要求**不会自己报错**。原先只有 T030 / T048 两个**实现**任务，
// 没有任何测试断言这些禁止词缺席 —— 正是 002 反复总结的"不会变红的守卫"形态。
//
// 前提是文案先抽成零依赖的纯模块（`copy.mjs`），否则埋在渲染函数里根本测不到。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TIER_COPY, tierCopy, INCIDENT_COPY } from '../../tools/dashboard/public/copy.mjs';

/** "链已停止"及其同义表述 —— 只在 stopped 档允许出现。 */
const CHAIN_STOPPED = /链已停止|链停止|停止出块|链已停|无法出块/;

const RULES = [
  {
    tier: 'normal',
    must: [/正常/, /还可容忍|余量/],
    mustNot: [CHAIN_STOPPED],
    why: '正常档要说明还剩多少余量，否则看的人不知道自己离危险有多远',
  },
  {
    tier: 'zero-margin',
    must: [/仍在正常出块|仍在出块/, /余量|再有一个|再掉/],
    mustNot: [CHAIN_STOPPED],
    why: '80% 是"最后一格仍在工作"。说成"链已停止"会在链完全可用时发出假报警（FR-008）',
  },
  {
    tier: 'stopped',
    must: [/查询门槛|连接权益/, /恢复/, /安全停摆|不分叉|零回滚/],
    mustNot: [/数据.*丢失/, /需要重置|须重置|执行重置/],
    why: '要说清成因、恢复所需，以及这是安全停摆 —— 002 已证明恢复不需要重置',
  },
  {
    tier: 'starting',
    must: [/启动中|还在等|尚未就绪/],
    mustNot: [CHAIN_STOPPED, /须处置|需要处置/],
    why: '分批启动期间报"已停止"是假报警；报"须处置"则会让人去动一台无可处置之处的机器',
  },
  {
    tier: 'observer-blind',
    must: [/观测|看不见|连不上/, /本机|本地/],
    mustNot: [CHAIN_STOPPED],
    why: '面板自己瞎了就喊"链停了"，会摧毁报警的可信度（FR-020 / SC-006）',
  },
];

describe('档位文案的必含与禁止短语', () => {
  test('五个档位都有文案 —— 缺一个就会在界面上显示空白', () => {
    for (const { tier } of RULES) {
      assert.ok(TIER_COPY[tier], `缺 ${tier} 的文案`);
      assert.ok(TIER_COPY[tier].label, `${tier} 缺 label`);
      assert.ok(TIER_COPY[tier].body, `${tier} 缺 body`);
    }
    assert.deepEqual(Object.keys(TIER_COPY).sort(), RULES.map((r) => r.tier).sort(),
      '文案表的键必须与档位枚举一一对应，不多不少');
  });

  for (const { tier, must, mustNot, why } of RULES) {
    const text = () => {
      const c = TIER_COPY[tier];
      return `${c.label}\n${c.body}\n${c.action ?? ''}`;
    };

    for (const re of must) {
      test(`${tier} 的文案必含 ${re.source}`, () => {
        assert.match(text(), re, why);
      });
    }
    for (const re of mustNot) {
      test(`${tier} 的文案**不得**含 ${re.source}`, () => {
        assert.doesNotMatch(text(), re, why);
      });
    }
  }

  test('只有 stopped 档允许出现"链已停止"这类表述', () => {
    const offenders = Object.entries(TIER_COPY)
      .filter(([tier]) => tier !== 'stopped')
      .filter(([, c]) => CHAIN_STOPPED.test(`${c.label}\n${c.body}\n${c.action ?? ''}`))
      .map(([tier]) => tier);
    assert.deepEqual(offenders, [],
      `这些档位的文案里出现了"链已停止"：${offenders.join('、')}。`
      + '除 stopped 之外任何一档说这句话都是假报警');
  });
});

describe('tierCopy —— 按快照填入具体数字', () => {
  const snap = (over = {}) => ({
    tier: 'normal',
    healthPercent: 100,
    participating: 5,
    threshold: 4,
    validatorCount: 5,
    maxOfflineValidators: 1,
    validatorMargin: 1,
    domainMargin: 1,
    observer: { blind: false, pathAlive: [] },
    ...over,
  });

  test('normal 档给出剩余余量的具体数字', () => {
    const c = tierCopy(snap());
    assert.match(`${c.label}${c.body}`, /1/, '要说清还能掉几个，不是含糊的"有余量"');
  });

  test('stopped 档给出"至少再恢复几个"的具体数字', () => {
    const c = tierCopy(snap({
      tier: 'stopped', healthPercent: 60, participating: 3, validatorMargin: 0,
    }));
    // 门槛 4，当前 3 → 至少再恢复 1 个
    assert.match(c.body + (c.action ?? ''), /\b1\b/,
      '必须算出"至少再恢复 N 个"，而不是让人自己去减');
  });

  test('observer-blind 的措辞随 pathAlive 变化，但档位不变', () => {
    const noPath = tierCopy(snap({
      tier: 'observer-blind',
      observer: { blind: true, pathAlive: [{ domain: 'a', alive: false }, { domain: 'b', alive: false }] },
    }));
    const somePath = tierCopy(snap({
      tier: 'observer-blind',
      observer: { blind: true, pathAlive: [{ domain: 'a', alive: true }, { domain: 'b', alive: false }] },
    }));
    assert.notEqual(noPath.body, somePath.body, 'pathAlive 应当改变措辞');
    assert.doesNotMatch(noPath.body, CHAIN_STOPPED);
    assert.doesNotMatch(somePath.body, CHAIN_STOPPED);
    assert.match(somePath.body, /路径|通/, '有路径通时应当指出"节点确实不应答"');
    assert.match(noPath.body, /本机|网卡|交换机/, '全无应答时应当指向本机网络');
  });

  test('不同档位的文案彼此不同 —— 否则界面上分不出档', () => {
    const bodies = RULES.map((r) => tierCopy(snap({ tier: r.tier })).body);
    assert.equal(new Set(bodies).size, bodies.length, '各档位文案必须互不相同');
  });

  test('未知档位不抛，给一个明确的兜底 —— 界面不该因为多了一个档位而空白', () => {
    const c = tierCopy(snap({ tier: 'no-such-tier' }));
    assert.ok(c.label, '兜底必须有 label');
    assert.doesNotMatch(`${c.label}${c.body}`, CHAIN_STOPPED, '兜底也不许说"链已停止"');
  });
});

describe('异常分类的文案', () => {
  test('五类各有文案与处置方向', () => {
    for (const cls of ['observation', 'node-infra', 'sync-lag', 'consensus-margin', 'chain-identity']) {
      assert.ok(INCIDENT_COPY[cls], `缺 ${cls} 的文案`);
      assert.ok(INCIDENT_COPY[cls].label);
      assert.ok(INCIDENT_COPY[cls].action, `${cls} 缺处置方向（宪法第九条）`);
    }
  });

  test('observation 类的处置方向明确指向"别去动那台机器"', () => {
    // 这是 002 线缆故障那次的教训：报警指错方向，人会去重启一台好机器。
    assert.match(INCIDENT_COPY.observation.action, /本机|别去动|不是节点/);
  });

  test('sync-lag 类明确说"等"，不说"处置"', () => {
    assert.match(INCIDENT_COPY['sync-lag'].action, /等/);
    assert.doesNotMatch(INCIDENT_COPY['sync-lag'].action, /重启|处置|修/);
  });
});

describe('copy.mjs 必须是零依赖纯模块', () => {
  test('不 import 任何东西 —— 否则浏览器与 Node 不能共用同一份', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const { REPO_ROOT } = await import('../../tools/protocol/load.mjs');
    const src = readFileSync(resolve(REPO_ROOT, 'tools/dashboard/public/copy.mjs'), 'utf8');
    assert.doesNotMatch(src, /^\s*import\s/m, 'copy.mjs 不得有 import');
    assert.doesNotMatch(src, /require\(/, 'copy.mjs 不得有 require');
  });
});
