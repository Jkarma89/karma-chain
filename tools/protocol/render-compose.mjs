// tools/protocol/render-compose.mjs
//
// 由拓扑生成**每个故障边界一份** compose 文件（docker/compose/<domain>.yml）。
//
// 每台机器只跑自己那份 —— 机器之间没有编排层面的依赖，只有链层面的 P2P 关系（研究 R-10）。
// 这正是"不引入集群编排系统"的直接收益：任一台机器的编排失效不影响其他机器。
//
// 每个节点一个独占命名卷承载 /data。删掉某个卷再启动，该节点从对等节点重新同步，
// 其余节点不受影响（FR-006）—— 卷即故障单元。
//
// 用法：node tools/protocol/render-compose.mjs [--check]

import { writeFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadProtocol, deriveTopology, REPO_ROOT } from './load.mjs';
// 探测路径的**唯一来源**是渲染 nginx 配置的那个模块 —— 两处各写一份必然漂移，
// 而漂移的表现是"healthcheck 永远失败"，排查起来毫无线索。
import { PROXY_PROBE_PATH } from './render-rpc-proxy.mjs';

export const OUTPUT_DIR = resolve(REPO_ROOT, 'docker', 'compose');
export const NODE_IMAGE = 'karmachain/node:local';
// 每个节点一个独占命名卷 —— **FR-001** 的落地方式：数据的可用性只取决于这个卷，
// 与任何编排工具无关（缺陷 A 的修复基础，研究 R-01）。卷即故障单元，
// 因此单节点数据损坏可以只重建它（FR-006 / SC-011）。
const volumeOf = (id) => `karmachain-${id}-data`;
const containerOf = (id) => `karmachain-${id}`;

/**
 * 生成全部部署形态下每个故障边界的 compose 文本。
 * @returns {Record<string,string>} "<deployment>-<domain>" → YAML
 */
export function renderCompose(p = loadProtocol()) {
  const out = {};
  for (const deployment of Object.keys(p.topology.deployments)) {
    const d = deriveTopology({ ...p, topology: { ...p.topology, activeDeployment: deployment } });
    const byId = new Map(d.topologyNodes.map((n) => [n.id, n]));

    for (const domain of d.failureDomains) {
      const nodes = domain.nodes.map((id) => byId.get(id));
      // 对外 RPC 端口只映射到本边界内序号最小的 L1 验证者 —— 它承载 endpoints.hostRpcPort
      const rpcHost = nodes.find((n) => n.role === 'l1-validator');
      out[`${deployment}-${domain.id}`] = composeText(p, deployment, domain, nodes, rpcHost, d.containerNetwork);
    }
  }
  out.bootstrap = bootstrapText(p);
  out['active.env'] = activeEnvText(p);
  return out;
}

/**
 * 生效部署形态的 shell 可读摘要。
 *
 * 为什么需要它：scripts/devnet-* 必须保持「宿主只需要 Docker」这一承诺（README），
 * 不能依赖 Node 去解析 protocol.json。把该由生成器知道的事写成 KEY=value，
 * 薄封装脚本 source 一下就够了 —— 业务逻辑仍然只在生成器里。
 */
function activeEnvText(p) {
  const name = p.topology.activeDeployment;
  const d = deriveTopology(p);
  const domains = d.failureDomains.map((x) => x.id);
  const L = [];
  L.push('# GENERATED FROM blockchain/protocol.json by tools/protocol/render-compose.mjs — DO NOT EDIT.');
  L.push(`KARMACHAIN_DEPLOYMENT=${name}`);
  L.push(`KARMACHAIN_DOMAINS="${domains.join(' ')}"`);
  L.push(`KARMACHAIN_DEFAULT_DOMAIN=${domains[0]}`);
  L.push(`KARMACHAIN_RPC_PORT=${p.endpoints.hostRpcPort}`);
  L.push(`KARMACHAIN_RPC_PATH=${p.endpoints.rpcPath}`);
  L.push(`KARMACHAIN_CHAIN_ID_HEX=0x${p.chain.chainId.toString(16)}`);
  L.push(`KARMACHAIN_NODE_IDS="${d.topologyNodes.map((n) => n.id).join(' ')}"`);
  L.push(`KARMACHAIN_VALIDATOR_IDS="${d.topologyNodes.filter((n) => n.role === 'l1-validator').map((n) => n.id).join(' ')}"`);
  L.push(`KARMACHAIN_MAX_OFFLINE_VALIDATORS=${d.faultTolerance.maxOfflineValidators}`);
  // 每边界的声明地址，供 devnet-start 在跨机形态下核对"本机是不是拓扑说的那台机器"。
  // 放进 active.env 是为了让宿主侧的检查不需要解析 JSON —— 宿主只装 Docker，没有 Node
  // （见 contracts/cli-interface.md）。单边界形态下 KARMACHAIN_DOMAIN_COUNT=1，检查自动跳过：
  // 127.0.0.1 不是网卡地址，强行核对只会误报。
  L.push(`KARMACHAIN_DOMAIN_COUNT=${d.failureDomains.length}`);
  L.push(`KARMACHAIN_DOMAIN_ADDRESSES="${d.failureDomains.map((x) => `${x.id}=${x.address}`).join(' ')}"`);
  L.push('');
  return L.join('\n');
}

/**
 * 一次性建链的 compose。
 *
 * 它要挂上**全部**节点卷：建链的产出不只是几个 JSON —— Subnet 与 Blockchain 是 P 链上的交易，
 * 只存在于节点数据库里。节点若从空卷启动，得到的是一条没有该 Subnet 的新 P 链，L1 不存在
 * （实测：platform.getSubnets 只返回 Primary Network，/ext/bc/<alias>/rpc 返回 404）。
 * 因此建链完成后必须把数据库播种进这些卷，002 的节点才能接管这条链。
 */
function bootstrapText(p) {
  const ids = p.topology.nodes.map((n) => n.id);
  const L = [];
  L.push('# GENERATED FROM blockchain/protocol.json by tools/protocol/render-compose.mjs — DO NOT EDIT.');
  L.push('# 一次性建链。这是仓库中唯一会用到 Avalanche CLI 的地方，跑完即退。');
  L.push('#');
  L.push('# 用法：scripts/devnet-bootstrap（不要直接 compose up —— 它需要先确认没有节点在跑）');
  L.push('');
  L.push('services:');
  L.push('  bootstrap:');
  L.push('    build:');
  L.push('      context: ../..');
  L.push('      dockerfile: docker/bootstrap/Dockerfile');
  L.push('    image: karmachain/bootstrap:local');
  L.push('    container_name: karmachain-bootstrap');
  L.push('    volumes:');
  L.push('      - ../..:/workspace');
  for (const id of ids) L.push(`      - ${volumeOf(id)}:/seed/${id}`);
  L.push('');
  L.push('volumes:');
  for (const id of ids) {
    L.push(`  ${volumeOf(id)}:`);
    L.push(`    name: ${volumeOf(id)}`);
  }
  L.push('');
  return L.join('\n');
}

function composeText(p, deployment, domain, nodes, rpcHost, net) {
  const L = [];
  L.push('# GENERATED FROM blockchain/protocol.json by tools/protocol/render-compose.mjs — DO NOT EDIT.');
  L.push(`# 部署形态 ${deployment} · 故障边界 ${domain.id}（${domain.platform}, ${domain.address}）`);
  L.push('#');
  L.push('# 本文件只描述这一个故障边界。每台机器跑自己那份，机器之间没有编排依赖。');
  if (domain.sharedFailureFactors?.length) {
    L.push(`# 已声明的共享失效因素：${domain.sharedFailureFactors.join('、')}`);
  }
  L.push('');
  L.push('x-node: &node');
  L.push(`  image: ${NODE_IMAGE}`);
  L.push('  build:');
  L.push('    context: ../..');
  L.push('    dockerfile: docker/node/Dockerfile');
  // 崩溃自愈的实现基础：进程存活交给容器运行时，数据恢复交给节点自身的数据库（研究 R-06）
  L.push('  restart: unless-stopped');
  L.push('  stop_grace_period: 30s');
  L.push('  healthcheck:');
  L.push('    test: ["CMD", "/opt/karmachain/healthcheck.sh"]');
  L.push('    interval: 10s');
  L.push('    timeout: 5s');
  L.push('    retries: 3');
  L.push('    start_period: 120s');
  L.push('');
  L.push('services:');

  for (const n of nodes) {
    // 单机形态：节点之间走容器网络，**不向宿主发布节点端口**。
    // 这既避开了 Windows 保留端口段（实测本机保留 9617–9716，正好覆盖 protocol.json 声明的节点端口），
    // 也和 001 的做法一致 —— 对外只需要一个 RPC 入口。
    // 对外 RPC 端口由 rpc 代理服务持有，不再直接映射到某个验证者 ——
    // 那样一来该验证者一挂，RPC 入口就跟着没了（研究 R-05 的实测修正）
    const ports = net ? [] : [`${n.httpPort}:${n.httpPort}`, `${n.stakingPort}:${n.stakingPort}`];

    L.push(`  ${n.id}:`);
    L.push('    <<: *node');
    L.push(`    container_name: ${containerOf(n.id)}`);
    if (net) {
      L.push('    networks:');
      L.push('      karmachain:');
      L.push(`        ipv4_address: ${n.address}`);
    }
    // 验证者的引导连接超时是 60s：Primary 没就绪就会错过窗口，然后停在"没有 L1"的状态。
    // 同一边界内有 Primary 时按健康状态排序启动（跨边界没有这种依赖 —— 那是另一台机器的事）。
    const localPrimaries = nodes.filter((x) => x.role === 'primary');
    if (n.role === 'l1-validator' && localPrimaries.length) {
      L.push('    depends_on:');
      for (const pnode of localPrimaries) {
        L.push(`      ${pnode.id}:`);
        L.push('        condition: service_healthy');
      }
    }
    L.push('    volumes:');
    L.push(`      - ${volumeOf(n.id)}:/data`);
    L.push(`      - ../../${n.keyDir}:/keys:ro`);
    L.push(`      - ../../blockchain/nodes/${deployment}/${n.id}.flags.json:/config/flags.json:ro`);
    L.push(`      - ../../blockchain/nodes/${n.id}.identity.json:/config/identity.json:ro`);
    L.push('      - ../../blockchain/nodes/aliases.json:/config/aliases.json:ro');
    L.push('      - ../../blockchain/nodes/chain-config:/config/chains:ro');
    L.push('      - ../../blockchain/chain-identity/primary-network.genesis.json:/config/primary-network.genesis.json:ro');
    L.push('      - ../../blockchain/chain-identity/karmachain.identity.json:/config/karmachain.identity.json:ro');
    L.push('      - ../../blockchain/protocol.json:/config/protocol.json:ro');
    // 功能 005：健康检查要的「期望验证者数」在部署描述里。
    // **节点入口（出生证明那六项）仍然只读协议文件** —— 见 tests/unit/stamp-scope.test.mjs：
    // 挂进来不等于让节点启动依赖它，改部署仍不会让任何节点退出 12。
    L.push('      - ../../blockchain/deployment.json:/config/deployment.json:ro');
    L.push('      - ../../blockchain/genesis/karmachain.genesis.json:/config/karmachain.genesis.json:ro');
    L.push('      - ../../blockchain/genesis/karmachain.genesis.hash:/config/karmachain.genesis.hash:ro');
    // 单机形态下只有承载对外 RPC 的那个节点需要发布端口，其余一个都不发布
    if (ports.length) {
      L.push('    ports:');
      for (const x of ports) L.push(`      - "${x}"`);
    }
    L.push('');
  }

  // 对外 RPC 入口：无状态的路径重写代理。
  // 它把公布的 /ext/bc/<alias>/… 重写成 avalanchego 实际注册的 blockchainID 路径，
  // 并在全部验证者（跨故障边界）之间做故障转移。不持有数据，不在崩溃恢复路径上。
  if (rpcHost) {
    L.push('  rpc:');
    L.push('    image: nginx:alpine');
    L.push(`    container_name: karmachain-rpc-${domain.id}`);
    L.push('    restart: unless-stopped');
    if (net) {
      L.push('    networks:');
      L.push('      karmachain:');
    }
    L.push('    volumes:');
    L.push(`      - ../../blockchain/nodes/${deployment}/rpc-proxy.conf:/etc/nginx/conf.d/karmachain.conf:ro`);
    L.push('    ports:');
    L.push(`      - "${p.endpoints.hostRpcPort}:${p.endpoints.hostRpcPort}"`);
    L.push('    depends_on:');
    for (const n of nodes.filter((x) => x.role === 'l1-validator')) L.push(`      - ${n.id}`);
    L.push('    healthcheck:');
    // 代理的健康判定**只回答代理自己**：nginx 进程活着、配置解析通过、端口在监听。
    // 它原先打的是 avalanchego 的综合健康位，而那个位含 P 链可达性 ——
    // 两个 Primary 一停就 503，nginx 把 503 计为上游失败，一次探测毒遍五个上游，
    // 探测间隔又短于惩罚期，于是**真实客户端流量一起吃 502 而链好着**（2026-09-10 实测）。
    // 现在打的是由 nginx 自己应答、不碰任何上游的自检位置。
    // 「链能不能用」由面板与 devnet-verify 回答，不由这里回答（规格 FR-002 / FR-034）。
    L.push(`      test: ["CMD", "wget", "-q", "-O", "-", "http://127.0.0.1:${p.endpoints.hostRpcPort}${PROXY_PROBE_PATH}"]`);
    L.push('      interval: 10s');
    L.push('      timeout: 5s');
    L.push('      retries: 3');
    L.push('      start_period: 60s');
    L.push('');
  }

  if (net) {
    L.push('networks:');
    L.push('  karmachain:');
    L.push('    name: karmachain');
    L.push('    ipam:');
    L.push('      config:');
    L.push(`        - subnet: ${net.subnet}`);
    L.push('');
  }

  L.push('volumes:');
  for (const n of nodes) {
    L.push(`  ${volumeOf(n.id)}:`);
    L.push(`    name: ${volumeOf(n.id)}`);
  }
  L.push('');
  return L.join('\n');
}

const fileFor = (key) => resolve(OUTPUT_DIR, key.endsWith('.env') ? key : `${key}.yml`);

export function checkCompose() {
  const expected = renderCompose();
  const drift = [];
  let existing = [];
  try { existing = readdirSync(OUTPUT_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.env')); } catch { /* absent */ }

  for (const [key, yaml] of Object.entries(expected)) {
    let actual = null;
    try { actual = readFileSync(fileFor(key), 'utf8'); } catch { /* absent */ }
    if (actual !== yaml) drift.push(key.endsWith('.env') ? key : `${key}.yml`);
  }
  for (const f of existing) {
    if (!expected[f.replace(/\.yml$/, '')]) drift.push(`${f} (stale — no such failure domain)`);
  }
  return { same: drift.length === 0, drift, expected };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { same, drift, expected } = checkCompose();
  if (process.argv.includes('--check')) {
    if (same) { console.log(`compose files up to date: ${OUTPUT_DIR}`); process.exit(0); }
    console.error(`compose DRIFT (${drift.join(', ')}): run npm run node:render`);
    process.exit(1);
  }
  mkdirSync(OUTPUT_DIR, { recursive: true });
  for (const f of readdirSync(OUTPUT_DIR).filter((x) => x.endsWith('.yml'))) {
    if (!expected[f.replace(/\.yml$/, '')]) rmSync(resolve(OUTPUT_DIR, f));
  }
  for (const [key, yaml] of Object.entries(expected)) writeFileSync(fileFor(key), yaml);
  console.log(`wrote ${Object.keys(expected).length} compose file(s) to ${OUTPUT_DIR}`);
  for (const key of Object.keys(expected)) console.log(`  ${key.endsWith('.env') ? key : `${key}.yml`}`);
}
