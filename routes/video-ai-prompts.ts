'use strict';

// ── 改写提示词（纯 ASCII；输出 JSON 是硬约束，逐字段规则给足）──────────────
let REWRITE_SYSTEM_PROMPT = [
  'You are an expert anime storyboard director and cinematic prompt engineer.',
  'The video model (MiniMax H3) is a natural-language model driven by initial frames and Ref2VA character reference sheets,',
  'so the shot description must describe what HAPPENS in the shot (dynamic actions, expressive gestures, camera trajectory, atmospheric motion), not static pixel details.',
  '',
  'Rewrite the given prompt into a cinematic video shot description and reply with ONLY a JSON object',
  'with exactly these keys: "prompt", "shotSize", "camera", "motion", "dialogue".',
  'No markdown, no code fences, no commentary, no extra text outside the JSON object.',
  '',
  '"prompt": 1-3 concise English sentences about the dynamic subject action, camera movement, and time progression of the shot.',
  'When multiple characters are referenced in the identity anchor (e.g. Character 1 and Character 2), clearly distinguish who performs which action or interaction.',
  'Keep the subject, outfit, scene, and lighting consistent with the input. Do not restate static identity tokens that reference sheets already lock.',
  'Do not describe composition details that the reference images already define. Focus on cinematic movement, expression transition, and atmospheric motion.',
  '"shotSize": "wide", "medium", "closeup", or null.',
  '"camera": "still", "push", "pull", "pan", or "orbit" - camera movement only when it serves the action, otherwise "still".',
  '"motion": "subtle" (breathing/blinking only), "natural" (one clear continuous action), or "expressive" (dramatic action).',
  '"dialogue": one short line the subject speaks, matching the scene language (Chinese scene -> Chinese line),',
  'at most 20 Chinese characters or 60 English characters; use "" when the shot needs no speech.',
  'If the input already describes motion or camera movement, keep and refine it; never contradict it.'
].join('\n');

let SHOT_SIZE_VALUES = ['wide', 'medium', 'closeup'];
let CAMERA_VALUES = ['still', 'push', 'pull', 'pan', 'orbit'];
let MOTION_VALUES = ['subtle', 'natural', 'expressive'];

function buildRewriteUserPrompt(value: { prompt: string; identity: string; shotSize: string|null; camera: string; motion: string; dialogue: string; }|undefined) {
  return [
    'Identity anchor (for reference only, do not restate it in the shot description): ' + (value!.identity || '(none)'),
    '',
    'Still-image prompt (what generated the first frame):',
    value!.prompt,
    '',
    'Current shot parameters: shotSize=' + (value!.shotSize || 'default')
      + ', camera=' + value!.camera + ', motion=' + value!.motion
      + (value!.dialogue ? ', dialogue=' + value!.dialogue : ''),
    '',
    'Rewrite this shot for video:'
  ].join('\n');
}

let REWRITE_BODY_KEYS = new Set(['identity', 'prompt', 'shotSize', 'camera', 'motion', 'dialogue']);

// ── 整批节奏编排（/api/video-ai/polish）────────────────────────────────
// 与逐镜 rewrite 的分工：rewrite 逐镜独立改写描述；polish 用全局视角审
// 整批镜头，只调整构图字段（景别/镜头/运动/对白），让全片有节奏——
// 景别不连续扎堆、镜头运动不全是固定、台词不连续挤爆、动作强度匹配。
// 输出按 index 对齐，字段为 null = 保持当前值，绝不改动描述本身。
let POLISH_SYSTEM_PROMPT = [
  'You are a storyboard rhythm editor for an anime video.',
  'Review the WHOLE shot list and adjust ONLY the composition choices so the sequence has rhythm and variety.',
  '',
  'Reply with ONLY a JSON object: {"shots":[{"index":0,"shotSize":null,"camera":null,"motion":null,"dialogue":null}, ...]}',
  'with exactly one entry per shot, in the same order. No markdown, no commentary.',
  '',
  'Rules:',
  '- Only set a field when you have a concrete reason; null keeps the current value.',
  '- "shotSize": "wide" | "medium" | "closeup" - avoid long runs of the same size; open scenes wide, emotional beats closeup.',
  '- "camera": "still" | "push" | "pull" | "pan" | "orbit" - avoid every shot being "still"; camera movement must serve the action described.',
  '- "motion": "subtle" | "natural" | "expressive" - match the action intensity in the description.',
  '- "dialogue": a short line (at most 20 Chinese characters); thin out dialogue when too many consecutive shots have lines; use "" when silence is better.',
  '- NEVER change the shot description (prompt) itself, NEVER contradict explicit actions in the descriptions, NEVER invent new characters.',
  '- If the whole list is already well varied, set every field to null (keep all).'
].join('\n');

let MAX_POLISH_SHOTS = 30;

function validatePolishBody(body: any) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error:'请求体必须是 JSON 对象' };
  }
  let identity = String(body.identity || '').trim().slice(0, 600);
  if (!Array.isArray(body.shots) || body.shots.length < 2 || body.shots.length > MAX_POLISH_SHOTS) {
    return { error:'分镜数量需为 2—' + MAX_POLISH_SHOTS };
  }
  let shots = [];
  for (let i = 0; i < body.shots.length; i += 1) {
    let shot = body.shots[i];
    if (!shot || typeof shot !== 'object' || Array.isArray(shot)) {
      return { error:'第 ' + (i + 1) + ' 个分镜必须是对象' };
    }
    let prompt = String(shot.prompt || '').trim();
    if (!prompt || prompt.length > 4000) return { error:'第 ' + (i + 1) + ' 个分镜描述需为 1—4000 字符' };
    let shotSize = shot.shotSize === null || shot.shotSize === undefined || shot.shotSize === ''
      ? null
      : String(shot.shotSize);
    if (shotSize !== null && SHOT_SIZE_VALUES.indexOf(shotSize) === -1) {
      return { error:'第 ' + (i + 1) + ' 个分镜景别不支持' };
    }
    let camera = String(shot.camera || 'still');
    if (CAMERA_VALUES.indexOf(camera) === -1) return { error:'第 ' + (i + 1) + ' 个分镜镜头运动不支持' };
    let motion = String(shot.motion || 'subtle');
    if (MOTION_VALUES.indexOf(motion) === -1) return { error:'第 ' + (i + 1) + ' 个分镜主体运动不支持' };
    let dialogue = String(shot.dialogue || '').trim().slice(0, 300);
    shots.push({ prompt:prompt, shotSize:shotSize, camera:camera, motion:motion, dialogue:dialogue });
  }
  return { value:{ identity:identity, shots:shots } };
}

function buildPolishUserPrompt(value: { identity: string; shots: { prompt: string; shotSize: string|null; camera: string; motion: string; dialogue: string; }[]; }|undefined) {
  let lines = [
    'Identity anchor (for reference only): ' + (value!.identity || '(none)'),
    '',
    'Shot list (index | shotSize | camera | motion | dialogue | description):'
  ];
  value!.shots.forEach(function (shot, index: number) {
    lines.push((index + 1) + '. ' + (shot.shotSize || 'default') + ' | ' + shot.camera + ' | ' + shot.motion
      + ' | ' + (shot.dialogue ? JSON.stringify(shot.dialogue) : '""')
      + ' | ' + shot.prompt.slice(0, 160));
  });
  lines.push('', 'Adjust the rhythm of this shot list:');
  return lines.join('\n');
}

// 清洗编排输出：index 对齐 + 字段白名单；非法/越界条目整体跳过（保持原值）。
function cleanPolishOutput(parsed: { shots: string|any[]; }, value: { identity: string; shots: { prompt: string; shotSize: string|null; camera: string; motion: string; dialogue: string; }[]; }|undefined) {
  let out: { shotSize: string | null; camera: string | null; motion: string | null; dialogue: string | null }[] = value!.shots.map(function () {
    return { shotSize:null, camera:null, motion:null, dialogue:null };
  });
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.shots)) return out;
  for (let i = 0; i < parsed.shots.length; i += 1) {
    let item: any = parsed.shots[i];
    if (!item || typeof item !== 'object') continue;
    let index = Number(item.index);
    if (!Number.isInteger(index) || index < 0 || index >= out.length) continue;
    let entry = out[index];
    if (item.shotSize === null || item.shotSize === undefined || item.shotSize === '') {
      entry.shotSize = null;
    } else {
      let shotSize = String(item.shotSize);
      entry.shotSize = SHOT_SIZE_VALUES.indexOf(shotSize) !== -1 ? shotSize : null;
    }
    let camera = String(item.camera || '').trim();
    entry.camera = CAMERA_VALUES.indexOf(camera) !== -1 ? camera : null;
    let motion = String(item.motion || '').trim();
    entry.motion = MOTION_VALUES.indexOf(motion) !== -1 ? motion : null;
    // dialogue 语义：'' = 清空台词；合法短句 = 替换；null/undefined = 保持；超长 = 保持。
    if (item.dialogue !== null && item.dialogue !== undefined) {
      let dialogue = String(item.dialogue).trim();
      entry.dialogue = dialogue.length <= 300 ? dialogue : null;
    }
  }
  return out;
}

function validateRewriteBody(body: any) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error:'请求体必须是 JSON 对象' };
  }
  for (let key of Object.keys(body)) {
    if (!REWRITE_BODY_KEYS.has(key)) return { error:'不支持的参数：' + key };
  }
  let prompt = String(body.prompt || '').trim();
  if (!prompt || prompt.length > 4000) return { error:'画面描述需为 1—4000 字符' };
  let identity = String(body.identity || '').trim().slice(0, 600);
  let shotSize = body.shotSize === null || body.shotSize === undefined || body.shotSize === ''
    ? null
    : String(body.shotSize);
  if (shotSize !== null && SHOT_SIZE_VALUES.indexOf(shotSize) === -1) {
    return { error:'不支持的景别' };
  }
  let camera = String(body.camera || 'still');
  if (CAMERA_VALUES.indexOf(camera) === -1) return { error:'不支持的镜头运动' };
  let motion = String(body.motion || 'subtle');
  if (MOTION_VALUES.indexOf(motion) === -1) return { error:'不支持的主体运动' };
  let dialogue = String(body.dialogue || '').trim().slice(0, 300);
  return { value:{ prompt:prompt, identity:identity, shotSize:shotSize, camera:camera, motion:motion, dialogue:dialogue } };
}

export = {
  REWRITE_SYSTEM_PROMPT,
  SHOT_SIZE_VALUES,
  CAMERA_VALUES,
  MOTION_VALUES,
  buildRewriteUserPrompt,
  REWRITE_BODY_KEYS,
  POLISH_SYSTEM_PROMPT,
  MAX_POLISH_SHOTS,
  validatePolishBody,
  buildPolishUserPrompt,
  cleanPolishOutput,
  validateRewriteBody,
};
