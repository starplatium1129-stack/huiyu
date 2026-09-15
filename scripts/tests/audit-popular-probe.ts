#!/usr/bin/env node
import { errorMessage as runtimeErrorMessage } from '../lib/runtime-errors';
'use strict';

import { PathOrFileDescriptor } from 'node:fs';

/* audit-popular-probe.js — 对 Krea 2/Anima 热门角色实测图做角色识别审核。
 *
 * 每张图询问视觉模型：能否识别为预期角色（是/否/存疑）+ 关键特征核对 + 场景符合度。
 * 复用 image-inspect.js 的请求通道（本地 CLIProxyAPI，默认 gemini-3.7-flash-high）。
 *
 * 用法：node scripts/tests/audit-popular-probe.js [--out-dir <dir>]
 */

var fs: typeof import('fs') = require('fs');
var path: typeof import('path') = require('path');
var inspect: typeof import('../maintenance/image-inspect.js') = require('../maintenance/image-inspect.js');
var popular: typeof import('../../src/utils/popularContent.ts') = require('../../src/utils/popularContent.ts');

var ROOT = path.resolve(__dirname, '..', '..');
var PROBE_ROOT = path.join(ROOT, '..', 'AI', 'Reviews', 'PopularProbe', '2026-08-14');
var MANIFEST = path.join(PROBE_ROOT, 'manifest.json');
var MODEL = inspect.DEFAULT_MODEL;

function readJson(file: PathOrFileDescriptor) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file: PathLike, value: any) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  var temporary = file + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(temporary, file);
}

async function auditImage(imagePath: string, expectText: string, strict: boolean) {
  var prompt = strict
    ? inspect.TASKS.audit + '\n【预期内容】' + expectText + '\n审核时先判断画面是否符合预期（人物、服装、姿势、构图、环境），不符合预期本身也要作为问题列出。\n\n图片文件：' + imagePath
    : '你是角色识别审核员。请判断图中角色是否可识别为预期角色。\n' + expectText +
      '\n输出格式：\n识别结果：是 / 否 / 存疑\n关键特征核对：特征 | 还原情况（逐一列出预期特征）\n场景符合度：符合 / 部分 / 不符合 + 一句话\n依据：一句话';
  var content = [
    { type: 'text', text: prompt },
    { type: 'image_url', image_url: { url: inspect.imageUrl(imagePath) } },
  ];
  var lastErr = null;
  for (var attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise(function (r) { setTimeout(r, 2000); });
    try {
      var j = await inspect.chatCompletion([{ role: 'user', content: content }], { maxTokens: strict ? 4000 : 1200, timeoutMs: 180000 }, MODEL);
      var text = j.choices && j.choices[0] && j.choices[0].message
        ? String(j.choices[0].message.content) : JSON.stringify(j).slice(0, 600);
      return { ok: true, content: text };
    } catch (e) {
      lastErr = e;
      var retriable = /HTTP 5\d\d/.test(runtimeErrorMessage(e)) || /超时/.test(runtimeErrorMessage(e)) || /ECONN|EPIPE|ETIMEDOUT/.test(runtimeErrorMessage(e));
      if (!retriable) break;
    }
  }
  return { ok: false, content: null, error: lastErr.message };
}

function parseResult(content: string|null, strict: boolean) {
  if (strict) {
    var text = String(content || '').replace(/^#+\s*结论\s*$/gm, '结论：');
    var m = text.match(/\*{0,2}\s*结论\s*\*{0,2}\s*[：:]\s*\*{0,2}\s*(通过|需复核|不通过)/);
    var score = text.match(/总分\s*[：:]\s*(\d+)\s*\/\s*80/);
    return {
      verdict: m ? m[1] : 'parse-fail',
      sceneFit: score ? Number(score[1]) : null,
      strict: true,
    };
  }
  var raw = String(content || '');
  var mm = raw.match(/识别结果\s*\*{0,2}\s*[：:]\s*\*{0,2}\s*(是|否|存疑)/);
  var scene = raw.match(/场景符合度\s*\*{0,2}\s*[：:]\s*\*{0,2}\s*(符合|部分|不符合)/);
  return {
    verdict: mm ? mm[1] : 'parse-fail',
    sceneFit: scene ? scene[1] : null,
    strict: false,
  };
}

async function main() {
  var strict = process.argv.includes('--strict');
  var manifest = readJson(MANIFEST);
  var characters = popular.parsePopularCharacters(readJson(path.join(ROOT, 'data', 'popular-characters.json')));
  var blueprints = popular.parseSceneBlueprints(readJson(path.join(ROOT, 'data', 'scene-blueprints.json')));
  var byId = {};
  characters.forEach(function (c) { byId[c.id] = c; });
  var bpByChar = {};
  blueprints.forEach(function (bp) { if (bp.characterId && !bpByChar[bp.characterId]) bpByChar[bp.characterId] = bp; });

  var records = manifest.records.filter(function (r: { status: string; }) { return r.status === 'succeeded'; });
  console.log('审核对象: ' + records.length + ' 张（' + MODEL + '）' + (strict ? ' [严格八维]' : ''));

  var outDir = path.join(PROBE_ROOT, 'audit');
  fs.mkdirSync(outDir, { recursive: true });
  var reportFile = path.join(outDir, strict ? 'strict-report.json' : 'recognition-report.json');
  var report = fs.existsSync(reportFile) ? readJson(reportFile) : { manifest: MANIFEST, model: MODEL, strict: strict, results: [] };
  // 离线重解析：修复正则后对已有 parse-fail 记录直接重解析，不重新请求。
  var repaired = 0;
  report.results.forEach(function (x: any) {
    if (x.verdict !== 'parse-fail' || !x.content) return;
    var parsed = parseResult(x.content, strict);
    if (parsed.verdict === 'parse-fail') return;
    x.verdict = parsed.verdict;
    x.sceneFit = parsed.sceneFit;
    repaired += 1;
  });
  if (repaired) { writeJson(reportFile, report); console.log('重解析 parse-fail: ' + repaired + ' 条'); }

  for (var i = 0; i < records.length; i++) {
    var r = records[i];
    if (report.results.some(function (x: any) { return x.characterId === r.characterId && x.engine === r.engine; })) continue;
    var imagePath = path.join(PROBE_ROOT, r.image);
    if (!fs.existsSync(imagePath)) { console.error('[缺失] ' + imagePath); continue; }
    var character = byId[r.characterId] || { identityProse: r.characterId };
    var bp = bpByChar[r.characterId];
    process.stderr.write('[' + (i + 1) + '/' + records.length + '] ' + r.engine + ' ' + r.characterId + ' → ' + MODEL + '\n');
    var expect = '角色：' + (character.displayName || r.characterId) + '（' + (character.franchise || '') + '）\n' +
      '身份描述：' + (character.identityProse || '') + '\n' +
      '预期场景：' + (bp ? bp.title + '（' + bp.promptProse + '）' : '（无）');
    var res = await auditImage(imagePath, expect, strict);
    if (!res.ok) {
      console.error('[失败] ' + r.characterId + ': ' + res.error);
      report.results.push({ characterId: r.characterId, engine: r.engine, ok: false, error: res.error, verdict: null, sceneFit: null, content: null });
    } else {
      var parsed = parseResult(res.content, strict);
      report.results.push({
        characterId: r.characterId, engine: r.engine, ok: true, error: null,
        verdict: parsed.verdict, sceneFit: parsed.sceneFit, content: res.content,
      });
    }
    writeJson(reportFile, report);
  }

  // 汇总
  var md = '#' + (strict ? 'Krea 2 热门角色严格八维审核' : 'Krea 2 热门角色识别审核') + '\n\n- 模型: ' + MODEL + '\n- 图片: ' + PROBE_ROOT + '\n\n';
  md += '## 结果\n\n| 角色 | 结论' + (strict ? '（总分/80）' : '') + ' | 备注 |\n|---|---|---|\n';
  var stats = {};
  report.results.forEach(function (x: any) {
    var label = x.ok ? (x.verdict || 'parse-fail') : '失败';
    stats[label] = (stats[label] || 0) + 1;
    var scoreLabel = x.sceneFit !== null && x.sceneFit !== undefined ? String(x.sceneFit) : '-';
    var firstLine = x.ok ? String(x.content || '').split('\n').filter(function (l) { return l.trim(); })[0] || '' : x.error;
    md += '| ' + x.characterId + ' | ' + label + (strict ? '（' + scoreLabel + '）' : '') + ' | ' + firstLine.slice(0, 70) + ' |\n';
  });
  md += '\n统计：' + JSON.stringify(stats) + '\n\n## 逐张详情\n\n';
  report.results.forEach(function (x: any) {
    md += '### ' + x.characterId + '（' + x.engine + '）· ' + (x.ok ? x.verdict : '失败') + '\n\n';
    md += x.ok ? x.content + '\n' : '错误：' + x.error + '\n';
  });
  var mdFile = path.join(outDir, strict ? 'strict-report.md' : 'recognition-report.md');
  fs.writeFileSync(mdFile, md, 'utf8');
  writeJson(reportFile, report);

  console.log('\n===== ' + (strict ? '严格审核' : '识别') + '汇总 =====');
  Object.entries(stats).forEach(function (e) { console.log(e[0] + ': ' + e[1]); });
  console.log('报告: ' + mdFile);
}

main().catch(function (error) {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
