'use strict';
// 2026-08-18 共享超分探测：WAI（generation.js）与 Anima（anima.js）两条 Comfy 链路
// 都通过「ESRGAN 像素级放大 + 低 denoise 二阶段」做 hires，替代潜空间放大
// （nearest-exact / bicubic 对动漫线条/脸部会产生块状噪感，这是用户反馈的「奇怪」根源）。
// 模型文件放到 <AI>/ComfyUI/models/upscale_models/，按此优先顺序探测可用者。
var fs = require('fs');
var path = require('path');
var COMFY_SUPERRES_FILES = ['4x_foolhardy_Remacri.safetensors', 'R-ESRGAN 4x+ Anime6B.pth', 'RealESRGAN_x4plus.pth'];
var SUPER_RES_UPSALERS = new Set(['Remacri', 'R-ESRGAN 4x+ Anime6B', 'R-ESRGAN 4x+']);
function safeComfyResource(config, kind, file) {
    try {
        var root = path.resolve(config.AI_WORKSPACE_ROOT || '', 'ComfyUI', 'models', kind);
    }
    catch (e) {
        return false;
    }
    var target = path.resolve(root, file);
    if (target.indexOf(root + path.sep) !== 0)
        return false;
    try {
        return fs.statSync(target).isFile();
    }
    catch (error) {
        return false;
    }
}
// 返回本机可用的 ESRGAN 超分模型文件名，或 null。
function availableSuperRes(config) {
    for (var i = 0; i < COMFY_SUPERRES_FILES.length; i++) {
        if (safeComfyResource(config, 'upscale_models', COMFY_SUPERRES_FILES[i]))
            return COMFY_SUPERRES_FILES[i];
    }
    return null;
}
module.exports = { COMFY_SUPERRES_FILES: COMFY_SUPERRES_FILES, SUPER_RES_UPSALERS: SUPER_RES_UPSALERS, availableSuperRes: availableSuperRes };
