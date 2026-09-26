// tools/dashboard/public/dom.mjs —— 六个视图共用的建节点助手（功能 003 / 005）。
//
// ## 为什么要有这个文件：19 处文案里的 `**` 一直在页面上原样显示
//
// 六个 `view-*.mjs` 各自有一份**逐字节相同**的 `el()`，它只做一件事：
// `n.textContent = text`。而这些文案是按本仓库通行的 markdown 风格写的，
// 带着 `**强调**`。`textContent` 不解析任何标记 —— 于是页面上看到的是
//
//     再加一个成员（9 → 10）上限**仍然是** 2 个
//
// **星号是字面显示的。** 2026-09-26 扫出 19 处，分布在 5 个模块。
//
// 这件事**只有看页面才会发现**：`/api/snapshot` 里没有它（数据是对的），
// 逐档位的文案测试也看不见（它们断言的正是带星号的那个字符串）。
// FR-025 的验收当初记 ⚠ 的理由恰恰是「我读的是 `/api/snapshot`，没有看渲染出来的页面」——
// 补上那一步，第一眼就撞见了它。
//
// ## 处理方式：成对的 `**…**` 变成 `<b>`，落单的星号原样留着
//
// 不引入 markdown 解析器（宪法：不引重型依赖），只认最朴素的一种：成对、不跨星号。
// 落单的 `*` 原样输出 —— 悄悄吞掉一个字符比显示它更糟。

/** 成对的 `**…**`。内部不允许再出现 `*`，避免贪婪匹配跨过两段强调。 */
const BOLD = /\*\*([^*]+)\*\*/g;

/**
 * 把文字写进节点：成对的 `**…**` 变成 `<b>`，其余原样。
 *
 * 没有 `**` 时走 `textContent` 那条最短的路 —— 既省事，也让不提供
 * `createTextNode` 的替身仍然能用（测试替身提供了，但别把这当成前提）。
 */
export function setText(node, text) {
  const s = String(text);
  if (!s.includes('**')) { node.textContent = s; return node; }
  // **先清空**。名字叫 set 就得是替换语义 —— 第一版直接 append，于是对同一个节点
  // 写第二次会把两段文字叠起来。`el()` 只对新节点用它，撞不上；但一个名实不符的
  // 函数迟早会被人拿去复用。写这一行的守卫（第 ⑤ 条）是它自己抓出来的。
  node.textContent = '';
  let last = 0;
  for (const m of s.matchAll(BOLD)) {
    if (m.index > last) node.append(document.createTextNode(s.slice(last, m.index)));
    const b = document.createElement('b');
    b.textContent = m[1];
    node.append(b);
    last = m.index + m[0].length;
  }
  if (last < s.length) node.append(document.createTextNode(s.slice(last)));
  return node;
}

/** 建一个节点。签名与此前六份各自的 `el()` 完全一致。 */
export const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) setText(n, text);
  return n;
};
