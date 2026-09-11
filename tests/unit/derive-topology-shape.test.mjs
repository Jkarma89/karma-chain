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

describe('分家之后，派生结果**逐字节相同**（SC-003）', { skip: OVERRIDDEN ? '设置了 KARMACHAIN_ADDRESS_OVERRIDE，夹具不适用' : false }, () => {
  for (const name of Object.keys(BEFORE)) {
    test(`形态 \`${name}\` 的完整输出未变`, () => {
      assert.deepEqual(forDeployment(name), BEFORE[name],
        `形态 ${name} 的派生结果与分家前不同。\n`
        + '  分家的**全部承诺**就是「合并视图与分家前逐字段相同，下游一行不改」。\n'
        + '  这里不同，意味着某个消费者会拿到与它预期不同的东西 ——\n'
        + '  而下游有三十多处，逐个复查的代价远高于在这里对齐。');
    });

    test(`形态 \`${name}\` 的 JSON 序列化也相同（键顺序未变）`, () => {
      // `deepEqual` 不看键顺序，但生成物（compose / nginx / 文档）是按遍历顺序写出的，
      // 键顺序一变，T014 的"生成物逐字节相同"就会红在一个毫无信息量的地方。
      assert.equal(
        JSON.stringify(forDeployment(name)),
        JSON.stringify(BEFORE[name]),
        `形态 ${name} 的键顺序变了 —— 生成物会跟着变，而语义没变。`);
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
