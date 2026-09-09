// RPC 代理的**故障转移必须够快**。
//
// 生成的 rpc-proxy.conf 里写着一句承诺："某个验证者不可用时自动换下一个 ——
// RPC 入口不随单个验证者一起挂掉"。2026-09-09 实测发现这句话当时是**不成立**的：
// 转移能转，但每个请求要 21 秒，而任何客户端的正常超时（viem 20s、MetaMask ~30s）
// 都短于它 —— 也就是说对使用者而言入口确实是挂了。
//
// 三个原因叠在一起，缺一个都会把延迟带回去：
//
// 1. **没设 `proxy_connect_timeout`**（nginx 默认 60s）。机器整台没了时，Windows 的 WFP
//    对关闭端口**静默丢包**（不回 RST），nginx 只能等满超时才判失败。
// 2. **`max_fails=2`** 在低频请求下等于没生效：请求间隔一旦超过 `fail_timeout`，
//    窗口内只累积到 1 次失败，永远到不了 2 次，死节点因此从不被标记下线。
// 3. **upstream 没有 `zone`** —— 失败状态是**每个 worker 各记一份**的。
//    nginx:alpine 默认 `worker_processes auto`，实测起了 18 个 worker，
//    于是请求散开后几乎每次都命中一个"还不知道那台已死"的 worker。
//    这一条最隐蔽：修了前两条之后 8 次请求仍然 8 次都是 2 秒，就是它。
//
// 实测效果（win-2 整域缺席期间，win-1 的代理，间隔 6 秒发 10 次）：
//   修复前：21s × 5/5
//   只修 1+2：2.01s × 8/8
//   三条齐全：~7ms × 7/10，2s × 3/10（fail_timeout 到期重探那台死节点）
//
// 本套件守的是这三条，不是具体数值 —— 数值可以调，但"故障转移要在客户端超时之内完成"
// 这个性质不能丢。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT, loadProtocol, deriveTopology } from '../../tools/protocol/load.mjs';

const protocol = loadProtocol();
const DEPLOYMENTS = Object.keys(protocol.topology.deployments);

/** 客户端能容忍的上限。viem 在本仓库配的是 20s，MetaMask 约 30s —— 取更严的那个。 */
const CLIENT_TIMEOUT_S = 20;

const confOf = (deployment) =>
  readFileSync(resolve(REPO_ROOT, 'blockchain', 'nodes', deployment, 'rpc-proxy.conf'), 'utf8');

describe('RPC 代理的故障转移在客户端超时之内完成', () => {
  test('存在部署形态可测 —— 否则本套件在空转', () => {
    assert.ok(DEPLOYMENTS.length >= 1, `期望至少 1 个部署形态，实际 ${DEPLOYMENTS.length}`);
  });

  for (const d of DEPLOYMENTS) {
    describe(`部署形态 ${d}`, () => {
      const conf = confOf(d);

      test('upstream 声明了共享内存区 zone —— 否则失败状态每个 worker 各记一份', () => {
        assert.match(conf, /^\s*zone\s+\S+\s+\S+;/m,
          'upstream 缺 `zone`。nginx 默认 worker_processes auto（实测 18 个 worker），\n'
          + '  没有共享区时 max_fails 的计数不跨 worker —— 一台机器整域缺席时，请求散到各 worker，\n'
          + '  几乎每次都命中一个"还不知道那台已死"的 worker，重新付一遍连接超时。\n'
          + '  `zone` 是开源 nginx 的指令（1.9.0+），不需要 Plus。');
      });

      test('显式设了 proxy_connect_timeout，且短于客户端超时', () => {
        const m = conf.match(/proxy_connect_timeout\s+(\d+)(m?s);/);
        assert.ok(m, 'server 段缺 `proxy_connect_timeout`。nginx 默认 60s，而机器整台没了时\n'
          + '  Windows 对关闭端口静默丢包（不回 RST），nginx 只能等满这个超时才判失败去试下一个。\n'
          + '  实测：不设它 → 每个请求 21 秒，客户端全部超时。');
        const secs = m[2] === 'ms' ? Number(m[1]) / 1000 : Number(m[1]);
        assert.ok(secs > 0 && secs < CLIENT_TIMEOUT_S / 2,
          `proxy_connect_timeout=${m[1]}${m[2]} 太长：客户端超时约 ${CLIENT_TIMEOUT_S}s，`
          + '而最坏情况是"依次试完每个后端 × 该超时"，必须留出余量。');
      });

      test('后端 max_fails=1 —— 低频请求下 max_fails>1 等于没生效', () => {
        const servers = [...conf.matchAll(/^\s*server\s+\S+\s+max_fails=(\d+)\s+fail_timeout=(\d+)s;/gm)];
        assert.ok(servers.length > 0, 'upstream 里应当有带 max_fails/fail_timeout 的 server 行');
        const bad = servers.filter(([, mf]) => Number(mf) !== 1);
        assert.equal(bad.length, 0,
          `以下后端的 max_fails 不是 1：${bad.map(([l]) => l.trim()).join(' / ')}\n`
          + '  请求间隔一旦超过 fail_timeout，窗口内就只累积到 1 次失败，永远到不了阈值 ——\n'
          + '  死节点因此从不被标记下线，每个请求都要重新付一遍连接超时。实测踩过。');
      });

      test('宣告了在 error/timeout 时转下一个后端，且尝试次数覆盖全部验证者', () => {
        assert.match(conf, /proxy_next_upstream\s+[^;]*\berror\b/, '应在 error 时转下一个');
        assert.match(conf, /proxy_next_upstream\s+[^;]*\btimeout\b/, '应在 timeout 时转下一个');

        const validators = deriveTopology({ ...protocol, topology: { ...protocol.topology, activeDeployment: d } })
          .topologyNodes.filter((n) => n.role === 'l1-validator');
        const tries = conf.match(/proxy_next_upstream_tries\s+(\d+);/);
        assert.ok(tries, '缺 `proxy_next_upstream_tries` —— 不限次数时最坏情况不可预测');
        assert.ok(Number(tries[1]) >= validators.length,
          `proxy_next_upstream_tries=${tries[1]} 少于验证者数 ${validators.length}：`
          + '最后一个健康后端可能永远轮不到');
      });

      test('upstream 列出了该形态的全部 L1 验证者', () => {
        const d2 = deriveTopology({ ...protocol, topology: { ...protocol.topology, activeDeployment: d } });
        const validators = d2.topologyNodes.filter((n) => n.role === 'l1-validator');
        for (const v of validators) {
          assert.match(conf, new RegExp(`server\\s+${v.address.replace(/\./g, '\\.')}:${v.httpPort}\\b`),
            `${v.id}（${v.address}:${v.httpPort}）不在 upstream 里 —— 少一个后端就少一分冗余`);
        }
      });
    });
  }
});
