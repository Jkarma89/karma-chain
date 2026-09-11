// 部署描述与协议参数**分处两个文件**，且**一次切干净**（功能 005 / T007 / FR-001 / FR-005）。
//
// ## 为什么要分家
//
// `configVersion` 至今递增过四次，每次都让七个节点的出生证明失配、逼出**全链重置**：
//
//   1.1.0  调整开发账户的创世分配            ← 真协议变更（动了创世）
//   1.2.0  新增 endpoints.publishedHosts     ← 部署描述
//   1.3.0  新增 topology                     ← 部署描述
//   1.4.0  节点端口整体迁移（取值见 deployment.json）  ← 部署描述
//
// **四次里三次是部署变更**，而链的身份一个字节都没动。
// 建链初期重置近乎免费，所以没人觉得不对 —— 代价是后来才显现的。
//
// ## 判据是一个问题，不是一张表
//
//     改了这个字段，**已经存在的链上状态还有没有意义**？
//
// 归属表在 `tools/protocol/field-ownership.mjs` —— **生成器与本守卫共用同一份**。
// 两处各写一份必然漂移，而漂移的表现是"守卫说分家干净了，实际没有"。
//
// ## 这套件守的是**文件**，不是内存里的形状
//
// `loadProtocol()` 会把两个文件**合并**成一个对象返回 —— 那是装载层的职责，
// 也是让 30 多个消费者一行不改的关键。合并不等于没分家：
// **文件是分开的，stamp 只算协议那份。**
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  REPO_ROOT, loadProtocol, validateSchema, isAuditSeam, DEFAULT_PROTOCOL_PATH,
} from '../../tools/protocol/load.mjs';
import {
  PROTOCOL_FIELDS, DEPLOYMENT_FIELDS, VALIDATORS_SPLIT, BORDERLINE, ownerOf,
} from '../../tools/protocol/field-ownership.mjs';

const PROTOCOL_PATH = resolve(REPO_ROOT, 'blockchain', 'protocol.json');
const DEPLOYMENT_PATH = resolve(REPO_ROOT, 'blockchain', 'deployment.json');

const readRaw = (p) => JSON.parse(readFileSync(p, 'utf8'));

describe('两个文件都在，且各自能独立解析', () => {
  test('协议参数文件存在', () => {
    assert.ok(existsSync(PROTOCOL_PATH), 'blockchain/protocol.json 不见了');
  });

  test('部署描述文件存在', () => {
    assert.ok(existsSync(DEPLOYMENT_PATH),
      'blockchain/deployment.json 不存在 —— 分家没做，或文件名与 T003 的决定不一致');
  });

  test('部署描述有自己的版本号，且**不叫** configVersion', () => {
    const d = readRaw(DEPLOYMENT_PATH);
    assert.ok(d.deploymentVersion, '部署描述缺自己的版本号');
    assert.ok(!('configVersion' in d),
      '部署描述里出现了 configVersion —— 那是 stamp 的第一项，'
      + '同名会让人以为它也进 stamp（FR-002）');
  });
});

describe('协议参数文件里**不残留**任何部署字段（FR-005：一次切干净）', () => {
  const p = readRaw(PROTOCOL_PATH);

  for (const key of DEPLOYMENT_FIELDS) {
    test(`不含 \`${key}\``, () => {
      assert.ok(!(key in p),
        `\`${key}\` 仍在协议参数文件里。**已拍板：一次切干净，不留向后兼容** ——\n`
        + '  保留兼容会存在**两个事实来源**，而"两个地方都能配"正是 004 刚修的那类问题的根源。');
    });
  }

  test('`validators` 只留协议侧的子键', () => {
    if (!('validators' in p)) return;   // 若整块都移走了也合法
    const keys = Object.keys(p.validators).sort();
    assert.deepEqual(keys, [...VALIDATORS_SPLIT.protocol].sort(),
      `协议侧的 validators 应当只含 ${VALIDATORS_SPLIT.protocol.join(' / ')}（PoA 的治理主体，`
      + `属链上权限）；${VALIDATORS_SPLIT.deployment.join(' / ')} 属部署描述`);
  });

  test('每个顶层字段都在归属表里登记过', () => {
    const unknown = Object.keys(p).filter((k) => ownerOf(k) !== 'protocol' && ownerOf(k) !== 'split');
    assert.deepEqual(unknown, [],
      `协议参数文件里有未登记的顶层字段：${unknown.join(', ')}\n`
      + '  **新增字段时先回答那个问题**：改了它，已经存在的链上状态还有没有意义？\n'
      + '  然后登记进 tools/protocol/field-ownership.mjs —— 不要照着表猜。');
  });
});

describe('部署描述文件里**不混入**协议字段', () => {
  const d = readRaw(DEPLOYMENT_PATH);

  for (const key of PROTOCOL_FIELDS) {
    if (key === '$schema') continue;     // 两边都有自己的 $schema，合法
    test(`不含 \`${key}\``, () => {
      assert.ok(!(key in d),
        `\`${key}\` 出现在部署描述里 —— 它是协议参数，改它就是另一条链。\n`
        + '  放在不进 stamp 的那一侧，等于让一次真正的协议变更悄悄溜过去。');
    });
  }

  test('`validators` 只含部署侧的子键', () => {
    if (!('validators' in d)) return;
    const keys = Object.keys(d.validators).sort();
    assert.deepEqual(keys, [...VALIDATORS_SPLIT.deployment].sort());
  });

  test('每个顶层字段都在归属表里登记过', () => {
    const unknown = Object.keys(d)
      .filter((k) => k !== '$schema' && k !== 'deploymentVersion')
      .filter((k) => ownerOf(k) !== 'deployment' && ownerOf(k) !== 'split');
    assert.deepEqual(unknown, [], `部署描述里有未登记的顶层字段：${unknown.join(', ')}`);
  });
});

describe('三个边界情形的决定被记录下来了（T003 的要求）', () => {
  for (const key of ['avalanche.*Version', 'endpoints.rpcPath', 'validators.count']) {
    test(`\`${key}\` 有决定与理由`, () => {
      const b = BORDERLINE[key];
      assert.ok(b, `边界情形 ${key} 没有登记`);
      assert.ok(b.decision, `${key} 缺决定`);
      assert.ok(b.why && b.why.length > 40,
        `${key} 的理由太短 —— 边界情形是"两侧都说得通"的，`
        + '只写结论不写代价，下一个人会按相反方向改回去');
    });
  }
});

describe('`endpoints.rpcPath` 与 `chain.blockchainName` 一致（边界情形 ② 的守卫）', () => {
  test('路径里的别名就是协议侧声明的链名', () => {
    const p = readRaw(PROTOCOL_PATH);
    const d = readRaw(DEPLOYMENT_PATH);
    const alias = d.endpoints.rpcPath.match(/^\/ext\/bc\/([^/]+)\//)?.[1];
    assert.equal(alias, p.chain.blockchainName,
      `部署侧的 rpcPath 用的别名是 ${JSON.stringify(alias)}，`
      + `而协议侧的 blockchainName 是 ${JSON.stringify(p.chain.blockchainName)}。\n`
      + '  分家之后这两个值住在不同文件里 —— 改了一个忘了另一个，\n'
      + '  链照常跑而所有客户端连不上，**且没有任何东西会红**。这条断言就是那道锁。');
  });
});

describe('审计接缝的宽松**不泄漏**到默认路径（功能 005 实施期发现）', () => {
  // `validate-topology.mjs --protocol <path>` 的调用方传的是一份**合并视图**写成的
  // 单个文件，所以 `loadProtocol(显式路径)` 必须接受它。集成套件
  // tests/integration/topology-cli.test.mjs 抓到了这一点（分家时我漏了这个接缝）。
  //
  // 危险在于修法：如果让装载器"看到部署字段就当成完整配置"，那么有人把 `topology`
  // 写回 blockchain/protocol.json 时，装载器会**静默跳过** deployment.json ——
  // 分家就成了摆设，而且没有任何东西会红。
  // 所以宽松**只对显式路径生效**，本组守的就是这条边界。
  // **这四条是这一组的核心。** 判定原先内嵌在 loadProtocol 的 `if` 里，
  // 于是"宽松不得泄漏到默认路径"做不了变红检查 —— 去掉路径那一半之后全套照旧全绿
  // （2026-09-11 实测）。为此把它提成 `isAuditSeam()`：判定藏在表达式里等于没有判定。
  test('**默认路径 + 带部署字段 → 不是接缝**（泄漏那一半，最危险的一条）', () => {
    const polluted = { ...readRaw(PROTOCOL_PATH), topology: readRaw(DEPLOYMENT_PATH).topology };
    assert.equal(isAuditSeam(DEFAULT_PROTOCOL_PATH, polluted), false,
      '装载器把一份「带 topology 的 blockchain/protocol.json」当成了完整配置 —— 那会让它**静默跳过** deployment.json，两个文件的分家成为摆设，而 protocol.json 里的那份 topology 会被当作事实来源使用。');
  });

  test('显式路径 + 带部署字段 → 是接缝', () => {
    assert.equal(isAuditSeam('/tmp/whole.json', { topology: {}, endpoints: {} }), true);
  });

  test('显式路径 + 不带部署字段 → 不是接缝（要去并部署描述）', () => {
    assert.equal(isAuditSeam('/tmp/protocol-only.json', { configVersion: '1.4.0' }), false);
  });

  test('默认路径 + 不带部署字段 → 不是接缝（常态）', () => {
    assert.equal(isAuditSeam(DEFAULT_PROTOCOL_PATH, readRaw(PROTOCOL_PATH)), false);
  });

  test('协议 schema 本身拒绝带部署字段的协议文件（宽松不来自 schema）', () => {
    const p = readRaw(PROTOCOL_PATH);
    const polluted = { ...p, topology: readRaw(DEPLOYMENT_PATH).topology };
    const errs = validateSchema(polluted, readRaw(resolve(REPO_ROOT, 'blockchain', 'protocol.schema.json')));
    assert.ok(errs.length > 0,
      '协议 schema 接受了带 `topology` 的协议文件。\n'
      + '  **它必须拒绝** —— 否则「一次切干净」只是一句自述，装载器随时会把\n'
      + '  一份半新半旧的协议文件当成完整配置收下，两个文件的分家就此作废。');
  });

  test('显式路径上，一份合并视图必须**被接受**（接缝要真的能用）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kc-seam-'));
    try {
      const file = join(dir, 'whole.json');
      writeFileSync(file, `${JSON.stringify(loadProtocol(), null, 2)}\n`);
      assert.doesNotThrow(() => loadProtocol(file),
        '审计接缝收不下自己吐出来的合并视图 —— `--protocol <path>` 的两个用途都失效了');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('显式路径 + **只含协议参数**的文件 → 仍须并入仓库的部署描述', () => {
    // 这条是宽松的另一半边界：接缝按"这份文件里有没有部署字段"分流，
    // 而不是按"路径是不是显式给的"一刀切。给一份纯协议文件时，
    // 装载器必须照旧去读 deployment.json —— 否则 `topology` 会是 undefined，
    // 而 undefined 不抛异常，只让后面的派生静默变错。
    const dir = mkdtempSync(join(tmpdir(), 'kc-seam-'));
    try {
      const file = join(dir, 'protocol-only.json');
      writeFileSync(file, `${JSON.stringify(readRaw(PROTOCOL_PATH), null, 2)}
`);
      const cfg = loadProtocol(file);
      assert.ok(cfg.topology?.deployments,
        '给一份纯协议文件时，装载器没有并入部署描述 —— topology 是 undefined');
      assert.ok(Array.isArray(cfg.validators?.nodes),
        'validators.nodes 没并进来 —— 端口与密钥目录全都会取到 undefined');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
