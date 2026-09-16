// T052 —— 任一异常都必须带四类之一的分类，无未分类条目（功能 003 / SC-020）。
//
// 宪法第九条要求区分故障类别，理由是**处置方式完全不同**。一条没有分类的异常
// 等于把"该去哪儿看"这个信息丢掉了 —— 而那恰恰是运维唯一需要的东西。
//
// 本文件用**穷举**来守：把 9 个状态 × 两种 countsAsOffline × 五种档位 × 分叉与否
// 全部组合喂进去，断言产出的每一条都带合法分类、可读消息与处置方向。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from '../../tools/protocol/load.mjs';
import { buildIncidents, incidentClass, INCIDENT_CLASSES, TIERS } from '../../tools/dashboard/snapshot.mjs';
import { INCIDENT_COPY } from '../../tools/dashboard/public/copy.mjs';

const ALL_STATES = [
  'stopped', 'starting', 'bootstrapping', 'catching-up',
  'healthy', 'unreachable', 'identity-mismatch', 'data-corrupt', 'stalled',
];
const ALL_TIERS = Object.values(TIERS);

const row = (state, countsAsOffline, extra = {}) => ({
  id: `n-${state}-${countsAsOffline}`,
  role: 'l1-validator',
  state,
  detail: `${state} 的说明`,
  countsTowardTolerance: true,
  countsAsOffline,
  genesisMatchesBaseline: true,
  ...extra,
});

describe('穷举：没有任何组合能产出未分类的异常（SC-020）', () => {
  test(`${ALL_STATES.length} 状态 × 2 离线语义 × ${ALL_TIERS.length} 档位 × 2 分叉 —— 全部条目合法`, () => {
    let produced = 0;
    for (const state of ALL_STATES) {
      for (const offline of [true, false]) {
        for (const tier of ALL_TIERS) {
          for (const forkDetected of [true, false]) {
            const rows = [row(state, offline, { genesisMatchesBaseline: forkDetected ? false : true })];
            const incidents = buildIncidents({
              rows,
              tier,
              observer: { reachableNodes: 1, totalNodes: 7, blind: tier === TIERS.OBSERVER_BLIND, pathAlive: [] },
              chainIdentity: { forkDetected, unknownGenesis: false },
            });
            for (const i of incidents) {
              produced += 1;
              assert.ok(INCIDENT_CLASSES.has(i.class),
                `未分类异常：state=${state} offline=${offline} tier=${tier} → ${JSON.stringify(i)}`);
              assert.equal(typeof i.message, 'string');
              assert.ok(i.message.length > 0, `分类 ${i.class} 缺消息`);
              assert.equal(typeof i.action, 'string');
              assert.ok(i.action.length > 0, `分类 ${i.class} 缺处置方向（宪法第九条）`);
            }
          }
        }
      }
    }
    assert.ok(produced > 0, `这组穷举应当产出异常条目，实际 ${produced} 条 —— 否则本用例在空转`);
  });

  test('incidentClass 对全部 18 种（状态 × 离线语义）组合都给出确定结果', () => {
    for (const state of ALL_STATES) {
      for (const offline of [true, false]) {
        const cls = incidentClass(row(state, offline));
        assert.ok(cls === null || INCIDENT_CLASSES.has(cls),
          `state=${state} offline=${offline} → ${cls}`);
      }
    }
  });
});

describe('六类分类与文案表一一对应（004 追加 recovery-blocked）', () => {
  test('每个分类枚举值都有文案（否则界面上会显示原始 slug）', () => {
    for (const cls of INCIDENT_CLASSES) {
      assert.ok(INCIDENT_COPY[cls], `分类 ${cls} 缺文案`);
      assert.ok(INCIDENT_COPY[cls].label, `分类 ${cls} 缺 label`);
      assert.ok(INCIDENT_COPY[cls].action, `分类 ${cls} 缺处置方向`);
    }
  });

  test('文案表里没有多余的分类（否则枚举与文案已经漂移）', () => {
    for (const cls of Object.keys(INCIDENT_COPY)) {
      assert.ok(INCIDENT_CLASSES.has(cls),
        `文案表里的 ${cls} 不在分类枚举里 —— 两者已漂移`);
    }
  });

  test('六类的处置方向互不相同 —— 分类若不改变处置，就不该存在', () => {
    const actions = [...INCIDENT_CLASSES].map((c) => INCIDENT_COPY[c].action);
    assert.equal(new Set(actions).size, actions.length,
      '有两类给出了相同的处置方向 —— 那说明它们该合并，或者其中一个的处置写错了');
  });
});

describe('异常条目挂在正确的对象上', () => {
  const base = {
    observer: { reachableNodes: 5, totalNodes: 7, blind: false, pathAlive: [] },
    chainIdentity: { forkDetected: false, unknownGenesis: false },
  };

  test('节点级异常带 nodeId，链级异常不带', () => {
    const incidents = buildIncidents({
      ...base,
      rows: [row('stopped', true), row('healthy', false)],
      tier: TIERS.ZERO_MARGIN,
    });
    const nodeLevel = incidents.filter((i) => i.nodeId);
    const chainLevel = incidents.filter((i) => !i.nodeId);
    assert.equal(nodeLevel.length, 1, '只有那个 stopped 节点产生节点级异常');
    assert.equal(nodeLevel[0].class, 'node-infra');
    assert.equal(chainLevel.length, 1, 'zero-margin 产生一条链级异常');
    assert.equal(chainLevel[0].class, 'consensus-margin');
  });

  test('healthy 节点不产生任何条目 —— 清单里只该有需要看的东西', () => {
    const incidents = buildIncidents({
      ...base,
      rows: Array.from({ length: 5 }, () => row('healthy', false)),
      tier: TIERS.NORMAL,
    });
    assert.deepEqual(incidents, []);
  });
});

describe('每个分类都有颜色 —— 否则"显目报出"落成一个灰框（FR-029）', () => {
  // ## 为什么补这条（2026-09-16）
  //
  // `recovery-blocked`（004）与 `membership`（005）加进枚举时都**没有加样式**，
  // 于是它们渲染成 `border-left-color: var(--line)` 的中性灰框。
  // 文案表那条双向守卫抓不到这个：它只管有没有文字。
  //
  // 后果不对称，两个方向都坏：
  //   `recovery-blocked` 是"恢复能力已丧失"，看着却和普通提示一样
  //   005 的 `topology-limit` 若也这样，FR-029 的"**显目**报出"就落空了
  //
  // 所以这一条只问一件事：枚举里的每一类，style.css 里都有一条对应规则。
  // 颜色**该是什么**由人定（membership 刻意是中性，因为它不是故障）——
  // 守卫不替人做那个判断，只保证没人忘了做。
  // 选择器与 `{` 之间的空白抹平之后做子串比对 —— 不走正则。
  // 起初这里用的是模板字面量拼的 RegExp，而模板里的 `\.` 只剩一个反斜杠：
  // 正则变成了 `.incident-group--observations*{`，于是**九条全红**。
  // 红得很显眼所以立刻发现了；但若当时只有一条分类，它会红得像「样式真的缺了」。
  const css = readFileSync(resolve(REPO_ROOT, 'tools/dashboard/public/style.css'), 'utf8')
    .replace(/\s+\{/g, '{');

  for (const cls of INCIDENT_CLASSES) {
    test(`.incident-group--${cls} 有样式`, () => {
      assert.ok(css.includes(`.incident-group--${cls}{`),
        `分类 ${cls} 在 style.css 里没有对应规则 —— 它会渲染成默认的灰框。\n`
        + `  加一条：.incident-group--${cls} { border-left-color: var(--…); background: var(--…-wash); }\n`
        + '  颜色该是什么要想清楚：不是故障的那一类（如 membership）**刻意**保持中性，\n'
        + '  染成红色会让人去修一台没坏的机器。');
    });
  }

  test('**反向断言**：缺规则时这条真的会红', () => {
    assert.ok(!css.includes('.incident-group--definitely-not-a-class{'),
      '一个不存在的分类竟然匹配上了 —— 说明上面那些断言可能恒真');
  });
});
