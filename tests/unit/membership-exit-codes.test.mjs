// 成员管理三个工具的退出码：**一套，且不与仓库既有含义相撞**（功能 005 / FR-017 / T028）。
//
// ## 这条守卫在守什么
//
// 加入与退出是分两次写的，各挑各的号，于是同一件事有两个答案：
//
//   add-validator     前置检查未过 13   某步失败 14   人工中止 20
//   remove-validator  前置检查未过 11   某步失败 12   人工中止  3
//
// 而 11 / 12 / 13 / 20 在 001 与 002 的 CLI 契约里**早就有含义**。
// 「退出码 12」于是在一处是"节点数据不属于这条链"、在另一处是"P 链交易失败" ——
// 靠退出码分流的调用方会把两件毫不相干的事当成同一件，而且**不会报错**。
//
// 两条断言各守一半：
//   ① 三个工具的码都来自 exit-codes.mjs，没有谁自己再定义一份
//   ② 除了刻意同义复用的 10，成员码不得落在保留号段里
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from '../../tools/protocol/load.mjs';
import * as codes from '../../tools/membership/exit-codes.mjs';
import * as add from '../../tools/membership/add-validator.mjs';
import * as remove from '../../tools/membership/remove-validator.mjs';

const NAMES = ['EXIT_OK', 'EXIT_PRECHECK', 'EXIT_STEP_FAILED', 'EXIT_ABORTED'];
const SOURCES = ['add-validator.mjs', 'remove-validator.mjs', 'member-set.mjs'];

describe('成员管理的退出码只有一套', () => {
  test('加入与退出对同一件事给同一个码', () => {
    for (const n of NAMES) {
      assert.equal(add[n], codes[n], `add-validator 的 ${n} 与 exit-codes.mjs 不一致`);
      assert.equal(remove[n], codes[n], `remove-validator 的 ${n} 与 exit-codes.mjs 不一致`);
    }
  });

  test('没有哪个工具自己再定义一份（否则上一条会被绕过）', () => {
    for (const f of SOURCES) {
      const text = readFileSync(resolve(REPO_ROOT, 'tools/membership', f), 'utf8');
      // `export const EXIT_X = <字面量>` 才算自己定义；`export { … } from` 是转发，允许。
      const own = [...text.matchAll(/^export const (EXIT_[A-Z_]+)\s*=\s*\d+/gm)].map((m) => m[1]);
      assert.deepEqual(own, [],
        `tools/membership/${f} 自己定义了 ${own.join('、')} —— `
        + '要从 exit-codes.mjs 取，否则两处会各自漂移，而这正是本守卫要防的事');
    }
  });

  test('**反向断言**：exit-codes.mjs 里确实是数字字面量（否则上一条是空跑）', () => {
    const text = readFileSync(resolve(REPO_ROOT, 'tools/membership/exit-codes.mjs'), 'utf8');
    const own = [...text.matchAll(/^export const (EXIT_[A-Z_]+)\s*=\s*\d+/gm)].map((m) => m[1]);
    assert.ok(own.length >= NAMES.length,
      `exit-codes.mjs 只定义了 ${own.length} 个码 —— 若它也不用字面量，`
      + '上一条"没有谁自己定义"就会在一个空集合上恒真');
  });
});

describe('不与 001 / 002 已占用的退出码相撞', () => {
  test('保留号段列全了（10/11/12/13/20）', () => {
    assert.deepEqual(
      Object.keys(codes.RESERVED_BEFORE_005).map(Number).sort((a, b) => a - b),
      [10, 11, 12, 13, 20],
      'RESERVED_BEFORE_005 与 001/002 契约对不上 —— 漏一个就等于给它开了后门',
    );
  });

  test('成员码只在 10 上与保留号重合，且那一处是同义复用', () => {
    const memberCodes = Object.entries(codes)
      .filter(([k, v]) => k.startsWith('EXIT_') && typeof v === 'number' && v !== 0);
    for (const [name, value] of memberCodes) {
      if (!(value in codes.RESERVED_BEFORE_005)) continue;
      assert.equal(name, 'EXIT_DEPS',
        `${name} = ${value} 撞上保留码「${codes.RESERVED_BEFORE_005[value]}」。`
        + '成员管理的码请用 3x 号段 —— 复用只允许在含义**完全相同**时发生（只有 10）。');
      assert.match(codes.RESERVED_BEFORE_005[value], /前置依赖/,
        'EXIT_DEPS 复用 10 的前提是两边都指"前置依赖缺失"；10 的含义变了就不能再复用');
    }
  });

  test('前置检查 / 步骤失败 / 中止三者互不相同', () => {
    const three = [codes.EXIT_PRECHECK, codes.EXIT_STEP_FAILED, codes.EXIT_ABORTED];
    assert.equal(new Set(three).size, 3,
      `${three.join('、')} 里有重复 —— 这三件事的处置完全不同：`
      + '前置检查未过要去改环境，步骤失败要重跑那一步，中止是人自己选的');
  });
});
