// T067 / quickstart 场景 G：拓扑校验与漂移检出的 CLI 契约（功能 002 / US5、FR-021、FR-027）。
//
// 四项判据（quickstart.md 场景 G）：
//   1. 合法拓扑 → 退出 0，显示每边界验证者数与容错上限
//   2. 违规拓扑 → 退出 13，指出边界 id、实际数量、上限、以及"把哪个节点挪走"
//   3. 共享失效因素 → 告警但不阻断
//   4. 漂移 → 手改任一生成物后 `devnet-render --check` 失败并指出偏离项
//
// 违规与共享因素两项都用**改过的 protocol.json 副本**（`--protocol` 接缝）来构造，
// 不触碰唯一事实来源 —— 否则测试自身就会污染它要保护的东西。
//
// 直接调 node 而不经 scripts/devnet-*（那两个脚本是 `docker compose run` 的薄封装，
// 每次调用要几秒起容器）。脚本本身只是转调，转调的正确性由 no-cli-in-runtime 一类的
// 结构断言与人工使用覆盖；这里测的是被转调的那个工具的契约。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { REPO_ROOT, loadProtocol } from '../../tools/protocol/load.mjs';

const VALIDATE = resolve(REPO_ROOT, 'tools/protocol/validate-topology.mjs');
const RENDER_ALL = resolve(REPO_ROOT, 'tools/protocol/render-all.mjs');

/** 跑一个工具，返回退出码与合并输出。 */
function run(script, args = []) {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/** 把 protocol.json 改一改写到临时文件，返回路径。 */
function stageProtocol(mutate) {
  const p = JSON.parse(JSON.stringify(loadProtocol()));
  mutate(p);
  const dir = mkdtempSync(join(tmpdir(), 'kc-topo-'));
  const file = join(dir, 'protocol.json');
  writeFileSync(file, `${JSON.stringify(p, null, 2)}\n`);
  // schema 用 $schema 相对路径解析不到临时目录，故一并复制过去
  copyFileSync(resolve(REPO_ROOT, 'blockchain/protocol.schema.json'), join(dir, 'protocol.schema.json'));
  return file;
}

/** 构造一个 5 边界各 1 验证者、无共享因素的合法跨机形态。 */
function cleanFiveDomains(p) {
  p.topology.deployments.g = {
    description: '场景 G 测试用：5 边界各 1 验证者，无共享因素',
    failureDomains: [
      { id: 'm1', platform: 'linux', address: '10.90.0.1', nodes: ['l1-1', 'primary-1'], sharedFailureFactors: [] },
      { id: 'm2', platform: 'linux', address: '10.90.0.2', nodes: ['l1-2', 'primary-2'], sharedFailureFactors: [] },
      { id: 'm3', platform: 'linux', address: '10.90.0.3', nodes: ['l1-3'], sharedFailureFactors: [] },
      { id: 'm4', platform: 'linux', address: '10.90.0.4', nodes: ['l1-4'], sharedFailureFactors: [] },
      { id: 'm5', platform: 'linux', address: '10.90.0.5', nodes: ['l1-5'], sharedFailureFactors: [] },
    ],
  };
}

describe('场景 G — 拓扑校验与漂移检出（T067）', () => {
  test('判据 1：合法拓扑退出 0，显示每边界验证者数与容错上限', () => {
    const file = stageProtocol(cleanFiveDomains);
    const r = run(VALIDATE, ['--deployment', 'g', '--protocol', file]);
    assert.equal(r.code, 0, `合法拓扑不应失败\n${r.out}`);
    // 每边界一行，且末列是该边界的验证者数
    for (const id of ['m1', 'm2', 'm3', 'm4', 'm5']) {
      assert.match(r.out, new RegExp(`${id}\\s+linux\\s+10\\.90\\.0\\.\\d+\\s+.*\\s1\\s*$`, 'm'), `缺少边界 ${id} 的行或验证者数不为 1`);
    }
    assert.match(r.out, /可容忍 1 个离线/, '应显示推导出的容错上限');
    assert.match(r.out, /可容忍 1 个边界整体失效\s+\[OK\]/, '5 边界各 1 验证者应判为可容忍整域失效');
  });

  test('判据 2：违规拓扑退出 13，指出边界 id、实际数量、上限与修正方向', () => {
    const file = stageProtocol((p) => {
      cleanFiveDomains(p);
      // 把 l1-2 挪进 m1，使该边界含 2 个验证者；m2 只剩 Primary
      const d = p.topology.deployments.g.failureDomains;
      d[0].nodes = ['l1-1', 'l1-2', 'primary-1'];
      d[1].nodes = ['primary-2'];
      p.topology.activeDeployment = 'g';
    });
    const r = run(VALIDATE, ['--deployment', 'g', '--protocol', file]);
    assert.equal(r.code, 13, `期望退出码 13（拓扑违反容错约束），实际 ${r.code}\n${r.out}`);
    assert.match(r.out, /category: configuration/, '应归入 configuration 类别');
    assert.match(r.out, /m1/, '应指出是哪个边界');
    assert.match(r.out, /2/, '应指出实际验证者数量');
    assert.match(r.out, /1/, '应指出上限');
    // 契约要求给出可执行的修正方向，而不只是报错
    assert.match(r.out, /移到|挪|增加边界/, `应给出修正方向\n${r.out}`);
  });

  test('判据 3：共享失效因素告警但不阻断', () => {
    const file = stageProtocol((p) => {
      cleanFiveDomains(p);
      const d = p.topology.deployments.g.failureDomains;
      d[2].sharedFailureFactors = ['power:strip-A'];
      d[3].sharedFailureFactors = ['power:strip-A'];
    });
    const r = run(VALIDATE, ['--deployment', 'g', '--protocol', file]);
    assert.equal(r.code, 0, `共享因素不得阻断校验\n${r.out}`);
    assert.match(r.out, /\[WARN\]/, '应产生告警');
    assert.match(r.out, /power:strip-A/, '告警应指出是哪个因素');
    assert.match(r.out, /同时损失 2 个验证者/, '告警应说明后果');
    // 承诺必须按合并后的有效边界判定，不能因为"每个声明边界只有 1 个"就给绿灯
    assert.match(r.out, /无法容忍边界整体失效\s+\[FAIL\]/, '共享因素使有效边界合并，承诺应转为 FAIL');
    assert.match(r.out, /合并为 4 个/, '应说明 5 个声明边界合并为 4 个有效边界');
  });

  test('判据 4：手改生成物后 --check 失败并指出偏离项', () => {
    const target = resolve(REPO_ROOT, 'blockchain/nodes/aliases.json');
    const original = readFileSync(target, 'utf8');
    try {
      // 先确认基线是干净的，否则本断言证明不了任何事
      const before = run(RENDER_ALL, ['--check']);
      assert.equal(before.code, 0, `基线本身就有漂移，无法据此判断\n${before.out}`);

      writeFileSync(target, original.replace(/\}\s*$/, '  ,"_手改":"T067"\n}\n'));
      const after = run(RENDER_ALL, ['--check']);
      assert.equal(after.code, 1, `手改生成物后 --check 应失败\n${after.out}`);
      assert.match(after.out, /DRIFT/, '应标出漂移');
      assert.match(after.out, /aliases\.json/, '应指出是哪一项偏离');
      assert.match(after.out, /devnet-render|npm run render/, '应给出修正办法');
    } finally {
      writeFileSync(target, original);
      const restored = run(RENDER_ALL, ['--check']);
      assert.equal(restored.code, 0, `测试后未能恢复生成物\n${restored.out}`);
    }
  });
});
