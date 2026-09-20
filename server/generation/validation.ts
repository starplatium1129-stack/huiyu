import crypto = require('node:crypto');
import path = require('node:path');
import type { Request } from 'express';
import security = require('../security');
import validationCore = require('../validation-core');
import { ALLOWED, LORAS, DUAL_LORA_IDS, SAMPLERS, WEBUI_UPSCALERS, SUPER_RES_UPSALERS } from './constants';
import { error, plain, number } from './errors';
import type { GenerationInput } from './types';
function assertAdultAllowed(req: Request | null, body: Record<string, unknown>) {
    if (!validationCore.detectAdultIntent(body.prompt))
        return;
    let hasLocalBypass = req && security.isDirectLocalRequest(req);
    if (hasLocalBypass)
        return;
    // 服务端锚点（2026-08-28）：远程/隧道访问默认拒绝成人参数，请求体自报
    // adultEnabled 不再单独构成授权；AICS_ADULT_REMOTE=1 显式开启后仍走双门校验。
    let remote = validationCore.evaluateAdultRemote(false);
    if (remote) {
        throw error(403, remote.code, remote.message);
    }
    let targetChar = validationCore.inferAdultTargetChar(body, { useLoras: true });
    let denial = validationCore.evaluateAdultAccess(targetChar, body.adultEnabled);
    if (!denial)
        return;
    if (denial.reason === 'CHARACTER_NOT_ELIGIBLE') {
        throw error(403, 'ADULT_CHARACTER_NOT_ELIGIBLE', denial.message);
    }
    throw error(403, 'ADULT_NOT_ENABLED', denial.message);
}
export function validate(reqOrBody: unknown, maybeBody?: unknown): GenerationInput {
    let req: Request | null = null;
    let body: unknown;
    if (maybeBody !== undefined || (plain(reqOrBody) && reqOrBody.socket && reqOrBody.headers)) {
        req = reqOrBody as Request;
        body = maybeBody;
    }
    else {
        body = reqOrBody;
    }
    if (!plain(body))
        throw error(400, 'INVALID_BODY', '请求体必须是 JSON 对象');
    Object.keys(body).forEach(function (key) { if (!ALLOWED.has(key))
        throw error(400, 'UNKNOWN_PARAMETER', '不支持的参数：' + key); });
    assertAdultAllowed(req, body);
    if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 12000)
        throw error(400, 'INVALID_PARAMETER', 'prompt 无效');
    if (body.negative !== undefined && (typeof body.negative !== 'string' || body.negative.length > 8000))
        throw error(400, 'INVALID_PARAMETER', 'negative 无效');
    if (body.modelId !== undefined && body.modelId !== 'waiIllustriousSDXL_v170')
        throw error(400, 'UNKNOWN_MODEL', '未知 WAI checkpoint');
    const rawLoras = body.loras === undefined ? [] : body.loras;
    if (!Array.isArray(rawLoras) || rawLoras.length > 2)
        throw error(400, 'INVALID_PARAMETER', 'LoRA 列表无效');
    let loras = rawLoras.map(function (item: unknown) {
        if (!plain(item) || typeof item.id !== 'string' || !Object.hasOwn(LORAS, item.id))
            throw error(400, 'UNKNOWN_LORA', '未知 WAI LoRA');
        let spec = LORAS[item.id];
        return { id: item.id, strength: number(item.strength, 'loraStrength', 0, 2, false), file: spec.file };
    });
    let ids = loras.map(function (item) { return item.id; });
    if (new Set(ids).size !== ids.length)
        throw error(400, 'INVALID_PARAMETER', 'LoRA 不得重复');
    let dual = ids.length === 2 && DUAL_LORA_IDS.every(function (id) { return ids.indexOf(id) !== -1; });
    loras = loras.map(function (item) {
        let spec = LORAS[item.id];
        let min = dual ? 0.45 : spec.min;
        let max = dual ? 0.70 : spec.max;
        return { id: item.id, strength: number(item.strength, 'loraStrength', min, max, false), file: spec.file };
    });
    let width = number(body.width, 'width', 512, 1536, true);
    let height = number(body.height, 'height', 512, 2048, true);
    if (width % 8 || height % 8 || width % 64 || height % 64)
        throw error(400, 'INVALID_PARAMETER', '输出尺寸必须符合 64 对齐契约');
    let sampler = body.sampler || 'DPM++ 2M';
    if (typeof sampler !== 'string' || sampler.length > 80)
        throw error(400, 'UNSUPPORTED_SAMPLER', '采样器名称无效');
    let mapped = Object.hasOwn(SAMPLERS, sampler) ? SAMPLERS[sampler] : undefined;
    let comfyUnsupported = !mapped;
    if (mapped && body.scheduler !== undefined && body.scheduler !== '' && body.scheduler !== mapped.scheduler && !(sampler === 'DPM++ 2M' && (body.scheduler === 'Karras' || body.scheduler === 'karras')))
        comfyUnsupported = true;
    let seed = body.seed === undefined || Number(body.seed) < 0 ? crypto.randomInt(0, 2147483647) : number(body.seed, 'seed', 0, 9007199254740991, true);
    let loraTags = [];
    let loraTagPattern = /<lora:([^:>]+):([^>]+)>/gi;
    let tagMatch;
    while ((tagMatch = loraTagPattern.exec(body.prompt)) !== null) {
        let tagName = String(tagMatch[1]).trim();
        let tagWeight = Number(tagMatch[2]);
        let matchingLora = loras.find(function (lora) { return path.basename(lora.file, path.extname(lora.file)).toLowerCase() === tagName.toLowerCase(); });
        if (!matchingLora || !Number.isFinite(tagWeight) || Math.abs(tagWeight - matchingLora.strength) > 0.0001)
            comfyUnsupported = true;
        loraTags.push({ name: tagName, weight: tagWeight });
    }
    let cleanPrompt = body.prompt.replace(/<lora:[^>]+>/gi, '').replace(/,\s*,/g, ',').replace(/^\s*,|,\s*$/g, '').trim();
    let input: GenerationInput = {
        autoHires: false, superResWanted: false, comfyHires: false,
        prompt: body.prompt.trim(), cleanPrompt: cleanPrompt, loraTags: loraTags, negative: typeof body.negative === 'string' ? body.negative.trim() : '',
        profile: typeof body.profile === 'string' ? body.profile : '', modelId: 'waiIllustriousSDXL_v170', character: body.character || '',
        loras: loras, width: width, height: height, steps: number(body.steps === undefined ? 28 : body.steps, 'steps', 1, 60, true),
        cfg: number(body.cfg === undefined ? 5.5 : body.cfg, 'cfg', 0.5, 20, false), seed: seed, sampler: sampler,
        scheduler: ((body.scheduler === 'Karras' || body.scheduler === 'karras') ? 'karras' : (mapped ? mapped.scheduler : 'normal')), webuiScheduler: typeof body.scheduler === 'string' ? body.scheduler : '', comfyUnsupported: comfyUnsupported, hiresFix: Boolean(body.hiresFix), hiresScale: body.hiresScale === undefined ? 1.5 : number(body.hiresScale, 'hiresScale', 1, 2, false),
        hiresUpscaler: typeof body.hiresUpscaler === 'string' ? body.hiresUpscaler : 'Latent',
        hiresSteps: body.hiresSteps === undefined ? 14 : number(body.hiresSteps, 'hiresSteps', 1, 60, true),
        denoisingStrength: body.denoisingStrength === undefined ? 0.35 : number(body.denoisingStrength, 'denoisingStrength', 0, 1, false),
        faceDetailer: Boolean(body.faceDetailer)
    };
    if (!WEBUI_UPSCALERS.has(input.hiresUpscaler))
        throw error(400, 'UNSUPPORTED_UPSCALER', '放大器不在服务端白名单');
    input.autoHires = input.hiresFix && input.hiresUpscaler === 'Auto';
    // 2026-08-18：Comfy 本地真 super-res 意图（Remacri / R-ESRGAN 系）也算 Comfy 能力，
    // 但具体 ESRGAN 模型文件可用性由路由层（有 config / fs）决定并注入 input.superResModel。
    input.superResWanted = input.hiresFix && SUPER_RES_UPSALERS.has(input.hiresUpscaler);
    input.comfyHires = input.hiresFix && (input.autoHires || input.hiresUpscaler === 'Latent' || input.hiresUpscaler === 'Latent (nearest-exact)' || input.superResWanted)
        && input.hiresScale >= 1.25 && input.hiresScale <= 1.5 && input.hiresSteps >= 8 && input.hiresSteps <= 24
        && input.denoisingStrength >= 0.25 && input.denoisingStrength <= 0.5
        && input.width * input.height * input.hiresScale * input.hiresScale <= 3200000;
    input.comfyUnsupported = input.comfyUnsupported || (input.hiresFix && !input.comfyHires);
    return input;
}
