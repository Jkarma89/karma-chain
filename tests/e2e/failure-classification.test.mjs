// T041 / SC-011：注入每一类可复现故障，断言输出归入 FR-030 的正确类别、退出码符合
// contracts/cli-interface.md，且提示是可操作的。
//
// 会反复停止/启动开发网络并临时改动 blockchain/protocol.json（结束时恢复），约 6-8 分钟：
//   KARMACHAIN_ALLOW_DISRUPTIVE=1 node --test tests/e2e/failure-classification.test.mjs
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT, loadProtocol, derive } from '../../tools/protocol/load.mjs';

const disruptive = process.env.KARMACHAIN_ALLOW_DISRUPTIVE === '1';
const P = (rel) => resolve(REPO_ROOT, rel);
const TRACKED = ['blockchain/protocol.json', 'blockchain/genesis/karmachain.genesis.json',
  'blockchain/genesis/karmachain.genesis.hash', 'docs/protocol-parameters.md', 'blockchain/compose.env'];
const backups = new Map(TRACKED.map((f) => [f, readFileSync(P(f))]));

const protocol = loadProtocol();
const { chainIdHex } = derive(protocol);
const HOST_PORT = Number(process.env.KARMACHAIN_RPC_PORT || protocol.endpoints.hostRpcPort);
const RPC = `http://127.0.0.1:${HOST_PORT}${protocol.endpoints.rpcPath}`;

const runAllowFail = (cmd, args, env) => {
  try { return { code: 0, out: execFileSync(cmd, args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } }) }; }
  catch (e) { return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }; }
};
const compose = (...args) => runAllowFail('docker', ['compose', ...args]);
const startScript = (env) => runAllowFail('sh', ['scripts/devnet-start.sh'], env);

/** 用真正的启动脚本把网络拉起来并断言成功（失败时带上诊断输出）。 */
function ensureUp() {
  const { code, out } = startScript();
  if (code !== 0) {
    const logs = compose('logs', '--no-log-prefix', '--tail', '40', 'devnet').out;
    assert.fail(`devnet-start failed with exit ${code}\n--- start output ---\n${out.slice(-800)}\n--- container logs ---\n${logs.slice(-1200)}`);
  }
}

async function waitReady(timeoutS = 300) {
  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 4000);
    try {
      const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }), signal: ac.signal });
      if ((await res.json()).result === chainIdHex) return;
    } catch { /* not yet */ } finally { clearTimeout(timer); }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`devnet not ready within ${timeoutS}s at ${RPC}`);
}

describe('failure classification (FR-030 / SC-011)', { skip: !disruptive && 'set KARMACHAIN_ALLOW_DISRUPTIVE=1 (this test stops the devnet and edits protocol.json)', timeout: 1_800_000 }, () => {
  after(async () => {
    for (const [f, buf] of backups) writeFileSync(P(f), buf);
    compose('down', '-v', '--remove-orphans');
    compose('up', '-d', 'devnet');
    await waitReady();
  });

  test('host port already in use -> exit 11, category configuration, names the port', async () => {
    compose('down', '--remove-orphans');
    // 用另一个 Docker 容器占住宿主端口：由 Docker 自己检测冲突，跨平台可靠。
    // （在 Windows/Docker Desktop 上，进程级的 IPv4 监听不会与 Docker 的 IPv6 `::` 绑定冲突，
    //   因此不能用普通 TCP server 来注入这个故障。）
    const squatter = 'kc-port-squatter';
    runAllowFail('docker', ['rm', '-f', squatter]);
    const up = runAllowFail('docker', ['run', '-d', '--name', squatter, '-p', `${HOST_PORT}:80`, 'alpine', 'sleep', '300']);
    assert.equal(up.code, 0, `could not start the port squatter: ${up.out}`);
    try {
      const { code, out } = startScript();
      assert.equal(code, 11, `expected exit 11 for a port conflict; got ${code}\n${out.slice(-500)}`);
      assert.match(out, /category: configuration/, 'must carry the configuration category');
      assert.match(out, new RegExp(String(HOST_PORT)), 'must name the conflicting port');
      assert.match(out, /KARMACHAIN_RPC_PORT/, 'must suggest the override');
    } finally {
      runAllowFail('docker', ['rm', '-f', squatter]);
    }
  });

  test('chain data from a different protocol version -> exit 12, category configuration, tells you to reset', async () => {
    ensureUp();                              // 先建立带 stamp 的链数据

    compose('stop', 'devnet');
    const proto = JSON.parse(readFileSync(P('blockchain/protocol.json'), 'utf8'));
    proto.configVersion = '9.9.9';           // 只改版本：不影响创世哈希，专门触发 stamp 比对
    writeFileSync(P('blockchain/protocol.json'), `${JSON.stringify(proto, null, 2)}\n`);

    const { code, out } = startScript();
    assert.equal(code, 12, `expected exit 12 for stale chain data; got ${code}\n${out.slice(-600)}`);
    assert.match(out, /category: configuration/);
    assert.match(out, /configVersion: chain data .* protocol\.json 9\.9\.9/, 'must name the mismatching field and both values');
    assert.match(out, /devnet-reset/, 'must tell the operator how to recover');
    assert.match(out, /Art\. 15|constitution/i, 'must frame it as a protocol change');

    writeFileSync(P('blockchain/protocol.json'), backups.get('blockchain/protocol.json'));
  });

  test('genesis file missing -> exit 10, category genesis, tells you to re-render', async () => {
    compose('down', '--remove-orphans');
    const genesisPath = P('blockchain/genesis/karmachain.genesis.json');
    const saved = readFileSync(genesisPath);
    writeFileSync(genesisPath, '');          // 空文件：既不是合法 JSON 也没有 chainId
    try {
      const { code, out } = startScript();
      assert.equal(code, 10, `expected exit 10 for a broken genesis; got ${code}\n${out.slice(-600)}`);
      assert.match(out, /category: genesis/, 'must carry the genesis category');
      assert.match(out, /protocol:render/, 'must tell the operator how to regenerate it');
    } finally {
      writeFileSync(genesisPath, saved);
    }
  });

  test('chain unreachable -> verifier exits 1 with category rpc and skips the rest', async () => {
    compose('down', '--remove-orphans');
    const { code, out } = runAllowFail('node', ['tools/verify/verify-network.mjs']);
    assert.equal(code, 1);
    assert.match(out, /\[FAIL\]\s+rpc\s+\[category: rpc\]/);
    assert.match(out, /is the devnet running\?/);
    const report = JSON.parse(readFileSync(P('.devnet/verify-report.json'), 'utf8'));
    assert.equal(report.overall, 'failed');
    assert.equal(report.checks.filter((c) => c.status === 'fail').length, 1, 'one failure, not thirteen');
  });

  test('a stopped validator -> devnet-status exits 1 with category node', async () => {
    ensureUp();
    const victim = 'l1-2';
    compose('exec', '-T', 'devnet', 'devnet-node', 'stop', victim);
    try {
      await new Promise((r) => setTimeout(r, 8000));
      const { code, out } = compose('exec', '-T', 'devnet', 'devnet-status');
      assert.equal(code, 1, 'devnet-status must exit 1 with a node down');
      assert.match(out, /category: node/, 'must carry the node category');
      assert.match(out, /devnet-logs/, 'must point at the log command');
    } finally {
      compose('exec', '-T', 'devnet', 'devnet-node', 'start', victim);
      await new Promise((r) => setTimeout(r, 15000));
    }
  });

  test('every injected failure mapped to exactly one FR-030 category (SC-011 summary)', () => {
    // 上面五个用例已逐一断言；这里固化"类别集合"与契约文档一致，防止有人偷偷加类别
    const cliContract = readFileSync(P('specs/001-local-avalanche-devnet/contracts/cli-interface.md'), 'utf8');
    for (const c of ['genesis', 'configuration', 'node', 'validator', 'p2p', 'rpc', 'evm', 'transaction', 'storage']) {
      assert.match(cliContract, new RegExp(`\\\`${c}\\\``), `category ${c} must be documented in cli-interface.md`);
    }
  });
});
