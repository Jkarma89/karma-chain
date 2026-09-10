// tools/dashboard/public/view-domains.mjs —— 故障边界与异常分类（功能 003 / US4）。
//
// 归属：T053（边界视图）、T054（两个余量的成因）、T055（异常四类分组）、
//       T056（local 形态的边界余量为 0）。
//
// ## 为什么两个余量必须并列，且不同时要说明成因
//
// 它们可以不同：若两个验证者挤到同一台机器，**验证者级余量仍是 1**（还能掉一个验证者），
// 但**边界级余量变成 0**（那台机器一挂就同时掉两个）。只看前者会高估冗余。
//
// 而边界余量必须按 `effectiveDomains`（并查集之后）算 —— `load.mjs:259` 的注释说得
// 很直接：按声明的边界判会得到「可容忍 1 个边界整体失效 [OK]」这样
// **在现实里为假的绿灯**，因为共享供电、共享交换机这类因素会被绿灯掩盖。
import { INCIDENT_COPY } from './copy.mjs';

export const meta = { id: 'domains', title: '故障边界与异常', order: 4 };

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/** T054：两个余量并列，并解释它们为什么可能不同。 */
function renderMarginExplain(s, root) {
  const ft = s.faultTolerance;
  const box = el('div', 'margin-explain');

  const worst = Math.max(0, ...ft.effectiveDomains.map((g) => g.validators));
  const line = el('p', 'note');
  line.append(el('b', null, `验证者级余量 ${s.validatorMargin}　边界级余量 ${s.domainMargin}`));
  root.append(box);
  box.append(line);

  if (s.domainMargin === s.validatorMargin) {
    box.append(el('p', 'note',
      `两者相同：每个有效边界至多承载 ${worst} 个验证者，不超过可容忍的 `
      + `${ft.maxOfflineValidators} 个 —— 掉一个边界与掉一个验证者的代价一样。`));
  } else {
    // T054：不同时必须说明成因，否则看的人只会觉得面板算错了
    box.append(el('p', 'note',
      `**两者不同**：最大的有效边界承载 ${worst} 个验证者，超过了可容忍的 `
      + `${ft.maxOfflineValidators} 个。那台机器一旦整体失效会同时失去 ${worst} 个验证者 —— `
      + '所以边界级余量比验证者级余量更小。只看后者会高估冗余。'));
  }

  if (ft.effectiveDomainCount <= 1) {
    // T056：单边界形态
    box.append(el('p', 'note',
      '当前只有 1 个有效故障边界 —— **该形态不做整机失效容错承诺**。'
      + '这不是配置错误：单机形态本来就只解决"崩溃后自愈"，不解决"整机失效"。'));
  }

  if (ft.effectiveDomainCount < ft.domainCount) {
    box.append(el('p', 'note',
      `注意：声明了 ${ft.domainCount} 个边界，但按共享失效因素合并后只有 `
      + `${ft.effectiveDomainCount} 个**有效**边界。余量是按有效边界算的 —— `
      + '按声明的算会得到一个在现实里为假的绿灯。'));
  }
}

/** T053：逐边界视图 —— 平台、地址、承载节点、验证者数、共享因素。 */
function renderDomains(s, root) {
  // 按边界把节点归拢。地址与承载节点全部取自快照（源自 protocol.json）。
  const byDomain = new Map();
  for (const n of s.nodes) {
    if (!byDomain.has(n.domain)) byDomain.set(n.domain, { address: n.address, nodes: [] });
    byDomain.get(n.domain).nodes.push(n);
  }

  // 有效分组：哪些边界被共享因素合并在了一起
  const groupOf = new Map();
  for (const g of s.faultTolerance.effectiveDomains) {
    for (const id of g.ids) groupOf.set(id, g);
  }

  const wrap = el('div', 'scroll-x');
  const t = el('table', 'nodes');
  const head = el('tr');
  for (const c of ['故障边界', '地址', '承载节点', '验证者', '参与共识', '有效分组']) {
    head.append(el('th', null, c));
  }
  // Node.append() 返回 **undefined**，不是被追加的节点 —— 不能链式取 .lastChild。
  const thead = el('thead');
  thead.append(head);
  t.append(thead);

  const body = el('tbody');
  for (const [id, info] of byDomain) {
    const validators = info.nodes.filter((n) => n.countsTowardTolerance);
    const participating = validators.filter((n) => n.participatesInConsensus);
    const group = groupOf.get(id);
    const merged = group && group.ids.length > 1;

    const tr = el('tr', participating.length < validators.length ? 'row--offline' : null);
    tr.append(el('td', 'mono', id));
    tr.append(el('td', 'mono dim', info.address));
    tr.append(el('td', null, info.nodes.map((n) => n.id).join('、')));
    tr.append(el('td', 'num', String(validators.length)));
    tr.append(el('td', 'num', `${participating.length} / ${validators.length}`));
    tr.append(el('td', merged ? 'merged' : 'dim',
      merged ? `与 ${group.ids.filter((x) => x !== id).join('、')} 合并（${group.factors.join('、')}）` : '独立'));
    body.append(tr);
  }
  t.append(body);
  wrap.append(t);
  root.append(wrap);
}

/** T055：异常按四类分组，每类给处置方向。 */
function renderIncidents(s, root) {
  root.append(el('h3', 'group-title', `异常（${s.incidents.length}）`));

  if (s.incidents.length === 0) {
    root.append(el('p', 'note', '无异常。'));
    return;
  }

  // 按分类分组 —— 因为**处置方式完全不同**（宪法第九条）
  const byClass = new Map();
  for (const i of s.incidents) {
    if (!byClass.has(i.class)) byClass.set(i.class, []);
    byClass.get(i.class).push(i);
  }

  for (const [cls, items] of byClass) {
    const copy = INCIDENT_COPY[cls] ?? { label: cls, action: '（该分类缺文案）' };
    const box = el('div', `incident-group incident-group--${cls}`);
    box.append(el('div', 'incident-group-title', `${copy.label}（${items.length}）`));
    box.append(el('div', 'incident-action', `处置：${copy.action}`));
    const list = el('ul', 'fault-list');
    for (const i of items) list.append(el('li', null, i.message));
    box.append(list);
    root.append(box);
  }
}

export function render(snapshot, root) {
  root.replaceChildren();
  renderMarginExplain(snapshot, root);
  root.append(el('h3', 'group-title',
    `故障边界（声明 ${snapshot.faultTolerance.domainCount} / 有效 ${snapshot.faultTolerance.effectiveDomainCount}）`));
  renderDomains(snapshot, root);
  renderIncidents(snapshot, root);
}
