import crypto = require('node:crypto');
import httpClient = require('../../services/http-client');
import { CHECKPOINT, MAX_UPSTREAM_JSON_BYTES } from './constants';
import { isWaiCheckpoint } from './resources';
import { error, plain } from './errors';
import { errorCode, errorMessage, errorField } from '../../scripts/lib/runtime-errors';
import type { GenerationConfig, GenerationInput, WebUIJob, WebUIStatus } from './types';
function freezeLoras(loras: GenerationInput['loras']) {
    return Object.freeze(loras.map(lora => Object.freeze({ id: lora.id, strength: lora.strength })));
}
type WebUIConnection = Pick<GenerationConfig, 'SD_HOST' | 'SD_API_AUTH'>;
/** Reuse the bounded transport: body truncation, aborts and total deadlines must all settle. */
export async function requestJson(config: WebUIConnection, hostKey: 'SD_HOST', method: string, pathname: string, body: unknown, timeout: number, signal?: AbortSignal): Promise<unknown> {
    let target: URL;
    try {
        target = new URL(config[hostKey]);
        if (!['http:', 'https:'].includes(target.protocol)) throw new Error('protocol');
    } catch {
        throw error(502, 'UPSTREAM_CONFIG_INVALID', '上游地址无效');
    }
    let response;
    let raw: string;
    try {
        const headers: Record<string, string> = { Accept: 'application/json' };
        if (config.SD_API_AUTH) headers.Authorization = 'Basic ' + Buffer.from(config.SD_API_AUTH).toString('base64');
        const result = await httpClient.request(target.origin, pathname, {
            method, headers, json: body == null ? undefined : body, signal,
            timeoutMs: timeout || 10000, totalTimeoutMs: timeout || 10000,
        });
        response = result.response;
        raw = (await httpClient.readBody(response, MAX_UPSTREAM_JSON_BYTES)).toString('utf8');
    } catch (cause) {
        const code = errorCode(cause);
        if (httpClient.isAbortError(cause)) throw error(499, 'ABORT_ERR', '上游请求已取消');
        if (code === 'UPSTREAM_TIMEOUT' || code === 'UPSTREAM_DEADLINE')
            throw error(504, 'UPSTREAM_TIMEOUT', '上游请求超时');
        if (code === 'RESPONSE_TOO_LARGE')
            throw error(502, 'UPSTREAM_RESPONSE_TOO_LARGE', '上游响应过大');
        // Do not expose socket errors containing host addresses or credentials.
        throw error(502, 'UPSTREAM_UNAVAILABLE', '上游连接不可用或响应中断');
    }
    let data: unknown;
    try { data = raw ? JSON.parse(raw) : null; }
    catch { throw error(502, 'INVALID_UPSTREAM_RESPONSE', '上游返回无效 JSON'); }
    if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300)
        throw error(502, 'UPSTREAM_ERROR', '上游请求失败', { status: response.statusCode, data });
    return data;
}
// 探测结果短 TTL 缓存 + 在途合并（2026-08-21 性能审计 #3）：/api/generation/status
// 与每次提交任务都调用本探测；五个请求已并行化，但无缓存时提交仍要多等一个
// 并行探测往返。默认缓存 3s；**提交路径必须传 {fresh:true} 绕过缓存**——上游刚
// 下线时路由决策必须立刻看到（否则 faceDetailer 任务会被送进注定失败的 WebUI
// 异步失败，而不是立即 503，见 test-generation-routes.js 的离线路径断言）。
const WEBUI_PROBE_TTL_MS = 3000;
/** Each service owns its cache. Fresh submission probes cannot reuse an older status request. */
export function createWebUIProbe(config: WebUIConnection, request = requestJson) {
    let cached: {
        at: number;
        value: WebUIStatus;
    } | null = null;
    let pending: Promise<WebUIStatus> | null = null;
    let generation = 0;
    let hostKey = '';
    let authKey: string | undefined;
    return function probe(options: {
        fresh?: boolean;
    } = {}): Promise<WebUIStatus> {
        const host = String(config.SD_HOST);
        const auth = config.SD_API_AUTH;
        if (host !== hostKey || auth !== authKey) {
            hostKey = host;
            authKey = auth;
            cached = null;
            pending = null;
            ++generation;
        }
        if (!options.fresh && pending)
            return pending;
        if (!options.fresh && cached && Date.now() - cached.at < WEBUI_PROBE_TTL_MS)
            return Promise.resolve(cached.value);
        const token = ++generation;
        const work = doProbeWebUI({ SD_HOST: host, SD_API_AUTH: auth }, request).then(value => {
            if (token === generation) {
                cached = { at: Date.now(), value };
                pending = null;
            }
            return value;
        });
        pending = work;
        return work;
    };
}
const catalogRecords = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter(plain) : [];
const catalogNames = (value: unknown, keys: string[]) => catalogRecords(value)
    .map(item => keys.map(key => item[key]).find(v => typeof v === 'string' && v.length > 0))
    .filter((value): value is string => typeof value === 'string');
async function doProbeWebUI(config: WebUIConnection, request: typeof requestJson): Promise<WebUIStatus> {
    try {
        // 五个端点并行探测（对照 control.js /api/sd-status 的并行口径）；options 是
        // 唯一的硬依赖，其余失败按空列表降级——与原串行版本行为一致。
        let probeResults = await Promise.all([
            request(config, 'SD_HOST', 'GET', '/sdapi/v1/options', null, 3000),
            request(config, 'SD_HOST', 'GET', '/sdapi/v1/samplers', null, 3000).catch(function () { return []; }),
            request(config, 'SD_HOST', 'GET', '/sdapi/v1/schedulers', null, 3000).catch(function () { return []; }),
            request(config, 'SD_HOST', 'GET', '/sdapi/v1/upscalers', null, 3000).catch(function () { return []; }),
            request(config, 'SD_HOST', 'GET', '/sdapi/v1/sd-models', null, 3000).catch(function () { return []; }),
        ]);
        let options = probeResults[0];
        let samplerList = probeResults[1];
        let schedulerList = probeResults[2];
        let upscalerList = probeResults[3];
        let models = probeResults[4];
        let catalog = catalogRecords(models);
        let match = catalog.find(function (item) {
            let values = [item && item.filename, item && item.title, item && item.model_name, item && item.name].filter(Boolean).map(String);
            return values.some(isWaiCheckpoint);
        });
        let checkpoint = match ? String(match.title || match.filename || match.model_name || match.name) : '';
        let current = plain(options) && options.sd_model_checkpoint ? String(options.sd_model_checkpoint) : '';
        let exact = Boolean(match) && isWaiCheckpoint(current) && isWaiCheckpoint(checkpoint);
        return {
            online: true,
            waiAvailable: Boolean(match),
            checkpoint: exact ? checkpoint : '',
            samplers: catalogNames(samplerList, ['name', 'label']),
            schedulers: catalogNames(schedulerList, ['name', 'label']),
            upscalers: catalogNames(upscalerList, ['name', 'label']),
            models: catalogNames(catalog, ['title', 'filename', 'model_name', 'name'])
        };
    }
    catch (e) {
        return { online: false, waiAvailable: false, checkpoint: '', samplers: [], schedulers: [], upscalers: [], models: [] };
    }
}
export function publicJob(job: WebUIJob) {
    const available = job.status === 'succeeded' && Boolean(job.result?.length);
    const seed = typeof job.metadata.seed === 'number' && Number.isSafeInteger(job.metadata.seed) && job.metadata.seed >= 0 ? job.metadata.seed : job.input.seed;
    return { id: job.id, status: job.status, provider: job.provider, seed, resultAvailable: available, resultUrl: available ? '/api/generation/jobs/' + encodeURIComponent(job.id) + '/result' : null, metadata: Object.assign({}, job.metadata, { provider: job.provider }), error: job.error || null, code: job.code || null };
}
export function createWebUIJob(config: GenerationConfig, input: GenerationInput, ownerId: string, options: { start?: boolean } = {}) {
    input = structuredClone(input);
    let id = crypto.randomBytes(18).toString('hex');
    let webJob: WebUIJob = { id: id, owner: ownerId, input: input, provider: 'webui', status: 'queued', result: null, error: null, code: null, metadata: { engine: 'sd', provider: 'webui', id: id, modelId: input.modelId, profileId: input.profile, loras: freezeLoras(input.loras), loraId: input.loras[0] && input.loras[0].id || null, loraStrength: input.loras[0]?.strength ?? null, width: input.width, height: input.height, steps: input.steps, cfg: input.cfg, sampler: input.sampler, scheduler: input.scheduler, seed: input.seed, hiresFix: Boolean(input.hiresFix), hiresUpscaler: input.hiresFix ? input.hiresUpscaler : null, hiresScale: input.hiresFix ? input.hiresScale : null } };
    webJob.connection = { SD_HOST: String(config.SD_HOST), SD_API_AUTH: config.SD_API_AUTH };
    if (options.start !== false)
        void startWebUIJob(config, webJob);
    return webJob;
}
export function startWebUIJob(config: GenerationConfig, webJob: WebUIJob): Promise<void> {
    if (webJob.execution) return webJob.execution;
    if (webJob.status !== 'queued') return Promise.resolve();
    let input = webJob.input;
    webJob.requestAbort = new AbortController();
    webJob.status = 'running';
    let payload: Record<string, unknown> = { prompt: input.prompt, negative_prompt: input.negative, width: input.width, height: input.height, cfg_scale: input.cfg, steps: input.steps, sampler_name: input.sampler, seed: input.seed, batch_size: 1, n_iter: 1, send_images: true, save_images: false,
        override_settings: { sd_model_checkpoint: CHECKPOINT }, override_settings_restore_afterwards: true };
    if (input.webuiScheduler)
        payload.scheduler = input.webuiScheduler;
    if (input.hiresFix) {
        payload.enable_hr = true;
        payload.hr_scale = input.hiresScale;
        payload.hr_upscaler = input.hiresUpscaler;
        payload.hr_second_pass_steps = input.hiresSteps;
        payload.denoising_strength = input.denoisingStrength;
    }
    if (input.faceDetailer)
        payload.alwayson_scripts = { ADetailer: { args: [true, false, { ad_model: 'face_yolov8s.pt', ad_prompt: 'detailed eyes, clean face, character-accurate facial features', ad_negative_prompt: 'deformed face, asymmetrical eyes, cross-eyed', is_api: true }, { ad_model: 'hand_yolov8n.pt', ad_prompt: 'detailed hands, five fingers, natural fingers', ad_negative_prompt: 'extra fingers, missing fingers, fused fingers, malformed hands', is_api: true }] } };
    webJob.execution = requestJson(webJob.connection || config, 'SD_HOST', 'POST', '/sdapi/v1/txt2img', payload, 20 * 60 * 1000, webJob.requestAbort.signal).then(function (result) {
        if (webJob.status !== 'running')
            return;
        if (!plain(result) || !Array.isArray(result.images) || typeof result.images[0] !== 'string' || !result.images[0])
            throw error(502, 'SD_NO_IMAGE', 'WebUI 未返回图片');
        const image = result.images[0];
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(image) || image.length % 4 !== 0)
            throw error(502, 'SD_INVALID_IMAGE', 'WebUI 返回无效图片编码');
        webJob.result = Buffer.from(image, 'base64');
        webJob.mime = 'image/png';
        webJob.status = 'succeeded';
        let info = result.info;
        if (typeof info === 'string') {
            try {
                info = JSON.parse(info);
            }
            catch (ignore) {
                info = null;
            }
        }
        webJob.metadata.seed = plain(info) && typeof info.seed === 'number' && Number.isSafeInteger(info.seed) && info.seed >= 0 ? info.seed : input.seed;
    }).catch(function (e) { if (webJob.status === 'running') {
        webJob.status = 'failed';
        const detail = errorField(e, 'detail');
        const data = plain(detail) ? detail.data : null;
        webJob.error = plain(data) && data.error ? String(data.error) : errorMessage(e);
        webJob.code = errorCode(e) || 'WEBUI_FAILED';
    } });
    return webJob.execution;
}
