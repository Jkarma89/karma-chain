// T005：运行时 schema 必须与 Spec Kit 契约中的 schema 逐字节一致。
// 契约（specs/…/contracts/）是设计权威；blockchain/protocol.schema.json 只是为了让运行时不依赖 specs/ 目录。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT, DEFAULT_SCHEMA_PATH } from '../../tools/protocol/load.mjs';

const CONTRACT_SCHEMA = resolve(
  REPO_ROOT,
  'specs/001-local-avalanche-devnet/contracts/protocol-config.schema.json',
);

test('blockchain/protocol.schema.json is byte-identical to the contract schema', () => {
  const runtime = readFileSync(DEFAULT_SCHEMA_PATH);
  const contract = readFileSync(CONTRACT_SCHEMA);
  assert.ok(
    runtime.equals(contract),
    `schema drift: run  cp ${CONTRACT_SCHEMA} ${DEFAULT_SCHEMA_PATH}`,
  );
});

test('schema declares JSON Schema draft 2020-12 and forbids unknown top-level keys', () => {
  const schema = JSON.parse(readFileSync(DEFAULT_SCHEMA_PATH, 'utf8'));
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.additionalProperties, false);
});
