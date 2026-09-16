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
  'members-unknown': {
    label: '成员集合未知',
    body: '读不到链上的验证者成员集合，因此**无法判断容错余量** —— '
        + '本页面不会拿声明里的成员数去凑一个结论。'
        + '链本身可能完全正常：这一档说的是"我们看不见"，不是"链坏了"。',
    action: '先看 RPC 入口是否可达（npm run membership:status 会给出同样的读取）。'
          + '成员集合读通之后，余量判定会自动恢复。',
    severity: 'attention',
    symbol: '◆',
  },
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

  if (tier === 'members-unknown') {
    // 刻意**不给数值** —— 这一档的全部意思就是算不出来。
    // 拿声明的成员数去填一个余量，正是 research V-31 那个假警报的成因。
    return { ...base, detail: null };
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
  'recovery-blocked': {
    label: '恢复能力已丧失',
    action: '先把两个 Primary 都启动 —— 只起一个不够。在那之前不要重启任何验证者。',
  },
  // **标签里要有"不是故障"**：这一类最容易被当成红灯。
  // 它出现的典型时刻是一次正常的成员变更进行中 —— 加入还没走完，或者
  // 已经退出但声明还没清理。处置方向与 node-infra 相反：不要去动那台机器。
  // 一个分类覆盖 FR-030 的三种漂移，因为**处置的第一步是同一句**：先分清是哪一种。
  // 三种的后续处置写在这条 action 里，而不是拆成三个分类 ——
  // 拆开的话三条 action 的第一句会完全重复，而"分类若不改变处置就不该存在"。
  membership: {
    label: '声明与链上的成员集合不一致（非故障）',
    action: '**都不是故障**：正在加入、已被主动移除，或有人绕过工具改了链上。'
      + '先跑 npm run membership:status 分清是哪一种 —— '
      + '声明里有、链上没有 → 续注册或清理声明；'
      + '链上有、声明里没有 → 补进 deployment.json 的 validators.nodes[]，或把它退出。',
  },
  // 处置在**仓库里**，不在机房里 —— 这一点要和 node-infra 明确分开。
  // 去那台机器上看节点是徒劳的：节点本身没坏，是声明把太多验证者放到了一起。
  'topology-limit': {
    label: '故障边界越界（声明问题）',
    action: '改 blockchain/deployment.json 的故障边界划分：把超出的验证者挪到别的边界，'
      + '或增加边界数量。改完跑 scripts/devnet-topology 复核 —— 节点本身不用动。',
  },
  // **这一类否掉的是页面上其它数字的可信度**，所以它的处置是"先别信那些数"。
  'tolerance-basis': {
    label: '余量判据的前提不成立',
    action: '链上成员权重不等，⌊n/4⌋ 算不出正确的余量 —— 先用 npm run membership:status '
      + '看清各成员的权重并让它们一致。在那之前不要拿"还能掉几个"做决定。',
  },
});

/**
 * 恢复能力的文案 —— **与三档健康度正交**的一个维度。
 *
 * ## 它要说的不是事实，是后果
 *
 * 面板早就把 `primary-1 = 已停止` 显示出来了 —— **事实是可见的**。
 * 缺的是那两条合起来意味着什么：
 *
 * > 此刻任何一个 L1 验证者一旦重启，就**再也回不来**。
 *
 * 2026-09-10 实测：两个 Primary 全停、五个验证者都健康、面板报 `normal / 100%`
 * 的状态下重启 l1-1，它 5 分钟内 P 链引导毫无进展，L1 那条链在该节点上
 * **根本没被创建**。而"重启一下试试"恰好是最本能的运维动作 ——
 * **事实可见、后果不可见，是最容易出事的组合。**
 *
 * ## 三个不能少的成分（每个对应一次实测）
 *
 * 1. **「两个」** —— 起一个不够。只起回 primary-1 之后 l1-1 仍然卡着，
 *    它自报 `percentConnected: 0.5`，而门槛是 80%。
 * 2. **「不要重启任何验证者」** —— 那是这条提示存在的全部理由。
 * 3. **顺序** —— 先 Primary 再验证者，与 `docs/devnet.md` §9.5 一致（有守卫）。
 *
 * ## 刻意**不写**否定句
 *
 * 不写"不会丢数据"、"不需要重置"这类话，尽管它们都是真的。
 * 否定式对子串守卫天然敌对：003 期间 `starting` 的文案写了
 * 「也不是"须处置"」，那个词触发了一条子串断言 ——
 * **当时的处理是改文案，不是改守卫**。这里正面说"恢复后自动追上"。
 *
 * ## 它不是报警
 *
 * 链在出块。做成红色报警会稀释「链已停止出块」那一档的含义 ——
 * 003 期间为此删掉过一条会误报的守卫，理由记在那边：
 * **"噪音会让人开始忽略红灯。"**
 *
 * @param {{recoveryCapability?: string, primariesRequiredForRejoin?: number}} snapshot
 * @returns {{severity:string,symbol:string,label:string,body:string,action:string}|null}
 *   `null` = 不呈现（`ok` 或 `unknown`）
 */
export function recoveryCopy(snapshot) {
  if (snapshot?.recoveryCapability !== 'blocked') return null;
  const need = snapshot.primariesRequiredForRejoin ?? 2;
  return {
    // 与停摆报警的 critical 区分开：显目，但不是活性紧急事件
    severity: 'attention',
    symbol: '◆',
    label: '恢复能力已丧失',
    body: `链仍按上面的档位出块，但此刻**任何 L1 验证者一旦重启都无法重新加入** ——`
        + `它要先引导 P 链，而 P 链引导要求连上足够的权益，`
        + `${need} 个 Primary 各握一部分，少一个就到不了门槛。`
        + '已经在跑的验证者不受影响；卡住的那个在两个 Primary 都回来后自行追上。',
    action: `先把 ${need} 个 Primary 都启动 —— 只起一个不够。在那之前不要重启任何验证者。`,
  };
}

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
