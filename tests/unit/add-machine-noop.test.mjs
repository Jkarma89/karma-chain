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
import { loadProtocol, readJson, REPO_ROOT, validateConstraints } from '../../tools/protocol/load.mjs';
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
 *
 * `where` 决定新节点插在 `topology.nodes` 的哪个位置：
 *
 *   - `'before-primaries'`（**默认**）—— 人实际的改法：保持"验证者在前"的既有顺序
 *   - `'append'`            —— 追加到数组末尾
 *
 * **这两者必须都测。** 第一版只测了 `append`，于是 2026-09-14 真加第六台机器时
 * 单机形态的容器 IP 全被改号，而守卫是绿的 —— 容器 IP 按**数组位置**派生，
 * 追加不挪位置，插在中间才挪。**判据本身对，取样方式错。**
 */
const withExtraMachine = (deployment, { id, address, httpPort, stakingPort, index }, where = 'before-primaries') => {
  const next = structuredClone(BASE);
  next.validators.count += 1;
  next.validators.nodes.push({
    index, httpPort, stakingPort, keyDir: `blockchain/validators/dev/node-${index}/`,
  });
  // **键名是 `validatorIndex`**，不是 `index`。第一版写错了，而守卫只比对既有节点，
  // 所以那个畸形的模拟节点一直没被察觉 —— 下面那条 validateConstraints 就是为此加的。
  const entry = { id: `l1-${index}`, role: 'l1-validator', validatorIndex: index };
  const at = where === 'append'
    ? next.topology.nodes.length
    : next.topology.nodes.findIndex((n) => n.role === 'primary');
  next.topology.nodes.splice(at < 0 ? next.topology.nodes.length : at, 0, entry);

  // **每一种形态**都要把新节点分配到某个边界（T-4：成员并集必须等于节点全集），
  // 而且必须**保持该形态原有的边界结构**：
  //
  //   - 多边界形态（lan）→ 新开一个边界。塞进既有边界会让它有 2 个验证者，
  //     违反 T-5（每边界至多 ⌊n/4⌋ = 1 个）。
  //   - 单边界形态（local）→ 加进它唯一的那个边界。**不能新开** ——
  //     T-5 只在边界数 > 1 时生效，多开一个会把它激活，
  //     于是那个原本合法地装着 5 个验证者的单边界立刻变成违规。
  //
  // 这两条我都先写错过一次，两次都是 validateConstraints 抛出来的。
  // **"模拟一个加节点操作"在不同形态下不是同一件事**，而这件事只有约束校验器知道。
  for (const [name, dep] of Object.entries(next.topology.deployments)) {
    if (dep.failureDomains.length === 1) {
      dep.failureDomains[0].nodes.push(entry.id);
      continue;
    }
    const seed = dep.failureDomains[0].address;
    dep.failureDomains.push({
      id: name === deployment ? id : `${id}-${name}`,
      platform: 'linux',
      address: name === deployment ? address : seed.replace(/.d+$/, '.241'),
      nodes: [entry.id],
      sharedFailureFactors: [],
    });
  }

  // **模拟本身必须是一份合法配置。** 否则测的是"畸形输入下既有节点没变"，
  // 那句话恒真而毫无意义 —— 这正是第一版发生的事。
  const errs = validateConstraints(next);
  if (errs.length) throw new Error(`模拟出的配置不合法，本套件测不了任何东西：${errs.map((e) => `
  - ${e}`).join('')}`);
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

// ## 单机形态：**追加**是零改动，**插在中间**会给既有节点改号（已知限制，T068）
//
// 单机形态下每个节点是独立容器，地址由 `containerIp(i)` 按**数组位置** i 派生
// （子网前缀 + firstHost + i）。于是：
//
//   - 追加到 `topology.nodes` 末尾 → 谁的位置都没挪 → 既有节点零改动
//   - 插在中间（为保持"验证者在前"时的自然改法）→ 后面每个节点的容器 IP 都 +1，
//     于是全部验证者的 `bootstrap-ips` 与两个 Primary 的 `public-ip` 一起变
//
// 2026-09-14 真加第六台机器时撞到的就是这一条。**跨机形态不受影响**
// （地址取自所属故障边界的机器地址，与数组位置无关），而跨机才是真实部署。
//
// 代价被限定在"那一台开发机重建一次容器"，链数据不受影响（stamp 六项不含拓扑）。
// 修法记在 T068：让容器 IP 由稳定值派生，而非数组位置。
//
// **此处刻意不把"插在中间会变"写成断言** —— 那会把缺陷锁成"预期行为"。
// 用 todo 标注：它在输出里可见、不拦住套件，而修好之后会显出来。
describe('local 形态：追加是零改动，插在中间是已知限制（T068）', () => {
  const before = renderNodeFlags(BASE, IDENTITY, 'local');
  const appended = renderNodeFlags(
    withExtraMachine('local', probeFor('local'), 'append'), IDENTITY, 'local',
  );
  const inserted = renderNodeFlags(
    withExtraMachine('local', probeFor('local'), 'before-primaries'), IDENTITY, 'local',
  );

  for (const id of Object.keys(before)) {
    test('**追加**时 ' + id + ' 的 flags 未变', () => {
      assert.deepEqual(appended[id], before[id],
        '单机形态下**追加**一个节点改到了既有节点 ' + id + '。\n'
        + '  连追加都会变，说明位置依赖比 T068 记录的更严重 —— 重新查 containerIp()。');
    });
  }

  for (const id of Object.keys(before)) {
    test('插在中间时 ' + id + ' 的 flags 未变', {
      todo: '已知限制 T068：单机形态的容器 IP 按数组位置派生，插在中间会给后面的节点改号',
    }, () => {
      assert.deepEqual(inserted[id], before[id]);
    });
  }

  test('限制**只在**单机形态（跨机形态必须不受影响）', () => {
    // 这条是上面那组 todo 的边界：若哪天跨机形态也变成位置依赖，
    // 上面的 lan 套件会红，而这条给出"为什么那很严重"的落点。
    const lanBefore = renderNodeFlags(BASE, IDENTITY, 'lan');
    const lanAfter = renderNodeFlags(
      withExtraMachine('lan', probeFor('lan'), 'before-primaries'), IDENTITY, 'lan',
    );
    for (const id of Object.keys(lanBefore)) {
      assert.deepEqual(lanAfter[id], lanBefore[id],
        '跨机形态的 ' + id + ' 也变成位置依赖了 —— **那是真实部署**，\n'
        + '  意味着加一台机器要重建五台上的全部容器，005 的卖点就没了。');
    }
  });
});
