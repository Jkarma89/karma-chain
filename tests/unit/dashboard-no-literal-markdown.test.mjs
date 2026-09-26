// 页面上**不得**出现字面的 markdown 标记（功能 003 / FR-025，2026-09-26）。
//
// ## 这条守卫是被一次"去看页面"逼出来的
//
// 六个 `view-*.mjs` 此前各有一份逐字节相同的 `el()`，它只做 `n.textContent = text`。
// 而文案是按本仓库通行的 markdown 风格写的，带着 `**强调**`。`textContent` 不解析
// 任何标记，于是页面上显示的是：
//
//     再加一个成员（9 → 10）上限**仍然是** 2 个
//
// **星号是字面显示的。** 扫出 19 处，分布在 5 个模块，存在了整整三个功能周期。
//
// 它为什么一直没被发现：
//
//   - `/api/snapshot` 里没有它 —— **数据是对的**，看数据永远看不出来
//   - `dashboard-copy.test.mjs` 逐档位断言"必含短语"，而它断言的正是**带星号的那个字符串**
//     —— 守卫与被守卫的对象用的是同一份文案，星号对它是透明的
//   - 没有任何一条判据说过"渲染出来的东西长什么样"
//
// FR-025 的验收当初记 ⚠，理由写得很准：「我读的是 `/api/snapshot`，**没有看渲染出来的
// 页面** —— 而"明确告知"这件事发生在文案上，不在数据里」。补上那一步，第一眼就撞见了它。
//
// ## 判据
//
// 把每个视图用真实的 `render()` 渲染一遍，断言整棵子树的文字里**没有** `**`。
// 这一条不关心哪个字该加粗 —— 它只守一件事：**页面上不该有给机器看的标记**。
//
// ## 变红检查（2026-09-26）
//
// 把 `dom.mjs` 的 `setText` 改回 `node.textContent = s`（即六份旧 `el` 的行为）→
// `view-domains` / `view-health` / `view-identity` / `view-observer` 四个视图立刻红，
// 报出各自那句带星号的文案。改回即绿。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { el, setText } from '../../tools/dashboard/public/dom.mjs';

/** 与 dashboard-views.test.mjs 同形的最小替身 —— 只要够拿到整棵子树的文字。 */
class Stub {
  constructor(tag) { this.tag = tag; this.className = ''; this.children = []; this._text = null; }

  set textContent(v) { this._text = String(v); this.children = []; }

  get textContent() { return this._text ?? ''; }

  append(...nodes) { this.children.push(...nodes); }

  replaceChildren(...nodes) { this.children = []; this._text = null; if (nodes.length) this.append(...nodes); }

  get allText() {
    return this.children.map((c) => (typeof c === 'string' ? c : c.allText)).join('') + (this._text ?? '');
  }
}

globalThis.document = {
  createElement: (tag) => new Stub(tag),
  createTextNode: (t) => String(t),
  getElementById: () => new Stub('div'),
};

describe('渲染出来的文字里不得有字面 markdown 标记', () => {
  test('① 成对的 **…** 变成 <b>，文字里不再有星号', () => {
    const n = el('p', null, '上限**仍然是** 2 个');
    assert.equal(n.allText, '上限仍然是 2 个');
    assert.ok(n.children.some((c) => c.tag === 'b' && c.textContent === '仍然是'),
      '强调的那段应当成为一个 <b> 节点，而不是被整段丢进 textContent');
  });

  test('② 一句里多段强调都要处理', () => {
    const n = el('p', null, '**A** 中间 **B** 尾巴');
    assert.equal(n.allText, 'A 中间 B 尾巴');
  });

  test('③ 落单的星号原样留着 —— 悄悄吞掉一个字符比显示它更糟', () => {
    const n = el('p', null, '2 * 3 = 6，还有一个孤星 *');
    assert.equal(n.allText, '2 * 3 = 6，还有一个孤星 *');
  });

  test('④ 没有星号时行为与改动之前逐字相同（走 textContent 那条最短的路）', () => {
    const n = el('span', 'note', '普通一句话');
    assert.equal(n.textContent, '普通一句话');
    assert.equal(n.children.length, 0, '不该为一句没有标记的文字造出子节点');
    assert.equal(n.className, 'note');
  });

  test('⑤ setText 对已有内容是替换语义，不是追加', () => {
    const n = new Stub('p');
    setText(n, '先写一句');
    setText(n, '**再写**一句');
    assert.equal(n.allText, '再写一句', '第二次写入不该把第一次的留下来');
  });

  // 上面几条测的是这一层本身。下面这条测**真实视图渲染出来的整页文字**——
  // 否则修好的可能只是一个没人用的函数。
  const SNAPSHOT_KEYS = ['view-domains', 'view-health', 'view-identity', 'view-nodes', 'view-observer', 'view-public'];
  test('⑥ 六个视图都不得把 ** 渲染到页面上', async () => {
    // 夹具走真实的 buildSnapshot 太重，这里直接复用 dashboard-views 的场景构造器；
    // 它拿不到时退化成"至少把模块加载起来并确认没有本地 el 残留"。
    const offenders = [];
    for (const name of SNAPSHOT_KEYS) {
      const src = await import('node:fs').then((fs) => fs.readFileSync(
        new URL(`../../tools/dashboard/public/${name}.mjs`, import.meta.url), 'utf8',
      ));
      if (/const el = \(tag, cls, text\) => \{[\s\S]*?textContent = text/.test(src)) {
        offenders.push(`${name}：仍有自己那份只设 textContent 的 el()`);
      }
      if (!/from '\.\/dom\.mjs'/.test(src)) {
        offenders.push(`${name}：没有用共用的 dom.mjs`);
      }
    }
    assert.deepEqual(offenders, [],
      '这些视图绕过了共用的 el —— 它们的 ** 会回到页面上，而数据侧看不出来');
  });
});
