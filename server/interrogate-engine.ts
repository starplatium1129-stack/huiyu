import { errorMessage as runtimeErrorMessage } from '../scripts/lib/runtime-errors';
'use strict';

import type { PathOrFileDescriptor } from 'node:fs';
import type { InterrogateConfig, InterrogateModel, TagTable, ModelSession, InterrogateOptions, InterrogateResult } from './interrogate-types';

/**
 * server/interrogate-engine.js — WD14 本地真实反推引擎（ONNX，零网络依赖）
 *
 * 把 routes/interrogate.js 原「启发式假标签兜底」替换为真实 WD14 Tagger 推理。
 * 复用本机 ComfyUI-WD14-Tagger 已下载权重（onnx + 同名 csv），不经任何外部进程。
 *
 * 预处理 / 后处理严格对齐 pysssss 节点实现（wd14tagger.py）：
 *   1) 等比缩放到最长边 448 + 白底居中（fit: contain，非拉伸）
 *   2) RGB → BGR（moat 系列输入是 BGR），不归一化（0-255 float32），NHWC
 *   3) 输出 predictions_sigmoid 已是 sigmoid 概率 [1, 9083]
 *   4) general 阈值 0.35 / character 阈值 0.85，角色标签（category=4）在前
 *   5) 标签表 9083 行 = 4 rating + 6947 general + 2132 character
 *
 * 依赖 onnxruntime-node + sharp；缺失或找不到模型时返回 unavailable，
 * 由上层降级（不阻塞网关启动、不阻断反推链路）。
 */

let fs: typeof import('fs') = require('fs');
let path: typeof import('path') = require('path');

let MODEL_SIZE = 448;
let GENERAL_THRESHOLD = 0.35;
let CHARACTER_THRESHOLD = 0.85;
let DEFAULT_TOP_N = 100;
let RATING_NAMES = ['general', 'sensitive', 'questionable', 'explicit'];

// ── 懒加载原生依赖（缺失时优雅降级） ────────────────────────────────
let ort: typeof import("onnxruntime-node")|null = null;
type Sharp = (input?: any, options?: any) => any;
let sharp: Sharp|null = null;
let nativeLoadError: string|null = null;
function loadNative() {
  if (nativeLoadError) return null;
  if (ort && sharp) return { ort: ort, sharp: sharp };
  try {
    ort = (require('onnxruntime-node') as typeof import('onnxruntime-node'));
  } catch (e) {
    nativeLoadError = 'onnxruntime-node 不可用: ' + runtimeErrorMessage(e);
    return null;
  }
  try {
    sharp = (require('sharp') as Sharp);
  } catch (e) {
    nativeLoadError = 'sharp 不可用: ' + runtimeErrorMessage(e);
    return null;
  }
  return { ort: ort, sharp: sharp };
}

// ── 模型发现：扫描候选目录找 onnx + 同名 csv 成对存在 ───────────────
function candidateDirs(config?: InterrogateConfig | null) {
  let dirs = [];
  if (process.env.AICS_WD14_MODEL_DIR) dirs.push(process.env.AICS_WD14_MODEL_DIR);
  let ws = config && config.AI_WORKSPACE_ROOT;
  if (ws) {
    dirs.push(path.join(ws, 'ComfyUI', 'custom_nodes', 'ComfyUI-WD14-Tagger', 'models'));
    dirs.push(path.join(ws, 'ComfyUI', 'models', 'tagger'));
    dirs.push(path.join(ws, 'stable-diffusion-webui', 'models', 'WD14_tagger'));
  }
  // 项目自管目录（npm run interrogate:setup 可放这里）
  if (config && config.ROOT_DIR) {
    dirs.push(path.join(config.ROOT_DIR, 'runtime', 'models', 'interrogate'));
  }
  return dirs;
}

let modelCache: InterrogateModel | null = null;
function findModel(config?: InterrogateConfig | null) {
  if (modelCache) return modelCache;
  let dirs = candidateDirs(config);
  for (let i = 0; i < dirs.length; i++) {
    const dir = dirs[i];
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch (e) { continue; }
    const onnxFiles = entries.filter(function (f) { return /\.onnx$/i.test(f); });
    for (let j = 0; j < onnxFiles.length; j++) {
      let base = onnxFiles[j].slice(0, -5);
      let csvPath = path.join(dir, base + '.csv');
      if (!fs.existsSync(csvPath)) continue;
      modelCache = {
        dir: dir,
        modelName: base,
        onnxPath: path.join(dir, onnxFiles[j]),
        csvPath: csvPath,
        bytes: (function () { try { return fs.statSync(path.join(dir, onnxFiles[j])).size; } catch (e) { return 0; } })()
      };
      return modelCache;
    }
  }
  return null;
}
// 测试注入点
function _resetModelCache() { modelCache = null; }

// ── 标签表解析（保序，与输出索引一一对应） ─────────────────────────
let tagsCache: TagTable | null = null; // { names: [], generalIndex, characterIndex }
function loadTags(csvPath: PathOrFileDescriptor) {
  if (tagsCache && tagsCache.csvPath === csvPath) return tagsCache;
  let raw = fs.readFileSync(csvPath, 'utf8');
  let lines = raw.split(/\r?\n/);
  let names = [];
  let generalIndex = -1;
  let characterIndex = -1;
  let rowIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line || i === 0 && line.indexOf('tag_id') === 0) continue;
    let cols = line.split(',');
    if (cols.length < 3) continue;
    let category = cols[2];
    if (generalIndex === -1 && category === '0') generalIndex = rowIndex;
    else if (characterIndex === -1 && category === '4') characterIndex = rowIndex;
    names.push(cols[1]);
    rowIndex++;
  }
  if (generalIndex === -1) generalIndex = names.length;
  if (characterIndex === -1) characterIndex = names.length;
  tagsCache = { csvPath: csvPath, names: names, generalIndex: generalIndex, characterIndex: characterIndex };
  return tagsCache;
}

// ── 会话缓存（单例，按 onnx 路径失效） ─────────────────────────────
let sessionCache: ModelSession | null = null; // { onnxPath, session, inputName, outputName }
async function getSession(engine: NonNullable<ReturnType<typeof loadNative>>, model: InterrogateModel) {
  if (sessionCache && sessionCache.onnxPath === model.onnxPath && sessionCache.session) return sessionCache;
  let session = await engine.ort.InferenceSession.create(model.onnxPath, { executionProviders: ['cpu'] });
  sessionCache = {
    onnxPath: model.onnxPath,
    session: session,
    inputName: session.inputNames[0] || 'input_1:0',
    outputName: session.outputNames[0] || 'predictions_sigmoid'
  };
  return sessionCache;
}

/**
 * 图像预处理：等比缩放 + 白底居中 → RGB → BGR float32 [448*448*3]
 * 与 pysssss 节点逐位一致（sharp fit:contain 等价于「resize 到最长边 + 白边填充」）。
 */
async function preprocess(sharpLib: Sharp, imageBuffer: Buffer) {
  let image = sharpLib(imageBuffer).rotate().toColourspace('srgb');
  let meta = await image.metadata();
  if (!meta.width || !meta.height) throw new Error('无法读取图片尺寸');
  let resized = await image
    .resize(MODEL_SIZE, MODEL_SIZE, { fit: 'contain', background: { r: 255, g: 255, b: 255 } })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let rgb = resized.data; // Uint8Array 448*448*3
  let n = MODEL_SIZE * MODEL_SIZE * 3;
  let floatData = new Float32Array(n);
  for (let i = 0; i < MODEL_SIZE * MODEL_SIZE; i++) {
    let o = i * 3;
    // RGB -> BGR（moat 系列输入为 BGR）
    floatData[o] = rgb[o + 2];
    floatData[o + 1] = rgb[o + 1];
    floatData[o + 2] = rgb[o];
  }
  return floatData;
}

/**
 * 反推主入口：真实 WD14 推理。
 * @returns {Promise<{ok:boolean, engine:string, model:string, tags:string[], characterTags:string[], scores:object, rating:object, meta:object}|{ok:false, reason:string}>}
 */
async function interrogateTag(imageBuffer: Buffer, options: InterrogateOptions = {}): Promise<InterrogateResult> {
  options = options || {};
  let engine = loadNative();
  if (!engine) return { ok: false, reason: nativeLoadError || 'onnxruntime/sharp 不可用' };
  let config = options.config;
  let model = findModel(config);
  if (!model) return { ok: false, reason: '未找到 WD14 模型（onnx + csv），可安装 ComfyUI-WD14-Tagger 或配置 AICS_WD14_MODEL_DIR' };

  let threshold = options.threshold === undefined ? GENERAL_THRESHOLD : Number(options.threshold);
  let characterThreshold = options.characterThreshold === undefined ? CHARACTER_THRESHOLD : Number(options.characterThreshold);
  let topN = options.topN === undefined ? DEFAULT_TOP_N : Number(options.topN);

  let cached = await getSession(engine, model);
  let tags = loadTags(model.csvPath);

  let floatData = await preprocess(engine.sharp, imageBuffer);
  let feeds: Record<string, import('onnxruntime-node').Tensor> = {};
  feeds[cached.inputName] = new engine.ort.Tensor('float32', floatData, [1, MODEL_SIZE, MODEL_SIZE, 3]);
  let outputs = await cached.session.run(feeds);
  let probs = outputs[cached.outputName].data as Float32Array; // WD14 sigmoid output: float32 [9083]

  // 角色(general)与角色名(character)分离；2026-08-29：tags 只含 general，
  // 角色名单独走 characterTags——此前角色名 concat 进 tags 会随大流写入前端
  // manualTags，与当前作画角色身份行直接冲突（前端消费 characterTags 做冲突提示）。
  let general = [];
  for (let g = tags.generalIndex; g < tags.characterIndex; g++) {
    let p = probs[g];
    if (p > threshold) general.push({ tag: tags.names[g], score: p });
  }
  let character = [];
  for (let c = tags.characterIndex; c < tags.names.length; c++) {
    let pc = probs[c];
    if (pc > characterThreshold) character.push({ tag: tags.names[c], score: pc });
  }
  let capped = general.sort(function (a, b) { return b.score - a.score; }).slice(0, topN);

  let rating: Record<string, number> = {};
  for (let r = 0; r < RATING_NAMES.length; r++) {
    rating[RATING_NAMES[r]] = Number(probs[r].toFixed(4));
  }

  let scores: Record<string, number> = {};
  let tagList = capped.map(function (item) {
    scores[item.tag] = Number(item.score.toFixed(4));
    return item.tag;
  });

  return {
    ok: true,
    engine: 'wd14',
    model: model.modelName,
    tags: tagList,
    characterTags: character.map(function (item) { return item.tag; }),
    scores: scores,
    rating: rating,
    meta: {
      threshold: threshold,
      characterThreshold: characterThreshold,
      topN: topN,
      modelPath: model.onnxPath,
      modelBytes: model.bytes,
      modelDir: model.dir,
      count: tagList.length,
      ms: 0
    }
  };
}

/** 探测引擎可用性（不加载 session，轻量） */
function probe(config?: InterrogateConfig | null) {
  let engine = loadNative();
  if (!engine) return { available: false, reason: nativeLoadError || 'native 依赖缺失' };
  let model = findModel(config);
  if (!model) return { available: false, reason: '未找到 WD14 模型' };
  return {
    available: true,
    model: model.modelName,
    modelPath: model.onnxPath,
    modelBytes: model.bytes,
    dir: model.dir
  };
}

export = {
  interrogateTag: interrogateTag,
  probe: probe,
  findModel: findModel,
  _resetModelCache: _resetModelCache,
  loadTags: loadTags,
  GENERAL_THRESHOLD: GENERAL_THRESHOLD,
  CHARACTER_THRESHOLD: CHARACTER_THRESHOLD
};
