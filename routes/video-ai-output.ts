'use strict';

let MOTION_VALUES = ['subtle', 'natural', 'expressive'];

let CAMERA_VALUES = ['still', 'push', 'pull', 'pan', 'orbit'];


let SHOT_SIZE_VALUES = ['wide', 'medium', 'closeup'];


// 宽容提取 JSON 对象：模型可能包 markdown 围栏或前后缀，取首个 { 到末个 }。
function extractJsonObject(text: string) {
  let start = text.indexOf('{');
  let end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    return null;
  }
}


// 字段清洗：枚举白名单之外一律回退输入原值；prompt 为空回退原描述，
// 保证模型输出再离谱也不会把镜头参数或描述弄坏。
function cleanRewriteOutput(parsed: { prompt: unknown; shotSize: string|null|undefined; camera: unknown; motion: unknown; dialogue: unknown; }, original: { prompt: unknown; camera: unknown; motion: unknown; }) {
  let out = {
    prompt:original.prompt,
    shotSize:null,
    camera:original.camera,
    motion:original.motion,
    dialogue:''
  };
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  let prompt = String(parsed.prompt || '').trim();
  if (prompt && prompt.length <= 4000) out.prompt = prompt;
  if (parsed.shotSize === null || parsed.shotSize === undefined || parsed.shotSize === '') {
    out.shotSize = null;
  } else {
    let shotSize = String(parsed.shotSize);
    out.shotSize = SHOT_SIZE_VALUES.indexOf(shotSize) !== -1 ? shotSize : null;
  }
  let camera = String(parsed.camera || '').trim();
  if (CAMERA_VALUES.indexOf(camera) !== -1) out.camera = camera;
  let motion = String(parsed.motion || '').trim();
  if (MOTION_VALUES.indexOf(motion) !== -1) out.motion = motion;
  let dialogue = String(parsed.dialogue || '').trim();
  if (dialogue && dialogue.length <= 300) out.dialogue = dialogue;
  return out;
}
export = { extractJsonObject, cleanRewriteOutput };
