// inpaint-showcase-candidates: workflow construction.
const { UPSCALE }: typeof import('./inpaint-showcase-candidates-records.js') = require('./inpaint-showcase-candidates-records.js');

// ── workflow builder (offline SD/Anima candidate graphs) ──────

function modelNodes(cfg: any, graph: any, startId: any) {
  let next = startId;
  const node = (classType: any, inputs: any) => {
    const id = String(next);
    next += 1;
    graph[id] = { class_type: classType, inputs };
    return id;
  };
  if (cfg.engine === 'sd') {
    const ckpt = node('CheckpointLoaderSimple', { ckpt_name: cfg.checkpoint });
    const lora = node('LoraLoader', {
      model: [ckpt, 0], clip: [ckpt, 1],
      lora_name: cfg.lora.file, strength_model: cfg.lora.strength, strength_clip: cfg.lora.strength,
    });
    const pos = node('CLIPTextEncode', { clip: [lora, 1], text: '' });
    const neg = node('CLIPTextEncode', { clip: [lora, 1], text: '' });
    return { model: [lora, 0], pos, neg, vae: [ckpt, 2], next };
  }
  const unet = node('UNETLoader', { unet_name: cfg.unet, weight_dtype: 'default' });
  const clip = node('CLIPLoader', { clip_name: cfg.clip, type: 'qwen_image' });
  const vae = node('VAELoader', { vae_name: cfg.vae });
  const lora = node('LoraLoader', {
    model: [unet, 0], clip: [clip, 0],
    lora_name: cfg.lora.file, strength_model: cfg.lora.strength, strength_clip: cfg.lora.strength,
  });
  const pos = node('CLIPTextEncode', { clip: [lora, 1], text: '' });
  const neg = node('CLIPTextEncode', { clip: [lora, 1], text: '' });
  return { model: [lora, 0], pos, neg, vae: [vae, 0], next };
}

function buildOpWorkflow(cfg: any, op: any, denoiseConfig: any, prompt: any, negative: any, sourceImageName: any, maskImageName: any, crop: any) {
  const graph: Record<string, any> = {};
  let next = 1;
  const add = (classType: any, inputs: any) => {
    const id = String(next);
    next += 1;
    graph[id] = { class_type: classType, inputs };
    return id;
  };
  const loadSource = add('LoadImage', { image: sourceImageName });
  const loadMask = add('LoadImage', { image: maskImageName });

  // crop + upscale the face band
  const cropImage = add('ImageCrop', {
    image: [loadSource, 0],
    width: crop.w, height: crop.h, x: crop.x, y: crop.y,
  });
  const upImage = add('ImageScale', {
    image: [cropImage, 0], upscale_method: 'lanczos',
    width: crop.w * UPSCALE, height: crop.h * UPSCALE, crop: 'disabled',
  });

  // crop + upscale the mask identically (nearest keeps the mask hard)
  const cropMask = add('ImageCrop', {
    image: [loadMask, 0],
    width: crop.w, height: crop.h, x: crop.x, y: crop.y,
  });
  const upMask = add('ImageScale', {
    image: [cropMask, 0], upscale_method: 'nearest-exact',
    width: crop.w * UPSCALE, height: crop.h * UPSCALE, crop: 'disabled',
  });
  const maskTensor = add('ImageToMask', { image: [upMask, 0], channel: 'red' });

  const models = modelNodes(cfg, graph, next);
  next = models.next;
  graph[models.pos].inputs.text = prompt;
  graph[models.neg].inputs.text = negative;

  let latentInput;
  if (denoiseConfig.mode === 'vae-inpaint') {
    const encodeInpaint = add('VAEEncodeForInpaint', {
      pixels: [upImage, 0], vae: models.vae, mask: [maskTensor, 0], grow_mask_by: 6,
    });
    latentInput = [encodeInpaint, 0];
  } else {
    const encode = add('VAEEncode', { pixels: [upImage, 0], vae: models.vae });
    const setMask = add('SetLatentNoiseMask', { samples: [encode, 0], mask: [maskTensor, 0] });
    latentInput = [setMask, 0];
  }

  const sample = add('KSampler', {
    model: models.model, positive: [models.pos, 0], negative: [models.neg, 0],
    latent_image: latentInput,
    seed: 0, steps: cfg.steps, cfg: cfg.cfg,
    sampler_name: cfg.sampler, scheduler: cfg.scheduler,
    denoise: denoiseConfig.denoise,
  });
  const decode = add('VAEDecode', { samples: [sample, 0], vae: models.vae });

  // scale back to the original crop size, then composite onto the full source
  const downImage = add('ImageScale', {
    image: [decode, 0], upscale_method: 'lanczos',
    width: crop.w, height: crop.h, crop: 'disabled',
  });
  const composite = add('ImageCompositeMasked', {
    destination: [loadSource, 0], source: [downImage, 0],
    x: crop.x, y: crop.y, resize_source: false,
  });
  add('SaveImage', { images: [composite, 0], filename_prefix: `aics_inpaint_${op.id}_${denoiseConfig.id}` });

  return graph;
}

export = { buildOpWorkflow };
