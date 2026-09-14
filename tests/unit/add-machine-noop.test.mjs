// 加一台机器，**既有节点的配置逐字节不变**（功能 005 / T021 判据 ④ 的离线版）。
//
// ## 这条守的是 005 的整个卖点
//
// 「加节点不重置链」只是下限。真正有用的是**加节点不动既有节点** ——
// 否则每加一台机器都要把五台上的容器全部重建一遍，弹性无从谈起。
//
// T021 是这条的现场版（五台机器、比对容器的 Created/StartedAt）。但现场只能跑一次，
// 而回归会在任何一次改动里悄悄发生 —— 所以同一条性质必须**也有一个离线判据**。
//
// ## 它是怎么被逼出来的
//
// 分家做完后模拟加一台机器，发现既有七个节点的 flags.json 里**有一个键会变**：
// `http-allowed-hosts`，因为它当时列着每一台机器的地址。
//
// 而 2026-09-14 对活节点的实测表明，avalanchego 对 **IP 字面量的 Host 头无条件放行**：
// 未列出的 `192.168.1.99` / `10.99.99.99` / 公网 `203.0.113.7` 全部 200，
// 未列出的域名 `evil.example.com` 才 403。那些地址在清单里没有产生任何约束 ——
// 于是它们被去掉，本守卫锁住「去掉之后确实为零改动」。
//
// 这条实测是**版本相关**的，另由 tests/integration/host-header-policy.test.mjs
// 对活节点断言，哪天上游改了策略那条会先红。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadProtocol, readJson, REPO_ROOT } from '../../tools/protocol/load.mjs';
import { renderNodeFlags } from '../../tools/protocol/render-node-flags.mjs';

const IDENTITY = readJson(resolve(REPO_ROOT, 'blockchain', 'chain-identity', 'karmachain.identity.json'));
const BASE = loadProtocol();

// 探针机器的地址与端口全部**派生**，不写字面量 —— 002 的 no-hardcode 守卫
// 第七次在这儿抓到我（单机形态的容器网段字面量）。它是对的：测试夹具里的协议取值一样会漂移，
// 而漂移的表现是"测试仍然绿，但测的是一个不存在的网段"。
const probeFor = (deployment) => {
  const dep = BASE.topology.deployments[deployment];
  const seed = dep.containerNetwork
    ? dep.containerNetwork.subnet.split('/')[0]          // 单机形态：容器网段
    : dep.failureDomains[0].address;                     // 跨机形态：某台机器的网段
  const lastPort = Math.max(...BASE.validators.nodes.flatMap((n) => [n.httpPort, n.stakingPort]));
  return {
    id: 'probe-host',
    address: seed.replace(/.d+$/, '.240'),             // 同网段一个不会被用到的末位
    httpPort: lastPort + 21,                             // 跳开现有区段
    stakingPort: lastPort + 22,
    index: BASE.validators.count + 1,
  };
};

/**
 * 往某个部署形态加一台**只跑一个 L1 验证者**的机器。
 *
 * 刻意不加 Primary：加 Primary 会改到每个 L1 验证者的 `bootstrap-ips`，
 * 那是**真实且必要**的变化（引导目标确实多了一个），属 US4 的范围，不该混进这条。
 */
const withExtraMachine = (deployment, { id, address, httpPort, stakingPort, index }) => {
  const next = structuredClone(BASE);
  next.validators.count += 1;
  next.validators.nodes.push({
    index, httpPort, stakingPort, keyDir: `blockchain/validators/dev/node-${index}/`,
  });
  next.topology.nodes.push({ id: `l1-${index}`, role: 'l1-validator', index });
  next.topology.deployments[deployment].failureDomains.push({
    id, platform: 'linux', address, nodes: [`l1-${index}`], sharedFailureFactors: [],
  });
  return next;
};

describe('lan 形态：加一台 L1 验证者机器 → 既有节点的 flags 逐字节不变', () => {
  const before = renderNodeFlags(BASE, IDENTITY, 'lan');
  const after = renderNodeFlags(
    withExtraMachine('lan', probeFor('lan')),
    IDENTITY, 'lan',
  );

  test('模拟确实生效了（新节点出现在结果里）', () => {
    // 防「什么都没加所以当然没变」——本项目最熟悉的那种假绿灯。
    const newId = `l1-${probeFor('lan').index}`;
    assert.ok(!(newId in before), `基线里不该有 ${newId}`);
    assert.ok(newId in after, '模拟没把新节点加进去 —— 下面的比对毫无意义');
    assert.equal(Object.keys(after).length, Object.keys(before).length + 1);
  });

  for (const id of Object.keys(renderNodeFlags(BASE, IDENTITY, 'lan'))) {
    test(`\`${id}\` 的 flags 未变`, () => {
      assert.deepEqual(after[id], before[id],
        `加一台机器改到了既有节点 \`${id}\` 的配置。\n`
        + '  **那意味着五台机器上的容器都要重建一次** —— 链虽然不重置，\n'
        + '  但"加一台机器"从一次本地操作变成一次全网停机窗口，弹性就没了。\n'
        + '  先问：这个键**真的**需要随机器列表变吗？\n'
        + '  （`http-allowed-hosts` 曾经变，而实测表明它列的那些地址根本不起作用。）');
    });
  }

  test('JSON 序列化也相同（键顺序未变 → 生成物不会无谓地变字节）', () => {
    for (const id of Object.keys(before)) {
      assert.equal(JSON.stringify(after[id]), JSON.stringify(before[id]), `${id} 的键顺序变了`);
    }
  });
});

describe('local 形态同样成立（两种形态都不能退化）', () => {
  const before = renderNodeFlags(BASE, IDENTITY, 'local');
  const after = renderNodeFlags(
    withExtraMachine('local', probeFor('local')),
    IDENTITY, 'local',
  );

  for (const id of Object.keys(before)) {
    test(`\`${id}\` 的 flags 未变`, () => {
      assert.deepEqual(after[id], before[id],
        `单机形态下加一个节点改到了既有节点 \`${id}\`。\n`
        + '  单机形态用容器 IP，同样是 IP 字面量，同样无条件放行。');
    });
  }
});

describe('去掉地址之后，清单里该留的还在', () => {
  const flags = renderNodeFlags(BASE, IDENTITY, 'lan');

  test('`localhost` 必须仍在清单里（代理把 Host 统一改写成它）', () => {
    for (const [id, f] of Object.entries(flags)) {
      assert.ok(f['http-allowed-hosts'].includes('localhost'),
        `\`${id}\` 的清单里没有 localhost。\n`
        + '  RPC 代理把 Host 头统一改写为 localhost（见 render-rpc-proxy.mjs）——\n'
        + '  而**名字不在清单里就是 403**（实测：evil.example.com → 403）。\n'
        + '  去掉它，对外 RPC 入口会整条断掉。');
    }
  });

  test('清单里**不含**任何机器地址（否则加机器又会改到既有节点）', () => {
    const domainAddrs = new Set(
      BASE.topology.deployments.lan.failureDomains.map((d) => d.address),
    );
    for (const [id, f] of Object.entries(flags)) {
      const leaked = f['http-allowed-hosts'].filter((h) => domainAddrs.has(h));
      assert.deepEqual(leaked, [],
        `\`${id}\` 的清单里出现了机器地址：${leaked.join(', ')}\n`
        + '  实测表明 IP 字面量本就无条件放行，列它们不产生任何约束，\n'
        + '  却让清单随机器列表变 —— 加一台机器就要重建全网容器。');
    }
  });

  test('清单不为空（空清单会让 localhost 也被拒）', () => {
    for (const [id, f] of Object.entries(flags)) {
      assert.ok(f['http-allowed-hosts'].length > 0, `${id} 的清单是空的`);
    }
  });
});
