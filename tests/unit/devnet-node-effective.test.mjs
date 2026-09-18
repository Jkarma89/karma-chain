// 起停重启必须**事后核对**，不能只看 docker 的退出码（功能 005 / 研究 V-36）。
//
// ## 缺陷是怎么暴露的
//
// 2026-09-17 为了修 l1-1 的 P2P 签名，我跑了：
//
//   .\scripts\devnet-node.ps1 restart l1-1
//   devnet-node: l1-1 已重启
//
// 而容器的 `StartedAt` **一字未变**（`RestartCount = 0`）。随后在 docker/compose/
// 目录里手动 `docker compose -f lan-win-1.yml restart l1-1`，StartedAt 立刻变了。
// 两边都退出 0 —— **compose 自己"什么都没做"也算成功**，所以 `a9718cb` 加的
// 退出码检查拦不住它（那一条修的是 `no such service` 那种真失败）。
//
// 代价是它误导了我一整轮：我据此认为"重启没用、问题不在 l1-1"，
// 又把签名者从 4 掉到 3 错算成"重启弄坏了"。而真相是那次重启压根没发生。
//
// ## 三个动作的判据**各不相同**，这是本文件的要害
//
//   stop / kill  终态不是 running
//   start        **终态**是 running —— 对已经在跑的节点，什么都不做是对的
//   restart      **StartedAt 变了** —— 终态照旧 running，只有时刻能区分"重启过"
//
// 把 restart 也写成"终态是 running"就等于没有判定：那正是缺陷本身的形状。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from '../../tools/protocol/load.mjs';

const SH = readFileSync(resolve(REPO_ROOT, 'scripts/devnet-node.sh'), 'utf8');
const PS = readFileSync(resolve(REPO_ROOT, 'scripts/devnet-node.ps1'), 'utf8');

describe('① restart 的判据是 StartedAt，不是终态', () => {
  test('.sh 比对重启前后的 StartedAt', () => {
    assert.match(SH, /before="\$\(container_started "\$CONTAINER"\)"/,
      '.sh 的 restart 必须先读 StartedAt —— 不读就没有可比的基准');
    assert.match(SH, /\[ "\$after" != "\$before" \]/,
      '.sh 必须断言 StartedAt **变了**。只判终态 running 的话，'
      + '那个"什么都没做"的 compose 会照样通过 —— 那就是 V-36 本身');
  });

  test('.ps1 比对重启前后的 StartedAt', () => {
    assert.match(PS, /\$before = Get-ContainerStarted \$container/);
    assert.match(PS, /if \(\$after -eq \$before\) \{ Exit-NotEffective/,
      '.ps1 必须断言 StartedAt 变了 —— 这一版正是报出假成功的那一版');
  });

  test('两版都把新旧时刻打进成功消息里（可核对，不是一句断言）', () => {
    assert.match(SH, /已重启（StartedAt \$\{before\} → \$\{after\}）/);
    assert.match(PS, /已重启（StartedAt \$before → \$after）/);
  });
});

describe('② stop / start / kill 的判据不许被写成同一条', () => {
  test('start 判的是终态 running（对已在跑的节点不该要求时刻变）', () => {
    assert.match(SH, /\[ "\$state" = running \] \|\| not_effective/,
      'start 若也要求 StartedAt 变，对已经在跑的节点就会误报 —— '
      + '而"已启动"那句话本来是真的');
    assert.match(PS, /if \(\$state -ne 'running'\) \{ Exit-NotEffective/);
  });

  test('stop 与 kill 判的是"不再 running"', () => {
    const shHits = SH.split('!= running').length - 1;
    assert.ok(shHits >= 2, `.sh 里只有 ${shHits} 处 "不再 running" 判定 —— stop 与 kill 各要一处`);
    const psHits = PS.split("-eq 'running') { Exit-NotEffective '它还是 running' }").length - 1;
    assert.ok(psHits >= 2, `.ps1 里只有 ${psHits} 处 —— stop 与 kill 各要一处`);
  });
});

describe('③ 两版等价（FR-017），失败路径也要等价', () => {
  test('都用退出码 20 报"动作没有生效"，且都在头部写明', () => {
    assert.match(SH, /exit 20/, '.sh 缺少退出码 20');
    assert.match(PS, /exit 20/, '.ps1 缺少退出码 20');
    for (const [name, src] of [['sh', SH], ['ps1', PS]]) {
      assert.match(src, /20 \*\*动作没有生效\*\*/,
        `${name} 的头部没写明 20 是什么 —— 退出码有语义才有用（FR-017）`);
    }
  });

  test('20 不与 001/002 已用的号冲突', () => {
    // 10 前置依赖缺失 / 11 端口冲突 / 12 数据与声明不一致 / 13 拓扑违规 / 20 启动失败。
    // "restart 没有生效" 归到 20：节点没有被重新拉起，就是一次启动没成。
    for (const [name, src] of [['sh', SH], ['ps1', PS]]) {
      for (const bad of [11, 12, 13]) {
        assert.doesNotMatch(src, new RegExp(`exit ${bad}\b`),
          `${name} 用了保留给别的含义的退出码 ${bad}`);
      }
    }
  });

  test('两版的报法同文（同一句话，便于按输出搜）', () => {
    for (const src of [SH, PS]) {
      assert.match(src, /没有生效\*\* ——/);
      assert.match(src, /docker 命令自己退出 0，但容器状态说它什么都没发生。/,
        '两版的解释必须同文 —— 不同的话按输出搜不到同一处代码');
    }
  });
});
