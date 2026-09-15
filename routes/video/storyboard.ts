'use strict';

/**
 * routes/video/storyboard.js —— 场景蓝图 → 剧情短片剧本引擎（纯函数 + 只读缓存）。
 *
 * 2026-08-23 立项（AGENTS.md 演进方向 #1 的第一步落地）：把「出图链路选场景点一下」
 * 的体验带到剧情短片——用户不写剧本，选一个场景蓝图（可选一句创作意图），引擎按
 * 起承转合四镜骨架派生完整镜头列表（中文镜头描述 + 台词 + 景别/镜头/运动）。
 *
 * 设计约束：
 * - 确定性纯函数，零 LLM 依赖（离线可用、可单测；LLM 增强走 video-ai.js 另行叠加）；
 * - 素材只取蓝图既有字段（description/location/action/lighting/mood/timeOfDay），
 *   台词用正则从 description 的「…」引号原样提取，不改写角色语气；
 * - 输出条目与 CreateVideoBatchShotInput 对齐（prompt/dialogue/shotSize/camera/
 *   motion/duration），直接喂现有批量编排；三段式 H3 提示词由 validation.js 组装；
 * - 成人类蓝图 fail-closed 拒绝：视频链路尚无 adultEligibility 双门控，剧本文本
 *   会直通提示词与成片，不冒险放行。
 */

let fs: typeof import('fs') = require('fs');
let path: typeof import('path') = require('path');

// 起承转合之外的片型可后续在此扩充；每型固定四镜。
let SHOT_PLAN = Object.freeze([
  { beat:'establishing', shotSize:'wide',    camera:'still', motion:'subtle', dialogue:false },
  { beat:'interaction',   shotSize:'medium',  camera:'still', motion:'natural', dialogue:true },
  { beat:'emotion',       shotSize:'closeup', camera:'push',  motion:'subtle', dialogue:true },
  { beat:'closing',       shotSize:'wide',    camera:'pull',  motion:'subtle', dialogue:false },
]);

// 首帧出图的英文构图句（Krea2 自然语言链路）：同一蓝图的散文描述按镜头景别
// 变奏，四镜首帧不雷同。身份一致性不靠首帧，由分镜的 Ref2VA 参考卡锁定。
let BEAT_FRAMING = Object.freeze({
  establishing:'Framed as a wide establishing shot of the full scene.',
  interaction:'Framed as a medium shot centered on her action.',
  emotion:'Framed as a close-up portrait of her face.',
  closing:'Framed as a wide shot as the scenery opens up.',
});

let ADULT_CATEGORIES = Object.freeze({ '成人':true, '私密写真':true });

let DIALOGUE_RE = /「([^「」]{2,80})」/g;
let TITLE_PREFIX_RE = /^【([^】]+)】/;

// 与 routes/video-ai.js 同款的 (mtimeMs,size) 失效缓存：命中时零磁盘 IO。
let blueprintCache = { mtimeMs:-1, size:-1, byId:null };

function loadBlueprints(config: { ROOT_DIR: string; }) {
  let filePath = path.join(config.ROOT_DIR, 'data', 'scene-blueprints.json');
  let stat = null;
  try { stat = fs.statSync(filePath); } catch (error) { return null; }
  if (blueprintCache.byId && blueprintCache.mtimeMs === stat.mtimeMs
    && blueprintCache.size === stat.size) {
    return blueprintCache.byId;
  }
  try {
    let parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    let list = Array.isArray(parsed && parsed.blueprints) ? parsed.blueprints : [];
    let byId = Object.create(null);
    for (let i = 0; i < list.length; i += 1) byId[list[i].id] = list[i];
    blueprintCache = { mtimeMs:stat.mtimeMs, size:stat.size, byId:byId };
    return byId;
  } catch (error) {
    return null;
  }
}

function extractDialogues(description: any) {
  let matches = String(description || '').match(DIALOGUE_RE);
  if (!matches) return [];
  return matches.slice(0, 2).map(function (raw) { return raw.slice(1, -1); });
}

function characterNameOf(blueprint: any) {
  let prefix = String(blueprint.description || '').match(TITLE_PREFIX_RE);
  if (prefix) {
    let parts = prefix[1].split('·');
    let first = parts[0].trim();
    if (first) return first;
  }
  return String(blueprint.characterId || '她');
}

// 每镜中文描述：交给 validation.js 组装三段式（文案自带动作/镜头词时控制器句
// 自动让位，见 prose.js 冲突守卫），因此这里放心写自然叙事句。
function shotPrompt(beat: string, ctx: any) {
  if (beat === 'establishing') {
    return ctx.location + '全景定场。' + ctx.timeOfDay + '，' + ctx.lighting
      + '，' + ctx.mood + '的氛围铺满画面，' + ctx.name + '的身影静静出现在场景之中。';
  }
  if (beat === 'interaction') {
    let base = ctx.name + ctx.action + '。' + ctx.intent
      ? ctx.name + ctx.action + '。'
      : ctx.name + ctx.action + '，' + ctx.mood + '的情绪在画面里流动。';
    return ctx.intent ? base + '镜头跟随她的动作：' + ctx.intent + '。' : base;
  }
  if (beat === 'emotion') {
    return '特写' + ctx.name + '的面庞，' + ctx.lighting + '在她脸上流转，'
      + ctx.mood + '的神情渐渐清晰' + (ctx.intent ? '，' + ctx.intent : '') + '。';
  }
  return '镜头缓缓拉远，' + ctx.location + '重新展开，' + ctx.timeOfDay
    + '的光线归于平静，只余' + ctx.mood + '的余韵。';
}

function buildStoryboard(blueprint: any, options: any) {
  let opts = options || {};
  let dialogues = extractDialogues(blueprint.description);
  let ctx = {
    name: characterNameOf(blueprint),
    location: String(blueprint.location || blueprint.title || '场景'),
    action: String(blueprint.action || '静静伫立'),
    lighting: String(blueprint.lighting || '柔和光线'),
    mood: String(blueprint.mood || '静谧'),
    timeOfDay: String(blueprint.timeOfDay || '白昼'),
    intent: opts.intent ? String(opts.intent).trim().slice(0, 120) : '',
  };
  let dialogueCursor = 0;
  // 首帧散文基底：蓝图 promptProse（Krea2 自然语言格式）→ 缺失回退中文 description
  //（qwen3-vl 编码器同样理解）；两者皆缺则该镜不产首帧提示词（前端跳过该镜）。
  let proseBase = String(blueprint.promptProse || '').trim()
    || String(blueprint.description || '').trim();
  let shots = SHOT_PLAN.map(function (plan) {
    let dialogue = null;
    if (plan.dialogue && dialogueCursor < dialogues.length) {
      dialogue = dialogues[dialogueCursor];
      dialogueCursor += 1;
    }
    return {
      prompt: shotPrompt(plan.beat, ctx),
      dialogue: dialogue,
      shotSize: plan.shotSize,
      camera: plan.camera,
      motion: plan.motion,
      duration: 3,
      firstFramePrompt: proseBase ? proseBase + ' ' + (BEAT_FRAMING as Record<string, any>)[plan.beat] : null,
    };
  });
  return {
    title: String(blueprint.title || blueprint.id),
    blueprintId: String(blueprint.id),
    characterId: String(blueprint.characterId || ''),
    beats: SHOT_PLAN.map(function (plan) { return plan.beat; }),
    shots: shots,
  };
}

// 校验 + fail-closed 门控的唯一入口：不存在 / 数据文件不可读 / 成人类 → null + reason。
function resolveStoryboard(config: { ROOT_DIR: string; }, blueprintId: string|number, options: any) {
  if (!blueprintId || typeof blueprintId !== 'string') {
    return { error:'INVALID_PARAMETER', message:'blueprintId 需为字符串' };
  }
  let byId = loadBlueprints(config);
  let blueprint = byId ? byId[blueprintId] : null;
  if (!blueprint) return { error:'UNKNOWN_BLUEPRINT', message:'未知场景蓝图' };
  if ((ADULT_CATEGORIES as Record<string, any>)[blueprint.category]) {
    return { error:'ADULT_BLUEPRINT_UNSUPPORTED', message:'成人蓝图暂不支持自动剧本（视频链路成人门控未接入）' };
  }
  return { storyboard: buildStoryboard(blueprint, options) };
}

export = {
  SHOT_PLAN:SHOT_PLAN,
  extractDialogues:extractDialogues,
  characterNameOf:characterNameOf,
  buildStoryboard:buildStoryboard,
  resolveStoryboard:resolveStoryboard,
};
