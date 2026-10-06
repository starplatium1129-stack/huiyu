// Catalog used by offline showcase planning; no HTTP service or job state.
const generationContract: typeof import('./anima-generation-contract') = require('./anima-generation-contract');

interface ModelDefinition {
  file: string;
  label: string;
  family: string;
  profileId: string;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  teaCacheThresh?: number;
  sizes: string[];
  noLora?: boolean;
  rebalance?: { preset: string; multiplier: number; normalizeTaps: boolean };
}
interface LoraDefinition {
  file: string;
  name: string;
  character: string;
  compatibleModels: string[];
  minStrength: number;
  maxStrength: number;
}

let MODELS: Readonly<Record<string, ModelDefinition>> = Object.freeze({
  'anima-base-v1.0': { file:'anima-base-v1.0.safetensors', label:'Anima Base v1.0', family:'anima', profileId:'anima_base_v10', steps:generationContract.ANIMA_DEFAULTS.steps, cfg:generationContract.ANIMA_DEFAULTS.cfg, sampler:generationContract.ANIMA_DEFAULTS.sampler, scheduler:generationContract.ANIMA_DEFAULTS.scheduler, sizes:['832x1216','960x1536','1024x1024','1216x832'] },
  'anima-aesthetic-v1.1': { file:'anima-aesthetic-v1.1.safetensors', label:'Anima Aesthetic v1.1', family:'anima', profileId:'anima_aesthetic_v11', steps:generationContract.ANIMA_DEFAULTS.steps, cfg:generationContract.ANIMA_DEFAULTS.cfg, sampler:generationContract.ANIMA_DEFAULTS.sampler, scheduler:generationContract.ANIMA_DEFAULTS.scheduler, sizes:['832x1216','1024x1024','1216x832'], noLora:true },
  // MIAOKA 2.9B Beta 1.1；按该版本作者设置使用 Euler/sgm_uniform，不继承 1.6 配方。
  // 现有角色 LoRA 未在这个扩层微调上验收，暂不声明兼容。
  'anima-miaomiao-2.9b-beta1.1': { file:'miaomiaoHarem_29BBETA11.safetensors', label:'MiaoMiao Harem Anima 2.9B Beta 1.1', family:'anima', profileId:'anima_miaomiao_29b_beta11', steps:30, cfg:4.5, sampler:'euler', scheduler:'sgm_uniform', sizes:['832x1216','960x1536','1152x1536','1536x1152','1024x1024','1216x832'], noLora:true },
  // 2026-08-15 用户决策接入：AnimaYume v1.0（circlestone 社区基座微调，Civitai 2385278）。
  // noLora:true = 无 LoRA 创作模式可用；若显式传 loraId，仍走 LORAS 兼容表校验
  // （宁宁/夏目 v21 已声明兼容，用户实测自担效果）。
  'anima-yume-v1.0': { file:'AnimaYume_v10_final_base.safetensors', label:'Anima Yume v1.0', family:'anima', profileId:'anima_yume_v10', steps:generationContract.ANIMA_DEFAULTS.steps, cfg:generationContract.ANIMA_DEFAULTS.cfg, sampler:generationContract.ANIMA_DEFAULTS.sampler, scheduler:generationContract.ANIMA_DEFAULTS.scheduler, sizes:['832x1216','960x1536','1024x1024','1216x832'], noLora:true },
  // 接入：MiaoMiao Harem Anima v1.2（MIAOKA 质感微调，专攻半厚涂肌肤质感与唯美光影）。
  'anima-miaomiao-v1.2': { file:'miaomiaoHarem_anima12.safetensors', label:'MiaoMiao Harem Anima v1.2', family:'anima', profileId:'anima_miaomiao_v12', steps:generationContract.ANIMA_DEFAULTS.steps, cfg:generationContract.ANIMA_DEFAULTS.cfg, sampler:generationContract.ANIMA_DEFAULTS.sampler, scheduler:generationContract.ANIMA_DEFAULTS.scheduler, sizes:['832x1216','960x1536','1152x1536','1536x1152','1024x1024','1216x832'], noLora:true },
  // 2026-09-04 接入：MiaoMiao Harem Anima v1.6（MIAOKA Anima 主线正式版，2026-08-20 发布）。
  // 与 v1.2 同架构（实测：685 tensor / 2.091B 参数 / 28 层 DiT / 全 BF16，去掉 safetensors 头部后
  // 权重数据区字节数完全相同 4182137856），属版本迭代而非换底模。
  // 顶层键前缀由 model.diffusion_model.* 改为 net.*，ComfyUI unet_prefix_from_state_dict() 候选表
  // 已含 "net."，自动识别剥离，无需任何权重转换。
  // 官方推荐 Euler/normal、30 步、CFG 4.0-5.0；缓存采用保守 Euler 起点。
  // 注意：1.5/1.6 为美学强化模型，会影响 artist tag 表现；负面官方建议含 shiny skin。
  'anima-miaomiao-v1.6': { file:'miaomiaoHarem_anima16.safetensors', label:'MiaoMiao Harem Anima v1.6', family:'anima', profileId:'anima_miaomiao_v16', ...generationContract.MIAOMIAO_V16_DEFAULTS, sizes:['832x1216','960x1536','1152x1536','1536x1152','1024x1024','1216x832'], noLora:true },
  'krea2-turbo-fp8': { file:'krea2_turbo_fp8_scaled.safetensors', label:'Krea 2 Turbo', family:'krea2', profileId:'krea2_turbo_fp8', steps:generationContract.KREA_DEFAULTS.steps, cfg:generationContract.KREA_DEFAULTS.cfg, sampler:generationContract.KREA_DEFAULTS.sampler, scheduler:generationContract.KREA_DEFAULTS.scheduler, sizes:['1024x1024','1024x1536','1536x1024'], noLora:true, rebalance:{ preset:'standard', multiplier:1.1, normalizeTaps:false } }
});

let LORAS: Readonly<Record<string, LoraDefinition>> = Object.freeze({
  L_NENE_V21_ANIMA: {
    file:'ayachi_nene_v21_anima.safetensors',
    name:'ayachi_nene_v21_anima',
    character:'nene',
    compatibleModels:['anima-base-v1.0', 'anima-aesthetic-v1.1', 'anima-yume-v1.0', 'anima-miaomiao-v1.2', 'anima-miaomiao-v1.6'],
    minStrength:0.65,
    maxStrength:1
  },
  L_NAT_V21_ANIMA: {
    file:'shiki_natsume_v21_anima.safetensors',
    name:'shiki_natsume_v21_anima',
    character:'natsume',
    compatibleModels:['anima-base-v1.0', 'anima-aesthetic-v1.1', 'anima-yume-v1.0', 'anima-miaomiao-v1.2', 'anima-miaomiao-v1.6'],
    minStrength:0.65,
    maxStrength:1
  }
});

export = { MODELS, LORAS };
