'use strict';

import type { ImageJobInput, ImageModelDefinition, ImageLoraDefinition } from './types';
type RequestContext = Parameters<typeof import('../../server/security').isDirectLocalRequest>[0];

/**
 * routes/anima/validation.js —— 输入白名单校验与成人内容 fail-closed 双门。
 * 2026-08-27 P1-b 自 anima.js 切出，规则文本未改。
 */

let crypto: typeof import('crypto') = require('crypto');
let security: typeof import('../../server/security') = require('../../server/security');
let validationCore: typeof import('../../server/validation-core') = require('../../server/validation-core');
let generationContract: typeof import('../../server/anima-generation-contract') = require('../../server/anima-generation-contract');
let modelCatalog: typeof import('../../server/anima-model-catalog') = require('../../server/anima-model-catalog');
let animaErrors: typeof import('./errors') = require('./errors');
let animaConstants: typeof import('./constants') = require('./constants');

let serviceError = animaErrors.serviceError;
let isPlainObject = animaErrors.isPlainObject;
let hasOwn = animaErrors.hasOwn;
let MAX_PROMPT_LENGTH = animaConstants.MAX_PROMPT_LENGTH;
let MAX_NEGATIVE_LENGTH = animaConstants.MAX_NEGATIVE_LENGTH;
let MODELS: Readonly<Record<string, ImageModelDefinition>> = modelCatalog.MODELS;
let PROFILE_BY_MODEL: Readonly<Record<string, string>> = modelCatalog.PROFILE_BY_MODEL;
let LORAS: Readonly<Record<string, ImageLoraDefinition>> = modelCatalog.LORAS;
let KREA_STYLE_LORAS: Readonly<Record<string, { file: string; trigger: string }>> = modelCatalog.KREA_STYLE_LORAS;
let CHARACTERS: Readonly<Record<string, { id: string; label: string; loraId: string }>> = modelCatalog.CHARACTERS;
// 与服务端契约一致的输入键白名单实例
let ALLOWED_INPUT_KEYS = new Set(generationContract.ALLOWED_INPUT_KEYS);

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
function validateNumber(value: unknown, name: string, min: number, max: number, integer: boolean) {
  if (!finiteNumber(value) || (integer && !Number.isInteger(value)) || value < min || value > max) {
    throw serviceError(400, 'INVALID_PARAMETER', name + ' 超出允许范围');
  }
  return value;
}
function assertAdultAllowed(req: RequestContext | null | undefined, body: Record<string, unknown>) {
  if (!validationCore.detectAdultIntent(body.prompt)) return;
  // 本机个人使用（127.0.0.1 直连，含 Tauri 桌面端）直接放行，不再卡角色白名单与 adultEnabled
  let hasLocalBypass = req && security.isDirectLocalRequest(req);
  if (hasLocalBypass) return;
  // 服务端锚点（2026-08-28）：远程/隧道访问默认拒绝成人参数，请求体自报
  // adultEnabled 不再单独构成授权；AICS_ADULT_REMOTE=1 显式开启后仍走双门校验。
  let remote = validationCore.evaluateAdultRemote(false);
  if (remote) {
    throw serviceError(403, remote.code, remote.message);
  }
  // 无 LoRA 模式（popular）下 character 可能为空，此时按 prompt 中的 r18 锚点推断角色。
  // useLoras:false —— anima 家族原语义不含 LoRA 推断（带 LoRA 无锚点时白名单拒绝）。
  let targetChar = validationCore.inferAdultTargetChar(body, { useLoras: false });
  let denial = validationCore.evaluateAdultAccess(targetChar, body.adultEnabled);
  if (!denial) return;
  if (denial.reason === 'CHARACTER_NOT_ELIGIBLE') {
    throw serviceError(403, 'ADULT_CHARACTER_NOT_ELIGIBLE', denial.message);
  }
  throw serviceError(403, 'ADULT_NOT_ENABLED', denial.message);
}
// 成人内容双门（AGENTS.md 红线 #4 fail-closed）：常量与纯判定收口在
// server/validation-core.js（2026-08-28 审计 P1-6，此前 4 处实现漂移），此处保留家族组装。
function validateInput(reqOrBody: unknown, expectedFamilyOrBody?: unknown, maybeExpectedFamily?: string): ImageJobInput {
  let req: RequestContext | null = null;
  let rawBody: unknown;
  let expectedFamily;
  // 兼容旧调用 validateInput(body) 与新调用 validateInput(req, body)
  const candidate = reqOrBody as RequestContext | null | undefined;
  if (maybeExpectedFamily !== undefined || (candidate && candidate.socket && candidate.headers)) {
    req = candidate || null;
    rawBody = expectedFamilyOrBody;
    expectedFamily = maybeExpectedFamily;
  } else {
    rawBody = reqOrBody;
    expectedFamily = expectedFamilyOrBody;
  }
  const body = rawBody;
  if (!isPlainObject(body)) throw serviceError(400, 'INVALID_BODY', '请求体必须是 JSON 对象');

  Object.keys(body).forEach(function (key) {
    if (!ALLOWED_INPUT_KEYS.has(key)) {
      throw serviceError(400, 'UNKNOWN_PARAMETER', '不支持的参数：' + key);
    }
  });

  let required = ['prompt', 'modelId', 'width', 'height'];
  required.forEach(function (key) {
    if (!hasOwn(body, key)) throw serviceError(400, 'MISSING_PARAMETER', '缺少参数：' + key);
  });

  if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > MAX_PROMPT_LENGTH) {
    throw serviceError(400, 'INVALID_PARAMETER', 'prompt 需为 1—' + MAX_PROMPT_LENGTH + ' 字符');
  }
  if (body.negative !== undefined && (typeof body.negative !== 'string' || body.negative.length > MAX_NEGATIVE_LENGTH)) {
    throw serviceError(400, 'INVALID_PARAMETER', 'negative 需为不超过 ' + MAX_NEGATIVE_LENGTH + ' 字符的文本');
  }
  assertAdultAllowed(req, body);
  let model = typeof body.modelId === 'string' && hasOwn(MODELS, body.modelId) ? MODELS[body.modelId] : null;
  if (!model) throw serviceError(400, 'UNKNOWN_MODEL', '未知生成模型');
  if (expectedFamily && model.family !== expectedFamily) throw serviceError(400, 'WRONG_ROUTE_FAMILY', '请求路径与模型 family 不匹配');
  let modelId = body.modelId as string;
  let expectedProfile = PROFILE_BY_MODEL[modelId];
  let lora = typeof body.loraId === 'string' && hasOwn(LORAS, body.loraId) ? LORAS[body.loraId] : null;
  if (model.family !== 'krea2' && body.styleLoraId !== undefined) throw serviceError(400, 'WRONG_ROUTE_FAMILY', 'Style LoRA 仅适用于 Krea 2');
  if (model.family === 'krea2') {
    if (body.loraId || body.loraStrength !== undefined || (body.negative && String(body.negative).trim())) throw serviceError(400, 'KREA_UNSUPPORTED_PARAMETER', 'Krea 2 不接受角色 LoRA 或负向 Prompt');
    if (body.styleLoraId !== undefined && (typeof body.styleLoraId !== 'string' || !hasOwn(KREA_STYLE_LORAS, body.styleLoraId))) throw serviceError(400, 'UNKNOWN_STYLE_LORA', '未知 Krea 2 官方 Style LoRA');
  } else if (model.noLora === true && !body.loraId) {
    // 无 LoRA 创作模式：loraId/character 缺省或 character=null 即放行。
    // 若调用方提供了 lora，则落到下面的原校验，UNKNOWN_LORA /
    // INCOMPATIBLE_MODEL_LORA / INCOMPATIBLE_CHARACTER 全部保持生效。
    // loraStrength 无 lora 时是自相矛盾参数，直接拒绝；非空 character 不当作
    // 身份锁定元数据接受（fail closed，避免客户端绕过 LoRA 却声称角色身份）。
    if (body.loraStrength !== undefined) {
      throw serviceError(400, 'INVALID_PARAMETER', 'no-LoRA 模式不接受 loraStrength');
    }
    if (body.character !== undefined && body.character !== null) {
      throw serviceError(400, 'INVALID_PARAMETER', 'no-LoRA 模式不接受角色身份字段');
    }
  } else {
    if (!lora) throw serviceError(400, 'UNKNOWN_LORA', '未知 Anima LoRA');
    if (lora.compatibleModels.indexOf(modelId) === -1) throw serviceError(400, 'INCOMPATIBLE_MODEL_LORA', '底模与 LoRA 组合不受支持');
    let character = typeof body.character === 'string' && hasOwn(CHARACTERS, body.character) ? CHARACTERS[body.character] : null;
    if (!character || character.loraId !== body.loraId) throw serviceError(400, 'INCOMPATIBLE_CHARACTER', '角色与 LoRA 组合不受支持');
  }
  let loraStrength = lora ? validateNumber(body.loraStrength, 'loraStrength', lora.minStrength, lora.maxStrength, false) : null;
  let width = validateNumber(body.width, 'width', 512, 1536, true);
  let height = validateNumber(body.height, 'height', 512, 1536, true);
  let isAspectPreservingInpaint = model.family !== 'krea2'
    && typeof body.initImage === 'string' && body.initImage.trim();
  // 只有局部重绘可使用非白名单尺寸：前端按原图比例计算 16 对齐的安全画布。
  // 普通文生图继续严格锁定已验证的模型尺寸，避免任意分辨率撑爆显存。
  if (!isAspectPreservingInpaint && model.sizes.indexOf(width + 'x' + height) === -1) {
    throw serviceError(400, 'INVALID_PARAMETER', '不支持的输出尺寸');
  }
  if (isAspectPreservingInpaint && (width % 16 !== 0 || height % 16 !== 0)) {
    throw serviceError(400, 'INVALID_PARAMETER', '局部重绘尺寸必须是 16 的倍数');
  }
  // 尺寸上限防护：支持最大 1152x1536 (1.77 MP)，上限放宽至 1.85 MP
  if (model.family !== 'krea2' && width * height > 1_850_000) throw serviceError(400, 'INVALID_PARAMETER', '输出尺寸超过允许面积');
  let steps;
  let cfg;
  if (model.family === 'krea2') {
    // 2026-08-31 与 KREA_DEFAULTS 对齐：e0cbf20 已把主 KSampler 实际出图步数改为 12
    if (body.steps !== undefined && body.steps !== 12) throw serviceError(400, 'INVALID_PARAMETER', 'Krea 2 steps 固定为 12');
    if (body.cfg !== undefined && body.cfg !== 1) throw serviceError(400, 'INVALID_PARAMETER', 'Krea 2 CFG 固定为 1');
    steps = 12;
    cfg = 1;
  } else {
    steps = body.steps === undefined ? model.steps : validateNumber(
      body.steps,
      'steps',
      generationContract.PARAMETER_LIMITS.steps.min,
      generationContract.PARAMETER_LIMITS.steps.max,
      generationContract.PARAMETER_LIMITS.steps.integer
    );
    cfg = body.cfg === undefined ? model.cfg : validateNumber(
      body.cfg,
      'cfg',
      generationContract.PARAMETER_LIMITS.cfg.min,
      generationContract.PARAMETER_LIMITS.cfg.max,
      generationContract.PARAMETER_LIMITS.cfg.integer
    );
  }
  let seed = body.seed === undefined
    ? crypto.randomInt(0, 2147483647)
    : validateNumber(
      body.seed,
      'seed',
      generationContract.PARAMETER_LIMITS.seed.min,
      generationContract.PARAMETER_LIMITS.seed.max,
      generationContract.PARAMETER_LIMITS.seed.integer
    );

  return {
    prompt:model.family === 'krea2' && body.styleLoraId
      ? body.prompt.trim() + ', ' + KREA_STYLE_LORAS[body.styleLoraId as string].trigger
      : body.prompt.trim(),
    negative:model.family === 'krea2' ? '' : (typeof body.negative === 'string' ? body.negative.trim() : ''),
    family:model.family,
    profileId:expectedProfile,
    modelId:modelId,
    loraId:body.loraId as ImageJobInput['loraId'],
    loraStrength:loraStrength,
    width:width,
    height:height,
    steps:steps,
    cfg:cfg,
    sampler:model.sampler,
    scheduler:model.scheduler,
    seed:seed,
    character:body.character,
    styleLoraId:model.family === 'krea2' ? (body.styleLoraId as string | undefined || null) : null,
    hiresFix:Boolean(body.hiresFix),
    hiresScale:body.hiresFix ? validateNumber(body.hiresScale || 2.0, 'hiresScale', 1.1, 3.0, false) : 1.0,
    hiresDenoise:body.hiresFix ? validateNumber(body.hiresDenoise || 0.35, 'hiresDenoise', 0.1, 0.7, false) : 0.35,
    // 2026-08-25 放大器可选：'Remacri'（ESRGAN 像素超分，默认 Auto 探测注入）| 'Latent'（潜空间放大，不做像素超分）
    hiresUpscaler:typeof body.hiresUpscaler === 'string' && (body.hiresUpscaler === 'Remacri' || body.hiresUpscaler === 'Latent') ? body.hiresUpscaler : (body.hiresFix ? 'Auto' : null),
    teaCache:body.teaCache !== undefined ? Boolean(body.teaCache) : true,
    teaCacheThresh:body.teaCacheThresh !== undefined ? validateNumber(body.teaCacheThresh, 'teaCacheThresh', 0.0, 1.0, false) : 0.08,
    initImage:typeof body.initImage === 'string' && body.initImage.trim() ? body.initImage.trim() : null,
    maskImage:typeof body.maskImage === 'string' && body.maskImage.trim() ? body.maskImage.trim() : null,
    maskPrompt:typeof body.maskPrompt === 'string' && body.maskPrompt.trim() ? body.maskPrompt.trim() : null,
    denoisingStrength:body.denoisingStrength !== undefined ? validateNumber(body.denoisingStrength, 'denoisingStrength', 0.1, 1.0, false) : 0.80,
    growMaskBy:body.growMaskBy !== undefined ? validateNumber(body.growMaskBy, 'growMaskBy', 0, 32, true) : 6,
    // 2026-08-21 换装完善：CLIPSeg 自动识别阈值可调。实测 threshold 0.20 会把身体/
    // 背景大片拉进 mask（denoise 0.85 下整块重绘 → 构图漂移），0.45+ 才聚焦服装主体。
    maskThreshold:body.maskThreshold !== undefined ? validateNumber(body.maskThreshold, 'maskThreshold', 0.05, 0.95, false) : 0.45,
  };
}

export = {
  finiteNumber:finiteNumber,
  validateNumber:validateNumber,
  assertAdultAllowed:assertAdultAllowed,
  ADULT_ELIGIBLE_CHARACTERS:validationCore.ADULT_ELIGIBLE_CHARACTERS,
  ADULT_PROMPT_RE:validationCore.ADULT_PROMPT_RE,
  validateInput:validateInput,
};
