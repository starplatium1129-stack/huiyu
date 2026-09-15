#!/usr/bin/env node
import { errorMessage as runtimeErrorMessage } from '../lib/runtime-errors';
/**
 * image-inspect.js — 通用识图脚本（本地视觉模型）
 *
 * 通过本地 CLIProxyAPI（OpenAI 兼容 /v1/chat/completions）调用视觉模型识别本地图片，
 * 等价于 opencode 配置中的 vision / gemini-vision agent（gemini-3.7-flash-high）。
 * 主端点连不上时（ECONNREFUSED 等）自动回退到本地 llama-server（默认 127.0.0.1:8000/v1，
 * 需 --mmproj 启动，模型 ID 自动取自其 /v1/models）；--no-fallback 可禁用回退。
 * 零第三方依赖，只使用 Node 内置模块。
 *
 * 用法：
 *   node scripts/maintenance/image-inspect.js <图片|目录>... [选项]
 *
 * 选项：
 *   -t, --task <describe|audit|ocr|score>  任务预设（默认 describe）
 *   -p, --prompt "<文本>"                   自定义提示词（覆盖任务预设）
 *   -m, --model <模型名>                    视觉模型（默认 gemini-3.7-flash-high）
 *       --mode <each|group>                 each=逐张独立请求（默认）；group=多图合并一次请求
 *       --concurrency <n>                   并发请求数（仅 each 模式，默认 1，上限 8）
 *   -o, --out <文件>                        结果写入 Markdown 文件
 *       --json                              stdout 只输出 JSON 结果
 *       --max-tokens <n>                    单次回答上限（默认 4000）
 *       --timeout <ms>                      单次请求超时（默认 180000）
 *   -h, --help                              显示帮助
 *
 * 环境变量（可选覆盖）：VISION_BASE_URL / VISION_API_KEY / VISION_MODEL / VISION_FALLBACK_BASE_URL
 */
'use strict';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const http: typeof import('http') = require('http');

const DEFAULT_BASE_URL = process.env.VISION_BASE_URL || 'http://127.0.0.1:8317/v1';
// Key 解析顺序：VISION_API_KEY 环境变量 → runtime/vision-api-key.txt（gitignored，首行）→ 空。
// 严禁把真实 key 写回本文件作为默认值：仓库可能被推送/共享，硬编码凭据等于泄漏
// （2026-08-22 安全清理；历史默认值已从注释与本仓库全部文档中抹除）。
function resolveVisionApiKey() {
  const fromEnv = String(process.env.VISION_API_KEY || '').trim();
  if (fromEnv) return fromEnv;
  try {
    const keyFile = path.join(__dirname, '..', '..', 'runtime', 'vision-api-key.txt');
    const fromFile = fs.readFileSync(keyFile, 'utf8').split(/\r?\n/)[0].trim();
    if (fromFile) return fromFile;
  } catch { /* 文件不存在视为未配置 */ }
  return '';
}
const DEFAULT_API_KEY = resolveVisionApiKey();
if (!DEFAULT_API_KEY) {
  console.error('⚠️ 未配置视觉后端 API key：请设 VISION_API_KEY 环境变量，或把 key 写入 runtime/vision-api-key.txt 首行（该文件已被 .gitignore 忽略）。');
}
const DEFAULT_MODEL = process.env.VISION_MODEL || 'gemini-3.7-flash-high';
// 主端点连接失败时回退的本地 llama-server 后端；与主端点相同则视为禁用（亦可 --no-fallback）
const FALLBACK_BASE_URL = process.env.VISION_FALLBACK_BASE_URL || 'http://127.0.0.1:8000/v1';
const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // base64 后 ≈20MB，对齐 opencode attachment 上限

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

const TASKS: any = {
  describe:
    '请详细、准确地描述这张图片的内容：主体、人物、场景、构图、色彩、光照、风格与氛围；' +
    '画面中的文字请一并转录。请用中文回答。',
  audit:
    '你是资深二次元 AI 绘画项目主审，审核标准对齐项目展示集定稿样张水准。审核必须同时覆盖【人物细节】与【整体画面】两类维度，规则严格遵守：\n' +
    '【判定铁律】出现以下任一硬伤，结论必须为「不通过」：\n' +
    '  a. 手指/手掌结构崩坏、明显粘连或数量错误；\n' +
    '  b. 五官崩坏、错位或表情僵硬失真；\n' +
    '  c. 肢体缺失、比例严重错误、姿势扭曲僵硬或透视错误；\n' +
    '  d. 服装穿模、错乱或与角色设定冲突；\n' +
    '  e. 双人图两人特征/服装互相串位（双人图必查）；\n' +
    '  f. 明显伪影、异物悬浮、水印或乱码文字。\n' +
    '无硬伤但存在明显可提升项（细节含糊、构图平庸、氛围平淡、背景空泛）⇒「需复核」；无硬伤且整体达到定稿水准 ⇒「通过」。不得用「需复核」为硬伤开脱。\n' +
    '【量化打分】八维各 0-10 分（满分 80）：\n' +
    '  1. 身份特征还原（发型/发色/瞳色/标志性装饰与设定一致）\n' +
    '  2. 脸部与神态（五官精致度、表情自然度、神态传达与情绪契合）\n' +
    '  3. 服装（款式/配色/细节完整度）\n' +
    '  4. 肢体结构与姿势（结构正确性、姿势动态自然度与表现力、透视）\n' +
    '  5. 构图（取景、主体位置、平衡、节奏、留白、景深层次）\n' +
    '  6. 背景与细节（背景实体感、细节丰富度、前后景层次、物体合理性）\n' +
    '  7. 光影与氛围（光照逻辑、明暗层次、氛围营造、通透度）\n' +
    '  8. 完成度与叙事（整体完成度、场景叙事成立、画面感染力）\n' +
    '存在硬伤时总分强制 ≤48。\n' +
    '【禁止含糊】每个问题必须给出具体位置（如"画面右侧，人物左手小指与无名指粘连"）与修复方向；不得使用"略有""似乎""可能"等模糊措辞。\n' +
    '【输出格式】每张图严格按以下结构：\n' +
    '  结论：通过 / 需复核 / 不通过\n' +
    '  各维度评分：维度 | 分数 | 一句话依据（八维全列）\n' +
    '  问题清单：位置 + 问题 + 修复方向（无则写"无"；人物细节与整体画面问题都算）\n' +
    '  总评：一句话（点出该图最强的维度和最拖后腿的维度）\n' +
    '宁可多标问题，不可放过硬伤；请用中文回答。',
  ocr:
    '请识别这张图片中的全部文字，按出现位置整理输出；若图片不含文字请明确说明。请用中文回答。',
  score:
    '请按以下维度为这张图片打分（每维 0-20，满分 100）：光影通透、背景实体感、角色服装发型细节、氛围、完成度。' +
    '输出各维度分数、总分与一句总评。请用中文回答。',
};

function printHelp() {
  console.log(`用法：node ${path.basename(process.argv[1])} <图片|目录>... [选项]

通过本地 CLIProxyAPI 调用视觉模型识别图片（等价于 opencode 的 vision agent）；
主端点连不上时自动回退本地 llama-server（--no-fallback 禁用）。

选项：
  -t, --task <describe|audit|ocr|score>  任务预设（默认 describe）
  -p, --prompt "<文本>"                   自定义提示词（覆盖任务预设）
  -e, --expect "<预期>"                   audit 任务专用：预期内容（提示词），审核时判断画面是否符合
  -m, --model <模型名>                    视觉模型（默认 ${DEFAULT_MODEL}）
      --mode <each|group>                 each=逐张独立请求（默认）；group=多图合并一次请求
      --concurrency <n>                   并发请求数（仅 each 模式，默认 1，上限 8）
  -o, --out <文件>                        结果写入 Markdown 文件
      --json                              stdout 只输出 JSON 结果
      --max-tokens <n>                    单次回答上限（默认 4000）
      --timeout <ms>                      单次请求超时（默认 180000）
      --no-fallback                       禁用主端点连不上时回退到本地 llama-server
  -h, --help                              显示帮助

环境变量（可选覆盖）：VISION_BASE_URL / VISION_API_KEY / VISION_MODEL / VISION_FALLBACK_BASE_URL
示例：
  node scripts/maintenance/image-inspect.js out.png
  node scripts/maintenance/image-inspect.js AI/Reviews/SceneFix/sc001 -t audit -o audit.md
  node scripts/maintenance/image-inspect.js a.png b.png --mode group -p "对比两张图并说明差异"`);
}

function parseArgs(argv: any) {
  const opts = {
    task: 'describe', mode: 'each', model: null, prompt: null, expect: null,
    out: null, json: false, maxTokens: 4000, timeoutMs: 180000, help: false,
    noFallback: false, concurrency: 1, paths: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a: any = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '-t': case '--task': opts.task = next(); break;
      case '-p': case '--prompt': opts.prompt = next(); break;
      case '-e': case '--expect': opts.expect = next(); break;
      case '-m': case '--model': opts.model = next(); break;
      case '--mode': opts.mode = next(); break;
      case '--concurrency': opts.concurrency = Math.max(1, Math.min(8, Number(next()) || 1)); break;
      case '-o': case '--out': opts.out = next(); break;
      case '--json': opts.json = true; break;
      case '--max-tokens': opts.maxTokens = Number(next()); break;
      case '--timeout': opts.timeoutMs = Number(next()); break;
      case '--no-fallback': opts.noFallback = true; break;
      case '-h': case '--help': opts.help = true; break;
      default:
        if (a.startsWith('-')) {
          console.error(`[错误] 未知选项: ${a}（--help 查看用法）`);
          process.exit(2);
        }
        opts.paths.push(a);
    }
  }
  return opts;
}

function collectImages(inputs: any) {
  const files: any[] = [];
  for (const p of inputs) {
    if (!fs.existsSync(p)) { console.error(`[错误] 路径不存在: ${p}`); continue; }
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const f of fs.readdirSync(p)) {
        const full = path.join(p, f);
        if (!IMAGE_EXT.has(path.extname(f).toLowerCase())) continue;
        if (fs.statSync(full).isFile()) files.push({ file: full, size: fs.statSync(full).size });
      }
      files.sort((a: any, b: any) => a.file.localeCompare(b.file));
    } else if (st.isFile()) {
      files.push({ file: p, size: st.size });
    }
  }
  return files;
}

function httpJson(method: any, urlPath: any, body: any, opts: any, base: any) {
  return new Promise<any>((resolve: any, reject: any) => {
    const url = new URL((base || DEFAULT_BASE_URL) + urlPath);
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: url.hostname, port: url.port || 80, path: url.pathname, method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEFAULT_API_KEY}`,
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res: any) => {
      let d = '';
      res.on('data', (c: any) => d += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(d); } catch { /* raw below */ }
        if (res.statusCode >= 200 && res.statusCode < 300 && json) return resolve(json);
        const detail = json && json.error ? JSON.stringify(json.error) : d.slice(0, 600);
        reject(new Error(`HTTP ${res.statusCode}: ${detail}`));
      });
    });
    req.setTimeout(opts.timeoutMs, () => req.destroy(new Error(`请求超时（${opts.timeoutMs}ms）`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function chatCompletion(messages: any, opts: any, model: any, base: any) {
  return httpJson('POST', '/chat/completions', {
    model,
    messages,
    max_tokens: opts.maxTokens,
  }, opts, base);
}

function imageUrl(file: any) {
  const ext = path.extname(file).toLowerCase().replace('.', '');
  const mime = ext === 'jpg' ? 'jpeg' : ext;
  return 'data:image/' + mime + ';base64,' + fs.readFileSync(file).toString('base64');
}

function isConnectionError(err: any) {
  return /ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|超时/.test(err);
}

async function fetchModelId(base: any, opts: any) {
  const j = await httpJson('GET', '/models', null, opts, base);
  const id = j && j.data && j.data[0] && j.data[0].id;
  if (!id) throw new Error(`${base} 的 /v1/models 未返回模型`);
  return id;
}

async function attemptBackend(base: any, model: any, messages: any, opts: any, file: any) {
  let lastErr: any = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      console.error(`[重试 ${attempt}] ${file || 'group'}（等待 2s）`);
      await new Promise<any>((r: any) => setTimeout(r, 2000));
    }
    try {
      const j = await chatCompletion(messages, opts, model, base);
      const content = j.choices && j.choices[0] && j.choices[0].message
        ? j.choices[0].message.content
        : JSON.stringify(j).slice(0, 800);
      return { ok: true, content, model };
    } catch (e) {
      lastErr = e;
      const retriable = /HTTP 5\d\d/.test(runtimeErrorMessage(e)) || /超时/.test(runtimeErrorMessage(e)) || /ECONN|EPIPE|ETIMEDOUT/.test(runtimeErrorMessage(e));
      if (!retriable) break;
    }
  }
  return { ok: false, content: null, model, error: lastErr.message };
}

async function requestWithRetry(messages: any, opts: any, model: any, file: any) {
  const r1 = await attemptBackend(DEFAULT_BASE_URL, model, messages, opts, file);
  if (r1.ok || opts.noFallback || !isConnectionError(r1.error)) return r1;
  if (FALLBACK_BASE_URL === DEFAULT_BASE_URL) return r1;
  console.error(`[fallback] 主视觉端点不可用（${r1.error}）→ 本地 llama-server ${FALLBACK_BASE_URL}`);
  try {
    const fbModel = await fetchModelId(FALLBACK_BASE_URL, opts);
    console.error(`[fallback] 使用模型 ${fbModel}`);
    const r2 = await attemptBackend(FALLBACK_BASE_URL, fbModel, messages, opts, file);
    if (r2.ok) return r2;
    return { ok: false, content: null, model: r1.model, error: `${r1.error}；fallback 亦失败：${r2.error}` };
  } catch (e) {
    return { ok: false, content: null, model: r1.model, error: `${r1.error}；fallback 不可用：${runtimeErrorMessage(e)}` };
  }
}

function buildTextAndImages(prompt: any, files: any, labeled: any) {
  const text = labeled
    ? `${prompt}\n\n本次共 ${files.length} 张图片，请严格按编号逐一分析，不要遗漏。`
    : prompt;
  const content = [{ type: 'text', text }];
  files.forEach((f: any, i: any) => {
    content.push({
      type: 'image_url',
      image_url: { url: imageUrl(f.file) },
    });
    if (labeled) {
      content.push({ type: 'text', text: `图片 ${i + 1}: ${f.file}` });
    }
  });
  return content;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { printHelp(); return; }
  if (opts.paths.length === 0) {
    console.error('[错误] 至少需要一个图片路径或目录（--help 查看用法）');
    process.exit(2);
  }
  if (!['each', 'group'].includes(opts.mode)) {
    console.error(`[错误] --mode 只支持 each 或 group，收到: ${opts.mode}`);
    process.exit(2);
  }
  const taskPrompt = opts.prompt || TASKS[opts.task];
  if (!taskPrompt) {
    console.error(`[错误] 未知任务: ${opts.task}（describe|audit|ocr|score）`);
    process.exit(2);
  }
  const finalPrompt = (opts.task === 'audit' && opts.expect)
    ? `${taskPrompt}\n【预期内容】${opts.expect}\n审核时先判断画面是否符合预期（人物、服装、姿势、构图、环境），不符合预期本身也要作为问题列出。`
    : taskPrompt;

  const files = collectImages(opts.paths);
  if (files.length === 0) {
    console.error('[错误] 没有找到可识别的图片');
    process.exit(2);
  }
  const model = opts.model || DEFAULT_MODEL;
  const results: any[] = [];
  const skipped: any[] = [];

  if (opts.mode === 'group') {
    const tooBig = files.find((f: any) => f.size > MAX_IMAGE_BYTES);
    if (tooBig) {
      console.error(`[错误] group 模式图片过大（>${MAX_IMAGE_BYTES / 1024 / 1024}MB）: ${tooBig.file}`);
      process.exit(2);
    }
    console.error(`[识图] ${files.length} 张图 → ${model}（group）`);
    const content = buildTextAndImages(finalPrompt, files, true);
    const r = await requestWithRetry([{ role: 'user', content }], opts, model, files.map((f: any) => f.file).join('; '));
    results.push({
      mode: 'group',
      model: r.model,
      prompt: taskPrompt,
      files: files.map((f: any) => f.file),
      ok: r.ok,
      content: r.content,
      error: r.error || null,
    });
  } else {
    const n = Math.max(1, Math.min(8, Math.floor(opts.concurrency) || 1));
    if (n > 1) console.error(`[并发] ${n} 路并行请求（each 模式）`);
    const resultsArr = new Array(files.length);
    const runOne = async (f: any, i: any) => {
      if (f.size > MAX_IMAGE_BYTES) {
        console.error(`[跳过] 图片过大（>${MAX_IMAGE_BYTES / 1024 / 1024}MB）: ${f.file}`);
        skipped.push(f.file);
        return { mode: 'each', model, file: f.file, ok: false, content: null, error: '图片过大被跳过' };
      }
      console.error(`[识图 ${i + 1}/${files.length}] ${f.file} → ${model}`);
      const content = [
        { type: 'text', text: `${finalPrompt}\n\n图片文件：${f.file}` },
        { type: 'image_url', image_url: { url: imageUrl(f.file) } },
      ];
      const r = await requestWithRetry([{ role: 'user', content }], opts, model, f.file);
      return { mode: 'each', model: r.model, file: f.file, ok: r.ok, content: r.content, error: r.error || null };
    };
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(n, files.length) }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= files.length) return;
        resultsArr[i] = await runOne(files[i], i);
      }
    }));
    results.push(...resultsArr);
  }

  if (opts.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const r of results) {
      const label = r.mode === 'group' ? `[group] ${r.files.length} 张图` : r.file;
      console.log(`\n===== ${label} =====`);
      if (r.ok) console.log(r.content);
      else console.error(`[失败] ${r.error}`);
    }
  }
  if (opts.out) {
    const md = results.map((r: any) => {
      const title = r.mode === 'group'
        ? `## Group（${r.files.length} 张图）\n\n${r.files.map((f: any) => `- \`${f}\``).join('\n')}`
        : `## ${r.file}`;
      return `${title}\n\n${r.ok ? r.content : `> 失败：${r.error}`}\n`;
    }).join('\n');
    fs.writeFileSync(opts.out, md, 'utf8');
    console.error(`[已写入] ${opts.out}`);
  }

  const failed = results.filter((r: any) => !r.ok).length;
  if (skipped.length) console.error(`[跳过] ${skipped.length} 张（图片过大）`);
  process.exit(failed ? 1 : 0);
}

if (require.main === module) {
  main().catch(function (error: any) { console.error('[错误]', error.message); process.exit(1); });
}

export = {
  TASKS: TASKS,
  DEFAULT_BASE_URL: DEFAULT_BASE_URL,
  DEFAULT_API_KEY: DEFAULT_API_KEY,
  DEFAULT_MODEL: DEFAULT_MODEL,
  FALLBACK_BASE_URL: FALLBACK_BASE_URL,
  isConnectionError: isConnectionError,
  MAX_IMAGE_BYTES: MAX_IMAGE_BYTES,
  imageUrl: imageUrl,
  chatCompletion: chatCompletion,
  requestWithRetry: requestWithRetry,
};
