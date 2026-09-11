// 代理的健康探测**不接触上游** —— 用一个上游全是黑洞的临时 nginx 来证明。
//
// ## 为什么要这样证明
//
// 静态守卫（tests/unit/proxy-health-boundaries.test.mjs）能断言配置里那个块没有
// `proxy_pass`。但"没有 proxy_pass"与"这个请求真的不会碰上游"之间还差一步 ——
// nginx 的 location 匹配优先级、catch-all 的抢占、将来某个"顺手改进"，
// 都可能让实际行为与配置的字面意思分开。
//
// 所以这里起一个**真的 nginx**，喂给它生成的配置，但把全部上游换成黑洞
// （一个确定关闭的端口）。然后看两件事：
//
//   ① 探测位置仍然 **200** —— 它由 nginx 自己应答，上游死活与它无关（契约 C-5）
//   ② 真实 RPC 路径 **5xx** —— 上游确实是死的，不是我把黑洞配错了（这是①的对照组）
//
// **②是①的一半价值所在。** 只验①的话，"探测 200"可能只是因为黑洞其实是通的 ——
// 那样这条测试就成了一个不会变红的守卫，而本项目已经在三处栽过那个形状。
//
// ## 这条测试守的是 2026-09-10 那个缺陷
//
// 当时代理的 healthcheck 打的是 avalanchego 的**综合**健康位 `/ext/health`，
// 两个 Primary 一停它就返回 503；而这个请求经由代理自己打到上游，
// nginx 把 503 计为上游失败（`proxy_next_upstream … http_503`），
// `max_fails=1 fail_timeout=60s` 一次就关 60 秒，`proxy_next_upstream_tries 5`
// 让同一个探测毒遍五个上游，10 秒的探测间隔又短于惩罚期 ——
// 于是**真实客户端流量一起吃 502，而链好着**。
//
// 修法是去掉病因：探测不再接触上游。本测试就是那句"不再接触"的证据。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { REPO_ROOT, loadProtocol } from '../../tools/protocol/load.mjs';
import { PROXY_PROBE_PATH } from '../../tools/protocol/render-rpc-proxy.mjs';

const p = loadProtocol();
const IN_CONTAINER_PORT = p.endpoints.hostRpcPort;
const RPC_PATH = `/ext/bc/${p.chain.blockchainName}${p.endpoints.rpcPath.replace(/^\/ext\/bc\/[^/]+/, '')}`;

const sh = (...args) => spawnSync(args[0], args.slice(1), { encoding: 'utf8', shell: false });
const docker = (...args) => {
  const r = sh('docker', ...args);
  return r.status === 0 ? (r.stdout ?? '').trim() : null;
};

const dockerAvailable = docker('version', '--format', '{{.Server.Version}}') !== null;
// 镜像必须已在本地 —— 本套件不去联网拉镜像（离线环境里那会变成一次超时而不是一次跳过）
const imageLocal = dockerAvailable && docker('image', 'inspect', 'nginx:alpine') !== null;

const SKIP = !dockerAvailable
  ? 'docker 不可用（可能正在容器内运行）。配置层面的判据由 tests/unit/proxy-health-boundaries.test.mjs 覆盖；'
    + '本套件证明的是运行时行为，只在宿主有 docker 时才有意义。'
  : !imageLocal
    ? 'nginx:alpine 不在本地镜像库里。本套件刻意不联网拉镜像 —— 先 docker pull nginx:alpine。'
    : undefined;

/** 一个确定关闭的端口。取 1 是因为它不在任何协议参数里，也几乎不可能被占用。 */
const BLACK_HOLE_PORT = 1;

let dir;
let name;
let hostPort;

const startBlackHoleProxy = (deployment) => {
  dir = mkdtempSync(join(tmpdir(), 'km-proxy-health-'));
  const src = readFileSync(resolve(REPO_ROOT, 'blockchain', 'nodes', deployment, 'rpc-proxy.conf'), 'utf8');
  // 只换 upstream 的后端地址，其余**一个字符不动** —— 换多了就不是在测生成的那份配置了
  const conf = src.replace(
    /^(\s*)server\s+\S+:\d+\s+(max_fails.*)$/gm,
    `$1server 127.0.0.1:${BLACK_HOLE_PORT} $2`,
  );
  const replaced = (conf.match(new RegExp(`server 127\\.0\\.0\\.1:${BLACK_HOLE_PORT} max_fails`, 'g')) ?? []).length;
  assert.ok(replaced >= 1,
    `没有替换掉任何上游地址 —— 黑洞没造出来，后面两条断言都会变成假绿灯。\n`
    + '  （生成的 rpc-proxy.conf 里 upstream server 行的写法可能变了，请同步本处的正则。）');

  const confPath = join(dir, 'karmachain.conf');
  writeFileSync(confPath, conf);

  name = `km-proxy-health-test-${process.pid}`;
  docker('rm', '-f', name);
  // -p 0: 让 docker 挑一个空闲宿主端口，避免与真实入口或别的测试撞车
  const id = docker('run', '-d', '--name', name,
    '-p', `0:${IN_CONTAINER_PORT}`,
    '-v', `${confPath}:/etc/nginx/conf.d/karmachain.conf:ro`,
    'nginx:alpine');
  assert.ok(id, '临时 nginx 起不来');

  const mapping = docker('port', name, `${IN_CONTAINER_PORT}/tcp`) ?? '';
  const m = mapping.match(/:(\d+)\s*$/m);
  assert.ok(m, `拿不到映射出来的宿主端口（docker port 输出：${mapping}）`);
  hostPort = Number(m[1]);
};

const get = async (path, init) => {
  for (let i = 0; i < 25; i += 1) {
    try {
      return await fetch(`http://127.0.0.1:${hostPort}${path}`, { signal: AbortSignal.timeout(8000), ...init });
    } catch {
      await new Promise((r) => setTimeout(r, 200));   // nginx 刚起来，端口可能还没监听
    }
  }
  throw new Error(`连不上临时代理 127.0.0.1:${hostPort}${path}`);
};

describe('代理的健康探测不接触上游（契约 C-1 / C-2 / C-5）', { skip: SKIP }, () => {
  before(() => startBlackHoleProxy('lan'));
  after(() => {
    if (name) docker('rm', '-f', name);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('对照组：上游确实是死的 —— 真实 RPC 路径返回 5xx', async () => {
    const r = await get(RPC_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
    });
    assert.ok(r.status >= 500,
      `真实 RPC 路径返回了 ${r.status}，而上游应当全是黑洞。\n`
      + '  **这一条是下面那条的对照组**：若黑洞其实是通的，"探测 200"就不能说明任何事 ——\n'
      + '  那样这套测试会变成一个不会变红的守卫。');
  });

  test(`探测位置 ${PROXY_PROBE_PATH} 仍然 200 —— 上游死活与它无关`, async () => {
    const r = await get(PROXY_PROBE_PATH);
    assert.equal(r.status, 200,
      `探测位置返回了 ${r.status}。上游全死时它**应当**仍是 200 ——\n`
      + '  代理进程活着、配置解析通过、端口在监听，它确实在正常履行职责。\n'
      + '  「链能不能用」由面板与 devnet-verify 回答，不由容器健康位回答（FR-002 / FR-034）。');
    const body = (await r.text()).trim();
    assert.ok(body.length > 0 && body.length < 64,
      `探测返回的内容不像 nginx 自己的应答（${JSON.stringify(body.slice(0, 80))}）——\n`
      + '  若它是一段 JSON-RPC 或 avalanchego 的 404 页面，说明请求其实被转发出去了。');
  });

  test('容器内跑真正的 healthcheck 命令：退出码 0', () => {
    const r = sh('docker', 'exec', name, 'sh', '-c',
      `wget -q -O - -T 5 http://127.0.0.1:${IN_CONTAINER_PORT}${PROXY_PROBE_PATH}`);
    assert.equal(r.status, 0,
      `healthcheck 命令退出码 ${r.status}（stderr: ${(r.stderr ?? '').trim()}）。\n`
      + '  这是 compose 里那条 test: 的原样 —— 它退出非 0 就意味着容器会被判 unhealthy。');
  });

  test('探测不写访问日志 —— 每 10 秒一条会把真正的异常淹掉', () => {
    const logs = docker('logs', name) ?? '';
    assert.ok(!logs.includes(PROXY_PROBE_PATH),
      `代理日志里出现了探测条目：\n  ${logs.split('\n').filter((l) => l.includes(PROXY_PROBE_PATH)).slice(0, 3).join('\n  ')}\n`
      + '  探测每 10 秒一次，写日志会把真正要看的东西挤出去（`access_log off`）。');
  });
});
