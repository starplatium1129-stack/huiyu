'use strict';

import { PathLike } from 'node:fs';

/**
 * routes/video/media.js —— 媒体资产与文件系统助手。
 *
 * 覆盖：模型/输入目录解析、受控文件名模式、魔数嗅探、图片头部尺寸解析、
 * 画布比例换算、模型可用性探测、结果文件安全路径与视频引用校验。
 * 所有路径写入都必须经 safeMediaPath / 受控前缀，杜绝路径逃逸。
 */

let fs: typeof import('fs') = require('fs');
let path: typeof import('path') = require('path');
let errors: typeof import('./errors') = require('./errors');
let constants: typeof import('./constants') = require('./constants');

let serviceError = errors.serviceError;
let isPlainObject = errors.isPlainObject;

// ── 目录解析 ────────────────────────────────────────────────────
function modelRoot(config: any) {
  return path.resolve(
    config.AI_WORKSPACE_ROOT || path.resolve(config.ROOT_DIR, '..', 'AI'),
    'ComfyUI',
    'models'
  );
}

// 首帧图片写入 ComfyUI/input，由 LoadImage 节点按文件名读取。
function imageInputRoot(config: any) {
  return path.resolve(
    config.AI_WORKSPACE_ROOT || path.resolve(config.ROOT_DIR, '..', 'AI'),
    'ComfyUI',
    'input'
  );
}

// ── 受控文件名契约 ──────────────────────────────────────────────
let IMAGE_INPUT_PATTERN = /^aics_video_input_[a-f0-9]{16,40}\.(png|jpg|jpeg|webp)$/i;
let IMAGE_REF_PATTERN = /^aics_video_ref_[a-f0-9]{16,40}\.(png|jpg|jpeg|webp)$/i;

function imageInputAvailable(config: unknown, name: string) {
  if (typeof name !== 'string') return false;
  if (!IMAGE_INPUT_PATTERN.test(name) && !IMAGE_REF_PATTERN.test(name)) return false;
  let target = path.resolve(imageInputRoot(config), name);
  try { return fs.statSync(target).isFile(); } catch (error) { return false; }
}

// ── 魔数嗅探与尺寸解析 ──────────────────────────────────────────
// 魔数识别：只信任解码后的真实格式，不信任客户端声称的 type。
function sniffImageExtension(buffer: string|unknown[]) {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50
    && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF'
    && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

// 只读文件头取真实像素尺寸（PNG IHDR / JPEG SOF / WebP VP8*），不整图解码。
// 512KB 头部窗口：PNG/WebP 的尺寸字段都在前 32 字节，JPEG SOF 标记实测也在
// 前几十 KB 内；此前 readFileSync 整图读取会为 ≤20MB 的上传白白吃一次内存带宽。
let IMAGE_HEADER_WINDOW = 512 * 1024;

function readImageSize(file: PathLike) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (error) { return null; }
  let headerWindow = Buffer.alloc(IMAGE_HEADER_WINDOW);
  try {
    let read = fs.readSync(fd, headerWindow, 0, IMAGE_HEADER_WINDOW, 0);
    if (!read) return null;
    let buffer = read === IMAGE_HEADER_WINDOW ? headerWindow : headerWindow.subarray(0, read);
    return parseImageHeaderSize(buffer);
  } catch (error) {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function parseImageHeaderSize(buffer: unknown[]|Buffer<ArrayBuffer>) {
  if (buffer.length >= 24 && buffer[0] === 0x89 && buffer[1] === 0x50
    && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { width:buffer.readUInt32BE(16), height:buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      let marker = buffer[offset + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { offset += 2; continue; }
      let length = buffer.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height:buffer.readUInt16BE(offset + 5), width:buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  if (buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF'
    && buffer.toString('ascii', 8, 12) === 'WEBP') {
    let chunk = buffer.toString('ascii', 12, 16);
    if (chunk === 'VP8 ' && buffer.length >= 30) {
      return { width:buffer.readUInt16LE(26) & 0x3fff, height:buffer.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L' && buffer.length >= 25) {
      let bits = buffer.readUInt32LE(21);
      return { width:(bits & 0x3fff) + 1, height:((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X' && buffer.length >= 30) {
      return { width:buffer.readUIntLE(24, 3) + 1, height:buffer.readUIntLE(27, 3) + 1 };
    }
  }
  return null;
}

// 按原图比例 + 档位目标面积计算 H3 画布：32 对齐、短边 ≤768、面积 ≤768×1344。
// 比例收敛到 0.5—2 防极端画幅；对齐后比例偏差 ≤~3%，肉眼无感。
function fitCanvasToRatio(width: number, height: number, quality: { sizes: { landscape: { width: number; height: number; }; }; }) {
  let ratio = Math.min(2, Math.max(0.5, width / height));
  let targetArea = quality.sizes.landscape.width * quality.sizes.landscape.height;
  let canvasW = Math.max(32, Math.round(Math.sqrt(targetArea * ratio) / 32) * 32);
  let canvasH = Math.max(32, Math.round(Math.sqrt(targetArea / ratio) / 32) * 32);
  if (Math.min(canvasW, canvasH) > 768) {
    let edgeScale = 768 / Math.min(canvasW, canvasH);
    canvasW = Math.max(32, Math.round(canvasW * edgeScale / 32) * 32);
    canvasH = Math.max(32, Math.round(canvasH * edgeScale / 32) * 32);
  }
  if (canvasW * canvasH > 768 * 1344) {
    let areaScale = Math.sqrt((768 * 1344) / (canvasW * canvasH));
    canvasW = Math.max(32, Math.round(canvasW * areaScale / 32) * 32);
    canvasH = Math.max(32, Math.round(canvasH * areaScale / 32) * 32);
  }
  return { width:canvasW, height:canvasH };
}

// ── 模型可用性 ──────────────────────────────────────────────────
function resourceAvailable(root: string, kind: string, file: string) {
  let base = path.resolve(root, kind);
  let target = path.resolve(base, file);
  if (target.indexOf(base + path.sep) !== 0) return false;
  try { return fs.statSync(target).isFile(); } catch (error) { return false; }
}

function modelAvailability(config: unknown, model: any) {
  let root = modelRoot(config);
  let missing = model.requirements.filter(function (requirement: string[]) {
    return !resourceAvailable(root, requirement[0], requirement[1]);
  }).map(function (requirement: string[]) {
    return requirement[0] + '/' + requirement[1];
  });
  return {
    available:model.executable && missing.length === 0,
    missing:missing,
    reason:!model.executable ? '适配器待验证' : (missing.length ? '缺少本机模型文件' : ''),
  };
}

// ── 输出目录与安全路径 ──────────────────────────────────────────
function ensureMediaRoot(config: any) {
  let outputs = config.RUNTIME && config.RUNTIME.outputs
    ? config.RUNTIME.outputs
    : path.join(config.RUNTIME_ROOT || path.join(config.ROOT_DIR, 'runtime'), 'outputs');
  let root = path.resolve(outputs, 'video');
  fs.mkdirSync(root, { recursive:true });
  return root;
}

function safeMediaPath(root: string, file: string) {
  let resolvedRoot = path.resolve(root);
  let resolved = path.resolve(root, file);
  return resolved.indexOf(resolvedRoot + path.sep) === 0 ? resolved : null;
}

function cleanupMediaRoot(config: unknown) {
  let root = ensureMediaRoot(config);
  let entries = [];
  try { entries = fs.readdirSync(root); } catch (error) { return; }
  entries.forEach(function (name) {
    let target = safeMediaPath(root, name);
    if (!target) return;
    try {
      let stat = fs.lstatSync(target);
      if (stat.isFile()) fs.unlinkSync(target);
    } catch (error) {}
  });
}

// 启动时清理由本服务写入的孤儿首帧图（网关重启后无活动任务引用它们）。
// 只清 aics_video_input_ 前缀；aics_video_ref_（参考卡）是跨任务资产，保留。
function cleanupImageInput(config: unknown) {
  let root = imageInputRoot(config);
  let entries = [];
  try { entries = fs.readdirSync(root); } catch (error) { return; }
  entries.forEach(function (name) {
    if (!IMAGE_INPUT_PATTERN.test(name)) return;
    try { fs.unlinkSync(path.resolve(root, name)); } catch (error) {}
  });
}

// 任务生命周期结束时删除其专属首帧图（文件名唯一、只被本 job 引用）。
function removeInputImage(config: unknown, name: string) {
  if (!IMAGE_INPUT_PATTERN.test(String(name || ''))) return;
  try { fs.unlinkSync(path.resolve(imageInputRoot(config), name)); } catch (error) {}
}

// ── 上游结果校验 ────────────────────────────────────────────────
function decodePathValue(value: unknown) {
  let decoded = String(value || '');
  for (let i = 0; i < 3; i += 1) {
    var next;
    try { next = decodeURIComponent(decoded); } catch (error) {
      throw serviceError(400, 'INVALID_RESULT', '结果路径编码无效');
    }
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

function validateVideoReference(value: unknown) {
  if (!isPlainObject(value)) throw serviceError(400, 'INVALID_RESULT', 'ComfyUI 视频描述无效');
  let type = String(value.type || 'output').toLowerCase();
  let filename = decodePathValue(value.filename);
  let subfolder = decodePathValue(value.subfolder || '');
  if (type !== 'output' || subfolder || filename !== path.basename(filename) || /[\\/\0]/.test(filename)) {
    throw serviceError(400, 'INVALID_RESULT', '视频结果路径不在应用允许范围内');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.(?:mp4|webm|mov)$/i.test(filename)) {
    throw serviceError(400, 'INVALID_RESULT', '结果必须是受支持的视频文件');
  }
  if (!new RegExp('^' + constants.OUTPUT_FILENAME_PREFIX + '(?:[_.-]|$)', 'i').test(filename)) {
    throw serviceError(400, 'INVALID_RESULT', '视频结果文件名前缀不受支持');
  }
  return { filename:filename, subfolder:'', type:'output' };
}

function videoMimeAndExtension(contentType: unknown, body: any, filename: string) {
  let mime = String(contentType || '').split(';')[0].trim().toLowerCase();
  let extension = path.extname(filename).slice(1).toLowerCase();
  if ((extension === 'mp4' || extension === 'mov')
    && body.length >= 12
    && body.toString('ascii', 4, 8) === 'ftyp') {
    return { mime:extension === 'mov' ? 'video/quicktime' : 'video/mp4', extension:extension };
  }
  if (extension === 'webm'
    && body.length >= 4
    && body.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    return { mime:'video/webm', extension:'webm' };
  }
  if (mime === 'video/mp4' && extension === 'mp4') return { mime:mime, extension:extension };
  return null;
}

export = {
  modelRoot:modelRoot,
  imageInputRoot:imageInputRoot,
  IMAGE_INPUT_PATTERN:IMAGE_INPUT_PATTERN,
  IMAGE_REF_PATTERN:IMAGE_REF_PATTERN,
  imageInputAvailable:imageInputAvailable,
  sniffImageExtension:sniffImageExtension,
  IMAGE_HEADER_WINDOW:IMAGE_HEADER_WINDOW,
  readImageSize:readImageSize,
  parseImageHeaderSize:parseImageHeaderSize,
  fitCanvasToRatio:fitCanvasToRatio,
  resourceAvailable:resourceAvailable,
  modelAvailability:modelAvailability,
  ensureMediaRoot:ensureMediaRoot,
  safeMediaPath:safeMediaPath,
  cleanupMediaRoot:cleanupMediaRoot,
  cleanupImageInput:cleanupImageInput,
  removeInputImage:removeInputImage,
  decodePathValue:decodePathValue,
  validateVideoReference:validateVideoReference,
  videoMimeAndExtension:videoMimeAndExtension,
};
