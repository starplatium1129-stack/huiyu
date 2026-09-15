/**
 * 绫季绘境 scene and character data quality gate.
 * Run with: npm run validate
 */
const fs = require('fs');
const path = require('path');
const { isSceneId, formatSceneId, missingSceneIdRanges } = require('../lib/scene-id');
const { loadSceneShards } = require('../lib/scene-store');
const { renderedScene } = require('../lib/scene-render-contract');
const {
  adultSafetyIssues,
  auMetadataIssues,
  framingConflicts,
  gazeConflicts,
  poseConflicts,
  ratingFor,
  scenePositiveKeys,
  tokenKey
} = require('../lib/prompt-policy');
// 2026-08-15 样张视觉定级的人工评级覆盖：非 mature 场景也信任人工评级，不做 tag 反推交叉检查。
const MANUAL_SCENE_RATINGS = require('../lib/manual-scene-ratings.js');

// 数据根与 scene-store 等维护脚本同链解析：夹具经 AICS_DATA_ROOT 运行时，
// 本脚本全部数据输入（分片与 characters/presets/curation/retired/pinned）取自同一根；
// 未设置环境变量时保持仓库 data/ 的既有行为。
const dataDir = path.join(
  path.resolve(process.env.AICS_DATA_ROOT || process.env.AICS_APP_ROOT || path.join(__dirname, '..', '..')),
  'data'
);
const characterSource = path.join(dataDir, 'characters.json');
const presetSource = path.join(dataDir, 'presets.json');
const curationSource = path.join(dataDir, 'curation.json');
const retiredSource = path.join(dataDir, 'retired-scenes.json');
const pinnedSource = path.join(dataDir, 'prompt-pinned-scenes.json');
const required = [
  'id', 'title', 'category', 'story', 'storyJa', 'char', 'character', 'lora', 'emotion',
  'season', 'time', 'timeOfDay', 'tags', 'rating', 'mature', 'location', 'weather',
  'camera', 'lighting', 'usage', 'prompt', 'negative'
];
const timeValues = new Set(['morning', 'afternoon', 'sunset', 'evening', 'night', 'late_night', 'dawn', 'all_day']);
const charValues = new Set(['nene', 'natsume', 'triad']);
const ratingValues = new Set(['All', 'R15', 'R18']);
const promptTrigger = { nene: 'ayachi_nene', natsume: 'shiki_natsume' };
const promptLora = { nene: '', natsume: '' };
const driftMarkers = [
  '\u4e03\u7eea', '\u3059\u3054\u3044', '\u9b45\u9b54', '\u732b\u8033', 'Devon', '\u758f\u53f2',
  '\u94f6\u8272\u53d1\u4e1d', '\u6e7f\u900f\u7684\u94f6\u8272\u957f\u53d1', '\u7c89\u8272\u957f\u53d1', '\u7c89\u53d1'
];

function readJson(source, label, errors) {
  try {
    return JSON.parse(fs.readFileSync(source, 'utf8'));
  } catch (error) {
    errors.push(label + ' cannot be parsed: ' + error.message);
    return [];
  }
}

function hasRepeatedNgram(value, size = 12) {
  const compact = String(value || '').replace(/\s+/g, '');
  const counts = new Map();
  for (let index = 0; index <= compact.length - size; index += 1) {
    const gram = compact.slice(index, index + size);
    const count = (counts.get(gram) || 0) + 1;
    if (count >= 3) return true;
    counts.set(gram, count);
  }
  return false;
}

const errors = [];
let scenes = [];
try {
  scenes = loadSceneShards().scenes;
} catch (error) {
  errors.push('scene shards cannot be loaded: ' + error.message);
}
const characters = readJson(characterSource, 'characters.json', errors);
for (const character of Array.isArray(characters) ? characters : []) {
  if ((character.id === 'nene' || character.id === 'natsume') && character.lora?.name) {
    promptLora[character.id] = character.lora.name;
  }
}
if (!promptLora.nene || !promptLora.natsume) errors.push('characters.json must define current Nene and Natsume LoRA names');
const presetData = readJson(presetSource, 'presets.json', errors);
const curationData = readJson(curationSource, 'curation.json', errors);
const retiredData = readJson(retiredSource, 'retired-scenes.json', errors);
const pinnedData = readJson(pinnedSource, 'prompt-pinned-scenes.json', errors);
const pinnedScenes = pinnedData && pinnedData.scenes ? pinnedData.scenes : {};
const ids = new Set();

if (!Array.isArray(scenes)) errors.push('scenes.json root must be an array');

(Array.isArray(scenes) ? scenes : []).forEach((scene, index) => {
  const label = scene && scene.id ? scene.id : 'index ' + index;
  if (!scene || typeof scene !== 'object') {
    errors.push(label + ': scene must be an object');
    return;
  }

  for (const key of required) {
    const value = scene[key];
    if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) {
      errors.push(label + ': missing field ' + key);
    }
  }

  if (!isSceneId(scene.id)) errors.push(label + ': id must use canonical sc001 / sc1000 format');
  if (ids.has(scene.id)) errors.push(label + ': duplicate id');
  ids.add(scene.id);

  if (!charValues.has(scene.char)) errors.push(label + ': unknown char ' + scene.char);
  if (!timeValues.has(scene.timeOfDay)) errors.push(label + ': unknown timeOfDay ' + scene.timeOfDay);
  if (!Array.isArray(scene.character)) errors.push(label + ': character must be an array');
  if (!Array.isArray(scene.tags)) errors.push(label + ': tags must be an array');
  if (!Array.isArray(scene.usage)) errors.push(label + ': usage must be an array');
  if (typeof scene.mature !== 'boolean') errors.push(label + ': mature must be boolean');
  if (scene.recommendedSize != null) {
    if (!/^\d{3,4}×\d{3,4}$/.test(String(scene.recommendedSize))) {
      errors.push(label + ': recommendedSize must use WIDTH×HEIGHT');
    } else {
      const [width, height] = String(scene.recommendedSize).split('×').map(Number);
      if (width < 512 || height < 512) errors.push(label + ': recommendedSize must be at least 512x512');
    }
  }
  if (!ratingValues.has(scene.rating)) errors.push(label + ': rating must be All, R15, or R18');
  if (typeof scene.rating === 'string' && scene.mature !== (scene.rating === 'R18')) {
    errors.push(label + ': mature must match R18 rating');
  }
  const isPinned = Boolean(pinnedScenes[scene.id]);
  // 信任手工标记的成熟评级，不过问 tag 是否匹配；人工定级表（MANUAL_SCENE_RATINGS）与定稿场景（pinned）同样豁免。
  if (!scene.mature && !isPinned && !Object.prototype.hasOwnProperty.call(MANUAL_SCENE_RATINGS, scene.id)) {
    const expectedRating = ratingFor(scene);
    if (scene.rating !== expectedRating) errors.push(label + ': rating should be ' + expectedRating + ', found ' + scene.rating);
  }

  if (typeof scene.story === 'string' && scene.story.length < 80) {
    errors.push(label + ': story is too short (' + scene.story.length + ' < 80)');
  }
  if (typeof scene.storyJa === 'string' && !/[ぁ-んァ-ヶ]/.test(scene.storyJa)) {
    errors.push(label + ': storyJa must contain Japanese kana');
  }
  if (typeof scene.storyJa === 'string' && /[这们说没让还过进给为从吗边发经动觉样东门书车话气实间见听脸妈爱现开关窝败总紧头轻软应处]/.test(scene.storyJa)) {
    errors.push(label + ': storyJa contains likely untranslated Simplified Chinese');
  }
  if (typeof scene.storyJa === 'string' && typeof scene.story === 'string') {
    const sourceHasDialogue = scene.story.includes('「') && scene.story.includes('」');
    const japaneseHasDialogue = scene.storyJa.includes('「') && scene.storyJa.includes('」');
    if (sourceHasDialogue !== japaneseHasDialogue) errors.push(label + ': storyJa dialogue structure differs from story');
  }
  if (typeof scene.storyJa === 'string' && Array.isArray(scene.character)) {
    const japaneseHeader = scene.storyJa.split('】', 1)[0];
    if (scene.character.includes('nene') && !japaneseHeader.includes('寧々')) errors.push(label + ': storyJa header is missing Nene');
    if (scene.character.includes('natsume') && !japaneseHeader.includes('夏目')) errors.push(label + ': storyJa header is missing Natsume');
  }
  if (typeof scene.storyJa === 'string' && typeof scene.story === 'string' && scene.storyJa.length > Math.max(300, scene.story.length * 2.4)) {
    errors.push(label + ': storyJa is implausibly longer than story');
  }
  if (typeof scene.storyJa === 'string' && hasRepeatedNgram(scene.storyJa)) {
    errors.push(label + ': storyJa repeats the same 12-character text three times');
  }
  if (typeof scene.prompt === 'string' && scene.prompt.length < 100) {
    errors.push(label + ': prompt is too short (' + scene.prompt.length + ' < 100)');
  }
  if (typeof scene.prompt === 'string' && /_BREAK_/i.test(scene.prompt)) {
    errors.push(label + ': use standalone BREAK instead of _BREAK_');
  }
  if (typeof scene.prompt === 'string' && /\{[^}]+\}/.test(scene.prompt)) {
    errors.push(label + ': unresolved prompt placeholder');
  }
  const effective = renderedScene(scene);
  if (typeof scene.negative === 'string') {
    const negativeTokens = effective.negative.split(',').map(tokenKey).filter(Boolean);
    for (const token of ['text', 'watermark', 'signature', 'bad_hands', 'extra_fingers', 'missing_fingers']) {
      if (!negativeTokens.includes(token)) errors.push(label + ': negative prompt missing ' + token.replace(/_/g, ' '));
    }
    if (!isPinned) {
      if (scene.rating === 'All' && !negativeTokens.includes('nsfw')) {
        errors.push(label + ': All scene must exclude nsfw');
      }
      // 2026-08-15 用户裁定：裸体压制只在 All 评级保留；R15 与 R18 同待遇——
      // 负面不得出现 nsfw/nude/explicit（会与生成意图冲突），并须带未成年保护。
      if (scene.rating === 'R15' || scene.rating === 'R18') {
        for (const token of ['nsfw', 'nude', 'explicit']) {
          if (negativeTokens.includes(token)) errors.push(label + ': ' + scene.rating + ' negative conflicts with positive intent: ' + token);
        }
        for (const token of ['child', 'loli', 'underage']) {
          if (!negativeTokens.includes(token)) errors.push(label + ': ' + scene.rating + ' negative prompt missing ' + token);
        }
      }
      const overlap = [...scenePositiveKeys(effective)].filter((token) => negativeTokens.includes(token));
      if (overlap.length) {
        errors.push(label + ': positive/negative token overlap: ' + [...new Set(overlap)].join(', '));
      }
    }
  }
  if (!isPinned) adultSafetyIssues(effective).forEach((issue) => errors.push(label + ': ' + issue));
  framingConflicts(effective).forEach((issue) => errors.push(label + ': conflicting framing ' + issue));
  poseConflicts(effective).forEach((issue) => errors.push(label + ': conflicting pose ' + issue));
  gazeConflicts(effective).forEach((issue) => errors.push(label + ': conflicting gaze ' + issue));
  auMetadataIssues(scene).forEach((issue) => errors.push(label + ': ' + issue));
  if (Array.isArray(scene.character) && typeof scene.prompt === 'string') {
    for (const character of scene.character) {
      const trigger = promptTrigger[character];
      if (trigger && !scene.prompt.includes(trigger)) errors.push(label + ': prompt missing ' + trigger);
      const lora = promptLora[character];
      if (lora && scene.prompt.includes('<lora:') && !scene.prompt.includes('<lora:' + lora + ':') && !String(scene.lora || '').includes(lora) && !scene.prompt.includes('anima') && !scene.prompt.includes('v21')) {
        errors.push(label + ': prompt missing LoRA ' + lora);
      }
    }
  }
  if (typeof scene.story === 'string') {
    for (const marker of driftMarkers) {
      if (scene.story.includes(marker)) errors.push(label + ': stale character marker ' + marker);
    }
  }

  const includesNene = scene.char === 'nene' || (Array.isArray(scene.character) && scene.character.includes('nene'));
  const adultMarked = typeof scene.story === 'string' && (scene.story.includes('\u6210\u5e74') || /adult/i.test(scene.story.slice(0, 60)));
  if (scene.mature && includesNene && !adultMarked) errors.push(label + ': mature Nene scene must be explicitly adult');
});

const retiredRecords = retiredData && Array.isArray(retiredData.records) ? retiredData.records : [];
const retiredIds = new Set();
for (const record of retiredRecords) {
  if (!record || !isSceneId(record.id)) {
    errors.push('retired-scenes.json contains an invalid id');
    continue;
  }
  if (retiredIds.has(record.id)) errors.push('retired-scenes.json duplicate id ' + record.id);
  if (ids.has(record.id)) errors.push('retired scene is still active: ' + record.id);
  if (!record.reason) errors.push('retired scene lacks reason: ' + record.id);
  retiredIds.add(record.id);
}
for (const gap of missingSceneIdRanges(ids, retiredIds)) {
  // Work scales with recorded IDs, not with the largest supplied number.
  if (gap.count <= 20) {
    for (let number = gap.start; number <= gap.end; number++) errors.push('missing undeclared id ' + formatSceneId(number));
  } else {
    errors.push('missing undeclared ids ' + formatSceneId(gap.start) + '..' + formatSceneId(gap.end) + ' (' + gap.count + ')');
  }
}

const curatedSceneIds = curationData && Array.isArray(curationData.curatedSceneIds) ? curationData.curatedSceneIds : [];
const signatureSceneIds = curationData && Array.isArray(curationData.signatureSceneIds) ? curationData.signatureSceneIds : [];
const reviewSceneIds = curationData && Array.isArray(curationData.reviewSceneIds) ? curationData.reviewSceneIds : [];
const recommendationReasons = curationData && curationData.recommendationReasons && typeof curationData.recommendationReasons === 'object' ? curationData.recommendationReasons : {};
const searchAliases = curationData && curationData.searchAliases && typeof curationData.searchAliases === 'object' ? curationData.searchAliases : {};
const moodRails = curationData && Array.isArray(curationData.moodRails) ? curationData.moodRails : [];
if (!curatedSceneIds.length) errors.push('curation.json must define curatedSceneIds');
if (!signatureSceneIds.length) errors.push('curation.json must define signatureSceneIds');
if (!moodRails.length) errors.push('curation.json must define moodRails');
const curatedSeen = new Set();
for (const sceneId of curatedSceneIds) {
  if (curatedSeen.has(sceneId)) errors.push('curation.json duplicate curated scene: ' + sceneId);
  curatedSeen.add(sceneId);
  if (!ids.has(sceneId)) errors.push('curation.json references missing scene: ' + sceneId);
}
for (const sceneId of signatureSceneIds) {
  if (!ids.has(sceneId)) errors.push('curation.json signature references missing scene: ' + sceneId);
  if (!curatedSeen.has(sceneId)) errors.push('curation.json signature must also be curated: ' + sceneId);
  if (!String(recommendationReasons[sceneId] || '').trim()) errors.push('curation.json signature needs a recommendation reason: ' + sceneId);
}
for (const sceneId of reviewSceneIds) {
  if (!ids.has(sceneId)) errors.push('curation.json review references missing scene: ' + sceneId);
  if (curatedSeen.has(sceneId)) errors.push('curation.json scene cannot be both curated and review: ' + sceneId);
}
// personaCoreSceneIds：字段存在时核对数组、非空字符串 ID、重复项与活跃引用；
// 空数组与缺省保持兼容（首屏预算、角色覆盖等政策检查归 test-scene-shard-integrity.js）。
const personaCoreSceneIds = curationData?.personaCoreSceneIds;
if (personaCoreSceneIds !== undefined) {
  if (!Array.isArray(personaCoreSceneIds)) {
    errors.push('curation.json personaCoreSceneIds must be an array');
  } else {
    const coreSeen = new Set();
    personaCoreSceneIds.forEach((sceneId, index) => {
      if (typeof sceneId !== 'string' || !sceneId.trim()) {
        errors.push('curation.json personaCoreSceneIds[' + index + '] must be a non-empty string');
        return;
      }
      if (coreSeen.has(sceneId)) errors.push('curation.json personaCoreSceneIds[' + index + '] duplicates an earlier entry: ' + sceneId);
      coreSeen.add(sceneId);
      if (!ids.has(sceneId)) errors.push('curation.json personaCoreSceneIds[' + index + '] references missing scene: ' + sceneId);
    });
  }
}
for (const sceneId of Object.keys(recommendationReasons)) {
  if (!ids.has(sceneId)) errors.push('curation.json recommendation reason references missing scene: ' + sceneId);
}
const curationText = (scene) => [scene.id, scene.title, scene.story, scene.emotion, scene.char, scene.category, scene.season,
  scene.timeOfDay, scene.location, scene.weather, scene.camera, scene.lighting].concat(scene.tags || []).join(' ').toLowerCase();
for (const [intent, aliases] of Object.entries(searchAliases)) {
  if (!Array.isArray(aliases) || !aliases.length) {
    errors.push('curation.json search alias must be a non-empty array: ' + intent);
    continue;
  }
  const candidates = [intent].concat(aliases).map((item) => String(item).toLowerCase());
  if (!scenes.some((scene) => candidates.some((candidate) => curationText(scene).includes(candidate)))) {
    errors.push('curation.json search alias returns no scenes: ' + intent);
  }
}
for (const rail of moodRails) {
  const label = rail && rail.id ? rail.id : 'mood rail';
  if (!rail || !rail.id || !rail.title || !rail.query) {
    errors.push(label + ': curation mood rail is missing id, title, or query');
    continue;
  }
  const terms = String(rail.query).toLowerCase().split(/\s+/).filter(Boolean);
  const hasMatch = scenes.some((scene) => {
    const text = curationText(scene);
    return terms.every((term) => text.includes(term));
  });
  if (!hasMatch) errors.push(label + ': curation query returns no scenes: ' + rail.query);
}

const expectedCharacters = {
  nene: ['white_hair', 'low_twintails', 'purple_eyes', 'ahoge', 'hair_ribbon'],
  natsume: ['black_hair', 'long_hair', 'yellow_eyes', 'mole_under_eye', 'hairclip']
};
for (const [id, traits] of Object.entries(expectedCharacters)) {
  const character = Array.isArray(characters) ? characters.find((item) => item.id === id) : null;
  if (!character) {
    errors.push('characters.json missing ' + id);
    continue;
  }
  const actual = new Set((character.traits || []).map((trait) => trait.tag));
  for (const trait of traits) if (!actual.has(trait)) errors.push(id + ': missing visual trait ' + trait);
  if (!character.lora || !character.lora.name) errors.push(id + ': missing LoRA binding');

  const recommendations = character.lora && character.lora.recommended_scene;
  if (!Array.isArray(recommendations) || recommendations.length === 0) {
    errors.push(id + ': missing recommended scenes');
    continue;
  }
  for (const sceneId of recommendations) {
    const scene = scenes.find((item) => item.id === sceneId);
    if (!scene) {
      errors.push(id + ': recommended scene does not exist: ' + sceneId);
      continue;
    }
    const sceneCharacters = Array.isArray(scene.character) ? scene.character : [];
    if (scene.char !== id && !sceneCharacters.includes(id)) {
      errors.push(id + ': recommended scene belongs to another character: ' + sceneId);
    }
  }
}

const modelProfiles = presetData && Array.isArray(presetData.model_profiles) ? presetData.model_profiles : [];
const presets = presetData && Array.isArray(presetData.presets) ? presetData.presets : [];
if (!modelProfiles.length) errors.push('presets.json must define model_profiles');
if (!presets.length) errors.push('presets.json must define presets');
const profileIds = new Set();
for (const profile of modelProfiles) {
  const label = profile && profile.id ? profile.id : 'model profile';
  if (!profile || !profile.id) { errors.push('model profile missing id'); continue; }
  if (profileIds.has(profile.id)) errors.push(label + ': duplicate model profile id');
  profileIds.add(profile.id);
  if (!Array.isArray(profile.match) || !profile.match.length) errors.push(label + ': missing model match patterns');
  if (typeof profile.quality_prefix !== 'string'
    || typeof profile.negative_prefix !== 'string'
    || (profile.engine !== 'krea2' && !profile.negative_prefix.trim())) {
    errors.push(label + ': invalid prompt prefixes');
  }
  if (!profile.sampler || !Number.isFinite(Number(profile.steps)) || !Number.isFinite(Number(profile.cfg))) errors.push(label + ': invalid generation defaults');
  if (!/^\d+×\d+$/.test(profile.size || '')) errors.push(label + ': invalid output size');
}
for (const requiredProfile of ['wai_illustrious_v17', 'anima_base_v10', 'anima_aesthetic_v11', 'krea2_turbo_fp8']) {
  if (!profileIds.has(requiredProfile)) errors.push('presets.json missing model profile ' + requiredProfile);
}
const presetIds = new Set();
for (const preset of presets) {
  const label = preset && preset.id ? preset.id : 'preset';
  if (!preset || !preset.id || !preset.name) { errors.push('preset missing id or name'); continue; }
  if (presetIds.has(preset.id)) errors.push(label + ': duplicate preset id');
  presetIds.add(preset.id);
  if (!preset.sampler || !Number.isFinite(Number(preset.steps)) || !Number.isFinite(Number(preset.cfg))) errors.push(label + ': invalid generation values');
  if (!/^\d+×\d+$/.test(preset.size || '')) errors.push(label + ': invalid output size');
}

if (errors.length) {
  console.error('Scene validation failed (' + errors.length + ' issues)');
  for (const error of errors) console.error('  - ' + error);
  process.exit(1);
}

console.log('Validation passed: ' + scenes.length + ' scenes, ' + modelProfiles.length + ' model profiles, ' + presets.length + ' presets');
