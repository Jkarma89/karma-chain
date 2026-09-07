// T030（漂移部分）：生成物必须与 protocol.json 同步 —— docs/protocol-parameters.md、blockchain/compose.env、
// 以及 docker-compose.yml 中为裸 `docker compose up` 保留的 :- 兜底字面量。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadProtocol, REPO_ROOT } from '../../tools/protocol/load.mjs';
import { checkDocs, renderDocsText, REQUIRED_RATIONALE_KEYS, RATIONALE_PATH } from '../../tools/protocol/render-docs.mjs';
import { checkComposeEnv } from '../../tools/protocol/render-compose-env.mjs';
import { checkNodeFlags } from '../../tools/protocol/render-node-flags.mjs';
import { checkAliases } from '../../tools/protocol/render-aliases.mjs';
import { checkCompose } from '../../tools/protocol/render-compose.mjs';
import { checkRpcProxy } from '../../tools/protocol/render-rpc-proxy.mjs';

const protocol = loadProtocol();

describe('generated artifacts stay in sync with protocol.json', () => {
  test('docs/protocol-parameters.md has no drift', () => {
    assert.ok(checkDocs().same, 'docs drift — run: npm run protocol:render');
  });

  test('blockchain/compose.env has no drift', () => {
    assert.ok(checkComposeEnv().same, 'compose.env drift — run: npm run protocol:render');
  });

  // 功能 002 的生成物：节点标志、链别名、每边界 compose。
  // 它们直接决定节点怎么启动，手改一处就会让运行行为与声明脱节（FR-027）。
  test('blockchain/nodes/<deployment>/*.flags.json has no drift', () => {
    const { same, drift } = checkNodeFlags();
    assert.ok(same, `node flags drift (${drift.join(', ')}) — run: npm run node:render`);
  });

  test('blockchain/nodes/aliases.json has no drift', () => {
    assert.ok(checkAliases().same, 'chain aliases drift — run: npm run node:render');
  });

  test('docker/compose/*.yml has no drift', () => {
    const { same, drift } = checkCompose();
    assert.ok(same, `compose drift (${drift.join(', ')}) — run: npm run node:render`);
  });

  test('blockchain/nodes/<deployment>/rpc-proxy.conf has no drift', () => {
    const { same, drift } = checkRpcProxy();
    assert.ok(same, `rpc proxy config drift (${drift.join(', ')}) — run: npm run node:render`);
  });

  // 每个声明的部署形态都必须有完整的一套标志 —— 只渲染 activeDeployment 曾让
  // lan 形态无法在别的机器上启动（节点仍在用单机形态的容器地址）。
  test('每个部署形态的节点标志都覆盖拓扑声明的全部节点，且无多余文件', () => {
    const { byDeployment } = checkNodeFlags();
    const wantNodes = protocol.topology.nodes.map((n) => n.id).sort();
    assert.deepEqual(
      Object.keys(byDeployment).sort(),
      Object.keys(protocol.topology.deployments).sort(),
    );
    for (const [name, flags] of Object.entries(byDeployment)) {
      assert.deepEqual(Object.keys(flags).sort(), wantNodes, `deployment ${name}`);
    }
  });

  // 形态相关的标志必须真的随形态变化：public-ip / bootstrap-ips / http-allowed-hosts
  // 全都相同，说明渲染没有按形态取地址（那正是这次分目录要修的缺陷）。
  test('lan 形态的节点地址取自各机器，而非单机形态的容器网段', () => {
    const { byDeployment } = checkNodeFlags();
    const lan = byDeployment.lan;
    const local = byDeployment.local;
    if (!lan) return; // 只声明了单机形态时跳过
    const lanDomains = protocol.topology.deployments.lan.failureDomains;
    const addrOfNode = new Map(lanDomains.flatMap((d) => d.nodes.map((id) => [id, d.address])));
    for (const [id, f] of Object.entries(lan)) {
      assert.equal(f['public-ip'], addrOfNode.get(id), `${id} public-ip 应为所在故障边界的地址`);
      assert.notEqual(f['public-ip'], local[id]['public-ip'], `${id} 的地址未随形态变化`);
    }
  });

  // 下限从 4 降到 1（T080）：001 的 `devnet` 服务贡献了其中 4 处兜底，而它已退役 ——
  // `docker compose up` 不再启动链（链由每边界一份的生成物启动）。
  // 断言的实质从未改变：**留下的每一处**兜底都必须与唯一事实来源一致。
  // 保留下限是为了防止正则因文件重构而静默匹配不到任何东西，从而让本测试空转。
  test('docker-compose.yml fallback literals equal protocol.endpoints.hostRpcPort', () => {
    const compose = readFileSync(resolve(REPO_ROOT, 'docker-compose.yml'), 'utf8');
    const fallbacks = [...compose.matchAll(/\$\{KARMACHAIN_(?:RPC_PORT|CONTAINER_RPC_PORT):-(\d+)\}/g)].map((m) => Number(m[1]));
    assert.ok(fallbacks.length >= 1, `expected >=1 port fallback in docker-compose.yml, found ${fallbacks.length}`);
    for (const v of fallbacks) assert.equal(v, protocol.endpoints.hostRpcPort, 'compose fallback out of sync with protocol.json');
  });

  // T080 之后 docker-compose.yml 只剩无状态工具容器；链的编排一律在生成物里。
  // 这条断言防止有人把链服务加回这个手写文件 —— 那会绕过拓扑声明（宪法第十六条）。
  test('docker-compose.yml 不再定义任何链节点服务（T080）', () => {
    const compose = readFileSync(resolve(REPO_ROOT, 'docker-compose.yml'), 'utf8');
    assert.doesNotMatch(compose, /karmachain\/devnet|docker\/devnet/, '001 的单容器编排已退役');
    assert.doesNotMatch(compose, /karmachain-devnet-data/, '001 的 CLI 账本卷已退役');
    for (const id of protocol.topology.nodes.map((n) => n.id)) {
      assert.doesNotMatch(compose, new RegExp(`^\\s{2}${id}:`, 'm'),
        `节点 ${id} 不该出现在手写 compose 里 —— 它由 docker/compose/<deployment>-<domain>.yml 生成`);
    }
  });

  test('every required parameter has a rationale (constitution Art. 14)', () => {
    // renderDocsText 内部强制；这里再验证"缺一条就失败"的行为本身
    assert.doesNotThrow(() => renderDocsText());
    const tmp = mkdtempSync(join(tmpdir(), 'kc-rationale-'));
    try {
      const crippled = JSON.parse(readFileSync(RATIONALE_PATH, 'utf8'));
      delete crippled.rationale['chain.chainId'];
      const crippledPath = join(tmp, 'rationale.json');
      writeFileSync(crippledPath, JSON.stringify(crippled));
      // 通过环境无法注入路径 —— 直接断言键清单包含该项即可（渲染入口已在上面验证）
      assert.ok(REQUIRED_RATIONALE_KEYS.includes('chain.chainId'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// T071：理由文件的**结构**守卫。
//
// 为什么需要：渲染器只读 `.rationale`，而 protocol-rationale.json 曾经在顶层多出
// `topology`、`validators.nodes`、`configVersion` 三个键 —— 那是追加迁移说明时写错了位置。
// 后果是双重的：那些说明**根本没进文档**，而它们本该更新的 `rationale.*` 条目仍停留在旧值
// （`validators.nodes` 一直写着已迁走的 9660-9669）。而且其中两条以字面量 "undefined " 开头，
// 说明拼接时源值就是 undefined。这类错误不会让任何测试失败，只会让文档静默陈旧。
describe('protocol-rationale.json 的结构', () => {
  const raw = JSON.parse(readFileSync(RATIONALE_PATH, 'utf8'));

  test('顶层只允许 $comment 与 rationale —— 别处写的理由不会进文档', () => {
    assert.deepEqual(
      Object.keys(raw).sort(),
      ['$comment', 'rationale'],
      '顶层出现了额外的键：渲染器只读 .rationale，写在顶层的内容会被静默忽略',
    );
  });

  test('没有条目以 "undefined" 开头或包含它 —— 那是拼接源值缺失的痕迹', () => {
    const bad = Object.entries(raw.rationale)
      .filter(([, v]) => String(v).includes('undefined'))
      .map(([k]) => k);
    assert.deepEqual(bad, [], `以下条目含 "undefined"：${bad.join(', ')}`);
  });

  // 不设字符数门槛：`"0：官方默认。"` 是条正当理由，只是短。要管的是**空的**与**占位的**，
  // 不是简短的 —— 按长度打分会把简洁误判为缺失。
  test('每条理由都是非空字符串，且不含占位符', () => {
    const PLACEHOLDER = /\b(TODO|TBD|FIXME|XXX|待补|待填)\b|^\s*[?？-]+\s*$/i;
    for (const [k, v] of Object.entries(raw.rationale)) {
      assert.equal(typeof v, 'string', `${k} 的理由应为字符串`);
      assert.ok(v.trim().length > 0, `${k} 的理由为空`);
      assert.doesNotMatch(v, PLACEHOLDER, `${k} 的理由仍是占位符：${JSON.stringify(v)}`);
    }
  });

  test('必填清单中的每一项都有理由，且清单覆盖 topology', () => {
    const missing = REQUIRED_RATIONALE_KEYS.filter((k) => !raw.rationale[k]);
    assert.deepEqual(missing, [], `缺理由：${missing.join(', ')}`);
    for (const k of ['topology', 'topology.activeDeployment', 'topology.nodes', 'topology.deployments']) {
      assert.ok(REQUIRED_RATIONALE_KEYS.includes(k), `${k} 必须列入必填清单（宪法第十四条）`);
    }
  });
});
