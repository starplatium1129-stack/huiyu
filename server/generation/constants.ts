import superres = require('../../routes/superres');
const { COMFY_SUPERRES_FILES, SUPER_RES_UPSALERS } = superres;
export { COMFY_SUPERRES_FILES, SUPER_RES_UPSALERS };
export const MAX_PENDING = 4;
export const MAX_BODY = '64kb';
export const MAX_UPSTREAM_JSON_BYTES = 8 * 1024 * 1024;
export const WEB_JOB_TTL_MS = 2 * 60 * 60 * 1000;
export const CHECKPOINT = 'waiIllustriousSDXL_v170.safetensors';
export const OUTPUT_PREFIX = 'wai_app';
export const LORAS: Record<string, {
    file: string;
    character: string;
    min: number;
    max: number;
}> = Object.freeze({
    L_NENE_V18_WD14: { file: 'ayachi_nene_v18_wd14.safetensors', character: 'nene', min: 0.65, max: 1 },
    L_NAT_V18_WD14: { file: 'shiki_natsume_v18_wd14.safetensors', character: 'natsume', min: 0.65, max: 1 }
});
export const DUAL_LORA_IDS = Object.freeze(['L_NENE_V18_WD14', 'L_NAT_V18_WD14']);
export const WEBUI_UPSCALERS = new Set(['Auto', 'Remacri', 'Latent', 'Latent (nearest-exact)', 'R-ESRGAN 4x+ Anime6B', 'R-ESRGAN 4x+']);
// Comfy 本地真超分模型见 routes/superres.js（Remacri 优先，按优先级探测 upscale_models）。
export const SAMPLERS: Record<string, {
    sampler: string;
    scheduler: string;
}> = Object.freeze({
    'DPM++ 2M': { sampler: 'dpmpp_2m', scheduler: 'normal' },
    'DPM++ 2M Karras': { sampler: 'dpmpp_2m', scheduler: 'karras' },
    'Euler a': { sampler: 'euler_ancestral', scheduler: 'normal' },
    'Euler': { sampler: 'euler', scheduler: 'normal' }
});
export const ALLOWED = new Set([
    'prompt', 'negative', 'profile', 'modelId', 'character', 'loras', 'width', 'height',
    'steps', 'cfg', 'seed', 'sampler', 'scheduler', 'hiresFix', 'hiresScale',
    'hiresUpscaler', 'hiresSteps', 'denoisingStrength', 'faceDetailer', 'adultEnabled'
]);
