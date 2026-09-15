import type { ImageJobInput, ImageModelDefinition, ImageLoraDefinition, ComfyWorkflow, ComfyLink } from './types';
'use strict';

/**
 * routes/anima/workflows.js —— ComfyUI 工作流图构建器。
 * 2026-08-27 P1-b 自 anima.js 切出，节点图与事故溯源注释逐字未改。
 */

let modelCatalog: typeof import('../../server/anima-model-catalog') = require('../../server/anima-model-catalog');
let generationContract: typeof import('../../server/anima-generation-contract') = require('../../server/anima-generation-contract');
let MODELS: Readonly<Record<string, ImageModelDefinition>> = modelCatalog.MODELS;
let HIRES_SAMPLER = generationContract.HIRES_SAMPLER;
let HIRES_SCHEDULER = generationContract.HIRES_SCHEDULER;
let LORAS: Readonly<Record<string, ImageLoraDefinition>> = modelCatalog.LORAS;
let KREA_STYLE_LORAS: Readonly<Record<string, { file: string; trigger: string }>> = modelCatalog.KREA_STYLE_LORAS;
let OUTPUT_FILENAME_PREFIX = (require('./constants') as typeof import('./constants')).OUTPUT_FILENAME_PREFIX;

// 2026-08-20：Anima hires 真超分辅助——与 WAI 链路同款（Remacri ESRGAN 像素级放大 +
// 低 denoise 二阶段），替代潜空间 bicubic 放大（动漫线条块状/噪感根源之一）。
// 只在 input.superResModel 存在时启用；否则回退原有 LatentUpscaleBy(bicubic)。
// 2026-08-25 实测转正：二阶段 KSampler 低 denoise 重绘在 4MP 外推 latent 上实测
// 全脏（参数/调度器/TeaCache/RCAS/显存机制穷举排除，X1r 连 433f93f 逐字复刻亦脏；
// P1 纯像素直出与 Z1 VAE 往返直出均干净），Remacri 路径改纯像素放大直出：
// Remacri 4x → lanczos 精确缩放 → 保存（无 VAEEncode/KSampler 重绘段）。
function appendSuperResHires(wf: ComfyWorkflow, input: ImageJobInput, opts: { firstPass: ComfyLink; vae: ComfyLink }) {
  let targetW = Math.round(input.width * input.hiresScale / 8) * 8;
  let targetH = Math.round(input.height * input.hiresScale / 8) * 8;
  wf['20'] = { class_type:'VAEDecode', inputs:{ samples:opts.firstPass, vae:opts.vae } };
  wf['21'] = { class_type:'UpscaleModelLoader', inputs:{ model_name:input.superResModel } };
  wf['22'] = { class_type:'ImageUpscaleWithModel', inputs:{ upscale_model:['21', 0], image:['20', 0] } };
  wf['23'] = { class_type:'ImageScale', inputs:{ image:['22', 0], upscale_method:'lanczos', width:targetW, height:targetH, crop:'disabled' } };
  wf['10'].inputs.images = ['23', 0];
}
function buildWorkflow(input: ImageJobInput): ComfyWorkflow {
  let model = MODELS[input.modelId];
  if (model.family === 'krea2') {
    let rebalance = model.rebalance;
    let workflow: ComfyWorkflow = {
      '1': { class_type:'UNETLoader', inputs:{ unet_name:model.file, weight_dtype:'default' } },
      '2': { class_type:'CLIPLoader', inputs:{ clip_name:'qwen3-vl-4b-heretic_fp8_e4m3fn.safetensors', type:'krea2' } },
      '3': { class_type:'VAELoader', inputs:{ vae_name:'qwen_image_vae.safetensors' } },
      '4': { class_type:'CLIPTextEncode', inputs:{ clip:['2', 0], text:input.prompt } },
      '5': { class_type:'ConditioningZeroOut', inputs:{ conditioning:['4', 0] } },
      '6': { class_type:'EmptyLatentImage', inputs:{ width:input.width, height:input.height, batch_size:1 } },
      '8': { class_type:'VAEDecode', inputs:{ samples:['7', 0], vae:['3', 0] } },
      '10': { class_type:'SaveImage', inputs:{ images:['8', 0], filename_prefix:'creative_app' } }
    };
    let positive: ComfyLink = ['4', 0];
    if (rebalance) {
      workflow['11'] = { class_type:'ConditioningKrea2Rebalance', inputs:{
        conditioning:['4', 0],
        preset:rebalance.preset || 'standard',
        multiplier:rebalance.multiplier || 1,
        per_layer_weights:'1.0,1.0,1.0,1.0,1.0,1.0,1.0,2.5,5.0,1.1,4.0,1.0',
        normalize_taps:Boolean(rebalance.normalizeTaps)
      } };
      positive = ['11', 0];
    }
     let kreaModel: ComfyLink = ['1', 0];
     if (input.styleLoraId) {
       let styleLora = KREA_STYLE_LORAS[input.styleLoraId];
       workflow['12'] = { class_type:'LoraLoaderModelOnly', inputs:{ model:kreaModel, lora_name:styleLora.file, strength_model:1 } };
       kreaModel = ['12', 0];
     }
     // 2026-08-22 社区工作流回流（来源 comfyui-mcp krea2-txt2img-manual V2，本机复现
     // 样张 seed 20260822 审核通过）。2026-08-23 实测增强链路与原 euler 标准链路出图
     // 时间一致，原链路退役：LoRA 栈后固定挂 T-Enhancer 细节补丁，采样器固定社区
     // 验证的 er_sde，解码后固定 RCAS 锐化，不再暴露关闭开关。
    workflow['14'] = { class_type:'ComfyUI-Krea2T-Enhancer', inputs:{ model:kreaModel, enabled:true, strength:1.3, debug:false } };
    kreaModel = ['14', 0];
    workflow['7'] = { class_type:'KSampler', inputs:{ model:kreaModel, positive:positive, negative:['5', 0], latent_image:['6', 0], seed:input.seed, steps:12, cfg:1, sampler_name:'er_sde', scheduler:'simple', denoise:1 } };
    workflow['15'] = { class_type:'ImageSharpenKJ', inputs:{ image:['8', 0], method:'rcas', 'method.strength':0.75 } };
    workflow['10'].inputs.images = ['15', 0];
    return workflow;
  }

  let isHires = input.hiresFix === true && input.hiresScale > 1.0;

  if (model.noLora === true && !input.loraId) {
    let noLoraModel: ComfyLink = ['1', 0];
    let noLoraWf: ComfyWorkflow = {
      '1': { class_type:'UNETLoader', inputs:{ unet_name:model.file, weight_dtype:'default' } },
      '2': { class_type:'CLIPLoader', inputs:{ clip_name:'qwen_3_06b_base.safetensors', type:'qwen_image' } },
      '3': { class_type:'VAELoader', inputs:{ vae_name:'qwen_image_vae.safetensors' } },
      '4': { class_type:'CLIPTextEncode', inputs:{ clip:['2', 0], text:input.prompt } },
      '5': { class_type:'CLIPTextEncode', inputs:{ clip:['2', 0], text:input.negative } },
      '6': { class_type:'EmptyLatentImage', inputs:{ width:input.width, height:input.height, batch_size:1 } },
      '7': { class_type:'KSampler', inputs:{
        model:noLoraModel,
        positive:['4', 0],
        negative:['5', 0],
        latent_image:['6', 0],
        seed:input.seed,
        steps:input.steps,
        cfg:input.cfg,
        sampler_name:input.sampler,
        scheduler:input.scheduler,
        denoise:1
      } },
      '8': { class_type:'VAEDecode', inputs:{ samples:['7', 0], vae:['3', 0] } },
      '10': { class_type:'SaveImage', inputs:{ images:['8', 0], filename_prefix:OUTPUT_FILENAME_PREFIX } }
    };
    if (input.teaCache) {
      noLoraWf['13'] = { class_type:'AnimaTeaCache', inputs:{ model:['1', 0], rel_l1_thresh:input.teaCacheThresh || 0.08, start_percent:0, end_percent:1, cache_device:'cuda' } };
      noLoraModel = ['13', 0];
      noLoraWf['7'].inputs.model = noLoraModel;
    }
    if (!input.initImage && !isHires) {
    // 2026-08-23 社区增强回流：纯文生图末端 RCAS 锐化（与 Krea2 转正链路同款，
    // 实测 0.75 强度约 +1s，线条/发丝细节显著提升且无振铃白边）。inpaint 有像素级
    // 回贴保真契约、hires 走超分路径，一律不挂。
    noLoraWf['35'] = { class_type:'ImageSharpenKJ', inputs:{ image:['8', 0], method:'rcas', 'method.strength':0.75 } };
    noLoraWf['10'].inputs.images = ['35', 0];
  }
  if (input.initImage) {
      noLoraWf['15'] = { class_type:'LoadImage', inputs:{ image:input.initImage } };
      noLoraWf['19'] = { class_type:'ResizeAndPadImage', inputs:{ image:['15', 0], target_width:input.width, target_height:input.height, padding_color:'black', interpolation:'lanczos' } };
      noLoraWf['18'] = { class_type:'VAEEncode', inputs:{ pixels:['19', 0], vae:['3', 0] } };
      if (input.maskImage) {
        noLoraWf['15_mask'] = { class_type:'LoadImage', inputs:{ image:input.maskImage } };
        noLoraWf['19_mask'] = { class_type:'ResizeAndPadImage', inputs:{ image:['15_mask', 0], target_width:input.width, target_height:input.height, padding_color:'black', interpolation:'lanczos' } };
        noLoraWf['16'] = { class_type:'ImageToMask', inputs:{ image:['19_mask', 0], channel:'red' } };
        noLoraWf['16_grow'] = { class_type:'GrowMask', inputs:{ mask:['16', 0], expand:input.growMaskBy !== undefined ? input.growMaskBy : 6, tapered_corners:true } };
        noLoraWf['17'] = { class_type:'SetLatentNoiseMask', inputs:{ samples:['18', 0], mask:['16_grow', 0] } };
        noLoraWf['30'] = { class_type:'ImageCompositeMasked', inputs:{ destination:['19', 0], source:['8', 0], x:0, y:0, resize_source:false, mask:['16_grow', 0] } };
        noLoraWf['10'].inputs.images = ['30', 0];
      } else if (input.maskPrompt) {
        // 2026-08-21 换装完善：threshold 可调（默认 0.45）+ 补 ImageCompositeMasked 回贴，
        // 与手绘遮罩分支行为一致——非重绘区像素级保真，不再整图 VAE 往返。
        let clipsegThreshold = input.maskThreshold !== undefined ? input.maskThreshold : 0.45;
        noLoraWf['16'] = { class_type:'AP_CLIPSeg_TextMask', inputs:{ image:['19', 0], prompt:input.maskPrompt, threshold:clipsegThreshold, smooth_radius:2, soft_mask:false, invert:false, model:'clipseg_rd64', mask_dilate:input.growMaskBy !== undefined ? input.growMaskBy : 8, mask_blur:12, device:'auto', unload_after_run:false } };
        noLoraWf['17'] = { class_type:'SetLatentNoiseMask', inputs:{ samples:['18', 0], mask:['16', 0] } };
        noLoraWf['30'] = { class_type:'ImageCompositeMasked', inputs:{ destination:['19', 0], source:['8', 0], x:0, y:0, resize_source:false, mask:['16', 0] } };
        noLoraWf['10'].inputs.images = ['30', 0];
      }
      if (noLoraWf['17']) {
        noLoraWf['7'].inputs.latent_image = ['17', 0];
        noLoraWf['7'].inputs.denoise = input.denoisingStrength !== undefined ? input.denoisingStrength : 0.80;
      }
    }
    if (isHires) {
      // inpaint（手绘遮罩或 CLIPSeg 自动识别）+ hires：对 composite 回贴结果 ['30',0] 超分。
      if (input.initImage && (input.maskImage || input.maskPrompt)) {
        if (input.superResModel) {
          let tw = Math.round(input.width * input.hiresScale / 8) * 8;
          let th = Math.round(input.height * input.hiresScale / 8) * 8;
          noLoraWf['20'] = { class_type:'UpscaleModelLoader', inputs:{ model_name:input.superResModel } };
          noLoraWf['21'] = { class_type:'ImageUpscaleWithModel', inputs:{ upscale_model:['20', 0], image:['30', 0] } };
          noLoraWf['22'] = { class_type:'ImageScale', inputs:{ image:['21', 0], upscale_method:'lanczos', width:tw, height:th, crop:'disabled' } };
          noLoraWf['23'] = { class_type:'VAEEncode', inputs:{ pixels:['22', 0], vae:['3', 0] } };
          // 2026-08-25 修复：二阶段不再走 TeaCache（跳步丢细节 = 放大发糊根因），
          // 直接连 UNET 原模型全量重绘补细节。
          noLoraWf['24'] = { class_type:'KSampler', inputs:{ model:noLoraModel, positive:['4', 0], negative:['5', 0], latent_image:['23', 0], seed:input.seed + 1, steps:Math.max(12, Math.round(input.steps * 0.6)), cfg:input.cfg, sampler_name:HIRES_SAMPLER, scheduler:HIRES_SCHEDULER, denoise:input.hiresDenoise || 0.35 } };
          noLoraWf['25'] = { class_type:'VAEDecode', inputs:{ samples:['24', 0], vae:['3', 0] } };
          noLoraWf['10'].inputs.images = ['25', 0];
        } else {
          noLoraWf['31'] = { class_type:'VAEEncode', inputs:{ pixels:['30', 0], vae:['3', 0] } };
          noLoraWf['32'] = { class_type:'LatentUpscaleBy', inputs:{ samples:['31', 0], upscale_method:'bicubic', scale_by:input.hiresScale } };
          noLoraWf['33'] = { class_type:'KSampler', inputs:{ model:noLoraModel, positive:['4', 0], negative:['5', 0], latent_image:['32', 0], seed:input.seed + 1, steps:Math.max(12, Math.round(input.steps * 0.6)), cfg:input.cfg, sampler_name:HIRES_SAMPLER, scheduler:HIRES_SCHEDULER, denoise:input.hiresDenoise || 0.35 } };
          noLoraWf['34'] = { class_type:'VAEDecode', inputs:{ samples:['33', 0], vae:['3', 0] } };
          noLoraWf['10'].inputs.images = ['34', 0];
        }
      } else if (input.superResModel) {
        appendSuperResHires(noLoraWf, input, { firstPass:['7', 0], vae:['3', 0] });
      } else {
        noLoraWf['11'] = { class_type:'LatentUpscaleBy', inputs:{ samples:['7', 0], upscale_method:'bicubic', scale_by:input.hiresScale } };
        noLoraWf['12'] = { class_type:'KSampler', inputs:{
          model:noLoraModel,
          positive:['4', 0],
          negative:['5', 0],
          latent_image:['11', 0],
          seed:input.seed + 1,
          steps:Math.max(12, Math.round(input.steps * 0.6)),
          cfg:input.cfg,
          sampler_name:HIRES_SAMPLER,
          scheduler:HIRES_SCHEDULER,
          denoise:input.hiresDenoise || 0.35
        } };
        noLoraWf['8'].inputs.samples = ['12', 0];
      }
    }
    if (isHires && !input.superResModel) {
      // Keep hires output on parity with the base route: the ESRGAN/VAE round trip
      // otherwise bypasses the proven RCAS finishing pass and visibly softens line art.
      // Remacri 纯像素路径（superResModel 存在）不挂 RCAS（2026-08-25 P1 实测状态直出）。
      noLoraWf['35'] = { class_type:'ImageSharpenKJ', inputs:{ image:noLoraWf['10'].inputs.images, method:'rcas', 'method.strength':0.75 } };
      noLoraWf['10'].inputs.images = ['35', 0];
    }
    return noLoraWf;
  }

  let lora = LORAS[String(input.loraId)];
  let loraModel: ComfyLink = ['4', 0];
  let loraWf: ComfyWorkflow = {
    '1': { class_type:'UNETLoader', inputs:{ unet_name:model.file, weight_dtype:'default' } },
    '2': { class_type:'CLIPLoader', inputs:{ clip_name:'qwen_3_06b_base.safetensors', type:'qwen_image' } },
    '3': { class_type:'VAELoader', inputs:{ vae_name:'qwen_image_vae.safetensors' } },
    '4': { class_type:'LoraLoader', inputs:{
      model:['1', 0],
      clip:['2', 0],
      lora_name:lora.file,
      strength_model:input.loraStrength,
      strength_clip:input.loraStrength
    } },
    '5': { class_type:'CLIPTextEncode', inputs:{ clip:['4', 1], text:input.prompt } },
    '6': { class_type:'CLIPTextEncode', inputs:{ clip:['4', 1], text:input.negative } },
    '7': { class_type:'EmptyLatentImage', inputs:{ width:input.width, height:input.height, batch_size:1 } },
    '8': { class_type:'KSampler', inputs:{
      model:loraModel,
      positive:['5', 0],
      negative:['6', 0],
      latent_image:['7', 0],
      seed:input.seed,
      steps:input.steps,
      cfg:input.cfg,
      sampler_name:input.sampler,
      scheduler:input.scheduler,
      denoise:1
    } },
    '9': { class_type:'VAEDecode', inputs:{ samples:['8', 0], vae:['3', 0] } },
    '10': { class_type:'SaveImage', inputs:{ images:['9', 0], filename_prefix:OUTPUT_FILENAME_PREFIX } }
  };
  if (input.teaCache) {
    loraWf['13'] = { class_type:'AnimaTeaCache', inputs:{ model:['4', 0], rel_l1_thresh:input.teaCacheThresh || 0.08, start_percent:0, end_percent:1, cache_device:'cuda' } };
    loraModel = ['13', 0];
    loraWf['8'].inputs.model = loraModel;
  }
  if (input.initImage) {
    loraWf['15'] = { class_type:'LoadImage', inputs:{ image:input.initImage } };
    loraWf['19'] = { class_type:'ResizeAndPadImage', inputs:{ image:['15', 0], target_width:input.width, target_height:input.height, padding_color:'black', interpolation:'lanczos' } };
    loraWf['18'] = { class_type:'VAEEncode', inputs:{ pixels:['19', 0], vae:['3', 0] } };
    if (input.maskImage) {
      loraWf['15_mask'] = { class_type:'LoadImage', inputs:{ image:input.maskImage } };
      loraWf['19_mask'] = { class_type:'ResizeAndPadImage', inputs:{ image:['15_mask', 0], target_width:input.width, target_height:input.height, padding_color:'black', interpolation:'lanczos' } };
      loraWf['16'] = { class_type:'ImageToMask', inputs:{ image:['19_mask', 0], channel:'red' } };
      loraWf['16_grow'] = { class_type:'GrowMask', inputs:{ mask:['16', 0], expand:input.growMaskBy !== undefined ? input.growMaskBy : 6, tapered_corners:true } };
      loraWf['17'] = { class_type:'SetLatentNoiseMask', inputs:{ samples:['18', 0], mask:['16_grow', 0] } };
      loraWf['30'] = { class_type:'ImageCompositeMasked', inputs:{ destination:['19', 0], source:['9', 0], x:0, y:0, resize_source:false, mask:['16_grow', 0] } };
      loraWf['10'].inputs.images = ['30', 0];
    } else if (input.maskPrompt) {
      // 2026-08-21 换装完善：threshold 可调（默认 0.45）+ 补 ImageCompositeMasked 回贴，
      // 与手绘遮罩分支行为一致——非重绘区像素级保真，不再整图 VAE 往返。
      let loraClipsegThreshold = input.maskThreshold !== undefined ? input.maskThreshold : 0.45;
      loraWf['16'] = { class_type:'AP_CLIPSeg_TextMask', inputs:{ image:['19', 0], prompt:input.maskPrompt, threshold:loraClipsegThreshold, smooth_radius:2, soft_mask:false, invert:false, model:'clipseg_rd64', mask_dilate:input.growMaskBy !== undefined ? input.growMaskBy : 8, mask_blur:12, device:'auto', unload_after_run:false } };
      loraWf['17'] = { class_type:'SetLatentNoiseMask', inputs:{ samples:['18', 0], mask:['16', 0] } };
      loraWf['30'] = { class_type:'ImageCompositeMasked', inputs:{ destination:['19', 0], source:['9', 0], x:0, y:0, resize_source:false, mask:['16', 0] } };
      loraWf['10'].inputs.images = ['30', 0];
    }
    if (loraWf['17']) {
      loraWf['8'].inputs.latent_image = ['17', 0];
      loraWf['8'].inputs.denoise = input.denoisingStrength !== undefined ? input.denoisingStrength : 0.80;
    }
  }
  if (isHires) {
    // inpaint（手绘遮罩或 CLIPSeg 自动识别）+ hires：对 composite 回贴结果 ['30',0] 超分。
    // 2026-08-21 换装完善：此前只认 maskImage，CLIPSeg 任务会误走普通生图超分分支。
    if (input.initImage && (input.maskImage || input.maskPrompt)) {
      if (input.superResModel) {
        let ltw = Math.round(input.width * input.hiresScale / 8) * 8;
        let lth = Math.round(input.height * input.hiresScale / 8) * 8;
        loraWf['20'] = { class_type:'UpscaleModelLoader', inputs:{ model_name:input.superResModel } };
        loraWf['21'] = { class_type:'ImageUpscaleWithModel', inputs:{ upscale_model:['20', 0], image:['30', 0] } };
        loraWf['22'] = { class_type:'ImageScale', inputs:{ image:['21', 0], upscale_method:'lanczos', width:ltw, height:lth, crop:'disabled' } };
        loraWf['23'] = { class_type:'VAEEncode', inputs:{ pixels:['22', 0], vae:['3', 0] } };
        // 2026-08-25 修复：二阶段不再走 TeaCache（跳步丢细节 = 放大发糊根因），
        // 直接连 LoraLoader 原模型全量重绘补细节。
        loraWf['24'] = { class_type:'KSampler', inputs:{ model:loraModel, positive:['5', 0], negative:['6', 0], latent_image:['23', 0], seed:input.seed + 1, steps:Math.max(12, Math.round(input.steps * 0.6)), cfg:input.cfg, sampler_name:HIRES_SAMPLER, scheduler:HIRES_SCHEDULER, denoise:input.hiresDenoise || 0.35 } };
        loraWf['25'] = { class_type:'VAEDecode', inputs:{ samples:['24', 0], vae:['3', 0] } };
        loraWf['10'].inputs.images = ['25', 0];
      } else {
        loraWf['31'] = { class_type:'VAEEncode', inputs:{ pixels:['30', 0], vae:['3', 0] } };
        loraWf['32'] = { class_type:'LatentUpscaleBy', inputs:{ samples:['31', 0], upscale_method:'bicubic', scale_by:input.hiresScale } };
        loraWf['33'] = { class_type:'KSampler', inputs:{ model:loraModel, positive:['5', 0], negative:['6', 0], latent_image:['32', 0], seed:input.seed + 1, steps:Math.max(12, Math.round(input.steps * 0.6)), cfg:input.cfg, sampler_name:HIRES_SAMPLER, scheduler:HIRES_SCHEDULER, denoise:input.hiresDenoise || 0.35 } };
        loraWf['34'] = { class_type:'VAEDecode', inputs:{ samples:['33', 0], vae:['3', 0] } };
        loraWf['10'].inputs.images = ['34', 0];
      }
    } else if (input.superResModel) {
      appendSuperResHires(loraWf, input, { firstPass:['8', 0], vae:['3', 0] });
    } else {
      loraWf['11'] = { class_type:'LatentUpscaleBy', inputs:{ samples:['8', 0], upscale_method:'bicubic', scale_by:input.hiresScale } };
      loraWf['12'] = { class_type:'KSampler', inputs:{
        model:loraModel,
        positive:['5', 0],
        negative:['6', 0],
        latent_image:['11', 0],
        seed:input.seed + 1,
        steps:Math.max(12, Math.round(input.steps * 0.6)),
        cfg:input.cfg,
        sampler_name:HIRES_SAMPLER,
        scheduler:HIRES_SCHEDULER,
        denoise:input.hiresDenoise || 0.35
      } };
      loraWf['9'].inputs.samples = ['12', 0];
    }
  }
  if (isHires && !input.superResModel) {
    // Remacri/VAE and latent hires both need the same finishing pass as base output;
    // without it, the final enlarged image is softer than the unscaled preview.
    // Remacri 纯像素路径（superResModel 存在）不挂 RCAS（2026-08-25 P1 实测状态直出）。
    loraWf['35'] = { class_type:'ImageSharpenKJ', inputs:{ image:loraWf['10'].inputs.images, method:'rcas', 'method.strength':0.75 } };
    loraWf['10'].inputs.images = ['35', 0];
  } else if (!isHires && !input.initImage) {
    // 同 no-LoRA 路线：非 hires 纯文生图末端 RCAS 锐化；inpaint 保持像素级回贴保真。
    // 2026-08-25 修复：必须排除 isHires——否则覆盖 appendSuperResHires 的像素直出
    // （10←23），Remacri 节点变孤立、ComfyUI 跳过未消费节点，输出退回原尺寸
    // （gateway 全链路实测 832x1216 的根因；node23 孤立被复现）。
    loraWf['35'] = { class_type:'ImageSharpenKJ', inputs:{ image:['9', 0], method:'rcas', 'method.strength':0.75 } };
    loraWf['10'].inputs.images = ['35', 0];
  }
  return loraWf;
}

export = {
  appendSuperResHires:appendSuperResHires,
  buildWorkflow:buildWorkflow,
};
