// tools/dashboard/public/copy.mjs —— 全部档位与状态的文案（功能 003 / T030）。
//
// **零 import 的纯模块**，浏览器与 Node 共用同一份。
//
// ## 为什么文案要单独成一个模块
//
// FR-008 / FR-020 / SC-006 的判据本质是**"文案里不得出现某些话"**：
//
//   - `zero-margin` 必须说"链仍在正常出块"，不得出现"链已停止"
//   - `observer-blind` 全程不得出现"链已停止"
//   - `stopped` 不得写"数据可能丢失""需要重置"（002 已证明恢复不需要重置）
//
// 这类要求**不会自己报错**。把文案埋在渲染函数里就测不到，于是只剩一个不会变红的守卫。
// 抽出来之后 `tests/unit/dashboard-copy.test.mjs` 才能逐档位断言必含与禁止短语。
//
// 判据来源：specs/003-chain-health-dashboard/contracts/health-tier.md 第 6 节。

/** 静态骨架 —— 不含具体数字，供测试断言必含/禁止短语。 */
export const TIER_COPY = Object.freeze({
  normal: {
    label: '正常',
    body: '链正在正常出块，容错余量充足 —— 还可容忍若干个验证者离线。',
    action: '无需处置。',
    severity: 'ok',
    symbol: '●',
  },
  'zero-margin': {
    label: '高危：零余量',
    body: '链仍在正常出块，但容错余量已经为 0 —— 再有一个验证者离线就会停摆。',
    action: '尽快恢复离线的验证者。链现在可用，但没有任何冗余了。',
    severity: 'warn',
    symbol: '▲',
  },
  stopped: {
    label: '链已停止出块',
    body: '在线验证者的连接权益低于共识的查询门槛，链已停止出块。'
        + '这是**安全停摆**：不分叉、区块零回滚，验证者恢复后自动继续。',
    action: '恢复验证者数量即可 —— 恢复到门槛以上就会自动继续出块。',
    severity: 'critical',
    symbol: '■',
  },
  starting: {
    label: '启动中',
    body: '部分验证者尚未完成引导，还在等其余故障边界就位 —— 链还没开始出块。',
    // 刻意不写「也不是"须处置"」这种否定式措辞：守卫做的是子串匹配，
    // 否定句会被它抓住，而这句话去掉那个词一点信息都不损失。
    action: '等待。这不是故障 —— 先起来的机器上无可处置之处，动它反而有害。',
    severity: 'waiting',
    symbol: '◌',
  },
  'observer-blind': {
    label: '失去观测能力',
    body: '本机连不上任何节点 —— 面板无法判断链的状态。'
        + '注意这**不等于**链有问题：面板自己看不见，与链是否可用是两件事。',
    action: '先检查本机的网卡与交换机。',
    severity: 'unknown',
    symbol: '?',
  },
});

const FALLBACK = Object.freeze({
  label: '未知档位',
  body: '出现了一个本页面还不认识的档位取值 —— 请对照 contracts/health-tier.md 检查。',
  action: '把该取值补进 copy.mjs，或核对判定层是否引入了新档位。',
  severity: 'unknown',
  symbol: '?',
});

const plural = (n) => `${n} 个`;

/**
 * 按快照填入具体数字。
 *
 * **不做任何判定** —— `tier` / `healthPercent` / 两个余量全部取自快照。
 * 这里只把它们组织成人话。
 */
export function tierCopy(snapshot) {
  const base = TIER_COPY[snapshot.tier] ?? FALLBACK;
  const {
    tier, validatorMargin, domainMargin, participating, threshold, observer,
  } = snapshot;

  if (tier === 'normal') {
    return {
      ...base,
      body: `链正在正常出块。还可容忍 ${plural(validatorMargin)}验证者离线`
          + `，或 ${plural(domainMargin)}故障边界整体失效。`,
    };
  }

  if (tier === 'zero-margin') {
    return {
      ...base,
      body: '链仍在正常出块，但容错余量已经为 0 —— 再有一个验证者离线就会停摆。',
      action: `尽快恢复离线的验证者。当前参与共识 ${participating} 个，`
            + `恰好等于查询门槛 ${threshold} 个。`,
    };
  }

  if (tier === 'stopped') {
    const need = Math.max(1, threshold - participating);
    return {
      ...base,
      body: `在线验证者的连接权益低于共识的查询门槛（参与 ${participating} 个，`
          + `门槛 ${threshold} 个），链已停止出块。`
          + '这是安全停摆：不分叉、区块零回滚，验证者恢复后自动继续。',
      action: `至少再恢复 ${plural(need)}验证者 —— 到门槛以上会自动继续出块。`,
    };
  }

  if (tier === 'starting') {
    const waiting = Math.max(0, threshold - participating);
    return {
      ...base,
      body: `部分验证者尚未完成引导，还在等其余故障边界就位 —— 链还没开始出块。`
          + `当前参与共识 ${participating} 个，还差 ${plural(waiting)}到达门槛 ${threshold} 个。`,
    };
  }

  if (tier === 'observer-blind') {
    const alive = (observer?.pathAlive ?? []).filter((p) => p.alive);
    return {
      ...base,
      body: alive.length > 0
        ? `本机连不上任何节点，但到 ${plural(alive.length)}机器的网络路径是通的`
          + ' —— 节点确实不应答，链可能真的停了，也可能是节点进程的问题。'
          + '面板在这种观测下不会替你断言链停了。'
        : '本机连不上任何节点，各机器的对外端口也全部无应答'
          + ' —— 更像本机网络问题。面板自己看不见，与链是否可用是两件事。',
      action: alive.length > 0
        ? '到那几台机器上确认节点进程。'
        : '先检查本机的网卡与交换机。',
    };
  }

  return base;
}

/** 异常五分类的文案与处置方向（宪法第九条：分类决定处置）。 */
export const INCIDENT_COPY = Object.freeze({
  observation: {
    label: '观测故障',
    action: '修本机到该节点的网络路径 —— 链是好的，别去动那台机器，问题不是节点。',
  },
  'node-infra': {
    label: '单节点基础设施故障',
    action: '到那台机器上查节点进程、数据卷与挂载的密钥。',
  },
  'sync-lag': {
    label: '节点同步落后',
    action: '等。这不是故障。',
  },
  'consensus-margin': {
    label: '共识容错余量不足',
    action: '恢复验证者数量 —— 这不是修某一个节点能解决的。',
  },
  'chain-identity': {
    label: '链身份不一致',
    action: '那台机器跑在另一条链上 —— 核对它的创世文件与协议参数。',
  },
});

/** 节点状态的中文标签。取值集合与既有 ALL_STATES 一致，不增删。 */
export const STATE_COPY = Object.freeze({
  healthy: '正常',
  'catching-up': '追赶中',
  bootstrapping: '引导中',
  starting: '启动中',
  stopped: '已停止',
  stalled: '卡住',
  unreachable: '不可达',
  'identity-mismatch': '身份不符',
  'data-corrupt': '数据不一致',
});

/** 常驻说明 —— 每个第一次看面板的人都会问"高度为什么不动"。 */
export const ON_DEMAND_BLOCKS_NOTE =
  'KarmaChain 按需出块：没有交易就没有区块。**高度长时间不变是正常的**，'
  + '不是活性故障信号 —— 判断链是否可用要看参与共识的验证者数与查询门槛的关系。';

/** 推断 vs 实测的区别（FR-036）—— 不得把前者说成后者。 */
export const LIVENESS_KINDS = Object.freeze({
  inferred: {
    label: '推断',
    body: '由参与共识的验证者数与查询门槛比较得出"应当能出块"。自动、持续、只读。',
  },
  measured: {
    label: '实测',
    body: '由一笔真实交易验证"确实能出块"。人工触发、一次性，会向链写入。',
  },
});
