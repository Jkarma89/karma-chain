// 「这台机器还在读旧格式」必须被**指名道姓**报出来（功能 005 / T020 / FR-008）。
//
// ## 为什么这条要用行为守卫，不能只做静态扫描
//
// 五台机器靠 `git pull` 同步，而 pull 会失败、会被跳过、会停在一个旧提交上。
// 004 的现场就撞到过一次同源问题：三台 Ubuntu 没有 node/npm，
// 我写的部署步骤要求每台机器 `npm run render` —— 那条步骤在四台机器上没人试过。
//
// 分家之后「旧格式」有两种样子，**后果不同**：
//
//   ① `blockchain/deployment.json` 不存在  —— 仓库停在分家之前
//   ② `blockchain/protocol.json` 里还有 `topology` —— **半新半旧**，更危险：
//      两份文件都在，取值从哪一份来取决于读取路径，而两份可以不一致。
//
// 不拦下来的话，报出来的会是一句 jq 的 `null (null) has no keys`，
// 或者更糟 —— 某个取值静默变成 `undefined`，链照常跑而入口连不上。
//
// ## 这套件不碰仓库
//
// 在临时目录里搭一棵最小的仓库树（脚本自己 `cd "$(dirname "$0")/.."`，
// 所以它会把临时目录当成仓库根），然后跑**真脚本**。
// 早期想过"把仓库里的 deployment.json 挪开再跑" —— 那样一旦中断，
// 留下的是一个坏掉的工作区。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { REPO_ROOT } from '../../tools/protocol/load.mjs';

const SH = resolve(REPO_ROOT, 'scripts', 'devnet-start.sh');
const ACTIVE_ENV = resolve(REPO_ROOT, 'docker', 'compose', 'active.env');

let root;

/** 搭一棵最小仓库树。`opts` 决定这台"机器"处于哪种格式状态。 */
const makeTree = ({ deployment, topologyInProtocol }) => {
  const dir = mkdtempSync(join(tmpdir(), 'km-oldfmt-'));
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'blockchain'), { recursive: true });
  mkdirSync(join(dir, 'docker', 'compose'), { recursive: true });
  copyFileSync(SH, join(dir, 'scripts', 'devnet-start.sh'));
  copyFileSync(ACTIVE_ENV, join(dir, 'docker', 'compose', 'active.env'));

  const protocol = { name: 'karmachain', configVersion: '1.4.0' };
  if (topologyInProtocol) protocol.topology = { activeDeployment: 'lan' };
  writeFileSync(join(dir, 'blockchain', 'protocol.json'), `${JSON.stringify(protocol, null, 2)}\n`);
  if (deployment) {
    writeFileSync(join(dir, 'blockchain', 'deployment.json'), '{"deploymentVersion":"1.0.0"}\n');
  }
  return dir;
};

const run = (dir) => spawnSync('bash', [join(dir, 'scripts', 'devnet-start.sh')], {
  encoding: 'utf8',
  env: { ...process.env, KARMACHAIN_ENV_FILE: join(dir, 'docker', 'compose', 'active.env') },
  timeout: 30_000,
});

before(() => { root = []; });
after(() => { for (const d of root ?? []) rmSync(d, { recursive: true, force: true }); });

describe('devnet-start.sh 对两种"旧格式"各给一句能照做的话', () => {
  test('① 缺 deployment.json → 退出 10，并说清是**这台机器**的仓库旧了', () => {
    const dir = makeTree({ deployment: false, topologyInProtocol: false });
    root.push(dir);
    const r = run(dir);
    assert.equal(r.status, 10, `应当退出 10，实际 ${r.status}\nstderr:\n${r.stderr}`);
    assert.match(r.stderr, /deployment\.json/, '没提到是哪个文件');
    assert.match(r.stderr, /旧格式/, '没说清这是"格式旧了"而不是别的故障');
    assert.match(r.stderr, /git pull/, '没给出能照做的修法');
    // 判的是"有没有叫人去跑 npm/node"，不是"有没有提到这两个词" ——
    // 那句修法正是靠「本机不需要 node/npm」把这件事说清的。
    assert.ok(!/npm run|node \S+\.mjs/.test(r.stderr),
      '修法里叫人去跑 npm/node —— 三台 Ubuntu 上没有它们。\n'
      + '  004 的现场已经为这件事付过一次代价：写好的部署步骤在四台机器上没人试过。');
  });

  test('② protocol.json 里还有 topology → 退出 10，并点出"半新半旧"', () => {
    const dir = makeTree({ deployment: true, topologyInProtocol: true });
    root.push(dir);
    const r = run(dir);
    assert.equal(r.status, 10, `应当退出 10，实际 ${r.status}\nstderr:\n${r.stderr}`);
    assert.match(r.stderr, /topology/, '没提到是哪个字段');
    assert.match(r.stderr, /半新半旧/,
      '没点出这一种比"缺文件"更危险 —— 两份都在而可以不一致');
  });

  test('**格式正确时不拦**（否则这两条检查会挡住所有人）', () => {
    const dir = makeTree({ deployment: true, topologyInProtocol: false });
    root.push(dir);
    const r = run(dir);
    // **按消息判，不按退出码判。** 临时树里没有 compose 文件，脚本走到后面同样会以 10
    // 退出（配置类失败共用这个码）—— 拿退出码判会把「格式检查放行了」与
    // 「后面另有别的配置问题」混为一谈，而那正是本条要区分的两件事。
    assert.ok(!/旧格式|半新半旧/.test(r.stderr),
      `格式正确却打印了旧格式警告：\n${r.stderr}`);
    assert.match(r.stderr, /故障边界|compose|docker/,
      '脚本连格式检查之后的任何一步都没走到 —— 那说明它在别处就退了，\n'
      + `  本条并没有真的验证"格式正确时放行"。stderr:\n${r.stderr}`);
  });
});

describe('两个宿主封装等价（契约 001 cli-interface.md）', () => {
  const sh = readFileSync(SH, 'utf8');
  const ps1 = readFileSync(resolve(REPO_ROOT, 'scripts', 'devnet-start.ps1'), 'utf8');

  for (const [what, needle] of [
    ['缺 deployment.json', 'deployment.json'],
    ['protocol.json 里残留 topology', '"topology"'],
    ['旧格式的措辞', '旧格式'],
    ['半新半旧的措辞', '半新半旧'],
  ]) {
    test(`\`.ps1\` 也覆盖「${what}」`, () => {
      assert.ok(sh.includes(needle), `.sh 里没有 ${needle} —— 本条比对失去意义`);
      assert.ok(ps1.includes(needle),
        `\`.sh\` 会报「${what}」而 \`.ps1\` 不会。\n`
        + '  两台 Windows 机器走的是 .ps1 —— 少一条检查，那两台就会以旧格式静默跑起来。');
    });
  }

  test('两边都用退出码 10（配置类失败）', () => {
    assert.ok(/exit 10/.test(sh) && /exit 10/.test(ps1));
  });
});
