// 创世**之后**加入的验证者：身份凭**声明的公开材料**，不从私钥派生（功能 005 / T069）。
//
// ## 为什么必须有这条路
//
// `identityFromKeyDir()` 读 `signer.key`（**BLS 私钥**）来派生公钥。对创世那五个没问题 ——
// 它们的密钥按宪法第四条 v1.1.0 的例外提交在仓库里。
//
// 但 005 的安全约束对**新**验证者更严：私钥**必须在目标机器上生成、
// 不得经过仓库、对话或任何中间环节**。所以仓库里没有它的 `signer.key`，派生这条路走不通。
//
// 2026-09-14 试着往 descriptor 里加第六个验证者时，这一点是**硬卡点**：
// `npm run render` 直接 ENOENT 在 `node-6/staker.crt`，仓库进入无法渲染的状态。
//
// ## 三处必须一起改，少一处就做不成
//
//   ① `identityOf(v)`          —— 有声明用声明，没声明才派生
//   ② `crossCheckIdentity()`   —— 创世制品里永远不会有新成员，按 `origin` **显式**跳过
//   ③ `renderNodeIdentities()` —— 用声明的哈希，而不是去 sha256 一个不存在的文件
//
// ## 这条守卫用**构造的**声明，不依赖仓库里那份
//
// 仓库里的 descriptor 现在确实有一个 origin=joined 的成员了（node-6 / ubuntu-4，
// 材料 2026-09-14 在 192.168.1.31 上生成）。但本套件仍用自己构造的声明 ——
// 否则它就变成了"当前这份配置恰好是对的"，而不是"这条机制成立"。
// 构造的好处还在于能测**缺字段**、**origin 写错**这些真实配置里不该出现的情形。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { loadProtocol, readJson, REPO_ROOT, validateSchema } from '../../tools/protocol/load.mjs';
import {
  identityOf, crossCheckIdentity, cb58Encode, genesisValidators,
} from '../../tools/verify/lib/identity.mjs';
import { renderNodeIdentities } from '../../tools/protocol/render-node-flags.mjs';

const IDENTITY_ARTIFACT = readJson(resolve(REPO_ROOT, 'blockchain', 'chain-identity', 'karmachain.identity.json'));
const DEPLOYMENT_PATH = resolve(REPO_ROOT, 'blockchain', 'deployment.json');
const DEPLOYMENT_SCHEMA = readJson(resolve(REPO_ROOT, 'blockchain', 'deployment.schema.json'));
const BASE = loadProtocol();

// 构造材料一律**派生**，不写字面量（002 的 no-hardcode 守卫本期已抓过我七次）
const h = (s) => createHash('sha256').update(s).digest('hex');
const JOINED = Object.freeze({
  origin: 'joined',
  nodeId: `NodeID-${cb58Encode(Buffer.from(h('probe-node-6-cert').slice(0, 40), 'hex'))}`,
  blsPublicKey: `0x${(h('probe-bls-a') + h('probe-bls-b')).slice(0, 96)}`,
  proofOfPossession: `0x${(h('probe-pop-a') + h('probe-pop-b') + h('probe-pop-c')).slice(0, 192)}`,
  certSha256: h('probe-cert'),
  keySha256: h('probe-key'),
  signerSha256: h('probe-signer'),
  reportedBy: 'probe-host (offline fixture)',
  reportedAt: '2026-09-14',
});

/** 造一份「多了一个创世后加入的验证者」的配置。 */
const withJoined = () => {
  const next = structuredClone(BASE);
  const last = next.validators.nodes[next.validators.nodes.length - 1];
  const index = last.index + 1;
  next.validators.count += 1;
  next.validators.nodes.push({
    index,
    httpPort: last.httpPort + 2,
    stakingPort: last.stakingPort + 2,
    keyDir: `blockchain/validators/dev/node-${index}/`,
    identity: { ...JOINED },
  });
  next.topology.nodes.push({ id: `l1-${index}`, role: 'l1-validator', validatorIndex: index });
  // 保持各形态原有的边界结构（单边界的加进去，多边界的新开一个）——
  // 理由与 tests/unit/add-machine-noop.test.mjs 里那段相同：T-5 只在边界数 > 1 时生效。
  for (const dep of Object.values(next.topology.deployments)) {
    if (dep.failureDomains.length === 1) { dep.failureDomains[0].nodes.push(`l1-${index}`); continue; }
    dep.failureDomains.push({
      id: 'probe-host',
      platform: 'linux',
      address: dep.failureDomains[0].address.replace(/\.\d+$/, '.242'),
      nodes: [`l1-${index}`],
      sharedFailureFactors: [],
    });
  }
  return { config: next, index };
};

/** 往仓库里那份 descriptor 的副本上追加一个验证者声明（只用于 schema 校验）。 */
const declaredWith = (identity) => {
  const d = readJson(DEPLOYMENT_PATH);
  const last = d.validators.nodes.at(-1);
  const index = last.index + 1;
  d.validators.nodes.push({
    index,
    httpPort: last.httpPort + 2,
    stakingPort: last.stakingPort + 2,
    keyDir: `blockchain/validators/dev/node-${index}/`,
    ...(identity ? { identity } : {}),
  });
  return d;
};

describe('① identityOf：有声明用声明，没声明才派生', () => {
  test('创世成员仍从密钥派生（derived = true）', () => {
    // 只取创世那批 —— 声明里现在真的有一个 origin=joined 的成员了（node-6），
    // 遍历全部会把它也要求「从密钥派生」，而那正是本套件要否掉的前提。
    for (const v of genesisValidators(BASE.validators.nodes)) {
      const id = identityOf(v);
      assert.equal(id.derived, true, `${v.keyDir} 应当从密钥派生`);
      assert.match(id.nodeId, /^NodeID-[1-9A-HJ-NP-Za-km-z]+$/);
      assert.match(id.blsPublicKey, /^0x[0-9a-f]{96}$/);
    }
  });

  test('创世后加入的用声明（derived = false），取值逐项透传', () => {
    const id = identityOf({ index: 9, keyDir: 'blockchain/validators/dev/node-9/', identity: { ...JOINED } });
    assert.equal(id.derived, false);
    for (const k of ['nodeId', 'blsPublicKey', 'certSha256', 'keySha256', 'signerSha256']) {
      assert.equal(id[k], JOINED[k], `${k} 没有透传`);
    }
  });

  test('**声明缺任何一项就抛**（半份身份比没有更坏）', () => {
    for (const k of ['nodeId', 'blsPublicKey', 'certSha256', 'keySha256', 'signerSha256']) {
      const partial = { ...JOINED };
      delete partial[k];
      assert.throws(
        () => identityOf({ index: 9, keyDir: 'blockchain/validators/dev/node-9/', identity: partial }),
        new RegExp(k),
        `缺 ${k} 时没抛 —— 渲染出的身份制品会少一个字段，而容器的 `
        + 'check_key_material() 取到 null 就退出 12，报出来的是「身份材料不符」，'
        + '没人会想到是声明写漏了');
    }
  });
});

describe('② crossCheckIdentity：创世制品里不会有新成员', () => {
  test('只有创世那五个时返回空（不回归）', () => {
    assert.deepEqual(crossCheckIdentity(IDENTITY_ARTIFACT, BASE.validators.nodes), []);
  });

  test('多一个 origin=joined 的成员，仍返回空', () => {
    const { config } = withJoined();
    assert.deepEqual(crossCheckIdentity(IDENTITY_ARTIFACT, config.validators.nodes), [],
      '创世后加入的成员被拿去和建链制品比了 —— 那份制品记录的是链的**出生**，'
      + '不是当前成员，它永远不会有新加入者');
  });

  test('**没有 origin=joined 却不在制品里 → 必须报错**（保护范围没缩过头）', () => {
    const { config } = withJoined();
    // 去掉 origin，它就不再是「声明过的新成员」，而是一个来源不明的验证者
    delete config.validators.nodes.at(-1).identity.origin;
    const problems = crossCheckIdentity(IDENTITY_ARTIFACT, config.validators.nodes);
    assert.ok(problems.length > 0,
      '一个既不在建链制品里、又没声明 origin=joined 的验证者被放行了。'
      + '**这条是 ② 的边界**：若改成「制品里查不到就当成新成员」，'
      + '创世成员的材料被换掉时（证书打错、密钥目录指错）会被静默放行。');
  });

  test('创世成员的密钥目录被换掉 → 制品里那一项无人认领 → 必须报错', () => {
    const swapped = BASE.validators.nodes.map((v, i) =>
      (i === 0 ? { ...v, keyDir: BASE.validators.nodes[1].keyDir } : v));
    const problems = crossCheckIdentity(IDENTITY_ARTIFACT, swapped);
    assert.ok(problems.some((p) => p.includes('no validator key directory derives it')),
      `换掉一个创世成员的密钥目录后没报出「制品里还剩谁」：\n  ${problems.join('\n  ')}`);
  });
});

describe('③ renderNodeIdentities：用声明的哈希，不去 sha256 不存在的文件', () => {
  const { config, index } = withJoined();
  const rendered = renderNodeIdentities(config, IDENTITY_ARTIFACT, 'lan');
  const joinedId = `l1-${index}`;

  test('渲染不再因为读不到私钥而失败', () => {
    assert.ok(rendered[joinedId], `${joinedId} 没渲染出来`);
  });

  test('新成员的身份取自声明', () => {
    for (const k of ['nodeId', 'blsPublicKey', 'certSha256', 'keySha256', 'signerSha256']) {
      assert.equal(rendered[joinedId][k], JOINED[k], `${k} 不是声明里的值`);
    }
  });

  test('**字段名与创世成员完全一致**（容器逐个 jq 取值，少一个就退出 12）', () => {
    assert.deepEqual(Object.keys(rendered[joinedId]).sort(), Object.keys(rendered['l1-1']).sort(),
      '两种来源渲染出的身份制品字段集合不同 —— docker/node/entrypoint.sh 的 '
      + 'check_key_material() 按固定字段名 jq 取值，缺一个取到 null、直接退出 12');
  });

  test('创世成员的渲染结果**没有变**（这条改动不许影响既有节点）', () => {
    const before = renderNodeIdentities(BASE, IDENTITY_ARTIFACT, 'lan');
    for (const id of Object.keys(before)) {
      assert.deepEqual(rendered[id], before[id], `${id} 的身份制品变了`);
    }
  });
});

describe('schema：identity 可选，但声明了就必须完整', () => {
  test('创世那五个不写 identity 也合法（仓库里那份就是）', () => {
    assert.deepEqual(validateSchema(readJson(DEPLOYMENT_PATH), DEPLOYMENT_SCHEMA), []);
  });

  test('带完整 identity 的声明合法', () => {
    assert.deepEqual(validateSchema(declaredWith({ ...JOINED }), DEPLOYMENT_SCHEMA), []);
  });

  test('**identity 少一项 → schema 拒绝**（不能等到渲染或启动才发现）', () => {
    const partial = { ...JOINED };
    delete partial.signerSha256;
    assert.ok(validateSchema(declaredWith(partial), DEPLOYMENT_SCHEMA).length > 0,
      'schema 收下了半份 identity');
  });

  test('origin 只允许 joined（创世成员不得声明 origin）', () => {
    assert.ok(validateSchema(declaredWith({ ...JOINED, origin: 'genesis' }), DEPLOYMENT_SCHEMA).length > 0,
      'origin 收下了 genesis —— 那会让「创世成员从密钥派生」这条路出现第二种表达');
  });

  test('多余字段被拒（additionalProperties: false）', () => {
    assert.ok(validateSchema(declaredWith({ ...JOINED, privateKey: 'x' }), DEPLOYMENT_SCHEMA).length > 0,
      'identity 收下了未登记的字段 —— **尤其危险**：'
      + '有人可能顺手把私钥塞进来，而 005 的安全约束正是禁止私钥进仓库');
  });
});
