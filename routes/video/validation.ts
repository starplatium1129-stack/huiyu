'use strict';

/**
 * routes/video/validation.js —— 输入校验与归一化（单任务 + 分镜批量）。
 *
 * validateInput 同时承担三件事：
 * 1. 白名单/类型/取值域校验（fail-fast，serviceError 带 code）；
 * 2. 派生量计算（画幅、帧数、seed、输入模式 I2VA/FL2VA/L2VA）；
 * 3. 提示词组装（H3 官方三段式散文 / Wan 中文负面清单拼接）。
 * 返回冻结的规范化输入对象，是工作流构建器与服务层的唯一契约源。
 */

let crypto: typeof import('crypto') = require('crypto');
let path: typeof import('path') = require('path');
let errors: typeof import('./errors') = require('./errors');
let constants: typeof import('./constants') = require('./constants');
let prose: typeof import('./prose') = require('./prose');
let media: typeof import('./media') = require('./media');
let validationCore: typeof import('../../server/validation-core') = require('../../server/validation-core');

let serviceError = errors.serviceError;
let isPlainObject = errors.isPlainObject;
let hasOwn = errors.hasOwn;

let MAX_PROMPT_LENGTH = constants.MAX_PROMPT_LENGTH;
let MAX_NEGATIVE_LENGTH = constants.MAX_NEGATIVE_LENGTH;
let MAX_DIALOGUE_LENGTH = 300;
let MODEL_BY_ID = constants.MODEL_BY_ID;
let QUALITIES = constants.QUALITIES;
let DURATIONS = constants.DURATIONS;
let H3_EXTRA_DURATIONS = constants.H3_EXTRA_DURATIONS;
let WAN_NEGATIVE = constants.WAN_NEGATIVE;

let CAMERA = prose.CAMERA;
let MOTION = prose.MOTION;
let H3_CAMERA = prose.H3_CAMERA;
let H3_MOTION = prose.H3_MOTION;
let H3_SHOT_SIZE = prose.H3_SHOT_SIZE;
let DIALOGUE_LANGS = prose.DIALOGUE_LANGS;
let resolveDialogueLang = prose.resolveDialogueLang;
let proseCarriesCameraMention = prose.proseCarriesCameraMention;
let proseCarriesMotionMention = prose.proseCarriesMotionMention;
let H3_STYLE = prose.H3_STYLE;
let deriveH3Soundscape = prose.deriveH3Soundscape;
let deriveH3Music = prose.deriveH3Music;
let h3FrameCount = prose.h3FrameCount;

let IMAGE_INPUT_PATTERN = media.IMAGE_INPUT_PATTERN;
let IMAGE_REF_PATTERN = media.IMAGE_REF_PATTERN;
let imageInputAvailable = media.imageInputAvailable;
let readImageSize = media.readImageSize;
let imageInputRoot = media.imageInputRoot;
let fitCanvasToRatio = media.fitCanvasToRatio;

let ALLOWED_INPUT_KEYS = new Set([
  'prompt', 'negative', 'modelId', 'aspectRatio', 'duration',
  'camera', 'motion', 'seed', 'image', 'quality',
  'dialogue', 'dialogueLang', 'lastFrame', 'shotSize', 'steps', 'references', 'adultEnabled',
]);

function assertAdultAllowed(body: any, isLocal: boolean) {
  // 成人锚点正则与双门判定收口在 server/validation-core.js（2026-08-28 审计 P1-6）。
  // 视频侧成人蓝图当前 fail-closed 拒绝（storyboard.js ADULT_BLUEPRINT_UNSUPPORTED），
  // 此处仅对显式 adult prompt 做二次门控，避免前端绕过；无角色白名单（蓝图层负责）。
  // 服务端锚点（2026-08-28）：远程/隧道访问默认拒绝成人参数，请求体自报
  // adultEnabled 不再单独构成授权；AICS_ADULT_REMOTE=1 显式开启后按原门控放行。
  if (!validationCore.detectAdultIntent(body.prompt)) return;
  let remote = validationCore.evaluateAdultRemote(isLocal);
  if (remote) {
    throw serviceError(403, remote.code, remote.message);
  }
  if (body.adultEnabled !== true) {
    throw serviceError(403, 'ADULT_NOT_ENABLED', validationCore.ADULT_NOT_ENABLED_MESSAGE);
  }
}

// isLocal 缺省视为本机：内部重放路径（分镜规划/批量重试重校验）不持 req，
// 成人蓝图在 storyboard 层已 fail-closed，不受该缺省影响。
function validateInput(body: unknown, config?: unknown, options?: { isLocal: boolean; }|undefined) {
  let isLocal = !options || options.isLocal !== false;
  if (!isPlainObject(body)) throw serviceError(400, 'INVALID_BODY', '请求体必须是 JSON 对象');
  Object.keys(body).forEach(function (key) {
    if (!ALLOWED_INPUT_KEYS.has(key)) {
      throw serviceError(400, 'UNKNOWN_PARAMETER', '不支持的参数：' + key);
    }
  });
  assertAdultAllowed(body, isLocal);

  ['prompt', 'modelId', 'aspectRatio', 'duration', 'camera', 'motion'].forEach(function (key) {
    if (!hasOwn(body, key)) throw serviceError(400, 'MISSING_PARAMETER', '缺少参数：' + key);
  });
  if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > MAX_PROMPT_LENGTH) {
    throw serviceError(400, 'INVALID_PARAMETER', '画面描述需为 1—' + MAX_PROMPT_LENGTH + ' 字符');
  }
  if (body.negative !== undefined && (typeof body.negative !== 'string' || body.negative.length > MAX_NEGATIVE_LENGTH)) {
    throw serviceError(400, 'INVALID_PARAMETER', '负向描述需为不超过 ' + MAX_NEGATIVE_LENGTH + ' 字符的文本');
  }
  let model = MODEL_BY_ID[body.modelId];
  if (!model) throw serviceError(400, 'UNKNOWN_MODEL', '未知视频模型');
  if (!model.executable) throw serviceError(409, 'MODEL_ADAPTER_UNAVAILABLE', '该模型仍在适配与实测阶段');
  let isH3 = model.family === 'minimax-h3';
  let quality = body.quality === undefined || body.quality === null || body.quality === ''
    ? 'standard'
    : body.quality;
  if (typeof quality !== 'string' || !QUALITIES[quality]) {
    throw serviceError(400, 'INVALID_PARAMETER', '不支持的画质档位');
  }
  let image = body.image;
  if (image !== undefined && image !== null && image !== '') {
    // 只接受本服务上传接口写入的受控文件名，杜绝任意路径/文件名注入。
    if (typeof image !== 'string' || !IMAGE_INPUT_PATTERN.test(image)) {
      throw serviceError(400, 'INVALID_PARAMETER', '图片引用格式不受支持');
    }
    // 模型不含 image 模式时坚决拒绝：buildWanWorkflow 不会消费 first_frame，
    // 放行会导致「上传了首帧但任务静默按文字成片生成」的错误成片。
    if (!model.modes.includes('image')) {
      throw serviceError(400, 'MODEL_INPUT_MODE', '该模型不支持首帧图输入');
    }
    if (config && !imageInputAvailable(config, image)) {
      throw serviceError(400, 'INVALID_PARAMETER', '图片文件不存在或已过期');
    }
  }
  // 尾帧图（FL2VA/L2VA）：与首帧同源受控文件名校验；只允许声明了
  // first-last-frame 模式的模型（H3 原生节点 MiniMaxH3ImageToVideo 支持）。
  let lastFrame = body.lastFrame;
  if (lastFrame !== undefined && lastFrame !== null && lastFrame !== '') {
    if (typeof lastFrame !== 'string' || !IMAGE_INPUT_PATTERN.test(lastFrame)) {
      throw serviceError(400, 'INVALID_PARAMETER', '尾帧图片引用格式不受支持');
    }
    if (!model.modes.includes('first-last-frame')) {
      throw serviceError(400, 'MODEL_INPUT_MODE', '该模型不支持尾帧图输入');
    }
    if (config && !imageInputAvailable(config, lastFrame)) {
      throw serviceError(400, 'INVALID_PARAMETER', '图片文件不存在或已过期');
    }
  }
  // 参考图（Ref2VA 多参考：角色卡）。仅 H3（T8 ref_images autogrow 1-9 槽）；
  // Wan 无此链路，放行会造成「传了参考图但任务静默忽略」的错误成片。
  let references = body.references;
  if (references !== undefined && references !== null) {
    if (!isH3) throw serviceError(400, 'MODEL_INPUT_MODE', '参考图仅支持 MiniMax H3');
    if (!Array.isArray(references) || references.length < 1 || references.length > 9) {
      throw serviceError(400, 'INVALID_PARAMETER', '参考图需为 1—9 张');
    }
    for (let refIndex = 0; refIndex < references.length; refIndex += 1) {
      let refName = references[refIndex];
      if (typeof refName !== 'string' || !IMAGE_REF_PATTERN.test(refName)) {
        throw serviceError(400, 'INVALID_PARAMETER', '参考图引用格式不受支持');
      }
      if (config && !imageInputAvailable(config, refName)) {
        throw serviceError(400, 'INVALID_PARAMETER', '参考图文件不存在或已过期：' + refName);
      }
    }
  } else {
    references = null;
  }
  let hasReferences = Array.isArray(references) && references.length > 0;
  // 对白（P7）：H3 原生音画同步能力（官方 4.4 说话人 ID + <d> 原文块）；
  // Wan 等无口型链路拒绝，避免「写了台词但画面没有对白」的错误成片。
  let dialogue = body.dialogue;
  if (dialogue !== undefined && dialogue !== null && dialogue !== '') {
    if (!isH3) {
      throw serviceError(400, 'MODEL_INPUT_MODE', '对白仅支持 MiniMax H3');
    }
    if (typeof dialogue !== 'string' || !dialogue.trim() || dialogue.length > MAX_DIALOGUE_LENGTH) {
      throw serviceError(400, 'INVALID_PARAMETER', '对白需为 1—' + MAX_DIALOGUE_LENGTH + ' 字符');
    }
  }
  // 对白语言：显式指定优先，auto 按字符自动判定（假名→Japanese、CJK→Chinese、
  // 其余→English）。中文台词写中文即可走 Chinese，无需特殊处理；
  // 需要强制某语言时才传 dialogueLang。
  let dialogueLang = body.dialogueLang === undefined || body.dialogueLang === null || body.dialogueLang === ''
    ? 'auto'
    : body.dialogueLang;
  if (typeof dialogueLang !== 'string' || !DIALOGUE_LANGS[dialogueLang]) {
    throw serviceError(400, 'INVALID_PARAMETER', '对白语言仅支持 auto/zh/ja/en');
  }
  // 景别（P5 分镜字段）：H3 自然语言句；Wan 链路不接受（避免歧义）。
  let shotSize = body.shotSize === undefined || body.shotSize === null || body.shotSize === ''
    ? null
    : body.shotSize;
  if (shotSize !== null) {
    if (!isH3) {
      throw serviceError(400, 'MODEL_INPUT_MODE', '景别仅支持 MiniMax H3');
    }
    if (!H3_SHOT_SIZE[shotSize]) {
      throw serviceError(400, 'INVALID_PARAMETER', '不支持的景别');
    }
  }
  // 步数（2026-08-16 真机实测：H3 Turbo 4 步 ≈ 8 步一半耗时，fast 5s 从 130s → 80s，
  // 质量抽查可接受）。仅 H3；Wan 固定 20 步。
  let steps = body.steps === undefined || body.steps === null || body.steps === ''
    ? 8
    : body.steps;
  if (steps !== 4 && steps !== 8) {
    throw serviceError(400, 'INVALID_PARAMETER', '步数只支持 4（极速）或 8（标准）');
  }
  if (!isH3 && body.steps !== undefined && body.steps !== null && body.steps !== '') {
    throw serviceError(400, 'MODEL_INPUT_MODE', '极速步数仅支持 MiniMax H3');
  }

  let aspect;
  if (body.aspectRatio === 'original') {
    // 跟随首帧图比例：读图片真实尺寸 → 按档位面积 + 原图比例计算画布（等比例无变形）。
    if (!image) throw serviceError(400, 'INVALID_PARAMETER', '跟随原图比例需要先上传首帧图');
    if (!config) throw serviceError(400, 'INVALID_PARAMETER', '缺少图片文件上下文');
    if (!imageInputAvailable(config, image)) throw serviceError(400, 'INVALID_PARAMETER', '图片文件不存在或已过期');
    let imageSize = readImageSize(path.resolve(imageInputRoot(config), image));
    if (!imageSize || !(imageSize.width > 0) || !(imageSize.height > 0)) {
      throw serviceError(400, 'INVALID_PARAMETER', '无法解析首帧图尺寸');
    }
    aspect = fitCanvasToRatio(imageSize.width, imageSize.height, QUALITIES[quality]);
  } else {
    aspect = QUALITIES[quality].sizes[body.aspectRatio];
    if (!aspect) throw serviceError(400, 'INVALID_PARAMETER', '不支持的画面比例');
  }
  let duration = DURATIONS[body.duration];
  if (!duration && isH3 && H3_EXTRA_DURATIONS.has(body.duration)) {
    duration = { seconds:body.duration, frames:0 };
  }
  if (!duration) {
    throw serviceError(400, 'INVALID_PARAMETER', isH3 ? '时长支持 3/5/10/15 秒' : '时长只支持 3 秒或 5 秒');
  }
  if (!CAMERA[body.camera]) throw serviceError(400, 'INVALID_PARAMETER', '不支持的镜头运动');
  if (!MOTION[body.motion]) throw serviceError(400, 'INVALID_PARAMETER', '不支持的主体运动');
  let seed = body.seed;
  if (seed === undefined || seed === null || seed === '') {
    seed = crypto.randomInt(0, 0x7fffffff);
  }
  if (typeof seed !== 'number' || !Number.isSafeInteger(seed) || seed < 0 || seed > 0x7fffffff) {
    throw serviceError(400, 'INVALID_PARAMETER', 'seed 需为 0—2147483647 的整数');
  }

  let isI2va = isH3 && Boolean(image) && !lastFrame;
  let isFl2va = isH3 && Boolean(image) && Boolean(lastFrame);
  let isL2va = isH3 && !image && Boolean(lastFrame);

  // 组装前的派生量：文案自带镜头/动作意图时控制器句子让位；
  // soundscape/music 按场景信号派生（无信号回退通用模板）。
  let userPrompt = body.prompt.trim();
  let h3CameraLine = proseCarriesCameraMention(userPrompt) ? null : H3_CAMERA[body.camera];
  let h3MotionLine = proseCarriesMotionMention(userPrompt) ? null : H3_MOTION[body.motion];
  let wanCameraLine = proseCarriesCameraMention(userPrompt) ? null : CAMERA[body.camera];
  let wanMotionLine = proseCarriesMotionMention(userPrompt) ? null : MOTION[body.motion];

  // H3 景别/对白派生句（官方 4.1/4.4）：景别写成构图自然句；对白用说话人 ID
  // (S1) + <d>[语言标签] 原文</d> 块，逐字保留用户台词（不翻译不改写）。
  let h3ShotLine = shotSize === null ? null : H3_SHOT_SIZE[shotSize].line;
  let dialogueLine = dialogue
    ? ' The subject in the frame (S1) says: <d>[' + resolveDialogueLang(dialogue, dialogueLang) + '] ' + dialogue + '</d>'
    : null;

  // 参考图对齐指令（官方 base-en.txt 2.1）：I2VA 首帧 / FL2VA 首尾帧 / L2VA 尾帧，
  // 均为提示词首行 + 空行后再进三段式。
  let referenceInstruction = null;
  let h3Description;
  if (isFl2va) {
    referenceInstruction = 'How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the ' + duration.seconds.toFixed(2) + '-second mark of the target video.';
    h3Description = 'integrated_multimodal_description: [Shot 1] ' + H3_STYLE + ' — ' + userPrompt
      + ' The shot begins in the position, framing, and scene established by Picture 1 and settles into the final pose, spacing, and composition established by Picture 2 at the end of the shot.';
  } else if (isL2va) {
    referenceInstruction = 'How the reference pictures align with the target video — <Picture 1> (from [Shot 1]) aligns with the ' + duration.seconds.toFixed(2) + '-second mark of the target video.';
    h3Description = 'integrated_multimodal_description: [Shot 1] ' + H3_STYLE + ' — ' + userPrompt
      + ' The scene begins in a plausible earlier state and gradually converges to the pose, composition, lighting, and scene structure established by <Picture 1> by the end of the shot.';
  } else if (isI2va) {
    referenceInstruction = 'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.';
    h3Description = 'integrated_multimodal_description: [Shot 1] ' + H3_STYLE + ' — preserve the subject, clothing, hairstyle, and scene from <Picture 1>, then ' + userPrompt;
  } else {
    h3Description = 'integrated_multimodal_description: [Shot 1] ' + H3_STYLE + ', ' + userPrompt;
  }
  let h3Lines = [
    h3Description,
    h3ShotLine,
    h3CameraLine,
    h3MotionLine,
    dialogueLine,
    hasReferences
      ? 'Character identity anchors: ' + references.map(function (_: unknown, i: number) { return '<Picture ' + (i + 1) + '>'; }).join(', ')
        + (references.length === 1
          ? ' - the shot contains exactly one character: <Picture 1>. No other people, no reflections, no duplicate or mirrored copies.'
          : ' - each <Picture N> is a distinct character: keep every character\'s face, hairstyle, outfit and identity consistent with their own picture, and never swap or merge characters.')
      : null,
    'Character identity, clothing, lighting, and scene structure remain consistent from start to finish.',
  ].filter(function (line) { return line !== null; });
  let h3Prompt = (referenceInstruction ? [referenceInstruction, ''] : []).concat(h3Lines, [
    '',
    'overall_soundscape: ' + deriveH3Soundscape(userPrompt),
    '',
    'non_diegetic_music: ' + deriveH3Music(userPrompt),
  ]).join('\n');

  return Object.freeze({
    // H3 按官方三段式组装（MiniMax-AI/MiniMax-H3 h3-prompt-writing skill，
    // references/base-en.txt）：
    // - I2VA/FL2VA/L2VA 首行参考图对齐指令（逐字按官方模板），空一行再进三段式；
    // - [Shot 1] 开头声明整体风格（官方 4.1）；
    // - 镜头/运动写成自然句（官方 4.3）；文案已自带镜头/动作意图时不重复附加，
    //   避免「用户写推进 + 控制器默认静止」这类矛盾指令（自然语言模型对
    //   相互矛盾的指令会产生语义漂移）；
    // - 景别写成构图句（官方 4.1）；对白用 (S1) + <d> 原文块（官方 4.4）；
    // - soundscape/music 按文案场景信号派生具体声音与器乐节奏（官方 4.6/4.7），
    //   不用抽象情绪词，也不给雨夜/战场错误地配「quiet room tone」。
    prompt:isH3 ? h3Prompt : [
      userPrompt,
      wanCameraLine,
      wanMotionLine,
      '动作从开始到结束保持连续，角色身份、服装、光照和场景结构一致。',
    ].filter(function (line) { return line !== null; }).join('\n'),
    originalPrompt:userPrompt,
    // H3 是自然语言模型：负向词会污染语义，保持空；Wan 仍走中文负面清单。
    negative:isH3 ? '' : [WAN_NEGATIVE, String(body.negative || '').trim()].filter(Boolean).join('，'),
    modelId:model.id,
    aspectRatio:body.aspectRatio,
    quality:quality,
    width:aspect.width,
    height:aspect.height,
    duration:duration.seconds,
    frames:isH3 ? h3FrameCount(duration.seconds) : duration.frames,
    fps:24,
    camera:body.camera,
    motion:body.motion,
    seed:seed,
    image:image || null,
    lastFrame:lastFrame || null,
    references:references,
    dialogue:dialogue || null,
    dialogueLang:dialogueLang === 'auto' ? null : dialogueLang,
    shotSize:shotSize || null,
    steps:isH3 ? steps : 20,
    cfg:5,
  });
}

// ── 分镜批量校验（P5：POST /api/video/batches）──────────────────────────

let BATCH_BODY_KEYS = new Set(['modelId', 'aspectRatio', 'quality', 'linkLastFrame', 'steps', 'shots', 'adultEnabled']);
let BATCH_SHOT_KEYS = new Set(['prompt', 'dialogue', 'dialogueLang', 'shotSize', 'camera', 'motion', 'duration', 'seed', 'image', 'references']);
let BATCH_SHOT_DEFAULTS = Object.freeze({ camera:'still', motion:'subtle', duration:5 });

function validateBatchInput(body: unknown, config?: unknown) {
  if (!isPlainObject(body)) throw serviceError(400, 'INVALID_BODY', '请求体必须是 JSON 对象');
  Object.keys(body).forEach(function (key) {
    if (!BATCH_BODY_KEYS.has(key)) {
      throw serviceError(400, 'UNKNOWN_PARAMETER', '不支持的参数：' + key);
    }
  });
  if (typeof body.modelId !== 'string' || !MODEL_BY_ID[body.modelId]) {
    throw serviceError(400, 'UNKNOWN_MODEL', '未知视频模型');
  }
  let model = MODEL_BY_ID[body.modelId];
  if (!model.executable) throw serviceError(409, 'MODEL_ADAPTER_UNAVAILABLE', '该模型仍在适配与实测阶段');
  // 整批统一画幅与画质：拼接成片时分辨率必须一致，逐镜自由会破坏 P8 concat。
  let aspectRatio = body.aspectRatio;
  if (aspectRatio !== 'landscape' && aspectRatio !== 'portrait' && aspectRatio !== 'square') {
    throw serviceError(400, 'INVALID_PARAMETER', '分镜整批需要统一的画幅（landscape/portrait/square）');
  }
  let quality = body.quality === undefined || body.quality === null || body.quality === ''
    ? 'standard'
    : body.quality;
  if (typeof quality !== 'string' || !QUALITIES[quality]) {
    throw serviceError(400, 'INVALID_PARAMETER', '不支持的画质档位');
  }
  let linkLastFrame = body.linkLastFrame === undefined || body.linkLastFrame === null
    ? true
    : body.linkLastFrame;
  if (typeof linkLastFrame !== 'boolean') {
    throw serviceError(400, 'INVALID_PARAMETER', 'linkLastFrame 需为布尔值');
  }
  let steps = body.steps === undefined || body.steps === null || body.steps === ''
    ? 8
    : body.steps;
  if (steps !== 4 && steps !== 8) {
    throw serviceError(400, 'INVALID_PARAMETER', '步数只支持 4（极速）或 8（标准）');
  }
  if (steps === 4 && model.family !== 'minimax-h3') {
    throw serviceError(400, 'MODEL_INPUT_MODE', '极速步数仅支持 MiniMax H3');
  }
  if (!Array.isArray(body.shots) || body.shots.length < 1 || body.shots.length > constants.MAX_BATCH_SHOTS) {
    throw serviceError(400, 'INVALID_PARAMETER', '分镜数量需为 1—' + constants.MAX_BATCH_SHOTS);
  }
  let shots = body.shots.map(function (shot: any, index: number) {
    if (!isPlainObject(shot)) {
      throw serviceError(400, 'INVALID_PARAMETER', '第 ' + (index + 1) + ' 个分镜必须是对象');
    }
    Object.keys(shot).forEach(function (key) {
      if (!BATCH_SHOT_KEYS.has(key)) {
        throw serviceError(400, 'UNKNOWN_PARAMETER', '分镜不支持参数：' + key);
      }
    });
    // 单镜契约与单任务完全同源（validateInput 白名单/时长/景别/对白/图片校验）。
    // lastFrame 由服务端衔接写入，客户端不接受；validateInput 返回冻结对象，
    // 这里复制成可变副本，供 linkLastFrame 衔接时改写 image/lastFrame。
    let shotBody = Object.assign({}, BATCH_SHOT_DEFAULTS, shot, {
      modelId:model.id,
      aspectRatio:aspectRatio,
      quality:quality,
    });
    // 成人内容传输层授权随批次透传：单镜 prompt 命中 R18 词时，本机直连（adultEnabled:true）
    // 走 assertAdultAllowed 放行；远程/隧道由服务端 fail-closed 拒绝。
    if (body.adultEnabled === true) shotBody.adultEnabled = true;
    if (model.family === 'minimax-h3') shotBody.steps = steps;
    let input = Object.assign({}, validateInput(shotBody, config));
    return { input:input };
  });
  return Object.freeze({
    modelId:model.id,
    aspectRatio:aspectRatio,
    quality:quality,
    linkLastFrame:linkLastFrame,
    steps:steps,
    adultEnabled:body.adultEnabled === true,
    shots:shots,
  });
}

export = {
  ALLOWED_INPUT_KEYS:ALLOWED_INPUT_KEYS,
  validateInput:validateInput,
  validateBatchInput:validateBatchInput,
};
