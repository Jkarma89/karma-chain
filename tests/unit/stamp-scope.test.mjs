// 出生证明（stamp）的**作用域**：只依赖协议参数侧（功能 005 / T064）。
//
// ## 这套件是 /speckit-analyze 补回来的
//
// 规格的 FR-033 自己写着「MUST 有守卫覆盖『加/删节点后 stamp 六项不变』这条性质本身 ——
// **不能只靠一次人工核对**」。而原先唯一承接它的 T021 **正是一次五台机器的人工现场核对**。
// FR-002（部署描述的版本号 MUST NOT 参与 stamp）此前**一条断言都没有**。
//
// 「字段分离成立」与「版本号被排除在 stamp 外」是**两件事**：
// 有人可能把部署版本号也加进 `stamp_fields()`，而字段分离仍然成立。
//
// ## 为什么这条能纯离线测
//
// stamp 的六项由 `docker/node/entrypoint.sh` 的 `stamp_fields()` 定义，
// 而它们全部取自协议参数文件与创世文件。所以「改部署描述不影响 stamp」
// 不需要起容器就能证明。
//
// ## 输入必须是**合并视图**，否则这套件是假的
//
// 第一版我让复算函数只收 protocol 一个参数，然后写 `computeStamp(protocol, mutated)` ——
// 第二个实参被静默丢掉，两条「改部署不影响 stamp」的断言**根本没把部署当输入**，
// 必然通过。所以这里一律传 `loadProtocol()` 返回的那个**合并对象**：
// 改它的部署侧键是一次真实的输入变化，「输出不变」才是一句有内容的话。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { REPO_ROOT, loadProtocol } from '../../tools/protocol/load.mjs';
import { DEPLOYMENT_FIELDS, VALIDATORS_SPLIT } from '../../tools/protocol/field-ownership.mjs';

const ENTRYPOINT = resolve(REPO_ROOT, 'docker', 'node', 'entrypoint.sh');
const GENESIS_PATH = resolve(REPO_ROOT, 'blockchain', 'genesis', 'karmachain.genesis.json');
const GENESIS_HASH_PATH = resolve(REPO_ROOT, 'blockchain', 'genesis', 'karmachain.genesis.hash');

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

const src = readFileSync(ENTRYPOINT, 'utf8');
/** `stamp_fields()` 的函数体 —— 下面几条断言直接读它，而不是读我的转录。 */
const stampBlock = src.slice(src.indexOf('stamp_fields()'), src.indexOf('check_or_write_stamp'));

/**
 * 复算 stamp 六项。**入参是合并视图**（`loadProtocol()` 的返回形状）。
 *
 * 这是 `stamp_fields()` 的转录，不是它的调用 —— 下面有两条断言双向比对
 * 两者的字段集合，防止转录漂移到「测的已经不是真正的 stamp」。
 */
const computeStamp = (config) => ({
  configVersion: config.configVersion,
  chainId: config.chain.chainId,
  networkId: config.avalanche.networkId,
  blockchainName: config.chain.blockchainName,
  genesisSha256: sha256(GENESIS_PATH),
  genesisBlockHash: readFileSync(GENESIS_HASH_PATH, 'utf8').trim(),
});

const MERGED = loadProtocol();
const BASELINE = computeStamp(MERGED);

describe('转录与 entrypoint.sh 的 stamp_fields() 双向一致', () => {
  test('我转录的六个字段名，stamp_fields() 里都有', () => {
    for (const key of Object.keys(BASELINE)) {
      assert.ok(stampBlock.includes(key),
        `本文件转录了字段 \`${key}\`，而 docker/node/entrypoint.sh 的 stamp_fields() 里没有它。\n`
        + '  两处已漂移 —— 本套件测的就不再是真正的 stamp 了。');
    }
  });

  test('stamp_fields() 里的每个 `--arg` / `--argjson`，我都转录了', () => {
    const declared = [...stampBlock.matchAll(/--argj?son?\s+(\w+)/g)].map((m) => m[1]);
    assert.ok(declared.length > 0, '没能从 stamp_fields() 里解析出任何字段 —— 正则与实现漂移了');
    const mine = new Set(Object.keys(BASELINE));
    const extra = declared.filter((k) => !mine.has(k));
    assert.deepEqual(extra, [],
      `stamp_fields() 里多了字段：${extra.join(', ')}\n`
      + '  **若那是部署描述里的东西，005 的整个承诺就不成立了** —— 改部署会让既有节点退出 12。');
  });
});

describe('结构性事实：节点入口根本看不到部署描述（FR-002）', () => {
  test('stamp_fields() 只从协议文件与创世文件取值', () => {
    assert.ok(stampBlock.includes('"${PROTOCOL}"'), 'stamp_fields() 不再读协议文件？');
    assert.ok(/PROTOCOL="\$\{KARMACHAIN_CONFIG\}\/protocol\.json"/.test(src),
      '`PROTOCOL` 不再绑定到 protocol.json —— 六项的来源变了，本套件的前提失效');
  });

  test('**整个节点入口脚本里没有 deployment 字样**', () => {
    // 这比任何取值断言都强：读不到的文件不可能影响输出。
    // 若日后有人给节点入口加了部署描述的读取，这条会立刻红 —— 那时必须重新论证
    // 「改部署不重置链」是否还成立，而不是顺手把这条断言删掉。
    assert.ok(!/deployment/i.test(src),
      'docker/node/entrypoint.sh 里出现了 deployment —— 节点启动开始依赖部署描述了。\n'
      + '  **改一台机器的端口就可能让七个节点退出 12**，而那正是 005 要消灭的东西。');
  });

  test('部署侧的每个键名都不在 stamp_fields() 的取值路径里', () => {
    const deploymentKeys = [
      ...DEPLOYMENT_FIELDS,
      ...VALIDATORS_SPLIT.deployment.map((k) => `validators.${k}`),
      'deploymentVersion',
    ];
    for (const key of deploymentKeys) {
      assert.ok(!stampBlock.includes(`.${key}`),
        `stamp_fields() 里引用了部署侧的 \`${key}\` —— 005 的承诺就此作废。`);
    }
  });
});

describe('**改部署描述，六项逐字节不变**（合并视图上的行为判据）', () => {
  for (const field of DEPLOYMENT_FIELDS) {
    test(`改 \`${field}\` → stamp 不变`, () => {
      const mutated = { ...MERGED, [field]: { ...MERGED[field], __changed__: true } };
      assert.deepEqual(computeStamp(mutated), BASELINE,
        `改了部署描述的 \`${field}\` 之后 stamp 变了。\n`
        + '  **那意味着加一台机器会让七个节点退出 12、逼出一次全链重置** ——\n'
        + '  而这正是 005 存在的全部理由。');
    });
  }

  test(`改 \`validators.${VALIDATORS_SPLIT.deployment.join('/')}\` → stamp 不变`, () => {
    const mutated = {
      ...MERGED,
      validators: { ...MERGED.validators, count: MERGED.validators.count + 1, nodes: [] },
    };
    assert.deepEqual(computeStamp(mutated), BASELINE,
      '加一个验证者让 stamp 变了 —— 在线增删验证者（US2/US3）从根上不可能。');
  });

  test('**改部署描述的版本号 → stamp 不变**（FR-002）', () => {
    assert.deepEqual(computeStamp({ ...MERGED, deploymentVersion: '99.0.0' }), BASELINE,
      '部署版本号影响了 stamp。\n'
      + '  **「字段分离成立」与「版本号被排除在 stamp 外」是两件事** ——\n'
      + '  有人可能把部署版本号也加进 stamp_fields()，而字段分离仍然成立。');
  });
});

describe('**但保护范围没有缩过头**：真正的协议变更仍在 stamp 里（契约 D-5）', () => {
  for (const [label, mutate] of [
    ['chain.chainId', (c) => ({ ...c, chain: { ...c.chain, chainId: c.chain.chainId + 1 } })],
    ['avalanche.networkId', (c) => ({ ...c, avalanche: { ...c.avalanche, networkId: 999 } })],
    ['chain.blockchainName', (c) => ({ ...c, chain: { ...c.chain, blockchainName: 'other' } })],
    ['configVersion', (c) => ({ ...c, configVersion: '9.9.9' })],
  ]) {
    test(`改 \`${label}\` → stamp **必须**变`, () => {
      assert.notDeepEqual(computeStamp(mutate(MERGED)), BASELINE,
        `改了 \`${label}\` 而 stamp 没变 —— 一次真正的协议变更溜过去了。\n`
        + '  **只做「部署变更不再拦」而不做「协议变更照旧拦」，会得到一个什么都不拦的守卫。**\n'
        + '  本项目已在三处栽过「不会变红的守卫比没有守卫更坏」。');
    });
  }

  test('两项创世指纹确实在六项之列，且不是同一个值', () => {
    assert.match(BASELINE.genesisSha256, /^[0-9a-f]{64}$/);
    assert.match(BASELINE.genesisBlockHash, /^0x[0-9a-f]{64}$/);
    assert.notEqual(BASELINE.genesisSha256, BASELINE.genesisBlockHash.slice(2),
      '一个是创世文件哈希，一个是创世区块哈希 —— 相等说明取值取错了');
  });
});
