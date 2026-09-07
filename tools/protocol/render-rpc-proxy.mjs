// tools/protocol/render-rpc-proxy.mjs
//
// 生成 blockchain/nodes/<deployment>/rpc-proxy.conf —— 对外 RPC 入口的 nginx 配置。
//
// 按部署形态分目录的理由与 render-node-flags.mjs 相同：上游地址是形态相关的
// （local 是容器网段，lan 是各机器的局域网地址）。
//
// 为什么需要它（研究 R-05 的实测修正）：
// 对第三方公布的地址是 /ext/bc/karmachain/rpc，而 avalanchego 只在 /ext/bc/<blockchainID>/rpc
// 上注册路由。`--chain-aliases-file` 会被读进配置，但 **v1.14.1 不会据此注册 HTTP 路由**
// （实测：配置里有 chainAliases，别名路径仍然 404）—— 只有 admin.aliasChain 会，
// 而那是内存态，节点一重启就没了。
//
// 也就是说，001 公布的那个地址本身就依赖编排器：CLI 每次 network start 都重新调 admin API 建别名。
// 这正是 002 要消灭的隐式依赖，只是它藏在公开契约里。
//
// 代理是**无状态**的：不持有链数据、不参与共识、崩了重启即可，因此不在崩溃恢复路径上。
// 顺带两个收益：
//   1. 上游是**全部** L1 验证者（跨故障边界）—— RPC 入口不再随某一个验证者、
//      甚至某一台机器一起挂掉（US2 / US4）。每台机器都跑一份代理，各自都能对外服务。
//   2. Host 头由代理固定为 localhost —— 第三方不再需要"必须用 IP 不能用域名"
//
// 用法：node tools/protocol/render-rpc-proxy.mjs [--check]

import { writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { loadProtocol, deriveTopology, readJson, REPO_ROOT } from './load.mjs';

export const OUTPUT_DIR = resolve(REPO_ROOT, 'blockchain', 'nodes');
export const outputPathFor = (deployment) => resolve(OUTPUT_DIR, deployment, 'rpc-proxy.conf');
const IDENTITY_PATH = resolve(REPO_ROOT, 'blockchain', 'chain-identity', 'karmachain.identity.json');

export function renderRpcProxy(p = loadProtocol(), identity = readJson(IDENTITY_PATH), deploymentName) {
  const scoped = deploymentName
    ? { ...p, topology: { ...p.topology, activeDeployment: deploymentName } }
    : p;
  const d = deriveTopology(scoped);
  const validators = d.topologyNodes.filter((n) => n.role === 'l1-validator');
  if (!validators.length) throw new Error('topology has no l1-validator nodes to proxy to');

  const alias = identity.chainAlias;
  const bid = identity.blockchainId;
  const port = p.endpoints.hostRpcPort;

  const L = [];
  L.push('# GENERATED FROM blockchain/protocol.json by tools/protocol/render-rpc-proxy.mjs — DO NOT EDIT.');
  L.push('#');
  L.push(`# 把对外公布的 /ext/bc/${alias}/… 重写成 avalanchego 实际注册的 /ext/bc/<blockchainID>/…`);
  L.push('# 详见 tools/protocol/render-rpc-proxy.mjs 顶部说明与研究 R-05。');
  L.push('');
  // 本文件被 include 进 nginx 的 http 块（conf.d/*.conf），map 必须在这一层
  L.push('map $http_upgrade $connection_upgrade {');
  L.push('    default upgrade;');
  L.push("    ''      close;");
  L.push('}');
  L.push('');
  L.push('upstream karmachain_rpc {');
  // 客户端亲和：同一个客户端固定落到同一个验证者，避免"发完交易立刻读高度却读到旧视图"
  // （实测：轮询时 receipt 已返回 block 1，紧接着的 eth_blockNumber 从另一个节点读到 0）。
  // 该节点不可用时 ip_hash 仍会转到下一个 —— 亲和性与故障转移可以兼得。
  L.push('    ip_hash;');
  for (const v of validators) {
    L.push(`    server ${v.address}:${v.httpPort} max_fails=2 fail_timeout=10s;   # ${v.id}`);
  }
  L.push('}');
  L.push('');
  L.push('server {');
  L.push(`    listen ${port};`);
  L.push('    server_name _;');
  L.push('');
  L.push('    proxy_http_version 1.1;');
  L.push('    proxy_read_timeout 300s;');
  L.push('');
  L.push('    # 某个验证者不可用时自动换下一个 —— RPC 入口不随单个验证者一起挂掉');
  L.push('    proxy_next_upstream error timeout http_502 http_503 http_504;');
  L.push('');
  L.push(`    location /ext/bc/${alias}/ {`);
  L.push(`        rewrite ^/ext/bc/${alias}/(.*)$ /ext/bc/${bid}/$1 break;`);
  L.push('        proxy_pass http://karmachain_rpc;');
  L.push('        # WebSocket（/ext/bc/<alias>/ws）');
  L.push('        proxy_set_header Upgrade $http_upgrade;');
  L.push('        proxy_set_header Connection $connection_upgrade;');
  // nginx 的 proxy_set_header 不跨层合并：location 里只要出现一条，server 层的全部失效。
  // 因此 Host 必须在每个 location 内重复声明，否则发出去的是默认的 $proxy_host（上游名）。
  L.push('        # avalanchego 只放行 localhost 与 IP 字面量；由代理统一改写 Host，');
  L.push('        # 客户端用什么主机名都不再受影响。');
  L.push('        proxy_set_header Host "localhost";');
  L.push('    }');
  L.push('');
  L.push('    # 其余路径原样转发（/ext/health、/ext/info、blockchainID 全路径等）');
  L.push('    location / {');
  L.push('        proxy_pass http://karmachain_rpc;');
  L.push('        proxy_set_header Upgrade $http_upgrade;');
  L.push('        proxy_set_header Connection $connection_upgrade;');
  // nginx 的 proxy_set_header 不跨层合并：location 里只要出现一条，server 层的全部失效。
  // 因此 Host 必须在每个 location 内重复声明，否则发出去的是默认的 $proxy_host（上游名）。
  L.push('        # avalanchego 只放行 localhost 与 IP 字面量；由代理统一改写 Host，');
  L.push('        # 客户端用什么主机名都不再受影响。');
  L.push('        proxy_set_header Host "localhost";');
  L.push('    }');
  L.push('}');
  L.push('');
  return L.join('\n');
}

/** 全部部署形态的代理配置。 @returns {Record<string,string>} deployment → conf */
export function renderAllRpcProxies(p = loadProtocol(), identity = readJson(IDENTITY_PATH)) {
  const out = {};
  for (const name of Object.keys(p.topology.deployments)) out[name] = renderRpcProxy(p, identity, name);
  return out;
}

export function checkRpcProxy(p = loadProtocol(), identity = readJson(IDENTITY_PATH)) {
  const expected = renderAllRpcProxies(p, identity);
  const drift = [];
  for (const [name, want] of Object.entries(expected)) {
    let actual = null;
    try { actual = readFileSync(outputPathFor(name), 'utf8'); } catch { /* absent */ }
    if (actual !== want) drift.push(`${name}/rpc-proxy.conf`);
  }
  // 分目录之前的顶层残留
  try {
    readFileSync(resolve(OUTPUT_DIR, 'rpc-proxy.conf'), 'utf8');
    drift.push('rpc-proxy.conf (stale — 已按部署形态分目录)');
  } catch { /* absent — 正常 */ }
  return { same: drift.length === 0, drift, expected };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { same, drift, expected } = checkRpcProxy();
  if (process.argv.includes('--check')) {
    if (same) { console.log(`rpc proxy config up to date: ${OUTPUT_DIR}`); process.exit(0); }
    console.error(`rpc proxy config DRIFT (${drift.join(', ')}): run npm run node:render`);
    process.exit(1);
  }
  rmSync(resolve(OUTPUT_DIR, 'rpc-proxy.conf'), { force: true });
  for (const [name, conf] of Object.entries(expected)) {
    const path = outputPathFor(name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, conf);
    console.log(`wrote ${path}`);
  }
}
