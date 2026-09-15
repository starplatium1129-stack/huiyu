#!/usr/bin/env node
import { errorMessage as runtimeErrorMessage } from '../lib/runtime-errors';
'use strict';

import { PathOrFileDescriptor } from 'node:fs';

/* audit-unified-sweep.js — 对 Anima unified sweep 生成的实图执行两阶段审核并汇总。
 *
 * 两阶段设计（优化审核效率）：
 *   quick  硬伤快筛：轻量 prompt + group 批量（一次请求审多张），只判
 *          「通过/需复核/不通过」，快速淘汰明显不合格的图。
 *   full   完整八维精审：只对 quick 阶段「通过」和「需复核」的图执行
 *          （--stage full 或 --stage quick 可单独跑；默认两阶段串行）。
 *
 * 读取评估 manifest（evaluate-anima-unified.js 产物），调用本地视觉模型
 * （复用 image-inspect.js 的 audit 预设与请求逻辑），解析结论/总分，按候选
 * 汇总通过/需复核/不通过 计数与平均分，输出 JSON + Markdown 报告。
 *
 * 用法：
 *   node scripts/tests/audit-unified-sweep.js [manifest.json] [--out-dir <dir>] [--resume]
 *       [--stage quick|full] [--batch <n>] [--concurrency <n>]
 *
 *   --stage quick     只跑硬伤快筛（group 批量，最快）
 *   --stage full      只跑完整八维（配合 --resume 接着 quick 结果）
 *   --batch <n>       quick 阶段一次请求合并审 n 张（默认 6）
 *   --concurrency <n> 视觉 API 并发请求数（默认 3）
 */

var fs: typeof import('fs') = require('fs');
var path: typeof import('path') = require('path');
var http: typeof import('http') = require('http');
var inspect: typeof import('../maintenance/image-inspect.js') = require('../maintenance/image-inspect.js');

var ROOT = path.resolve(__dirname, '..', '..');
var AI_ROOT = path.resolve(ROOT, '..', 'AI');
var DEFAULT_MANIFEST = path.join(AI_ROOT, 'Reviews', 'AnimaUnifiedSweep', '2026-08-13_24s_cfg3', 'manifest.json');

// 角色身份锚点：审核「身份特征还原」维度的判定基准（expectFor 使用）。
// --character natsume 切换为夏目；不传默认宁宁（向后兼容）。
var CHARACTER_EXPECT: any = {
  nene: '绫地宁宁（ayachi_nene，白发/紫瞳/呆毛/粉色发带，宁宁）',
  natsume: '四季夏目（shiki_natsume，黑色长直发/金黄瞳/红色发夹/泪痣，夏目）',
};
var character = ''; // 由 main() 从 --character 解析（模块级，expectFor 使用）

var AUDIT_PROMPT = inspect.TASKS.audit;
var MODEL = inspect.DEFAULT_MODEL;

// quick 快筛：只判硬伤，轻量输出，一次可审多张（group 模式）。
var QUICK_PROMPT =
  '你是资深二次元 AI 绘画项目主审。下面会给出多张图片，请逐张快速判断是否存在【硬伤】：\n' +
  '  a. 手指/手掌结构崩坏、明显粘连或数量错误；\n' +
  '  b. 五官崩坏、错位或表情僵硬失真；\n' +
  '  c. 肢体缺失、比例严重错误、姿势扭曲僵硬或透视错误；\n' +
  '  d. 服装穿模、错乱或与角色设定冲突；\n' +
  '  e. 双人图两人特征/服装互相串位（双人图必查）；\n' +
  '  f. 明显伪影、异物悬浮、水印或乱码文字。\n' +
  '无任何硬伤 ⇒ 结论「通过」；有硬伤但轻微（可修复、不影响主体）⇒「需复核」；硬伤明显或致命 ⇒「不通过」。\n' +
  '【输出格式】严格按每张图一行：图片 N：结论 + 一句话理由（硬伤需给出具体位置）。不要展开长篇分析。';

function readJson(file: PathOrFileDescriptor) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

function writeJson(file: PathLike, value: any) {
  fs.mkdirSync(path.dirname(file), { recursive:true });
  var temporary = file + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(temporary, file);
}

function httpJson(urlPath: string, body: { model: string; messages: { role: string; content: ({ type: string; text: string; image_url?: any; }|{ type: string; image_url: { url: string; }; text?: any; })[]; }[]|{ role: string; content: { type: string; text: string; }[]; }[]; max_tokens: number; }, timeoutMs: string|number) {
  return new Promise(function (resolve, reject) {
    var url = new URL(inspect.DEFAULT_BASE_URL + urlPath);
    var payload = body ? JSON.stringify(body) : null;
    var req = http.request({
      hostname: url.hostname, port: url.port || 80, path: url.pathname, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + inspect.DEFAULT_API_KEY,
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, function (res) {
      var d = '';
      res.on('data', function (c) { d += c; });
      res.on('end', function () {
        var json = null;
        try { json = JSON.parse(d); } catch (error) {}
        if (res.statusCode >= 200 && res.statusCode < 300 && json) return resolve(json);
        var detail = json && json.error ? JSON.stringify(json.error) : d.slice(0, 600);
        reject(new Error('HTTP ' + res.statusCode + ': ' + detail));
      });
    });
    req.setTimeout(timeoutMs, function () { req.destroy(new Error('timeout ' + timeoutMs + 'ms')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** 冷却感知重试：429 model_cooldown 时按 reset_seconds 等待后重试；
 *  5xx/超时也重试。最多 maxAttempts 次，最后一次失败原样抛出。 */
async function withCooldownRetry(fn: any, maxAttempts?: number|undefined) {
  var attempts = maxAttempts || 5;
  for (var attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      var message = String((e && e.message) || e);
      var cooldown = message.match(/reset_seconds"?\s*[:=]\s*"?(\d+)/);
      var waitSeconds = cooldown ? Number(cooldown[1]) + 5 : (/HTTP 5\d\d/.test(message) || /timeout/.test(message) || /ECONN|EPIPE|ETIMEDOUT/.test(message) ? 3 : 0);
      if (attempt >= attempts - 1 || waitSeconds <= 0) throw e;
      process.stderr.write('[冷却等待 ' + waitSeconds + 's] ' + message.slice(0, 100) + '\n');
      await new Promise(function (r) { setTimeout(r, waitSeconds * 1000); });
    }
  }
}

async function auditImage(imagePath: string, expectText: string, prompt: string) {
  var content = [
    { type:'text', text: (prompt || AUDIT_PROMPT) + '\n【预期内容】' + expectText + '\n审核时先判断画面是否符合预期（人物、服装、姿势、构图、环境），不符合预期本身也要作为问题列出。\n\n图片文件：' + imagePath },
    { type:'image_url', image_url:{ url: inspect.imageUrl(imagePath) } },
  ];
  try {
    var j = await withCooldownRetry(function () {
      return httpJson('/chat/completions', {
        model: MODEL,
        messages:[{ role:'user', content:content }],
        max_tokens: 4000,
      }, 180000);
    });
    var text = j.choices && j.choices[0] && j.choices[0].message
      ? String(j.choices[0].message.content) : JSON.stringify(j).slice(0, 800);
    return { ok:true, content:text };
  } catch (e) {
    return { ok:false, content:null, error:runtimeErrorMessage(e) };
  }
}

/** group 快筛：一次请求合并审多张（quick 阶段专用），输出按图片 N 分行。 */
async function auditGroup(images: any, prompt: string) {
  var content = [
    { type:'text', text: (prompt || QUICK_PROMPT) + '\n\n本次共 ' + images.length + ' 张图片，严格按下面给出的图片编号逐一判断，不要遗漏任何一张。' },
  ];
  images.forEach(function (item: any, index: number) {
    content.push({ type:'text', text: '图片 ' + (index + 1) + ': ' + item.expect });
    content.push({ type:'image_url', image_url:{ url: inspect.imageUrl(item.imagePath) } });
  });
  try {
    var j = await withCooldownRetry(function () {
      return httpJson('/chat/completions', {
        model: MODEL,
        messages:[{ role:'user', content:content }],
        max_tokens: 4000,
      }, 180000);
    });
    var text = j.choices && j.choices[0] && j.choices[0].message
      ? String(j.choices[0].message.content) : JSON.stringify(j).slice(0, 800);
    return { ok:true, content:text };
  } catch (e) {
    return { ok:false, content:null, error:runtimeErrorMessage(e) };
  }
}

/** 从 group 回复中按行提取「图片 N：结论」；解析失败的行记为 parse-fail。 */
function parseGroupVerdicts(content: string|null, count: number) {
  var verdicts = [];
  var lines = String(content || '').split('\n');
  for (var i = 1; i <= count; i++) {
    var re = new RegExp('图片\\s*' + i + '\\s*[:：]', 'i');
    var line = lines.find(function (l) { return re.test(l); });
    if (!line) { verdicts.push({ verdict: 'parse-fail', score: null }); continue; }
    var m = line.match(/[:：]\s*(通过|需复核|不通过)/);
    var v = m && m[1] ? m[1] : 'parse-fail';
    if (v !== '通过' && v !== '需复核' && v !== '不通过') v = 'parse-fail';
    verdicts.push({ verdict: v, score: null });
  }
  return verdicts;
}

function parseVerdict(content: string|null) {
  // 归一化 Claude 风格（"## 结论" 独立标题行）为冒号风格
  var text = String(content || '').replace(/^#+\s*结论\s*$/gm, '结论：');
  var m = text.match(/\*{0,2}\s*结论\s*\*{0,2}\s*[：:]\s*\*{0,2}\s*(通过|需复核|不通过)/);
  var score = text.match(/总分\s*[：:]\s*(\d+)\s*\/\s*80/);
  return {
    verdict: m ? m[1] : 'parse-fail',
    score: score ? Number(score[1]) : null,
  };
}

function expectFor(scene: any, record: any) {
  var parts = ['场景：' + (scene.title || record.sceneId)];
  if (record.mature) parts.push('R18 成人内容');
  else parts.push('safe 非成人');
  parts.push('角色：' + (CHARACTER_EXPECT[character] || CHARACTER_EXPECT.nene));
  return parts.join('；');
}

async function main() {
  var args = process.argv.slice(2);
  var manifestFile = args.find(function (a) { return a.endsWith('.json'); }) || DEFAULT_MANIFEST;
  var outDirIndex = args.indexOf('--out-dir');
  var outDir = outDirIndex >= 0 ? args[outDirIndex + 1] : path.join(path.dirname(manifestFile), 'audit');
  var resume = args.includes('--resume');
  var characterIndex = args.indexOf('--character');
  character = characterIndex >= 0 ? String(args[characterIndex + 1] || '') : '';
  if (character && !CHARACTER_EXPECT[character]) {
    console.error('[错误] --character 只支持 nene 或 natsume，收到: ' + character);
    process.exit(2);
  }
  var stageIndex = args.indexOf('--stage');
  var stage = stageIndex >= 0 ? args[stageIndex + 1] : 'both';
  if (!['both', 'quick', 'full'].includes(stage)) {
    console.error('--stage 只支持 quick|full|both（默认 both）');
    process.exit(2);
  }
  var batchIndex = args.indexOf('--batch');
  var batchSize = batchIndex >= 0 ? Number(args[batchIndex + 1]) : 6;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 20) {
    console.error('--batch 必须是 1..20 的整数（默认 6）');
    process.exit(2);
  }
  var concIndex = args.indexOf('--concurrency');
  var concurrency = concIndex >= 0 ? Number(args[concIndex + 1]) : 3;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    console.error('--concurrency 必须是 1..16 的整数（默认 3）');
    process.exit(2);
  }

  if (!fs.existsSync(manifestFile)) {
    console.error('[错误] manifest 不存在: ' + manifestFile);
    process.exit(2);
  }
  var manifest = readJson(manifestFile);
  var scenes = new Map(manifest.scenes.map(function (s: any) { return [s.id, s]; }));
  var records = manifest.records.filter(function (r: { status: string; }) { return r.status === 'succeeded'; });
  console.log('审核对象: ' + records.length + ' 张（' + manifest.paramGroup + '），stage=' + stage + '，batch=' + (stage === 'full' ? 1 : batchSize) + '，并发=' + concurrency);

  fs.mkdirSync(outDir, { recursive:true });
  var reportFile = path.join(outDir, 'audit-report.json');
  var report = resume && fs.existsSync(reportFile) ? readJson(reportFile) : { manifest:manifestFile, paramGroup:manifest.paramGroup, stage:stage, results:[] };

  function findResult(r: any) {
    return report.results.find(function (x: any) {
      return x.candidate === r.candidate && x.sceneId === r.sceneId && x.seed === r.seed;
    });
  }

  // ---- quick 阶段：group 批量硬伤快筛 ----
  if (stage === 'both' || stage === 'quick') {
    var quickTodo = records.filter(function (r: any) {
      var existing = findResult(r);
      return !existing || existing.quickVerdict === undefined;
    });
    console.log('[quick] 待快筛: ' + quickTodo.length + ' 张（每批 ' + batchSize + ' 张合并一次请求）');

    var quickBatches: any = [];
    for (var qi = 0; qi < quickTodo.length; qi += batchSize) {
      quickBatches.push(quickTodo.slice(qi, qi + batchSize));
    }
    // worker 只负责 API 调用；结果由主线程按序写回，避免并发写同一 report 文件。
    async function quickCall(items: any) {
      return auditGroup(items, QUICK_PROMPT);
    }
    var quickNext = 0;
    async function quickWorker() {
      var results = [];
      while (true) {
        var bi = quickNext;
        quickNext += 1;
        if (bi >= quickBatches.length) return results;
        var batch = quickBatches[bi];
        var items = batch.map(function (r: any) {
          var scene = scenes.get(r.sceneId) || { title:r.sceneTitle || r.sceneId };
          return {
            imagePath: path.join(path.dirname(manifestFile), r.image),
            expect: expectFor(scene, r),
          };
        });
        process.stderr.write('[quick ' + (bi + 1) + '/' + quickBatches.length + '] 批 ' + batch.map(function (r: { candidate: string; sceneId: string; seed: string; }) { return r.candidate + ':' + r.sceneId + ':s' + r.seed; }).join(' ') + '\n');
        var res = await quickCall(items);
        results.push({ index: bi, batch: batch, res: res });
      }
    }
    var quickWorkers = [];
    for (var qw = 0; qw < Math.min(concurrency, quickBatches.length || 1); qw += 1) quickWorkers.push(quickWorker());
    var quickCollected = (await Promise.all(quickWorkers)).flat();
    quickCollected.sort(function (a, b) { return a.index - b.index; });
    quickCollected.forEach(function (item) {
      var batch = item.batch;
      var res = item.res;
      var verdicts = res.ok ? parseGroupVerdicts(res.content, batch.length) : [];
      for (var vi = 0; vi < batch.length; vi++) {
        var r = batch[vi];
        var scene: any = scenes.get(r.sceneId) || { title:r.sceneTitle || r.sceneId };
        var existing = findResult(r);
        var entry = existing || {
          candidate:r.candidate, epoch:r.epoch, sceneId:r.sceneId, sceneTitle:scene.title, mature:r.mature, seed:r.seed,
          image:r.image, ok:null, error:null, verdict:null, score:null, content:null,
        };
        if (res.ok) {
          entry.quickVerdict = verdicts[vi].verdict;
          entry.quickContent = res.content;
        } else {
          entry.quickError = res.error;
        }
        if (!existing) report.results.push(entry);
      }
      writeJson(reportFile, report);
    });
    var quickCounts: any = {};
    report.results.forEach(function (x: { quickVerdict: string|number; }) {
      if (!x.quickVerdict) return;
      quickCounts[x.quickVerdict] = (quickCounts[x.quickVerdict] || 0) + 1;
    });
    console.log('[quick] 完成: ' + JSON.stringify(quickCounts));
  }

  // ---- full 阶段：只对 quick 通过/需复核（或 quick 未跑时全部）做完整八维 ----
  if (stage === 'both' || stage === 'full') {
    var fullTodo = records.filter(function (r: any) {
      var existing = findResult(r);
      if (existing && existing.ok && existing.verdict) return false; // 已精审
      // quick 已判不通过的直接跳过（硬伤确认，无需精审浪费时间）；
      // both 与 full --resume 都生效（修复：full resume 曾重审 quick 淘汰图）
      if (existing && existing.quickVerdict === '不通过') return false;
      if (existing && existing.quickError) return true; // quick 失败仍补精审
      if (existing && existing.quickVerdict === 'parse-fail') return true;
      return true;
    });
    console.log('[full] 待精审: ' + fullTodo.length + ' 张（完整八维，逐张）');

    var fullNext = 0;
    async function fullWorker() {
      var results = [];
      while (true) {
        var fi = fullNext;
        fullNext += 1;
        if (fi >= fullTodo.length) return results;
        var r = fullTodo[fi];
        var scene = scenes.get(r.sceneId) || { title:r.sceneTitle || r.sceneId };
        var imagePath = path.join(path.dirname(manifestFile), r.image);
        if (!fs.existsSync(imagePath)) {
          console.error('[缺失] ' + imagePath);
          continue;
        }
        process.stderr.write('[full ' + (fi + 1) + '/' + fullTodo.length + '] ' + r.candidate + ' ' + r.sceneId + ' seed-' + r.seed + ' → ' + MODEL + '\n');
        var res = await auditImage(imagePath, expectFor(scene, r), AUDIT_PROMPT);
        results.push({ index: fi, record: r, res: res });
      }
    }
    var fullWorkers = [];
    for (var fw = 0; fw < Math.min(concurrency, fullTodo.length || 1); fw += 1) fullWorkers.push(fullWorker());
    var fullCollected = (await Promise.all(fullWorkers)).flat();
    fullCollected.sort(function (a, b) { return a.index - b.index; });
    fullCollected.forEach(function (item) {
      var r = item.record;
      var res = item.res;
      var scene: any = scenes.get(r.sceneId) || { title:r.sceneTitle || r.sceneId };
      var existing = findResult(r);
      var entry = existing || {
        candidate:r.candidate, epoch:r.epoch, sceneId:r.sceneId, sceneTitle:scene.title, mature:r.mature, seed:r.seed,
        image:r.image, ok:null, error:null, verdict:null, score:null, content:null,
      };
      if (res.ok) {
        var parsed = parseVerdict(res.content);
        entry.ok = true; entry.error = null;
        entry.verdict = parsed.verdict; entry.score = parsed.score; entry.content = res.content;
      } else {
        entry.ok = false; entry.error = res.error;
      }
      if (!existing) report.results.push(entry);
      writeJson(reportFile, report);
    });
  }

  // 汇总
  var byCandidate: any = {};
  report.results.forEach(function (x: any) {
    if (!byCandidate[x.candidate]) byCandidate[x.candidate] = { epoch:x.epoch, pass:0, review:0, reject:0, fail:0, scores:[] };
    var b = byCandidate[x.candidate];
    if (x.ok) {
      if (x.verdict === '通过') b.pass += 1;
      else if (x.verdict === '需复核') b.review += 1;
      else if (x.verdict === '不通过') b.reject += 1;
      else b.fail += 1; // 未知判定视为失败
    } else if (x.quickVerdict === '不通过') {
      b.reject += 1; // 快筛淘汰（未走精审），不是请求失败
    } else {
      b.fail += 1; // 请求失败 / quick 失败
    }
    if (x.score !== null) b.scores.push(x.score);
  });
  var order = Object.keys(byCandidate).sort(function (a, b) { return byCandidate[a].epoch - byCandidate[b].epoch; });

  var md = '# Anima Unified Sweep 审核汇总\n\n- manifest: `' + manifestFile + '`\n- 参数组: ' + manifest.paramGroup + '\n- 审核模型: ' + MODEL + '\n- 阶段: ' + stage + '\n\n';
  md += '## 各候选汇总（通过 / 需复核 / 不通过 / 失败，平均分满分 80）\n\n';
  md += '| 候选 | epoch | 通过 | 需复核 | 不通过 | 失败 | 平均分 |\n|---|---|---|---|---|---|---|\n';
  order.forEach(function (id) {
    var b = byCandidate[id];
    var avg = b.scores.length ? (b.scores.reduce(function (a: any, c: any) { return a + c; }, 0) / b.scores.length).toFixed(1) : '—';
    md += '| ' + id + ' | ' + b.epoch + ' | ' + b.pass + ' | ' + b.review + ' | ' + b.reject + ' | ' + b.fail + ' | ' + avg + ' |\n';
  });
  md += '\n## 逐张明细\n\n';
  report.results.forEach(function (x: any) {
    md += '### ' + x.candidate + ' · ' + x.sceneId + ' · seed-' + x.seed + (x.mature ? '（R18）' : '') + '\n\n';
    if (x.quickVerdict) md += '- 快筛：' + x.quickVerdict + (x.quickError ? '（错误：' + x.quickError + '）' : '') + '\n';
    var verdictLine = x.ok
      ? (x.verdict + (x.score !== null ? '（' + x.score + '/80）' : ''))
      : (x.quickVerdict === '不通过' ? '快筛不通过（未精审）' : '请求失败');
    md += '- 结论：' + verdictLine + '\n';
    if (x.ok) md += '\n' + x.content + '\n';
    else if (x.quickVerdict !== '不通过') md += '- 错误：' + x.error + '\n';
  });
  var mdFile = path.join(outDir, 'audit-report.md');
  fs.writeFileSync(mdFile, md, 'utf8');
  writeJson(reportFile, report);

  console.log('\n===== 汇总（' + manifest.paramGroup + '）=====');
  order.forEach(function (id) {
    var b = byCandidate[id];
    var avg = b.scores.length ? (b.scores.reduce(function (a: any, c: any) { return a + c; }, 0) / b.scores.length).toFixed(1) : '—';
    console.log(id + ' (e' + b.epoch + '): 通过 ' + b.pass + ' / 需复核 ' + b.review + ' / 不通过 ' + b.reject + ' / 失败 ' + b.fail + ' / 平均分 ' + avg);
  });
  console.log('报告: ' + mdFile);
}

main().catch(function (error) {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
