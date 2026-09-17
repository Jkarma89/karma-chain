// `devnet-node` 只管**本机承载**的节点，且失败**必须说失败**
//（功能 005 / T041 实施期发现、002 的 FR-017 等价性）。
//
// ## 2026-09-17 在 win-2 上撞到的那一幕
//
// ```
// PS E:\BlockChain\karma-chain> .\scripts\devnet-node.ps1 stop l1-2
// no such service: l1-2
// devnet-node: l1-2 已停止
// ```
//
// **l1-2 根本没停**（从 win-1 探测它仍在应答），而命令说停了。
// 三个缺陷叠在一起：
//
//   ① 没设 `KARMACHAIN_DOMAIN` → 边界回落成默认的 win-1 →
//      去 `lan-win-1.yml` 里找 `l1-2`（那份只定义 `l1-1`）
//   ② 脚本只校验了"这个 id 在**整张网络**里存在吗"，
//      而注释写的是"节点必须属于**本故障边界**" —— **一条声称存在的检查并不存在**
//      （与 FR-014 那次同形）
//   ③ `.ps1` 的成功消息是**无条件**打印的 —— compose 报错之后照报"已停止"
//
// 第 ③ 条同时是一次 **FR-017 违反**：`.sh` 有 `set -eu`，命令失败即中止、不会报成功；
// 两版因此在**失败路径上并不等价**。更糟的是它恰好落在两台 Windows 机器上 ——
// 按 ADR-0006 那两台要人工介入恢复，**假成功正好出现在有人手动操作的地方**。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from '../../tools/protocol/load.mjs';

const read = (rel) => readFileSync(resolve(REPO_ROOT, rel), 'utf8');
const SH = read('scripts/devnet-node.sh');
const PS1 = read('scripts/devnet-node.ps1');

describe('本机承载判据：取 compose 真正定义的服务，不再写一份会过期的清单', () => {
  for (const [name, src] of [['devnet-node.sh', SH], ['devnet-node.ps1', PS1]]) {
    test(`${name} 问 compose 要本机的服务清单`, () => {
      assert.match(src, /config --services/,
        `${name} 没有问 compose "本机有哪些服务"。\n`
        + '  只比对 KARMACHAIN_NODE_IDS（全网节点全集）是不够的 —— 那让非默认机器上\n'
        + '  的操作静默打到别人的 compose 文件上。');
    });

    test(`${name} 拦下之后指名 KARMACHAIN_DOMAIN 这个成因`, () => {
      assert.match(src, /KARMACHAIN_DOMAIN/,
        `${name} 拦下时没提 KARMACHAIN_DOMAIN —— 而那是**最常见的成因**。\n`
        + '  `_devnet-common.sh` 的 devnet_node_network 早就记着这一条教训\n'
        + '  （"在非默认机器上最常见的成因其实不是没启动，而是没设 KARMACHAIN_DOMAIN"），\n'
        + '  当时没有推广到本脚本。');
    });
  }
});

describe('失败必须说失败 —— 两版在失败路径上要等价（FR-017）', () => {
  test('.ps1 检查 $LASTEXITCODE，不再无条件报成功', () => {
    assert.match(PS1, /\$LASTEXITCODE -ne 0/,
      '.ps1 没有检查退出码。PowerShell 不会因为原生命令失败而中止，\n'
      + '  所以成功消息会照常打印 —— 那是一次假成功，比操作失败更坏。');
  });

  test('.ps1 的 stop / start / restart 都走同一条检查', () => {
    // 三个动作共用 Invoke-NodeCompose；若有人给某一个"顺手简化"回去，这条会红。
    for (const action of ['stop', 'start', 'restart']) {
      const line = PS1.split('\n').find((l) => l.includes(`'${action}'`) && l.includes('{'));
      assert.ok(line, `.ps1 里找不到 ${action} 分支`);
      assert.match(line, /Invoke-NodeCompose/,
        `${action} 分支绕过了 Invoke-NodeCompose —— 它就失去了退出码检查`);
    }
  });

  test('.ps1 的 kill 也检查退出码（它不走 compose，容易被漏掉）', () => {
    // 从 `switch ($Action)` 之后开始找 —— 否则会命中参数声明里的
    // `ValidateSet('kill', 'stop', …)`，那一处在文件更前面。
    // 第一版就是这么写的，切出来的是字符串 `'kill',` 而不是分支体。
    const sw = PS1.indexOf('switch ($Action)');
    assert.ok(sw > 0, '.ps1 里找不到 switch ($Action)');
    const body = PS1.slice(sw);
    const killBlock = body.slice(body.indexOf("'kill'"), body.indexOf("'stop'"));
    assert.match(killBlock, /\$LASTEXITCODE -ne 0/,
      'kill 直接调 docker kill，不经 Invoke-NodeCompose —— 它自己那条检查不能少');
  });

  test('**反向断言**：.sh 靠 set -eu 达到同一效果', () => {
    // 两版的机制不同（一个显式判码、一个靠 shell 中止），但**行为必须相同**。
    // 这一条钉住 .sh 那一半的机制还在 —— 它没了的话，.sh 会变成和出问题前的 .ps1 一样。
    assert.match(SH, /^set -eu$/m,
      '.sh 去掉 set -eu 之后，docker compose 失败也会继续往下走到那句"已停止" —— '
      + '那就退回到本次修的那个缺陷了');
  });
});

describe('拼写检查仍然保留 —— 两层不是一层', () => {
  test('两版都还比对全网节点清单（打错 id 时给出可选项）', () => {
    for (const [name, src] of [['devnet-node.sh', SH], ['devnet-node.ps1', PS1]]) {
      assert.match(src, /KARMACHAIN_NODE_IDS/,
        `${name} 丢掉了"这个 id 在全网存在吗"这一层 —— `
        + '打错一个字母时，本机承载判据只会说"本机不承载它"，而真正的问题是拼写');
    }
  });
});
