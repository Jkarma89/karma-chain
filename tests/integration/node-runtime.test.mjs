// T029 / T030 / T031：节点运行时镜像的构成与启动期校验。
//
// 这些测试直接跑容器，但**不启动链** —— 每个用例都在 exec avalanchego 之前就有结论，
// 因此都是秒级的。这正是 FR-017 的要求：制品与密钥不同源必须在启动早期被拦下，
// 而不是表现为几分钟后的连接超时。
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadProtocol, REPO_ROOT } from '../../tools/protocol/load.mjs';

const IMAGE = 'karmachain/node:local';
const P = loadProtocol();
const NODE_ID = 'l1-1';

const docker = (args, opts = {}) => {
  try {
    return { code: 0, out: execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }) };
  } catch (err) {
    return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
};

/** 把一套完整配置复制到临时目录，便于逐项篡改。 */
function stageConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'kc-node-'));
  const cfg = join(dir, 'config');
  const keys = join(dir, 'keys');
  const data = join(dir, 'data');
  for (const d of [cfg, keys, data]) mkdirSync(d, { recursive: true });

  cpSync(resolve(REPO_ROOT, `blockchain/nodes/${P.topology.activeDeployment}/${NODE_ID}.flags.json`), join(cfg, 'flags.json'));
  cpSync(resolve(REPO_ROOT, `blockchain/nodes/${NODE_ID}.identity.json`), join(cfg, 'identity.json'));
  cpSync(resolve(REPO_ROOT, 'blockchain/chain-identity/karmachain.identity.json'), join(cfg, 'karmachain.identity.json'));
  cpSync(resolve(REPO_ROOT, 'blockchain/protocol.json'), join(cfg, 'protocol.json'));
  cpSync(resolve(REPO_ROOT, 'blockchain/genesis/karmachain.genesis.json'), join(cfg, 'karmachain.genesis.json'));
  cpSync(resolve(REPO_ROOT, 'blockchain/genesis/karmachain.genesis.hash'), join(cfg, 'karmachain.genesis.hash'));
  cpSync(resolve(REPO_ROOT, P.validators.nodes[0].keyDir), keys, { recursive: true });
  return { dir, cfg, keys, data };
}

/** 跑一次入口，覆盖 avalanchego 让它在校验通过后立刻退出（我们只验校验逻辑）。 */
function runEntrypoint({ cfg, keys, data }, { stub = true } = {}) {
  const args = ['run', '--rm', '--network', 'none',
    '-v', `${cfg}:/config:ro`, '-v', `${keys}:/keys:ro`, '-v', `${data}:/data`];
  if (stub) args.push('-e', 'AVALANCHEGO_BIN=/bin/true');
  args.push(IMAGE);
  return docker(args);
}

describe('T029 镜像构成', () => {
  before(() => {
    const probe = docker(['image', 'inspect', IMAGE]);
    if (probe.code !== 0) assert.fail(`镜像 ${IMAGE} 不存在 —— 先运行 docker build -t ${IMAGE} -f docker/node/Dockerfile .`);
  });

  test('镜像内不存在 Avalanche CLI —— FR-015 由构成静态保证', () => {
    const r = docker(['run', '--rm', '--entrypoint', 'sh', IMAGE, '-c',
      'command -v avalanche || echo ABSENT']);
    assert.match(r.out, /ABSENT/, `镜像里不该有 avalanche 可执行文件：${r.out}`);
  });

  test('subnet-evm 插件存在且版本正确', () => {
    const r = docker(['run', '--rm', '--entrypoint', 'sh', IMAGE, '-c',
      '/opt/subnet-evm/subnet-evm --version 2>&1 | head -1']);
    assert.equal(r.code, 0);
    assert.ok(r.out.includes(P.avalanche.subnetEvmVersion.replace(/^v/, '')),
      `插件版本应为 ${P.avalanche.subnetEvmVersion}，实际输出：${r.out.trim()}`);
  });

  test('avalanchego 二进制版本与 protocol.json 一致', () => {
    const r = docker(['run', '--rm', '--entrypoint', 'sh', IMAGE, '-c',
      '/avalanchego/build/avalanchego --version 2>&1 | head -1']);
    assert.ok(r.out.includes(P.avalanche.avalanchegoVersion.replace(/^v/, '')),
      `avalanchego 版本应为 ${P.avalanche.avalanchegoVersion}，实际：${r.out.trim()}`);
  });

  test('入口所需的工具齐备（jq / curl / sha256sum）', () => {
    const r = docker(['run', '--rm', '--entrypoint', 'sh', IMAGE, '-c',
      'for t in jq curl sha256sum bash; do command -v $t >/dev/null || echo MISSING:$t; done; echo DONE']);
    assert.ok(!r.out.includes('MISSING'), r.out);
  });
});

describe('T030 启动期校验', () => {
  let staged;
  before(() => { staged = stageConfig(); });

  test('完整配置下校验全部通过，进入 exec', () => {
    const r = runEntrypoint(staged);
    assert.equal(r.code, 0, `应当通过全部校验：\n${r.out}`);
    assert.match(r.out, /identity OK/);
    assert.match(r.out, /stamp written|stamp OK/);
    assert.match(r.out, /starting avalanchego/);
  });

  test('身份材料缺失 → 退出 10，且秒级失败', () => {
    const s = stageConfig();
    rmSync(join(s.keys, 'signer.key'));
    const t0 = Date.now();
    const r = runEntrypoint(s);
    assert.equal(r.code, 10, r.out);
    assert.match(r.out, /identity material missing/);
    assert.ok(Date.now() - t0 < 30_000, '必须在数秒内失败，而不是等待超时');
    rmSync(s.dir, { recursive: true, force: true });
  });

  test('密钥被换掉 → 退出 12，并指出是哪个文件', () => {
    const s = stageConfig();
    // 用另一个验证者的密钥冒充
    cpSync(resolve(REPO_ROOT, P.validators.nodes[1].keyDir, 'staker.crt'), join(s.keys, 'staker.crt'));
    const r = runEntrypoint(s);
    assert.equal(r.code, 12, r.out);
    assert.match(r.out, /staker\.crt/);
    assert.match(r.out, /different bootstraps/);
    rmSync(s.dir, { recursive: true, force: true });
  });

  test('制品与 protocol.json 版本不符 → 退出 12', () => {
    const s = stageConfig();
    const art = JSON.parse(readFileSync(join(s.cfg, 'karmachain.identity.json'), 'utf8'));
    art.vmVersion = 'v0.7.0';
    writeFileSync(join(s.cfg, 'karmachain.identity.json'), JSON.stringify(art, null, 2));
    const r = runEntrypoint(s);
    assert.equal(r.code, 12, r.out);
    assert.match(r.out, /vmVersion/);
    rmSync(s.dir, { recursive: true, force: true });
  });
});

describe('T031 出生证明（stamp）—— 001 FR-021 的语义不得回退', () => {
  test('空卷首次启动写入 stamp，再次启动比对通过', () => {
    const s = stageConfig();
    const first = runEntrypoint(s);
    assert.equal(first.code, 0, first.out);
    assert.match(first.out, /stamp written/);

    const second = runEntrypoint(s);
    assert.equal(second.code, 0, second.out);
    assert.match(second.out, /stamp OK/);
    rmSync(s.dir, { recursive: true, force: true });
  });

  test('configVersion 变更后重启 → 退出 12 且指出不符项', () => {
    const s = stageConfig();
    assert.equal(runEntrypoint(s).code, 0);

    const proto = JSON.parse(readFileSync(join(s.cfg, 'protocol.json'), 'utf8'));
    proto.configVersion = '9.9.9';
    writeFileSync(join(s.cfg, 'protocol.json'), JSON.stringify(proto, null, 2));

    const r = runEntrypoint(s);
    assert.equal(r.code, 12, r.out);
    assert.match(r.out, /configVersion: chain data .*, protocol\.json 9\.9\.9/);
    assert.match(r.out, /devnet-reset/, '必须给出可执行的出路');
    rmSync(s.dir, { recursive: true, force: true });
  });

  test('创世文件被改动 → 退出 12（genesisSha256 不符）', () => {
    const s = stageConfig();
    assert.equal(runEntrypoint(s).code, 0);

    const g = JSON.parse(readFileSync(join(s.cfg, 'karmachain.genesis.json'), 'utf8'));
    g.config.chainId = 20190;
    writeFileSync(join(s.cfg, 'karmachain.genesis.json'), JSON.stringify(g, null, 2));

    const r = runEntrypoint(s);
    assert.equal(r.code, 12, r.out);
    assert.match(r.out, /genesisSha256/);
    rmSync(s.dir, { recursive: true, force: true });
  });

  test('stamp 落在节点自己的卷里 —— 一个节点的旧数据不牵连其他节点', () => {
    const s = stageConfig();
    runEntrypoint(s);
    const stamp = JSON.parse(readFileSync(join(s.data, 'karmachain.stamp.json'), 'utf8'));
    assert.equal(stamp.configVersion, P.configVersion);
    assert.equal(stamp.chainId, P.chain.chainId);
    assert.equal(stamp.networkId, P.avalanche.networkId);
    assert.equal(stamp.blockchainName, P.chain.blockchainName);
    assert.match(stamp.genesisBlockHash, /^0x[0-9a-f]{64}$/);
    rmSync(s.dir, { recursive: true, force: true });
  });
});
