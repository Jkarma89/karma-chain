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

// ── 以下三组是 2026-09-15 那次**自相矛盾的报告**逼出来的（功能 005 / T073）──────
//
// 当时同一次 devnet-verify 里：
//   fault-tolerance   4/6 … EXCEEDED: l1-2, l1-6 offline, chain has stopped producing blocks
//   block-production  977 -> 978 -> 979 (on-demand)          ← 三行之后
//
// 两处毛病各自独立：
//   ① n 按**声明的 6** 算，而 l1-6 还没注册完 —— 链上成员是 5 个，掉 1 个仍在容错内
//   ② "链已停止出块"是**推断**，却写成了观测。而 summarize 手上就有观测
//      （两次采样之间高度涨没涨），只是没用。
//
// 一条自相矛盾的报告比没有报告更坏：它训练人忽略这个工具。
describe('容错基准：链上注册数，且要说清用的是哪个', () => {
  const rows = (states) => states.map((state, i) => ({
    id: `l1-${i + 1}`, role: 'l1-validator', domain: `d${i + 1}`, state,
    countsAsOffline: !['healthy', 'catching-up', 'bootstrapping'].includes(state),
    countsTowardTolerance: true,
  }));

  test('声明 6 / 链上 5 / 在线 4 → **在容错内**（就是那个假警报的现场）', () => {
    // 收敛已由 scopeToChainMembers 做过：l1-6 不在 rows 里（不计入容错），
    // faultTolerance 带着链上的 5 与声明的 6。
    const ft = { validatorCount: 5, maxOfflineValidators: 1, declaredValidatorCount: 6 };
    const s = summarize(rows(['healthy', 'stopped', 'healthy', 'healthy', 'healthy']), ft,
      { blocksAdvanced: false });
    assert.equal(s.withinTolerance, true,
      '按链上 5 个算，掉 1 个仍在 ⌊5/4⌋=1 之内 —— 报成越限就是 V-31 那个假警报');
    // 只禁"已经停了"这类既成事实的说法。"再有一个离线即停摆"是条件式前瞻，
    // 是余量为 0 时该说的话 —— 把它一起禁掉会逼实现删掉一条有用的提示。
    assert.doesNotMatch(s.line, /已停止出块|已停摆|超出上限/,
      `在容错内却报成了停摆/越限：${s.line}`);
    assert.match(s.line, /链继续出块/, '在容错内应当明说链继续出块');
  });

  test('声明数与 P 链数不同时，必须说出用的是哪个', () => {
    const ft = { validatorCount: 5, maxOfflineValidators: 1, declaredValidatorCount: 6 };
    const s = summarize(rows(['healthy', 'healthy', 'healthy', 'healthy', 'healthy']), ft, {});
    assert.match(s.line, /P 链上带权重的 5 个/,
      `没说基准是 P 链成员数 —— "6 台机器却按 5 算"看着像少算了一个：${s.line}`);
    assert.match(s.line, /声明 6 个/, '没给出声明数，读的人无从核对差额');
  });

  // ⌊n/4⌋ 整条推导建立在**等权**上（research R-05 / V-22 实测各 100）。
  // 权重不等时上面那个"可容忍 N 个离线"是按不成立的前提算的 —— 必须当场说破。
  test('**权重不等时说明上限不可信**', () => {
    const ft = {
      validatorCount: 5, maxOfflineValidators: 1, declaredValidatorCount: 5, equalWeights: false,
    };
    const s = summarize(rows(['healthy', 'healthy', 'healthy', 'healthy', 'healthy']), ft, {});
    assert.match(s.line, /上限不可信/,
      '权重不等却照常给出"可容忍 1 个离线" —— 那个数是按一条不成立的前提算的，'
      + `而读的人无从知道：${s.line}`);
    assert.match(s.line, /等权为前提/, '没说清为什么不可信');
  });

  test('等权时不加这句噪声', () => {
    const ft = {
      validatorCount: 5, maxOfflineValidators: 1, declaredValidatorCount: 5, equalWeights: true,
    };
    const s = summarize(rows(['healthy', 'healthy', 'healthy', 'healthy', 'healthy']), ft, {});
    assert.doesNotMatch(s.line, /上限不可信/, '恒定出现的警告等于没有警告');
  });

  test('没有权重信息时**不妄断**（undefined ≠ 不等权）', () => {
    const ft = { validatorCount: 5, maxOfflineValidators: 1, declaredValidatorCount: 5 };
    const s = summarize(rows(['healthy', 'healthy', 'healthy', 'healthy', 'healthy']), ft, {});
    assert.doesNotMatch(s.line, /上限不可信/,
      '这一侧没提供权重信息就报"不可信"—— 那是把"不知道"说成了"知道它不等权"');
  });

  test('声明数与链上数相同时不加这句噪声', () => {
    const ft = { validatorCount: 5, maxOfflineValidators: 1, declaredValidatorCount: 5 };
    const s = summarize(rows(['healthy', 'healthy', 'healthy', 'healthy', 'healthy']), ft, {});
    assert.doesNotMatch(s.line, /声明 5 个/,
      '两个数相同时还提差额 —— 恒定出现的提示等于没有提示');
  });

  test('没有 declaredValidatorCount（未收敛）时不编造差额', () => {
    const s = summarize(rows(['healthy', 'healthy', 'healthy', 'healthy', 'healthy']),
      { validatorCount: 5, maxOfflineValidators: 1 }, {});
    assert.doesNotMatch(s.line, /声明/, `凭空说出了声明数：${s.line}`);
  });
});

describe('越限时不断言没测过的事', () => {
  const ft = { validatorCount: 5, maxOfflineValidators: 1 };
  const rows = (states) => states.map((state, i) => ({
    id: `l1-${i + 1}`, role: 'l1-validator', domain: `d${i + 1}`, state,
    countsAsOffline: !['healthy', 'catching-up', 'bootstrapping'].includes(state),
    countsTowardTolerance: true,
  }));
  const exceeded = () => rows(['healthy', 'stopped', 'unreachable', 'healthy', 'healthy']);

  test('**越限但高度在涨 → 报矛盾，不报停摆**', () => {
    const s = summarize(exceeded(), ft, { blocksAdvanced: true });
    assert.equal(s.withinTolerance, false, '算出来确实越限');
    assert.equal(s.contradiction, true, '矛盾必须以字段形式暴露给调用方，而不是只藏在文案里');
    assert.match(s.line, /判据与观测矛盾/, `没报出矛盾：${s.line}`);
    assert.doesNotMatch(s.line, /已停止出块/,
      '高度还在涨，却说"已停止出块" —— 这正是那份自相矛盾的报告。'
      + `实际：${s.line}`);
    assert.match(s.line, /要查的是判据/,
      '没有把人指向真正要查的东西（成员集合算错？离线谓词判错？）');
  });

  test('越限且未观测到出块 → 说明是**推断**，并说清为什么不是证据', () => {
    const s = summarize(exceeded(), ft, { blocksAdvanced: false });
    assert.equal(s.contradiction, false);
    assert.match(s.line, /推断/, `把推断写成了观测：${s.line}`);
    assert.match(s.line, /按需出块/,
      '没说明"高度不涨"在本网不构成停摆的证据 —— 少了这句，'
      + '读的人会把"没涨"当成"停了"');
  });

  test('blocksAdvanced 未提供时按"没观测到"处理，不当成在出块', () => {
    const s = summarize(exceeded(), ft, {});
    assert.equal(s.contradiction, false, '没有观测就不该宣称矛盾');
    assert.match(s.line, /超出上限/);
  });

  test('第三个参数整个省略也要能工作（既有调用方没有传它）', () => {
    const s = summarize(exceeded(), ft);
    assert.equal(s.withinTolerance, false);
    assert.equal(s.contradiction, false);
  });

  test('在容错内时，blocksAdvanced 不影响结论', () => {
    const ok = rows(['healthy', 'stopped', 'healthy', 'healthy', 'healthy']);
    for (const blocksAdvanced of [true, false, null]) {
      const s = summarize(ok, ft, { blocksAdvanced });
      assert.equal(s.withinTolerance, true);
      assert.equal(s.contradiction, false,
        `blocksAdvanced=${blocksAdvanced} 时在容错内却报了矛盾`);
    }
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
