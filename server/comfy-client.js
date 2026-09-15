'use strict';
/**
 * ComfyUI 客户端 —— 身份持久化、重启孤儿清理与缓冲式 HTTP 传输（全站唯一）。
 *
 * 2026-08-16 审计（方案 A）：client_id 持久化 + 启动清理遗留 prompt；
 * 2026-08-21：anima/video 两路由重复的清理实现收口到本文件；
 * 2026-08-27 审计：缓冲式 requestComfy/requestComfyJson 同步收口 —— 此前
 * routes/anima.js 与 routes/video/comfy.js 各持一份逐行相同拷贝，server 内部
 * 另有更旧的第三份残部（1MB 上限 / {status,data} 形状），口径互不一致。
 *
 * 背景：网关每次重启都随机生成 client_id 时，重启前提交给 ComfyUI 的任务会变成
 * 「没人认领」的孤儿——继续占 GPU、无人轮询、结果无人消费（详见 docs/audit-2026-08-16.md
 * 第九节）。方案 A：client_id 持久化（与 gateway_token 同目录），启动时清理属于
 * 本网关的遗留 prompt（定向取消，GPU 立即释放；结果本就在重启时丢失，不重收养）。
 *
 * 任何失败都静默降级（ComfyUI 未就绪/接口差异不影响网关启动；持久化失败退回
 * 随机 id，功能不受影响只是重启后无法识别旧任务）。
 */
let crypto = require('crypto');
let fs = require('fs');
let requestBuffered = require('./buffered-request').requestBuffered;
let path = require('path');
let CLIENT_ID_PATTERN = /^[a-zA-Z0-9-]{8,80}$/;
// 每次网关进程唯一；30 秒重扫不得取消本次启动新提交的任务。
let sessionId = crypto.randomBytes(16).toString('hex');
function stateDir(config) {
    if (config && config.RUNTIME && config.RUNTIME.state)
        return config.RUNTIME.state;
    if (config && config.RUNTIME_ROOT)
        return path.join(config.RUNTIME_ROOT, 'state');
    return '';
}
/** 稳定 client_id：首次生成后原子持久化（tmp+rename），此后重启复用。 */
function clientIdFor(config, namespace) {
    let dir = stateDir(config);
    let randomId = function () {
        return 'aics-' + namespace + '-' + crypto.randomBytes(12).toString('hex');
    };
    if (!dir)
        return randomId();
    let file = path.join(dir, 'comfy_client_' + namespace + '.id');
    try {
        fs.mkdirSync(dir, { recursive: true });
    }
    catch (error) {
        return randomId();
    }
    try {
        // 读已有 id（文件不存在属正常首启，不能走异常路径）。
        let existing = '';
        try {
            existing = fs.readFileSync(file, 'utf8').trim();
        }
        catch (error) {
            existing = '';
        }
        if (existing && CLIENT_ID_PATTERN.test(existing))
            return existing;
        let fresh = randomId();
        let temporary = file + '.' + process.pid + '.tmp';
        fs.writeFileSync(temporary, fresh + '\n', { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(temporary, file);
        return fresh;
    }
    catch (error) {
        // 状态目录不可写：退回随机 id。
        return randomId();
    }
}
/** 与 routes 层 serviceError 同形的最小错误工厂（server 不反向依赖 routes）。 */
function comfyError(status, code, message, detail) {
    let error = new Error(message);
    error.status = status;
    error.code = code;
    error.detail = detail;
    return error;
}
/**
 * 缓冲式 ComfyUI JSON 传输 —— 全站唯一实现（2026-08-27 审计收口：
 * 此前 anima.js 与 routes/video/comfy.js 各持一份逐行相同的拷贝，超时默认值/
 * 字节上限/错误分类口径互不一致；server 内部另有一份更旧的残部）。
 * 返回 {status,headers,body(Buffer)}，不解析 JSON；默认 10s 超时 / 2MB 上限。
 */
async function requestComfy(config, method, pathname, body, timeoutMs, maxBytes) {
    let target;
    try {
        target = new URL(config.COMFY_HOST);
    }
    catch {
        throw comfyError(502, 'COMFY_CONFIG_INVALID', 'ComfyUI 地址无效');
    }
    const rawPath = String(pathname || '/');
    const queryIndex = rawPath.indexOf('?');
    target.pathname = queryIndex >= 0 ? rawPath.slice(0, queryIndex) : rawPath;
    target.search = queryIndex >= 0 ? rawPath.slice(queryIndex) : '';
    if (method === 'POST' && rawPath === '/prompt' && body) {
        body = { ...body, extra_data: { ...body.extra_data, aics_session_id: sessionId } };
    }
    const payload = body === undefined || body === null ? null : Buffer.from(JSON.stringify(body));
    const headers = { Accept: 'application/json' };
    if (payload) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = payload.length;
    }
    return requestBuffered(target, {
        method, headers, body: payload, timeoutMs: timeoutMs || 10000, maxBytes: maxBytes || 2 * 1024 * 1024,
        makeError(kind, error) {
            if (kind === 'timeout')
                return comfyError(504, 'COMFY_TIMEOUT', 'ComfyUI 请求超时');
            if (kind === 'tooLarge')
                return comfyError(502, 'COMFY_RESPONSE_TOO_LARGE', 'ComfyUI 响应过大');
            if (kind === 'network' && error?.code)
                return error;
            return comfyError(502, 'COMFY_UNAVAILABLE', error?.message || 'ComfyUI 连接中断');
        },
    });
}
/** 缓冲请求 + JSON 解析 + 非 2xx 上抛；detail 含上游状态与可解析体（诊断面并集）。 */
async function requestComfyJson(config, method, pathname, body, timeoutMs, maxBytes) {
    const response = await requestComfy(config, method, pathname, body, timeoutMs, maxBytes || 2 * 1024 * 1024);
    let data = null;
    try {
        data = response.body.length ? JSON.parse(response.body.toString('utf8')) : null;
    }
    catch (error) {
        throw comfyError(502, 'COMFY_INVALID_RESPONSE', 'ComfyUI 返回了无效 JSON', { upstreamStatus: response.status });
    }
    if (response.status < 200 || response.status >= 300) {
        const upstream = data;
        const reason = upstream && upstream.error && (upstream.error.message || upstream.error.type);
        throw comfyError(502, 'COMFY_UPSTREAM_ERROR', 'ComfyUI 请求失败' + (reason ? '：' + String(reason).slice(0, 1000) : ''), {
            upstreamStatus: response.status,
            upstream: data,
        });
    }
    return data;
}
/** 从 ComfyUI /queue 的 running/pending 里挑出属于本网关的 prompt_id。 */
function ownedPromptIds(queue, clientId) {
    let ids = [];
    (Array.isArray(queue) ? queue : []).forEach(function (item) {
        // ComfyUI: [number, prompt_id, prompt, extra_data, outputs_to_execute]。
        if (!Array.isArray(item) || !item[1])
            return;
        let extra = item[3];
        if (extra && typeof extra === 'object' && extra.client_id === clientId
            && extra.aics_session_id !== sessionId)
            ids.push(String(item[1]));
    });
    return ids;
}
/**
 * 释放 ComfyUI 已加载模型与显存缓存（防双底模共存爆显存）。
 * ComfyUI POST /free 会设置 unload_models/free_memory 标志，worker 在
 * 当前任务结束后统一 unload_all_models + soft_empty_cache。失败静默降级，
 * 不影响出图主链路（旧版 ComfyUI / 未就绪时保持原行为）。
 */
async function unloadComfyModels(config) {
    try {
        await requestComfyJson(config, 'POST', '/free', {
            unload_models: true,
            free_memory: true
        }, 8000);
    }
    catch (error) {
        // 非致命：显存保护是尽力而为，不能因为卸载接口失败挡住出图。
    }
}
/**
 * 启动清理：取消属于本网关（client_id 匹配）但已无人跟踪的遗留任务。
 * 返回实际取消的 prompt_id 列表；任何一步失败都静默跳过。
 */
async function cancelOrphanPrompts(config, clientId) {
    let cancelled = [];
    try {
        let data = await requestComfyJson(config, 'GET', '/queue', null, 8000) || {};
        let running = data.queue_running || data.running;
        let pending = data.queue_pending || data.pending;
        let targets = ownedPromptIds(running, clientId).concat(ownedPromptIds(pending, clientId));
        for (let i = 0; i < targets.length; i += 1) {
            try {
                let response = await requestComfy(config, 'POST', '/api/jobs/' + encodeURIComponent(targets[i]) + '/cancel', null, 8000);
                if (response.status >= 200 && response.status < 300)
                    cancelled.push(targets[i]);
            }
            catch (error) {
                // 单条取消失败继续其余。
            }
        }
    }
    catch (error) {
        // ComfyUI 未就绪或接口差异：跳过清理。
    }
    return cancelled;
}
/**
 * 启动清理接线：立即 + 30s 后各试一次（网关常先于 ComfyUI 启动，重试幂等无害）。
 * anima/video 两路由曾各有一份相同实现（仅日志前缀不同），2026-08-21 收口到这里。
 * 任何失败都静默降级（见 cancelOrphanPrompts）。
 */
function sweepOrphanPromptsAfterStart(config, clientId, logLabel) {
    let run = function () {
        void cancelOrphanPrompts(config, clientId).then(function (cancelled) {
            if (cancelled.length) {
                console.warn('[' + logLabel + '] 启动清理：已取消 ' + cancelled.length + ' 个重启遗留的 ComfyUI 任务');
            }
        });
    };
    run();
    let retry = setTimeout(run, 30 * 1000);
    if (typeof retry.unref === 'function')
        retry.unref();
}
module.exports = {
    clientIdFor: clientIdFor,
    cancelOrphanPrompts: cancelOrphanPrompts,
    sweepOrphanPromptsAfterStart: sweepOrphanPromptsAfterStart,
    unloadComfyModels: unloadComfyModels,
    requestComfy: requestComfy,
    requestComfyJson: requestComfyJson,
    ownedPromptIds: ownedPromptIds,
};
