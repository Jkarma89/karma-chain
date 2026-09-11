// tools/dashboard/public/view-health.mjs —— 健康度主视图（功能 003 / US1）。
//
// 归属：T029a（骨架）、T031（新鲜度已在 app.mjs 顶栏，这里补降级告知）、
//       T034（探活按钮）、T035（推断 vs 实测）、T020 的呈现侧。
//
// **不做任何判定** —— tier / healthPercent / 两个余量 / incidents 全部取自快照。
// 文案全部来自 copy.mjs（那样才测得到"不得出现某些话"，见 tests/unit/dashboard-copy）。
import { tierCopy, recoveryCopy, LIVENESS_KINDS } from './copy.mjs';

export const meta = { id: 'health', title: '链健康度', order: 1 };

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/** 探活的界面状态只活在本模块内 —— 它不属于快照。 */
const probe = { asking: false, running: false, result: null };

function renderTier(s, root) {
  const copy = tierCopy(s);
  const box = el('div', `tier tier--${copy.severity}`);

  box.append(el('div', 'symbol', copy.symbol));
  box.append(el('div', 'percent', `${s.healthPercent}%`));
  box.append(el('div'));                       // 占位，让 label 落在第二列
  box.append(el('div', 'label', copy.label));
  box.append(el('div', 'body', copy.body));
  if (copy.action) box.append(el('div', 'action', copy.action));
  root.append(box);
}

/**
 * 恢复能力 —— **与档位正交**的一条（功能 004）。
 *
 * ## 为什么它在档位下面、余量上面
 *
 * 读的顺序应当是「链现在怎么样 → 有件事你现在不能做 → 还剩多少余量」。
 * 放到最下面会被余量和节点表挤走，而它要防的恰好是一个**本能动作**
 * （看到 Primary 停了就去重启点什么）—— 那个动作发生在人往下滚之前。
 *
 * ## 为什么版式与停摆报警不同
 *
 * 链在出块。做成同样的红框会**稀释**「链已停止出块」那一档的含义 ——
 * 003 期间为此删掉过一条会误报的守卫，理由记在那边："噪音会让人开始忽略红灯。"
 *
 * 所以它是：左侧粗竖条 + 自己的字形（◆）+ 自己的色（warn 而非 critical），
 * 三个通道都与 critical 有区别，而不是只换个颜色（FR-009 / FR-021）。
 *
 * `ok` 与 `unknown` 时 `recoveryCopy()` 返回 null —— 不呈现，无噪音。
 */
function renderRecovery(s, root) {
  const copy = recoveryCopy(s);
  if (!copy) return;

  const box = el('div', `recovery recovery--${copy.severity}`);
  const head = el('div', 'recovery-head');
  head.append(el('span', 'recovery-symbol', copy.symbol));
  head.append(el('span', 'recovery-label', copy.label));
  box.append(head);
  box.append(el('div', 'recovery-body', copy.body));
  box.append(el('div', 'recovery-action', copy.action));
  root.append(box);
}

function renderMargins(s, root) {
  const wrap = el('div', 'margins');

  const item = (n, kind, note) => {
    const d = el('div', `margin-item${n === 0 ? ' zero' : ''}`);
    d.append(el('span', 'n', String(n)));
    d.append(el('span', 'k', kind));
    if (note) d.append(el('span', 'note', note));
    return d;
  };

  wrap.append(item(s.validatorMargin, '个验证者余量',
    `参与共识 ${s.participating} / ${s.validatorCount}，查询门槛 ${s.threshold}`));

  // 两个余量必须并列显示，且不同时说明成因（FR-010）——
  // 若两个验证者挤到同一台机器，验证者级余量仍是 1，但边界级余量是 0。只看前者会高估冗余。
  const domainNote = s.domainMargin === s.validatorMargin
    ? `${s.faultTolerance.effectiveDomainCount} 个有效故障边界`
    : `与验证者余量不同：某个边界承载的验证者数超过了可容忍的 ${s.faultTolerance.maxOfflineValidators} 个，`
      + '那台机器一挂就会同时失去多个';
  wrap.append(item(s.domainMargin, '个边界余量', domainNote));

  root.append(wrap);
}

function renderDegraded(s, root) {
  // T020 / FR-030：容器事实是可选增强，但降级必须**可见**，不静默接受
  if (!s.containerFacts?.degraded) return;
  const d = el('div', 'degraded');
  d.append(el('strong', null, '观测降级：'));
  d.append(document.createTextNode(s.containerFacts.note ?? ''));
  root.append(d);
}

function renderProbe(s, root) {
  const box = el('div', 'probe');

  // T035 / FR-036：两类活性判断必须分清，**不得**把推断说成实测
  const liveness = el('div', 'liveness');
  const line = (kind, extra) => {
    const d = el('div');
    d.append(el('b', null, `${kind.label}：`));
    d.append(document.createTextNode(`${kind.body}${extra ?? ''}`));
    return d;
  };
  liveness.append(line(LIVENESS_KINDS.inferred, ` 当前结论：${tierCopy(s).label}。`));
  liveness.append(line(
    LIVENESS_KINDS.measured,
    probe.result
      ? ''
      : ' 尚未实测 —— 面板不会替你断言"确实能出块"。',
  ));
  box.append(liveness);

  if (probe.result) {
    const r = probe.result;
    const line2 = el('div', `probe-result ${r.confirmed ? 'ok' : 'bad'}`);
    if (r.confirmed) {
      line2.textContent = `实测：交易已确认，区块 ${r.blockNumber}，耗时 ${(r.elapsedMs / 1000).toFixed(1)}s`;
    } else if (r.busy) {
      line2.textContent = r.error;
    } else {
      line2.textContent = `实测：交易未能确认 —— ${r.error ?? '原因未知'}`;
    }
    if (r.txHash) {
      const h = el('span', 'mono', `  ${r.txHash.slice(0, 14)}…`);
      line2.append(h);
    }
    box.append(line2);
  }

  if (!probe.asking) {
    const btn = el('button', null, probe.running ? '探活中…' : '立即探活');
    btn.disabled = probe.running;
    btn.addEventListener('click', () => { probe.asking = true; rerender(s); });
    box.append(btn);
  } else {
    // FR-035：触发前必须告知它会向链写入
    const warn = el('div', 'probe-warning');
    warn.append(el('strong', null, '这会向链写入：'));
    warn.append(document.createTextNode(
      '发一笔真实交易 —— 消耗开发账户余额，并产生一个新区块。'
      + '产生的区块会让"高度"不再只反映真实业务活动，所以只在需要确认时点它。',
    ));
    const actions = el('div', 'probe-actions');
    const go = el('button', null, '确认发送');
    const no = el('button', null, '取消');
    go.addEventListener('click', async () => {
      probe.asking = false;
      probe.running = true;
      rerender(s);
      try {
        const res = await fetch('/api/probe', { method: 'POST' });
        probe.result = await res.json();
      } catch (err) {
        probe.result = { confirmed: false, error: String(err.message ?? err) };
      } finally {
        probe.running = false;
        rerender(s);
      }
    });
    no.addEventListener('click', () => { probe.asking = false; rerender(s); });
    actions.append(go, no);
    warn.append(actions);
    box.append(warn);
  }

  root.append(box);
}

let lastRoot = null;

function draw(s, root) {
  root.replaceChildren();
  renderTier(s, root);
  renderRecovery(s, root);
  renderMargins(s, root);
  renderDegraded(s, root);
  renderProbe(s, root);
}

/** 探活的界面状态变化不等下一次轮询，立即重画。 */
function rerender(s) {
  if (lastRoot) draw(s, lastRoot);
}

export function render(snapshot, root) {
  lastRoot = root;
  draw(snapshot, root);
}
