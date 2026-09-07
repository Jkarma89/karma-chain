// tools/verify/verify-network.mjs —— 编排全部检查（001 的 13 项 + 002 的 fault-tolerance），输出逐项 [OK]/[FAIL] 行 + JSON 报告。
//
// 退出码：0 全部通过（含 unsupported/skip 之外无失败）| 1 任一失败（contracts/cli-interface.md）
// "节点已启动" 单独不构成通过（FR-029）：必须走完转账、合约与协议一致性检查。
//
// 用法：node tools/verify/verify-network.mjs [--json <path>] [--quick]
//   --quick  跳过合约编译与 RPC 方法逐一探测（本地迭代用；正式验收不得使用）

import { resolve } from 'node:path';
import { protocol, derived, rpcUrl, publicClient, walletClient, info, REPO_ROOT_HINT } from './lib/rpc.mjs';
import { Report, STATUS } from './lib/report.mjs';
import { categorizeError } from './lib/categories.mjs';
import { basicChecks } from './checks/basic.mjs';
import { chainChecks } from './checks/chain.mjs';

const args = process.argv.slice(2);
const quick = args.includes('--quick');
const jsonPath = (() => {
  const i = args.indexOf('--json');
  if (i !== -1 && args[i + 1]) return resolve(args[i + 1]);
  return resolve(REPO_ROOT_HINT, '.devnet', 'verify-report.json');
})();

const SKIP_IN_QUICK = new Set(['contract', 'rpc-methods']);

async function main() {
  const report = new Report({ rpcUrl });
  report.printHeader();

  const ctx = { protocol, derived, rpcUrl, publicClient, walletClient, info, report, repoRoot: REPO_ROOT_HINT };
  const checks = [...basicChecks, ...chainChecks];

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
      report.add({
        id: check.id,
        status: STATUS.FAIL,
        category: categorizeError(err),
        detail: (err.shortMessage ?? err.message ?? String(err)).slice(0, 200),
      });
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
