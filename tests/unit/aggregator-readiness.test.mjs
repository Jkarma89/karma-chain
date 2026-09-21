// 聚合器的**就绪**判据 —— `/health` 说 `up` 不等于它能收签名（研究 V-48）。
//
// ## 事情是怎么发生的
//
// 2026-09-19 重启聚合器后 13 秒就用它：
//
//   accumulatedWeight: 0
//   Failed to connect to a threshold of stake
//
// 而**同一时刻** `curl /health` 已经是 `{"status":"up"}`。等约 90 秒后同一条命令就过了。
//
// `up` 只说进程活着。它还要先与两个 Primary 握手、再经 gossip 学到各 L1 验证者的
// IP 声明，才谈得上收签名。而文档当时只教人「`curl /health` 必须是 up」——
// **一个恒真的就绪信号，等于没有就绪信号。**
//
// 更坏的是当时那句诊断把人指向 `allow-private-ips`（那是另一个成因，**症状一模一样**）。
// 于是一次"再等 60 秒"被读成一次配置错误。
//
// ## 判据取自它自己的指标
//
//   signature_aggregator_connected_stake_weight_percentage{subnetID="…"} 100
//
// 刚起来是 0，连齐了是 100。低于门槛就收不齐，与网络配置无关。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { aggregatorConnectedStake } from '../../tools/membership/add-validator.mjs';
import { REPO_ROOT } from '../../tools/protocol/load.mjs';

/** 真实指标输出的形状（2026-09-21 从活链聚合器取的那一份）。 */
const METRICS = [
  '# HELP signature_aggregator_agg_sigs_req_count ...',
  'signature_aggregator_agg_sigs_req_count 6',
  'signature_aggregator_connected_stake_weight_percentage{subnetID="2W9boARgCWL25z6pMFNtkCfNA5v28VGg9PmBgUJfuKndEdhrvw"} 100',
  'signature_aggregator_failures_to_connect_to_sufficient_stake 2',
  '',
].join('\n');

const fakeFetch = (body, { ok = true } = {}) => async () => ({ ok, text: async () => body });

describe('① 从指标里取出那个百分比', () => {
  test('按 subnetID 取到 100', async () => {
    const pct = await aggregatorConnectedStake({
      aggregatorUrl: 'http://agg:8646',
      subnetId: '2W9boARgCWL25z6pMFNtkCfNA5v28VGg9PmBgUJfuKndEdhrvw',
      fetchImpl: fakeFetch(METRICS),
    });
    assert.equal(pct, 100);
  });

  test('刚起来时是 0 —— 它与「读不到」必须能分开', async () => {
    const zero = METRICS.replace('} 100', '} 0');
    const pct = await aggregatorConnectedStake({
      aggregatorUrl: 'http://agg:8646', fetchImpl: fakeFetch(zero),
    });
    assert.equal(pct, 0, '0 是一个有效读数：它说"连上了 0%"，而不是"没读到"');
  });

  test('指标端口是 8647，而不是 API 的 8646', async () => {
    let seen = null;
    await aggregatorConnectedStake({
      aggregatorUrl: 'http://agg:8646',
      fetchImpl: async (url) => { seen = url; return { ok: true, text: async () => METRICS }; },
    });
    assert.equal(seen, 'http://agg:8647/metrics',
      '指标在 8647 —— 打到 8646 上会拿到 API 的 404，然后被当成"读不到"');
  });
});

describe('② 读不到时是 null，不是 0', () => {
  for (const [name, impl] of [
    ['连不上', async () => { throw new Error('fetch failed'); }],
    ['非 200', fakeFetch('', { ok: false })],
    ['没有那条指标', fakeFetch('signature_aggregator_agg_sigs_req_count 6\n')],
    ['值不是数', fakeFetch('signature_aggregator_connected_stake_weight_percentage{a="b"} NaNish\n')],
  ]) {
    test(`${name} → null`, async () => {
      const pct = await aggregatorConnectedStake({ aggregatorUrl: 'http://agg:8646', fetchImpl: impl });
      assert.equal(pct, null,
        '**"没读到"与"是 0"是两件事**：前者说不出它连没连上，后者说它确实没连上。'
        + '混成一个值，会让一次读取失败被报成"它还没就绪，再等等"，而人就真的白等了');
    });
  }
});

describe('③ 失败诊断要把两种成因分开', () => {
  const SRC = readFileSync(resolve(REPO_ROOT, 'tools/membership/add-validator.mjs'), 'utf8');

  test('收不齐签名时会去读那个百分比', () => {
    assert.match(SRC, /const pct = await aggregatorConnectedStake\(\{/,
      '不读这个数的话，"刚起来还没连上"与"某个验证者不签"在输出里长得一模一样');
  });

  test('低于门槛时说"等一会儿"，而不是先怪配置', () => {
    assert.match(SRC, /多半是刚起来还没连上/);
    assert.match(SRC, /若长期停在 0，那才去查 allow-private-ips/,
      'allow-private-ips 是**另一个**成因。把它当成首要建议，'
      + '会让人去改一个本来就对的配置 —— 2026-09-19 我自己就照着它查了一轮');
  });

  test('已达门槛时把矛头指向"某个验证者不签"', () => {
    assert.match(SRC, /已达门槛 —— 那问题不在连通性/);
  });
});
