// ACP-77 第三步：P 链交易之前的三个判定（功能 005 / T027）。
//
// ## 为什么偏偏是这三个
//
// 第三步是四步里**唯一花钱**、且成功之后若第四步失败会在链上留下
// 「P 链认了、合约没认」中间态的那一步。它自己的主体是 I/O（查 feeState、
// 查 UTXO、构造、签名、提交），测不动也不该测；但**决定要不要提交、
// 以及提交什么**的三个判断是纯的：
//
//   `payerExpectation`    新成员该跟谁一致（既有成员的续费地址与余额）
//   `assertPayerAccount`  用来签名的密钥是不是那个账户
//   `computeFee`          会花多少钱
//
// 这三个原先都嵌在别处：前一个内联在命令行分支里（**只有真跑一次 CLI
// 才会被执行**），后两个在 step3 的函数体里。判定藏在表达式里，就等于没有判定。
//
// ## 其中一个原先根本不会变红
//
// 地址核对初版写成 `if (expectedPAddress && pAddress !== expectedPAddress)`。
// 调用方忘了传期望值，检查就**静默不做** —— 而调用处读起来和核过了一模一样。
// 本套件的 `缺期望值本身就是错误` 那条守的正是这个。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  payerExpectation, assertPayerAccount, computeFee,
} from '../../tools/membership/add-validator.mjs';

// 基准取自 2026-09-15 第三步的**实测干跑**（对着真链构造，未提交）：
//   pAddress  P-custom18jma8ppw3nhx5r4ap8clazz0dps7rv5u9xde7p
//   utxoCount 2   spent 19999999499750228   change 19999999399703378
//   balance   100000000（0.1 AVAX，与既有成员相同）   fee 46850
const REAL = Object.freeze({
  pAddress: 'P-custom18jma8ppw3nhx5r4ap8clazz0dps7rv5u9xde7p',
  spent: 19999999499750228n,
  change: 19999999399703378n,
  balance: 100000000n,
  fee: 46850n,
});

/** 造一个 P 链既有成员的样子（只含本判定要用的两个字段）。 */
const member = (addr, balance) => ({
  remainingBalanceOwner: { addresses: [addr] },
  balance: String(balance),
});

describe('payerExpectation：新成员跟既有成员一致，不唯一时不猜', () => {
  test('五个同质成员 → 取出那唯一的地址与余额', () => {
    const vs = Array.from({ length: 5 }, () => member(REAL.pAddress, REAL.balance));
    const got = payerExpectation(vs);
    assert.equal(got.expectedPAddress, REAL.pAddress);
    assert.equal(got.balance, REAL.balance);
    assert.equal(typeof got.balance, 'bigint',
      'balance 必须是 BigInt —— newRegisterL1ValidatorTx 收的是 BigInt，'
      + '而 Number 在 nAVAX 这个量级上会静默丢精度');
  });

  test('**续费地址分叉 → 抛**（该跟谁一致要人来定）', () => {
    const vs = [member(REAL.pAddress, REAL.balance), member('P-custom1elseelseelse', REAL.balance)];
    assert.throws(() => payerExpectation(vs), /不唯一/,
      '两个不同的续费地址被放行了 —— 工具会替人挑一个，'
      + '而挑错的后果是新成员的续费地址与一部分既有成员分叉，且不会报错');
  });

  test('**余额分叉 → 抛**', () => {
    const vs = [member(REAL.pAddress, REAL.balance), member(REAL.pAddress, REAL.balance * 2n)];
    assert.throws(() => payerExpectation(vs), /不唯一/,
      '两种不同的余额被放行了 —— 新成员的续费节奏会与既有的不同，几个月后才暴露');
  });

  test('**一个成员都没有 → 抛**（推不出该用什么）', () => {
    for (const empty of [[], null, undefined]) {
      assert.throws(() => payerExpectation(empty), /没有任何既有成员/,
        `${JSON.stringify(empty)} 没抛 —— 空集合下任何"取出唯一值"的写法都会`
        + '拿到 undefined，而带着 undefined 去构造交易，报出来的是别的错');
    }
  });

  test('地址相同但有成员缺 remainingBalanceOwner → 视为只有一个地址，仍通过', () => {
    // 这一条是**边界说明**而不是纵容：缺字段的成员贡献不出地址，
    // 于是集合里仍只有一个 —— 判定按"出现过的地址"算，不按"成员数"算。
    const vs = [member(REAL.pAddress, REAL.balance), { balance: String(REAL.balance) }];
    assert.equal(payerExpectation(vs).expectedPAddress, REAL.pAddress);
  });
});

describe('assertPayerAccount：两个参数都必需', () => {
  test('地址一致 → 通过', () => {
    assert.equal(assertPayerAccount({
      pAddress: REAL.pAddress, expectedPAddress: REAL.pAddress,
    }), true);
  });

  test('**地址不符 → 抛，且报出两个地址**', () => {
    assert.throws(
      () => assertPayerAccount({ pAddress: REAL.pAddress, expectedPAddress: 'P-custom1other' }),
      (err) => err.message.includes(REAL.pAddress) && err.message.includes('P-custom1other'),
      '报错里没有同时给出两个地址 —— 只说"不是同一个账户"的话，'
      + '看的人还得自己去查期望值是多少');
    });

  test('**缺期望值本身就是错误**（这是那条不会变红的守卫的修复）', () => {
    for (const missing of [undefined, null, '']) {
      assert.throws(
        () => assertPayerAccount({ pAddress: REAL.pAddress, expectedPAddress: missing }),
        /没有传入期望的 P 链地址/,
        `expectedPAddress = ${JSON.stringify(missing)} 时没抛 —— 那就回到了`
        + '「忘了传就静默不检查」，而调用处读起来和核过了一模一样。'
        + '**"核不了"不等于"核过了"。**');
    }
  });

  test('缺本次地址也抛（不拿 undefined 去比较）', () => {
    assert.throws(
      () => assertPayerAccount({ pAddress: undefined, expectedPAddress: REAL.pAddress }),
      /没有传入本次要用的 P 链地址/);
  });

  test('两个错因分开报 —— 修法不同', () => {
    const missing = (() => {
      try { assertPayerAccount({ pAddress: REAL.pAddress }); return ''; } catch (e) { return e.message; }
    })();
    const mismatch = (() => {
      try {
        assertPayerAccount({ pAddress: REAL.pAddress, expectedPAddress: 'P-custom1other' });
        return '';
      } catch (e) { return e.message; }
    })();
    assert.notEqual(missing, mismatch,
      '缺期望值与地址不符报了同一句话 —— 前者要改调用方，后者要换账户');
  });
});

describe('computeFee：会花多少，以及算错时停下来', () => {
  test('实测那笔的费用能被复现出来', () => {
    const got = computeFee({
      inputAmounts: [REAL.spent], outputAmounts: [REAL.change], balance: REAL.balance,
    });
    assert.equal(got.fee, REAL.fee, '算出的费用与 2026-09-15 实测干跑的不符');
    assert.equal(got.spent, REAL.spent);
    assert.equal(got.change, REAL.change);
  });

  test('多个 UTXO 与多个找零输出都要求和（实测那笔动用了 2 个 UTXO）', () => {
    const got = computeFee({
      inputAmounts: [REAL.spent / 2n, REAL.spent - REAL.spent / 2n],
      outputAmounts: [REAL.change - 1000n, 1000n],
      balance: REAL.balance,
    });
    assert.equal(got.fee, REAL.fee, '分成两个输入/两个输出后总额变了 —— 某一侧没有求和');
  });

  test('字符串金额也接受（JSON-RPC 回来的是字符串）', () => {
    const got = computeFee({
      inputAmounts: [String(REAL.spent)], outputAmounts: [String(REAL.change)],
      balance: String(REAL.balance),
    });
    assert.equal(got.fee, REAL.fee);
  });

  test('**费用为零 → 抛**（这笔交易不可能免费）', () => {
    assert.throws(() => computeFee({
      inputAmounts: [REAL.balance], outputAmounts: [0n], balance: REAL.balance,
    }), /不可能为零或负数/,
      '零费用被当成了有效结果 —— 它只可能来自算式或对交易形状的理解有误，'
      + '而打印出来的会是一个看着像费用的错数');
  });

  test('**费用为负 → 抛**（找零比花掉的还多，形状理解有误）', () => {
    assert.throws(() => computeFee({
      inputAmounts: [REAL.change], outputAmounts: [REAL.spent], balance: REAL.balance,
    }), /不可能为零或负数/);
  });

  test('**费用吃掉全部花费 → 抛**（找零与 balance 都没算进去）', () => {
    assert.throws(() => computeFee({
      inputAmounts: [REAL.spent], outputAmounts: [], balance: 0n,
    }), /不小于花掉的总额/,
      '"费用 = 花掉的全部"被放行了 —— 那正是取错了输出字段时会得到的结果');
  });

  test('报错里带上三个数，让人能自己核', () => {
    const msg = (() => {
      try {
        computeFee({ inputAmounts: [REAL.balance], outputAmounts: [0n], balance: REAL.balance });
        return '';
      } catch (e) { return e.message; }
    })();
    for (const n of [REAL.balance]) {
      assert.ok(msg.includes(String(n)), `报错里没有 ${n} —— 只说"算式有误"的话无从下手`);
    }
  });
});
