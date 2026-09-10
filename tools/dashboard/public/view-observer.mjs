// tools/dashboard/public/view-observer.mjs —— 观察者视角（功能 003 / US3）。
//
// 归属：T047（本机视角不可达）、T048（失去观测能力）、T049（各节点说法不一致）、
//       T050（启动中）。
//
// ## 这一整个视图存在的理由
//
// 「面板连不上」与「节点坏了」是两件事。002 的 ubuntu-1 线缆丢包实测过：
// 混为一谈会误报"节点下线"、进而误报"链已停止"，而链完全正常。
// 报警一旦骗过人一次，之后就没人信它了。
//
// 所以观察者可达性在这里**单独成块**，与链的健康度并列 —— 而不是藏在节点表的某一行里。
import { tierCopy, STATE_COPY } from './copy.mjs';

export const meta = { id: 'observer', title: '观察者视角', order: 3 };

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/** T048：整体失明 —— 整幅提示，且绝不出现"链已停止"。 */
function renderBlind(s, root) {
  const copy = tierCopy(s);
  const box = el('div', 'blind-banner');
  box.append(el('div', 'blind-title', `${copy.symbol} ${copy.label}`));
  box.append(el('div', null, copy.body));
  box.append(el('div', 'blind-action', copy.action));

  // pathAlive 的逐边界佐证 —— 让"该去哪儿看"有依据，而不是只说"我不知道"
  const paths = s.observer?.pathAlive ?? [];
  if (paths.length > 0) {
    const list = el('ul', 'path-list');
    for (const p of paths) {
      list.append(el('li', p.alive ? 'alive' : 'dead',
        `${p.domain}：${p.alive ? `对外端口有应答（HTTP ${p.status}）—— 路径通` : '对外端口无应答'}`));
    }
    box.append(list);
  }
  root.append(box);
}

/** T047：本机视角不可达 —— 必须与「节点下线」明显区别。 */
function renderLocalPathFaults(s, root) {
  const faults = s.nodes.filter((n) => n.incidentClass === 'observation');
  if (faults.length === 0) return;

  const box = el('div', 'observation-block');
  box.append(el('div', 'observation-title',
    `本机视角不可达（${faults.length}）—— 不是节点故障`));
  box.append(el('p', 'note',
    '这些节点本机连不上，但网络里其余节点与它们有连接 —— 链里有它们，'
    + '断的是本机到它们的路径。它们**不计入**离线，健康度也不受影响。'
    + '处置方向是修本机的网络路径，**别去动那几台机器**。'));

  const list = el('ul', 'fault-list');
  for (const n of faults) {
    const li = el('li');
    li.append(el('b', 'mono', n.id));
    li.append(document.createTextNode(`（${n.domain} · ${n.address}）`));
    if (n.detail) li.append(el('span', 'dim', ` ${n.detail}`));
    list.append(li);
  }
  box.append(list);
  root.append(box);
}

/** T050：启动中 —— 列出尚未就绪的边界，且不说"须处置"。 */
function renderStarting(s, root) {
  const waiting = s.nodes.filter((n) => ['bootstrapping', 'starting'].includes(n.state));
  if (waiting.length === 0) return;

  const copy = tierCopy(s);
  const box = el('div', 'starting-block');
  if (s.tier === 'starting') {
    box.append(el('div', 'starting-title', `${copy.symbol} ${copy.label}`));
    box.append(el('div', null, copy.body));
    box.append(el('div', 'dim', copy.action));
  } else {
    box.append(el('div', 'starting-title', `有节点正在就位（${waiting.length}）`));
    box.append(el('p', 'note',
      '这些节点还在引导或启动 —— 要等，不是故障。链目前不受影响。'));
  }

  const domains = [...new Set(waiting.map((n) => n.domain))];
  const list = el('ul', 'fault-list');
  for (const d of domains) {
    const ids = waiting.filter((n) => n.domain === d);
    const li = el('li');
    li.append(el('b', null, d));
    li.append(document.createTextNode(
      `：${ids.map((n) => `${n.id}（${STATE_COPY[n.state] ?? n.state}）`).join('、')}`,
    ));
    const detail = ids.find((n) => n.detail)?.detail;
    if (detail) li.append(el('span', 'dim', ` ${detail}`));
    list.append(li);
  }
  box.append(list);
  root.append(box);
}

/**
 * T049：各节点说法不一致时，呈现**各节点各自的数值**，不合并为单一结论（FR-023）。
 *
 * 高度不一致在活链上很常见（传播尾巴）。合并成一个"网络高度"再报警，会把一次正常的
 * 传播延迟说成故障；而完全不显示差异，又会让真正的落后无从发现。
 * 所以：显示分歧本身，并说明它通常是什么。
 */
function renderDisagreement(s, root) {
  const serving = s.nodes.filter((n) => n.height != null);
  const heights = [...new Set(serving.map((n) => n.height))];
  if (heights.length <= 1) return;

  const box = el('div', 'disagree-block');
  box.append(el('div', 'disagree-title', `各节点报出的高度不一致（${heights.length} 种说法）`));
  box.append(el('p', 'note',
    '这通常是正常的传播尾巴，不是故障 —— 面板不把它合并成一个结论，'
    + '而是把各节点各自的数值摆出来。真正需要注意的是长期落后不追平的节点。'));

  const list = el('ul', 'fault-list');
  for (const h of [...heights].sort((a, b) => b - a)) {
    const ids = serving.filter((n) => n.height === h).map((n) => n.id);
    list.append(el('li', null, `高度 ${h}：${ids.join('、')}`));
  }
  box.append(list);
  root.append(box);
}

export function render(snapshot, root) {
  root.replaceChildren();

  const o = snapshot.observer ?? {};
  const line = el('div', 'observer-line');
  line.append(el('b', null, `本机可达 ${o.reachableNodes ?? '—'} / ${o.totalNodes ?? '—'} 个节点`));
  line.append(el('span', 'dim',
    '　—— 这是**本机**的视角。它与链是否可用是两件事：本机连不上某个节点，'
    + '可能是那个节点坏了，也可能只是本机到它的路径断了。'));
  root.append(line);

  if (o.blind) {
    renderBlind(snapshot, root);
    return;                       // 失明时其余分块无意义（什么都没探到）
  }

  renderLocalPathFaults(snapshot, root);
  renderStarting(snapshot, root);
  renderDisagreement(snapshot, root);

  if (root.children.length === 1) {
    root.append(el('p', 'note', '本机能看见全部节点，各节点说法一致 —— 无观测层面的问题。'));
  }
}
