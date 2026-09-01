// T021（后半）：在 scripts/devnet-stop 之后运行 —— RPC 端口必须不再有人监听（FR-003 无残留）。
// 运行：KARMACHAIN_EXPECT_STOPPED=1 npm run test:integration   （仅执行本文件的断言；未设变量时跳过）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rpcUrl } from '../../tools/verify/lib/rpc.mjs';

test('after devnet-stop the RPC endpoint refuses connections', { skip: !process.env.KARMACHAIN_EXPECT_STOPPED && 'set KARMACHAIN_EXPECT_STOPPED=1 after scripts/devnet-stop' }, async () => {
  let reached = false;
  try {
    await fetch(rpcUrl, { method: 'POST', body: '{}', signal: AbortSignal.timeout(3000) });
    reached = true;
  } catch { /* expected: ECONNREFUSED / timeout */ }
  assert.equal(reached, false, `something still answers at ${rpcUrl} after stop`);
});
