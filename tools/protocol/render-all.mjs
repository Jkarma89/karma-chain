// tools/protocol/render-all.mjs
//
// 由唯一事实来源生成**全部**派生物，或以 --check 检查它们是否漂移（功能 002 / US5、FR-027）。
//
// 为什么需要一个统一驱动：
//   1. `npm run protocol:render && npm run node:render` 用 && 串联，**遇到第一个失败就停** ——
//      检查漂移时这意味着一次只能看到一处偏离，要改几轮才知道到底有几处。本驱动逐个跑完再汇总。
//   2. 宿主的唯一前置依赖是 Docker（README），因此需要一个能在容器里跑的单一入口，
//      供 scripts/devnet-render.{sh,ps1} 转调。
//
// 用法：node tools/protocol/render-all.mjs [--check]
// 退出码：0 全部一致（或已生成） | 1 存在漂移（仅 --check）
//
// 生成器清单在此**显式列出**而不是扫目录：新增生成器必须有人有意识地登记，
// 否则它会静默地不被漂移检查覆盖 —— 那正是 FR-027 要防的情况。

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/** [脚本名, 产出说明]。顺序即执行顺序：节点标志依赖建链制品，compose 依赖节点标志。 */
export const GENERATORS = [
  ['render-genesis.mjs', 'blockchain/genesis/'],
  ['render-docs.mjs', 'docs/protocol-parameters.md'],
  ['render-compose-env.mjs', 'blockchain/compose.env'],
  ['render-chain-info.mjs', 'docs/public/chain-info.json'],
  ['render-developer-quickstart.mjs', 'docs/public/developer-quickstart.md'],
  ['render-node-flags.mjs', 'blockchain/nodes/<deployment>/*.flags.json + *.identity.json'],
  ['render-aliases.mjs', 'blockchain/nodes/aliases.json'],
  ['render-chain-config.mjs', 'blockchain/nodes/chain-config/'],
  ['render-rpc-proxy.mjs', 'blockchain/nodes/<deployment>/rpc-proxy.conf'],
  ['render-compose.mjs', 'docker/compose/'],
];

const check = process.argv.includes('--check');
const failures = [];

for (const [script, produces] of GENERATORS) {
  const args = check ? [resolve(HERE, script), '--check'] : [resolve(HERE, script)];
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();

  if (r.status === 0) {
    if (!check) process.stdout.write(out ? `${out}\n` : '');
    else console.log(`[OK]    ${script.padEnd(34)} ${produces}`);
    continue;
  }
  failures.push({ script, produces, out, status: r.status });
  console.error(`[DRIFT] ${script.padEnd(34)} ${produces}`);
  if (out) console.error(out.split('\n').map((l) => `        ${l}`).join('\n'));
}

if (!failures.length) {
  console.log(check
    ? `\n全部 ${GENERATORS.length} 项生成物与 blockchain/protocol.json 一致。`
    : `\n已生成 ${GENERATORS.length} 项派生物。下一步：npm test 会指出还有什么没同步。`);
  process.exit(0);
}

// 汇总：一次列出全部偏离项，而不是让调用方改一处再跑一次
console.error(`\n${failures.length}/${GENERATORS.length} 项生成物存在漂移：`);
for (const f of failures) console.error(`  - ${f.produces}   （${f.script}）`);
console.error(check
  ? '\n修正：运行 scripts/devnet-render（或 npm run render）重新生成；不要手改生成物。'
  : '\n生成过程本身失败了 —— 上面的输出给出了原因。');
process.exit(1);
