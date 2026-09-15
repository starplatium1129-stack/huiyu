#!/usr/bin/env node
'use strict';

import { PathOrFileDescriptor } from 'node:fs';

/* repair-audit-parses.js — 对 audit-report.json 中 parse-fail 的记录离线重解析。
 * 视觉模型结论格式偶尔漂移（如 `**结论：** 不通过`），无需重新请求 API，
 * 直接对已有 content 用修复后的正则重新解析 verdict，重写 report。
 *
 * 用法：node scripts/tests/repair-audit-parses.js <audit-report.json>
 */

var fs: typeof import('fs') = require('fs');

function readJson(file: PathOrFileDescriptor) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

function parseVerdict(content: unknown) {
  // 归一化 Claude 风格（"## 结论" 独立标题行）为冒号风格
  var text = String(content || '').replace(/^#+\s*结论\s*$/gm, '结论：');
  var m = text.match(/\*{0,2}\s*结论\s*\*{0,2}\s*[：:]\s*\*{0,2}\s*(通过|需复核|不通过)/);
  var score = text.match(/总分\s*[：:]\s*(\d+)\s*\/\s*80/);
  return {
    verdict: m ? m[1] : 'parse-fail',
    score: score ? Number(score[1]) : null,
  };
}

function main() {
  var file = process.argv[2];
  if (!file) {
    console.error('用法: node scripts/tests/repair-audit-parses.js <audit-report.json>');
    process.exit(2);
  }
  var report = readJson(file);
  var fixed = 0;
  var stillFail = 0;
  report.results.forEach(function (x: { verdict: string; content: unknown; score: number; }) {
    if (x.verdict !== 'parse-fail' || !x.content) return;
    var parsed = parseVerdict(x.content);
    if (parsed.verdict === 'parse-fail') { stillFail += 1; return; }
    x.verdict = parsed.verdict;
    if (parsed.score !== null) x.score = parsed.score;
    fixed += 1;
  });
  var tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(report, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  console.log('修复 parse-fail: ' + fixed + ' 条；仍无法解析: ' + stillFail + ' 条');
}

main();
