// tests/e2e/lib/devnet.mjs —— 崩溃恢复类 e2e 的共用操作（功能 002）。
//
// 这些测试只通过**对外接口**操作开发网：scripts/devnet-* 与 RPC。
// 不直接读节点内部状态 —— 否则测的就不是"用户能观察到的恢复"了。
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, http, defineChain, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { REPO_ROOT, loadProtocol, deriveTopology } from '../../../tools/protocol/load.mjs';
import { findPosixShell, skipReasonFor } from '../../../tools/test/posix-shell.mjs';

const env = Object.fromEntries(
  readFileSync(resolve(REPO_ROOT, 'docker/compose/active.env'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z]/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"|"$/g, '')]),
);

export const RPC = `http://127.0.0.1:${env.KARMACHAIN_RPC_PORT}${env.KARMACHAIN_RPC_PATH}`;
export const NODE_IDS = env.KARMACHAIN_NODE_IDS.split(' ');
export const VALIDATOR_IDS = env.KARMACHAIN_VALIDATOR_IDS.split(' ');
export const CHAIN_ID_HEX = env.KARMACHAIN_CHAIN_ID_HEX;
export const MAX_OFFLINE_VALIDATORS = Number(env.KARMACHAIN_MAX_OFFLINE_VALIDATORS ?? 0);

const info = JSON.parse(readFileSync(resolve(REPO_ROOT, 'docs/public/chain-info.json'), 'utf8'));
const acct = (label) => info.testAccounts.accounts.find((a) => a.label === label);

/**
 * 针对任意一个 RPC 入口造一套客户端。
 *
 * 为什么需要"任意入口"：整域失效的测试必须**从别的机器观测** —— 被停掉的那台机器上
 * 本地代理也随之消失，`127.0.0.1` 这条入口不存在了。而链是否继续出块只能由**存活的**
 * 边界回答。
 */
export function clientsFor(rpcUrl) {
  const chain = defineChain({
    id: info.chainId,
    name: info.name,
    nativeCurrency: info.nativeCurrency,
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const transport = http(rpcUrl, { timeout: 20_000, retryCount: 0 });
  return {
    RPC: rpcUrl,
    pub: createPublicClient({ chain, transport }),
    wallet: createWalletClient({
      account: privateKeyToAccount(acct('anvil-0').privateKey), chain, transport,
    }),
  };
}

const local = clientsFor(RPC);
export const pub = local.pub;
export const wallet = local.wallet;
export const RECIPIENT = acct('anvil-1').address;

// —— 故障边界（跨机形态才有多个）——
export const DOMAIN = process.env.KARMACHAIN_DOMAIN || env.KARMACHAIN_DEFAULT_DOMAIN;
export const DOMAIN_COUNT = Number(env.KARMACHAIN_DOMAIN_COUNT ?? 1);
/** 边界 id → 局域网地址的映射，取自 active.env 的渲染事实，不另算一遍。 */
export const DOMAIN_ADDRESSES = Object.fromEntries(
  (env.KARMACHAIN_DOMAIN_ADDRESSES ?? '').split(' ').filter(Boolean).map((pair) => {
    const i = pair.indexOf('=');
    return [pair.slice(0, i), pair.slice(i + 1)];
  }),
);

const topology = deriveTopology(loadProtocol());
/** 某个故障边界承载哪些节点 id。 */
export const nodesOfDomain = (domain) =>
  topology.topologyNodes.filter((n) => n.domain === domain).map((n) => n.id);
/** 某个故障边界承载哪些**验证者** id（Primary 节点不计入容错，研究 R-09）。 */
export const validatorsOfDomain = (domain) =>
  topology.topologyNodes.filter((n) => n.domain === domain && n.role === 'l1-validator').map((n) => n.id);
/** 该边界对外的 RPC 入口（每台机器都跑一个本地 nginx 代理，端口相同）。 */
export const rpcOfDomain = (domain) =>
  `http://${DOMAIN_ADDRESSES[domain]}:${env.KARMACHAIN_RPC_PORT}${env.KARMACHAIN_RPC_PATH}`;

// maxBuffer 给到 16MB：默认只有 1MB，而这个 helper 被大量 docker 调用复用
// （volume ls、compose ps、脚本输出…）。宁可宽裕，也不要在某台机器上因为输出偏大
// 就冒出一个与被测内容无关的 ENOBUFS。取日志仍必须显式 `--tail`，见 proxyTail。
export const sh = (cmd, args) => execFileSync(cmd, args, {
  cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
});

// —— 本机实况：故障注入只能操作**本机**的容器 ——
//
// 这一组是跨机形态逼出来的。原先各测试都按下标从全局验证者列表里挑靶子
// （`VALIDATOR_IDS[2]`、`VALIDATOR_IDS.at(-1)` 之类），单机形态下 7 个容器都在本机，
// 那样写没问题；跨机形态下 `docker kill karmachain-l1-5` 会因为 l1-5 在别的机器上而失败。
// 2026-09-09 实测：11 个 e2e 里有 6 个因此失败，全是同一个结构性原因，与实现无关。

/** 本机是否真的有这个节点的容器。 */
export const containerExists = (id) => {
  try { sh('docker', ['inspect', '--format', '{{.State.Status}}', `karmachain-${id}`]); return true; }
  catch { return false; }
};

/** 本机实际承载的节点 / 验证者（跨机形态下只有本边界那几个）。每次调用现查。 */
export const localNodeIds = () => NODE_IDS.filter(containerExists);
export const localValidatorIds = () => VALIDATOR_IDS.filter(containerExists);

/**
 * 挑本机的验证者当靶子，不够就返回 null 让调用方跳过。
 *
 * @param count 需要几个（`beyond-tolerance` 要 2 个才能超出容错上限）
 * @param requireDomainPeers 是否要求靶子所在边界**还有别的节点**。
 *   判据是"杀一个验证者 → 节点级故障而非边界缺席"时必须为真：若该边界只有它一个节点，
 *   杀掉它**确实**是整域缺席，报 `unreachable` 是对的（那属 domain-failure.test.mjs）。
 */
export function pickLocalVictims(count = 1, { requireDomainPeers = false } = {}) {
  const sizeOf = topology.topologyNodes
    .reduce((m, n) => m.set(n.domain, (m.get(n.domain) ?? 0) + 1), new Map());
  const domainOf = new Map(topology.topologyNodes.map((n) => [n.id, n.domain]));
  const usable = localValidatorIds()
    .filter((id) => !requireDomainPeers || sizeOf.get(domainOf.get(id)) >= 2)
    .reverse();          // 从后往前：靠后的验证者一般不与 Primary 同处一台
  return usable.length >= count ? usable.slice(0, count) : null;
}

/**
 * 「故障没扩散」的判据：其余验证者**是否仍在服务 L1**（网络层探测）。
 *
 * 为什么不能用"它的容器是否 running"（各测试原先的写法）：跨机形态下别的验证者在**别的
 * 机器上**，本机 `docker inspect` 返回 missing，于是测试把"看不见"当成了"挂了"。
 * 2026-09-09 实测：SC-003 的 30 分钟窗口里 30 笔交易全部确认、零交易失败，
 * 却报出 120 条"故障扩散了" —— 全是这个假阳性（30 轮 × 4 个远端验证者）。
 *
 * 换成"在不在服务 L1"同时也是**更强**的判据：容器活着但不服务，比容器不在更坏。
 *
 * @param excludeIds 不检查的节点（通常是本测试自己制造故障的靶子）
 * @returns [{ id, domain, serving, detail }]
 */
export async function validatorsServing(excludeIds = []) {
  const { probeNode, expectedNodeId } = await import('../../../tools/inspect/node-status.mjs');
  let blockchainId = null;
  try {
    blockchainId = JSON.parse(readFileSync(
      resolve(REPO_ROOT, 'blockchain/chain-identity/karmachain.identity.json'), 'utf8')).blockchainId;
  } catch { /* 尚未建链 */ }

  const targets = topology.topologyNodes
    .filter((n) => n.role === 'l1-validator' && !excludeIds.includes(n.id));
  const probes = await Promise.all(targets.map((n) => probeNode(n, blockchainId)));
  return targets.map((n, i) => ({
    id: n.id,
    domain: n.domain,
    serving: Boolean(probes[i].reachable) && probes[i].height != null,
    // 身份与对等列表**一并带出来** —— spreadProblems 要用它们向对等求证。
    // 不可达时探不到自报的 NodeID，回落到生成物里声明的那个（面板同一做法）。
    nodeId: probes[i].nodeId ?? expectedNodeId(n.id),
    peerNodeIds: probes[i].peerNodeIds ?? [],
    detail: !probes[i].reachable
      ? '不可达'
      : probes[i].height == null ? '可达但尚未服务 L1' : `服务中（高度 ${probes[i].height}）`,
  }));
}

/**
 * 故障有没有扩散到其余验证者 —— **一次探测不作数，要复核**。
 *
 * ## 为什么
 *
 * 2026-09-19 的 SC-003 三十分钟窗口：**30 笔交易全部确认**，而第 8 分钟
 * 三台不同机器（win-2、ubuntu-1、ubuntu-2）**同时**报"不可达"一次，
 * 于是整轮被判成「故障扩散了」。三台同机率挂掉的概率，远低于**观测方抖了一下**。
 *
 * 004 早就记过这个形状：「本机连不上它，但网络里其他节点与它有连接 ——
 * 是本机到它的网络路径问题，不是节点故障」。而这里是**单点、单次**探测就下结论，
 * 既不重探也不向对等求证。
 *
 * ## 修法不是放宽断言
 *
 * 「故障扩散」是一个很重的结论，而**从一次读失败得不出它**。
 * 所以把观测做到与说法一样强：只对**看起来不好的那几个**复核一次，
 * 两次都不成才算。正常路径上一次复核都不会发生（没有可疑对象就直接返回）。
 *
 * 与 dashboard-genesis-parity 那条是同一个形状：**把一次读失败当成了判决**。
 *
 * ## 复核只解决了一半（2026-09-22 补完）
 *
 * 「3 秒后再看一次」挡住了**瞬时**抖动，挡不住**持续**的观测方问题：
 * 观测方到某台机器的路径坏了五秒，两次探测都失败，于是照样断言「故障扩散了」。
 * 而 004 那条判据的另一半正是为此写的：**本机探不到 且 其余节点的对等列表里也没有**，
 * 才算它真的缺席；只是本机探不到的，是本机到它的路径问题，链里还有它。
 *
 * 所以复核之后再向**还在服务的那些节点**求证 —— 它们的对等列表里有没有这个可疑对象。
 * 四种结果分开处置：
 *
 *   证人看得见它        → 诊断，**不算失败**（观测方的路径问题）
 *   证人也看不见        → **失败**：这才是故障扩散
 *   一个证人都没有      → **失败**：不是求证不了，是验证者全都不在服务
 *   拿不到它的 NodeID   → 诊断，**求证不了就不宣布扩散**
 *
 * 最后一条是刻意的：「故障扩散」是很重的结论，**求证不了不等于确认**。
 * 把不确定当成定论，正是这条 e2e 原先的毛病 —— 而 2026-09-19 那次
 * 三台机器同时报"不可达"、30 笔交易却全部确认，就是它的代价。
 *
 * @param {number} confirmAfterMs 复核前等多久 —— 给瞬时抖动一点恢复时间
 * @param {(msg:string)=>void} onNote 诊断输出口。默认打到 stderr 并以 `#` 开头
 *        （TAP 把它当注释），**不会被静默丢掉** —— 调用方没传也看得见。
 */
export async function spreadProblems(excludeIds = [], label = '', {
  confirmAfterMs = 3_000,
  onNote = (m) => console.error(`# ${m}`),
  // 注入点**只为可测**：这四路判定是本函数的全部价值，而它原先无法单测 ——
  // 一条不会变红的判定比没有判定更坏。默认就是真探测，调用方不受影响。
  probe = validatorsServing,
} = {}) {
  const rows = await probe(excludeIds);
  const suspect = rows.filter((r) => !r.serving);
  if (!suspect.length) return [];

  await new Promise((r) => setTimeout(r, confirmAfterMs));
  const again = await probe(excludeIds);
  const byId = new Map(again.map((r) => [r.id, r]));
  const stillBad = suspect.filter((r) => byId.get(r.id) && !byId.get(r.id).serving);
  if (!stillBad.length) return [];

  // 证人 = 复核那一轮里**还在服务**的节点。它们与可疑对象有连接，
  // 就说明链里还有它 —— 坏的是观测方到它的那条路。
  const witnesses = again.filter((r) => r.serving);
  const seenByPeers = new Set(witnesses.flatMap((r) => r.peerNodeIds));

  const failures = [];
  for (const r of stillBad) {
    const now = byId.get(r.id);
    const head = `${label}${r.id}（${r.domain}）${now.detail}`;
    const tail = `（${Math.round(confirmAfterMs / 1000)} 秒后复核仍然如此；`
      + `第一次探测时是「${r.detail}」）`;
    const id = now.nodeId ?? r.nodeId;

    if (!witnesses.length) {
      failures.push(`${head} —— **全部验证者都不在服务**：`
        + `没有任何证人可以求证，而这本身就是要报的事${tail}`);
    } else if (!id) {
      onNote(`${head} —— 求证不了：拿不到它的 NodeID（自报与声明都没有），`
        + `无法在 ${witnesses.length} 个证人的对等列表里找它。`
        + `**不据此宣布故障扩散**${tail}`);
    } else if (seenByPeers.has(id)) {
      onNote(`${head} —— 但 ${witnesses.length} 个仍在服务的验证者**看得见它**`
        + `（对等列表里有 ${String(id).slice(0, 20)}…）`
        + ` —— 是观测方到它的路径问题，**不是故障扩散**${tail}`);
    } else {
      failures.push(`${head} —— **故障扩散了**：${witnesses.length} 个仍在服务的`
        + `验证者的对等列表里**也没有**它${tail}`);
    }
  }
  return failures;
}

/**
 * 本机 RPC 代理最近的日志行 —— 交易失败时用来留证据。
 *
 * 为什么需要：2026-09-09 的 SC-003 窗口里第 5、6 分钟各失败一笔（回执超时 + 502），
 * 而事后查 nginx 日志时**已经没了** —— 排在最后的 T090 会删掉并重建 rpc 容器
 * （那是它测试退出码 11 的手段），日志随容器一起消失。于是那次故障只留下客户端侧的
 * 一句 502，无从判断是代理耗尽了重试、还是某个上游瞬时不可达。
 *
 * 教训：**失败的那一刻就是唯一能取证的时刻**，指望事后去翻是不行的。
 * `--tail` 与 `maxBuffer` 是必需的（见 tests/unit/npm-scripts.test.mjs 的守卫）。
 */
export function proxyTail(lines = 40) {
  try {
    const out = execFileSync('docker', ['logs', '--tail', String(lines), `karmachain-rpc-${DOMAIN}`],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    return out.split('\n').filter(Boolean).join('\n');
  } catch (e) {
    return `（取不到代理日志：${(e.message ?? e).toString().slice(0, 80)}）`;
  }
}

/** 靶子不足时的 skip 理由。TAP 的 skip 是**单行**字段，别用换行（会被转义成 \n 字面量）。 */
export const localVictimSkip = (count, { requireDomainPeers = false } = {}) =>
  `本机可用的验证者容器不足 ${count} 个（本机承载：${localValidatorIds().join('、') || '无'}；`
  + `拓扑声明：${VALIDATOR_IDS.join('、')}）—— 故障注入只能操作本机容器。`
  + (requireDomainPeers ? ' 且靶子所在边界须另有节点，否则杀掉它是整域缺席（见 domain-failure.test.mjs）。' : '')
  + ' 在承载足够验证者的机器上跑本文件即可。';

/** 强制杀死全部节点容器 —— 不给任何优雅退出的机会。 */
// —— 跑仓库脚本要一个**看得见这个仓库**的 POSIX shell ——
//
// 2026-09-18（研究 V-44）：从 PowerShell 跑 `npm run test:e2e` 之后，win-1 的
// l1-1 与代理停在退出码 137，而套件报的是"开发网不可用"。根因是一处**不对称**：
//
//   毁坏  killAll() / node kill → `docker`      ← 在 PATH 里，**总能跑**
//   恢复  start()               → `sh scripts/…` ← `sh` 不在 PowerShell 的 PATH 里
//
// 于是它把节点打掉、又没法放回去。`bash` 在 Windows 上还常常是 WSL 的启动器
//（另一套文件系统，跑不了仓库里的 .sh）—— 判据见 tools/test/posix-shell.mjs。
const SHELL = findPosixShell();

/**
 * 破坏性套件的跳过理由。**没有恢复路径时，这些测试一条都不该跑。**
 *
 * 与"本机凑不出靶子"那种跳过是两回事：那种是环境不具备，这种是**我们收不了场**。
 */
export const SHELL_SKIP = skipReasonFor(SHELL);

/** 跑仓库里的一个脚本（`scripts/<name>`）。没有可用 shell 时抛，不静默不做。 */
export const script = (name, ...args) => {
  if (!SHELL) throw new Error(`没有可用的 POSIX shell，跑不了 scripts/${name} —— ${SHELL_SKIP}`);
  return sh(SHELL.cmd, [`scripts/${name}`, ...args]);
};

export const start = () => script('devnet-start.sh');

/**
 * 注入故障之前，**先确认这条链是满的** —— 与那把串行锁是一对姊妹前提。
 *
 * 锁管的是"现在只有我在动节点"；这一条管的是"我动手之前，别人没先把它弄坏"。
 * 两者缺一，判据都不成立。
 *
 * ## 这条是 2026-09-23 那轮完整 e2e 逼出来的
 *
 * 那一轮开跑时 `l1-2`（win-2）就已经卡在起始高度、只剩 3 个对等 —— 而没有任何东西
 * 检查这件事。于是第 13 条停掉 win-1 整个边界时，链上同时缺了两个：
 * **6/8 = 75%，正好卡在查询门槛上、余量为零**。后果是两条 30 分钟窗口用例
 * 报出 `27/30`、`28/30` 次交易未确认，另有两条面板用例报"余量不得被虚报为 0"
 * 与"节点从未被动过"。
 *
 * **四条失败看起来都像产品缺陷，而它们全是前提被破坏的回声。**
 * 在一条已经退化的链上注入故障，量到的不是被测性质，是别人的故障加上我的故障。
 *
 * 所以宁可**停住并说清楚**，也不要跑出一份读不出结论的红。
 * 这与"打在正常路径上的诊断守卫必须保守"不冲突 —— 那说的是**正常**路径；
 * 这里是**破坏性**路径的入口，而它本来就该挑剔。
 */
export async function requireFullMargin(label = '') {
  const rows = await validatorsServing();
  const bad = rows.filter((r) => !r.serving);
  if (!bad.length) return;
  const who = bad.map((r) => `${r.id}（${r.domain}）${r.detail}`).join(NEWLINE + '    ');
  throw new Error(
    `**动手之前这条链就不是满的** —— ${bad.length}/${rows.length} 个验证者不在服务：`
    + `${NEWLINE}    ${who}`
    + `${NEWLINE}  ${label ? `（${label}）` : ''}破坏性套件的判据建立在"我动手之前一切正常"上。`
    + `${NEWLINE}  在已经退化的链上注入故障，量到的不是被测性质 ——`
    + `${NEWLINE}  是别人的故障加上我的故障，而失败会看起来像产品缺陷（2026-09-23 实测）。`
    + `${NEWLINE}  先把上面那几个弄回来（scripts/devnet-start，或查它们的 P2P 连通性），再跑本套件。`,
  );
}

/**
 * **破坏性套件必须串行** —— 这把锁挡的是"两次运行同时打同一条链"。
 *
 * ## 为什么需要它
 *
 * `--test-concurrency=1` 只保证**一次运行内**文件串行（npm-scripts 那条守卫钉着它）。
 * 它挡不住的是：把一次完整 e2e 放到后台跑，**同时**又在同一条链上跑别的破坏性套件。
 *
 * 2026-09-19 我就是这么干的（研究 V-44）。链一直没事 ——
 * **而它没事是因为容错刚好够，不是因为我做得对**：两轮故障注入各自以为
 * "现在只有我在动节点"，而它们的判据全都建立在那个前提上。
 *
 * 那条教训此前只写在 research 里。**一条只写在文档里的规矩，不会在有人违反时变红。**
 *
 * ## 它挡得住什么、挡不住什么
 *
 * 挡得住：**同一台机器**上两次并发的破坏性运行。
 * 挡不住：两台机器分别对同一条链做故障注入 —— 锁在 `.devnet/` 里，是本机的。
 * 这一点要说出来，而不是让人以为有了锁就万无一失。
 *
 * ## 陈旧的锁
 *
 * 崩溃的运行会留下锁文件。按**持有者进程还在不在**判断：不在就接管，并打印一行
 * 说明接管了谁 —— 静默接管等于没有锁。
 */
// 换行常量：模板串里直接写转义在本仓库被多层引号搬运时会丢，
// 而 2026-09-21 就因为引用了一个**没定义**的 NEWLINE，让这把锁
// 以 ReferenceError 拦住了运行 —— 拦对了结果、错了原因，那句说明一个字没送出去。
const NEWLINE = String.fromCharCode(10);

export function acquireDestructiveLock(label) {
  const path = resolve(REPO_ROOT, '.devnet', 'destructive.lock');
  const mine = { pid: process.pid, label, at: new Date().toISOString() };

  const alive = (pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };

  let held = null;
  try { held = JSON.parse(readFileSync(path, 'utf8')); } catch { /* 没有锁，或读不动 */ }

  if (held && held.pid !== process.pid && alive(held.pid)) {
    throw new Error(
      `**已经有一次破坏性运行在进行中**：pid ${held.pid}「${held.label}」，起于 ${held.at}。`
      + `${NEWLINE}  破坏性套件必须串行 —— 两轮故障注入并发时，各自的判据都建立在`
      + `${NEWLINE}  "现在只有我在动节点"这个前提上，而那个前提不成立。`
      + `${NEWLINE}  等它跑完，或确认它已经死了之后删掉 ${path}。`,
    );
  }
  if (held && !alive(held.pid)) {
    process.stderr.write(`（接管一把陈旧的锁：pid ${held.pid}「${held.label}」已经不在了）${NEWLINE}`);
  }

  writeFileSync(path, JSON.stringify(mine));
  const release = () => { try { rmSync(path, { force: true }); } catch { /* 已经没了 */ } };
  process.on('exit', release);
  return release;
}

/**
 * 哪些容器算 `killAll()` 的目标 —— **白名单，不是黑名单**。
 *
 * 契约由 crash-recovery 那条断言定死：**本机的节点容器 + 1 个 RPC 代理**
 * （`killed === local.length + 1`）。代理是故意在内的：场景 A 要的是"全都崩掉"。
 *
 * ## 为什么从黑名单改成白名单（2026-09-23）
 *
 * 原先是 `NOT_A_NODE = new Set(['karmachain-aggregator'])` —— 排除聚合器，
 * 而过滤条件 `name=karmachain-` 把**所有**同前缀容器都捞进来。于是面板
 * （`karmachain-dashboard`）被一起杀了，而它是 `--rm` 起的：不是停掉，是**移除**，
 * `start()` 也不会把它带回来。
 *
 * 2026-09-23 完整 e2e 实测到：场景 B（50 轮强制终止）第一轮就把面板清掉了；
 * 等场景 A 跑到时只剩 2 个容器，于是它那条计数断言照常通过 ——
 * **缺陷被一条通过的断言掩盖了**，因为破坏发生在断言之前的另一个套件里。
 *
 * 黑名单的毛病就在这里：**每加一个辅助容器，就要有人记得去补它**。
 * 白名单反过来 —— 新容器默认安全，要杀它必须显式写进来。
 * （与公开投影那份"显式字段白名单"同一条道理。）
 */
const NODE_CONTAINERS = new Set(topology.topologyNodes.map((n) => `karmachain-${n.id}`));
export const isKillTarget = (name) => NODE_CONTAINERS.has(name)
  // 代理名由生成物决定（`karmachain-rpc-<边界>`），按前缀认即可，不必知道本机是哪个边界
  || /^karmachain-rpc-/.test(name);

export function killAll() {
  if (!SHELL) throw new Error(`拒绝执行 killAll()：起不回来。${SHELL_SKIP}`);
  const ids = sh('docker', ['ps', '--format', '{{.ID}} {{.Names}}', '--filter', 'name=karmachain-'])
    .trim().split(/\r?\n/).filter(Boolean)
    .map((line) => line.trim().split(/\s+/))
    .filter(([, name]) => isKillTarget(name))
    .map(([id]) => id);
  if (ids.length) sh('docker', ['kill', ...ids]);
  return ids.length;
}


/** 等 RPC 回到预期的 chainId，返回耗时（毫秒）。 */
export async function waitReady(timeoutMs = 300_000) {
  const t0 = Date.now();
  for (;;) {
    try {
      if (await pub.getChainId() === info.chainId) return Date.now() - t0;
    } catch { /* 尚未就绪 */ }
    if (Date.now() - t0 > timeoutMs) throw new Error(`chain not ready within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/**
 * 发一笔转账并等待回执，返回它所在的**区块高度**。
 *
 * 注意返回值不是 receipt —— 回执非 success 时本函数自己抛异常，因此"拿到返回值"
 * 就等于"已确认"。别去读它的 `.status`（曾踩过：那是个数字，`.status` 恒为 undefined）。
 */
/**
 * **兜底恢复**：无论前面成功还是失败，都把本机的节点拉回来并等到就绪。
 *
 * 给每个破坏性套件的 `after` 用。它自己**不抛** —— 在 `after` 里抛会盖掉真正的
 * 失败原因，而那个原因才是人要看的。恢复不成功时明说，让人知道要去收拾什么。
 */
export async function restoreOrReport(label = '') {
  // **唯一"停着才对"的场景**：有人显式声明这一轮期望开发网是停的
  //（`after devnet-stop the RPC endpoint refuses connections` 就靠它）。
  // 那时候把它拉起来才是破坏 —— 兜底恢复也要认这个开关。
  if (process.env.KARMACHAIN_EXPECT_STOPPED === '1') return null;
  try {
    start();
    await waitReady(300_000);
    return true;
  } catch (err) {
    const nl = String.fromCharCode(10);
    process.stderr.write(`${nl}⚠ 恢复失败${label ? `（${label}）` : ''}：${err.message}${nl}`
      + `  本机的节点可能仍停着。手动收拾：scripts/devnet-start.sh（或 .ps1）${nl}`);
    return false;
  }
}

export async function sendTxVia(clients, valueEth = '0.001') {
  const hash = await clients.wallet.sendTransaction({ to: RECIPIENT, value: parseEther(valueEth) });
  const rcpt = await clients.pub.waitForTransactionReceipt({ hash, timeout: 90_000, pollingInterval: 500 });
  if (rcpt.status !== 'success') throw new Error(`tx ${hash} reverted`);
  return Number(rcpt.blockNumber);
}

export const sendTx = (valueEth = '0.001') => sendTxVia(local, valueEth);

export const genesisHash = () => readFileSync(resolve(REPO_ROOT, 'blockchain/genesis/karmachain.genesis.hash'), 'utf8').trim();

/** 开发网是否可用；不可用时让调用方跳过而不是误报失败。 */
export async function devnetAvailable() {
  try { return await pub.getChainId() === info.chainId; } catch { return false; }
}
