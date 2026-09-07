// T057 / V-06：跨机端口连通性与防火墙（功能 002，US4）。
//
// 判据来自 research.md V-06："5 台机器两两可达；Windows 入站规则可用"。
//
// **一次运行只能证明矩阵的一行。** 测试从**本机**出发去连其余每个故障边界上每个节点的
// staking 端口与 HTTP 端口；把它在 5 台机器上各跑一次，才覆盖完整的两两矩阵。
// 这不是取巧：跨机可达性本身就是每台机器各自的防火墙与路由状态，没有哪一台能代表别人。
//
// 判定方式（2026-09-07 修正，**曾经因此误判两天**）：
//   - 连上（ESTABLISHED）→ 路径通。这是唯一对所有平台都无歧义的信号。
//   - 被拒（ECONNREFUSED）→ 路径通，只是那一刻没有进程监听。Linux 对关闭端口回 RST，所以这条主要来自 Linux 目标。
//   - 超时，且目标是 **linux** → 真的被拦（Linux 本会回 RST）。
//   - 超时，且目标是 **windows** → **无法判定**，跳过并说明。
//   - 其他错误（EHOSTUNREACH / ENETUNREACH）→ 路由不通。
//
// 为什么 Windows 目标的超时不能判为失败：Windows 的 WFP 默认对**无监听**端口静默丢弃而不回 RST
// （俗称 stealth mode），而 allow 规则只放行、并不产生监听者。于是"防火墙已放行但节点没起来"
// 与"防火墙在拦"在 Windows 上产生**完全相同**的观测，本测试无从区分。
//
// 实测教训：初版把 Windows 目标的超时判为"被防火墙拦下"，导致对着一台配置完全正确的机器
// 排查了七个假设（规则、端口、第三方安全软件、AP 隔离、ARP 过期、Wi-Fi 桥接、VPN kill switch）
// 才发现是判据本身有问题。期间还用"从容器探本机得到 refused"去否证 stealth mode ——
// 而那个 refused 是 0ms 的**本地拒绝**（Docker Desktop 的 WSL2 NAT 就地拒掉，没出网），
// 同样的 0ms refused 对没有任何规则的端口也会出现。**跨主机的可达性不能从容器里测。**
//
// 因此本测试在链未部署时只能给出**部分**结论（Linux 目标可判、Windows 目标不可判）；
// 决定性的一次是**节点起来之后**复跑，那时"连上"对每个平台都无歧义。
//
// 跳过条件（都是"本机不在跨机拓扑里"，不是缺陷）：
//   - 唯一事实来源里没有多边界部署形态
//   - 本机的网卡地址不属于该形态的任何一个故障边界
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { networkInterfaces, hostname } from 'node:os';
import { loadProtocol, deriveTopology } from '../../tools/protocol/load.mjs';

const CONNECT_TIMEOUT_MS = 3000;

/** 本机全部非回环 IPv4 地址。 */
function localAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

/**
 * 一次 TCP 连接尝试。
 * @returns {Promise<{ok: boolean, how: 'connected'|'refused'|'blocked', detail: string}>}
 */
function probe(host, port) {
  return new Promise((done) => {
    const sock = new net.Socket();
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; sock.destroy(); done(r); } };

    sock.setTimeout(CONNECT_TIMEOUT_MS);
    sock.once('connect', () => finish({ how: 'connected', detail: '已建立连接' }));
    sock.once('timeout', () => finish({ how: 'silent', detail: `${CONNECT_TIMEOUT_MS}ms 内无响应` }));
    sock.once('error', (e) => {
      // 被拒说明数据包到达了对端并收到 RST —— 路径是通的
      if (e.code === 'ECONNREFUSED') finish({ how: 'refused', detail: '连接被拒（路径通，该端口当前无监听）' });
      else finish({ how: 'error', detail: `${e.code ?? e.message}` });
    });
    sock.connect(port, host);
  });
}

/** 挑出多边界形态，并判断本机是哪一个边界。 */
function locateSelf() {
  const p = loadProtocol();
  const name = Object.keys(p.topology.deployments)
    .find((k) => p.topology.deployments[k].failureDomains.length > 1);
  if (!name) return { reason: '唯一事实来源中没有多边界部署形态 —— 跨机可达性无从谈起' };

  const d = deriveTopology({ ...p, topology: { ...p.topology, activeDeployment: name } });
  const mine = new Set(localAddresses());
  const self = d.failureDomains.find((x) => mine.has(x.address));
  if (!self) {
    return {
      reason: `本机（${hostname()}，地址 ${[...mine].join(', ') || '无'}）不属于形态 '${name}' 的任何故障边界`
        + `（声明的地址：${d.failureDomains.map((x) => x.address).join(', ')}）`,
    };
  }
  return { deployment: name, derived: d, self };
}

const found = locateSelf();

describe('V-06 跨机 staking / HTTP 端口可达性（T057）', { skip: found.reason }, () => {
  const { derived: d, self, deployment } = found;
  // 只测别的边界：本机内部的连通性由容器网络保证，不属于 V-06
  const remotes = d.failureDomains.filter((x) => x.id !== self?.id);
  const byId = new Map((d?.topologyNodes ?? []).map((n) => [n.id, n]));

  test(`本机识别为形态 '${deployment}' 的边界 '${self?.id}'`, () => {
    assert.ok(self, '定位失败时本套件应当整体跳过');
    assert.equal(remotes.length, d.failureDomains.length - 1);
  });

  for (const dom of remotes) {
    for (const id of dom.nodes) {
      const n = byId.get(id);
      for (const [kind, port] of [['staking', n.stakingPort], ['http', n.httpPort]]) {
        test(`${self.id} → ${dom.id}(${dom.address}) ${id} ${kind} 端口 ${port}`, async (t) => {
          const r = await probe(dom.address, port);
          if (r.how === 'connected' || r.how === 'refused') return; // 路径通
          if (r.how === 'silent' && dom.platform === 'windows') {
            t.skip(
              `无法判定：${dom.address} 是 Windows，${r.detail}。\n`
              + '    Windows 的 WFP 对无监听端口静默丢弃而不回 RST（allow 规则只放行、不产生监听者），\n'
              + `    因此"防火墙已放行但 ${id} 没起来"与"防火墙在拦"在这里产生完全相同的观测。\n`
              + '    判定办法：在该机器上启动节点后复跑本测试 —— 那时"连上"是无歧义的信号。\n'
              + `    若确认节点已在运行仍然超时，才是真的被拦，按下面的方式放行入站 TCP ${port}：\n`
              + `      New-NetFirewallRule -DisplayName "KarmaChain ${id} ${kind}" -Direction Inbound -Protocol TCP -LocalPort ${port} -Action Allow`,
            );
            return;
          }
          assert.fail(
            `不可达：${r.detail}\n`
            + `  ${kind === 'staking' ? 'staking 端口用于共识 P2P，不通则该节点无法参与出块' : 'HTTP 端口是本机 RPC 代理的上游，不通则故障转移失效'}\n`
            + `  在 ${dom.address}（${dom.platform}）上放行入站 TCP ${port}：\n`
            + (dom.platform === 'windows'
              ? `    New-NetFirewallRule -DisplayName "KarmaChain ${id} ${kind}" -Direction Inbound -Protocol TCP -LocalPort ${port} -Action Allow\n`
              : `    sudo ufw allow ${port}/tcp\n`)
            + '  另需确认该机器上 docker compose 已发布该端口（compose 文件由拓扑生成，不必手改）\n'
            + `  本条判为失败的依据：目标是 ${dom.platform}，Linux 对关闭端口会回 RST，所以静默超时只能是被拦或路由不通。\n`
            + '  （Windows 目标不会走到这里 —— 它的静默超时无法区分"被拦"与"无监听"，按跳过处理）\n'
            + `  不通的边界等于少一个可用故障域，而容错上限只有 ${d.faultTolerance.maxOfflineValidators} 个`,
          );
        });
      }
    }
  }
});
