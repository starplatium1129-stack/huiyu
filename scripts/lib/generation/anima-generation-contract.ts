// Maintenance candidate parameters; product request validation belongs to the Rust runtime.
// res_multistep preserves the measured Anima TeaCache skip behavior; SDE samplers
// did not accelerate this local chain. Revisit only after a verified sampler migration.
const ANIMA_DEFAULTS = Object.freeze({
  steps: 30,
  cfg: 4.5,
  sampler: 'res_multistep',
  scheduler: 'simple',
});

// Author-recommended sampling; local SageAttention/TeaCache comparison keeps
// scene detail at 0.10 while allowing same-seed composition changes.
const MIAOMIAO_V16_DEFAULTS = Object.freeze({
  steps: 30,
  cfg: 4.5,
  sampler: 'euler',
  scheduler: 'normal',
  teaCacheThresh: 0.10,
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

export = { ANIMA_DEFAULTS, MIAOMIAO_V16_DEFAULTS, KREA_DEFAULTS };
