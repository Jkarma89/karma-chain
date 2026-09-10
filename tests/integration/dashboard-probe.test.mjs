// T026b —— `POST /api/probe` 的契约（功能 003 / SC-018、FR-034、FR-035）。
//
// **这是 `/speckit-analyze` 补上的缺口**：探活端点原先零测试。
//
// 判据来自 `contracts/dashboard-api.md` 第 2.3 节。本文件守四件事：
//   ① 返回结构固定，且**恒 200** —— 链停了返回 confirmed:false，那是正常输出不是错误
//   ② 单飞：同一时刻只允许一笔在飞（002 踩过并行 nonce 间隙导致回执超时的坑）
//   ③ 只接 POST —— 探活会写链，不该是一个 GET 能触发的东西
//   ④ 响应体里**不含任何密钥材料**
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDashboardServer } from '../../tools/dashboard/server.mjs';
import { loadContext } from '../../tools/dashboard/poll.mjs';
import { redact, isProbeInFlight } from '../../tools/dashboard/probe-tx.mjs';
import { REPO_ROOT } from '../../tools/protocol/load.mjs';

/** 开发账户的私钥 —— 只用来断言它**没有**出现在任何输出里。 */
const DEV_KEYS = (() => {
  try {
    const { accounts } = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'blockchain/accounts/dev-accounts.json'), 'utf8'),
    );
    return accounts.map((a) => a.privateKey).filter(Boolean);
  } catch { return []; }
})();

let ctx; let server; let poller; let base;

before(async () => {
  ctx = loadContext();
  ({ server, poller } = createDashboardServer({ ctx, intervalSeconds: 5 }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  poller?.stop();
  if (server) await new Promise((r) => server.close(r));
});

const post = (path) => fetch(`${base}${path}`, { method: 'POST', signal: AbortSignal.timeout(60_000) });

describe('POST /api/probe —— 方法与结构', () => {
  test('GET 被拒 —— 探活会写链，不该被浏览器预取或链接分享触发', async () => {
    const res = await fetch(`${base}/api/probe`, { signal: AbortSignal.timeout(10_000) });
    assert.equal(res.status, 405);
    const body = await res.json();
    assert.match(body.error, /POST/);
    assert.match(body.error, /写入|FR-035/, '拒绝理由要说明"它会写链"，而不是只说方法不对');
  });

  test('POST 返回约定的五个字段，且恒 200', async () => {
    const res = await post('/api/probe');
    assert.equal(res.status, 200, '链停了也该是 200 —— confirmed:false 是正常输出（SC-018）');
    const r = await res.json();
    for (const k of ['confirmed', 'blockNumber', 'elapsedMs', 'txHash', 'error']) {
      assert.ok(k in r, `响应缺字段 ${k}`);
    }
    assert.equal(typeof r.elapsedMs, 'number');
    assert.ok(r.confirmed === true || r.confirmed === false || r.confirmed === null);
  });

  test('链可用时确认成功，并给出区块与耗时（SC-018 的正向一半）', async (t) => {
    const r = await (await post('/api/probe')).json();
    t.diagnostic(`探活结果：${JSON.stringify({ confirmed: r.confirmed, blockNumber: r.blockNumber, elapsedMs: r.elapsedMs, error: r.error })}`);
    // 本用例的前提是链此刻可用。若不可用，说明的是环境而非实现 —— 那时给出可读的失败原因。
    assert.equal(r.confirmed, true,
      `链此刻应当可用；探活失败原因：${r.error}。若确属链不可用，`
      + 'stopped 档下的行为由 tests/e2e/dashboard-stopped-tier.test.mjs 覆盖');
    assert.ok(Number.isInteger(r.blockNumber) && r.blockNumber > 0);
    assert.match(r.txHash, /^0x[0-9a-f]{64}$/i);
    assert.ok(r.elapsedMs > 0);
    assert.equal(r.error, null);
  });
});

describe('单飞：同一时刻只允许一笔在飞', () => {
  test('并发两个请求，第二个被拒且不发第二笔（避免 nonce 间隙）', async (t) => {
    // 002 踩过：并行发交易造成 nonce 间隙，进而 WaitForTransactionReceiptTimeoutError。
    const [a, b] = await Promise.all([
      post('/api/probe').then((r) => r.json()),
      // 稍微错开，确保第一笔已进入在飞状态
      new Promise((r) => setTimeout(r, 50)).then(() => post('/api/probe').then((x) => x.json())),
    ]);
    const results = [a, b];
    const busy = results.filter((r) => r.busy === true);
    const sent = results.filter((r) => r.txHash);
    t.diagnostic(`结果：${results.map((r) => (r.busy ? 'busy' : `tx=${String(r.txHash).slice(0, 12)}…`)).join(' / ')}`);

    assert.equal(busy.length, 1, '恰好一个应当被单飞守卫挡下');
    assert.equal(sent.length, 1, '只应当有一笔真的发出去');
    assert.match(busy[0].error, /已有探活在进行中/);
    assert.equal(busy[0].txHash, null, '被挡下的那个不得带交易哈希');
  });

  test('结束后单飞标志被复位 —— 否则第一次之后就再也探不了活了', async () => {
    assert.equal(isProbeInFlight(), false, '上一组测试结束后应当已复位');
    const r = await (await post('/api/probe')).json();
    assert.notEqual(r.busy, true, '复位后应当能正常发起');
    assert.equal(isProbeInFlight(), false);
  });
});

describe('密钥不出服务端（宪法第四条）', () => {
  test('响应体里不含任何开发账户私钥', async () => {
    assert.ok(DEV_KEYS.length > 0, '前提：应当能读到开发账户，否则本用例在空转');
    const text = JSON.stringify(await (await post('/api/probe')).json());
    for (const key of DEV_KEYS) {
      assert.ok(!text.includes(key), '响应体里出现了私钥');
      assert.ok(!text.includes(key.replace(/^0x/, '')), '响应体里出现了去掉 0x 的私钥');
    }
  });

  test('快照里也不含私钥 —— 探活与快照是两个端点，但都别泄漏', async () => {
    await poller.round();
    const text = JSON.stringify(await (await fetch(`${base}/api/snapshot`)).json());
    for (const key of DEV_KEYS) {
      assert.ok(!text.includes(key));
    }
  });

  test('redact 抹掉长十六进制串 —— viem 的错误里可能带上已签名的原始交易', () => {
    const raw = `boom 0x${'ab'.repeat(40)} tail`;
    const out = redact(raw);
    assert.ok(!out.includes('ab'.repeat(40)), '长十六进制串必须被抹掉');
    assert.match(out, /已隐去/);
    assert.match(out, /boom/, '有信息量的部分要留着，否则排障无从下手');
  });

  test('redact 截断过长文本 —— 不把整个请求体渲染到面板上', () => {
    assert.ok(redact('x'.repeat(5000)).length <= 400);
  });
});
