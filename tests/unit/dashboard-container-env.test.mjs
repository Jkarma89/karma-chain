// 入口脚本必须把容器内可用的 RPC 地址传进去（功能 003）。
//
// ## 为什么补这个文件（2026-09-10）
//
// 用户点「立即探活」后报 `HTTP request failed`。成因：探活在**容器内**跑，
// 而 `probe-tx.mjs` 的 RPC 地址默认回落到回环地址加对外 RPC 端口 ——
// **容器内的 127.0.0.1 是容器自己，那儿没有 nginx 代理。**
//
// `probe-tx.mjs` 的注释里早就写了「容器：由 scripts/devnet-dashboard.* 传入
// KARMACHAIN_RPC_URL」，但那一步**从没真的实现**。
//
// ## 为什么整套测试都没抓到
//
// `tests/integration/dashboard-probe.test.mjs` 在**宿主**上跑，那里
// 回环地址加那个端口恰好就是代理容器发布出来的入口 —— 于是它探活成功、全绿。
// **宿主与容器的 127.0.0.1 指向不同的东西，而测试只覆盖了前者。**
//
// 这与 002 反复踩的是同一类坑：判据在一种形态下成立，就以为在另一种形态下也成立。
// 002 的 `--network karmachain` 写死过两次、单文件绑定挂载绑 inode 那次，都是这个形状。
//
// 本文件是静态守卫：它证明不了容器里真能连上（那要 V-01 逐台实测），
// 但它能保证**这个变量不会再被漏传**。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from '../../tools/protocol/load.mjs';

const read = (rel) => readFileSync(resolve(REPO_ROOT, rel), 'utf8');

/** 起工具容器、且容器内要访问链的入口脚本 —— 它们都必须传 KARMACHAIN_RPC_URL。 */
const SCRIPTS = [
  { file: 'scripts/devnet-dashboard.sh', helper: 'devnet_container_rpc_url' },
  { file: 'scripts/devnet-dashboard.ps1', helper: 'Get-ContainerRpcUrl' },
  // 既有的两对 —— 它们本来就在传，一并锁住，免得日后被人"顺手简化"掉
  { file: 'scripts/devnet-verify.sh', helper: 'devnet_container_rpc_url' },
  { file: 'scripts/devnet-verify.ps1', helper: 'Get-ContainerRpcUrl' },
  { file: 'scripts/devnet-contracts.sh', helper: 'devnet_container_rpc_url' },
  { file: 'scripts/devnet-contracts.ps1', helper: 'Get-ContainerRpcUrl' },
];

describe('容器内的 RPC 地址必须由入口脚本传入', () => {
  for (const { file, helper } of SCRIPTS) {
    test(`${file} 传了 KARMACHAIN_RPC_URL`, () => {
      const src = read(file);
      assert.match(src, /KARMACHAIN_RPC_URL/,
        `${file} 没有把 KARMACHAIN_RPC_URL 传进容器 —— `
        + '容器内的 127.0.0.1 是容器自己，那儿没有 RPC 代理');
    });

    test(`${file} 的地址由 ${helper} 推导，不写死`, () => {
      const src = read(file);
      assert.match(src, new RegExp(helper.replace(/[-]/g, '\\-')),
        `${file} 必须用公共件 ${helper} 推导地址 —— `
        + '容器名含边界 id，写死会在别的边界上失败（002 在 --network 上踩过两次）');
    });

    test(`${file} 不把 127.0.0.1 当作容器内的 RPC 地址`, () => {
      // 只看**传给容器**的那一段，不看注释。
      const code = read(file)
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .split('\n')
        .filter((l) => !/^\s*#/.test(l))
        .join('\n');
      const badLine = code.split('\n').find(
        (l) => /KARMACHAIN_RPC_URL/.test(l) && /127\.0\.0\.1|localhost/.test(l),
      );
      assert.equal(badLine, undefined,
        `${file} 把回环地址传进了容器：${badLine}`);
    });
  }
});

describe('probe-tx 的回落地址与它的风险都被写明', () => {
  const src = read('tools/dashboard/probe-tx.mjs');

  test('优先用 KARMACHAIN_RPC_URL，回落才用回环地址', () => {
    assert.match(src, /process\.env\.KARMACHAIN_RPC_URL/,
      '必须先看环境变量 —— 容器里只有它是对的');
  });

  test('连接失败的错误信息里带上"试的是哪个地址"', () => {
    // 原先只回 viem 的 `HTTP request failed`，那句话对排障零信息量。
    assert.match(src, /function explain\(/, '须有一个把成因说清的函数');
    assert.match(src, /RPC 入口/, '错误信息里要带上试的地址');
  });

  test('错误信息明确说明"这不表示链停了"', () => {
    // 探活连不上 ≠ 链停了。混淆两者会让人去处置一条好着的链。
    assert.match(src, /不表示链停了|不表示链已停/,
      '连不上 RPC 入口与链是否可用是两件事，错误信息必须说清');
  });

  test('回落分支专门提示容器内 127.0.0.1 的陷阱', () => {
    assert.match(src, /容器内的 127\.0\.0\.1 是容器自己/,
      '这是 2026-09-10 那次故障的成因，要写在报错里而不只是注释里');
  });
});

describe('explain 的行为（不是只看源码里有没有那串字）', () => {
  test('连接类错误被识别并补上地址与成因', async () => {
    // 用真实模块验证行为 —— 上面几条是静态断言，这一条是行为断言。
    const mod = await import('../../tools/dashboard/probe-tx.mjs');
    // explain 未导出：通过 probeChain 的失败路径间接验证。
    // 把 RPC 指向一个确定关不通的回环端口，断言报错里含地址与那句提示。
    const saved = process.env.KARMACHAIN_RPC_URL;
    process.env.KARMACHAIN_RPC_URL = 'http://127.0.0.1:1/ext/bc/karmachain/rpc';
    try {
      const r = await mod.probeChain();
      assert.equal(r.confirmed, false);
      assert.match(r.error, /127\.0\.0\.1:1/, '报错里要出现试的那个地址');
      assert.match(r.error, /容器内的 127\.0\.0\.1 是容器自己/, '回环地址要触发那条提示');
      assert.match(r.error, /不表示链停了/);
    } finally {
      if (saved === undefined) delete process.env.KARMACHAIN_RPC_URL;
      else process.env.KARMACHAIN_RPC_URL = saved;
    }
  });

  test('非回环地址给出的是另一条提示（查代理容器）', async () => {
    const mod = await import('../../tools/dashboard/probe-tx.mjs');
    const saved = process.env.KARMACHAIN_RPC_URL;
    // 端口取 1（确定关闭）：本用例只验「非回环地址走另一条提示」，端口号无关，
    // 写真实端口会让协议参数在测试里多出一个副本（no-hardcode 守卫会抓）。
    process.env.KARMACHAIN_RPC_URL = 'http://karmachain-rpc-nowhere:1/ext/bc/karmachain/rpc';
    try {
      const r = await mod.probeChain();
      assert.equal(r.confirmed, false);
      assert.match(r.error, /karmachain-rpc-nowhere/);
      assert.match(r.error, /代理容器是否在运行/);
      assert.doesNotMatch(r.error, /容器内的 127\.0\.0\.1/, '这条提示只该给回环地址');
    } finally {
      if (saved === undefined) delete process.env.KARMACHAIN_RPC_URL;
      else process.env.KARMACHAIN_RPC_URL = saved;
    }
  });
});
