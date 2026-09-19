// DoD 摘要里的数必须**从表里数出来**，不能靠记（功能 005 / T062）。
//
// ## 为什么要有这条
//
// 2026-09-19 回填这份表时，我在摘要里写了 SC **6 ✅**、FR **31 ✅** ——
// 而逐条数下来是 **4 ✅** 与 **30 ✅**。两个数都是我按"改了哪几条"心算出来的，
// 没有对着表数。
//
// 摘要那一行**没有自己的事实来源**：它只能从下面的表里数出来。
// 一个从别处抄来或算出来的数，会在有人改动某一行档位之后静默失真 ——
// 而这份表的全部价值就是它的数字可信。
//
// 同族的错本期已经有过：第六节第 17 条（一个"声称存在"的判定其实不存在）。
// 这次是一个"声称数过"的数其实没数过。
//
// ## 这条守的是一致性，不是某个具体的数
//
// 刻意**不写死** "4 ✅ / 9 ⚠"：那样每次状态推进都要改两处，而改漏的那处
// 恰恰是这条守卫要抓的东西。它只断言**摘要与表格相等**。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from '../../tools/protocol/load.mjs';

const DOD = readFileSync(
  resolve(REPO_ROOT, 'specs/005-elastic-membership/checklists/dod.md'), 'utf8',
);

/** 数某一节里那些「| 编号 … | 状态 |」行的档位。 */
const tally = (fromHeading, toHeading, rowPattern) => {
  const a = DOD.indexOf(fromHeading);
  const b = DOD.indexOf(toHeading);
  assert.ok(a >= 0, `找不到小节：${fromHeading}`);
  assert.ok(b > a, `找不到小节：${toHeading}`);
  const rows = DOD.slice(a, b).split('\n').filter((l) => rowPattern.test(l));
  const counts = { '✅': 0, '⚠': 0, '❌': 0 };
  for (const r of rows) {
    const m = r.match(/[✅⚠❌]/);
    assert.ok(m, `这一行没有档位标记，摘要就数不出来：\n  ${r.slice(0, 80)}`);
    counts[m[0]] += 1;
  }
  return { rows: rows.length, counts };
};

const render = (c) => `${c['✅']} ✅ / ${c['⚠']} ⚠ / ${c['❌']} ❌`;

const SC = tally('## 三、16 条成功判据', '## 四、38 条功能需求', /^\| 0\d\d \|/);
const FR = tally('## 四、38 条功能需求', '## 五、两份契约', /^\| \d\d\d /);

describe('表格本身是完整的（否则下面两条数的是残表）', () => {
  test('SC 恰好 16 行', () => {
    assert.equal(SC.rows, 16, `第三节数到 ${SC.rows} 行 —— 标题说 16 条`);
  });
  test('FR 恰好 38 行，且编号 001…038 一条不缺', () => {
    assert.equal(FR.rows, 38, `第四节数到 ${FR.rows} 行 —— 标题说 38 条`);
    const a = DOD.indexOf('## 四、38 条功能需求');
    const b = DOD.indexOf('## 五、两份契约');
    const ids = [...DOD.slice(a, b).matchAll(/^\| (\d\d\d) /gm)].map((m) => m[1]);
    const missing = [];
    for (let i = 1; i <= 38; i += 1) {
      const id = String(i).padStart(3, '0');
      if (!ids.includes(id)) missing.push(id);
    }
    assert.deepEqual(missing, [],
      `FR 编号断链：缺 ${missing.join('、')}。004 的教训是编号断链会让回填漏项，`
      + '而漏掉的那条不会有人发现它漏了');
  });
});

describe('摘要的数与表格相等', () => {
  test('SC 那一行', () => {
    const m = /成功判据（16 条 SC） \| \*\*([^*]+)\*\*/.exec(DOD);
    assert.ok(m, '摘要里找不到 SC 那一行');
    assert.equal(m[1].trim(), render(SC.counts),
      '摘要与第三节的表**对不上**。摘要没有自己的事实来源 —— 它只能从表里数出来。\n'
      + '  2026-09-19 就是这么错过一次：按"改了哪几条"心算，写成了 6 ✅ 而实际 4 ✅。');
  });

  test('FR 那一行', () => {
    const m = /功能需求（38 条 FR） \| \*\*([^*]+)\*\*/.exec(DOD);
    assert.ok(m, '摘要里找不到 FR 那一行');
    assert.equal(m[1].trim(), render(FR.counts), '摘要与第四节的表对不上 —— 同上');
  });

  test('宪法第 1 项引的 FR 数也要一致（它是第三处副本）', () => {
    const m = /\*\*Specification 满足\*\* \| [^|]+ \| 38 条 FR 里 \*\*([^*]+)\*\*/.exec(DOD);
    assert.ok(m, '宪法第 1 项里找不到那个数');
    assert.equal(m[1].trim(), render(FR.counts),
      '同一个数在本表里有三处副本（摘要、宪法第 1 项、第四节的表）。'
      + '**三处必须同时改** —— 改漏的那处就是下一次误判的来源');
  });
});
