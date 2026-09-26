// tools/verify/checks/stake-expiry.mjs —— P 链权益**会到期**，而到期没有任何告警
// （功能 005 / US4，2026-09-26 加）。
//
// ## 为什么需要这一条
//
// F-7 把 P 链权益持有者从 2 个各 50% 推到 6 个各 16.66%，于是"掉任意一台机器"
// 之后还剩 83.34% ≥ 80%，引导不再依赖那两个 Primary 同时在线。
//
// **但每一份质押都有到期日。** 到期之后那个验证者**自动退出集合**，
// 权益分布悄悄退回去 —— P 链不报警，面板也不会（它看的是**当前**分布，不是到期日）。
//
// 实测到的具体情形：既有两个 Primary 的质押 **2027-09-08** 到期，
// 而 T045 加的那四笔是 2027-09-26。**绑定的日期是前者，比后者还早 18 天** ——
// 那天一到，持有者从 6 掉回 4、每个 25%，掉一台剩 75% < 80%，F-7 买到的性质失效。
//
// 一个只写在文档里的到期日，不会在它逼近时变红。这一条把它变成会变红的东西。
//
// ## 判据不是"快到期了"，是"到期之后还撑不撑得住"
//
// 单说"某笔质押 30 天后到期"没什么用 —— 到期的若是一个本来就多余的持有者，
// 那不是问题。真正要问的是：**把窗口内会到期的那些拿掉之后，
// 掉任意一台机器还剩多少？** 低于门槛才是事。
//
// 这样写还顺带覆盖了一种文档写不出来的情形：某天有人加了第 7 个持有者，
// 于是两个 Primary 到期也不再致命 —— 那时这一条会自己不红，不需要有人来改它。
import { STATUS } from '../lib/report.mjs';
import { CATEGORIES } from '../lib/categories.mjs';
import { loadProtocol, deriveTopology } from '../../protocol/load.mjs';
import {
  PRIMARY_NETWORK_ID, BOOTSTRAP_QUORUM_PERCENT, worstCaseAfterDomainLoss, holderMapper,
} from '../../membership/add-primary-validator.mjs';

/** 提前多久开始报警。够走完"续期或补一个持有者"的流程。 */
export const WARN_DAYS = 45;

const DAY_MS = 86_400_000;

/**
 * **纯函数**：给定当前的权益持有者与时刻，判断到期这件事要不要现在管。
 *
 * @param {{domain:string, weight:bigint, endTimeMs:number, label:string}[]} holders
 * @param {{now:number, warnDays:number, quorumPercent:number}} opts
 * @returns {null|{verdict:'ok'|'fail', soonest:{label:string,endTimeMs:number,inDays:number}|null,
 *   expiring:string[], remainingAfter:number|null, reason:string}}
 *   拿不到可用输入时返回 null —— **不猜**。
 */
export function assessStakeExpiry(holders, { now, warnDays = WARN_DAYS, quorumPercent = BOOTSTRAP_QUORUM_PERCENT } = {}) {
  const usable = (holders ?? []).filter((h) => Number.isFinite(h?.endTimeMs) && h.weight > 0n);
  if (!usable.length) return null;

  const withDays = usable
    .map((h) => ({ ...h, inDays: Math.floor((h.endTimeMs - now) / DAY_MS) }))
    .sort((a, b) => a.inDays - b.inDays);
  const soonest = withDays[0];

  // 窗口内会到期的（含已经过期的）拿掉之后，剩下的还撑不撑得住"掉一台机器"
  const expiring = withDays.filter((h) => h.inDays <= warnDays);
  const survivors = withDays.filter((h) => h.inDays > warnDays);
  const after = worstCaseAfterDomainLoss(survivors);
  const remainingAfter = after ? after.remainingPercent : 0;

  if (!expiring.length) {
    return {
      verdict: 'ok',
      soonest: { label: soonest.label, endTimeMs: soonest.endTimeMs, inDays: soonest.inDays },
      expiring: [],
      remainingAfter: null,
      reason: `还没进 ${warnDays} 天窗口`,
    };
  }
  if (remainingAfter >= quorumPercent) {
    return {
      verdict: 'ok',
      soonest: { label: soonest.label, endTimeMs: soonest.endTimeMs, inDays: soonest.inDays },
      expiring: expiring.map((h) => h.label),
      remainingAfter,
      reason: `${expiring.length} 笔在 ${warnDays} 天内到期，但去掉它们之后掉一台仍剩 ${remainingAfter}% —— 不致命`,
    };
  }
  return {
    verdict: 'fail',
    soonest: { label: soonest.label, endTimeMs: soonest.endTimeMs, inDays: soonest.inDays },
    expiring: expiring.map((h) => h.label),
    remainingAfter,
    reason: `${expiring.length} 笔在 ${warnDays} 天内到期（最早 ${soonest.inDays} 天后：${soonest.label}），`
      + `到期之后掉任意一台机器只剩 ${remainingAfter}% < ${quorumPercent}% —— P 链引导会失败`,
  };
}

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

export const stakeExpiryCheck = {
  id: 'stake-expiry',
  async run() {
    const p = loadProtocol();
    const d = deriveTopology(p);
    const primary = d.topologyNodes.find((n) => n.role === 'primary');
    if (!primary?.address) {
      return { status: STATUS.SKIP, detail: 'no primary node declared — cannot read P-chain' };
    }
    let validators;
    try {
      const r = await fetch(`http://${primary.address}:${primary.httpPort}/ext/bc/P`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'platform.getCurrentValidators',
          params: { subnetID: PRIMARY_NETWORK_ID },
        }),
        signal: AbortSignal.timeout(20_000),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      validators = j.result.validators;
    } catch (err) {
      // **读不到不等于没问题，也不等于有问题** —— 报 SKIP 并说清，不冒充结论。
      return {
        status: STATUS.SKIP,
        detail: `P 链读不到当前验证者（${String(err.message).slice(0, 80)}）—— 到期这件事此刻无从判定`,
      };
    }

    const holderOf = holderMapper(p, d);
    const holders = validators.map((v) => {
      const h = holderOf(v.nodeID, v.weight ?? v.stakeAmount ?? 0);
      return { ...h, endTimeMs: Number(v.endTime) * 1000, label: `${h.ourId ?? v.nodeID.slice(0, 14)}@${h.domain}` };
    });

    const a = assessStakeExpiry(holders, { now: Date.now() });
    if (!a) {
      return { status: STATUS.SKIP, detail: 'P 链没有给出可用的到期时刻 —— 无从判定' };
    }
    const when = `${iso(a.soonest.endTimeMs)}（${a.soonest.inDays} 天后，${a.soonest.label}）`;
    if (a.verdict === 'fail') {
      return {
        status: STATUS.FAIL,
        category: CATEGORIES.CONFIGURATION,
        detail: `${a.reason}。最早到期 ${when}。处置：续期那几笔，或补一个持有者把分母做大`,
        data: { soonest: a.soonest, expiring: a.expiring, remainingAfter: a.remainingAfter },
      };
    }
    return {
      status: STATUS.OK,
      // **即使是 OK 也把日期说出来** —— 这一条存在的意义，一半是让那个日期
      // 出现在每一次验收的输出里，而不是只躺在某份文档的某一段。
      detail: `${validators.length} 笔 P 链质押，最早到期 ${when}；${a.reason}`,
      data: { soonest: a.soonest, count: validators.length },
    };
  },
};
