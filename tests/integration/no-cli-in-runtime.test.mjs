// T048 / quickstart 场景 H（FR-014、FR-015）：运行时路径彻底脱离 Avalanche CLI。
//
// 这组测试守的是本特性的结构性成果：编排工具**不在恢复路径上**。
// 它有两层：
//   1. 静态 —— 运行时镜像里根本没有 avalanche 可执行文件，且运行时代码不引用它
//   2. 动态 —— 全部节点在这样的镜像里正常起来，14 项验证通过
// 第 1 层是构成保证，比"我们保证不调用"这种约定强得多（研究 R-02）。
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { REPO_ROOT } from '../../tools/protocol/load.mjs';

const IMAGE = 'karmachain/node:local';

/**
 * 002 的运行时路径 —— 启动、停止、重启、观测一条已建好的链所经过的全部代码。
 * 建链（docker/bootstrap/）不在其中：CLI 允许出现在那里，且它跑完即退。
 */
const RUNTIME_DIRS = ['docker/node', 'tools/protocol', 'tools/verify', 'tools/inspect'];
const RUNTIME_SCRIPTS = [
  'devnet-start', 'devnet-stop', 'devnet-reset', 'devnet-node',
  'devnet-status', 'devnet-logs', 'devnet-verify', 'devnet-contracts',
].flatMap((n) => [`scripts/${n}.sh`, `scripts/${n}.ps1`]).concat(['scripts/_devnet-common.ps1']);

/**
 * 一次性动作专属，允许调用 CLI —— 它们都不在「启动一条已建好的链」的路径上。
 * 每一项都必须说得出为什么它是一次性的，否则就是在给例外开口子。
 */
const ONE_SHOT = {
  'docker/bootstrap/': '建链镜像：创建 Subnet 与 Blockchain，跑完即退',
  'docker/lib/avalanche.sh': 'CLI 调用的唯一封装点，只被建链镜像 source',
  'scripts/devnet-bootstrap': '建链的宿主入口',
  'tools/protocol/extract-vm-alloc.sh': '一次性 fixture 提取（001）：从 CLI 生成的链里取 ValidatorManager 分配，产出提交进仓库后不再运行',
};

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

function runtimeFiles() {
  const out = [];
  for (const d of RUNTIME_DIRS) {
    try { out.push(...walk(resolve(REPO_ROOT, d))); } catch { /* 目录可缺 */ }
  }
  for (const f of RUNTIME_SCRIPTS) {
    try { statSync(resolve(REPO_ROOT, f)); out.push(resolve(REPO_ROOT, f)); } catch { /* 文件可缺 */ }
  }
  return out
    .map((f) => relative(REPO_ROOT, f).replace(/\\/g, '/'))
    .filter((f) => !Object.keys(ONE_SHOT).some((b) => f.startsWith(b)));
}

const docker = (args) => {
  try {
    return { code: 0, out: execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (err) { return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }; }
};

describe('场景 H —— 运行时不含编排工具', () => {
  before(() => {
    if (docker(['image', 'inspect', IMAGE]).code !== 0) {
      assert.fail(`镜像 ${IMAGE} 不存在 —— 先运行 docker build -t ${IMAGE} -f docker/node/Dockerfile .`);
    }
  });

  test('节点镜像内不存在 avalanche 可执行文件', () => {
    const r = docker(['run', '--rm', '--entrypoint', 'sh', IMAGE, '-c', 'command -v avalanche || echo ABSENT']);
    assert.match(r.out, /ABSENT/, `镜像里不该有 avalanche：${r.out}`);
  });

  test('节点镜像的基底是官方 avalanchego，而不是 CLI 镜像', () => {
    const df = readFileSync(resolve(REPO_ROOT, 'docker/node/Dockerfile'), 'utf8');
    assert.match(df, /^FROM avaplatform\/avalanchego:/m);
    assert.ok(!/avalanche-cli/.test(df), '节点镜像不得以 CLI 镜像为基底');
  });

  test('运行时代码路径中没有任何 CLI 调用', () => {
    const offenders = [];
    for (const rel of runtimeFiles()) {
      const text = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
      // 只找**调用**：执行 avalanche 命令，或 source 那个封装 CLI 的库。
      // 注释里提到 CLI（解释为什么脱离它）是允许的，否则没法写清楚缘由。
      const lines = text.split(/\r?\n/);
      lines.forEach((line, i) => {
        const code = line.replace(/^\s*(#|\/\/).*$/, '');
        if (/\bav_[a-z_]+\s*\(?\)?/.test(code)
          || /(^|[;&|`$(\s])avalanche\s+(network|blockchain|subnet|key)\b/.test(code)
          || /source\s+.*avalanche\.sh|\.\s+.*avalanche\.sh/.test(code)) {
          offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 90)}`);
        }
      });
    }
    assert.deepEqual(offenders, [],
      `运行时路径不得调用 Avalanche CLI（建链除外）：\n${offenders.join('\n')}`);
  });

  test('运行时路径覆盖到了该覆盖的文件（防止断言因路径变动而空转）', () => {
    const files = runtimeFiles();
    assert.ok(files.length >= 15, `运行时文件只找到 ${files.length} 个，路径清单可能已过时`);
    assert.ok(files.some((f) => f === 'docker/node/entrypoint.sh'), '应当覆盖节点入口');
    assert.ok(files.some((f) => f === 'scripts/devnet-start.sh'), '应当覆盖启动脚本');
  });

  test('CLI 只出现在建链路径里', () => {
    const bootstrap = readFileSync(resolve(REPO_ROOT, 'docker/bootstrap/entrypoint.sh'), 'utf8');
    assert.match(bootstrap, /av_blockchain_create|av_network_start/,
      '建链入口应当确实在用 CLI —— 否则本组测试证明不了任何事');
  });
});
