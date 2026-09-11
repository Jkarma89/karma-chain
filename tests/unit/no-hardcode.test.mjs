// T030（扫描部分）/ SC-007：协议参数字面量只允许出现在唯一事实来源、生成物、文档与少数"刻意双写"的测试锚点中。
// 纯 Node 实现（verify 容器内无 git）。新增合法出现点时必须在 ALLOWED 中登记并说明归类。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { REPO_ROOT } from '../../tools/protocol/load.mjs';

/** 受控的协议参数字面量（正则，按词边界匹配）。 */
const TOKENS = [
  /\b20189\b/, // chainId
  /\b20188\b/, // reserved mainnet chainId
  /\b1337\b/, // networkId
  /\b4edd\b/i, // chainId hex
  /\b8545\b/, // host RPC port
  // 节点端口于 configVersion 1.4.0 整体迁移（原 96xx 段落在 Windows 的 Hyper-V 保留区间内）。
  // 词表必须随之迁移 —— 否则守卫盯着一段不存在的端口，等于静默失效。
  /\b2166[0-9]\b/, // validator ports
  /\b2165[0-9]\b/, // primary node ports
  /KarmaCoin/, // token name
  // T068：拓扑地址同样是协议参数，且是**安装特有**的数据。写死在脚本或生成器里，
  // 换一套硬件就得改代码 —— 而声明里改一处即可（FR-027 / 宪法第十六条）。
  // 取自 topology.deployments 的实际地址，随声明变化而更新词表（与端口迁移同一规矩）。
  /\b192\.168\.1\.(?:3|13|21|22|23)\b/, // 跨机形态各故障边界的局域网地址
  /\b172\.28\.0\.\d{1,3}\b/, // 单机形态的容器网段（containerNetwork.subnet 派生）
];

/** 允许出现字面量的路径（前缀匹配，POSIX 风格），value = 归类理由。 */
const ALLOWED = {
  'blockchain/protocol.json': '唯一事实来源（协议参数）',
  // 功能 005：部署描述（机器、地址、端口、故障边界）从 protocol.json 切出来了。
  // 端口与地址**本来就该住在这里** —— 它同样是事实来源，只是管的是另一半。
  'blockchain/deployment.json': '唯一事实来源（部署描述：机器 / 地址 / 端口 / 故障边界）',
  'blockchain/deployment.schema.json': '部署描述的 schema（约束里带取值范围）',
  'blockchain/protocol-rationale.json': '理由文档（伴随事实来源）',
  'blockchain/compose.env': '生成物（render-compose-env，漂移测试锁定）',
  'blockchain/genesis/': '生成物 + 基准记录（render-genesis，漂移测试锁定）',
  'blockchain/chain-identity/': '建链产物（extract-identity / extract-primary-genesis 生成，chain-identity.test 交叉校验锁定）',
  'blockchain/nodes/': '生成物（render-node-flags / render-aliases，docs-drift 漂移测试锁定）',
  'docker/compose/': '生成物（render-compose，docs-drift 漂移测试锁定）',
  'blockchain/accounts/dev-accounts.json': 'DEVELOPMENT ONLY 密钥文件的警示文案',
  'blockchain/validators/dev/': '密钥目录 README（记录端口与 NodeID）',
  'docker-compose.yml': '裸 compose 的 :- 兜底（docs-drift.test 与 protocol.json 锁定同步）',
  'docs/': '文档（引用值；protocol-parameters.md 为生成物）',
  'specs/': '设计文档（Spec Kit 产物）',
  'doc/': '外部参考文档',
  'README.md': '文档',
  '.env.example': '覆盖项说明文档',
  'tests/unit/protocol.test.mjs': '刻意双写：断言 protocol.json 的关键身份值，防止事实来源被误改',
  'tests/unit/no-hardcode.test.mjs': '本扫描器自身的白名单与词表',
  'tests/integration/start-stop.test.mjs': '刻意双写：断言派生 chainIdHex 锚点',
  'tests/e2e/param-change.test.mjs': '改参数演练需要新旧两个 chainId 字面量',
  'tests/fixtures/': '实测基准：记录链**当时实际**是什么值，字面量即证据本身，不是配置来源（功能 002 Phase 0 取证）',
};

const SKIP_DIRS = new Set(['.git', 'node_modules', '.devnet', '.claude', '.specify', '.vscode', '.idea']);
const SKIP_FILES = new Set(['package-lock.json']);
const SKIP_EXT = new Set(['.crt', '.key', '.png', '.jpg', '.gz', '.zip']);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(REPO_ROOT, full).replace(/\\/g, '/');
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) yield* walk(full);
    } else {
      if (SKIP_FILES.has(name)) continue;
      if (SKIP_EXT.has(name.slice(name.lastIndexOf('.')))) continue;
      yield rel;
    }
  }
}

const isAllowed = (rel) => Object.keys(ALLOWED).some((prefix) => rel === prefix || rel.startsWith(prefix));

test('no protocol literals outside the single source of truth, generated artifacts and registered anchors (SC-007)', () => {
  const violations = [];
  for (const rel of walk(REPO_ROOT)) {
    if (isAllowed(rel)) continue;
    const content = readFileSync(join(REPO_ROOT, rel), 'utf8');
    const lines = content.split('\n');
    lines.forEach((line, i) => {
      for (const re of TOKENS) {
        if (re.test(line)) violations.push(`${rel}:${i + 1}: [${re}] ${line.trim().slice(0, 120)}`);
      }
    });
  }
  assert.deepEqual(violations, [], `protocol literals found outside allowed locations:\n${violations.join('\n')}\n→ 改为从 blockchain/protocol.json 读取/生成，或在 ALLOWED 中登记并说明归类`);
});
