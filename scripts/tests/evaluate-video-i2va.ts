#!/usr/bin/env node
'use strict';

import { PopularCharacter,SceneBlueprint } from '../../src/utils/popularContent.ts';

/* evaluate-video-i2va.js — 出图 → 图生视频端到端实测（真实 ComfyUI）。
 *
 * 流程与页面「出视频」联动一致：
 *   1) Anima 出图（角色 × 场景预设，buildPopularPromptPlan 官方组装）
 *   2) 图写入 ComfyUI/input（模拟 POST /api/video/images 的受控文件名）
 *   3) routes/video.js validateInput + buildH3Workflow（I2VA：<Picture 1> 指令 + 三段式 + Turbo 8 步）
 *   4) 提交 → 轮询 → 下载 mp4
 *
 * 用法：node scripts/tests/evaluate-video-i2va.js
 *       [--scene <blueprintId>] [--character <characterId>] [--seed <n>]
 * 默认场景：raiden_shogun_tenshukaku（天守阁内廷，非 R18）
 */

let crypto: typeof import('crypto') = require('crypto');
let fs: typeof import('fs') = require('fs');
let path: typeof import('path') = require('path');
let animaRoute: typeof import('../../routes/anima') = require('../../routes/anima');
let videoRoute: typeof import('../../routes/video') = require('../../routes/video');
let popular: typeof import('../../src/utils/popularContent.ts') = require('../../src/utils/popularContent.ts');

let ROOT = path.resolve(__dirname, '..', '..');
let AI_ROOT = path.resolve(ROOT, '..', 'AI');
let COMFY = process.env.COMFY_HOST || 'http://127.0.0.1:8188';
let OUTPUT_ROOT = path.join(AI_ROOT, 'Reviews', 'VideoI2VA', '2026-08-15');
let CLIENT_ID = 'aics-video-i2va-' + crypto.randomUUID();

function assert(condition: string|boolean|PopularCharacter|SceneBlueprint|null|undefined, message: string|undefined) { if (!condition) throw new Error(message); }
function readJson(file: string) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function flag(name: string, fallback: string) {
  let index = process.argv.indexOf('--' + name);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

function comfyUrl(pathname: string|URL) {
  let base = new URL(COMFY);
  return new URL(pathname, base).toString();
}
async function requestJson(pathname: string, options: RequestInit|undefined) {
  let response = await fetch(comfyUrl(pathname), options);
  let text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (error) {}
  if (!response.ok) throw new Error(pathname + ' returned HTTP ' + response.status + ': ' + text.slice(0, 600));
  return data;
}
async function requestMedia(image: any, expectedMimePrefix: string) {
  let query = new URLSearchParams({
    filename: String(image.filename || ''),
    subfolder: String(image.subfolder || ''),
    type: String(image.type || 'output'),
  });
  let response = await fetch(comfyUrl('/view?' + query.toString()), { cache: 'no-store' });
  let mime = String(response.headers.get('content-type') || '');
  assert(response.ok && mime.startsWith(expectedMimePrefix),
    'ComfyUI result was not ' + expectedMimePrefix + ': HTTP ' + response.status + ' ' + mime);
  let body = Buffer.from(await response.arrayBuffer());
  assert(body.length > 0, 'ComfyUI returned empty media');
  return body;
}
async function waitFor(promptId: string|number, outputNode: string, kind: string, timeoutMs?: any) {
  let deadline = Date.now() + (timeoutMs || 15 * 60 * 1000);
  while (Date.now() < deadline) {
    let history = await requestJson('/history/' + encodeURIComponent(promptId), { cache: 'no-store' });
    let entry = history && history[promptId];
    if (entry) {
      let messages = entry.status && entry.status.messages || [];
      let failed = messages.find(function (message: string[]) { return message && message[0] === 'execution_error'; });
      if (failed) throw new Error('ComfyUI execution failed: ' + JSON.stringify(failed).slice(0, 600));
      let outputs = entry.outputs && entry.outputs[outputNode] || {};
      let list = outputs.images || outputs.videos || [];
      if (Array.isArray(list) && list[0]) return list[0];
    }
    await new Promise(function (resolve) { setTimeout(resolve, 1500); });
  }
  throw new Error('ComfyUI prompt timed out: ' + promptId);
}

async function submit(workflow: any) {
  let response = await requestJson('/prompt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: CLIENT_ID }),
  });
  assert(typeof response.prompt_id === 'string' && response.prompt_id, 'ComfyUI did not return prompt_id');
  return response.prompt_id;
}

async function main() {
  let sceneId = flag('scene', 'raiden_shogun_tenshukaku');
  let characterId = flag('character', 'raiden_shogun');
  let seed = Number(flag('seed', '20260815'));

  let characters = popular.parsePopularCharacters(readJson(path.join(ROOT, 'data', 'popular-characters.json')));
  let blueprints = popular.parseSceneBlueprints(readJson(path.join(ROOT, 'data', 'scene-blueprints.json')));
  let character = characters.find(function (c) { return c.id === characterId; })!;
  let blueprint = blueprints.find(function (bp) { return bp.id === sceneId; })!;
  assert(character, 'character not found: ' + characterId);
  assert(blueprint, 'blueprint not found: ' + sceneId);

  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  console.log('场景: ' + blueprint!.title + '（' + blueprint!.id + '）');
  console.log('角色: ' + character!.displayName + '（' + character!.id + '）');

  // ── 1) Anima 出图（横图 1216x832，匹配视频画布比例） ─────────────────────
  console.log('\n[1/4] Anima 出图…');
  let built = popular.buildPopularPromptPlan({
    character: character,
    outfit: popular.defaultOutfit(character),
    blueprint: blueprint,
    engine: 'anima',
    profile: null,
    adultEnabled: true,
  });
  assert(built && built.prompt, 'buildPopularPromptPlan failed');
  let imageInput = animaRoute.validateInput({
    prompt: built!.prompt,
    negative: built!.negative || '',
    modelId: 'anima-aesthetic-v1.1',
    width: 1216,
    height: 832,
    seed: seed,
    character: null,
  });
  let imageWorkflow = animaRoute.buildWorkflow(imageInput);
  imageWorkflow['10'].inputs.filename_prefix = ['video_i2va', sceneId, 'seed-' + seed].join('/');
  let imagePromptId = await submit(imageWorkflow);
  let imageRef = await waitFor(imagePromptId, '10', 'image');
  let png = await requestMedia(imageRef, 'image/');
  let inputName = 'aics_video_input_' + crypto.randomBytes(8).toString('hex') + '.png';
  let inputDir = path.join(AI_ROOT, 'ComfyUI', 'input');
  fs.writeFileSync(path.join(inputDir, inputName), png, { flag: 'wx' });
  let firstFramePath = path.join(OUTPUT_ROOT, sceneId + '_first_frame.png');
  fs.writeFileSync(firstFramePath, png);
  console.log('  首帧图: ' + firstFramePath + '（' + (png.length / 1024).toFixed(0) + ' KB）');

  // ── 2) H3 I2VA：与页面「出视频」联动一致（composeVideoPrompt 的降级组装） ──
  console.log('[2/4] 组装 H3 I2VA 提示词…');
  let config = { AI_WORKSPACE_ROOT: AI_ROOT, ROOT_DIR: ROOT };
  // 与 VideoStudioView.composeVideoPrompt 同源：优先英文 promptProse（可直接
  // 驱动 H3 三段式），没有才回退中文结构化字段。
  let scenePrompt = (blueprint!.promptProse || '').trim()
    || [blueprint!.description, blueprint!.action, blueprint!.lighting]
      .filter(Boolean).join('，');
  console.log('  场景描述: ' + scenePrompt);
  let input = videoRoute.validateInput({
    prompt: scenePrompt,
    modelId: 'minimax-h3',
    aspectRatio: 'landscape',
    duration: 3,
    camera: 'still',
    motion: 'subtle',
    seed: seed,
    image: inputName,
  }, config);
  console.log('  I2VA 首帧指令: ' + input.prompt.split('\n')[0].slice(0, 120) + '…');
  let videoWorkflow = videoRoute.buildWorkflow(input);
  assert(videoWorkflow['17'] && videoWorkflow['17'].class_type === 'LoadImage', 'I2VA LoadImage node missing');
  assert(videoWorkflow['5'].inputs.first_frame[0] === '17', 'first_frame not wired');

  // ── 3) 提交视频任务 ───────────────────────────────────────────────────────
  console.log('[3/4] 提交 H3 I2VA（Turbo 8 步，3 秒 / 73 帧）…');
  let videoPromptId = await submit(videoWorkflow);
  let videoRef = await waitFor(videoPromptId, '11', 'video');
  let mp4 = await requestMedia(videoRef, 'video/');
  let videoPath = path.join(OUTPUT_ROOT, sceneId + '_3s.mp4');
  fs.writeFileSync(videoPath, mp4);

  // ── 4) 清理 input 首帧（与 removeJob 生命周期一致） ───────────────────────
  try { fs.unlinkSync(path.join(inputDir, inputName)); } catch (error) {}

  console.log('[4/4] 完成');
  console.log('  视频: ' + videoPath + '（' + (mp4.length / 1024 / 1024).toFixed(1) + ' MB）');
  console.log('  首帧: ' + firstFramePath);
}

main().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
