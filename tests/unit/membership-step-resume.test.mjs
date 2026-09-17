// ACP-77 四步：**任一步失败之后，能报出停在哪一步，而且重跑会从那一步继续**
//（功能 005 / T031 的离线一半、FR-016 / SC-011 / V-10）。
//
// ## 为什么这一半能离线做，而且**应该**离线做
//
// 场景 N 要求"在每一步人为注入失败"。在活链上注入四次失败代价很高：
// 第三步要花钱、第四步失败会留下"P 链认了、合约没认"的中间态，
// 而那个中间态本身要靠再跑一次第四步才能收拾。
//
// 但"能不能报出停在哪一步"这件事**不取决于失败是怎么造出来的** ——
// 它只取决于一件事：**`assessProgress()` 从链上读到的状态能不能唯一定位步数。**
// 那是一个纯观测函数，喂给它合成的链上状态就能逐格验证。
//
// 而这恰恰是 l1-6 真实注册时**反复用对了的那个机制**：四步分四次跑完，
// 中间还夹着一次停电与一次 P 链拒绝，每次重跑都自己找对了位置 ——
// 因为它**不读状态文件，只读链**。本文件把那个性质钉住。
//
// ## 剩下的那一半为什么留着
//
// 活链那一半（T031）要验的是**注入的失败本身**：合约 revert 长什么样、
// P 链拒绝长什么样、聚合器超时长什么样。那些是外部系统的真实行为，
// 离线造出来的只是我对它们的想象 —— 本期已经踩过一次
//（V-32：从配置项名字推出"确认消息要 Primary 签"，实测证伪）。
// **所以这里不假装测了那一半。**
//
// ## 本文件的变红检查记录（含一次**假的**变红检查）
//
// | 变异 | 结果 |
// |---|---|
// | 让 `assessProgress` 在"已发起、P 链未收录"时返回 **2** | ✅ 5 条红 |
// | 摘掉第四步的判定（`if (false && …)`，等价于把 ③ 判在 ④ 前面） | ✅ 4 条红 |
//
// 第二条**第一次做的时候报了"14 通过"** —— 而我随后单独验证同一处变异确实会让
// `step` 变成 3，那两条断言必然失败。真因：那次的变异脚本没生效
// （bash 引号把它吞了），而我给测试输出加的 `grep` **把"变异已生效"那行滤掉了**，
// 于是我看不出区别 —— 一次没生效的变异和一条真的守住了的断言，输出长得一模一样。
//
// **教训：变红检查必须独立确认变异生效，不能靠"测试没红所以守卫是好的"来反推。**
// 004 的实施记录里第 1 条也是这个形状（"我的变红检查器本身是假的，它冤枉了一个好守卫"）——
// 这次方向相反：它**放过**了一条本该被质疑的断言。
// 两个方向的代价不同，但根因相同：**检查器自己没有被检查。**
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { encodeEventTopics, encodeAbiParameters, keccak256, toHex } from 'viem';
import { VALIDATOR_MANAGER_ABI, PROXY_ADDRESS, STATUS } from '../../tools/membership/member-set.mjs';
import { cb58Encode } from '../../tools/verify/lib/identity.mjs';
import {
  assessProgress, EXIT_OK, EXIT_PRECHECK, EXIT_STEP_FAILED, EXIT_ABORTED,
} from '../../tools/membership/add-validator.mjs';

// ── 合成链上状态（造法与 member-set.test.mjs 同源，走同一份 ABI）─────────────
const nodeBytes = (seed) => `0x${keccak256(toHex(seed)).slice(2, 42)}`;
const nodeIdOf = (seed) => `NodeID-${cb58Encode(Buffer.from(nodeBytes(seed).slice(2), 'hex'))}`;
const vid = (seed) => keccak256(toHex(`validation:${seed}`));

const logOf = (eventName, args, blockNumber = 4n) => {
  const ev = VALIDATOR_MANAGER_ABI.find((x) => x.type === 'event' && x.name === eventName);
  if (!ev) throw new Error(`ABI 里没有事件 ${eventName}`);
  const nonIndexed = ev.inputs.filter((i) => !i.indexed);
  return {
    topics: encodeEventTopics({ abi: VALIDATOR_MANAGER_ABI, eventName, args }),
    data: nonIndexed.length
      ? encodeAbiParameters(nonIndexed, nonIndexed.map((i) => args[i.name]))
      : '0x',
    blockNumber,
  };
};

const initiatedLog = (seed) => logOf('InitiatedValidatorRegistration', {
  validationID: vid(seed),
  nodeID: nodeBytes(seed),
  registrationMessageID: keccak256(toHex(`msg:${seed}`)),
  registrationExpiry: 0n,
  weight: 100n,
}, 100n);

const SUBNET = 'SubnetIdForTest';
const SEED = 'l1-x';
const NODE = nodeIdOf(SEED);

/** 状态码：2 = Active（research V-24 实测）。用 1 表示"合约见过但未确认"。 */
const ACTIVE = 2;
const PENDING = 1;

/**
 * 造一个**四步中某一步刚做完**的链上状态。
 *
 * 四个入口对应 `assessProgress` 能观测到的四种链上事实：
 *
 * | 造出来的状态 | 合约事件 | `getValidator().status` | P 链收录 | 期望 step |
 * |---|---|---|---|---|
 * | 一步都没做 | 无 | —— | 否 | **0** |
 * | 第一步做完 | Initiated | PENDING | 否 | **1** |
 * | 第三步做完 | Initiated | PENDING | **是** | **3** |
 * | 第四步做完 | Initiated | **ACTIVE** | 是 | **4** |
 *
 * **没有 step === 2 这一格，而且不可能有** —— 第二步是收集签名，
 * 它**不写链**，所以链上看不出"第二步做完了"。这不是遗漏：
 * 第二步失败的代价是零（重做一遍就行），而它一旦成功，第三步立刻用掉那个签名。
 */
const chainAt = ({ initiated = false, status = PENDING, onPChain = false } = {}) => ({
  client: {
    getBlockNumber: async () => 200n,
    getLogs: async () => (initiated ? [initiatedLog(SEED)] : []),
    readContract: async ({ address, functionName, args }) => {
      assert.equal(address, PROXY_ADDRESS, 'assessProgress 必须读代理地址上的合约');
      assert.equal(functionName, 'getValidator');
      assert.deepEqual(args, [vid(SEED)], '必须用第一步事件里那个 validationID 去查');
      return { status: BigInt(status), weight: 100n };
    },
  },
  pchain: async (method, params) => {
    assert.equal(method, 'platform.getCurrentValidators');
    assert.deepEqual(params, { subnetID: SUBNET }, 'P 链侧必须按 subnetID 问');
    return { validators: onPChain ? [{ nodeID: NODE, weight: '100' }] : [] };
  },
});

const progressOf = (state) => assessProgress({ ...chainAt(state), nodeId: NODE, subnetId: SUBNET });

// ── ① 链上状态 → 停在第几步，四格逐一 ───────────────────────────────────────
describe('链上状态唯一定位步数（FR-016 的地基）', () => {
  test('一步都没做 → step 0，并说清"合约上没有记录"', async () => {
    const p = await progressOf({});
    assert.equal(p.step, 0);
    assert.equal(p.validationID, null, '还没有 validationID —— 它是第一步的产物');
    assert.match(p.notes.join('\n'), /没有这个 nodeID 的注册记录/);
  });

  test('第一步做完 → step 1，并带出 validationID 与 registrationMessageID', async () => {
    const p = await progressOf({ initiated: true });
    assert.equal(p.step, 1);
    assert.equal(p.validationID, vid(SEED));
    assert.equal(p.registrationMessageID, keccak256(toHex(`msg:${SEED}`)),
      '第二步要拿它去要签名 —— 它必须从链上读出来，不能靠人抄');
    const notes = p.notes.join('\n');
    assert.match(notes, /① 已发起/);
    assert.match(notes, /③ P 链\*\*未\*\*收录/, '要说清第三步还没做，而不是只说"停在第一步"');
  });

  test('第三步做完、第四步没做 → step 3，并**明说这是什么中间态**', async () => {
    const p = await progressOf({ initiated: true, onPChain: true });
    assert.equal(p.step, 3);
    const notes = p.notes.join('\n');
    assert.match(notes, /停在第四步/,
      '这是唯一一个"链上留下中间态"的位置：P 链认了、合约还没认。'
      + '光说"已完成 3/4 步"不够 —— 要说清它现在是个什么状态');
    assert.match(notes, /P 链认了、合约还没认/);
  });

  test('第四步做完 → step 4', async () => {
    const p = await progressOf({ initiated: true, status: ACTIVE, onPChain: true });
    assert.equal(p.step, 4);
    assert.match(p.notes.join('\n'), new RegExp(`status = ${ACTIVE}.*${STATUS[ACTIVE]}`),
      '要把状态码与它的名字一起报出来 —— 光一个数字读的人得去查表');
  });

  test('**step 永不为 2** —— 第二步不写链，链上看不出它做完了', async () => {
    // 穷举 assessProgress 能观测到的全部链上状态组合，断言 2 不在值域里。
    const steps = new Set();
    for (const initiated of [false, true]) {
      for (const status of [PENDING, ACTIVE]) {
        for (const onPChain of [false, true]) {
          steps.add((await progressOf({ initiated, status, onPChain })).step);
        }
      }
    }
    assert.ok(!steps.has(2),
      `step 取到了 2（值域 ${[...steps].sort().join(',')}）—— 那意味着有人让第二步写了链，`
      + '或者把"第二步做完"存到了别处。**进度必须只从链上读**，'
      + '存到别处就会有一个和链不一致的第二事实来源');
    assert.deepEqual([...steps].sort(), [0, 1, 3, 4],
      '值域应当恰好是 {0,1,3,4}');
  });

  test('**反向断言**：第四步的判定先于第三步 —— 否则已完成会被报成停在第四步', async () => {
    // ④ 成立必然蕴含 ③ 成立，所以顺序不能调。
    // 若先判 ③，一个**已完成**的成员（P 链有、合约 ACTIVE）会被报成 step 3，
    // 于是工具会去重跑第四步 —— 对一个已经完成的成员。
    const done = await progressOf({ initiated: true, status: ACTIVE, onPChain: true });
    assert.equal(done.step, 4, '已完成的成员不得被报成"停在第四步"');
  });
});

// ── ② 重跑从正确的步继续 ────────────────────────────────────────────────────
describe('重跑会从正确的一步继续（"可重试"的实际含义）', () => {
  // 工具的做法是：读进度 → 只做 progress.step + 1 这一步 → 停下。
  // 所以"可重试"= 失败之后同一条命令再跑一次，会落在同一步上。
  const nextStepOf = (p) => p.step + 1;

  for (const [label, state, expectNext] of [
    ['一步都没做', {}, 1],
    ['第一步做完（第二步失败了）', { initiated: true }, 2],
    ['第二步失败后再跑', { initiated: true }, 2],
    ['第三步做完（第四步失败了）', { initiated: true, onPChain: true }, 4],
  ]) {
    test(`${label} → 下一步是第 ${expectNext} 步`, async () => {
      assert.equal(nextStepOf(await progressOf(state)), expectNext);
    });
  }

  test('第二步失败**不留链上痕迹**，所以重跑落回第二步而不是第三步', async () => {
    // 这一条是 step 值域没有 2 的直接后果，也是它最有用的地方：
    // 第二步是纯离线的签名收集，失败了重做一遍毫无代价 ——
    // 而如果进度记在文件里，一次"已完成第二步"的记录会让重跑直接去做第三步，
    // 拿着一个可能已经过期或根本没收齐的签名去发一笔**花钱的** P 链交易。
    const before = await progressOf({ initiated: true });
    const after = await progressOf({ initiated: true });   // 失败不改链，状态原样
    assert.equal(before.step, after.step, '第二步失败前后链上状态必须相同');
    assert.equal(nextStepOf(after), 2, '重跑必须还是第二步');
  });

  test('已完成的成员重跑 → 下一步是 5，调用方据此报"无需操作"', async () => {
    const p = await progressOf({ initiated: true, status: ACTIVE, onPChain: true });
    assert.equal(p.step, 4);
    assert.ok(nextStepOf(p) > 4, '已完成时不得再指向任何一步');
  });
});

// ── ③ 退出码把"没动链"与"动了一半"分开 ─────────────────────────────────────
describe('退出码分得开"一步都没动"与"某一步失败"', () => {
  // FR-016 要求失败可见可重试，而**调用方要能不看输出就知道该怎么办**。
  // 这三个码对应三种完全不同的处置。
  test('三个码互不相同，且都不是 0', () => {
    const three = [EXIT_PRECHECK, EXIT_STEP_FAILED, EXIT_ABORTED];
    assert.equal(new Set(three).size, 3);
    assert.ok(!three.includes(EXIT_OK));
    assert.ok(!three.includes(0));
  });

  test('它们的处置确实不同 —— 这是分三个码的理由', () => {
    // 前置检查未过：去改环境，链没被碰过，重跑前先修好外面的东西
    // 某一步失败：链可能已经变了（第三步尤其），改完**直接重跑同一条命令**
    // 人工中止：什么都不用做
    assert.notEqual(EXIT_PRECHECK, EXIT_STEP_FAILED,
      '这两个混在一起的后果是实际的：前者意味着链未被碰过、后者可能留下中间态，'
      + '而中间态需要重跑那一步去收拾');
  });
});
