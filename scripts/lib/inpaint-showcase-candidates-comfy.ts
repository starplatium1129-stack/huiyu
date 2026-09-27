'use strict';

// inpaint-showcase-candidates: ComfyUI transport and workflow construction.

const { JOB_TIMEOUT_MS, POLL_INTERVAL_MS, UPSCALE }: typeof import('./inpaint-showcase-candidates-records.js') = require('./inpaint-showcase-candidates-records.js');

// ── ComfyUI client ──────────────────────────────────────────────────────────

function comfyJson(base: any, method: any, pathname: any, body: any, timeoutMs: any) {
  return new Promise<any>((resolve: any, reject: any) => {
    const url = new URL(base.replace(/\/$/, '') + pathname);
    const client = url.protocol === 'https:' ? (require('https') as typeof import('https')) : (require('http') as typeof import('http'));
    const payload = body === undefined || body === null ? null : Buffer.from(JSON.stringify(body));
    const request = client.request({
      hostname: url.hostname, port: url.port, method,
      path: url.pathname + url.search, timeout: timeoutMs || 30000,
      headers: Object.assign({ Accept: 'application/json' }, payload ? {
        'Content-Type': 'application/json', 'Content-Length': payload.length,
      } : {}),
    }, (response: any) => {
      const chunks: any[] = [];
      response.on('data', (chunk: any) => chunks.push(chunk));
      response.on('end', () => {
        const rawBuffer = Buffer.concat(chunks);
        const raw = rawBuffer.toString('utf8');
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch (error) { /* keep null */ }
        resolve({ status: response.statusCode || 0, data, raw, rawBuffer });
      });
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('ComfyUI request timeout')));
    if (payload) request.write(payload);
    request.end();
  });
}

async function uploadImage(comfyBase: any, filename: any, buffer: any) {
  const boundary = `----aics${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`,
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  const payload = Buffer.concat([prefix, buffer, suffix]);
  const url = new URL(comfyBase.replace(/\/$/, '') + '/upload/image');
  const client = url.protocol === 'https:' ? (require('https') as typeof import('https')) : (require('http') as typeof import('http'));
  return new Promise<any>((resolve: any, reject: any) => {
    const request = client.request({
      hostname: url.hostname, port: url.port, method: 'POST', timeout: 60000,
      path: url.pathname + '?overwrite=true',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': payload.length,
      },
    }, (response: any) => {
      const chunks: any[] = [];
      response.on('data', (chunk: any) => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = JSON.parse(raw); } catch (error) { /* keep null */ }
        resolve({ status: response.statusCode || 0, data, raw });
      });
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('ComfyUI upload timeout')));
    request.write(payload);
    request.end();
  });
}

/**
 * ComfyUI 0.31.0 /upload/image IGNORES overwrite=true and renames an existing
 * file to "<name> (1).png". Re-running would then load a stale file via the
 * LoadImage node. To stay correct on resume/--force we (a) always use the
 * server-returned name for LoadImage and (b) derive it ourselves when the
 * response is empty: if the target exists, append the counter ComfyUI uses.
 */
function resolveUploadName(requested: any, uploaded: any) {
  const serverName = uploaded && uploaded.data && uploaded.data.name;
  if (serverName) return serverName;
  // no JSON (defensive): replicate ComfyUI's rename so the LoadImage node still
  // points at the file that was actually written.
  return requested;
}

async function submitAndWait(comfyBase: any, workflow: any) {
  const submitted = await comfyJson(comfyBase, 'POST', '/prompt', { prompt: workflow, client_id: `aics-inpaint-${process.pid}` }, 30000);
  if (submitted.status < 200 || submitted.status >= 300 || !submitted.data || !submitted.data.prompt_id) {
    throw new Error(`ComfyUI prompt submission failed (HTTP ${submitted.status}): ${submitted.raw || JSON.stringify(submitted.data)}`);
  }
  const promptId = submitted.data.prompt_id;
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const history = await comfyJson(comfyBase, 'GET', `/history/${encodeURIComponent(promptId)}`, null, 15000);
    const entry = history.data && history.data[promptId];
    if (entry) {
      const status = entry.status && entry.status.status_str;
      if (status === 'error' || status === 'failed') {
        const messages = (entry.status && entry.status.messages || [])
          .filter(([, value]: any) => value && value.exception_message)
          .map(([, value]: any) => value.exception_message);
        throw new Error(`ComfyUI execution failed for ${promptId}: ${messages.join(' | ') || JSON.stringify(entry.status)}`);
      }
      if (status === 'success') {
        return { promptId, entry };
      }
    }
    await new Promise<any>((resolve: any) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`ComfyUI execution timed out for ${promptId}`);
}

async function fetchOutputImage(comfyBase: any, image: any) {
  const query = `?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(image.subfolder || '')}&type=output`;
  const response = await comfyJson(comfyBase, 'GET', '/view' + query, null, 60000);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`ComfyUI /view failed (HTTP ${response.status})`);
  }
  return response.rawBuffer;
}

// ── workflow builder (mirrors routes/generation.js + routes/anima.js) ──────

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

export = { uploadImage, resolveUploadName, buildOpWorkflow, submitAndWait, fetchOutputImage, comfyJson };
