// T057 / T058 —— 分叉检测与健康度是并列的两个维度（功能 003 / FR-024、FR-025）。
//
// ## 为什么分叉不能是健康度的一个档位
//
// 一个创世哈希与基准不符的节点**自己活得很好**：它已引导、在出块、peers 正常，
// 健康度可以是 100%。它只是**不在同一条链上**。
//
// 把它算进健康度会得出一个自相矛盾的结论（"链 100% 正常，但有台机器在别的链上"），
// 而把它当成节点故障又会指错处置方向（去重启一台运行正常的机器）。
// 所以它是一条**并列**的警报。
//
// ## 三值语义（T058）
//
// `genesisMatchesBaseline` 必须是 true / false / **null** 三值：
// null 是"未取到"，与 false（不匹配）**不是一回事**。把取不到当成不匹配，
// 会在链路抖动时虚报分叉 —— 而分叉是比节点下线严重得多的警报，
// **虚报一次，之后就没人信它了**。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  deriveTier, buildIncidents, buildChainIdentity, enrichRows, TIERS,
} from '../../tools/dashboard/snapshot.mjs';
import { REPO_ROOT } from '../../tools/protocol/load.mjs';

const BASELINE = '0x19cfde1f02e585020cdae83071bac33c7d81e411cacf7f306b82ceabe98892ed';
const OTHER = '0xdeadbeef02e585020cdae83071bac33c7d81e411cacf7f306b82ceabe98892ed';

let seq = 0;
const v = (over = {}) => ({
  id: `l1-${(seq += 1)}`,
  role: 'l1-validator',
  state: 'healthy',
  countsTowardTolerance: true,
  countsAsOffline: false,
  reachable: true,
  height: 748,
  genesisHash: BASELINE,
  ...over,
});

const primary = (over = {}) => ({
  id: `primary-${(seq += 1)}`,
  role: 'primary',
  state: 'healthy',
  countsTowardTolerance: false,
  countsAsOffline: false,
  reachable: true,
  height: null,
  genesisHash: null,     // Primary 不服务 L1，取不到 L1 的创世
  ...over,
});

const LAN = () => ({
  validatorCount: 5,
  maxOfflineValidators: 1,
  domainCount: 5,
  maxValidatorsPerDomain: 1,
  declaredWithinLimit: true,
  effectiveDomainCount: 5,
  effectiveDomains: Array.from({ length: 5 }, (_, i) => ({ ids: [`d${i}`], factors: [], validators: 1 })),
  tolerateWholeDomainLoss: true,
});

const obs = () => ({ reachableNodes: 7, totalNodes: 7, blind: false, pathAlive: [] });
// 链身份从唯一事实来源读 —— 在测试里复制一份就多了一个副本（002 的 no-hardcode 守卫会抓）。
const protocol = JSON.parse(readFileSync(resolve(REPO_ROOT, 'blockchain/protocol.json'), 'utf8'));
const chain = {
  chainId: protocol.chain.chainId,
  networkId: protocol.avalanche.networkId,
  chainAlias: protocol.chain.blockchainName,
};

const enrich = (rows) => enrichRows({ rows, networkHeight: 748, baselineGenesisHash: BASELINE });

describe('enrichRows —— 创世哈希比对的三值语义（T058）', () => {
  test('相同 → true', () => {
    assert.equal(enrich([v()])[0].genesisMatchesBaseline, true);
  });

  test('不同 → false', () => {
    assert.equal(enrich([v({ genesisHash: OTHER })])[0].genesisMatchesBaseline, false);
  });

  test('未取到（null）→ null，**不是** false', () => {
    const got = enrich([v({ genesisHash: null })])[0];
    assert.equal(got.genesisMatchesBaseline, null);
    assert.notEqual(got.genesisMatchesBaseline, false,
      '把取不到当成不匹配会虚报分叉 —— 虚报一次这条警报就再没人信');
  });

  test('大小写不敏感 —— RPC 返回的十六进制大小写不该造成假分叉', () => {
    assert.equal(enrich([v({ genesisHash: BASELINE.toUpperCase().replace('0X', '0x') })])[0]
      .genesisMatchesBaseline, true);
  });

  test('基准缺失时全部为 null，而不是全部 false', () => {
    const got = enrichRows({ rows: [v()], networkHeight: 748, baselineGenesisHash: null });
    assert.equal(got[0].genesisMatchesBaseline, null,
      '读不到仓库基准时不能把所有节点都判成分叉');
  });
});

describe('buildChainIdentity —— 分叉与未知的判定', () => {
  test('全部匹配 → forkDetected 与 unknownGenesis 均为 false', () => {
    const rows = enrich([v(), v(), v(), v(), v(), primary(), primary()]);
    const id = buildChainIdentity({ chain, baselineGenesisHash: BASELINE, rows });
    assert.equal(id.forkDetected, false);
    assert.equal(id.unknownGenesis, false);
  });

  test('任一验证者不匹配 → forkDetected 为 true', () => {
    const rows = enrich([v(), v(), v(), v(), v({ genesisHash: OTHER }), primary(), primary()]);
    const id = buildChainIdentity({ chain, baselineGenesisHash: BASELINE, rows });
    assert.equal(id.forkDetected, true);
  });

  test('Primary 的 null 不算 unknownGenesis —— 它们不参与容错计数，本就取不到 L1 创世', () => {
    const rows = enrich([v(), v(), v(), v(), v(), primary(), primary()]);
    const id = buildChainIdentity({ chain, baselineGenesisHash: BASELINE, rows });
    assert.equal(id.unknownGenesis, false,
      'Primary 的 genesisHash 恒为 null，若把它算进 unknownGenesis，面板会永远显示"有节点创世未知"');
  });

  test('可达的验证者取不到创世 → unknownGenesis 为 true，但 forkDetected 仍为 false', () => {
    const rows = enrich([v(), v(), v(), v(), v({ genesisHash: null }), primary(), primary()]);
    const id = buildChainIdentity({ chain, baselineGenesisHash: BASELINE, rows });
    assert.equal(id.unknownGenesis, true, '要如实说"有一个没取到"');
    assert.equal(id.forkDetected, false, '**但不得因此报分叉**');
  });

  test('不可达的验证者不算 unknownGenesis —— 连不上当然取不到，那不是新信息', () => {
    const rows = enrich([v(), v(), v(), v(),
      v({ reachable: false, genesisHash: null, state: 'unreachable', countsAsOffline: true })]);
    const id = buildChainIdentity({ chain, baselineGenesisHash: BASELINE, rows });
    assert.equal(id.unknownGenesis, false);
  });

  test('链身份字段被原样带出（FR-024）', () => {
    const id = buildChainIdentity({ chain, baselineGenesisHash: BASELINE, rows: enrich([v()]) });
    assert.equal(id.chainId, protocol.chain.chainId);
    assert.equal(id.networkId, protocol.avalanche.networkId);
    assert.equal(id.chainAlias, protocol.chain.blockchainName);
    assert.equal(id.baselineGenesisHash, BASELINE);
  });
});

describe('分叉不改变健康度与档位（T057 / FR-025）', () => {
  test('一个节点创世不符而全部参与 → 100% / normal / 余量 1，同时 forkDetected 为 true', () => {
    const rows = enrich([v(), v(), v(), v(), v({ genesisHash: OTHER }), primary(), primary()]);
    const tierInfo = deriveTier({ rows, faultTolerance: LAN(), observer: obs() });
    const id = buildChainIdentity({ chain, baselineGenesisHash: BASELINE, rows });

    assert.equal(tierInfo.healthPercent, 100, '那个节点自己活得很好，健康度不受影响');
    assert.equal(tierInfo.tier, TIERS.NORMAL);
    assert.equal(tierInfo.validatorMargin, 1);
    assert.equal(id.forkDetected, true, '但分叉必须被报出来');
  });

  test('档位判定式里根本不含 genesisMatchesBaseline —— 改它不会改档位', () => {
    const clean = enrich([v(), v(), v(), v(), v(), primary(), primary()]);
    const forked = enrich([v(), v(), v(), v(), v({ genesisHash: OTHER }), primary(), primary()]);
    const a = deriveTier({ rows: clean, faultTolerance: LAN(), observer: obs() });
    const b = deriveTier({ rows: forked, faultTolerance: LAN(), observer: obs() });
    assert.deepEqual(
      { tier: b.tier, healthPercent: b.healthPercent, validatorMargin: b.validatorMargin, domainMargin: b.domainMargin },
      { tier: a.tier, healthPercent: a.healthPercent, validatorMargin: a.validatorMargin, domainMargin: a.domainMargin },
    );
  });

  test('分叉产生一条 chain-identity 异常，且不产生 consensus-margin', () => {
    const rows = enrich([v(), v(), v(), v(), v({ genesisHash: OTHER })]);
    const id = buildChainIdentity({ chain, baselineGenesisHash: BASELINE, rows });
    const incidents = buildIncidents({ rows, tier: TIERS.NORMAL, observer: obs(), chainIdentity: id });
    assert.equal(incidents.filter((i) => i.class === 'chain-identity').length, 1);
    assert.equal(incidents.filter((i) => i.class === 'consensus-margin').length, 0,
      '跑在别的链上不是共识余量问题 —— 处置方向完全不同');
  });

  test('chain-identity 异常里点出了具体是哪些节点', () => {
    const rows = enrich([v({ id: 'l1-a' }), v({ id: 'l1-b', genesisHash: OTHER })]);
    const id = buildChainIdentity({ chain, baselineGenesisHash: BASELINE, rows });
    const incident = buildIncidents({ rows, tier: TIERS.NORMAL, observer: obs(), chainIdentity: id })
      .find((i) => i.class === 'chain-identity');
    assert.match(incident.message, /l1-b/, '要说清是哪一台，否则运维无从下手');
    assert.doesNotMatch(incident.message, /l1-a/, '不该把好的那台也列进去');
  });

  test('genesisMatchesBaseline 全为 null 时不产生 chain-identity 异常（T058）', () => {
    const rows = enrich([v({ genesisHash: null }), v({ genesisHash: null })]);
    const id = buildChainIdentity({ chain, baselineGenesisHash: BASELINE, rows });
    const incidents = buildIncidents({ rows, tier: TIERS.NORMAL, observer: obs(), chainIdentity: id });
    assert.equal(incidents.filter((i) => i.class === 'chain-identity').length, 0);
  });
});
