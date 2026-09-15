'use strict';

/**
 * server/video-model-catalog.js — 视频模型目录数据表（Wan 2.2 / MiniMax H3 / 预留占位）。
 *
 * 2026-08-21 从 routes/video.js 头部原样外移（纯数据，零逻辑）：路由文件此前超过
 * 2100 行。新增/调整模型只改这里；工作流构建与任务编排留在路由层。
 */
let MODEL_CATALOG = Object.freeze([
  {
    id:'wan2.2-ti2v-5b',
    label:'Wan 2.2 TI2V 5B',
    family:'wan2.2',
    tier:'本机推荐',
    summary:'16GB 显存优先路线，先从短片稳定闭环开始。',
    executable:true,
    modes:['text'],
    requirements:[
      ['diffusion_models', 'wan2.2_ti2v_5B_fp16.safetensors'],
      ['text_encoders', 'umt5_xxl_fp8_e4m3fn_scaled.safetensors'],
      ['vae', 'wan2.2_vae.safetensors'],
    ],
  },
  {
    id:'minimax-h3',
    label:'MiniMax H3',
    family:'minimax-h3',
    tier:'高上限成片',
    summary:'本地 768p 原生立体声音频与口型，画质上限最高；16GB 显存建议从 3 秒短片起步。',
    executable:true,
    modes:['text', 'image', 'first-last-frame'],
    requirements:[
      ['diffusion_models', 'minimax_h3_fl2va_pruned_int8_convrot.safetensors'],
      ['text_encoders', 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'],
      ['vae', 'minimax_h3_video_vae_fp16.safetensors'],
      ['vae', 'minimax_h3_audio_vae_fp32.safetensors'],
      ['loras', 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors'],
      // 2026-08-16 T8 双时钟路径（默认）：4 步加速 LoRA（lightx2v 官方 4step 版），
      // 配合 T8 双时钟采样器；无 T8 节点时回退 8 步 LoRA + 原生采样器。
      ['loras', 'minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors'],
    ],
  },
  {
    id:'wan2.2-14b',
    label:'Wan 2.2 14B',
    family:'wan2.2',
    tier:'高质量扩展',
    summary:'更高质量的文生/图生视频路线，需独立工作流和显存实测。',
    executable:false,
    modes:['text', 'image', 'first-last-frame'],
    requirements:[],
  },
  {
    id:'hunyuan-video-1.5',
    label:'HunyuanVideo 1.5',
    family:'hunyuan',
    tier:'高质量扩展',
    summary:'面向 720p 与超分链路，待本机资源和耗时验证。',
    executable:false,
    modes:['text', 'image'],
    requirements:[],
  },
  {
    id:'ltx-2.3',
    label:'LTX-2.3',
    family:'ltx',
    tier:'快速迭代扩展',
    summary:'适合快速预演与音视频扩展，待适配官方子图工作流。',
    executable:false,
    modes:['text', 'image', 'first-last-frame'],
    requirements:[],
  },
]);

let MODEL_BY_ID = Object.freeze(MODEL_CATALOG.reduce<Record<string, typeof MODEL_CATALOG[number]>>(function (result, model) {
  result[model.id] = model;
  return result;
}, {}));

export = {
  MODEL_CATALOG: MODEL_CATALOG,
  MODEL_BY_ID: MODEL_BY_ID,
};
