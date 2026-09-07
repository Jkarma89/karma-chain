// 运行时 schema 必须与 Spec Kit 契约保持同步。
// 契约（specs/…/contracts/）是设计权威；blockchain/ 下的副本只是为了让运行时不依赖 specs/ 目录。
//
// 功能 002 起，protocol.schema.json 由**两个**契约共同决定：
//   001 contracts/protocol-config.schema.json   —— 基础协议参数
//   002 contracts/topology.schema.json          —— topology 段（片段，嵌入为一个属性 + 若干 $defs）
// 因此不能再做逐字节比对，改为结构化比对：基础部分必须与 001 契约逐字段一致，
// 新增部分必须与 002 片段逐字段一致，两者之外不得有任何差异。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT, DEFAULT_SCHEMA_PATH } from '../../tools/protocol/load.mjs';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

const BASE_CONTRACT = resolve(REPO_ROOT, 'specs/001-local-avalanche-devnet/contracts/protocol-config.schema.json');
const TOPOLOGY_CONTRACT = resolve(REPO_ROOT, 'specs/002-resilient-validator-network/contracts/topology.schema.json');
const IDENTITY_CONTRACT = resolve(REPO_ROOT, 'specs/002-resilient-validator-network/contracts/chain-identity.schema.json');
const IDENTITY_RUNTIME = resolve(REPO_ROOT, 'blockchain/chain-identity.schema.json');

describe('protocol.schema.json 与其两个契约同步', () => {
  const runtime = readJson(DEFAULT_SCHEMA_PATH);
  const base = readJson(BASE_CONTRACT);
  const frag = readJson(TOPOLOGY_CONTRACT);

  test('基础部分与 001 契约逐字段一致（除 topology、$defs 与 required 的增量外无差异）', () => {
    // required 单独比对（见下一条：只增不减）—— 002 把 topology 列为必填，属于合法增量
    const { topology, ...props } = runtime.properties;
    const { $defs, required, ...rest } = runtime;
    const { required: baseRequired, ...baseRest } = base;
    assert.deepEqual({ ...rest, properties: props }, baseRest,
      `schema 漂移：运行时 schema 的基础部分偏离了 ${BASE_CONTRACT}`);
  });

  test('topology 段与 002 契约片段逐字段一致', () => {
    // 片段的 $schema/$id/title 是独立文档的元数据，嵌入后不适用；$defs 提升到根
    const { $schema, $id, title, $defs, ...expected } = frag;
    assert.deepEqual(runtime.properties.topology, expected,
      `schema 漂移：topology 段偏离了 ${TOPOLOGY_CONTRACT}`);
    for (const [name, def] of Object.entries($defs)) {
      assert.deepEqual(runtime.$defs?.[name], def, `$defs.${name} 偏离契约片段`);
    }
  });

  test('嵌入未破坏片段内部的 $ref —— 引用的 $defs 都存在', () => {
    const refs = [...JSON.stringify(runtime.properties.topology).matchAll(/#\/\$defs\/([A-Za-z0-9_]+)/g)]
      .map((m) => m[1]);
    assert.ok(refs.length > 0, '片段应当含有 $ref');
    for (const r of new Set(refs)) {
      assert.ok(runtime.$defs?.[r], `topology 引用了 #/$defs/${r}，但根 schema 中不存在`);
    }
  });

  test('必填集合只增不减（001 的必填项一个都不能少）', () => {
    for (const key of base.required) {
      assert.ok(runtime.required.includes(key), `必填项 ${key} 被移除了`);
    }
  });

  test('声明 draft 2020-12 并禁止未知顶层键', () => {
    assert.equal(runtime.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(runtime.additionalProperties, false);
  });
});

describe('chain-identity.schema.json 与契约同步', () => {
  test('与 002 契约逐字节一致', () => {
    const runtime = readFileSync(IDENTITY_RUNTIME);
    const contract = readFileSync(IDENTITY_CONTRACT);
    assert.ok(runtime.equals(contract),
      `schema 漂移：执行  cp ${IDENTITY_CONTRACT} ${IDENTITY_RUNTIME}`);
  });

  test('声明 draft 2020-12 并禁止未知顶层键', () => {
    const schema = readJson(IDENTITY_RUNTIME);
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(schema.additionalProperties, false);
  });
});
