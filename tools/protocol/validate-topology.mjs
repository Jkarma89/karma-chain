// tools/protocol/validate-topology.mjs
//
// 校验并展示拓扑：节点 → 故障边界归属、每边界验证者数、推导出的容错上限、共享失效因素告警。
// 契约见 specs/002-resilient-validator-network/contracts/cli-interface.md。
//
// 退出码（001 已占用 10/11/12/20，本特性新增 13）：
//   0   拓扑合法
//   10  声明缺失或不可读
//   13  拓扑违反容错约束（configuration 类别）
//
// 用法：node tools/protocol/validate-topology.mjs [--deployment <name>] [--json] [--protocol <path>]
//
// --protocol 指向另一份声明（默认 blockchain/protocol.json）。两个用途：
//   1. 提交前先审一份**拟改的**拓扑，不必先把改动落进唯一事实来源；
//   2. 测试用改过的副本验证违规路径，不触碰真实声明。

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadProtocol, derive, deriveTopology, TOPOLOGY_VIOLATION_TAG } from './load.mjs';

export const EXIT_OK = 0;
export const EXIT_DECLARATION_MISSING = 10;
export const EXIT_TOPOLOGY_VIOLATION = 13;

/**
 * 分析一个部署形态。返回展示所需的全部数据与告警，不做任何输出。
 * @returns {{deployment: string, domains: object[], faultTolerance: object, warnings: string[]}}
 */
export function analyze(p, deploymentName = p.topology.activeDeployment) {
  if (!Object.prototype.hasOwnProperty.call(p.topology.deployments, deploymentName)) {
    const e = new Error(`unknown deployment "${deploymentName}"; available: ${Object.keys(p.topology.deployments).join(', ')}`);
    e.exitCode = EXIT_DECLARATION_MISSING;
    throw e;
  }

  // 借用 derive 的解析逻辑，但针对指定的部署形态
  const scoped = { ...p, topology: { ...p.topology, activeDeployment: deploymentName } };
  const d = deriveTopology(scoped);

  const validatorIds = new Set(d.topologyNodes.filter((n) => n.role === 'l1-validator').map((n) => n.id));
  const domains = d.failureDomains;
  const { maxOfflineValidators, validatorCount } = d.faultTolerance;

  // 共享失效因素：两个边界共享同一因素时，该因素一旦触发会同时打掉两边的验证者。
  // 代码无法验证"独立失效"是否成立，只能就声明出的共享因素告警（研究 R-12）。
  const warnings = [];
  if (domains.length > 1) {
    const byFactor = new Map();
    for (const dom of domains) {
      for (const f of dom.sharedFailureFactors ?? []) {
        if (!byFactor.has(f)) byFactor.set(f, []);
        byFactor.get(f).push(dom);
      }
    }
    for (const [factor, doms] of byFactor) {
      if (doms.length < 2) continue;
      const affected = doms.reduce((s, dom) => s + dom.nodes.filter((id) => validatorIds.has(id)).length, 0);
      if (affected > maxOfflineValidators) {
        warnings.push(
          `边界 ${doms.map((x) => x.id).join(' 与 ')} 共享失效因素 '${factor}'\n`
          + `         该因素触发将同时损失 ${affected} 个验证者，超出容错上限 ${maxOfflineValidators} —— 请消除该共享或错开`,
        );
      }
    }
  }

  return { deployment: deploymentName, domains, faultTolerance: d.faultTolerance, warnings, nodes: d.topologyNodes };
}

function printReport({ deployment, domains, faultTolerance, warnings, nodes }, chainName) {
  const {
    validatorCount, maxOfflineValidators, domainCount, maxValidatorsPerDomain,
    tolerateWholeDomainLoss, effectiveDomainCount, effectiveDomains: effective,
  } = faultTolerance;

  console.log(`\n${chainName} topology   deployment: ${deployment}   ${domainCount} domain${domainCount > 1 ? 's' : ''} / ${nodes.length} nodes\n`);

  const w = (s, n) => String(s).padEnd(n);
  console.log(`  ${w('domain', 11)}${w('platform', 10)}${w('address', 16)}${w('nodes', 34)}validators`);
  for (const d of domains) {
    console.log(`  ${w(d.id, 11)}${w(d.platform, 10)}${w(d.address, 16)}${w(d.nodes.join(', '), 34)}${String(d.validatorCount).padStart(6)}`);
  }

  console.log();
  console.log(`  容错：${validatorCount} 个等权验证者，查询门槛 75% → 可容忍 ${maxOfflineValidators} 个离线`);
  if (domainCount === 1) {
    console.log('  边界：单边界形态，不做整机失效容错承诺（阶段一）');
  } else {
    const ok = tolerateWholeDomainLoss;
    console.log(`  边界：每边界至多 ${maxValidatorsPerDomain} 个验证者 → ${ok ? '可容忍 1 个边界整体失效' : '无法容忍边界整体失效'}  [${ok ? 'OK' : 'FAIL'}]`);
    // 共享失效因素会把多个声明边界合并成一个**有效**边界。承诺按有效边界判定 ——
    // 否则"5 个边界各 1 个验证者"这种声明会在真实宿主只有 2 台时依然显示绿灯。
    if (effectiveDomainCount !== domainCount) {
      console.log(`  有效边界：${domainCount} 个声明边界因共享失效因素合并为 ${effectiveDomainCount} 个 —— 上面那行按合并后判定`);
      for (const g of effective) {
        const label = g.ids.length > 1 ? `${g.ids.join(' + ')}  ← ${g.factors.join(', ')}` : g.ids[0];
        console.log(`    ${String(g.validators).padStart(2)} 个验证者  ${label}`);
      }
    }
  }

  for (const msg of warnings) console.log(`\n  [WARN] ${msg}`);
  console.log();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const flag = (n) => { const i = args.indexOf(n); return i !== -1 && args[i + 1] ? args[i + 1] : undefined; };
  const name = flag('--deployment');
  const protocolPath = flag('--protocol');

  let p;
  try {
    p = protocolPath ? loadProtocol(resolve(protocolPath)) : loadProtocol();
  } catch (err) {
    // load.mjs 的约束校验已覆盖容错约束。判别不靠匹配散文，而靠 load.mjs 导出的标记 ——
    // 文案（含语言）可以改，退出码映射不受影响。
    const isViolation = err.message.includes(TOPOLOGY_VIOLATION_TAG);
    const code = isViolation ? EXIT_TOPOLOGY_VIOLATION : EXIT_DECLARATION_MISSING;
    const category = 'configuration';
    console.error(`[karmachain] FAILED [category: ${category}] ${err.message}`);
    process.exit(code);
  }

  try {
    const result = analyze(p, name);
    if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
    else printReport(result, p.name);
    process.exit(EXIT_OK);
  } catch (err) {
    console.error(`[karmachain] FAILED [category: configuration] ${err.message}`);
    process.exit(err.exitCode ?? EXIT_DECLARATION_MISSING);
  }
}
