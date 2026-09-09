// T090：补回 001 退役 e2e 丢失的覆盖 —— `devnet-start` 的**退出码 11（宿主端口冲突）与 20（超时）**。
//
// 001 的 `tests/e2e/failure-classification.test.mjs` 覆盖过这两条，但它驱动的是单容器架构，
// 已于 T052 退役。002 的 `tests/integration/node-runtime.test.mjs` 只覆盖了**节点级**的 10 与 12
// （容器入口的启动期校验），而 11 与 20 是**脚本级**的判断，一直没有测试。
//
// 契约见 specs/001-local-avalanche-devnet/contracts/cli-interface.md：
//   11 = 宿主端口冲突（configuration 类）
//   20 = 启动失败 / 超时（node 类）
// 两者都必须给出**可执行的信息**，而不只是一个非零退出码。
//
// ## 怎么触发这两条（都踩过坑，记下来）
//
// **11：必须由另一个容器占端口，宿主进程占不出来。** 实测：Node 起一个 server 占住
// 宿主 RPC 端口之后，`docker compose up -d rpc` **依然成功** —— Docker Desktop 的端口发布
// 走它自己的代理（WSL2/vpnkit），不与宿主套接字争用。更糟的是那样测会**假成功**：
// squatter 接受 TCP 连接却不回 HTTP，脚本的就绪轮询一直等到自己超时，
// 收到的退出码是 null（被测试超时杀掉）而不是 11。改用容器占端口后，compose 如实报
// `port is already allocated`。
//
// **20：不能靠"停掉代理再用 1 秒超时"触发。** nginx 秒起，第一次轮询就 READY 了。
// 而停掉**整条链**会让 `compose up -d` 卡在 Primary 的 `service_healthy` 上约两分钟 ——
// 那段时间不受 `KARMACHAIN_STARTUP_TIMEOUT` 管（它只管轮询循环）。
// 因此改用 `KARMACHAIN_ENV_FILE` 接缝：给一份 RPC 端口指向无人服务之处的 env，
// 于是容器照常起、轮询永远不成功，1 秒后如实退出 20。测的仍是契约本身。
//
// **本测试是破坏性的**：会短暂占用宿主 RPC 端口并停掉 RPC 代理。因此默认跳过，
// 须显式 `KARMACHAIN_ALLOW_DISRUPTIVE=1`（与 `tests/integration/verify-negative.test.mjs` 同一约定）。
// 跑完把开发网恢复到测试前的状态。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { REPO_ROOT } from '../../tools/protocol/load.mjs';

const ENV_PATH = resolve(REPO_ROOT, 'docker/compose/active.env');
const ENV_RAW = readFileSync(ENV_PATH, 'utf8');
const env = Object.fromEntries([...ENV_RAW.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)]
  .map(([, k, v]) => [k, v.replace(/^"|"$/g, '')]));

const RPC_PORT = Number(env.KARMACHAIN_RPC_PORT);
// 取**生效的**边界，不是 active.env 里的默认值：跨机形态下每台机器用 KARMACHAIN_DOMAIN
// 指定自己那一个，而 DEFAULT_DOMAIN 是全局的同一个值（win-1）。在别的机器上按默认值
// 拼出来的 compose 文件与 rpc 容器名都是**别人的**。win-1 上两者相同所以一直没暴露。
const DOMAIN = process.env.KARMACHAIN_DOMAIN || env.KARMACHAIN_DEFAULT_DOMAIN;
const COMPOSE_FILE = `docker/compose/${env.KARMACHAIN_DEPLOYMENT}-${DOMAIN}.yml`;
const SQUATTER = 'kc-t090-port-squatter';

const SKIP = process.env.KARMACHAIN_ALLOW_DISRUPTIVE === '1'
  ? undefined
  : '破坏性测试：会占用宿主 RPC 端口并停掉 RPC 代理。设 KARMACHAIN_ALLOW_DISRUPTIVE=1 后运行。';

const docker = (...args) => {
  try {
    execFileSync('docker', args, { cwd: REPO_ROOT, encoding: 'utf8', timeout: 300_000, stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch { return false; }
};
const compose = (...args) => docker('compose', '-f', COMPOSE_FILE, ...args);

/** 跑 devnet-start，返回退出码与合并输出。超时给到脚本自身超时的两倍以上，避免把"被杀"当成结论。 */
function runStart(extraEnv = {}) {
  const r = spawnSync('sh', ['scripts/devnet-start.sh'], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 420_000,
    env: { ...process.env, ...extraEnv },
  });
  return { code: r.status, signal: r.signal, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('T090 —— devnet-start 的退出码 11 与 20', { skip: SKIP }, () => {
  before(() => { assert.ok(compose('ps'), '开发网应已建立 —— 先跑 scripts/devnet-bootstrap 与 devnet-start'); });

  after(() => {
    docker('rm', '-f', SQUATTER);
    runStart();   // 无论成败都把链放回就绪
  });

  test('宿主 RPC 端口被另一个容器占用 → 退出码 11，configuration 类，并指出端口号', () => {
    // 先停代理，否则 devnet-start 的幂等检查会直接返回 0（RPC 仍在应答）
    docker('rm', '-f', SQUATTER);   // 清掉上一次可能残留的同名容器
    // **删除**代理容器，而不是 stop。用 stop 不足以触发端口冲突：实测代理容器曾处于
    // "Running 但 PORTS 只列出容器内端口、未发布到宿主" 的状态，compose 判断配置未变、
    // 不重建也不绑端口，于是冲突根本不发生 —— 用例退化成"等 300 秒然后报 20"，
    // 看起来像脚本的分类逻辑错了，实际是前置条件没成立。删掉容器才能强制它重建并绑定。
    docker('rm', '-f', `karmachain-rpc-${DOMAIN}`);
    assert.ok(docker('run', '-d', '--name', SQUATTER, '-p', `${RPC_PORT}:80`, 'nginx:alpine'),
      '应能起一个占端口的容器');
    try {
      // 前置条件显式验证：占端口的必须是我们的 squatter，且代理容器必须不存在
      const holders = execFileSync('docker', ['ps', '--format', '{{.Names}} {{.Ports}}'], { encoding: 'utf8' })
        .split('\n').filter((l) => l.includes(`:${RPC_PORT}->`));
      assert.ok(holders.some((l) => l.startsWith(SQUATTER)),
        `占端口的容器未就位，当前占 ${RPC_PORT} 的是：${holders.join(' / ') || '（无）'}`);
      assert.ok(!docker('inspect', `karmachain-rpc-${DOMAIN}`),
        '代理容器必须已删除，否则 compose 不会重建它、也就不会尝试绑端口');

      const r = runStart();
      assert.equal(r.code, 11, `期望退出码 11，实际 ${r.code}（signal ${r.signal}）\n${r.out}`);
      assert.match(r.out, /category: configuration/, '端口冲突属 configuration 类');
      assert.ok(r.out.includes(String(RPC_PORT)), `报错须指出是哪个端口\n${r.out}`);
      // 底层原因也应透出，否则运维不知道是谁占的
      assert.match(r.out, /port is already allocated|address already in use|bind/i,
        '应保留 docker 的原始错误，便于查是谁占了端口');
    } finally {
      docker('rm', '-f', SQUATTER);
    }
  });

  test('超时未就绪 → 退出码 20，node 类，并指出可调的开关', () => {
    // RPC 端口指向无人服务之处：容器照常起，就绪轮询永不成功
    const dir = mkdtempSync(join(tmpdir(), 'kc-t090-'));
    const file = join(dir, 'active.env');
    writeFileSync(file, ENV_RAW.replace(/^KARMACHAIN_RPC_PORT=.*$/m, 'KARMACHAIN_RPC_PORT=18545'));

    const r = runStart({ KARMACHAIN_ENV_FILE: file, KARMACHAIN_STARTUP_TIMEOUT: '1' });
    assert.equal(r.code, 20, `期望退出码 20，实际 ${r.code}（signal ${r.signal}）\n${r.out}`);
    assert.match(r.out, /category: node/, '启动超时属 node 类');
    assert.match(r.out, /KARMACHAIN_STARTUP_TIMEOUT/, '须指出可调的开关，而不是让人去翻脚本');
  });

  test('恢复：正常启动回到就绪', () => {
    const r = runStart();
    assert.equal(r.code, 0, `恢复启动应成功\n${r.out}`);
    assert.match(r.out, /READY|已在运行/);
  });
});
