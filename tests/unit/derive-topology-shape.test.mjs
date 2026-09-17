// `deriveTopology()` 的输出形状**不因分家而变**（功能 005 / T008 / SC-003）。
//
// ## 为什么这条是本期最强的不回归判据
//
// 分家把 `topology` / `endpoints` / `primaryNetwork` / `validators.{count,nodes}`
// 搬到了另一个文件，而这些正是 `deriveTopology()` 的全部输入。
// 实现上选择**在装载层合并**（`loadProtocol()` 返回一个对象），
// 让三十多个下游消费者一行不改 —— 但「一行不改」这句话本身需要被证明，
// 不能靠"跑一遍看起来没坏"。
//
// 所以在动手之前，先把分家**之前**两种形态的完整派生结果冻进
// `tests/fixtures/derive-topology-before-005.json`，然后要求分家之后
// **逐字节相同**。
//
// ## 这份夹具是「之前」的照片，不是「应该」的样子
//
// 它记录的是 2026-09-11 分家前一刻的真实输出。**日后有意改变派生逻辑时，
// 要连同这份夹具一起改，并在提交信息里写明改了什么、为什么** ——
// 不要因为它红了就重新生成一份盖过去。那等于把照片换成现场，
// 然后宣布现场与照片一致。
//
// ## 夹具的有意改动记录（照上面那条规矩办）
//
// **2026-09-17 / T068**：`local` 形态里 `primary-1` 与 `primary-2` 的地址
// 从 `.16` / `.17` 改为 `.41` / `.42`。**只改了这两行**（`git diff` 是 2 加 2 减），
// 不是重新生成。
//
// 原因：单机形态的容器地址原先由 `topology.nodes` 的**数组下标**派生，
// 于是把新节点插在中间会让后面每个节点改号。改成按角色分块、
// 块内用该角色自己的稳定序号（验证者用 `validatorIndex`，Primary 用声明的
// `primaryFirstHost` 加它在 Primary 里的序号）。
//
// **五个验证者的地址一个都没变**（`validatorIndex` 1…5 → `.11`…`.15`）——
// 动的只有两个 Primary，因为它们得从验证者的号段里挪出来。
// 跨机形态（`lan`，也就是真实部署）**逐字节未变**，本文件的 lan 那半个套件全绿。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT, loadProtocol, deriveTopology } from '../../tools/protocol/load.mjs';

const FIXTURE_PATH = resolve(REPO_ROOT, 'tests', 'fixtures', 'derive-topology-before-005.json');
const BEFORE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

// 地址可被环境变量覆盖（T060）。夹具是在**无覆盖**下拍的，
// 带着覆盖跑会得到一份不同却同样正确的输出 —— 那时红的是环境，不是代码。
const OVERRIDDEN = Boolean(process.env.KARMACHAIN_ADDRESS_OVERRIDE);

const config = loadProtocol();
const forDeployment = (name) => deriveTopology({
  ...config,
  topology: { ...config.topology, activeDeployment: name },
});

describe('夹具本身是可信的', () => {
  test('两种形态都在夹具里', () => {
    assert.deepEqual(Object.keys(BEFORE).sort(), ['lan', 'local']);
  });

  test('夹具覆盖了 protocol 里声明的每一种形态', () => {
    assert.deepEqual(
      Object.keys(BEFORE).sort(),
      Object.keys(config.topology.deployments).sort(),
      '新增了一种部署形态而夹具没跟上 —— 那种形态的派生结果没有任何锁');
  });

  test('夹具不是空壳（防止"与空对象逐字节相同"式的假绿）', () => {
    for (const [name, snap] of Object.entries(BEFORE)) {
      assert.ok(snap.topologyNodes?.length > 0, `${name} 的 topologyNodes 是空的`);
      assert.ok(snap.failureDomains?.length > 0, `${name} 的 failureDomains 是空的`);
      assert.ok(snap.faultTolerance, `${name} 缺 faultTolerance`);
    }
  });
});

// ## 成员增加之后，这份夹具怎么比（2026-09-14）
//
// 加第六个验证者时这一组红了四条。**夹具没有错，被比较的东西也没有错** ——
// 夹具是"分家前一刻"的照片，而成员增加**理应**改变派生输出。
//
// 处理方式：**把比对范围限定在拍照时存在的那些节点上**，其余视为新增。
// 这保住了夹具的本意（分家没有改变派生），同时容许成员变化 —— 而那正是 005 做的事。
//
// **刻意不重新生成一份盖过去。** 那等于把照片换成现场，然后宣布现场与照片一致。
// 也**刻意不比 `faultTolerance` 的冻结数值**：验证者数变了，⌊n/4⌋ 与边界数都跟着变。
// 改为断言**规则**没变 —— 夹具当时的数字与现在的数字必须服从同一条公式。
describe('分家之后，**拍照时存在的那些节点**的派生结果逐字节相同（SC-003）', { skip: OVERRIDDEN ? '设置了 KARMACHAIN_ADDRESS_OVERRIDE，夹具不适用' : false }, () => {
  for (const name of Object.keys(BEFORE)) {
    const before = BEFORE[name];
    const after = forDeployment(name);
    const frozenIds = before.topologyNodes.map((n) => n.id);

    test(`形态 \`${name}\`：每个旧节点的派生条目未变`, () => {
      const byId = new Map(after.topologyNodes.map((n) => [n.id, n]));
      for (const old of before.topologyNodes) {
        assert.deepEqual(byId.get(old.id), old,
          `形态 ${name} 里 \`${old.id}\` 的派生结果与分家前不同。\n`
          + '  分家的**全部承诺**就是「合并视图与分家前逐字段相同，下游一行不改」。\n'
          + '  这里不同，意味着某个消费者会拿到与它预期不同的东西 ——\n'
          + '  而下游有三十多处，逐个复查的代价远高于在这里对齐。');
      }
    });

    test(`形态 \`${name}\`：旧节点的**相对顺序**未变（生成物按遍历顺序写出）`, () => {
      // `deepEqual` 不看顺序，但 compose / nginx / 文档都是按遍历顺序写的。
      // 顺序一变，生成物就会变字节，而语义没变 —— 红在一个毫无信息量的地方。
      assert.deepEqual(
        after.topologyNodes.map((n) => n.id).filter((id) => frozenIds.includes(id)),
        frozenIds,
        `形态 ${name} 里旧节点的相对顺序变了`);
    });

    test(`形态 \`${name}\`：拍照时的故障边界除**成员列表**外原样都在`, () => {
      // 不能要求边界"逐字节原样"：单边界形态（local）下新成员**必然**加进那个
      // 唯一的边界，它的 `nodes` 因此合法地变长。跨机形态则是新开一个边界、
      // 既有边界不动。两种都要容许，而**除成员列表之外的字段一律不许变**。
      const byId = new Map(after.failureDomains.map((d) => [d.id, d]));
      for (const old of before.failureDomains) {
        const now = byId.get(old.id);
        assert.ok(now, `形态 ${name} 的边界 \`${old.id}\` 不见了`);
        // `validatorCount` 也排除：它是成员列表的**派生计数**，不是声明。
        // 单独断言它只增不减 —— 排除一个字段不等于不管它。
        const { nodes: oldNodes, validatorCount: oldCount, ...oldRest } = old;
        const { nodes: nowNodes, validatorCount: nowCount, ...nowRest } = now;
        assert.ok((nowCount ?? 0) >= (oldCount ?? 0),
          `形态 ${name} 的边界 \`${old.id}\` 的验证者数从 ${oldCount} 降到 ${nowCount}`
          + ' —— 加成员不该让某个边界少掉验证者');
        assert.deepEqual(nowRest, oldRest,
          `形态 ${name} 的边界 \`${old.id}\` 的**非成员字段**变了`
          + '（平台 / 地址 / 共享失效因素）—— 加成员不该动这些');
        // 旧成员必须**全部还在且保序**；新成员只能是追加
        assert.deepEqual(nowNodes.filter((id) => oldNodes.includes(id)), oldNodes,
          `形态 ${name} 的边界 \`${old.id}\` 里旧成员被移走或换了顺序 ——`
          + ' 那不是"加一个成员"，而是改了既有归属');
      }
    });

    test(`形态 \`${name}\`：容错的**规则**未变（数值随 n 变，公式不变）`, () => {
      const f = (n) => Math.floor(n / 4);
      // 夹具当时的数字必须服从这条公式 —— 否则说明公式本身被改过
      assert.equal(before.faultTolerance.maxOfflineValidators, f(before.faultTolerance.validatorCount),
        '夹具里的容错上限不服从 ⌊n/4⌋ —— 公式在拍照之后被改过，这份夹具已不可用作基准');
      assert.equal(after.faultTolerance.maxOfflineValidators, f(after.faultTolerance.validatorCount),
        '当前的容错上限不服从 ⌊n/4⌋');
      // 成员只增不减时，验证者数不得反而变少
      assert.ok(after.faultTolerance.validatorCount >= before.faultTolerance.validatorCount,
        `验证者数从 ${before.faultTolerance.validatorCount} 降到 ${after.faultTolerance.validatorCount} ——`
        + ' 若确实退出了成员，请连同这份夹具一起更新，并在提交信息里写明');
    });

    test(`形态 \`${name}\`：新增的节点**只是新增**，没有替换旧节点`, () => {
      // 这条是上面几条的边界：若有人把一个旧节点改名，上面按 id 取值会拿到 undefined
      // 而 deepEqual(undefined, old) 会红 —— 但红的原因看起来像"派生变了"。
      // 这条把它说清：旧 id 必须**全部还在**。
      const nowIds = new Set(after.topologyNodes.map((n) => n.id));
      const gone = frozenIds.filter((id) => !nowIds.has(id));
      assert.deepEqual(gone, [],
        `形态 ${name} 里这些拍照时存在的节点不见了：${gone.join(', ')}\n`
        + '  改名或删除既有节点不在 005 的承诺范围内（那是 US3 的"退出"，走链上流程）。');
    });
  }
});

describe('下游真正依赖的那几个字段，名字与类型都没动', () => {
  const d = forDeployment(config.topology.activeDeployment);

  for (const [path, kind] of [
    ['activeDeployment', 'string'],
    ['topologyNodes', 'object'],
    ['failureDomains', 'object'],
    ['faultTolerance', 'object'],
  ]) {
    test(`\`${path}\` 仍是 ${kind}`, () => {
      assert.equal(typeof d[path], kind, `${path} 的类型变了 —— 下游会静默拿到 undefined`);
    });
  }

  test('每个 topologyNode 仍带 id / role / httpPort / domain / address', () => {
    for (const n of d.topologyNodes) {
      for (const k of ['id', 'role', 'httpPort', 'domain', 'address']) {
        assert.ok(n[k] !== undefined,
          `节点 ${n.id ?? '?'} 缺字段 \`${k}\` —— 面板与生成器都按这几个键取值`);
      }
    }
  });
});
