// T091：补回 001 退役 e2e 丢失的覆盖之二 —— **reset → bootstrap → start 的完整往返**。
//
// 001 的 `tests/e2e/reset-recreate.test.mjs` 覆盖过"reset 后重新部署"，但 002 的 reset 语义已变
// （T037）：删卷之后**必须重新建链**，因为 Subnet 与 Blockchain 是 P 链上的交易，只存在于节点
// 数据库里 —— 空卷上没有那条链（实测：`platform.getSubnets` 只返回 Primary Network，
// 别名路径 404）。因此这是新写的，不是移植。
//
// 本测试要证明三件事：
//   1. **reset 之后 start 会失败并给出正确的指引**（而不是起一条没有 L1 的链）
//   2. bootstrap 是**确定性**的：重建后 SubnetID / BlockchainID / 创世哈希与制品逐字相同
//      （研究 R-04 的核心结论 —— 它使制品可以被漂移测试保护）
//   3. 往返之后 `devnet-verify` 14 项全通，且高度从创世重新计数
//
// **本测试销毁全链状态**，耗时数分钟。因此默认跳过，须显式 `KARMACHAIN_ALLOW_DESTRUCTIVE=1`。
// 它与 `KARMACHAIN_ALLOW_DISRUPTIVE` 是两个不同的开关：后者只是打断服务，本测试**丢数据**。
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT, loadProtocol } from '../../tools/protocol/load.mjs';

const IDENTITY_PATH = resolve(REPO_ROOT, 'blockchain/chain-identity/karmachain.identity.json');
const GENESIS_HASH_PATH = resolve(REPO_ROOT, 'blockchain/genesis/karmachain.genesis.hash');

// 第二道闸门：**跨机形态下重新建链会废掉整套部署**，光有 ALLOW_DESTRUCTIVE 不够。
//
// 重新建链会重写 `blockchain/chain-identity/primary-network.genesis.json`，而 Primary Network
// 创世**嵌入建链时刻**、不可复现（ADR-0009）。本机拿到新的那份之后，其余机器上的节点
// 仍持有旧的 —— 它们下次启动会以 `db contains invalid genesis hash` 拒绝启动，
// 整套部署必须从分发那一步重做。SubnetID／BlockchainID 是确定性的（本测试正是要断言这点），
// 但那不足以救回来：不确定的那一半足以让节点起不来。
//
// 2026-09-09 加这道闸门：当时 5 台机器的 lan 形态正在运行，而这个测试只看
// ALLOW_DESTRUCTIVE 一个开关 —— 谁在跑完整 e2e 时顺手设上它，就会毁掉部署。
const domainCount = Number(
  (readFileSync(resolve(REPO_ROOT, 'docker/compose/active.env'), 'utf8')
    .match(/^KARMACHAIN_DOMAIN_COUNT=(\d+)/m)?.[1]) ?? 1,
);

const SKIP = process.env.KARMACHAIN_ALLOW_DESTRUCTIVE !== '1'
  ? '销毁性测试：会删除全部链数据并重新建链（数分钟）。设 KARMACHAIN_ALLOW_DESTRUCTIVE=1 后运行。'
  : (domainCount > 1 && process.env.KARMACHAIN_ALLOW_CROSS_HOST_REBOOTSTRAP !== '1')
    ? `当前是跨机形态（${domainCount} 个故障边界）。重新建链会重写不可复现的 Primary Network 创世，`
      + '其余机器上的节点下次启动会以 db contains invalid genesis hash 拒绝启动 —— 整套部署要重做。'
      + ' 确实要在跨机形态下做这件事，再加 KARMACHAIN_ALLOW_CROSS_HOST_REBOOTSTRAP=1。'
    : undefined;

/** 跑一个薄封装脚本。两个脚本都是非交互的，无需喂确认。 */
const sh = (script, { args = [], env: extraEnv = {}, timeout = 900_000 } = {}) => {
  const r = spawnSync('sh', [script, ...args], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout,
    env: { ...process.env, ...extraEnv },
  });
  return { code: r.status, signal: r.signal, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

// 端点从唯一事实来源派生，不写死 —— 端口与路径都是协议参数（SC-007）
// 功能 005：部署描述已分家，这里要的是**合并视图**（`endpoints` 现住在 deployment.json）。
// 读协议文件原文会静默得到 undefined —— 拼出的 URL 连不上，而错因看起来像「链挂了」。
const protocol = loadProtocol();
const RPC_URL = `http://${protocol.endpoints.publishedHosts[0]}:${protocol.endpoints.hostRpcPort}${protocol.endpoints.rpcPath}`;

const rpc = async (method, params = []) => {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
};

describe('T091 —— reset → bootstrap → start 往返', { skip: SKIP }, () => {
  // 往返前的制品：确定性断言的基准。它们在仓库里，reset 不会动它们。
  let before_;

  before(() => {
    before_ = {
      identity: readJson(IDENTITY_PATH),
      genesisHash: readFileSync(GENESIS_HASH_PATH, 'utf8').trim(),
    };
    assert.ok(before_.identity.blockchainId, '往返前应已有建链制品');
  });

  test('reset 删除全部节点卷', () => {
    const r = sh('scripts/devnet-reset.sh');
    assert.equal(r.code, 0, `reset 应成功\n${r.out}`);
  });

  test('reset 之后直接 start 会失败，并指引去 bootstrap（而不是起一条没有 L1 的链）', () => {
    const r = sh('scripts/devnet-start.sh', { env: { KARMACHAIN_STARTUP_TIMEOUT: '60' } });
    assert.notEqual(r.code, 0, `空卷上不该启动成功\n${r.out}`);
    assert.match(r.out, /bootstrap/i,
      `报错必须指向 bootstrap —— 空卷上没有那条链（R-04）。实际输出：\n${r.out}`);
    // 而且必须**快速**失败。此前这条路径会等满就绪超时才给一句"未就绪"，毫无指向性；
    // 现在 devnet-start 在 compose up 之后直接问 P 链（实测 3 秒）。
    assert.match(r.out, /P 链上没有/, `应指出根因是 P 链上没有那条链：\n${r.out}`);
    assert.match(r.out, /devnet-stop/, '应提示先 stop —— 否则紧接着的 bootstrap 会因节点在跑而拒绝');
  });

  test('bootstrap 重新建链，且产出与原制品**逐字相同**（确定性，R-04）', () => {
    // 上一步失败后容器仍在运行（compose up 已成功，是守卫拦下的），建链要独占那些卷
    const stop = sh('scripts/devnet-stop.sh');
    assert.equal(stop.code, 0, `stop 应成功\n${stop.out}`);

    const r = sh('scripts/devnet-bootstrap.sh', { args: ['--force'] });
    assert.equal(r.code, 0, `bootstrap 应成功\n${r.out.slice(-3000)}`);

    const after = readJson(IDENTITY_PATH);
    assert.equal(after.subnetId, before_.identity.subnetId, 'SubnetID 应当可复现');
    assert.equal(after.blockchainId, before_.identity.blockchainId, 'BlockchainID 应当可复现');
    assert.deepEqual(
      after.bootstrapValidators.map((v) => v.nodeID).sort(),
      before_.identity.bootstrapValidators.map((v) => v.nodeID).sort(),
      '引导验证者集合应当不变（身份来自仓库里的密钥，R-03）',
    );
    // 创世哈希是第一类事实的产物，重建不该改变它
    assert.equal(readFileSync(GENESIS_HASH_PATH, 'utf8').trim(), before_.genesisHash,
      '创世哈希不该因重建而改变');
  });

  test('start 之后链可用，且高度从创世重新计数', async () => {
    const r = sh('scripts/devnet-start.sh');
    assert.equal(r.code, 0, `start 应成功\n${r.out.slice(-2000)}`);

    const chainId = await rpc('eth_chainId');
    assert.equal(Number(chainId), protocol.chain.chainId);

    const height = Number(await rpc('eth_blockNumber'));
    assert.ok(height >= 0 && height < 20,
      `往返后高度应从创世附近重新开始，实际 ${height} —— 若很大说明卷没被真正删除`);
  });

  test('devnet-verify 14 项全通', () => {
    const r = sh('scripts/devnet-verify.sh');
    assert.equal(r.code, 0, `verify 应全通\n${r.out.slice(-2500)}`);
    assert.match(r.out, /KarmaChain is READY/);
    assert.match(r.out, /0 failed/);
    assert.doesNotMatch(r.out, /\[SKIP\]/, '往返之后不该有降级为 SKIP 的检查');
  });
});
