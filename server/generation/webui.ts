import crypto = require('node:crypto');
import http = require('node:http');
import https = require('node:https');
import { CHECKPOINT, MAX_UPSTREAM_JSON_BYTES } from './constants';
import { isWaiCheckpoint } from './resources';
import { error, plain } from './errors';
import { errorCode, errorMessage, errorField } from '../../scripts/lib/runtime-errors';
import type { GenerationConfig, GenerationInput, WebUIJob, WebUIStatus } from './types';
function freezeLoras(loras: GenerationInput['loras']) {
    return Object.freeze(loras.map(lora => Object.freeze({ id: lora.id, strength: lora.strength })));
}
export function requestJson(config: Pick<GenerationConfig, 'SD_HOST'>, hostKey: 'SD_HOST', method: string, pathname: string, body: unknown, timeout: number): Promise<unknown> {
    return new Promise(function (resolve, reject) {
        let target;
        try {
            target = new URL(config[hostKey]);
        }
        catch (e) {
            reject(error(502, 'UPSTREAM_CONFIG_INVALID', '上游地址无效'));
            return;
        }
        target.pathname = pathname;
        target.search = '';
        let payload = body == null ? null : Buffer.from(JSON.stringify(body));
        let client = target.protocol === 'https:' ? https : http;
        let req = client.request({ protocol: target.protocol, hostname: target.hostname, port: target.port, path: target.pathname, method: method, timeout: timeout || 10000,
            headers: Object.assign({ Accept: 'application/json' }, payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) }, function (res) {
            // 2026-08-16 审计：响应体必须设上限，防止上游（本机 SD）返回超大 JSON 时
            // 网关内存被无界撑高（之前 chunks 无限累加）；超过即掐断并按错误处理。
            let chunks: Buffer[] = [];
            let size = 0;
            res.on('data', function (c) {
                size += c.length;
                if (size > MAX_UPSTREAM_JSON_BYTES) {
                    req.destroy(error(502, 'UPSTREAM_RESPONSE_TOO_LARGE', '上游响应过大'));
                    return;
                }
                chunks.push(c);
            });
            res.on('end', function () {
                let raw = Buffer.concat(chunks).toString('utf8');
                let data;
                try {
                    data = raw ? JSON.parse(raw) : null;
                }
                catch (e) {
                    reject(error(502, 'INVALID_UPSTREAM_RESPONSE', '上游返回无效 JSON'));
                    return;
                }
                if (res.statusCode! < 200 || res.statusCode! >= 300) {
                    reject(error(502, 'UPSTREAM_ERROR', '上游请求失败', { status: res.statusCode, data: data }));
                    return;
                }
                resolve(data);
            });
        });
        req.on('error', function (e) { reject(error(502, 'UPSTREAM_UNAVAILABLE', e.message)); });
        req.on('timeout', function () { req.destroy(error(504, 'UPSTREAM_TIMEOUT', '上游请求超时')); });
        if (payload)
            req.write(payload);
        req.end();
    });
}
// 探测结果短 TTL 缓存 + 在途合并（2026-08-21 性能审计 #3）：/api/generation/status
// 与每次提交任务都调用本探测；五个请求已并行化，但无缓存时提交仍要多等一个
// 并行探测往返。默认缓存 3s；**提交路径必须传 {fresh:true} 绕过缓存**——上游刚
// 下线时路由决策必须立刻看到（否则 faceDetailer 任务会被送进注定失败的 WebUI
// 异步失败，而不是立即 503，见 test-generation-routes.js 的离线路径断言）。
const WEBUI_PROBE_TTL_MS = 3000;
/** Each service owns its cache. Fresh submission probes cannot reuse an older status request. */
export function createWebUIProbe(config: Pick<GenerationConfig, 'SD_HOST'>, request = requestJson) {
    let cached: {
        at: number;
        value: WebUIStatus;
    } | null = null;
    let pending: Promise<WebUIStatus> | null = null;
    let generation = 0;
    let hostKey = '';
    return function probe(options: {
        fresh?: boolean;
    } = {}): Promise<WebUIStatus> {
        const host = String(config.SD_HOST);
        if (host !== hostKey) {
            hostKey = host;
            cached = null;
            pending = null;
            ++generation;
        }
        if (!options.fresh && pending)
            return pending;
        if (!options.fresh && cached && Date.now() - cached.at < WEBUI_PROBE_TTL_MS)
            return Promise.resolve(cached.value);
        const token = ++generation;
        const work = doProbeWebUI({ SD_HOST: host }, request).then(value => {
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
async function doProbeWebUI(config: Pick<GenerationConfig, 'SD_HOST'>, request: typeof requestJson): Promise<WebUIStatus> {
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
    return { id: job.id, status: job.status, provider: job.provider, seed: job.input.seed, resultAvailable: Boolean(job.result), resultUrl: job.result ? '/api/generation/jobs/' + encodeURIComponent(job.id) + '/result' : null, metadata: Object.assign({}, job.metadata, { provider: job.provider }), error: job.error || null, code: job.code || null };
}
export function createWebUIJob(config: GenerationConfig, input: GenerationInput, ownerId: string) {
    let id = crypto.randomBytes(18).toString('hex');
    let webJob: WebUIJob = { id: id, owner: ownerId, input: input, provider: 'webui', status: 'running', result: null, error: null, code: null, metadata: { engine: 'sd', provider: 'webui', id: id, modelId: input.modelId, profileId: input.profile, loras: freezeLoras(input.loras), loraId: input.loras[0] && input.loras[0].id || null, loraStrength: input.loras[0] && input.loras[0].strength || null, width: input.width, height: input.height, steps: input.steps, cfg: input.cfg, sampler: input.sampler, scheduler: input.scheduler, seed: input.seed, hiresFix: Boolean(input.hiresFix), hiresUpscaler: input.hiresFix ? input.hiresUpscaler : null, hiresScale: input.hiresFix ? input.hiresScale : null } };
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
    void requestJson(config, 'SD_HOST', 'POST', '/sdapi/v1/txt2img', payload, 20 * 60 * 1000).then(function (result) {
        if (webJob.status === 'cancelled')
            return;
        if (!plain(result) || !Array.isArray(result.images) || !result.images[0])
            throw error(502, 'SD_NO_IMAGE', 'WebUI 未返回图片');
        webJob.result = Buffer.from(String(result.images[0]), 'base64');
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
        webJob.metadata.seed = plain(info) && typeof info.seed === 'number' && Number.isFinite(info.seed) ? info.seed : input.seed;
    }).catch(function (e) { if (webJob.status !== 'cancelled') {
        webJob.status = 'failed';
        const detail = errorField(e, 'detail');
        const data = plain(detail) ? detail.data : null;
        webJob.error = plain(data) && data.error ? String(data.error) : errorMessage(e);
        webJob.code = errorCode(e) || 'WEBUI_FAILED';
    } });
    return webJob;
}
