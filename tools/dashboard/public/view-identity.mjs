// tools/dashboard/public/view-identity.mjs —— 链身份与分叉警报（功能 003 / US5）。
//
// 归属：T060（链身份区）、T061（分叉警报）。
//
// ## 为什么分叉警报与档位**并列**，而不是档位的一档
//
// 一个创世哈希与基准不符的节点自己活得很好：已引导、在出块、peers 正常。
// 健康度可以是 100% —— 它只是**不在同一条链上**。
//
// 把它折进健康度会得出自相矛盾的呈现；当成节点故障又会指错处置方向
// （去重启一台运行正常的机器）。所以它是一条独立的维度。
//
// 而 `genesisMatchesBaseline === null`（未取到）**不触发**警报，只登记为"未知" ——
// 分叉是比下线严重得多的警报，虚报一次之后就没人信它了。
import { INCIDENT_COPY } from './copy.mjs';

export const meta = { id: 'identity', title: '链身份', order: 5 };

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const short = (hash) => (hash ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : '—');

function renderFacts(s, root) {
  const id = s.chainIdentity ?? {};
  const dl = el('dl', 'facts');
  const row = (k, v, cls) => {
    dl.append(el('dt', null, k));
    dl.append(el('dd', cls, v));
  };
  row('Chain ID', String(id.chainId ?? '—'), 'mono');
  row('Network ID', String(id.networkId ?? '—'), 'mono');
  row('链别名', id.chainAlias ?? '—', 'mono');
  row('blockchainID', id.blockchainId ?? '—', 'mono dim');
  row('基准创世哈希', id.baselineGenesisHash ?? '—', 'mono dim');
  row('当前高度', s.networkHeight == null ? '—' : String(s.networkHeight), 'mono');
  root.append(dl);
}

/** T061：分叉警报 —— 显目列出与基准不一致的节点及其自报哈希。 */
function renderFork(s, root) {
  const id = s.chainIdentity ?? {};
  const mismatched = s.nodes.filter((n) => n.genesisMatchesBaseline === false);

  if (id.forkDetected && mismatched.length > 0) {
    const copy = INCIDENT_COPY['chain-identity'];
    const box = el('div', 'fork-banner');
    box.append(el('div', 'fork-title', `■ 链身份不一致（${mismatched.length}）`));
    box.append(el('p', null,
      '以下节点自报的创世区块哈希与仓库基准**不同** —— 它们跑在另一条链上。'
      + '注意这**不会**表现为健康度下降：那些节点自己活得很好。'));
    const list = el('ul', 'fault-list');
    for (const n of mismatched) {
      const li = el('li');
      li.append(el('b', 'mono', n.id));
      li.append(document.createTextNode(`（${n.domain}）自报 `));
      li.append(el('span', 'mono', short(n.genesisHash)));
      li.append(document.createTextNode(`，基准 `));
      li.append(el('span', 'mono', short(id.baselineGenesisHash)));
      list.append(li);
    }
    box.append(list);
    box.append(el('div', 'fork-action', `处置：${copy.action}`));
    root.append(box);
    return;
  }

  // 未取到 ≠ 不匹配 —— 如实说"有节点没取到"，但不报分叉
  if (id.unknownGenesis) {
    const unknown = s.nodes.filter((n) => n.countsTowardTolerance && n.reachable
      && n.genesisMatchesBaseline === null);
    const box = el('div', 'unknown-genesis');
    box.append(el('div', 'unknown-title', `创世哈希未取到（${unknown.length}）`));
    box.append(el('p', 'note',
      '这些节点可达但取不到创世区块 —— **这不等于分叉**，只是本轮没拿到那个事实。'
      + '面板刻意不把"未知"当成"不匹配"：虚报一次分叉，之后就没人信这条警报了。'));
    box.append(el('ul', 'fault-list'));
    for (const n of unknown) box.lastChild.append(el('li', 'mono', `${n.id}（${n.domain}）`));
    root.append(box);
    return;
  }

  const ok = s.nodes.filter((n) => n.genesisMatchesBaseline === true);
  root.append(el('p', 'note',
    `● ${ok.length} 个 L1 验证者自报的创世哈希均与仓库基准一致 —— 没有分叉。`
    + '（Primary 节点不服务 L1，取不到 L1 创世，属正常。）'));
}

export function render(snapshot, root) {
  root.replaceChildren();
  renderFacts(snapshot, root);
  renderFork(snapshot, root);
}
