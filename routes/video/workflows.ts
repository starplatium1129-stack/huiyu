'use strict';

/**
 * routes/video/workflows.js —— ComfyUI 工作流图构建器（纯函数）。
 *
 * 三条路径：H3 原生采样（lightx2v Turbo 8 步）、H3 T8 双时钟（4 步加速）、
 * Wan 2.2 TI2V。输出契约不变：SaveVideo 固定节点 '11'、aics_video 前缀。
 * T8 可用性由调用方经 options.t8Available 注入 —— 本模块不持有可变状态，
 * 探测与缓存留在 routes/video.js 编排层。
 */

let constants: typeof import('./constants') = require('./constants');

let OUTPUT_FILENAME_PREFIX = constants.OUTPUT_FILENAME_PREFIX;

// T8 双时钟采样路径（2026-08-16，默认当 T8 节点可用时启用）：
// MiniMaxH3AudioConditioningT8（官方三段式提示词 + task_type 显式声明）→
// LoraLoaderBypassModelOnly（4 步加速 LoRA）→ MiniMaxH3DualClockSamplerT8
// （双时钟，steps 4 极速 / 8 标准，shift_video 12 / shift_audio 3）→
// BasicGuider + SamplerCustomAdvanced → MiniMaxH3AVDecodeT8 → CreateVideo → SaveVideo。
// 输出契约不变（SaveVideo 节点 11、aics_video 前缀）。真机实测 2.5× 提速。
function buildH3T8Workflow(input: { modelId?: string; references?: unknown; image?: unknown; lastFrame?: unknown; prompt?: unknown; width?: unknown; height?: unknown; frames?: unknown; steps?: unknown; seed?: unknown; fps?: unknown; }) {
  // Ref2VA / Hybrid：有参考图（角色卡）时按 T8 枚举（大写）传参；
  // 参考图 + 首/尾帧 → Hybrid（参考身份 + 关键帧构图），仅参考 → Ref2VA。
  let hasReferences = Array.isArray(input.references) && input.references.length > 0;
  let taskType = hasReferences
    ? (input.image || input.lastFrame ? 'Hybrid' : 'Ref2VA')
    : input.image && input.lastFrame ? 'FL2VA'
      : input.image ? 'I2VA'
        : input.lastFrame ? 'L2VA'
          : 'T2VA';
  let graph = {
    '1': { class_type:'UNETLoader', inputs:{
      unet_name:'minimax_h3_fl2va_pruned_int8_convrot.safetensors',
      weight_dtype:'default',
    } },
    '2': { class_type:'CLIPLoader', inputs:{
      clip_name:'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
      type:'minimax',
      device:'default',
    } },
    '3': { class_type:'VAELoader', inputs:{ vae_name:'minimax_h3_video_vae_fp16.safetensors' } },
    '4': { class_type:'VAELoader', inputs:{ vae_name:'minimax_h3_audio_vae_fp32.safetensors' } },
    '5': { class_type:'MiniMaxH3AudioConditioningT8', inputs:{
      clip:['2', 0],
      video_vae:['3', 0],
      audio_vae:['4', 0],
      prompt:input.prompt,
      width:input.width,
      height:input.height,
      length:input.frames,
      task_type:taskType,
      audio_mode:'native',
      audio_denoise_strength:1,
      add_source_as_reference:false,
      prompt_primary_audio_ordinal:0,
      strict_prompt_tags:true,
      ref_image_size:'match',
      reference_video_policy:'official_2_to_15s',
    } },
    '15': { class_type:'LoraLoaderBypassModelOnly', inputs:{
      model:['1', 0],
      lora_name:'minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors',
      strength_model:1,
    } },
    '16': { class_type:'MiniMaxH3DualClockSamplerT8', inputs:{
      model:['15', 0],
      av_latent:['5', 1],
      steps:input.steps,
      shift_video:12,
      shift_audio:3,
    } },
    '6': { class_type:'RandomNoise', inputs:{ noise_seed:input.seed } },
    '9': { class_type:'BasicGuider', inputs:{ model:['16', 0], conditioning:['5', 0] } },
    '10': { class_type:'SamplerCustomAdvanced', inputs:{
      noise:['6', 0],
      guider:['9', 0],
      sampler:['16', 1],
      sigmas:['16', 2],
      latent_image:['5', 1],
    } },
    '12': { class_type:'MiniMaxH3AVDecodeT8', inputs:{
      av_latent:['10', 0],
      video_vae:['3', 0],
      audio_vae:['4', 0],
    } },
    '14': { class_type:'CreateVideo', inputs:{
      images:['12', 0],
      audio:['12', 1],
      fps:input.fps,
      bit_depth:8,
    } },
    '11': { class_type:'SaveVideo', inputs:{
      video:['14', 0],
      filename_prefix:OUTPUT_FILENAME_PREFIX,
      format:'auto',
      codec:'auto',
    } },
  };
  if (input.image) {
    graph['17'] = { class_type:'LoadImage', inputs:{ image:input.image } };
    graph['5'].inputs.first_frame = ['17', 0];
  }
  if (input.lastFrame) {
    graph['18'] = { class_type:'LoadImage', inputs:{ image:input.lastFrame } };
    graph['5'].inputs.last_frame = ['18', 0];
  }
  // 参考图（Ref2VA 角色卡）：T8 ref_images autogrow 槽。
  // ComfyUI v0.30 expression API 的动态输入槽名 = Autogrow id 前缀点 + 模板名，
  // 即 ref_images.ref_image_0..N（序号从 0 起，见 _io.py finalize_prefix 展开）。
  // 裸 ref_image_N 会被当成普通 kwarg 交给 execute → TypeError
  // （2026-08-17 短片流水线实锤：9 镜批量全败）。节点 21 起每张一个 LoadImage，
  // 提示词用 <Picture N> 标签（排序后第 N 张）。
  if (hasReferences) {
    input.references.forEach(function (refName: unknown, refIndex: string|number) {
      let nodeId = String(21 + refIndex);
      graph[nodeId] = { class_type:'LoadImage', inputs:{ image:refName } };
      graph['5'].inputs['ref_images.ref_image_' + refIndex] = [nodeId, 0];
    });
  }
  return graph;
}

// MiniMax H3 原生工作流（lightx2v Turbo 版，官方 ModelTC 推荐 T2VA 图）。
// 节点图与官方模板
// （ModelTC/Minimax-H3-Turbo example_workflows/video_minimax_h3_t2v_lightx2v_turbo.json）
// 保持一致，全部为 ComfyUI 核心节点：
// UNETLoader → LoraLoaderModelOnly（Turbo LoRA，strength 1.0）→
// MiniMaxH3SigmaShift（shift_video 12 / shift_audio 3）→
// BasicGuider + BasicScheduler(simple, 8 步) + KSamplerSelect(euler) +
// SamplerCustomAdvanced + VAEDecode + VAEDecodeAudio + CreateVideo + SaveVideo。
// 20 步 → 8 步蒸馏采样（官方推荐 8 或 4 步）。SaveVideo 固定在节点 11，
// 与任务结果读取（outputs['11'].videos）契约一致。
function buildH3Workflow(input: { modelId?: string; prompt?: unknown; width?: unknown; height?: unknown; frames?: unknown; seed?: unknown; steps?: unknown; fps?: unknown; image?: unknown; lastFrame?: unknown; }) {
  let graph = {
    '1': { class_type:'UNETLoader', inputs:{
      unet_name:'minimax_h3_fl2va_pruned_int8_convrot.safetensors',
      weight_dtype:'default',
    } },
    '2': { class_type:'CLIPLoader', inputs:{
      clip_name:'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
      type:'minimax',
      device:'default',
    } },
    '3': { class_type:'VAELoader', inputs:{ vae_name:'minimax_h3_video_vae_fp16.safetensors' } },
    '4': { class_type:'VAELoader', inputs:{ vae_name:'minimax_h3_audio_vae_fp32.safetensors' } },
    '5': { class_type:'MiniMaxH3ImageToVideo', inputs:{
      clip:['2', 0],
      vae:['3', 0],
      prompt:input.prompt,
      width:input.width,
      height:input.height,
      length:input.frames,
    } },
    '15': { class_type:'LoraLoaderModelOnly', inputs:{
      model:['1', 0],
      lora_name:'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors',
      strength_model:1,
    } },
    '16': { class_type:'MiniMaxH3SigmaShift', inputs:{
      model:['15', 0],
      shift_video:12,
      shift_audio:3,
    } },
    '6': { class_type:'RandomNoise', inputs:{ noise_seed:input.seed } },
    '7': { class_type:'KSamplerSelect', inputs:{ sampler_name:'euler' } },
    '8': { class_type:'BasicScheduler', inputs:{
      model:['16', 0],
      scheduler:'simple',
      steps:input.steps,
      denoise:1,
    } },
    '9': { class_type:'BasicGuider', inputs:{
      model:['16', 0],
      conditioning:['5', 0],
    } },
    '10': { class_type:'SamplerCustomAdvanced', inputs:{
      noise:['6', 0],
      guider:['9', 0],
      sampler:['7', 0],
      sigmas:['8', 0],
      latent_image:['5', 1],
    } },
    '12': { class_type:'VAEDecode', inputs:{ samples:['10', 0], vae:['3', 0] } },
    '13': { class_type:'VAEDecodeAudio', inputs:{ samples:['10', 0], vae:['4', 0] } },
    '14': { class_type:'CreateVideo', inputs:{
      images:['12', 0],
      audio:['13', 0],
      fps:input.fps,
      bit_depth:8,
    } },
    '11': { class_type:'SaveVideo', inputs:{
      video:['14', 0],
      filename_prefix:OUTPUT_FILENAME_PREFIX,
      // 官方模板值：format/codec 用 'auto'。SaveVideo 的 codec 是 COMFY_DYNAMICCOMBO_V3，
      // 真实执行不接受对象结构（2026-08-15 实测 execution_error: missing 'codec'）。
      format:'auto',
      codec:'auto',
    } },
  };
  // I2VA：首帧图经 LoadImage 读入 ComfyUI/input，作为 <Picture 1> 几何锚点。
  if (input.image) {
    graph['17'] = { class_type:'LoadImage', inputs:{ image:input.image } };
    graph['5'].inputs.first_frame = ['17', 0];
  }
  // FL2VA/L2VA：尾帧图作为 <Picture 2> / 收敛锚点（节点原生支持 last_frame，
  // 2026-08-16 本机 object_info 与 nodes_minimax_h3.py 双重确认）。
  if (input.lastFrame) {
    graph['18'] = { class_type:'LoadImage', inputs:{ image:input.lastFrame } };
    graph['5'].inputs.last_frame = ['18', 0];
  }
  return graph;
}

function buildWanWorkflow(input: { modelId?: string; prompt?: unknown; negative?: unknown; width?: unknown; height?: unknown; frames?: unknown; seed?: unknown; steps?: unknown; cfg?: unknown; fps?: unknown; }) {
  return {
    '1': { class_type:'UNETLoader', inputs:{
      unet_name:'wan2.2_ti2v_5B_fp16.safetensors',
      weight_dtype:'default',
    } },
    '2': { class_type:'CLIPLoader', inputs:{
      clip_name:'umt5_xxl_fp8_e4m3fn_scaled.safetensors',
      type:'wan',
      device:'default',
    } },
    '3': { class_type:'VAELoader', inputs:{ vae_name:'wan2.2_vae.safetensors' } },
    '4': { class_type:'CLIPTextEncode', inputs:{ clip:['2', 0], text:input.prompt } },
    '5': { class_type:'CLIPTextEncode', inputs:{ clip:['2', 0], text:input.negative } },
    '6': { class_type:'ModelSamplingSD3', inputs:{ model:['1', 0], shift:8 } },
    '7': { class_type:'Wan22ImageToVideoLatent', inputs:{
      vae:['3', 0],
      width:input.width,
      height:input.height,
      length:input.frames,
      batch_size:1,
    } },
    '8': { class_type:'KSampler', inputs:{
      model:['6', 0],
      positive:['4', 0],
      negative:['5', 0],
      latent_image:['7', 0],
      seed:input.seed,
      steps:input.steps,
      cfg:input.cfg,
      sampler_name:'uni_pc',
      scheduler:'simple',
      denoise:1,
    } },
    '9': { class_type:'VAEDecode', inputs:{ samples:['8', 0], vae:['3', 0] } },
    '10': { class_type:'CreateVideo', inputs:{ images:['9', 0], fps:input.fps, bit_depth:8 } },
    '11': { class_type:'SaveVideo', inputs:{
      video:['10', 0],
      filename_prefix:OUTPUT_FILENAME_PREFIX,
      // 同 H3：format/codec 用官方模板的 'auto'（动态 combo 不接受对象值）。
      format:'auto',
      codec:'auto',
    } },
  };
}

/**
 * 按模型族分派工作流。options.t8Available 由编排层注入（探测缓存在那里），
 * 保持本模块无状态、可独立单测。
 */
function buildWorkflow(input: { modelId: string; }, options: { t8Available: unknown; }) {
  let t8Available = Boolean(options && options.t8Available);
  if (input.modelId === 'minimax-h3') {
    return t8Available ? buildH3T8Workflow(input) : buildH3Workflow(input);
  }
  return buildWanWorkflow(input);
}

export = {
  buildWorkflow:buildWorkflow,
  buildH3T8Workflow:buildH3T8Workflow,
  buildH3Workflow:buildH3Workflow,
  buildWanWorkflow:buildWanWorkflow,
};
