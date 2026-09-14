// 最小 ABI 的每一项都必须在**部署的字节码**里对得上（功能 005 / T004 / T025）。
//
// ## 为什么不从外部取整份 ABI
//
// research R-03 列了三条途径：vendor 外部 ABI、从字节码反推、改用 Avalanche CLI。
// 第三条与 ADR-0008 冲突（CLI 已退出运行时）。第二条 R-03 自己标了"不推荐"。
// 第一条要引入一份外部数据并**自行论证它与 CLI v1.9.6 对得上** —— 而那份论证
// 只能靠人读版本号，正是本项目反复栽过的那种"自述式合规"。
//
// 实际做法是第四条：**提出候选签名，用 keccak 命中来确认。**
//
//   - 函数：`keccak256(sig).slice(0,10)` 必须出现在字节码的某个 `PUSH4` 操作数里
//   - 事件：`keccak256(sig)` 必须出现在某个 `PUSH32` 操作数里
//
// 命中就是确认，**未命中的一律不写进 ABI**。这既不是反推（我没从字节码猜签名），
// 也不需要外部来源，而且**合约一变守卫就红**。
//
// ## 为什么能离线
//
// `blockchain/genesis/validator-manager.alloc.json` 里存着创世注入的完整字节码
// （实现 30920 字符），而那正是链上跑着的那份 —— 2026-09-14 对活链
// `eth_getCode` 核对过长度一致。所以本套件进 `npm test`，不需要起链。
//
// ## 这条守卫**不**证明什么
//
// 选择器只证明**签名存在**，不证明语义：参数含义、返回布局它都说不了。
// 返回布局是在活链上逐字段解码核实的（research V-20…V-24），
// 而那部分由 tests/integration/member-set.test.mjs 对着活链守。
// **别把这条守卫当成"ABI 完全正确"的证明。**
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { keccak256, toHex } from 'viem';
import { REPO_ROOT, readJson } from '../../tools/protocol/load.mjs';

const ABI_PATH = resolve(REPO_ROOT, 'tools', 'membership', 'abi', 'validator-manager.json');
const ALLOC_PATH = resolve(REPO_ROOT, 'blockchain', 'genesis', 'validator-manager.alloc.json');

const doc = readJson(ABI_PATH);
const alloc = readJson(ALLOC_PATH);
const implAddr = doc.provenance.implementation;
const code = alloc.alloc[implAddr]?.code ?? '';

/** 扫出所有 PUSHn 的操作数（n = 4 或 32）。solidity 的分发表与事件 topic 都在其中。 */
const pushOperands = (hex, opcode, bytes) => {
  const out = new Set();
  const width = bytes * 2;
  for (let i = 0; i + 2 + width <= hex.length; i += 2) {
    if (hex.slice(i, i + 2) === opcode) out.add(`0x${hex.slice(i + 2, i + 2 + width)}`);
  }
  return out;
};

const body = code.slice(2);
const PUSH4 = pushOperands(body, '63', 4);
const PUSH32 = pushOperands(body, '7f', 32);

/** 把一个 ABI 项还原成规范签名字符串（tuple 展开成括号形式）。 */
const typeOf = (p) => (p.type.startsWith('tuple')
  ? `(${p.components.map(typeOf).join(',')})${p.type.slice('tuple'.length)}`
  : p.type);
const sigOf = (item) => `${item.name}(${item.inputs.map(typeOf).join(',')})`;

const functions = doc.abi.filter((x) => x.type === 'function');
const events = doc.abi.filter((x) => x.type === 'event');

describe('夹具与前提', () => {
  test('创世夹具里有实现合约的字节码', () => {
    assert.ok(code.startsWith('0x'), `alloc 里找不到 ${implAddr} 的 code`);
    assert.ok(body.length > 10000,
      `字节码只有 ${body.length} 个字符 —— 太短，不像 ValidatorManager 的实现`);
  });

  test('扫描器确实扫到了东西（防"什么都没扫到所以全绿"）', () => {
    assert.ok(PUSH4.size > 20, `只扫出 ${PUSH4.size} 个 PUSH4 操作数`);
    assert.ok(PUSH32.size > 5, `只扫出 ${PUSH32.size} 个 PUSH32 操作数`);
  });

  test('ABI 里函数与事件都不为空', () => {
    assert.ok(functions.length >= 8, `只有 ${functions.length} 个函数`);
    assert.ok(events.length >= 4, `只有 ${events.length} 个事件`);
  });

  test('出处记录了取得方式与核验对象（不是一句"从官方仓库拿的"）', () => {
    for (const k of ['verifiedAgainst', 'implementation', 'avalancheCliVersion', 'method']) {
      assert.ok(doc.provenance[k], `provenance 缺 ${k}`);
    }
    assert.ok(doc.provenance.method.length > 30, 'method 太短 —— 下一个人无从复核');
  });

  test('ABI 声明的 CLI 版本与创世夹具的出处一致', () => {
    assert.equal(doc.provenance.avalancheCliVersion, alloc.extractedFrom.avalancheCliVersion,
      'ABI 与字节码来自不同版本的 CLI —— 选择器可能碰巧还对得上，而语义已经变了');
  });
});

describe('**每个函数的选择器都在字节码里**', () => {
  for (const f of functions) {
    const sig = sigOf(f);
    test(`${sig}`, () => {
      const sel = keccak256(toHex(sig)).slice(0, 10);
      assert.ok(PUSH4.has(sel),
        `选择器 ${sel} 不在实现字节码的 PUSH4 操作数里。\n`
        + `  签名 \`${sig}\` 在这份合约上**不存在** —— 调它会 revert，或更糟：\n`
        + '  命中另一个恰好同选择器的函数。\n'
        + '  **不要改断言。** 要么这个签名写错了，要么合约换了版本；\n'
        + '  后者的话整份 ABI 都要重新核验（连同返回布局，那部分要对活链做）。');
    });
  }
});

describe('**每个事件的 topic0 都在字节码里**', () => {
  for (const e of events) {
    const sig = sigOf(e);
    test(`${sig}`, () => {
      const t = keccak256(toHex(sig));
      assert.ok(PUSH32.has(t),
        `topic0 ${t.slice(0, 18)}… 不在实现字节码的 PUSH32 操作数里。\n`
        + `  事件 \`${sig}\` 不是这份合约发出的那个。\n`
        + '  **这条尤其要紧**：链上成员集合只能从事件重建（合约没有枚举函数），\n'
        + '  事件签名错了，读出来的会是一个空集合 —— 而空集合不报错，\n'
        + '  只会让"链上有、声明里没有"这种漂移永远检测不到。');
    });
  }
});

describe('保护范围没有缩过头', () => {
  test('一个**编造的**签名必须不在字节码里（否则上面全是空跑）', () => {
    // 若 PUSH4 集合大到什么都能命中，上面那组断言就毫无意义。
    for (const fake of ['definitelyNotAFunction()', 'karmachainFakeEntry(uint256,address)']) {
      const sel = keccak256(toHex(fake)).slice(0, 10);
      assert.ok(!PUSH4.has(sel), `编造的签名 ${fake} 竟然命中了 —— 扫描器的假阳性太高`);
    }
  });

  test('US2/US3 真正要调的五个入口一个都不能少', () => {
    // 少一个就不是"ABI 不全"，而是某一步做不成：
    //   注册两步 + 退出两步 + 重试。FR-016 要求每一步可见且可重试。
    const want = [
      'initiateValidatorRegistration', 'completeValidatorRegistration',
      'initiateValidatorRemoval', 'completeValidatorRemoval',
      'resendRegisterValidatorMessage',
    ];
    const have = new Set(functions.map((f) => f.name));
    for (const n of want) assert.ok(have.has(n), `ABI 里缺 ${n} —— 对应那一步做不成`);
  });

  test('读取成员集合所需的三个入口都在', () => {
    const have = new Set(functions.map((f) => f.name));
    for (const n of ['registeredValidators', 'getValidator', 'l1TotalWeight']) {
      assert.ok(have.has(n), `ABI 里缺 ${n} —— 读不出链上实际成员，三种漂移都无从分类`);
    }
  });
});
