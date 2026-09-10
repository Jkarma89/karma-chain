// tools/dashboard/public/app.mjs —— 装配与轮询（功能 003 / T029）。
//
// **只做三件事**：轮询 `/api/snapshot`、按 `?view=` 路由、装配 DOM。
//
//   - 不做任何判定 —— 档位、百分比、两个余量、异常分类全部取自快照
//   - 不直连节点 —— 只访问本服务的路径
//   - 不持有密钥 —— 探活经 POST /api/probe
//   - **不渲染任何具体视图** —— 那些在 view-*.mjs 里
//
// 最后一条是刻意的。原先的任务清单让 14 条任务横跨全部六个用户故事去改同一个 app.mjs，
// 与"同一文件的任务必须串行"直接冲突，六个故事根本无法并行。
// 现在每个故事只碰自己那一个 view-*.mjs。
import { ON_DEMAND_BLOCKS_NOTE } from './copy.mjs';

/**
 * 视图模块的固定清单。**在此一次性声明齐全**，后续用户故事只需新增对应文件 ——
 * 缺哪个就跳过哪个，不必回来改本文件。
 *
 * 每个模块导出：`export const meta = { id, title, order }` 与 `export function render(snapshot, el)`。
 */
const VIEW_NAMES = [
  'view-health',    // US1：百分比、档位、两个余量、新鲜度、探活
  'view-nodes',     // US2：节点表、Primary 分组
  'view-observer',  // US3：本机视角不可达、失去观测能力、说法不一致、启动中
  'view-domains',   // US4：故障边界、两个余量的成因、异常四类
  'view-identity',  // US5：链身份、分叉警报
];
const PUBLIC_VIEW = 'view-public'; // US6：?view=public 的精简渲染

const POLL_MS = 1000;              // 读的是服务端内存里的快照，不触发新一轮探测
const $ = (id) => document.getElementById(id);

/** 动态加载视图模块；文件还不存在（后续故事才写）就静默跳过。 */
async function loadViews(names) {
  const mods = [];
  for (const name of names) {
    try {
      const mod = await import(`./${name}.mjs`);
      if (typeof mod.render === 'function') mods.push({ name, ...mod });
    } catch {
      // 该视图尚未实现 —— 面板照常显示其余部分，不因此空白
    }
  }
  return mods.sort((a, b) => (a.meta?.order ?? 99) - (b.meta?.order ?? 99));
}

/** 为每个视图建一个 <section>，返回 name → element。 */
function mountViews(mods, root) {
  const els = new Map();
  for (const mod of mods) {
    const section = document.createElement('section');
    section.className = 'card';
    section.dataset.view = mod.name;
    if (mod.meta?.title) {
      const h = document.createElement('h2');
      h.textContent = mod.meta.title;
      section.append(h);
    }
    const body = document.createElement('div');
    section.append(body);
    root.append(section);
    els.set(mod.name, body);
  }
  return els;
}

/**
 * 新鲜度（T031 / FR-021）。
 *
 * 三档：正常 / 超过 3 倍轮询间隔标为陈旧 / 取不到快照。
 * **不得**空白或静默保留旧画面 —— 既有 `readContainers()` 的注释把理由说到位了：
 * 「过期的事实比没有事实更坏：它看起来像证据，而且恰好把判定推向错误的分支」。
 */
function renderFreshness(el, snapshot, lastError) {
  if (lastError) {
    el.classList.add('stale');
    el.textContent = `取不到快照（${lastError}）—— 下方显示的是最后一次成功采集的结果，不是当前状态`;
    return;
  }
  if (!snapshot || snapshot.collectedAt == null) {
    el.classList.remove('stale');
    el.textContent = '首次采集中…';
    return;
  }
  const ageMs = Date.now() - snapshot.collectedAt;
  const interval = snapshot.pollIntervalMs || 2000;
  const secs = Math.max(0, Math.round(ageMs / 1000));
  if (ageMs > interval * 3) {
    el.classList.add('stale');
    el.textContent = `数据已陈旧：采集于 ${secs} 秒前（轮询间隔 ${interval / 1000}s）—— 这不是当前状态`;
  } else {
    el.classList.remove('stale');
    el.textContent = `采集于 ${secs} 秒前 · 形态 ${snapshot.deployment} · 轮询 ${interval / 1000}s`;
  }
}

async function main() {
  const isPublic = new URL(location.href).searchParams.get('view') === 'public';
  $('on-demand-note').textContent = ON_DEMAND_BLOCKS_NOTE.replace(/\*\*/g, '');
  if (isPublic) {
    // 精简视图不显示页脚里那段"面板是只读旁观者"的内部说明
    document.querySelectorAll('.note.small').forEach((n) => n.remove());
  }

  const mods = await loadViews(isPublic ? [PUBLIC_VIEW] : VIEW_NAMES);
  const els = mountViews(mods, $('views'));

  if (mods.length === 0) {
    $('views').textContent = isPublic
      ? '精简视图尚未实现（view-public.mjs）。'
      : '尚无可用视图模块 —— view-*.mjs 还没实现。';
  }

  let snapshot = null;
  let lastError = null;

  const tick = async () => {
    try {
      const res = await fetch('/api/snapshot', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      snapshot = await res.json();
      lastError = null;
    } catch (err) {
      // 保留上一次的快照，但**必须**在新鲜度里标明它不是当前状态
      lastError = String(err.message ?? err);
    }

    renderFreshness($('freshness'), snapshot, lastError);
    if (!snapshot || snapshot.collectedAt == null) return;

    for (const mod of mods) {
      try {
        mod.render(snapshot, els.get(mod.name));
      } catch (err) {
        // 一个视图渲染失败不该让整块面板空白
        els.get(mod.name).textContent = `此视图渲染失败：${String(err.message ?? err)}`;
      }
    }
  };

  await tick();
  setInterval(tick, POLL_MS);
  // 新鲜度要在两次 tick 之间也走字，否则"N 秒前"看起来像卡住了
  setInterval(() => renderFreshness($('freshness'), snapshot, lastError), 1000);
}

main();
