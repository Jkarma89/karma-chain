// tools/dashboard/public/view-public.mjs —— 对外精简视图（功能 003 / US6 / T067）。
//
// 由 `?view=public` 触发。它**只消费 `/api/public`** 这个已投影过的端点，
// 而不是从完整快照里自己挑字段 —— 那样等于在前端又实现了一遍白名单，
// 而前端的那一份不会被 `tests/unit/dashboard-public-view.test.mjs` 的三层守卫覆盖。
//
// 于是泄漏面只有一处（`tools/dashboard/public-view.mjs`），并且那一处有行为探针守着。
//
// ## 当下的实际用途
//
// ADR 里「公开可访问的 RPC 端点」仍是未解决的开放决策 —— 公网上目前没有可供第三方
// 访问的端点。所以这个视图现在的用途是：**可以把这个页面截图或投屏给外部看，
// 而不泄漏内部事实**。它还不是"第三方自己来访问"。
import { tierCopy } from './copy.mjs';

export const meta = { id: 'public', title: 'KarmaChain 状态', order: 1 };

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

let cache = null;

/**
 * 精简视图刻意**另发一次请求**取 `/api/public`，不复用传进来的完整快照。
 * 理由见文件头：只让泄漏面存在一处。
 */
async function refresh() {
  try {
    const res = await fetch('/api/public', { cache: 'no-store' });
    if (res.ok) cache = await res.json();
  } catch { /* 保留上一次；顶栏的新鲜度会标明陈旧 */ }
}

function draw(root) {
  root.replaceChildren();
  if (!cache || cache.tier == null) {
    root.append(el('p', 'note', '采集中…'));
    return;
  }

  // 档位文案需要几个只在内部快照里的数字（余量、门槛）——
  // 精简视图没有它们，因此只用 label 与 severity，不拼具体数字。
  const copy = tierCopy({ tier: cache.tier, observer: {} });

  const box = el('div', `tier tier--${copy.severity}`);
  box.append(el('div', 'symbol', copy.symbol));
  box.append(el('div', 'percent', `${cache.healthPercent}%`));
  box.append(el('div'));
  box.append(el('div', 'label', copy.label));
  root.append(box);

  const dl = el('dl', 'facts');
  const row = (k, v, cls) => { dl.append(el('dt', null, k)); dl.append(el('dd', cls, v)); };
  row('Chain ID', String(cache.chainId ?? '—'), 'mono');
  row('Network ID', String(cache.networkId ?? '—'), 'mono');
  row('链别名', cache.chainAlias ?? '—', 'mono');
  row('RPC 路径', cache.rpcPath ?? '—', 'mono');
  row('公开主机', (cache.publishedHosts ?? []).join('、') || '—', 'mono');
  row('当前高度', cache.networkHeight == null ? '—' : String(cache.networkHeight), 'mono');
  root.append(dl);

  root.append(el('p', 'note',
    'KarmaChain 按需出块：没有交易就没有区块，高度长时间不变是正常的。'
    + '健康度是"参与共识的验证者占声明总数的比例"。'));
}

export function render(_snapshot, root) {
  draw(root);
  // 首次渲染时立刻取一次，之后跟着 app.mjs 的节奏走
  refresh().then(() => draw(root));
}
