'use strict';

import type { ImageGenerationConfig, ImageJobInput, ImageModelDefinition, ImageLoraDefinition } from './types';
import { errorCode as runtimeErrorCode } from '../../scripts/lib/runtime-errors';

/**
 * routes/anima/media.js —— 媒体资产与文件系统助手：输入图白名单/资源存在性/
 * 结果魔数校验/受控落盘。2026-08-27 P1-b 切出，路径安全逻辑逐字未改。
 */

let fs: typeof import('fs') = require('fs');
let path: typeof import('path') = require('path');
let crypto: typeof import('crypto') = require('crypto');
let comfyClient: typeof import('../../server/comfy-client') = require('../../server/comfy-client');
let animaErrors: typeof import('./errors') = require('./errors');
let animaConstants: typeof import('./constants') = require('./constants');
let modelCatalog: typeof import('../../server/anima-model-catalog') = require('../../server/anima-model-catalog');

let serviceError = animaErrors.serviceError;
let isPlainObject = animaErrors.isPlainObject;
let requestComfy = comfyClient.requestComfy;
let MAX_IMAGE_BYTES = animaConstants.MAX_IMAGE_BYTES;
let INPUT_IMAGE_TTL_MS = animaConstants.INPUT_IMAGE_TTL_MS;
let OUTPUT_FILENAME_PREFIX = animaConstants.OUTPUT_FILENAME_PREFIX;
let MODELS: Readonly<Record<string, ImageModelDefinition>> = modelCatalog.MODELS;
let LORAS: Readonly<Record<string, ImageLoraDefinition>> = modelCatalog.LORAS;
let KREA_STYLE_LORAS: Readonly<Record<string, { file: string; trigger: string }>> = modelCatalog.KREA_STYLE_LORAS;

function decodePathValue(value: any) {
  let decoded = String(value || '');
  for (let i = 0; i < 3; i += 1) {
    var next;
    try { next = decodeURIComponent(decoded); } catch (error) { throw serviceError(400, 'INVALID_RESULT', '结果路径编码无效'); }
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}
function modelRoot(config: Pick<ImageGenerationConfig, 'ROOT_DIR' | 'AI_WORKSPACE_ROOT'>) {
  return path.resolve(config.AI_WORKSPACE_ROOT || path.resolve(config.ROOT_DIR, '..', 'AI'), 'ComfyUI', 'models');
}
function imageInputRoot(config: Pick<ImageGenerationConfig, 'ROOT_DIR' | 'AI_WORKSPACE_ROOT'>) {
  return path.resolve(config.AI_WORKSPACE_ROOT || path.resolve(config.ROOT_DIR, '..', 'AI'), 'ComfyUI', 'input');
}
let IMAGE_INPUT_PATTERN = /^aics_anima_input_[a-f0-9]{16,40}\.(png|jpg|jpeg|webp)$/i;
function imageInputAvailable(config: Pick<ImageGenerationConfig, 'ROOT_DIR' | 'AI_WORKSPACE_ROOT'>, name: any) {
  if (typeof name !== 'string') return false;
  if (!IMAGE_INPUT_PATTERN.test(name)) return false;
  let target = path.resolve(imageInputRoot(config), name);
  try { return fs.statSync(target).isFile(); } catch (error) { return false; }
}
function cleanupImageInputs(config: Pick<ImageGenerationConfig, 'ROOT_DIR' | 'AI_WORKSPACE_ROOT'>, protectedNames?: ReadonlySet<string>, ttlMs?: number) {
  let root = imageInputRoot(config);
  let keep = protectedNames || new Set();
  let cutoff = Date.now() - (Number(ttlMs) > 0 ? Number(ttlMs) : INPUT_IMAGE_TTL_MS);
  let entries = [];
  try { entries = fs.readdirSync(root); } catch (error) { return; }
  entries.forEach(function (name) {
    if (!IMAGE_INPUT_PATTERN.test(name) || keep.has(name)) return;
    let target = path.resolve(root, name);
    if (target.indexOf(path.resolve(root) + path.sep) !== 0) return;
    try {
      let stat = fs.statSync(target);
      if (stat.isFile() && stat.mtimeMs < cutoff) fs.unlinkSync(target);
    } catch (error) {}
  });
}
function sniffImageExtension(buffer: Buffer) {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50
    && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF'
    && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}
function resourceExists(root: string, kind: string, file: string) {
  let base = path.resolve(root, kind);
  let target = path.resolve(base, file);
  if (target.indexOf(base + path.sep) !== 0) return false;
  try { return fs.statSync(target).isFile(); } catch (error) { return false; }
}
function requiredResources(config: ImageGenerationConfig, input: ImageJobInput, loraRoot: string) {
  let root = modelRoot(config);
  let model = MODELS[input.modelId];
  let encoder = model.family === 'krea2' ? 'qwen3-vl-4b-heretic_fp8_e4m3fn.safetensors' : 'qwen_3_06b_base.safetensors';
  if (!resourceExists(root, 'diffusion_models', model.file)) throw serviceError(503, 'ANIMA_MODEL_UNAVAILABLE', '所选生成底模资源不可用');
  if (!resourceExists(root, 'text_encoders', encoder)) throw serviceError(503, 'ANIMA_ENCODER_UNAVAILABLE', '所选底模的文本编码器资源不可用');
  if (!resourceExists(root, 'vae', 'qwen_image_vae.safetensors')) throw serviceError(503, 'ANIMA_VAE_UNAVAILABLE', '所选底模的 VAE 资源不可用');
  if (input.loraId) {
    let lora = LORAS[input.loraId];
    if (!lora || !resourceExists(loraRoot, '', lora.file)) throw serviceError(503, 'ANIMA_LORA_UNAVAILABLE', '所选 Anima LoRA 文件不可用');
  }
  if (input.styleLoraId) {
    let styleLora = KREA_STYLE_LORAS[input.styleLoraId];
    if (!styleLora || !resourceExists(loraRoot, '', styleLora.file)) throw serviceError(503, 'KREA_STYLE_LORA_UNAVAILABLE', '所选 Krea 2 Style LoRA 文件不可用');
  }
  if (input.initImage && !imageInputAvailable(config, input.initImage)) {
    throw serviceError(503, 'ANIMA_IMAGE_UNAVAILABLE', '局部重绘底图不存在或已过期');
  }
  if (input.maskImage && !imageInputAvailable(config, input.maskImage)) {
    throw serviceError(503, 'ANIMA_MASK_UNAVAILABLE', '局部重绘遮罩图不存在或已过期');
  }
}
function imageMimeAndExtension(contentType: any, body: Buffer) {
  let mime = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (mime === 'image/png' && body.length >= 8 && body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { mime:'image/png', extension:'png' };
  if (mime === 'image/jpeg' && body.length >= 3 && body.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return { mime:'image/jpeg', extension:'jpg' };
  if (mime === 'image/webp' && body.length >= 12 && body.toString('ascii', 0, 4) === 'RIFF' && body.toString('ascii', 8, 12) === 'WEBP') return { mime:'image/webp', extension:'webp' };
  return null;
}
function validateImageReference(image: any, outputPrefix?: string) {
  if (!isPlainObject(image)) throw serviceError(400, 'INVALID_RESULT', 'ComfyUI 图片描述无效');
  let type = String(image.type || 'output').toLowerCase();
  if (type !== 'output') throw serviceError(400, 'INVALID_RESULT', '只允许读取 output 图片');
  let filename = decodePathValue(image.filename);
  let subfolder = decodePathValue(image.subfolder || '');
  if (!filename || subfolder || filename !== path.basename(filename) || /[\\/\0]/.test(filename)) {
    throw serviceError(400, 'INVALID_RESULT', '结果路径不在应用允许范围内');
  }
  if (/^[a-z]:/i.test(filename) || /^\\\\|^\//.test(filename) || filename.split(/[\\/]/).some(function (part) { return part === '..' || part === '.'; })) {
    throw serviceError(400, 'INVALID_RESULT', '结果路径不安全');
  }
  if (/(?:^|[-_.])(input|temp|annotation|annotations|hash)(?:[-_.]|$)/i.test(filename)) {
    throw serviceError(400, 'INVALID_RESULT', '结果类型或路径不允许');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.(?:png|jpe?g|webp)$/i.test(filename)) {
    throw serviceError(400, 'INVALID_RESULT', '结果必须是图片文件');
  }
  let prefix = outputPrefix || OUTPUT_FILENAME_PREFIX;
  if (!new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:[_.-]|$)', 'i').test(filename)) {
    throw serviceError(400, 'INVALID_RESULT', '结果文件名前缀不受支持');
  }
  return { filename:filename, subfolder:'', type:'output' };
}
function ensureMediaRoot(config: Pick<ImageGenerationConfig, 'ROOT_DIR' | 'RUNTIME_ROOT' | 'RUNTIME'>, namespace?: string) {
  let outputs = config.RUNTIME && config.RUNTIME.outputs
    ? config.RUNTIME.outputs
    : path.join(config.RUNTIME_ROOT || path.join(config.ROOT_DIR, 'runtime'), 'outputs');
  let root = path.resolve(outputs, namespace || 'anima');
  fs.mkdirSync(root, { recursive:true });
  return root;
}
function safeMediaPath(root: string, file: string) {
  let resolvedRoot = path.resolve(root);
  let resolved = path.resolve(root, file);
  if (resolved.indexOf(resolvedRoot + path.sep) !== 0) return null;
  return resolved;
}
function cleanupMediaRoot(config: Pick<ImageGenerationConfig, 'ROOT_DIR' | 'RUNTIME_ROOT' | 'RUNTIME'>, namespace?: string) {
  let root = ensureMediaRoot(config, namespace);
  let entries = [];
  try { entries = fs.readdirSync(root); } catch (error) { return; }
  entries.forEach(function (name) {
    let target = safeMediaPath(root, name);
    if (!target) return;
    try {
      let stat = fs.lstatSync(target);
      if (stat.isDirectory()) fs.rmSync(target, { recursive:true, force:true });
      else fs.unlinkSync(target);
    } catch (error) {}
  });
}
async function materializeResult(config: ImageGenerationConfig, job: { id: string; }, image: any, options: { outputPrefix?: string; mediaNamespace?: string }) {
  let reference = validateImageReference(image, options.outputPrefix);
  let query = '?filename=' + encodeURIComponent(reference.filename) + '&type=output';
  let response = await requestComfy(config, 'GET', '/view' + query, null, 20000, MAX_IMAGE_BYTES);
  if (response.status < 200 || response.status >= 300) throw serviceError(502, 'COMFY_RESULT_ERROR', 'ComfyUI 图片读取失败');
  let info = imageMimeAndExtension(response.headers['content-type'], response.body);
  if (!info || !response.body.length || response.body.length > MAX_IMAGE_BYTES) {
    throw serviceError(502, 'INVALID_RESULT', 'ComfyUI 返回的结果不是受支持的图片');
  }

  let root = ensureMediaRoot(config, options.mediaNamespace);
  let filename = job.id + '.' + info.extension;
  let target = safeMediaPath(root, filename);
  if (!target) throw serviceError(500, 'MEDIA_PATH_INVALID', '应用媒体路径无效');
  let temporary = target + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  // 异步落盘（2026-08-21 性能审计 #1）：≤20MB 的 writeFileSync 同步写会短暂
  // 冻结事件循环，与视频/聊天流共享同一个进程。
  try {
    await fs.promises.writeFile(temporary, response.body, { flag:'wx', mode:0o600 });
    await fs.promises.rename(temporary, target);
    let realRoot = fs.realpathSync(root);
    let realTarget = fs.realpathSync(target);
    if (realTarget.indexOf(realRoot + path.sep) !== 0) throw serviceError(500, 'MEDIA_PATH_INVALID', '应用媒体路径无效');
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (ignore) {}
    if (['ENOSPC', 'EACCES', 'EPERM', 'EROFS', 'EIO'].includes(String(runtimeErrorCode(error)))) {
      throw serviceError(507, 'RESULT_SAVE_FAILED', '生成图片保存失败，请检查本地磁盘空间和目录写入权限（' + runtimeErrorCode(error) + '）');
    }
    throw error;
  }
  return { path:target, mime:info.mime, bytes:response.body.length };
}

export = {
  decodePathValue:decodePathValue,
  modelRoot:modelRoot,
  imageInputRoot:imageInputRoot,
  IMAGE_INPUT_PATTERN:IMAGE_INPUT_PATTERN,
  imageInputAvailable:imageInputAvailable,
  cleanupImageInputs:cleanupImageInputs,
  sniffImageExtension:sniffImageExtension,
  resourceExists:resourceExists,
  requiredResources:requiredResources,
  imageMimeAndExtension:imageMimeAndExtension,
  validateImageReference:validateImageReference,
  ensureMediaRoot:ensureMediaRoot,
  safeMediaPath:safeMediaPath,
  cleanupMediaRoot:cleanupMediaRoot,
  materializeResult:materializeResult,
};
