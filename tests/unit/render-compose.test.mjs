// T022：每故障边界一份 compose 的生成结果。
// 重点在两条结构性质：每个节点一个独占卷（卷即故障单元，FR-006），
// 以及各边界之间不产生编排层面的耦合（研究 R-10）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadProtocol, deriveTopology } from '../../tools/protocol/load.mjs';
import { renderCompose, NODE_IMAGE } from '../../tools/protocol/render-compose.mjs';

const P = loadProtocol();
const ALL = renderCompose(P);
// bootstrap.yml 性质不同：一次性建链，跑完即退，不设重启策略也不做健康检查。
// 节点 compose 的断言不适用于它，单独验。
// active.env 也不是节点 compose：它是给薄封装脚本读的 KEY=value 摘要。
const { bootstrap: BOOTSTRAP, 'active.env': ACTIVE_ENV, ...FILES } = ALL;

/** 极简解析：取出 services 段下的一级服务名。 */
const servicesOf = (yaml) => [...yaml.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)]
  .map((m) => m[1])
  .filter((n) => yaml.indexOf(`  ${n}:\n    <<: *node`) !== -1);

describe('生成的文件与拓扑对应', () => {
  test('每个部署形态的每个故障边界各一份', () => {
    let expected = 0;
    for (const name of Object.keys(P.topology.deployments)) {
      expected += P.topology.deployments[name].failureDomains.length;
    }
    assert.equal(Object.keys(FILES).length, expected);
  });

  test('文件名由「部署形态-边界 id」构成', () => {
    for (const name of Object.keys(P.topology.deployments)) {
      for (const d of P.topology.deployments[name].failureDomains) {
        assert.ok(FILES[`${name}-${d.id}`], `缺少 ${name}-${d.id}.yml`);
      }
    }
  });

  test('服务集合恰好等于该边界的成员节点', () => {
    for (const name of Object.keys(P.topology.deployments)) {
      for (const d of P.topology.deployments[name].failureDomains) {
        const svc = servicesOf(FILES[`${name}-${d.id}`]);
        assert.deepEqual([...svc].sort(), [...d.nodes].sort(), `${name}-${d.id} 的服务与成员不符`);
      }
    }
  });

  test('一份 compose 只描述一个边界 —— 不引用其他边界的节点', () => {
    const D = deriveTopology(P);
    const all = D.topologyNodes.map((n) => n.id);
    for (const d of D.failureDomains) {
      const yaml = FILES[`${P.topology.activeDeployment}-${d.id}`];
      const foreign = all.filter((id) => !d.nodes.includes(id));
      for (const id of foreign) {
        assert.ok(!yaml.includes(`container_name: karmachain-${id}`),
          `${d.id} 的 compose 不应包含其他边界的节点 ${id}`);
      }
    }
  });
});

describe('卷即故障单元', () => {
  test('每个节点一个独占命名卷，卷名与节点 id 对应且稳定', () => {
    const D = deriveTopology(P);
    for (const d of D.failureDomains) {
      const yaml = FILES[`${P.topology.activeDeployment}-${d.id}`];
      for (const id of d.nodes) {
        assert.ok(yaml.includes(`- karmachain-${id}-data:/data`), `${id} 应挂载独占卷到 /data`);
        assert.ok(yaml.includes(`name: karmachain-${id}-data`), `${id} 的卷应显式命名`);
      }
    }
  });

  test('没有任何两个节点共用数据卷', () => {
    for (const yaml of Object.values(FILES)) {
      const mounts = [...yaml.matchAll(/- (karmachain-[a-z0-9-]+-data):\/data/g)].map((m) => m[1]);
      assert.equal(new Set(mounts).size, mounts.length, '存在共用的数据卷');
    }
  });

  test('节点的身份材料与配置一律只读挂载', () => {
    for (const yaml of Object.values(FILES)) {
      const mounts = [...yaml.matchAll(/^ {6}- \.\.\/\.\.\/(\S+?):(\S+?)(:ro)?$/gm)];
      assert.ok(mounts.length > 0);
      for (const [, src, , ro] of mounts) {
        assert.ok(ro, `${src} 必须以只读方式挂载 —— 运行期不得改写仓库中的事实来源`);
      }
    }
  });
});

describe('崩溃自愈所依赖的容器配置', () => {
  test('每个服务都设了重启策略', () => {
    for (const yaml of Object.values(FILES)) {
      assert.match(yaml, /restart: unless-stopped/, '缺少重启策略，宿主重启后节点不会自动回来');
    }
  });

  test('健康检查存在，且给了足够的启动宽限', () => {
    for (const yaml of Object.values(FILES)) {
      assert.match(yaml, /healthcheck:/);
      assert.match(yaml, /start_period: \d+s/, '缺少 start_period 会让引导中的节点被误判并反复重启');
    }
  });

  test('节点服务使用统一镜像，且构建上下文指向仓库根', () => {
    for (const yaml of Object.values(FILES)) {
      assert.ok(yaml.includes(`image: ${NODE_IMAGE}`));
      assert.match(yaml, /dockerfile: docker\/node\/Dockerfile/);
    }
  });
});

describe('端口映射', () => {
  test('对外 RPC 端口只映射到边界内的一个 L1 验证者', () => {
    const D = deriveTopology(P);
    for (const d of D.failureDomains) {
      const yaml = FILES[`${P.topology.activeDeployment}-${d.id}`];
      const hits = [...yaml.matchAll(new RegExp(`"${P.endpoints.hostRpcPort}:\\d+"`, 'g'))];
      const hasValidator = d.nodes.some((id) => D.topologyNodes.find((n) => n.id === id)?.role === 'l1-validator');
      assert.equal(hits.length, hasValidator ? 1 : 0,
        `${d.id} 的对外 RPC 端口映射数量不对（含验证者=${hasValidator}）`);
    }
  });

  // 单机形态下节点端口一律不发布：节点之间走容器网络，宿主只需要一个 RPC 入口。
  // 这既是 001 的既有做法，也避开了 Windows 的保留端口段（实测本机的保留区间正好覆盖节点端口）。
  test('单机形态下除对外 RPC 外不发布任何端口', () => {
    const D = deriveTopology(P);
    if (!D.containerNetwork) return;   // 多机形态另有断言
    for (const d of D.failureDomains) {
      const yaml = FILES[`${P.topology.activeDeployment}-${d.id}`];
      const published = [...yaml.matchAll(/^ {6}- "(\d+):(\d+)"$/gm)].map((m) => m[1]);
      assert.deepEqual(published, [String(P.endpoints.hostRpcPort)],
        `${d.id} 只应发布 ${P.endpoints.hostRpcPort}，实际发布了 ${published.join(', ')}`);
    }
  });

  test('单机形态下每个节点分配了独立的容器 IP', () => {
    const D = deriveTopology(P);
    if (!D.containerNetwork) return;
    const ips = new Set();
    for (const d of D.failureDomains) {
      const yaml = FILES[`${P.topology.activeDeployment}-${d.id}`];
      assert.ok(yaml.includes(`- subnet: ${D.containerNetwork.subnet}`), '缺少容器网络的 subnet 声明');
      for (const id of d.nodes) {
        const n = D.topologyNodes.find((x) => x.id === id);
        assert.ok(yaml.includes(`ipv4_address: ${n.address}`), `${id} 未分配静态容器 IP`);
        ips.add(n.address);
      }
    }
    assert.equal(ips.size, D.topologyNodes.length, '容器 IP 必须两两不同 —— 否则节点会连向自身');
  });
});
