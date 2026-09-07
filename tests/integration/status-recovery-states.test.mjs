// T073：RecoveryState 在**活链**上可达且可区分（功能 002 / US6、FR-032）。
//
// 与 tests/unit/status-format.test.mjs 的分工：单元测试用内存数据覆盖状态机的**全部分支**
// （分支太多，靠真实故障逐一制造既慢又不可靠）；本文件只验证那些**只有真实运行才能证明**的事 ——
// 观测管道真的通、真实故障真的被归入正确的类别。
//
// ## 两组前置条件不同，因此分成两个套件
//
// 观测需要**直连每个节点的 HTTP 端口**；故障注入需要**docker 可用**。
// 单机形态下这两者互斥：节点在容器网段（172.28.0.x），宿主到不了；
// 而容器里有端点却没有 docker 客户端。于是：
//
//   | 套件 | 需要 | 单机形态怎么跑 | 跨机形态 |
//   |---|---|---|---|
//   | 观测 | 节点端点 | 容器内（见下） | 宿主直接跑 |
//   | 故障注入 | 端点 + docker | 跳过（分支由单元测试覆盖） | 宿主直接跑 |
//
// 单机形态下跑观测套件：
//   docker run --rm --network karmachain -v "$PWD:/workspace" \
//     karmachain/verify:local node --test tests/integration/status-recovery-states.test.mjs
//
// 跨机形态下节点地址是各机器的局域网 IP，宿主同时具备两者，两个套件都会真跑。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { loadProtocol, deriveTopology } from '../../tools/protocol/load.mjs';
import { collect, summarize } from '../../tools/inspect/node-status.mjs';

const p = loadProtocol();
const d = deriveTopology(p);
const validatorIds = d.topologyNodes.filter((n) => n.role === 'l1-validator').map((n) => n.id);
// 挑最后一个验证者当靶子：它不承载 Primary，杀掉它的影响面最小
const VICTIM = validatorIds[validatorIds.length - 1];

const docker = (...args) => {
  try {
    execFileSync('docker', args, { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch { return false; }
};

const status = (sampleSeconds = 1) => collect({ asJson: true, deployment: undefined, sampleSeconds });

// --- 前置条件探测 ---
const first = await status(1);
const endpointsReachable = first.nodes.some((n) => n.height != null || n.peers != null);
const dockerAvailable = docker('version', '--format', '{{.Server.Version}}');

const SKIP_OBSERVE = endpointsReachable ? undefined : [
  '本进程到不了任何节点端点。单机形态下节点在容器网段，须在容器内跑：',
  '    docker run --rm --network karmachain -v "$PWD:/workspace" \\',
  '      karmachain/verify:local node --test tests/integration/status-recovery-states.test.mjs',
].join('\n');

const SKIP_INJECT = SKIP_OBSERVE ?? (dockerAvailable ? undefined
  : 'docker 不可用（在容器内运行）。故障分类的全部分支由 tests/unit/status-format.test.mjs 覆盖；'
    + '本套件只在宿主同时具备 docker 与节点端点时才有意义 —— 即跨机形态。');

describe('US6 观测管道（T073）', { skip: SKIP_OBSERVE }, () => {
  test('每个声明的节点都有一行，且带所属故障边界', async () => {
    const s = await status();
    assert.equal(s.nodes.length, p.topology.nodes.length);
    const declared = new Set(d.failureDomains.map((x) => x.id));
    for (const n of s.nodes) assert.ok(declared.has(n.domain), `${n.id} 的边界 ${n.domain} 不在声明中`);
  });

  test('验证者报出高度与 peers，Primary 在岗但不计入容错', async () => {
    const s = await status();
    for (const n of s.nodes.filter((x) => x.role === 'l1-validator')) {
      assert.equal(n.state, 'healthy', `${n.id} 应为 healthy，实际 ${n.state}（${n.detail}）`);
      assert.ok(Number.isFinite(n.height), `${n.id} 应报出高度`);
      assert.ok(Number.isFinite(n.peers) && n.peers > 0, `${n.id} 应报出 peers`);
      assert.equal(n.countsAsOffline, false);
      assert.equal(n.countsTowardTolerance, true);
    }
    for (const n of s.nodes.filter((x) => x.role === 'primary')) {
      assert.equal(n.state, 'healthy', `${n.id} 应在岗`);
      assert.equal(n.countsTowardTolerance, false, 'Primary 不计入容错计算（R-09）');
    }
  });

  test('网络高度取各节点高度的最大值', async () => {
    const s = await status();
    assert.equal(s.height, Math.max(...s.nodes.map((n) => n.height ?? -1)));
  });

  test('摘要的算式与拓扑声明一致，不写死数字', async () => {
    const s = await status();
    const again = summarize(s.nodes, d.faultTolerance);
    assert.deepEqual(
      { online: again.online, offline: again.offline, margin: again.margin },
      { online: s.summary.online, offline: s.summary.offline, margin: s.summary.margin },
    );
    assert.equal(s.faultTolerance.validatorCount, p.validators.count);
    assert.equal(s.faultTolerance.maxOfflineValidators, Math.floor(p.validators.count / 4));
    assert.equal(s.summary.offline, 0, '本用例假定全网健康');
    assert.equal(s.summary.margin, d.faultTolerance.maxOfflineValidators);
    assert.match(s.summary.line, /余量/);
  });

  test('识别出的每个状态都在 data-model §7 的状态机内', async () => {
    const KNOWN = new Set(['stopped', 'starting', 'bootstrapping', 'catching-up',
      'healthy', 'unreachable', 'identity-mismatch', 'data-corrupt', 'stalled']);
    for (const n of (await status()).nodes) {
      assert.ok(KNOWN.has(n.state), `${n.id} 的状态 ${n.state} 不在状态机内`);
    }
  });
});

describe('US6 真实故障的归类（T073）', { skip: SKIP_INJECT }, () => {
  before(() => { assert.ok(docker('inspect', `karmachain-${VICTIM}`), `容器 karmachain-${VICTIM} 应存在`); });
  // 无论断言成败都把节点放回去：测试不该留下一个缺席的验证者
  after(() => { docker('start', `karmachain-${VICTIM}`); });

  test('强制杀死一个验证者 → 节点级故障（不是边界缺席），余量归零', async () => {
    assert.ok(docker('kill', `karmachain-${VICTIM}`), '应能杀掉目标容器');
    const s = await status();
    const v = s.nodes.find((n) => n.id === VICTIM);

    assert.equal(v.countsAsOffline, true);
    assert.notEqual(v.state, 'unreachable',
      `同边界其他节点仍在应答，不该报为边界缺席：${v.detail}`);
    assert.doesNotMatch(v.detail, /去看那台机器/, '节点级故障不该把运维引向整台机器');

    for (const n of s.nodes.filter((x) => x.role === 'l1-validator' && x.id !== VICTIM)) {
      assert.equal(n.state, 'healthy', `${n.id} 不该被牵连，实际 ${n.state}`);
    }

    assert.equal(s.summary.offline, 1);
    assert.equal(s.summary.withinTolerance, true, '1 个离线仍在上限内');
    assert.equal(s.summary.margin, 0);
    assert.match(s.summary.line, /余量为 0|再有一个/, `余量归零必须显式：${s.summary.line}`);
  });

  test('恢复后回到 healthy，余量恢复', async () => {
    assert.ok(docker('start', `karmachain-${VICTIM}`));
    // 实测崩溃恢复约 6–17 秒；给到 90 秒仍失败才是真的有问题
    const deadline = Date.now() + 90_000;
    let s;
    for (;;) {
      s = await status(1);
      const v = s.nodes.find((n) => n.id === VICTIM);
      if (v.state === 'healthy') break;
      assert.ok(['starting', 'bootstrapping', 'catching-up', 'stopped', 'unreachable'].includes(v.state),
        `恢复期出现了意外状态 ${v.state}（${v.detail}）`);
      assert.ok(Date.now() < deadline, `90 秒内未恢复，停在 ${v.state}（${v.detail}）`);
    }
    assert.equal(s.summary.offline, 0);
    assert.equal(s.summary.margin, d.faultTolerance.maxOfflineValidators);
  });
});
