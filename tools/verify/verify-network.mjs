// tools/verify/verify-network.mjs —— 编排全部检查（001 的 13 项 + 002 的 fault-tolerance + 005 的 stake-expiry），输出逐项 [OK]/[FAIL] 行 + JSON 报告。
//
// 退出码：0 全部通过（含 unsupported/skip 之外无失败）| 1 任一失败（contracts/cli-interface.md）
// "节点已启动" 单独不构成通过（FR-029）：必须走完转账、合约与协议一致性检查。
//
// 用法：node tools/verify/verify-network.mjs [--json <path>] [--quick]
//   --quick  跳过合约编译与 RPC 方法逐一探测（本地迭代用；正式验收不得使用）

import { resolve } from 'node:path';
import { protocol, derived, rpcUrl, publicClient, walletClient, info, REPO_ROOT_HINT } from './lib/rpc.mjs';
import { Report, STATUS } from './lib/report.mjs';
import { categorizeError, isConfirmationTimeout, diagnoseEndpointLag, CATEGORIES } from './lib/categories.mjs';
import { basicChecks, nodeHeights } from './checks/basic.mjs';
import { chainChecks } from './checks/chain.mjs';
import { stakeExpiryCheck } from './checks/stake-expiry.mjs';

const args = process.argv.slice(2);
const quick = args.includes('--quick');
const jsonPath = (() => {
  const i = args.indexOf('--json');
  if (i !== -1 && args[i + 1]) return resolve(args[i + 1]);
  return resolve(REPO_ROOT_HINT, '.devnet', 'verify-report.json');
})();

const SKIP_IN_QUICK = new Set(['contract', 'rpc-methods']);

/**
 * 「我们读的这个端点是不是落后于全网」的那句话 —— 拿不到数就返回 null（不猜）。
 *
 * 判定本身是纯的（`diagnoseEndpointLag`），这里只负责取两个数：
 * 我们读的那个端点的高度，以及各节点自报的高度。
 * 整段包在 try 里：**诊断失败不许把原来的失败吃掉**。
 */
async function lagNote() {
  try {
    const [endpointHeight, heights] = await Promise.all([
      publicClient.getBlockNumber().then(Number).catch(() => NaN),
      nodeHeights(),
    ]);
    const d = diagnoseEndpointLag({ endpointHeight, nodeHeights: heights });
    if (!d || !d.endpointBehind) return null;
    return `\n  ↳ 我们读的这个端点落后全网 ${d.behindBy} 块（端点 ${d.endpointHeight}，全网 ${d.networkHeight}）`
      + ` —— **交易多半已经进链，读不到的是回执**。`
      + `落后的节点：${d.laggards.map((n) => `${n.id}@${n.height}`).join('、')}。`
      + `处置是修那个节点（docs/devnet.md §5.3），不是查 RPC。`;
  } catch {
    return null;
  }
}

async function main() {
  const report = new Report({ rpcUrl });
  report.printHeader();

  const ctx = { protocol, derived, rpcUrl, publicClient, walletClient, info, report, repoRoot: REPO_ROOT_HINT };
  const checks = [...basicChecks, ...chainChecks, stakeExpiryCheck];

  // 先确认端点可达：不可达时直接给出 rpc 类失败，后续检查全部标记 skip（避免 13 条噪声）
  let reachable = true;
  try {
    await publicClient.getChainId();
  } catch (err) {
    reachable = false;
    report.add({
      id: 'rpc',
      status: STATUS.FAIL,
      category: categorizeError(err),
      detail: `${err.message.slice(0, 120)} at ${rpcUrl} — is the devnet running? (scripts/devnet-start)`,
    });
  }

  for (const check of checks) {
    if (!reachable) {
      if (check.id !== 'rpc') report.add({ id: check.id, status: STATUS.SKIP, detail: 'endpoint unreachable' });
      continue;
    }
    if (quick && SKIP_IN_QUICK.has(check.id)) {
      report.add({ id: check.id, status: STATUS.SKIP, detail: 'skipped by --quick (not valid for acceptance)' });
      continue;
    }
    try {
      const result = await check.run(ctx);
      report.add({ id: check.id, ...result });
    } catch (err) {
      let category = categorizeError(err);
      let detail = (err.shortMessage ?? err.message ?? String(err)).slice(0, 200);
      // **「等回执超时」的第二问：写进去了没有？**（研究 V-76）
      // 2026-09-25 实测：l1-1 落后 3 块卡住，我们经本机代理读、代理正好指着它，
      // 于是三笔交易**全都进链了**却读不到回执 —— 报出来的是"交易超时"，
      // 而处置在**那个落后的节点**上。不问这一句，这条消息就把人引向 RPC。
      if (isConfirmationTimeout(err)) {
        const note = await lagNote();
        if (note) { category = CATEGORIES.NODE; detail += note; }
      }
      report.add({ id: check.id, status: STATUS.FAIL, category, detail });
    }
  }

  report.printFooter();
  const written = report.write(jsonPath);
  console.log(`report: ${written}`);
  process.exit(report.overall === 'ready' ? 0 : 1);
}

main().catch((err) => {
  console.error(`verify-network: unexpected failure: ${err?.stack ?? err}`);
  process.exit(1);
});
