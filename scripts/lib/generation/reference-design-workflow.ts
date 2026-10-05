import catalog = require('./anima-model-catalog');

type Workflow = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

/** Reference-sheet graph: no LoRA, inpaint, hires or runtime job ownership. */
export function buildReferenceDesignWorkflow(input: { prompt: string; negative: string; seed: number; teaCacheThresh: number }): Workflow {
  const model = catalog.MODELS['anima-miaomiao-v1.6'];
  const workflow: Workflow = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: model.file, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_3_06b_base.safetensors', type: 'qwen_image' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_vae.safetensors' } },
    '4': { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: input.prompt } },
    '5': { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: input.negative } },
    '6': { class_type: 'EmptyLatentImage', inputs: { width: 960, height: 1536, batch_size: 1 } },
    '7': { class_type: 'KSampler', inputs: {
      model: ['1', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0],
      seed: input.seed, steps: model.steps, cfg: model.cfg, sampler_name: model.sampler,
      scheduler: model.scheduler, denoise: 1,
    } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } },
    '10': { class_type: 'SaveImage', inputs: { images: ['35', 0], filename_prefix: 'design_batch_tmp' } },
    // Existing sheet output uses RCAS 0.75 after decoding; preserve that finishing
    // pass until a separately reviewed reference-rendering change replaces it.
    '35': { class_type: 'ImageSharpenKJ', inputs: { image: ['8', 0], method: 'rcas', 'method.strength': 0.75 } },
  };
  if (input.teaCacheThresh > 0) {
    workflow['13'] = { class_type: 'AnimaTeaCache', inputs: { model: ['1', 0], rel_l1_thresh: input.teaCacheThresh, start_percent: 0, end_percent: 1, cache_device: 'cuda' } };
    workflow['7'].inputs.model = ['13', 0];
  }
  return workflow;
}
