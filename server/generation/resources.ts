import fs = require('node:fs');
import path = require('node:path');
import superres = require('../../routes/superres');
import { CHECKPOINT } from './constants';
import { error } from './errors';
import type { GenerationConfig, GenerationInput } from './types';
function comfyModelsRoot(config: GenerationConfig, kind: string) {
    return path.resolve(config.AI_WORKSPACE_ROOT || '', 'ComfyUI', 'models', kind);
}
export function safeComfyResource(config: GenerationConfig, kind: string, file: string) {
    let root = comfyModelsRoot(config, kind);
    let target = path.resolve(root, file);
    if (target.indexOf(root + path.sep) !== 0)
        return false;
    try {
        return fs.statSync(target).isFile();
    }
    catch (error) {
        return false;
    }
}
// 2026-08-18：探测本机可用的 ESRGAN 超分模型（按优先顺序），返回文件名或 null。
// 供 upstream 无 WebUI 时的本地真 super-res hires（generation.js 原生 Comfy 链路）。
// 复用共享模块 routes/superres.js（WAI 与 Anima 两条链路同一份清单与探测逻辑）。
export function availableSuperRes(config: GenerationConfig) {
    return superres.availableSuperRes(config);
}
export function normalizeCheckpointName(value: string) {
    let text = String(value || '').trim().replace(/^.*[\\/]/, '');
    text = text.replace(/\s*(?:\[[^\]]*\]|\([^)]*\))\s*$/, '').trim();
    text = text.replace(/\.(?:safetensors|ckpt|pt)$/i, '').trim();
    return text.replace(/[\s-]+/g, '_').replace(/_+/g, '_').toLowerCase();
}
export function isWaiCheckpoint(value: string) {
    return normalizeCheckpointName(value) === normalizeCheckpointName(CHECKPOINT);
}
export function comfyResourcesAvailable(config: GenerationConfig, input: GenerationInput) {
    if (!safeComfyResource(config, 'checkpoints', CHECKPOINT))
        return false;
    return (input.loras || []).every(function (lora: {
        file: string;
    }) { return safeComfyResource(config, 'loras', lora.file); });
}
export function validateWaiResources(config: GenerationConfig, input: GenerationInput) {
    if (!comfyResourcesAvailable(config, input))
        throw error(503, 'COMFY_RESOURCES_UNAVAILABLE', 'WAI checkpoint 或所选 LoRA 资源不可用');
}
