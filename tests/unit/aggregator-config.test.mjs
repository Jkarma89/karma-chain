// 签名聚合器的配置推导（功能 005 / T027 第四步）。
//
// ## 这套件守的是一个**静默**的错法
//
// 聚合器少了 `allow-private-ips` 时的表现（2026-09-16 实测）：
//   TCP 能连通 Primary 的 staking 端口
//   avalanchego 的握手一个都建不起来，两个 Primary 的 peer 列表里都看不到它
//   日志里 `connectedWeight: 0`，**不报任何拨号错误**
//   换一台机器、改用 host 网络 —— 一模一样
//
// 三个现象全指向网络，真凶却是一个布尔配置项。我据此误判过一次，
// 让人把容器搬到另一台机器上白跑了一趟。
//
// 而入口脚本里取这个值的写法是 `jq -r '.["network-allow-private-ips"] // "false"'` ——
// **字段一旦消失，兜底会静默给出 false**，于是又回到那个没有错误信息的状态。
// 所以这里断言两件事：字段确实存在于生成物里；入口确实从那里取。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, globSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadProtocol, deriveTopology, readJson, REPO_ROOT } from '../../tools/protocol/load.mjs';

const ENTRYPOINT = readFileSync(resolve(REPO_ROOT, 'docker/aggregator/entrypoint.sh'), 'utf8');
const DOCKERFILE = readFileSync(resolve(REPO_ROOT, 'docker/aggregator/Dockerfile'), 'utf8');
const CONFIG = loadProtocol();
const DEPLOYMENT = CONFIG.topology.activeDeployment;
const PRIMARIES = deriveTopology(CONFIG).topologyNodes.filter((n) => n.role === 'primary');

describe('allow-private-ips：值有出处，且出处不会悄悄消失', () => {
  test(`每个 Primary 的 flags 制品都带 network-allow-private-ips（共 ${PRIMARIES.length} 个）`, () => {
    assert.ok(PRIMARIES.length >= 2, `只找到 ${PRIMARIES.length} 个 Primary`);
    for (const n of PRIMARIES) {
      const flags = readJson(resolve(REPO_ROOT, 'blockchain/nodes', DEPLOYMENT, `${n.id}.flags.json`));
      assert.ok('network-allow-private-ips' in flags,
        `${n.id}.flags.json 里没有 network-allow-private-ips —— `
        + '入口脚本取不到就会按 "false" 兜底，而那会让聚合器**静默连不上**：'
        + 'TCP 通、握手不成、不报错。渲染器若不再输出这一项，要么改入口的取法，'
        + '要么让它显式报错，不能让兜底顶上去。');
    }
  });

  test('两个 Primary 的取值一致（聚合器只能取一个）', () => {
    const values = new Set(PRIMARIES.map((n) => readJson(
      resolve(REPO_ROOT, 'blockchain/nodes', DEPLOYMENT, `${n.id}.flags.json`),
    )['network-allow-private-ips']));
    assert.equal(values.size, 1,
      `Primary 之间对 network-allow-private-ips 有 ${values.size} 种取值：${[...values].join('、')}`);
  });

  test('本部署确实允许私网地址（LAN 形态的前提）', () => {
    const v = readJson(
      resolve(REPO_ROOT, 'blockchain/nodes', DEPLOYMENT, `${PRIMARIES[0].id}.flags.json`),
    )['network-allow-private-ips'];
    assert.equal(String(v), 'true',
      '本形态的节点地址都是 192.168.x 私网地址；这一项若为 false，'
      + '连节点之间都连不上 —— 这条更像是渲染器出了问题，不是配置选择');
  });

  test('入口脚本从 flags 制品取这个值，而不是自己判 RFC1918', () => {
    // **必须匹配那行 jq 取值本身**，不能只匹配字段名 ——
    // 字段名在本文件的注释与报错文案里也出现，写死成 true 也照样"匹配得上"。
    // 第一版就是这么写的，于是"入口不再读 flags"那条变异没能变红。
    assert.match(ENTRYPOINT, /thisPrivate="\$\(jq -r '\.\["network-allow-private-ips"\]/,
      '入口脚本没有从 flags 制品里 jq 取 network-allow-private-ips —— '
      + '写死这个值就等于自己做了第二份判断，而节点与聚合器必须对'
      + '"私网地址能不能用"有同一个答案');
    assert.match(ENTRYPOINT, /\$\{NODES_DIR\}\/\$\{DEPLOYMENT\}\/\$\{id\}\.flags\.json/,
      '入口脚本没有按「部署形态 / 节点 id」去定位 flags 制品');
    assert.doesNotMatch(ENTRYPOINT, /192\.168\.|10\.\d|172\.(1[6-9]|2\d|3[01])\./,
      '入口脚本里出现了私网地址字面量 —— 地址一律从 deployment.json 推导');
  });

  test('推导出的值进了配置的 allow-private-ips', () => {
    assert.match(ENTRYPOINT, /"allow-private-ips":\s*\$allowPrivate/,
      '配置里的 allow-private-ips 不是来自推导出的变量');
    assert.match(ENTRYPOINT, /--argjson allowPrivate/,
      '用 --arg 而不是 --argjson 会把它写成字符串 "true"，而配置要的是布尔值');
  });

  test('两个 Primary 取值不一致时入口要报错，不是随便挑一个', () => {
    assert.match(ENTRYPOINT, /network-allow-private-ips 不一致/,
      '入口没有处理两个 Primary 取值分叉的情形 —— 静默取其一会让行为取决于遍历顺序');
  });
});

describe('Primary 必须显式列出两个', () => {
  test('入口断言至少 2 个 Primary', () => {
    assert.match(ENTRYPOINT, /\[ "\$\{COUNT\}" -ge 2 \]/,
      '入口没有断言 Primary 数量。实测：只给 info-api 时聚合器从那个节点的 peer 列表'
      + '推导引导节点，而**节点不在自己的 peer 列表里**，于是只发现一个，'
      + '连上 50% 权益就报 failed to connect to a threshold of stake');
  });

  test('manually-tracked-peers 用 staking 端口，不是 http 端口', () => {
    assert.match(ENTRYPOINT, /\$\{address\}:\$\{stakingPort\}/,
      'P2P 要连的是 staking 端口；填 http 端口会连不上，而且同样不报拨号错误');
  });
});

describe('镜像与入口的接线', () => {
  test('Dockerfile 的 ENTRYPOINT 指向入口脚本', () => {
    assert.match(DOCKERFILE, /ENTRYPOINT \["\/opt\/karmachain\/entrypoint\.sh"\]/,
      'ENTRYPOINT 不是入口脚本 —— 直接跑二进制就没有配置推导那一步');
  });

  test('镜像装了 jq（入口靠它推导配置）', () => {
    assert.match(DOCKERFILE, /install -y --no-install-recommends[^\n]*\bjq\b/,
      '最终镜像里没装 jq，入口第一步就会退出 10');
  });

  test('聚合器**不进** compose —— 它是按需容器', () => {
    // 进了 compose 就成了常驻服务，要付配置、监控、升级三笔账，而它一年用不了几次。
    const composeDir = resolve(REPO_ROOT, 'docker/compose');
    const files = globSync('*.yml', { cwd: composeDir });
    for (const f of files) {
      const text = readFileSync(resolve(composeDir, f), 'utf8');
      assert.doesNotMatch(text, /karmachain\/aggregator/,
        `${f} 里出现了聚合器镜像 —— 它应当由 tools/membership/ 用 docker run --rm 按需拉起`);
    }
  });
});
