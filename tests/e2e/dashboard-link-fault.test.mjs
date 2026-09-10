// T045 —— 单链路故障不得误报成节点下线（功能 003 / SC-005）。
//
// **这是报警可信度的核心场景。**
//
// 002 的 ubuntu-1 线缆丢包（21–27%）就属这一类：朴素面板会误报"节点下线"并触发
// "链已停止"的假报警，而链完全正常。当时我还先给出了一个错误解释（"探测抖动"），
// 直到运维查网卡计数器全零、换掉网线后丢包归零，才确认是物理链路。
// 一个会假报警的面板，用两天就没人看了。
//
// ## 制造方法：地址覆盖，不用防火墙
//
// 用既有的 `KARMACHAIN_ADDRESS_OVERRIDE`（002 T060 引入）把某个边界的地址指向
// TEST-NET-1（192.0.2.0/24，RFC 5737 保留给文档用途，保证不可路由）。于是：
//
//   - **观察者**按那个地址探不到该节点 → unreachable
//   - **节点本身分毫未动**，仍在正常出块，仍出现在其余节点的对等列表里
//   - → `seenByPeers` 里有它的 NodeID → classify 判「本机视角不可达」，不计入离线
//
// 这正是链路故障的语义，而且比防火墙规则更好：不需要管理员权限、跨平台一致、
// 不会因为忘了撤销规则而留下后患。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { devnetAvailable } from './lib/devnet.mjs';
import { startDashboard, waitForSnapshot, waitFirstPoll } from './lib/dashboard.mjs';
import { loadContext } from '../../tools/dashboard/poll.mjs';
import { tierCopy } from '../../tools/dashboard/public/copy.mjs';

/** RFC 5737 TEST-NET-1 —— 保证不可路由，且不会误伤任何真实主机。 */
const BLACKHOLE = '192.0.2.1';

const SKIP = !(await devnetAvailable()) ? '开发网未运行 —— 先 scripts/devnet-start' : undefined;

describe('面板 —— 单链路故障不得误报成节点下线', { skip: SKIP, concurrency: 1 }, () => {
  let dash;
  let victim;
  let victimDomain;
  const savedOverride = process.env.KARMACHAIN_ADDRESS_OVERRIDE;

  before(async () => {
    // 挑一个**不是本机**的验证者当靶子：本机那个的容器事实会让 classify 走
    // "容器不在运行"分支，测不到网络推断这条路。
    const plain = loadContext();
    const localDomain = process.env.KARMACHAIN_DOMAIN || plain.domains[0].id;
    const target = plain.nodes.find((n) => n.role === 'l1-validator' && n.domain !== localDomain);
    victim = target?.id;
    victimDomain = target?.domain;
    if (!victim) return;

    process.env.KARMACHAIN_ADDRESS_OVERRIDE = `${victimDomain}=${BLACKHOLE}`;
    dash = await startDashboard();
    await waitFirstPoll(dash);
  });

  after(async () => {
    await dash?.stop();
    if (savedOverride === undefined) delete process.env.KARMACHAIN_ADDRESS_OVERRIDE;
    else process.env.KARMACHAIN_ADDRESS_OVERRIDE = savedOverride;
  });

  test('前置：找到一个非本机的验证者当靶子', () => {
    assert.ok(victim, '拓扑里应当有非本机的验证者 —— 否则本用例在单机形态下不成立');
  });

  test('该节点标为「本机视角不可达」，健康度保持 100%，全程不报警（SC-005）', async (t) => {
    const { snapshot: s } = await waitForSnapshot(
      dash,
      (x) => x.nodes.find((n) => n.id === victim)?.reachable === false,
      { timeoutMs: 60_000, label: `${victim} 变为不可达` },
    );

    const row = s.nodes.find((n) => n.id === victim);
    t.diagnostic(`${victim}（${victimDomain}）→ 地址 ${row.address}，状态 ${row.state}，detail：${row.detail}`);

    assert.equal(row.state, 'unreachable');
    assert.equal(row.countsAsOffline, false,
      '其余节点仍看得见它 —— 断的是本机到它的路径，不得计入离线（FR-012 / FR-004a）');
    assert.equal(row.participatesInConsensus, true,
      '它在链里好着，必须仍算参与共识');
    assert.equal(row.incidentClass, 'observation',
      '异常分类必须指向"修本机网络"，而不是"去那台机器"');

    // **这三条是本用例的意义所在**
    assert.equal(s.healthPercent, 100, '健康度不得因本机的链路问题而下降');
    assert.equal(s.tier, 'normal');
    assert.equal(s.validatorMargin, 1, '余量不得被虚报为 0 —— 那会让人以为链快停了');

    assert.equal(s.incidents.filter((i) => i.class === 'consensus-margin').length, 0,
      '不得产生共识余量告警');
    const obsIncidents = s.incidents.filter((i) => i.class === 'observation');
    assert.equal(obsIncidents.length, 1, '应当恰好有一条观测故障');
    assert.match(obsIncidents[0].action, /本机|别去动/,
      '处置方向必须指向本机 —— 002 的教训是报警指错方向会让人去重启一台好机器');
  });

  test('detail 里说清了"其他节点与它有连接"，而不是笼统的"连不上"', async () => {
    const s = await dash.snapshot();
    const row = s.nodes.find((n) => n.id === victim);
    assert.match(row.detail, /其他节点|网络中|路径/,
      '既有 classify 的这句话是运维判断方向的依据，必须原样呈现');
  });

  test('档位文案全程不出现"链已停止"', async () => {
    const s = await dash.snapshot();
    const copy = tierCopy(s);
    assert.doesNotMatch(`${copy.label}${copy.body}${copy.action}`, /链已停止|停止出块/);
  });

  test('撤销覆盖后该节点恢复可达 —— 证明节点本身分毫未动', async (t) => {
    await dash.stop();
    delete process.env.KARMACHAIN_ADDRESS_OVERRIDE;
    dash = await startDashboard();
    await waitFirstPoll(dash);

    const { snapshot: s } = await waitForSnapshot(
      dash,
      (x) => x.nodes.find((n) => n.id === victim)?.reachable === true,
      { timeoutMs: 60_000, label: `${victim} 恢复可达` },
    );
    const row = s.nodes.find((n) => n.id === victim);
    t.diagnostic(`${victim} 恢复：地址 ${row.address}，状态 ${row.state}，高度 ${row.height}`);
    assert.equal(row.state, 'healthy', '节点从未被动过 —— 它一直在正常出块');
    assert.equal(s.healthPercent, 100);
  });
});
