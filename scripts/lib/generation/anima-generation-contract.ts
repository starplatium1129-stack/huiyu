// Maintenance candidate parameters; product request validation belongs to the Rust runtime.
// res_multistep preserves the measured Anima TeaCache skip behavior; SDE samplers
// did not accelerate this local chain. Revisit only after a verified sampler migration.
const ANIMA_DEFAULTS = Object.freeze({
  steps: 30,
  cfg: 4.5,
  sampler: 'res_multistep',
  scheduler: 'simple',
});

// MiaoMiao 1.6 author recommendation; TeaCache's conservative Euler preset.
const MIAOMIAO_V16_DEFAULTS = Object.freeze({
  steps: 30,
  cfg: 4.5,
  sampler: 'euler',
  scheduler: 'normal',
  teaCacheThresh: 0.05,
});

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

const CHARACTER_LORA_BINDINGS = Object.freeze({
  nene: 'L_NENE_V21_ANIMA',
  natsume: 'L_NAT_V21_ANIMA',
});

function requiredCharacterForLora(loraId: any) {
  return Object.entries(CHARACTER_LORA_BINDINGS)
    .find(([, binding]: any) => binding === loraId)?.[0] || '';
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

export = { ANIMA_DEFAULTS, MIAOMIAO_V16_DEFAULTS, KREA_DEFAULTS, MANUAL_REPAIR_PRESET, PARAMETER_LIMITS, CHARACTER_LORA_BINDINGS, requiredCharacterForLora, validateTunableNumber };
