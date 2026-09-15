'use strict';

// 首轮采样器：恢复 res_multistep（2026-08-25 实测钉死：TeaCache 跳步判据在
// SDE 类采样器下全 FULL——euler_ancestral 1.04x vs res_multistep 1.90x
// 同基准实测；euler 画质偏好需先做 TeaCache SDE 兼容适配再考虑）。
// 放大二阶段采样器不再跟随首轮：Remacri 超分路径纯像素直出（无二阶段），
// Latent 回退/inpaint 路径冻结 HIRES 组合。
const ANIMA_DEFAULTS = Object.freeze({
  steps: 30,
  cfg: 4.5,
  sampler: 'res_multistep',
  scheduler: 'simple',
});

// Remacri 超分路径已改纯像素放大直出（2026-08-25 实测：二阶段低 denoise 重绘在
// 4MP 外推 latent 上全脏，P1 纯像素直出干净，见 routes/anima.js appendSuperResHires）。
// HIRES_SAMPLER / HIRES_SCHEDULER 仅用于保留重绘的 LatentUpscaleBy 回退分支与
// inpaint+hires 路径（二阶段冻结 res_multistep + sgm_uniform）。
const HIRES_SCHEDULER = 'sgm_uniform';
const HIRES_SAMPLER = 'res_multistep';

const KREA_DEFAULTS = Object.freeze({
  // 2026-08-31 对齐真实出图：e0cbf20 为解决默认偏 3D 质感将主 KSampler steps 8→12，
  // 此前此处与 validation 仍写 8，导致 UI 显示 8 步实际出图 12 步的契约漂移。
  steps: 12,
  cfg: 1,
  // 2026-08-23 Krea 链路替换：采样器随社区增强链路固定 er_sde（与 buildWorkflow
  // 内写死的社区验证配对一致），元数据与 models 接口 defaults 必须反映真实采样器。
  sampler: 'er_sde',
  scheduler: 'simple',
});

const MANUAL_REPAIR_PRESET = Object.freeze({
  steps: 30,
  cfg: 4.5,
  sampler: ANIMA_DEFAULTS.sampler,
  scheduler: ANIMA_DEFAULTS.scheduler,
});

const PARAMETER_LIMITS = Object.freeze({
  steps: Object.freeze({ min: 1, max: 60, integer: true }),
  cfg: Object.freeze({ min: 0.5, max: 10, integer: false }),
  seed: Object.freeze({ min: 0, max: Number.MAX_SAFE_INTEGER, integer: true }),
  teaCacheThresh: Object.freeze({ min: 0.0, max: 1.0, integer: false }),
  denoisingStrength: Object.freeze({ min: 0.1, max: 1.0, integer: false }),
  growMaskBy: Object.freeze({ min: 0, max: 32, integer: true }),
  maskThreshold: Object.freeze({ min: 0.05, max: 0.95, integer: false }),
});

const ALLOWED_INPUT_KEYS = Object.freeze([
  'prompt', 'negative', 'modelId', 'loraId', 'loraStrength',
  'width', 'height', 'steps', 'cfg', 'seed', 'character', 'styleLoraId',
  'hiresFix', 'hiresScale', 'hiresDenoise', 'hiresSteps', 'hiresUpscaler',
  'teaCache', 'teaCacheThresh',
  'initImage', 'maskImage', 'maskPrompt', 'maskThreshold', 'denoisingStrength', 'growMaskBy',
  'adultEnabled',
]);

const CHARACTER_LORA_BINDINGS = Object.freeze({
  nene: 'L_NENE_V21_ANIMA',
  natsume: 'L_NAT_V21_ANIMA',
});

function requiredCharacterForLora(loraId: any) {
  return Object.entries(CHARACTER_LORA_BINDINGS)
    .find(([, binding]) => binding === loraId)?.[0] || '';
}

function validateTunableNumber(value: any, name: string|number) {
  const limit = PARAMETER_LIMITS[name as keyof typeof PARAMETER_LIMITS];
  if (!limit || typeof value !== 'number' || !Number.isFinite(value)
    || (limit.integer && !Number.isInteger(value))
    || value < limit.min || value > limit.max) {
    return false;
  }
  return true;
}

export = {
  ANIMA_DEFAULTS,
  HIRES_SAMPLER,
  HIRES_SCHEDULER,
  KREA_DEFAULTS,
  MANUAL_REPAIR_PRESET,
  PARAMETER_LIMITS,
  ALLOWED_INPUT_KEYS,
  CHARACTER_LORA_BINDINGS,
  requiredCharacterForLora,
  validateTunableNumber,
};
