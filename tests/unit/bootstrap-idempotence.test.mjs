// T049：建链是一次性动作，默认拒绝覆盖已有制品。
//
// 为什么这条守卫重要：重新建链会产出新的链身份，而节点卷里的数据仍属于旧链 ——
// 二者一旦错配，节点会带着错误的 SubnetID 去连网络，表现为难以诊断的「连不上」。
// 宁可挡在前面，也不要让它悄悄发生（FR-017）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from '../../tools/protocol/load.mjs';

const read = (p) => readFileSync(resolve(REPO_ROOT, p), 'utf8');

describe('建链的一次性语义', () => {
  const entry = read('docker/bootstrap/entrypoint.sh');

  test('已有制品且未加 --force 时拒绝并以 12 退出', () => {
    assert.match(entry, /IDENTITY_FILE.*already exists/s, '应当检查制品是否已存在');
    assert.match(entry, /EXIT_ARTIFACT_EXISTS=12/, '拒绝时应使用 001 的「与声明不一致」退出码语义');
    assert.match(entry, /--force/, '应当提供显式的覆盖开关');
  });

  test('拒绝时说清后果与出路，而不只是报错', () => {
    const block = entry.slice(entry.indexOf('already exists'), entry.indexOf('already exists') + 600);
    assert.match(block, /SubnetID|BlockchainID/, '应当说明重新建链会换掉什么');
    assert.match(block, /devnet-reset/, '应当给出可执行的出路');
  });

  test('宿主脚本在有节点运行时拒绝建链', () => {
    const sh = read('scripts/devnet-bootstrap.sh');
    assert.match(sh, /docker ps .*karmachain-/, '应当检查是否仍有节点在运行');
    assert.match(sh, /devnet-stop/, '应当告知先停止');
    // 退出码必须是 10（前置条件未满足），**不是 11**。
    // 契约（specs/001-…/contracts/cli-interface.md）里 11 专指**宿主端口冲突**。
    // 本断言原文是"端口/状态冲突应使用 11"—— 它把误用写进了测试，因此没能拦住误用：
    // "端口被占"与"节点还在跑"是毫不相干的两件事，映射到同一个码上，
    // 调用方就无法据码分流（T091 的往返测试撞到了这一点）。
    assert.match(sh, /exit 10/, '前置条件未满足应使用 10');
    assert.doesNotMatch(sh, /exit 11/, '11 保留给宿主端口冲突');

    const ps1 = read('scripts/devnet-bootstrap.ps1');
    assert.match(ps1, /仍有节点在运行/, 'PowerShell 版本应当有等价检查');
    assert.match(ps1, /exit 10/, '两个版本的退出码必须等价');
    assert.doesNotMatch(ps1, /exit 11/, '11 保留给宿主端口冲突');
  });

  test('建链完成后必须播种节点卷 —— 否则节点接管不了这条链', () => {
    assert.match(entry, /seed_node_volumes/, '入口应当调用播种');
    assert.match(entry, /seeded \$\{seeded\}\/\$\{want\}/, '应当报告播种了几个卷');
    // 数量不符时必须失败：少播一个就意味着某个节点会从空卷启动，拿不到这条链
    assert.match(entry, /seeded \$\{seeded\} node volumes but topology declares/, '播种数量不符时应当失败');
  });

  test('播种发生在网络停止之后 —— 否则拷到的是写了一半的数据库', () => {
    const stopAt = entry.indexOf('av_network_stop');
    const seedAt = entry.indexOf('seed_node_volumes\n');
    assert.ok(stopAt > 0 && seedAt > 0, '两个步骤都应存在');
    assert.ok(stopAt < seedAt, '必须先干净停止再拷贝数据库');
  });

  test('链配置在 deploy 之前就位 —— 建链与运行时必须同源', () => {
    const cfgAt = entry.indexOf('chain.json');
    const deployAt = entry.indexOf('av_blockchain_deploy_local');
    assert.ok(cfgAt > 0 && deployAt > 0);
    assert.ok(cfgAt < deployAt,
      '链配置必须在 deploy 前写入：建链用默认（修剪）而运行时用归档，等于在修剪模式写过的库上切模式');
    assert.ok(existsSync(resolve(REPO_ROOT, 'blockchain/chain-config.json')),
      '建链所用的那份链配置应当是生成物');
  });

  test('建链所用的链配置与运行时的一致', () => {
    const flat = JSON.parse(read('blockchain/chain-config.json'));
    const identity = JSON.parse(read('blockchain/chain-identity/karmachain.identity.json'));
    const runtime = JSON.parse(read(`blockchain/nodes/chain-config/${identity.blockchainId}/config.json`));
    assert.deepEqual(runtime, flat, '两处链配置必须逐字段相同');
    assert.equal(flat['pruning-enabled'], false,
      '必须关闭修剪 —— 默认配置下强制终止会回滚区块，US1 因此不成立');
  });
});
