// 节点镜像里的 shell 读的每个字段，必须真的在它读的那个文件里（功能 005）。
//
// ## 这条守卫是被一次现场失败逼出来的
//
// 分家之后在 ubuntu-1 上跑 `devnet-start`，陈旧挂载告警如期而至。而在执行
// `--force-recreate` 之前查出：`docker/node/healthcheck.sh` 从 `/config/protocol.json`
// 读 `.validators.count` —— 那个字段已经搬进 `deployment.json`，
// **而节点容器当时根本没挂载它**。
//
// 后果不是崩溃，是**静默降级**：取空之后 `expected_peers` 留空，
// 两条判据都要求它非空，于是
//
//   - `等其余边界：只看见 x/y 个对等验证者` 这句诊断消失
//   - `stalled` 升级再也不会触发（节点真坏了也只报 bootstrapping）
//
// 节点照样 healthy，面板照样绿。**没有任何测试会红。**
//
// ## 为什么既有的守卫都漏了它
//
//   - JS 侧的残留扫描（deployment-path-residue）只看 .mjs/.js
//   - shell 侧那条只看 `proto_get`，而节点镜像里**没有** docker/lib ——
//     `docker/node/*.sh` 自己定义 PROTOCOL 变量直接 jq
//
// 所以这条改为**按文件变量反查**：找出每个 `jq ... "${X}"`，
// 把 X 映射到宿主上的真文件，再断言那个字段路径确实存在。
// 覆盖的是"读哪个文件的哪个字段"这件事本身，与分家与否无关 ——
// 日后任何一次字段搬家都会被它挡下。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from '../../tools/protocol/load.mjs';

const NODE_DIR = resolve(REPO_ROOT, 'docker', 'node');

/** shell 变量名 → 宿主上的真文件。容器里的 /config/<x> 由 compose 从这些路径挂进去。 */
// 逐节点的文件（IDENTITY / FLAGS）取**一个代表**来验证字段存在性 ——
// 它们由同一个生成器按同一形状写出，缺字段会缺在全部节点上。
const FILE_OF = Object.freeze({
  PROTOCOL: 'blockchain/protocol.json',
  DEPLOYMENT: 'blockchain/deployment.json',
  CHAIN_IDENTITY: 'blockchain/chain-identity/karmachain.identity.json',
  IDENTITY: 'blockchain/nodes/l1-1.identity.json',
  FLAGS: 'blockchain/nodes/lan/l1-1.flags.json',
});

/** 逐节点文件在 compose 里的宿主路径带节点名，比对时只看容器内那一侧。 */
const CONTAINER_PATH = Object.freeze({
  IDENTITY: ':/config/identity.json:ro',
  FLAGS: ':/config/flags.json:ro',
});

const readJson = (rel) => JSON.parse(readFileSync(resolve(REPO_ROOT, rel), 'utf8'));

/** 按点号路径取值；取不到返回 undefined。 */
const at = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

/**
 * 从一个 shell 文件里找出所有 `jq [-r] '.a.b' "${VAR}"` / `jq -r .a.b "${VAR}"`。
 * @returns {{file: string, line: number, varName: string, path: string}[]}
 */
const scanReads = (file) => {
  const src = readFileSync(resolve(NODE_DIR, file), 'utf8');
  const out = [];
  for (const [i, raw] of src.split('\n').entries()) {
    if (/^\s*#/.test(raw)) continue;                    // 整行注释
    const line = raw.replace(/\s#.*$/, '');
    // 两种写法：带引号的 '.a.b' 与裸的 .a.b
    const re = /jq\s+(?:-[a-zA-Z]+\s+)*(?:'(\.[A-Za-z0-9_.]+)'|(\.[A-Za-z0-9_.]+))\s+"\$\{(\w+)\}"/g;
    for (const m of line.matchAll(re)) {
      const path = (m[1] ?? m[2]).slice(1);
      if (!path) continue;
      out.push({ file, line: i + 1, varName: m[3], path });
    }
  }
  return out;
};

const reads = ['entrypoint.sh', 'healthcheck.sh'].flatMap(scanReads);

describe('扫描器本身有效', () => {
  test('确实扫到了取值（否则下面全是空跑）', () => {
    assert.ok(reads.length >= 5,
      `只扫到 ${reads.length} 处 jq 取值 —— 正则与实现漂移了，下面的断言全部形同虚设`);
  });

  test('两个脚本都被扫到了', () => {
    for (const f of ['entrypoint.sh', 'healthcheck.sh']) {
      assert.ok(reads.some((r) => r.file === f), `${f} 里一处取值都没扫到`);
    }
  });
});

describe('**每个字段都必须在它被读的那个文件里**', () => {
  for (const r of reads) {
    test(`${r.file}:${r.line}  ${r.varName} → \`.${r.path}\``, () => {
      const rel = FILE_OF[r.varName];
      assert.ok(rel,
        `变量 \`${r.varName}\` 没登记在 FILE_OF 里 —— 无法判断它读的是哪个文件。\n`
        + '  新增一个配置文件时，请一并登记，否则这条守卫会悄悄放过它。');
      assert.notEqual(at(readJson(rel), r.path), undefined,
        `\`${r.file}\` 第 ${r.line} 行从 \`${rel}\` 读 \`.${r.path}\`，而那里没有这个字段。\n`
        + '  **jq 取不到只会返回 null/空串，不会报错** —— 节点照常启动、照常 healthy，\n'
        + '  只是某条判据从此永远不成立。2026-09-12 在 healthcheck 的 validators.count 上\n'
        + '  真的发生过一次：两条诊断静默失效而全套测试仍然全绿。');
    });
  }
});

describe('容器里读得到的文件，compose 必须真的挂进去', () => {
  const composeFiles = ['lan-ubuntu-1.yml', 'lan-win-1.yml', 'local-local.yml'];

  for (const varName of [...new Set(reads.map((r) => r.varName))]) {
    const rel = FILE_OF[varName];
    if (!rel) continue;
    const needle = CONTAINER_PATH[varName] ?? `/${rel}:/config/`;
    test(`\`${rel}\` 在每份 compose 里都被挂载`, () => {
      for (const cf of composeFiles) {
        const src = readFileSync(resolve(REPO_ROOT, 'docker', 'compose', cf), 'utf8');
        assert.ok(src.includes(needle),
          `${cf} 没有把 ${rel} 挂进 /config —— \n`
          + `  而 docker/node/*.sh 会去读它。容器里读一个不存在的文件，jq 只会返回空串，\n`
          + '  于是依赖它的判据**静默失效**，而没有任何东西会红。');
      }
    });
  }
});
