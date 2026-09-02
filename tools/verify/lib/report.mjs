// tools/verify/lib/report.mjs —— 验证报告：控制台逐项 [OK]/[FAIL] 行（contracts/cli-interface.md 格式）
// 与机器可读 JSON（contracts/verification-report.schema.json）。

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ALL_CATEGORIES } from './categories.mjs';

export const STATUS = Object.freeze({ OK: 'ok', FAIL: 'fail', SKIP: 'skip', UNSUPPORTED: 'unsupported' });

const LABEL = { ok: 'OK', fail: 'FAIL', skip: 'SKIP', unsupported: 'UNSUPPORTED' };
const COLOR = { ok: '\x1b[32m', fail: '\x1b[31m', skip: '\x1b[33m', unsupported: '\x1b[33m' };
const RESET = '\x1b[0m';
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

export class Report {
  constructor({ rpcUrl }) {
    this.rpcUrl = rpcUrl;
    this.checks = [];
    this.summary = { chainId: null, networkId: null, blockHeight: null };
    this.startedAt = Date.now();
  }

  /** 记录一项结果并即时打印（长时检查也能看到进度）。 */
  add({ id, status, category, detail, data }) {
    if (status === STATUS.FAIL && !ALL_CATEGORIES.includes(category)) {
      throw new Error(`check ${id}: a failing check must carry a valid FR-030 category (got ${category})`);
    }
    const entry = { id, status, detail, ...(category ? { category } : {}), ...(data ? { data } : {}) };
    this.checks.push(entry);
    const tag = `[${LABEL[status]}]`.padEnd(14);
    const painted = useColor ? `${COLOR[status]}${tag}${RESET}` : tag;
    const cat = status === STATUS.FAIL ? `[category: ${category}] ` : '';
    console.log(`${painted}${id.padEnd(21)}${cat}${detail}`);
    return entry;
  }

  setSummary(patch) { Object.assign(this.summary, patch); }

  get failed() { return this.checks.filter((c) => c.status === STATUS.FAIL); }
  get overall() { return this.failed.length === 0 ? 'ready' : 'failed'; }

  toJSON() {
    return {
      schemaVersion: 1,
      timestamp: new Date(this.startedAt).toISOString(),
      rpcUrl: this.rpcUrl,
      chainId: this.summary.chainId,
      networkId: this.summary.networkId,
      blockHeight: this.summary.blockHeight,
      durationMs: Date.now() - this.startedAt,
      overall: this.overall,
      checks: this.checks,
    };
  }

  write(path) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(this.toJSON(), null, 2)}\n`);
    return path;
  }

  printHeader() {
    console.log(`\nKarmaChain Network Check  (rpc: ${this.rpcUrl})\n`);
  }

  printFooter() {
    const counts = { ok: 0, fail: 0, skip: 0, unsupported: 0 };
    for (const c of this.checks) counts[c.status]++;
    const secs = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    const verdict = this.overall === 'ready' ? 'KarmaChain is READY' : 'KarmaChain is NOT READY';
    const painted = useColor ? `${this.overall === 'ready' ? COLOR.ok : COLOR.fail}${verdict}${RESET}` : verdict;
    console.log(`\n${painted}   (${this.checks.length} checks, ${counts.fail} failed, ${counts.unsupported} unsupported, ${counts.skip} skipped, ${secs} s)\n`);
  }
}
