// T074：devnet-status 的分类与输出格式（功能 002 / US6、FR-032、FR-034）。
//
// 契约见 specs/002-resilient-validator-network/contracts/cli-interface.md 的
// "devnet-status 输出格式"，三条硬性要求：
//   1. catching-up 与故障必须可区分，且给出进度
//   2. unreachable（边界缺席）与节点故障必须可区分
//   3. 必须显示当前在线数与容错上限的关系
//
// 全部用纯函数 + 内存数据测，不需要活链 —— 状态机的分支太多，靠真实故障去覆盖既慢又不可靠。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classify, summarize, formatReport, parseArgs } from '../../tools/inspect/node-status.mjs';
import { ALL_STATES } from '../../tools/inspect/node-status.mjs';
import { CATEGORY_OF_RECOVERY_STATE, ALL_CATEGORIES } from '../../tools/verify/lib/categories.mjs';

const node = (id, role = 'l1-validator', domain = 'd1') => ({
  // 地址与端口刻意用虚构值：classify 不读它们，而写真实端口会让 no-hardcode 扫描无从区分
  // "夹具"与"第二处事实来源"。字段名用 address —— 与 deriveTopology 的输出一致。
  id, role, domain, address: '10.99.0.1', httpPort: 19999, nodeId: `NodeID-${id}`,
});

/** 默认上下文：本节点可达、已引导、追平、peers 充足。 */
const ctx = (over = {}) => ({
  probe: { reachable: true, nodeId: 'NodeID-l1-1', bootstrapped: true, height: 100, peers: 6, peerNodeIds: [] },
  prevHeight: 100,
  networkHeight: 100,
  seenByPeers: new Set(),
  domainAllUnreachable: false,
  container: null,
  ...over,
});

describe('RecoveryState 分类（data-model §7）', () => {
  test('已引导、追平、peers 达标 → healthy', () => {
    const r = classify(node('l1-1'), ctx());
    assert.equal(r.state, 'healthy');
  });

  test('未引导 → bootstrapping（要等，不是故障）', () => {
    const r = classify(node('l1-1'), ctx({
      probe: { reachable: true, nodeId: 'NodeID-l1-1', bootstrapped: false, height: null, peers: 2, peerNodeIds: [] },
    }));
    assert.equal(r.state, 'bootstrapping');
    assert.equal(r.countsAsOffline, false, 'bootstrapping 不计入离线');
  });

  test('落后于网络高度且在增长 → catching-up，且给出进度与预计追平时间（FR-032）', () => {
    const r = classify(node('l1-1'), ctx({
      probe: { reachable: true, nodeId: 'NodeID-l1-1', bootstrapped: true, height: 1201, peers: 6, peerNodeIds: [] },
      prevHeight: 1197, networkHeight: 1284, sampleSeconds: 3,
    }));
    assert.equal(r.state, 'catching-up');
    assert.equal(r.countsAsOffline, false, 'catching-up **不得**计入离线 —— 契约第 1 条');
    assert.ok(r.detail.includes('/min'), `进度须给出速率，实际：${r.detail}`);
    assert.match(r.detail, /~\d+/, '须给出预计追平时间');
  });

  test('落后但采样窗口内无进展 → 仍报 catching-up，并说明无进展（时间窗口归容器健康检查）', () => {
    const r = classify(node('l1-1'), ctx({
      probe: { reachable: true, nodeId: 'NodeID-l1-1', bootstrapped: true, height: 1201, peers: 6, peerNodeIds: [] },
      prevHeight: 1201, networkHeight: 1284, sampleSeconds: 3,
    }));
    assert.equal(r.state, 'catching-up');
    assert.match(r.detail, /无进展/, '须说明本次窗口内没有进展');
    assert.equal(r.countsAsOffline, false);
  });

  test('容器健康检查自报 stalled 时以它为准 —— 它才持有超时窗口', () => {
    const r = classify(node('l1-1'), ctx({
      probe: { reachable: true, nodeId: 'NodeID-l1-1', bootstrapped: true, height: null, peers: 6, peerNodeIds: [] },
      container: { status: 'running', selfState: 'stalled', detail: 'not serving L1 for 310s' },
    }));
    assert.equal(r.state, 'stalled');
    assert.equal(r.countsAsOffline, true, 'stalled 是须处置的状态，计入离线');
  });

  test('NodeID 与制品不符 → identity-mismatch（终态，须处置）', () => {
    const r = classify(node('l1-1'), ctx({
      probe: { reachable: true, nodeId: 'NodeID-someone-else', bootstrapped: true, height: 100, peers: 6, peerNodeIds: [] },
    }));
    assert.equal(r.state, 'identity-mismatch');
    assert.equal(r.countsAsOffline, true);
    assert.match(r.detail, /NodeID-someone-else/, '须指出实际观测到的 NodeID');
  });

  test('不可达，但网络中其他节点与它有连接 → unreachable，且指出是本机路径问题', () => {
    const r = classify(node('l1-1'), ctx({
      probe: { reachable: false },
      seenByPeers: new Set(['NodeID-l1-1']),
    }));
    assert.equal(r.state, 'unreachable');
    assert.match(r.detail, /本机/, '须说明是本机到它的路径问题，而不是节点故障');
    assert.equal(r.countsAsOffline, false, '网络里它还在，不该算作离线');
  });

  test('整个边界都不可达 → unreachable，指向那台机器（契约第 2 条）', () => {
    const r = classify(node('l1-2', 'l1-validator', 'ubuntu-3'), ctx({
      probe: { reachable: false },
      seenByPeers: new Set(),
      domainAllUnreachable: true,
    }));
    assert.equal(r.state, 'unreachable');
    assert.match(r.detail, /边界 ubuntu-3/, '须点名是哪个边界');
    assert.equal(r.countsAsOffline, true, '整域缺席时该验证者确实不在线');
  });

  test('同边界其他节点应答、只有它不应答 → stopped（节点故障，不是边界缺席）', () => {
    const r = classify(node('l1-1'), ctx({
      probe: { reachable: false },
      seenByPeers: new Set(),
      domainAllUnreachable: false,
    }));
    assert.equal(r.state, 'stopped', '同边界其他节点在，说明机器是好的 —— 这是节点级故障');
    assert.equal(r.countsAsOffline, true);
  });

  test('容器以退出码 12 结束 → 按错误文本区分 identity-mismatch 与 data-corrupt', () => {
    const idm = classify(node('l1-1'), ctx({
      probe: { reachable: false },
      container: { status: 'exited', exitCode: 12, lastError: 'nodeId mismatch: expected NodeID-x' },
    }));
    assert.equal(idm.state, 'identity-mismatch');

    const dc = classify(node('l1-1'), ctx({
      probe: { reachable: false },
      container: { status: 'exited', exitCode: 12, lastError: 'genesisSha256 不符' },
    }));
    assert.equal(dc.state, 'data-corrupt');
    assert.match(dc.detail, /不需全链重置|重建该节点/, '须说明只重建该节点即可（FR-006）');
  });

  test('Primary 节点可达即为在岗，且不参与容错计算（R-09）', () => {
    const r = classify(node('primary-1', 'primary'), ctx({
      probe: { reachable: true, nodeId: 'NodeID-primary-1', bootstrapped: true, height: null, peers: 6, peerNodeIds: [] },
    }));
    assert.equal(r.state, 'healthy');
    assert.equal(r.countsAsOffline, false);
    assert.equal(r.countsTowardTolerance, false, 'Primary 不计入容错计算');
  });
});

describe('在线数与容错上限的关系（契约第 3 条）', () => {
  const ft = { validatorCount: 5, maxOfflineValidators: 1 };
  const rows = (states) => states.map((state, i) => ({
    id: `l1-${i + 1}`, role: 'l1-validator', domain: `d${i + 1}`, state,
    countsAsOffline: !['healthy', 'catching-up', 'bootstrapping'].includes(state),
    countsTowardTolerance: true,
  }));

  test('全部健康 → 满余量', () => {
    const s = summarize(rows(['healthy', 'healthy', 'healthy', 'healthy', 'healthy']), ft);
    assert.equal(s.online, 5);
    assert.equal(s.offline, 0);
    assert.equal(s.withinTolerance, true);
    assert.equal(s.margin, 1, '还能再离线 1 个');
    assert.match(s.line, /5\/5/);
    assert.match(s.line, /可容忍 1 个离线/);
  });

  test('1 个离线 → 仍在上限内，但余量为 0，必须说出来', () => {
    const s = summarize(rows(['healthy', 'stopped', 'healthy', 'healthy', 'healthy']), ft);
    assert.equal(s.online, 4);
    assert.equal(s.withinTolerance, true);
    assert.equal(s.margin, 0);
    assert.match(s.line, /4\/5/);
    assert.match(s.line, /余量.*0|再有一个/, `余量为 0 必须显式提示，实际：${s.line}`);
  });

  test('catching-up 不计入离线（契约第 1 条）', () => {
    const s = summarize(rows(['healthy', 'catching-up', 'healthy', 'healthy', 'healthy']), ft);
    assert.equal(s.online, 5, 'catching-up 的节点仍算在线');
    assert.equal(s.offline, 0);
  });

  test('2 个离线 → 越过上限，须明确指出链已停止出块', () => {
    const s = summarize(rows(['healthy', 'stopped', 'unreachable', 'healthy', 'healthy']), ft);
    assert.equal(s.online, 3);
    assert.equal(s.withinTolerance, false);
    assert.match(s.line, /超出|越过|EXCEEDED/, '越限必须显式');
    assert.match(s.line, /停止出块|停摆/, '须说明后果');
  });

  test('Primary 不计入分母', () => {
    const withPrimary = [
      ...rows(['healthy', 'healthy', 'healthy', 'healthy', 'healthy']),
      { id: 'primary-1', role: 'primary', domain: 'd1', state: 'healthy', countsAsOffline: false, countsTowardTolerance: false },
    ];
    const s = summarize(withPrimary, ft);
    assert.equal(s.online, 5, '分母只算 L1 验证者');
    assert.match(s.line, /5\/5/);
  });
});

describe('输出格式', () => {
  const ft = { validatorCount: 5, maxOfflineValidators: 1 };
  const rows = [
    { id: 'l1-1', role: 'l1-validator', domain: 'win-1', state: 'healthy', height: 1284, peers: 6, detail: '', countsAsOffline: false, countsTowardTolerance: true },
    { id: 'l1-2', role: 'l1-validator', domain: 'win-2', state: 'catching-up', height: 1201, peers: 6, detail: '+83/min, ~1m', countsAsOffline: false, countsTowardTolerance: true },
    { id: 'l1-5', role: 'l1-validator', domain: 'ubuntu-3', state: 'unreachable', height: null, peers: null, detail: '边界 ubuntu-3 不可达', countsAsOffline: true, countsTowardTolerance: true },
    { id: 'primary-1', role: 'primary', domain: 'win-1', state: 'healthy', height: null, peers: 6, detail: '', countsAsOffline: false, countsTowardTolerance: false },
  ];

  test('表头与列齐全，每个节点一行，且带所属故障边界', () => {
    const out = formatReport(rows, { deployment: 'lan', height: 1284, faultTolerance: ft });
    assert.match(out, /deployment: lan/);
    assert.match(out, /height 1284/);
    for (const h of ['node', 'domain', 'role', 'state', 'height', 'peers']) {
      assert.ok(out.includes(h), `表头缺列 ${h}`);
    }
    for (const r of rows) {
      const line = out.split('\n').find((l) => l.includes(r.id));
      assert.ok(line, `缺少节点 ${r.id} 的行`);
      assert.ok(line.includes(r.domain), `${r.id} 的行须带所属边界`);
      assert.ok(line.includes(r.state), `${r.id} 的行须带状态`);
    }
  });

  test('不可用的高度与 peers 显示为占位符，而不是 null/undefined', () => {
    const out = formatReport(rows, { deployment: 'lan', height: 1284, faultTolerance: ft });
    const line = out.split('\n').find((l) => l.includes('l1-5'));
    assert.doesNotMatch(line, /null|undefined|NaN/, `不该出现 null/undefined：${line}`);
    assert.match(line, /—/, '不可用的值应显示为占位符');
  });

  test('摘要行出现在输出里', () => {
    const out = formatReport(rows, { deployment: 'lan', height: 1284, faultTolerance: ft });
    assert.match(out, /4\/5/, '摘要须给出在线数（l1-5 缺席，其余 4 个在线）');
    assert.match(out, /可容忍 1 个离线/);
  });
});

describe('命令行开关', () => {
  test('--json 与 --deployment 可解析，默认值合理', () => {
    assert.equal(parseArgs([]).asJson, false);
    assert.equal(parseArgs(['--json']).asJson, true);
    assert.equal(parseArgs(['--deployment', 'lan']).deployment, 'lan');
    assert.equal(parseArgs([]).deployment, undefined, '默认跟随 activeDeployment');
    assert.ok(parseArgs([]).sampleSeconds > 0, '须有一个采样间隔默认值（用于算追赶速率）');
  });
});

// 判定顺序：容器级事实优先于网络推断。
// 实测教训（2026-09-07）：用 devnet-stop 停掉本机全部节点后，输出是
// "边界 local 的全部节点都不应答 —— 整域缺席，去看那台机器" ——
// 而运维刚在这台机器上执行过 stop，那条建议是错的。
// 容器级事实只有本机知道，但正因如此它比"我连不上"这种推断更权威。
describe('判定优先级：容器级事实优先于网络推断', () => {
  const n = { id: 'l1-1', role: 'l1-validator', domain: 'local', nodeId: 'NodeID-l1-1' };

  test('本机主动停止（exited/0）→ stopped 且说明非故障，而不是整域缺席', () => {
    const r = classify(n, {
      probe: { reachable: false },
      seenByPeers: new Set(),
      domainAllUnreachable: true,      // 全停时这个条件必然成立
      container: { status: 'exited', exitCode: 0 },
    });
    assert.equal(r.state, 'stopped', '容器级事实已表明是主动停止');
    assert.match(r.detail, /主动停止|非故障/, `不该建议去看机器：${r.detail}`);
    assert.doesNotMatch(r.detail, /去看那台机器/);
  });

  test('拿不到容器事实（远端机器）时才退回整域缺席的推断', () => {
    const r = classify(n, {
      probe: { reachable: false },
      seenByPeers: new Set(),
      domainAllUnreachable: true,
      container: null,                 // 远端机器上的容器，本机无从得知
    });
    assert.equal(r.state, 'unreachable');
    assert.match(r.detail, /去看那台机器/);
  });

  test('被强制杀死（非零退出码）仍报 stopped 并带上退出码', () => {
    const r = classify(n, {
      probe: { reachable: false },
      seenByPeers: new Set(),
      domainAllUnreachable: false,
      container: { status: 'exited', exitCode: 137 },
    });
    assert.equal(r.state, 'stopped');
    assert.match(r.detail, /137/, '须带上退出码，便于判断是被杀还是自己退的');
  });
});

// T079 / FR-034：每个 RecoveryState 都必须能归入既有九类故障分类，或被显式标记为"非故障"。
// 这条断言把一次性的人工核对变成持续约束：新增状态若不登记，这里就会失败。
describe('故障分类覆盖（T079 / FR-034）', () => {
  test('状态机里的每个状态都在分类表中登记', () => {
    const missing = [...ALL_STATES].filter((s) => !(s in CATEGORY_OF_RECOVERY_STATE));
    assert.deepEqual(missing, [],
      `以下状态未登记分类：${missing.join(', ')} —— 见 tools/verify/lib/categories.mjs`);
  });

  test('分类表里没有已不存在的状态（防止表与状态机反向漂移）', () => {
    const stale = Object.keys(CATEGORY_OF_RECOVERY_STATE).filter((s) => !ALL_STATES.has(s));
    assert.deepEqual(stale, [], `分类表登记了状态机里不存在的状态：${stale.join(', ')}`);
  });

  test('登记的类别必须是既有九类之一；非故障状态显式记为 null', () => {
    for (const [state, cat] of Object.entries(CATEGORY_OF_RECOVERY_STATE)) {
      if (cat === null) continue;
      assert.ok(ALL_CATEGORIES.includes(cat), `${state} 的类别 ${cat} 不在既有九类中`);
    }
    // 契约要求 catching-up 不得计为故障 —— 分类上也必须是非故障
    assert.equal(CATEGORY_OF_RECOVERY_STATE['catching-up'], null);
    assert.equal(CATEGORY_OF_RECOVERY_STATE.bootstrapping, null);
  });

  test('九类未因分布式化而增加 —— 002 引入的是新处境，不是新的故障性质', () => {
    assert.equal(ALL_CATEGORIES.length, 9, `分类数应保持 9，实际 ${ALL_CATEGORIES.length}`);
  });
});
