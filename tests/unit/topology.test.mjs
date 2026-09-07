// T017：拓扑声明的约束校验（功能 002）。
// 约束编号见 specs/002-resilient-validator-network/data-model.md §1。
// 全部用内存对象构造，不改动 blockchain/protocol.json。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadProtocol, validateProtocol, validateConstraints, deriveTopology, readJson, DEFAULT_SCHEMA_PATH, TOPOLOGY_VIOLATION_TAG } from '../../tools/protocol/load.mjs';
import { analyze } from '../../tools/protocol/validate-topology.mjs';
import { readInventory } from '../../tools/verify/lib/avalanche-api.mjs';

const SCHEMA = readJson(DEFAULT_SCHEMA_PATH);
const BASE = loadProtocol();
const clone = () => JSON.parse(JSON.stringify(BASE));

/** 构造一个多边界部署并设为生效形态。 */
function withDeployment(domains, name = 'test') {
  const p = clone();
  p.topology.deployments[name] = { description: `测试形态 ${name}`, failureDomains: domains };
  p.topology.activeDeployment = name;
  return p;
}

const dom = (id, nodes, extra = {}) => ({
  id, platform: 'linux', address: '10.0.0.1', nodes, sharedFailureFactors: [], ...extra,
});

const errorsOf = (p) => validateConstraints(p);
const hasError = (p, needle) => errorsOf(p).some((e) => e.includes(needle));

describe('拓扑约束', () => {
  test('仓库中的实际拓扑合法', () => {
    const { ok, errors } = validateProtocol(BASE, SCHEMA);
    assert.ok(ok, `protocol.json 应当合法，但有：${errors.join('; ')}`);
  });

  test('T-1 / T-2：节点数量必须与 validators.count 和 primaryNetwork.nodeCount 一致', () => {
    const p = clone();
    p.topology.nodes = p.topology.nodes.filter((n) => n.id !== 'l1-5');
    assert.ok(hasError(p, 'validators.count is 5'), '少一个验证者应当报错');

    const q = clone();
    q.topology.nodes = q.topology.nodes.filter((n) => n.id !== 'primary-2');
    assert.ok(hasError(q, 'primaryNetwork.nodeCount is 2'), '少一个 primary 应当报错');
  });

  test('T-6：节点 id 必须唯一', () => {
    const p = clone();
    p.topology.nodes[1].id = 'l1-1';
    assert.ok(hasError(p, 'must be unique'), '重复 id 应当报错');
  });

  test('validatorIndex 必须恰好覆盖 validators.nodes 的全部索引', () => {
    const p = clone();
    p.topology.nodes.find((n) => n.id === 'l1-5').validatorIndex = 1;   // 与 l1-1 重复
    assert.ok(hasError(p, 'exactly once each'), '索引重复应当报错');
  });

  test('T-3：activeDeployment 必须存在于 deployments 中', () => {
    const p = clone();
    p.topology.activeDeployment = 'nonexistent';
    assert.ok(hasError(p, 'is not a key of topology.deployments'));
  });

  test('T-4：故障边界成员并集必须等于节点全集且互不重叠', () => {
    const missing = withDeployment([dom('a', ['l1-1', 'l1-2', 'primary-1']), dom('b', ['l1-3', 'l1-4', 'primary-2'])]);
    assert.ok(hasError(missing, 'not assigned to any failure domain'), '漏掉 l1-5 应当报错');

    const overlap = withDeployment([
      dom('a', ['l1-1', 'l1-2', 'l1-3', 'primary-1']),
      dom('b', ['l1-3', 'l1-4', 'l1-5', 'primary-2']),   // l1-3 重复
    ]);
    assert.ok(hasError(overlap, 'more than one failure domain'), '节点跨边界应当报错');

    const unknown = withDeployment([dom('a', ['l1-1', 'l1-2', 'l1-3', 'l1-4', 'l1-5', 'primary-1', 'primary-2', 'ghost'])]);
    assert.ok(hasError(unknown, 'unknown node id'), '未知节点 id 应当报错');
  });

  test('T-5：单边界形态（阶段一）不受容错约束限制', () => {
    // 仓库中的 local 形态就是 1 个边界含 5 个验证者 —— 不得报错
    const errs = errorsOf(BASE).filter((e) => e.includes('limit is'));
    assert.equal(errs.length, 0, `单边界不该触发容错约束，但报了：${errs.join('; ')}`);
  });

  test('T-5：多边界下任一边界超过 ⌊n/4⌋ 个验证者即违规', () => {
    const bad = withDeployment([
      dom('win-1', ['l1-1', 'l1-2', 'primary-1']),   // 2 个验证者 > 上限 1
      dom('win-2', ['l1-3', 'primary-2']),
      dom('u-1', ['l1-4']),
      dom('u-2', ['l1-5']),
    ]);
    const errs = errorsOf(bad);
    const hit = errs.find((e) => e.includes("'win-1'"));
    assert.ok(hit, `应当指出 win-1 违规，实际：${errs.join('; ')}`);
    // 文案依 contracts/cli-interface.md：边界 id、实际数量、上限、以及把哪个节点挪走
    assert.match(hit, /含 2 个 L1 验证者/, '应指出实际数量');
    assert.match(hit, /上限为 1/, '应指出上限');
    assert.match(hit, /查询门槛 75%/, '应给出上限的来由');
    assert.match(hit, /把 l1-2 移到另一个边界，或增加边界数量/, '必须给出可执行的修正方向，并点名具体节点');
    // 退出码 13 的映射靠这个标记，不靠散文 —— 改文案不得让判据静默失效
    assert.ok(hit.startsWith(TOPOLOGY_VIOLATION_TAG), `违规消息须带 ${TOPOLOGY_VIOLATION_TAG} 标记，实际：${hit}`);
  });

  test('T-5 的违规消息带机器可读标记，且合法拓扑不带', () => {
    const ok = withDeployment([
      dom('d1', ['l1-1', 'primary-1']), dom('d2', ['l1-2', 'primary-2']),
      dom('d3', ['l1-3']), dom('d4', ['l1-4']), dom('d5', ['l1-5']),
    ]);
    assert.ok(!errorsOf(ok).some((e) => e.includes(TOPOLOGY_VIOLATION_TAG)),
      '合法拓扑不得产生 T-5 标记 —— 否则退出码 13 会误报');
  });

  test('T-5：5 边界各 1 个验证者合法，且可容忍整域失效', () => {
    const good = withDeployment([
      dom('d1', ['l1-1', 'primary-1']),
      dom('d2', ['l1-2', 'primary-2']),
      dom('d3', ['l1-3']),
      dom('d4', ['l1-4']),
      dom('d5', ['l1-5']),
    ]);
    assert.deepEqual(errorsOf(good), [], '合法拓扑不该报错');
    const ft = deriveTopology(good).faultTolerance;
    assert.equal(ft.maxOfflineValidators, 1);
    assert.equal(ft.domainCount, 5);
    assert.equal(ft.tolerateWholeDomainLoss, true);
  });
});

describe('容错推导', () => {
  test('f ≤ ⌊n/4⌋：n=5 时可容忍 1 个', () => {
    assert.equal(deriveTopology(BASE).faultTolerance.maxOfflineValidators, 1);
  });

  test('单边界形态不承诺整机失效容错', () => {
    const ft = deriveTopology(BASE).faultTolerance;
    assert.equal(ft.domainCount, 1);
    assert.equal(ft.tolerateWholeDomainLoss, false, '1 个边界失效等于全部失效，不能声称可容忍');
  });

  test('验证者端口来自 validators.nodes[]，primary 端口来自 topology —— 无重复来源', () => {
    const nodes = deriveTopology(BASE).topologyNodes;
    for (const v of BASE.validators.nodes) {
      const n = nodes.find((x) => x.role === 'l1-validator' && x.keyDir === v.keyDir);
      assert.ok(n, `validators.nodes[${v.index}] 应当被某个拓扑节点引用`);
      assert.equal(n.httpPort, v.httpPort, '端口必须解析自 validators.nodes[]');
      assert.equal(n.stakingPort, v.stakingPort);
    }
    const validatorKeyDirs = new Set(BASE.validators.nodes.map((v) => v.keyDir));
    for (const t of BASE.topology.nodes.filter((n) => n.role === 'primary')) {
      const n = nodes.find((x) => x.id === t.id);
      assert.equal(n.httpPort, t.httpPort, 'primary 端口必须解析自 topology');
      assert.equal(n.keyDir, t.keyDir, 'primary 的 keyDir 必须解析自 topology');
      assert.ok(!validatorKeyDirs.has(n.keyDir), 'primary 不得复用 L1 验证者的密钥目录');
    }
  });
});

describe('共享失效因素告警', () => {
  test('两个边界共享同一因素、合计验证者超上限时告警，但不阻断', () => {
    const p = withDeployment([
      dom('win-1', ['l1-1', 'primary-1'], { platform: 'windows', sharedFailureFactors: ['update-window:patch-tuesday'] }),
      dom('win-2', ['l1-2', 'primary-2'], { platform: 'windows', sharedFailureFactors: ['update-window:patch-tuesday'] }),
      dom('u-1', ['l1-3']),
      dom('u-2', ['l1-4']),
      dom('u-3', ['l1-5']),
    ]);
    assert.deepEqual(errorsOf(p), [], '共享失效因素不得阻断校验');

    const r = analyze(p, 'test');
    assert.equal(r.warnings.length, 1, '应当产生一条告警');
    assert.match(r.warnings[0], /update-window:patch-tuesday/);
    assert.match(r.warnings[0], /同时损失 2 个验证者/);
  });

  test('共享因素但合计不超上限时不告警', () => {
    const p = withDeployment([
      dom('d1', ['l1-1', 'primary-1'], { sharedFailureFactors: ['switch:sw-1'] }),
      dom('d2', ['primary-2'], { sharedFailureFactors: ['switch:sw-1'] }),   // 该边界无验证者
      dom('d3', ['l1-2']), dom('d4', ['l1-3']), dom('d5', ['l1-4']), dom('d6', ['l1-5']),
    ]);
    assert.equal(analyze(p, 'test').warnings.length, 0);
  });

  test('单边界形态不产生共享因素告警', () => {
    assert.equal(analyze(BASE, 'local').warnings.length, 0);
  });
});

// 验证器的节点清单：字段名必须两个来源统一，否则报错信息里节点名会是 undefined
describe('验证器节点清单（readInventory）', () => {
  test('每个节点都同时具备 name 与 label，且等于拓扑里的节点 id', () => {
    const inv = readInventory();
    assert.ok(inv, '拓扑存在时清单不应为 null');
    assert.equal(inv.source, 'topology');
    const ids = BASE.topology.nodes.map((n) => n.id).sort();
    assert.deepEqual(inv.nodes.map((n) => n.name).sort(), ids);
    for (const n of inv.nodes) {
      assert.equal(n.label, n.name, `${n.name} 的 label 与 name 必须一致`);
      assert.ok(n.name, '节点名不得为空 —— 报错信息要靠它指出是哪个节点');
    }
  });

  test('清单带上每个节点的地址与端口，验证器据此直连而不经代理', () => {
    for (const n of readInventory().nodes) {
      assert.ok(n.host, `${n.name} 缺少地址`);
      assert.ok(Number.isInteger(n.httpPort) && Number.isInteger(n.stakingPort), `${n.name} 端口不是整数`);
      assert.match(n.nodeId, /^NodeID-/, `${n.name} 的 NodeID 应取自生成的身份伴生文件`);
    }
  });
});

// 有效边界：共享失效因素会把声明边界合并。对外承诺必须按合并后判定 ——
// 2026-09-07 实测教训：声明的 5 个边界里有 3 个是虚拟机、宿主只有 2 台物理机，
// 而当时的模型仍然打印"可容忍 1 个边界整体失效 [OK]"。
describe('有效边界与整域失效容忍', () => {
  test('无共享因素时，有效边界数等于声明边界数', () => {
    const p = withDeployment([
      dom('d1', ['l1-1', 'primary-1']), dom('d2', ['l1-2', 'primary-2']),
      dom('d3', ['l1-3']), dom('d4', ['l1-4']), dom('d5', ['l1-5']),
    ]);
    const ft = deriveTopology(p).faultTolerance;
    assert.equal(ft.domainCount, 5);
    assert.equal(ft.effectiveDomainCount, 5);
    assert.equal(ft.tolerateWholeDomainLoss, true);
  });

  test('虚拟化宿主共享 → 5 个声明边界合并为 2 个，承诺转为 false', () => {
    const p = withDeployment([
      dom('win-1', ['l1-1'], { sharedFailureFactors: ['hypervisor:win-1'] }),
      dom('win-2', ['l1-2'], { sharedFailureFactors: ['hypervisor:win-2'] }),
      dom('u-1', ['l1-3', 'primary-1'], { sharedFailureFactors: ['hypervisor:win-1'] }),
      dom('u-2', ['l1-4', 'primary-2'], { sharedFailureFactors: ['hypervisor:win-1'] }),
      dom('u-3', ['l1-5'], { sharedFailureFactors: ['hypervisor:win-2'] }),
    ]);
    const ft = deriveTopology(p).faultTolerance;
    assert.equal(ft.domainCount, 5, '声明边界数不变');
    assert.equal(ft.declaredWithinLimit, true, '声明层面每边界仍只有 1 个验证者，T-5 不报错');
    assert.equal(ft.effectiveDomainCount, 2, '按 hypervisor 因素合并');
    assert.equal(ft.tolerateWholeDomainLoss, false, '真实宿主只有 2 台，不得给绿灯');
    const sizes = ft.effectiveDomains.map((g) => g.validators).sort();
    assert.deepEqual(sizes, [2, 3]);
  });

  test('合并具有传递性：A~B 共享 f1、B~C 共享 f2 ⇒ A/B/C 同一有效边界', () => {
    const p = withDeployment([
      dom('a', ['l1-1'], { sharedFailureFactors: ['rack:r1'] }),
      dom('b', ['l1-2'], { sharedFailureFactors: ['rack:r1', 'power:p1'] }),
      dom('c', ['l1-3'], { sharedFailureFactors: ['power:p1'] }),
      dom('d', ['l1-4', 'primary-1']), dom('e', ['l1-5', 'primary-2']),
    ]);
    const ft = deriveTopology(p).faultTolerance;
    assert.equal(ft.effectiveDomainCount, 3, 'a/b/c 合并成一个，d 与 e 各自独立');
    const merged = ft.effectiveDomains.find((g) => g.ids.length > 1);
    assert.deepEqual(merged.ids.sort(), ['a', 'b', 'c']);
    assert.equal(merged.validators, 3);
    assert.equal(ft.tolerateWholeDomainLoss, false);
  });

  test('共享因素但合并后仍不超上限 → 承诺保持 true', () => {
    const p = withDeployment([
      dom('d1', ['l1-1'], { sharedFailureFactors: ['switch:sw-1'] }),
      dom('d2', ['primary-1', 'primary-2'], { sharedFailureFactors: ['switch:sw-1'] }), // 无验证者
      dom('d3', ['l1-2']), dom('d4', ['l1-3']), dom('d5', ['l1-4']), dom('d6', ['l1-5']),
    ]);
    const ft = deriveTopology(p).faultTolerance;
    assert.equal(ft.effectiveDomainCount, 5);
    assert.equal(ft.tolerateWholeDomainLoss, true, '合并后那一组只有 1 个验证者，不超上限');
  });

  test('单边界形态不给整域承诺', () => {
    const ft = loadProtocol().topology.deployments.local
      ? deriveTopology(clone()).faultTolerance : null;
    assert.equal(ft.domainCount, 1);
    assert.equal(ft.effectiveDomainCount, 1);
    assert.equal(ft.tolerateWholeDomainLoss, false, '1 个边界谈不上"某个边界失效后继续"');
  });

  test('真实的 lan 声明当前无法容忍整域失效 —— 宿主只有 2 台物理机', () => {
    const p = loadProtocol();
    if (!p.topology.deployments.lan) return;
    const ft = deriveTopology({ ...p, topology: { ...p.topology, activeDeployment: 'lan' } }).faultTolerance;
    assert.equal(ft.tolerateWholeDomainLoss, false,
      'protocol.json 若声明了独立的 5 台物理机，此断言应当被显式更新，而不是悄悄变绿');
  });
});
