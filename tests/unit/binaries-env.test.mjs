// docker/binaries.env 是版本锁定二进制的 sha256 唯一出处（功能 002）。
// 三个 Dockerfile 都要下载并校验这些二进制，校验值写在各自文件里就是三份副本。
// 本组测试保证：ARG 默认值不偏离 binaries.env，版本号不偏离 protocol.json。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadProtocol, REPO_ROOT } from '../../tools/protocol/load.mjs';

const P = loadProtocol();
const ENV_PATH = resolve(REPO_ROOT, 'docker/binaries.env');

const ENV = Object.fromEntries(
  readFileSync(ENV_PATH, 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);

/** 仓库中会下载二进制的 Dockerfile。001 的 docker/devnet 已于 T080 退役。 */
const DOCKERFILES = ['docker/bootstrap/Dockerfile', 'docker/node/Dockerfile'];

const argsOf = (path) => Object.fromEntries(
  [...readFileSync(resolve(REPO_ROOT, path), 'utf8').matchAll(/^ARG ([A-Z][A-Z0-9_]*)=(\S+)$/gm)]
    .map((m) => [m[1], m[2]]),
);

describe('binaries.env 是校验值的唯一出处', () => {
  test('文件存在且包含全部四个组件的版本', () => {
    for (const k of ['AVALANCHEGO_VERSION', 'SUBNET_EVM_VERSION', 'SIGNATURE_AGGREGATOR_VERSION', 'ICM_CONTRACTS_VERSION']) {
      assert.match(ENV[k] ?? '', /^v\d+\.\d+\.\d+$/, `${k} 缺失或格式不对`);
    }
  });

  test('每个 sha256 都是 64 位十六进制', () => {
    const shas = Object.entries(ENV).filter(([k]) => k.startsWith('SHA_'));
    assert.ok(shas.length >= 10, `校验值太少（${shas.length}），是否漏了组件？`);
    for (const [k, v] of shas) assert.match(v, /^[0-9a-f]{64}$/, `${k} 不是合法的 sha256`);
  });

  test('版本号与 protocol.json 一致 —— 版本的唯一事实来源仍是 protocol.json', () => {
    assert.equal(ENV.AVALANCHEGO_VERSION, P.avalanche.avalanchegoVersion);
    assert.equal(ENV.SUBNET_EVM_VERSION, P.avalanche.subnetEvmVersion);
  });
});

describe('各 Dockerfile 的 ARG 默认值不得偏离', () => {
  test(`覆盖到全部 ${DOCKERFILES.length} 个下载二进制的 Dockerfile`, () => {
    assert.ok(DOCKERFILES.length >= 2, `只找到 ${DOCKERFILES.length} 个 Dockerfile，检查路径是否变了`);
  });

  for (const df of DOCKERFILES) {
    test(`${df} 中出现在 binaries.env 的 ARG 与之逐字相同`, () => {
      const args = argsOf(df);
      const shared = Object.keys(args).filter((k) => k in ENV);
      assert.ok(shared.length > 0, `${df} 没有任何与 binaries.env 重合的 ARG`);
      for (const k of shared) {
        assert.equal(args[k], ENV[k], `${df} 的 ARG ${k} 与 docker/binaries.env 不一致`);
      }
    });
  }
});

describe('镜像职责边界', () => {
  test('只有 bootstrap 镜像以 Avalanche CLI 为基底', () => {
    const cliBased = DOCKERFILES.filter((df) => /^FROM avaplatform\/avalanche-cli:/m.test(readFileSync(resolve(REPO_ROOT, df), 'utf8')));
    // T080 之后只剩 bootstrap 一个 CLI 基底镜像（此前 docker/devnet 也是）。
    // 例外条件已收紧：再容忍 'devnet' 就等于允许它悄悄回来。
    assert.deepEqual(cliBased, ['docker/bootstrap/Dockerfile'],
      `唯一允许以 CLI 为基底的是建链镜像，实际：${cliBased.join(', ') || '（无）'}`);
  });

  test('节点运行时镜像以官方 avalanchego 为基底，且不引入 CLI', () => {
    const text = readFileSync(resolve(REPO_ROOT, 'docker/node/Dockerfile'), 'utf8');
    assert.match(text, /^FROM avaplatform\/avalanchego:/m);
    assert.ok(!/avalanche-cli/.test(text), '节点镜像不得引入 Avalanche CLI（FR-015）');
  });
});
