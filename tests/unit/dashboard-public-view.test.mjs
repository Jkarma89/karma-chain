// T062 / T063 / T064 —— 公开投影的三层守卫（功能 003 / FR-026、FR-027、FR-028）。
//
// ## 三层，缺一不可
//
//   ① 结构断言 —— 输出的键集合**等于**白名单。多一个键即失败
//   ② 内容扫描 —— 对输出的 JSON 文本扫描禁止模式
//   ③ **行为探针** —— 喂一个刻意含敏感值的假快照，断言那些**值**不出现在输出里
//
// **第 3 层是关键。** 只有前两层时，一个"看起来有白名单常量但白名单没被真正应用"
// 的错误实现依然全绿 —— 002 反复教过这一课：
// **静态守卫只证明了没用错写法，没证明用对了。**
//
// ## 方向必须是白名单
//
// 黑名单（"删掉 nodeId 和 address"）在有人给快照加一个新字段时**默认放行** ——
// 而那正是泄漏发生的方式。白名单方向是唯一能随快照结构演进而保持安全的方向。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { toPublicView, PUBLIC_FIELDS } from '../../tools/dashboard/public-view.mjs';
import { REPO_ROOT } from '../../tools/protocol/load.mjs';

const PROTOCOL = JSON.parse(readFileSync(resolve(REPO_ROOT, 'blockchain/protocol.json'), 'utf8'));

/** 一份结构完整、且**刻意塞满敏感值**的假快照。 */
const SENSITIVE = {
  nodeId: 'NodeID-7Xhw2mDxuDS44j42TCB6U5579esbSt3Lg',
  // 刻意用不在实际部署里的私网地址：探针要验的是"私网地址不得泄漏"，
  // 而写真实的部署地址会让协议参数在测试里多出一个副本（002 的守卫会抓）。
  lanAddress: '192.168.99.99',
  privateNet10: '10.7.0.2',
  privateNet172: '172.20.7.7',
  repoPath: '/workspace/blockchain/genesis/karmachain.genesis.json',
  containerName: 'karmachain-l1-3',
  hostName: 'ubuntu-1',
  version: 'avalanchego v1.14.1',
  genesis: '0x19cfde1f02e585020cdae83071bac33c7d81e411cacf7f306b82ceabe98892ed',
  blockchainId: '2W9boARgCWL25z6pMFNtkCfNA5v28VGg9PmBgUJfuKndEdhrvw',
};

const fakeSnapshot = () => ({
  collectedAt: 1_760_000_000_000,
  pollIntervalMs: 2000,
  deployment: 'lan',
  networkHeight: 748,
  tier: 'normal',
  healthPercent: 100,
  participating: 5,
  threshold: 4,
  validatorCount: 5,
  maxOfflineValidators: 1,
  observedValidators: 5,
  validatorMargin: 1,
  domainMargin: 1,
  notParticipatingIds: ['l1-3'],
  faultTolerance: {
    validatorCount: 5,
    maxOfflineValidators: 1,
    domainCount: 5,
    effectiveDomains: [{ ids: [SENSITIVE.hostName], factors: ['power:rack-A'], validators: 1 }],
    tolerateWholeDomainLoss: true,
  },
  observer: {
    reachableNodes: 7,
    totalNodes: 7,
    blind: false,
    pathAlive: [{ domain: SENSITIVE.hostName, alive: true, status: 200 }],
  },
  chainIdentity: {
    chainId: PROTOCOL.chain.chainId,
    networkId: PROTOCOL.avalanche.networkId,
    chainAlias: 'karmachain',
    blockchainId: SENSITIVE.blockchainId,
    rpcPath: '/ext/bc/karmachain/rpc',
    publishedHosts: ['127.0.0.1', 'localhost'],
    baselineGenesisHash: SENSITIVE.genesis,
    forkDetected: false,
    unknownGenesis: false,
  },
  nodes: [{
    id: 'l1-3',
    role: 'l1-validator',
    domain: SENSITIVE.hostName,
    address: SENSITIVE.lanAddress,
    nodeId: SENSITIVE.nodeId,
    state: 'healthy',
    detail: `已追平；配置来自 ${SENSITIVE.repoPath}`,
    height: 748,
    peers: 6,
    genesisHash: SENSITIVE.genesis,
    genesisMatchesBaseline: true,
    participatesInConsensus: true,
    incidentClass: null,
    countsAsOffline: false,
    countsTowardTolerance: true,
    behindBlocks: 0,
  }],
  incidents: [{
    class: 'node-infra',
    message: `${SENSITIVE.containerName} 已退出（码 137）`,
    action: `到 ${SENSITIVE.hostName}（${SENSITIVE.lanAddress}）上查`,
    nodeId: 'l1-3',
  }],
  containerFacts: { available: false, reason: '缺失', degraded: true, note: `见 ${SENSITIVE.repoPath}` },
  summaryLine: `5/5 验证者在线；${SENSITIVE.version}`,
});

describe('第 1 层：结构断言 —— 键集合等于白名单（T062）', () => {
  test('白名单就是契约里那九个字段', () => {
    assert.deepEqual([...PUBLIC_FIELDS].sort(), [
      'chainAlias', 'chainId', 'collectedAt', 'healthPercent',
      'networkHeight', 'networkId', 'publishedHosts', 'rpcPath', 'tier',
    ]);
  });

  test('输出的键集合**恰好**等于白名单，多一个即失败', () => {
    const out = toPublicView(fakeSnapshot());
    assert.deepEqual(Object.keys(out).sort(), [...PUBLIC_FIELDS].sort(),
      '多出的键说明白名单没被真正应用；少掉的键说明投影漏了字段。'
      + '两种情况都要求人显式决定，而不是默认放行');
  });

  test('快照多出一个新字段时，投影**不**把它带出去', () => {
    // 这一条模拟"日后有人给快照加字段"—— 白名单方向下它默认**不**公开。
    const out = toPublicView({ ...fakeSnapshot(), someNewInternalField: SENSITIVE.nodeId });
    assert.deepEqual(Object.keys(out).sort(), [...PUBLIC_FIELDS].sort());
    assert.ok(!JSON.stringify(out).includes(SENSITIVE.nodeId));
  });

  test('首轮未完成的快照也能安全投影（不抛、不泄漏）', () => {
    const out = toPublicView({ collectedAt: null, tier: null, deployment: 'lan' });
    assert.deepEqual(Object.keys(out).sort(), [...PUBLIC_FIELDS].sort());
    assert.equal(out.collectedAt, null);
    assert.equal(out.tier, null);
  });

  test('投影不修改入参', () => {
    const s = fakeSnapshot();
    const before = JSON.stringify(s);
    toPublicView(s);
    assert.equal(JSON.stringify(s), before);
  });
});

describe('第 2 层：内容扫描 —— 禁止模式（T063）', () => {
  const FORBIDDEN = [
    { re: /NodeID-/, why: '验证者身份' },
    { re: /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, why: '私网地址 10/8' },
    { re: /\b192\.168\.\d{1,3}\.\d{1,3}\b/, why: '私网地址 192.168/16' },
    { re: /\b172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/, why: '私网地址 172.16/12' },
    { re: /blockchain\//, why: '仓库内路径' },
    { re: /\/workspace/, why: '容器内路径' },
    { re: /tools\//, why: '仓库内路径' },
    { re: /karmachain-l1-|karmachain-primary-|karmachain-rpc-/, why: '容器名' },
    { re: /avalanchego v?\d|subnet-evm v?\d/i, why: '内部组件版本号' },
  ];

  const text = () => JSON.stringify(toPublicView(fakeSnapshot()));

  for (const { re, why } of FORBIDDEN) {
    test(`不出现 ${re.source} —— ${why}`, () => {
      assert.doesNotMatch(text(), re);
    });
  }

  test('也不出现 genesisHash / blockchainId / peers / detail 这几个内部事实', () => {
    const out = toPublicView(fakeSnapshot());
    const t = JSON.stringify(out);
    assert.ok(!t.includes(SENSITIVE.genesis), '创世哈希不该出现在对外视图');
    assert.ok(!t.includes(SENSITIVE.blockchainId), 'blockchainID 不该出现');
    assert.ok(!('nodes' in out), '逐节点明细一律不公开');
    assert.ok(!('incidents' in out), '异常清单含内部地址与容器名');
    assert.ok(!('observer' in out), '观察者视角是内部事实');
    assert.ok(!('faultTolerance' in out), '边界结构含机器 id');
    assert.ok(!('summaryLine' in out), '那句话可能含组件版本');
  });

  test('publishedHosts 被保留，且它本身不含私网地址', () => {
    // 既有 tests/unit/public-artifacts.test.mjs 已禁止 protocol.json 的该字段含私网地址；
    // 这里确认投影用的就是它，而**不是** failureDomains 的地址。
    const out = toPublicView(fakeSnapshot());
    assert.deepEqual(out.publishedHosts, ['127.0.0.1', 'localhost']);
    for (const h of out.publishedHosts) {
      assert.doesNotMatch(h, /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/);
    }
  });
});

describe('第 3 层：行为探针 —— 敏感**值**不出现在输出里（T064）', () => {
  // **这是关键的一层。** 前两层都可能被一个"有白名单常量但没应用"的实现骗过。
  // 这一层拿真实的敏感值去对照真实的输出。
  test('假快照里塞的每一个敏感值都不出现在投影结果中', () => {
    const out = JSON.stringify(toPublicView(fakeSnapshot()));
    for (const [name, value] of Object.entries(SENSITIVE)) {
      assert.ok(!out.includes(value),
        `投影输出里出现了 ${name}：${value}\n  白名单没被真正应用 —— 这正是第 3 层要抓的东西`);
    }
  });

  test('敏感值出现在**任意**位置都抓得到（顶层 / 嵌套 / 数组 / 字符串内）', () => {
    // 分别放在四种位置，逐个确认都不会漏出去
    const cases = [
      { top: SENSITIVE.nodeId },
      { nested: { deep: { deeper: SENSITIVE.lanAddress } } },
      { arr: [{ x: SENSITIVE.containerName }] },
      { summaryLine: `一切正常，${SENSITIVE.version}` },
    ];
    for (const extra of cases) {
      const out = JSON.stringify(toPublicView({ ...fakeSnapshot(), ...extra }));
      for (const value of Object.values(SENSITIVE)) {
        assert.ok(!out.includes(value), `${JSON.stringify(extra).slice(0, 40)} 中的值泄漏了：${value}`);
      }
    }
  });

  test('这个探针本身会变红吗 —— 用一个黑名单式的错误实现验证', () => {
    // 模拟"删掉不允许的字段"这种黑名单实现：它对已知字段有效，
    // 但**新字段默认放行**。探针必须抓住它。
    const blacklistProjection = (s) => {
      const copy = { ...s };
      delete copy.nodes;
      delete copy.incidents;
      delete copy.observer;
      return copy;                           // someNewInternalField 会被原样带出
    };
    const leaked = JSON.stringify(blacklistProjection({
      ...fakeSnapshot(),
      someNewInternalField: SENSITIVE.nodeId,
    }));
    assert.ok(leaked.includes(SENSITIVE.nodeId),
      '黑名单实现确实会泄漏 —— 所以探针的判据（值不出现）是有意义的');
    // 而白名单实现不会
    const safe = JSON.stringify(toPublicView({
      ...fakeSnapshot(),
      someNewInternalField: SENSITIVE.nodeId,
    }));
    assert.ok(!safe.includes(SENSITIVE.nodeId));
  });
});

describe('对外视图不隐瞒链的可用性', () => {
  test('stopped 档时仍正确显示档位与百分比', () => {
    const out = toPublicView({
      ...fakeSnapshot(), tier: 'stopped', healthPercent: 60,
    });
    assert.equal(out.tier, 'stopped');
    assert.equal(out.healthPercent, 60);
  });

  test('observer-blind 档也如实显示 —— 不美化成 normal', () => {
    const out = toPublicView({ ...fakeSnapshot(), tier: 'observer-blind', healthPercent: 0 });
    assert.equal(out.tier, 'observer-blind');
  });
});
