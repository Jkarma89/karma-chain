// tools/dashboard/public/view-nodes.mjs —— 逐节点明细（功能 003 / US2）。
//
// 归属：T039（节点表）、T040（Primary 分组）、T041（追赶进度）、T042（落后量）。
//
// **不做任何判定** —— state / behindBlocks / participatesInConsensus / incidentClass
// 全部取自快照；`detail` 是既有 classify() 写的那句话，原样呈现。
//
// ## 为什么 Primary 要单独成组
//
// 它们不参与 L1 出块（研究 R-09），因此 `countsTowardTolerance` 为 false，
// 不计入健康度百分比。002 实测过的那次误报正是因为把它们混在一起看：
// 两个 Primary 一停，5 个**工作正常**的验证者的综合健康位全部转假，
// `devnet-status` 报 "7/7 nodes NOT healthy" 而链完全可用。
// 分组呈现 + 一句说明，是为了让看的人不会再做同一个推断。
import { STATE_COPY, INCIDENT_COPY } from './copy.mjs';

export const meta = { id: 'nodes', title: '逐节点状态', order: 2 };

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const dash = '—';

/** 落后量与追赶进度（T041 / T042 / FR-016）。 */
function progressCell(n) {
  if (n.behindBlocks == null) return dash;
  if (n.behindBlocks <= 0) return '已追平';
  // 既有 classify() 的 catching-up 分支已经算出了速率与 ETA，写在 detail 里 ——
  // 这里不重算（那会成为第二个事实来源），只把落后量单独列出来便于扫视。
  return `落后 ${n.behindBlocks} 块`;
}

function stateCell(n) {
  const wrap = el('span', `state state--${n.state}`);
  wrap.append(el('b', null, STATE_COPY[n.state] ?? n.state));
  if (n.incidentClass) {
    const tag = INCIDENT_COPY[n.incidentClass];
    wrap.append(el('span', 'incident-tag', ` ${tag?.label ?? n.incidentClass}`));
  }
  return wrap;
}

function table(rows, { showParticipation }) {
  const wrap = el('div', 'scroll-x');
  const t = el('table', 'nodes');
  const head = el('tr');
  const cols = ['节点', '边界', '地址', '状态', '高度', '落后', 'peers'];
  if (showParticipation) cols.push('参与共识');
  for (const c of cols) head.append(el('th', null, c));
  // Node.append() 返回 **undefined**，不是被追加的节点 —— 不能链式取 .lastChild。
  const thead = el('thead');
  thead.append(head);
  t.append(thead);

  const body = el('tbody');
  for (const n of rows) {
    const tr = el('tr', n.participatesInConsensus === false && showParticipation ? 'row--offline' : null);
    tr.append(el('td', 'mono', n.id));
    tr.append(el('td', null, n.domain));
    tr.append(el('td', 'mono dim', n.address));
    const stateTd = el('td');
    stateTd.append(stateCell(n));
    tr.append(stateTd);
    tr.append(el('td', 'num mono', n.height == null ? dash : String(n.height)));
    tr.append(el('td', 'num', progressCell(n)));
    tr.append(el('td', 'num mono', n.peers == null ? dash : String(n.peers)));
    if (showParticipation) {
      tr.append(el('td', 'num', n.participatesInConsensus ? '是' : '否'));
    }
    body.append(tr);

    // 既有 classify 写的那句话 —— 它带着当初的实测理由（例如"是本机到它的网络路径问题"）
    if (n.detail) {
      const note = el('tr', 'detail-row');
      const td = el('td', 'detail', n.detail);
      td.colSpan = cols.length;
      note.append(td);
      body.append(note);
    }
  }
  t.append(body);
  wrap.append(t);
  return wrap;
}

export function render(snapshot, root) {
  root.replaceChildren();

  const validators = snapshot.nodes.filter((n) => n.countsTowardTolerance);
  const others = snapshot.nodes.filter((n) => !n.countsTowardTolerance);

  root.append(el('h3', 'group-title',
    `L1 验证者（${validators.length}）—— 计入健康度`));
  root.append(table(validators, { showParticipation: true }));

  if (others.length > 0) {
    root.append(el('h3', 'group-title',
      `Primary Network 节点（${others.length}）—— 不计入健康度`));
    // T040：说明为什么它们不计入 —— 否则看的人会以为面板漏算了
    root.append(el('p', 'note',
      'Primary 节点不参与 L1 出块，因此不计入健康度百分比与容错计算。'
      + '它们全部停止时 L1 仍会正常出块（002 已实测）—— 若某天面板因为它们而报链不健康，'
      + '那是判据被改坏了。'));
    root.append(table(others, { showParticipation: false }));
  }
}
