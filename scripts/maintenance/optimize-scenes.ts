const { renderedScene }: typeof import('../lib/scene-render-contract') = require('../lib/scene-render-contract');
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const { loadSceneShards, writeAggregate }: typeof import('../lib/scene-store') = require('../lib/scene-store');
// 计划 006 D5：写入走增量路径，改动只落受影响分片；全量重切仍归 split-scenes。
const sceneWrite: typeof import('../lib/scene-write') = require('../lib/scene-write');
const {
  adultSafetyIssues,
  framingConflicts,
  gazeConflicts,
  poseConflicts,
  tokenKey
}: typeof import('../lib/prompt-policy') = require('../lib/prompt-policy');
const write = process.argv.includes('--write');
const check = process.argv.includes('--check');

const pinnedPath = path.resolve(process.env.AICS_DATA_ROOT || process.env.AICS_APP_ROOT
  || path.resolve(__dirname, '..', '..'), 'data', 'prompt-pinned-scenes.json');
let pinnedScenes = {};
try {
  pinnedScenes = JSON.parse(fs.readFileSync(pinnedPath, 'utf8')).scenes || {};
} catch {}

const aliases = new Map(Object.entries({
  indoor: 'indoors',
  casual_wear: 'casual_clothes',
  pouting_expression: 'pout',
  panicked_expression: 'panicked',
  cool_expression: 'serious',
  subtle_smile: 'slight_smile',
  soft_ambiance: 'soft_lighting',
  cozy_atmosphere: 'cozy',
  masterpiece_composition: 'cinematic_composition',
  cloying_affection: 'in_love',
  expressive_ahoge: 'ahoge',
  heart_shaped_ahoge: 'ahoge',
  adult_women: 'adult',
  adult_woman: 'adult',
  transparent_clothing: 'see_through_clothing',
  shirt_undone: 'unbuttoned_shirt',
  unbuttoned: 'unbuttoned_shirt',
  three_hands_joined: 'holding_hands',
  floating_tea_cup: 'floating_cup',
  floating_object: 'floating_objects',
  energy_particles: 'glowing_particles',
  digital_artifacts: 'glitch_effect',
  infinite_loop_visual: 'abstract_background'
}));

const remove = new Set(['heart_rate_synchronization', 'shared_vows', 'skin_exposure']);
const baseNegative = [
  'worst quality', 'low quality', 'normal quality', 'lowres', 'blurry', 'jpeg artifacts',
  'text', 'watermark', 'logo', 'signature', 'bad anatomy', 'bad hands', 'extra fingers',
  'missing fingers', 'fused fingers', 'extra arms', 'extra legs', 'deformed',
  'bad proportions', 'duplicate', 'cropped', '3d render', 'photorealistic'
];

function key(value: string) {
  return tokenKey(value);
}

function canonical(value: string) {
  const normalized = key(value);
  if (!normalized || remove.has(normalized)) return '';
  return aliases.get(normalized) || normalized;
}

function dedupe(values: unknown[]) {
  const seen = new Set();
  return values.filter((value: string) => {
    const normalized = key(value);
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function cameraIntent(scene: { camera: unknown; }) {
  const camera = String(scene.camera || '');
  if (/\u8fdc\u666f|\u5168\u8eab|\u5168\u666f|wide|full.?body/i.test(camera)) return 'wide';
  if (/\u7279\u5199|\u8fd1\u666f|close/i.test(camera)) return 'close';
  if (/\u4e2d\u666f|medium/i.test(camera)) return 'medium';
  return '';
}

function cameraTags(scene: { camera: unknown; }, tags: unknown) {
  const intent = cameraIntent(scene);
  let normalized = [...tags];
  if (intent === 'wide') {
    normalized = normalized.filter((tag) => !['close_up', 'face_focus', 'medium_shot', 'upper_body'].includes(key(tag)));
    normalized.push('wide_shot', 'full_body');
  } else if (intent === 'close') {
    normalized = normalized.filter((tag) => !['medium_shot', 'wide_shot', 'full_body', 'long_shot'].includes(key(tag)));
    normalized.push('close_up');
  } else if (intent === 'medium') {
    normalized = normalized.filter((tag) => !['close_up', 'face_focus', 'wide_shot', 'full_body', 'long_shot'].includes(key(tag)));
    normalized.push('medium_shot');
  }
  const set = new Set(dedupe(normalized));
  if (/\u4e3b\u89c2|pov/i.test(String(scene.camera || ''))) set.add('pov');
  return [...set];
}

function optimizePrompt(prompt: unknown) {
  const prepared = String(prompt || '')
    .replace(/\{[^}]+\}/g, '')
    .replace(/_break_/gi, 'BREAK');
  return prepared.split(/\s*,?\s*\bBREAK\b\s*,?\s*/i).map((segment) => {
    const seen = new Set();
    return segment.split(',').map((token) => {
      const trimmed = token.trim();
      const leading = trimmed.match(/^[([]/)?.[0] || '';
      const trailing = trimmed.match(/[)\]]$/)?.[0] || '';
      const bare = trimmed.replace(/^[([]/, '').replace(/[)\]]$/, '');
      if (/^<lora:/i.test(bare)) return trimmed;
      const mapped = canonical(bare);
      const mappedKey = key(mapped);
      if (!mapped || seen.has(mappedKey)) return '';
      seen.add(mappedKey);
      return leading + mapped + trailing;
    }).filter(Boolean).join(', ');
  }).filter(Boolean).join(' BREAK ');
}

function ensureAdultPrompt(prompt: string) {
  const tokens = String(prompt || '').replace(/\s+BREAK\s+.*/i, '').split(',').map(key);
  if (tokens.includes('adult')) return prompt;
  if (/^\s*(?:1girl|2girls|3girls|1woman|2women)\s*,/i.test(prompt)) {
    return prompt.replace(/^(\s*(?:1girl|2girls|3girls|1woman|2women)\s*,)/i, '$1 adult,');
  }
  return 'adult, ' + prompt;
}

function optimizePromptCamera(scene: unknown, prompt: string) {
  const intent = cameraIntent(scene);
  const blocked = intent === 'wide'
    ? new Set(['close_up', 'face_focus', 'medium_shot', 'upper_body'])
    : intent === 'close'
      ? new Set(['medium_shot', 'wide_shot', 'full_body', 'long_shot'])
      : intent === 'medium'
        ? new Set(['close_up', 'face_focus', 'wide_shot', 'full_body', 'long_shot'])
        : new Set();
  if (!blocked.size) return prompt;
  return String(prompt || '').split(/\s+BREAK\s+/i).map((segment) => segment.split(',')
    .map((item) => item.trim())
    .filter((item) => !blocked.has(key(item)))
    .join(', ')).join(' BREAK ');
}

function optimizeNegative(scene: { negative: unknown; rating: string; }) {
  const policyTokens = new Set([
    'nsfw', 'nude', 'explicit', 'child', 'loli', 'underage', 'school_uniform', 'gym_uniform'
  ]);
  const custom = String(scene.negative || '').split(',').map((item) => item.trim())
    .filter((item) => item && !policyTokens.has(key(item)));
  // 2026-08-15 用户裁定（与 classify-scene-ratings.normalizeNegative 同源）：
  // 裸体压制(nsfw/nude/explicit)只保留在 All 评级；R15 与 R18 一样剥离，
  // 并统一补未成年保护 token。R15 分支此前漏同步该裁定，导致与 classify
  // 的规范形态互相 undo（132 个场景乒乓）。
  const ratingTokens = scene.rating === 'All'
    ? ['nsfw', 'nude', 'explicit']
    : ['child', 'loli', 'underage', ...(scene.rating === 'R18' ? ['school_uniform', 'gym_uniform'] : [])];
  return dedupe([...baseNegative, ...custom, ...ratingTokens]).join(', ');
}

function optimize(scene: { id: string; auditRevision: unknown; tags: unknown; rating: string; prompt: unknown; }) {
  // Direct-vision revisions deliberately use weighted natural-language groups
  // (for example, fixed prop counts and left/right character assignments).
  // The legacy comma-token normalizer would split those groups and silently
  // undo prompts that already passed image review, so audited scenes are
  // treated as the canonical source and are only checked by validate-scenes.
  if (pinnedScenes[scene.id] || String(scene.auditRevision || '').trim()) return scene;
  let tags = dedupe((scene.tags || []).map(canonical).filter(Boolean));
  tags = cameraTags(scene, tags);
  if (scene.rating === 'R18' && !tags.includes('adult')) tags.unshift('adult');
  if (scene.id === 'sc064') tags = tags.filter((tag: string) => !['looking_at_viewer', 'looking_back'].includes(tag));
  const negative = optimizeNegative(scene);
  let prompt = optimizePrompt(scene.prompt);
  prompt = optimizePromptCamera(scene, prompt);
  if (scene.rating === 'R18') prompt = ensureAdultPrompt(prompt);
  if (scene.id === 'sc064') {
    prompt = prompt.split(',').map((item) => item.trim()).filter((item) => !['looking_at_viewer', 'looking_back'].includes(key(item))).join(', ');
  }
  return { ...scene, tags, prompt, negative };
}

const previous = loadSceneShards();
const scenes = previous.scenes;
const optimized = scenes.map(optimize);
const issues = [];
const ids = new Set();
// 门禁检查真实持久化数据，不检查优化器在内存里自动修正后的副本。
for (const scene of check ? scenes : optimized) {
  if (ids.has(scene.id)) issues.push(`${scene.id}: duplicate id`);
  ids.add(scene.id);
  if (!scene.title || !scene.story || !scene.prompt || !scene.negative) issues.push(`${scene.id}: missing required content`);
  if (/\{[^}]+\}/.test(scene.prompt)) issues.push(`${scene.id}: unresolved prompt placeholder`);
  if (scene.char === 'triad' && !scene.tags.includes('2girls')) issues.push(`${scene.id}: dual scene missing 2girls`);
  if (scene.char !== 'triad' && scene.tags.includes('2girls')) issues.push(`${scene.id}: solo scene contains 2girls`);
  const effective = renderedScene(scene);
  const isPinned = Boolean(pinnedScenes[scene.id]);
  if (!isPinned) {
    if (scene.rating === 'All' && !/(^|, )nsfw(,|$)/.test(effective.negative)) issues.push(`${scene.id}: All scene lacks nsfw exclusion`);
    if (scene.rating === 'R15' && /(^|, )nsfw(,|$)/.test(effective.negative)) issues.push(`${scene.id}: R15 negative blocks the intended suggestive rating`);
    adultSafetyIssues(effective).forEach((issue) => issues.push(`${scene.id}: ${issue}`));
  }
  framingConflicts(effective).forEach((issue) => issues.push(`${scene.id}: conflicting framing ${issue}`));
  poseConflicts(effective).forEach((issue) => issues.push(`${scene.id}: conflicting pose ${issue}`));
  gazeConflicts(effective).forEach((issue) => issues.push(`${scene.id}: conflicting gaze ${issue}`));
}

const changed = optimized.reduce((count, scene, index) => count + (JSON.stringify(scene) !== JSON.stringify(scenes[index]) ? 1 : 0), 0);
console.log(`scenes=${optimized.length} changed=${changed} issues=${issues.length}`);
issues.forEach((issue) => console.error(issue));
if (write) {
  sceneWrite.applySceneChanges(optimized, previous, { retiredIds: sceneWrite.readRetiredSceneIds() });
  writeAggregate(optimized);
}
// 可机械改写不等于有缺陷；提示词改写须独立真实渲染，不能由门禁强迫执行。
if (issues.length) process.exitCode = 1;
