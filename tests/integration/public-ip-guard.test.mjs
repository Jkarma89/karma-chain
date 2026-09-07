// T062 / V-07：`public-ip` 配错时必须明确报错，而不是表现为随机的连接失败。
//
// 为什么检查落在宿主侧的 devnet-start 而不是容器入口：
// 节点用 `--public-ip` 向对等节点通告自己的地址，而容器处在 NAT 之后 —— 它看到的是容器网段地址，
// **看不到宿主的局域网地址**，因此容器内无从判断"通告出去的那个地址是不是本机的"。
// 配错时的实际症状（V-07）：节点照常启动、日志无任何异常，只是对等节点连不上它；
// 在 5 台机器的形态下表现为"某一个边界莫名不参与共识"。这正是要提前拦住的。
//
// 本测试直接跑 scripts/devnet-start.sh，用一份临时生成的 active.env（KARMACHAIN_ENV_FILE 接缝）
// 把生效形态指向跨机拓扑，避免为了测一个守卫而切换真实的 activeDeployment。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { networkInterfaces } from 'node:os';
import { loadProtocol, deriveTopology, REPO_ROOT } from '../../tools/protocol/load.mjs';

const p = loadProtocol();
const lanName = Object.keys(p.topology.deployments)
  .find((k) => p.topology.deployments[k].failureDomains.length > 1);

const localIps = new Set(
  Object.values(networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address),
);

const lan = lanName
  ? deriveTopology({ ...p, topology: { ...p.topology, activeDeployment: lanName } })
  : null;
// 本机对应的边界（若在拓扑内）与不对应的边界
const selfDomain = lan?.failureDomains.find((d) => localIps.has(d.address));
const otherDomains = (lan?.failureDomains ?? []).filter((d) => !localIps.has(d.address));

/** 把跨机形态写成一份临时 active.env —— 字段与 render-compose 的 activeEnvText 保持一致。 */
function stageEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'kc-env-'));
  const file = join(dir, 'active.env');
  const domains = lan.failureDomains.map((d) => d.id);
  writeFileSync(file, [
    `KARMACHAIN_DEPLOYMENT=${lanName}`,
    `KARMACHAIN_DOMAINS="${domains.join(' ')}"`,
    `KARMACHAIN_DEFAULT_DOMAIN=${domains[0]}`,
    `KARMACHAIN_RPC_PORT=${p.endpoints.hostRpcPort}`,
    `KARMACHAIN_RPC_PATH=${p.endpoints.rpcPath}`,
    `KARMACHAIN_CHAIN_ID_HEX=0x${p.chain.chainId.toString(16)}`,
    `KARMACHAIN_NODE_IDS="${lan.topologyNodes.map((n) => n.id).join(' ')}"`,
    `KARMACHAIN_VALIDATOR_IDS="${lan.topologyNodes.filter((n) => n.role === 'l1-validator').map((n) => n.id).join(' ')}"`,
    `KARMACHAIN_MAX_OFFLINE_VALIDATORS=${lan.faultTolerance.maxOfflineValidators}`,
    `KARMACHAIN_DOMAIN_COUNT=${lan.failureDomains.length}`,
    `KARMACHAIN_DOMAIN_ADDRESSES="${lan.failureDomains.map((d) => `${d.id}=${d.address}`).join(' ')}"`,
    '',
  ].join('\n'));
  return file;
}

/** 跑一次 devnet-start.sh，返回退出码与合并输出。 */
function runStart(domain, envFile) {
  try {
    const stdout = execFileSync('sh', ['scripts/devnet-start.sh'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, KARMACHAIN_ENV_FILE: envFile, KARMACHAIN_DOMAIN: domain },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('V-07 public-ip 与本机地址不符时明确失败（T062）', {
  skip: lanName ? undefined : '唯一事实来源中没有多边界部署形态',
}, () => {
  const envFile = lanName ? stageEnv() : null;

  test('声明地址不属于本机的边界 → 退出码 13 且指出三种修正方式', () => {
    assert.ok(otherDomains.length, '跨机拓扑里应当存在不对应本机的边界');
    const dom = otherDomains[0];
    const r = runStart(dom.id, envFile);
    assert.equal(r.code, 13, `期望退出码 13，实际 ${r.code}\n${r.out}`);
    assert.match(r.out, /本机不是故障边界/);
    assert.ok(r.out.includes(dom.address), `报错应指出声明的地址 ${dom.address}`);
    assert.match(r.out, /KARMACHAIN_DOMAIN=/, '应给出"改跑本机对应边界"的修正方式');
    assert.match(r.out, /KARMACHAIN_ADDRESS_OVERRIDE=/, '应给出"本机地址变了"的修正方式');
    assert.match(r.out, /protocol\.json/, '应给出"长期改变"的修正方式');
  });

  test('每一个不属于本机的边界都被拦下 —— 拿错边界 id 不会静默启动', () => {
    const missed = [];
    for (const dom of otherDomains) {
      const r = runStart(dom.id, envFile);
      if (r.code !== 13) missed.push(`${dom.id}(${dom.address}) → 退出码 ${r.code}`);
    }
    assert.deepEqual(missed, [], `以下边界未被拦下：\n  ${missed.join('\n  ')}`);
  });

  test('本机对应的边界不被该守卫拦下', { skip: selfDomain ? undefined : '本机不在跨机拓扑内' }, () => {
    // 只断言"没有被这个守卫拦住"。后续流程（compose up / 等待就绪）不在本测试范围内 ——
    // 本机此刻跑的是单机形态，跨机形态的容器并不该在这里被拉起。
    const r = runStart(selfDomain.id, envFile);
    assert.doesNotMatch(r.out, /本机不是故障边界/, `本机确实是 ${selfDomain.id}(${selfDomain.address})，不应被拦下\n${r.out}`);
    assert.notEqual(r.code, 13, `退出码不应为 13\n${r.out}`);
  });

  test('单边界形态不做该核对 —— 127.0.0.1 不是网卡地址，核对只会误报', () => {
    // 真实的 active.env（activeDeployment=local，KARMACHAIN_DOMAIN_COUNT=1）
    const r = runStart(p.topology.activeDeployment, join(REPO_ROOT, 'docker/compose/active.env'));
    assert.doesNotMatch(r.out, /本机不是故障边界/);
    assert.notEqual(r.code, 13);
  });
});
