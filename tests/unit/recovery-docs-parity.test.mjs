// T022 —— 面板文案与 `docs/devnet.md` §9.5「恢复顺序」**不得漂移**（功能 004，FR-023 / SC-010）。
//
// ## 同一处事实，两处表述
//
// 「先把两个 Primary 都拉起来，再拉验证者」这条规程同时出现在两个地方：
//
//   - `docs/devnet.md` §9.5 —— 断电／重启后的恢复流程，人**事后查**的地方
//   - 面板的恢复能力提示 —— 人**当场看**的地方
//
// 把它写进文档只解决"查得到"，写进面板才解决"想得起来" ——
// 这条约束是**反直觉**的（正常人的第一反应是先救看起来坏了的那个东西），
// 所以两处都要有。而两处都有就必然会漂移。
//
// ## 为什么不靠人核对
//
// 2026-09-11 就是这样：我先在 §9.5 写了门槛表，几小时后写面板文案时
// 又凭记忆写了一遍。人会忘，而漂移的表现是"文档说要两个、面板说随便起一个"——
// 那时候没有任何东西会失败。
//
// 本套件比对的是**结论、门槛数字、顺序**三样，不比对措辞 ——
// 措辞可以各自优化，结论不能各说各话。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from '../../tools/protocol/load.mjs';
import { recoveryCopy, INCIDENT_COPY } from '../../tools/dashboard/public/copy.mjs';
import { PRIMARIES_REQUIRED_FOR_REJOIN } from '../../tools/dashboard/snapshot.mjs';

const doc = readFileSync(resolve(REPO_ROOT, 'docs', 'devnet.md'), 'utf8');

/** §9.5 里「恢复顺序」那一节 —— 从标题句取到下一个二级分隔。 */
const section = (() => {
  const start = doc.indexOf('恢复顺序有硬约束');
  assert.ok(start > 0,
    'docs/devnet.md 里找不到「恢复顺序有硬约束」那一节。\n'
    + '  它是本套件比对的另一端 —— 节被改名或删掉时，本断言必须先失败，\n'
    + '  而不是让比对静默地变成"和空字符串一致"。');
  const end = doc.indexOf('### 9.6', start);
  return doc.slice(start, end > 0 ? end : start + 4000);
})();

const panelText = () => {
  const c = recoveryCopy({
    recoveryCapability: 'blocked',
    primariesRequiredForRejoin: PRIMARIES_REQUIRED_FOR_REJOIN,
  });
  return [c.label, c.body, c.action, INCIDENT_COPY['recovery-blocked'].action].join(' ');
};

describe('两处都在 —— 缺一处这条守卫就是在空转', () => {
  test('文档那一节取到了内容', () => {
    assert.ok(section.length > 200, `§9.5 那一节只取到 ${section.length} 字，像是被改结构了`);
  });
  test('面板那一侧有文案', () => {
    assert.ok(panelText().length > 50);
  });
});

describe('门槛数字一致（这是最容易漂的一样）', () => {
  test(`常量是 ${PRIMARIES_REQUIRED_FOR_REJOIN}，文档的表里也是`, () => {
    // 文档里那张表的第一行是「<N> | 100% | ✅」—— 只认"需要几个"这个数
    assert.match(section, new RegExp(`\\|\\s*${PRIMARIES_REQUIRED_FOR_REJOIN}\\s*\\|\\s*100%`),
      `§9.5 的门槛表里没有「${PRIMARIES_REQUIRED_FOR_REJOIN} | 100%」这一行。\n`
      + `  常量 PRIMARIES_REQUIRED_FOR_REJOIN = ${PRIMARIES_REQUIRED_FOR_REJOIN}，两处必须对得上 ——\n`
      + '  否则会出现"文档说要两个、面板说随便起一个"，而没有任何东西失败。');
  });

  test('面板文案里也出现同一个数', () => {
    assert.match(panelText(), new RegExp(`${PRIMARIES_REQUIRED_FOR_REJOIN}|两`),
      '面板没说需要几个 —— 人看完不知道该起一个还是两个');
  });

  test('文档明确写出"少一个就不行"这一格', () => {
    // 表里的中间那行：1 个在线 → 50% → ❌。它是 `< 2` 与 `= 0` 的唯一区别所在
    assert.match(section, /\|\s*\*\*1\*\*\s*\|\s*\*\*50%\*\*\s*\|\s*❌/,
      '§9.5 的表里缺了"只有 1 个在线 → 不行"那一格。\n'
      + '  它是整条规程最反直觉的一格 —— 从"两个都停了"这个现场最自然的归纳是"没有就不行"，\n'
      + '  而真相是"少一个就不行"。');
  });
});

describe('结论一致', () => {
  test('两处都说"缺任何一个都不行"，而不是"全停才不行"', () => {
    assert.match(section, /缺任何一个|少一个都不行|1\s*\|\s*.*❌/,
      '文档没说清"缺一个就不行"');
    assert.match(panelText(), /只起一个不够|一个不够/,
      '面板没说清"只起一个不够"');
  });

  test('两处都说明"已经在跑的不受影响 / 自行追上"', () => {
    assert.match(section, /自愈|自行/, '文档没说恢复后会自愈');
    assert.match(panelText(), /自行追上|自动/, '面板没说恢复后会自愈');
  });

  test('两处都不说"需要重置"', () => {
    for (const [name, text] of [['§9.5', section], ['面板', panelText()]]) {
      assert.ok(!text.includes('需要重置'),
        `${name} 里出现了「需要重置」—— 停摆与卡住不损坏任何东西（003 的 V-04）`);
    }
  });
});

describe('顺序一致：先 Primary，再验证者', () => {
  test('文档里 Primary 出现在验证者之前', () => {
    assert.match(section, /先把.*Primary.*再拉验证者|先.*Primary.*再.*验证者/,
      '§9.5 没有把顺序写成一句可执行的话');
  });

  test('面板的处置也是先 Primary —— 且明说在那之前别动验证者', () => {
    const t = panelText();
    assert.match(t, /先把.*Primary/, '面板的处置方向没说"先"');
    assert.match(t, /不要重启/, '面板没说在那之前别重启验证者 —— 那是整条提示的要点');
    assert.ok(t.indexOf('Primary') < t.lastIndexOf('验证者'),
      '面板文案里验证者出现在 Primary 之前，读起来会让人先去动验证者');
  });
});
