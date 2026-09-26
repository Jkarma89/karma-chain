// T021：节点标志生成器的输出必须与实测基准逐项对照。
//
// 基准 tests/fixtures/002/measured-node-flags.json 是 Avalanche CLI 实际传给 avalanchego 的参数。
// 本组测试的核心不是"生成了什么"，而是**与基准的每一处差异都必须有登记在案的理由**。
// 未登记的差异一律失败 —— 否则脱离 CLI 的过程会悄悄改变节点行为。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadProtocol, deriveTopology, readJson, REPO_ROOT } from '../../tools/protocol/load.mjs';
import { renderNodeFlags, CONTAINER } from '../../tools/protocol/render-node-flags.mjs';

const P = loadProtocol();
const D = deriveTopology(P);
const FLAGS = renderNodeFlags(P);
const BASELINE = readJson(resolve(REPO_ROOT, 'tests/fixtures/002/measured-node-flags.json'));
const IDENTITY = readJson(resolve(REPO_ROOT, 'blockchain/chain-identity/karmachain.identity.json'));

// 基准取自某一个 L1 验证者。configVersion 1.4.0 起节点端口整体迁移到两万段，
// 已无法再按端口配对，改取第一个验证者 —— 端口差异本身已登记在 CHANGED 里。
const BASELINE_NODE_ID = D.topologyNodes.find((n) => n.role === 'l1-validator').id;
const anyValidator = FLAGS[BASELINE_NODE_ID];
const anyPrimary = FLAGS['primary-1'];

/** 相对基准「刻意不再声明」的标志及理由。 */
const DROPPED = {
  'api-admin-enabled': '管理 API 是 CLI 自身编排所需；002 的运行时不调用它',
  'health-check-frequency': '沿用 avalanchego 默认；健康判定改由容器健康检查负责（contracts/node-runtime.md）',
  'network-max-reconnect-delay': 'CLI 为加速本地演示所调；不改变正确性，沿用默认更接近生产行为',
  'network-peer-list-pull-gossip-frequency': '同上',
  'staking-host': '沿用默认（全接口）；001 需要它是因为 CLI 把节点钉在 127.0.0.1（研究 R-07）',
};

/** 相对基准「新增」的标志及理由。 */
const ADDED = {
  'staking-tls-cert-file': '身份显式化：CLI 用 staking-tls-cert-file-content 内联注入，脱离 CLI 后必须指向文件（研究 R-03）',
  'staking-tls-key-file': '同上',
  'staking-signer-key-file': '同上',
  'genesis-file': 'CLI 用 genesis-file-content 内联注入 Primary Network 创世；改为文件形式（研究 R-04）',
  'chain-aliases-file': '把隐式的链名自动别名固化为版本控制下的配置（研究 R-05）',
  'http-allowed-hosts': '默认只放行 localhost，是 001 记录的 403 invalid host specified 的来源；显式声明使放宽范围可审计（研究 R-07）',
  'db-type': '显式声明默认值 leveldb —— 崩溃一致性依赖它的预写日志（研究 R-06）',
  // CLI 用 chain-config-content 内联注入，且只设了 log-level / eth-apis，没碰持久化。
  // 002 必须在这里关掉修剪：默认 commit-interval=4096 会让强制终止回滚到上一个提交点
  // （实测：高度 2 的链被 docker kill 后，5 个验证者全部报 0）。
  'chain-config-dir': '关闭 subnet-evm 的修剪 —— 默认配置下强制终止会丢块，US1 因此不成立（见 render-chain-config.mjs）',
};

/** 相对基准「取值改变」的标志及理由。 */
const CHANGED = {
  'http-host': 'socat 代理退役，节点直接对外监听（研究 R-07）',
  'data-dir': '容器内固定路径，映射到该节点独占的命名卷',
  'plugin-dir': '容器内固定路径（镜像层）',
  // 001 的 7 个节点是同一个容器里的进程，共享 localhost，所以基准里全是 127.0.0.1。
  // 002 一容器一节点后，每个容器的 127.0.0.1 是它自己 —— 沿用基准值会让节点连向自身。
  'public-ip': '单机形态下每个节点是独立容器，必须用各自的容器 IP；001 的 7 进程共享 localhost 才能用 127.0.0.1',
  'bootstrap-ips': '同上 —— 引导目标改为 Primary 节点的容器 IP',
  // 跨机 P2P 要求 staking 端口发布到宿主，而 avalanchego 通告的就是 public-ip:staking-port
  // （通告端口必须等于宿主发布端口）。实测 Windows 的 Hyper-V 从动态端口范围里切走了
  // 9617-9716，覆盖全部原端口，因此在 Windows 故障边界上无法使用。
  'http-port': '节点端口整体迁移（configVersion 1.4.0）—— 原先那一段落在 Windows 的 Hyper-V 保留区间内，无法发布到宿主',
  'staking-port': '同上',
};

describe('与实测基准的差异必须全部有据', () => {
  test('L1 验证者：没有任何未登记的差异', () => {
    const base = BASELINE.l1Validator;
    const mine = anyValidator;

    const dropped = Object.keys(base).filter((k) => !(k in mine));
    const added = Object.keys(mine).filter((k) => !(k in base));
    const changed = Object.keys(base).filter((k) => k in mine && base[k] !== mine[k]);

    assert.deepEqual(dropped.filter((k) => !(k in DROPPED)), [], '有未登记理由的「删除」标志');
    assert.deepEqual(added.filter((k) => !(k in ADDED)), [], '有未登记理由的「新增」标志');
    assert.deepEqual(changed.filter((k) => !(k in CHANGED)), [], '有未登记理由的「改值」标志');
  });

  test('登记表里不得有已经不适用的条目（防止理由表本身腐化）', () => {
    const base = BASELINE.l1Validator;
    for (const k of Object.keys(DROPPED)) assert.ok(k in base && !(k in anyValidator), `${k} 已不再是「删除」项`);
    for (const k of Object.keys(ADDED)) assert.ok(k in anyValidator && !(k in base), `${k} 已不再是「新增」项`);
    for (const k of Object.keys(CHANGED)) assert.ok(base[k] !== anyValidator[k], `${k} 已不再是「改值」项`);
  });
});

describe('与基准一致的关键行为', () => {
  test('引导目标的 NodeID 与基准逐字符相同（地址与端口已变，身份不变）', () => {
    // 身份是唯一必须与基准一致的部分：地址因容器化而变（R-07），端口因 Windows
    // 保留区间而迁移（configVersion 1.4.0），但引导的是哪两个节点不能变。
    assert.equal(anyValidator['bootstrap-ids'], BASELINE.l1Validator['bootstrap-ids']);
    // 端口改为与拓扑自洽：引导目标必须正好是 Primary 节点的 staking 端口
    const primaries = D.topologyNodes.filter((n) => n.role === 'primary');
    assert.deepEqual(
      anyValidator['bootstrap-ips'].split(',').map((x) => x.split(':')[1]),
      primaries.map((n) => String(n.stakingPort)),
    );
  });

  test('网络标识、子网、共识相关标志与基准相同', () => {
    for (const k of ['network-id', 'track-subnets', 'partial-sync-primary-network', 'sybil-protection-enabled', 'network-allow-private-ips']) {
      assert.equal(anyValidator[k], BASELINE.l1Validator[k], `${k} 不应偏离基准`);
    }
  });

  // 索引开关必须与播种进卷的数据库当初的设置一致，否则 Primary 启动即 FATAL
  // （"index to become incomplete"）。实测教训：默认值不等于安全值。
  test('索引开关与基准逐项相同 —— 它决定了能否读取播种来的数据库', () => {
    assert.equal(anyValidator['index-enabled'], BASELINE.l1Validator['index-enabled']);
    assert.equal(anyValidator['index-allow-incomplete'], BASELINE.l1Validator['index-allow-incomplete']);
    assert.equal(anyPrimary['index-enabled'], BASELINE.primary['index-enabled'],
      'Primary 节点的索引必须与建链时一致');
  });
});

describe('角色差异', () => {
  test('只有 L1 验证者跟踪子网并加载插件', () => {
    // 2026-09-26：`partial-sync-primary-network` 从这张"按角色"的清单里**挪了出去**。
    // 它原本与其余四个同类 —— "是不是 L1 验证者"一个条件就决定它。
    // F-7 落地后不再是：兼任 Primary 网络验证者的 L1 节点**必须不带**它
    //（avalanchego 对那个组合是启动即致命）。
    //
    // **这不是放宽**：那四个键的判据一字未动，而 partial-sync 换成了一条更准的，
    // 见下一条与 tests/unit/primary-dual-role-flags.test.mjs。
    // 把它留在这张清单里只有两种结局：要么这条恒红，要么有人把它删掉 ——
    // 而删掉就等于那个键从此无人看管。
    for (const n of D.topologyNodes) {
      const f = FLAGS[n.id];
      const isV = n.role === 'l1-validator';
      for (const k of ['track-subnets', 'sybil-protection-enabled', 'plugin-dir', 'chain-aliases-file']) {
        assert.equal(k in f, isV, `${n.id}（${n.role}）${isV ? '应当' : '不应'}有 ${k}`);
      }
    }
  });

  test('partial-sync 按"是否兼任 Primary 验证者"决定，Primary 节点一律没有', () => {
    const listed = new Set(P.primaryNetwork.alsoValidatedBy ?? []);
    for (const n of D.topologyNodes) {
      const has = 'partial-sync-primary-network' in FLAGS[n.id];
      const want = n.role === 'l1-validator' && !listed.has(n.id);
      assert.equal(has, want,
        `${n.id}（${n.role}${listed.has(n.id) ? '，兼任 Primary 验证者' : ''}）`
        + `${want ? '应当' : '不应'}有 partial-sync-primary-network`);
    }
  });

  test('全部节点都有三件身份材料与创世文件', () => {
    for (const n of D.topologyNodes) {
      const f = FLAGS[n.id];
      assert.equal(f['staking-tls-cert-file'], `${CONTAINER.keys}/staker.crt`);
      assert.equal(f['staking-tls-key-file'], `${CONTAINER.keys}/staker.key`);
      assert.equal(f['staking-signer-key-file'], `${CONTAINER.keys}/signer.key`);
      assert.equal(f['genesis-file'], `${CONTAINER.config}/primary-network.genesis.json`);
    }
  });

  test('Primary 节点互为引导：第一个是种子，其余引导自它', () => {
    assert.equal(anyPrimary['bootstrap-ids'], '', 'primary-1 应当是种子节点');
    assert.equal(anyPrimary['bootstrap-ips'], '');
    const p2 = FLAGS['primary-2'];
    assert.ok(p2['bootstrap-ids'].length > 0, 'primary-2 应当引导自 primary-1');
    const p1 = D.topologyNodes.find((n) => n.id === 'primary-1');
    assert.equal(p2['bootstrap-ips'], `${p1.address}:${p1.stakingPort}`,
      '引导地址必须是 primary-1 的节点地址，不是边界地址 —— 单机形态下二者不同');
  });

  test('subnetId 取自建链制品', () => {
    assert.equal(anyValidator['track-subnets'], IDENTITY.subnetId);
  });
});

describe('端点与监听', () => {
  test('全部节点对外监听，不再依赖 socat 代理', () => {
    for (const n of D.topologyNodes) assert.equal(FLAGS[n.id]['http-host'], '0.0.0.0');
  });

  test('http-allowed-hosts 必须是数组 —— 逗号拼接的字符串会被当成单个主机名', () => {
    // 实测：写成 "a,b,c" 时 avalanchego 解析出 ["a,b,c"]，清单形同虚设，
    // 于是 Host: localhost 被拒（IP 字面量本就无条件放行，所以当时没立刻暴露）。
    for (const n of D.topologyNodes) {
      assert.ok(Array.isArray(FLAGS[n.id]['http-allowed-hosts']), `${n.id} 的 http-allowed-hosts 不是数组`);
    }
  });

  // 原断言（002 / T053）要求清单**包含**每个故障边界地址。**功能 005 把它反了过来。**
  //
  // 理由不是"放宽要求"，而是那些条目**从来没有产生过约束**：
  // avalanchego 对 IP 字面量的 Host 头无条件放行 —— 这在 001 的 acceptance.md 第 76 行
  // 就记着（「默认只放行 localhost 与 IP 字面量」），2026-09-14 又在活节点上复核：
  // 未列出的 192.168.x / 10.x / 公网 IP 全部 200，未列出的域名 403。
  //
  // 留着它们的代价是实打实的：清单随机器列表变，于是**加一台机器会改到
  // 每一个既有节点的 flags.json**，逼得五台机器全部重建 —— 而那正是 005 要消灭的东西。
  //
  // 覆盖面没有缩小，只是换了承接者：
  //   - 「跨机 RPC 仍然可达」→ tests/integration/host-header-policy.test.mjs（对活节点）
  //   - 「加机器时既有节点零改动」→ tests/unit/add-machine-noop.test.mjs
  test('http-allowed-hosts 含全部已发布主机、不含通配符，且**不含机器地址**', () => {
    const allowed = anyValidator['http-allowed-hosts'];
    for (const h of P.endpoints.publishedHosts) assert.ok(allowed.includes(h), `应放行已发布主机 ${h}`);
    assert.ok(!allowed.includes('*'), '不得使用通配符 —— 放宽范围必须是可审计的具体清单');
    for (const d of D.failureDomains) {
      assert.ok(!allowed.includes(d.address),
        `清单里出现了故障边界地址 ${d.address}。\n`
        + '  它不产生任何约束（IP 字面量无条件放行），却让清单随机器列表变 ——\n'
        + '  加一台机器就要重建全网容器。');
    }
    assert.ok(allowed.includes('localhost'),
      'localhost 必须在清单里 —— 它是**名字**，而名字不在清单里就是 403。\n'
      + '  RPC 代理把 Host 头统一改写为它，去掉会让对外入口整条断掉。');
  });

  test('端口与 public-ip 全部解析自拓扑，无写死', () => {
    for (const n of D.topologyNodes) {
      assert.equal(FLAGS[n.id]['http-port'], String(n.httpPort));
      assert.equal(FLAGS[n.id]['staking-port'], String(n.stakingPort));
      assert.equal(FLAGS[n.id]['public-ip'], n.address);
    }
  });

  test('节点数量与拓扑声明一致', () => {
    assert.equal(Object.keys(FLAGS).length, D.topologyNodes.length);
  });
});

// T059 / T061：跨机形态的寻址（研究 R-08）。
// 用内存中的 lan 拓扑验证代码路径，不依赖真实机器 —— 真实 IP 是安装特有数据，
// 不该成为单元测试的前提（Phase 6 的实机验证另有 tests/e2e/domain-failure）。
describe('跨机形态（多故障边界）', () => {
  const lan = (() => {
    const p = JSON.parse(JSON.stringify(P));
    const dom = (id, platform, address, nodes) => ({ id, platform, address, nodes, sharedFailureFactors: [] });
    p.topology.deployments.lan = {
      description: '测试用 5 边界形态',
      // 刻意不声明 containerNetwork —— 节点分处不同机器，地址即机器地址
      // 边界从**声明**派生，不枚举 l1-1…l1-5：每个验证者独占一个边界、
      // primary 依次搭在前几个边界上（与真实 lan 同形）。
      // 写死五个的后果不是测试变错，而是加一个成员时 l1-6 没有归属边界 →
      // deriveTopology 给它 address: null → 本套件在 startsWith 上抛 TypeError，
      // 而那个失败在 npm test 的总数里看不见（describe 体抛异常 → not ok 但不计入 fail）。
      failureDomains: (() => {
        const vids = p.topology.nodes.filter((n) => n.role === 'l1-validator').map((n) => n.id);
        const pids = p.topology.nodes.filter((n) => n.role === 'primary').map((n) => n.id);
        return vids.map((id, i) => dom(
          `m${i + 1}`,
          i < 2 ? 'windows' : 'linux',
          `10.0.0.${i + 1}`,
          [id, ...(pids[i] ? [pids[i]] : [])],
        ));
      })(),
    };
    p.topology.activeDeployment = 'lan';
    return p;
  })();
  const LAN = renderNodeFlags(lan, IDENTITY, 'lan');

  test('public-ip 取所属边界的机器地址，而不是容器 IP', () => {
    assert.equal(LAN['l1-1']['public-ip'], '10.0.0.1');
    assert.equal(LAN['l1-3']['public-ip'], '10.0.0.3');
    assert.equal(LAN['primary-2']['public-ip'], '10.0.0.2');
    for (const f of Object.values(LAN)) {
      assert.ok(!f['public-ip'].startsWith('172.28.'), '跨机形态不得使用容器网段地址');
    }
  });

  test('同一边界内的节点共用地址，靠端口区分', () => {
    assert.equal(LAN['l1-1']['public-ip'], LAN['primary-1']['public-ip']);
    assert.notEqual(LAN['l1-1']['staking-port'], LAN['primary-1']['staking-port']);
  });

  test('bootstrap-ips 指向 Primary 节点所在机器的地址与端口', () => {
    const ips = LAN['l1-3']['bootstrap-ips'].split(',');
    assert.deepEqual(ips, [
      `10.0.0.1:${LAN['primary-1']['staking-port']}`,
      `10.0.0.2:${LAN['primary-2']['staking-port']}`,
    ]);
  });

  // 同上：原断言要求清单覆盖全部 5 台机器的地址，功能 005 反了过来。
  // 这里用的是**假拓扑**（10.0.0.x），所以直接断言"一个都不在"最直白。
  test('http-allowed-hosts **不随机器数变化** —— 五台的地址一个都不在清单里', () => {
    const allowed = LAN['l1-1']['http-allowed-hosts'];
    for (const d of lan.topology.deployments.lan.failureDomains) {
      assert.ok(!allowed.includes(d.address),
        `${d.address} 出现在清单里 —— 清单又随机器列表变了，`
        + '加一台机器会改到每个既有节点的配置（见 tests/unit/add-machine-noop.test.mjs）');
    }
    assert.deepEqual(allowed, [...new Set(lan.endpoints.publishedHosts)],
      '清单应当**恰好**等于已发布主机（去重后）—— 多一项少一项都说明派生逻辑变了');
  });

  test('地址可由环境变量覆盖（T060）—— 机器 IP 是安装特有数据', () => {
    const prev = process.env.KARMACHAIN_ADDRESS_OVERRIDE;
    process.env.KARMACHAIN_ADDRESS_OVERRIDE = 'm3=192.168.5.30';
    try {
      const f = renderNodeFlags(lan, IDENTITY, 'lan');
      assert.equal(f['l1-3']['public-ip'], '192.168.5.30');
      assert.equal(f['l1-1']['public-ip'], '10.0.0.1', '未被覆盖的边界不受影响');
    } finally {
      if (prev === undefined) delete process.env.KARMACHAIN_ADDRESS_OVERRIDE;
      else process.env.KARMACHAIN_ADDRESS_OVERRIDE = prev;
    }
  });
});
