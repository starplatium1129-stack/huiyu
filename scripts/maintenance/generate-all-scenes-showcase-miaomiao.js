#!/usr/bin/env node
'use strict';

/**
 * scripts/maintenance/generate-all-scenes-showcase-miaomiao.js
 *
 * 全库场景样张待审核候选生成（MiaoMiao Harem v1.2 专属正规编译版）：
 *
 * 核心特性：
 * - 提示词编译：通过 buildPopularPromptPlan 完整绑定【角色核心DNA + 专属服装 + 场景蓝图 + @rella 画风 + 防分身/Solo守护】
 * - 专属女主角：宁宁/夏目 强制绑定官方 v21 LoRA (0.85 强度) 保证 100% 角色神韵
 * - 底模：MiaoMiao Harem Anima v1.2 (anima-miaomiao-v1.2)
 * - 极速画幅：832x1216 (竖版) / 1216x832 (横版)
 * - 加速机制：TeaCache (0.08 阈值, 1.9x 加速)
 * - 存储：显式 --output 隔离目录，PNG 原图与 generation-manifest.json；不自动发布
 */

const fs = require('fs');
const path = require('path');
const safety = require('../lib/generation-candidates');
const MODEL_ID = 'anima-miaomiao-v1.2';
const PROFILE_ID = 'anima_miaomiao_v12';
const ARTIST_TAG = 'rella';

function resolveProfile(presets) {
  const profile = (presets.model_profiles || []).find(item => item.id === PROFILE_ID || item.id === 'anima_base_v10');
  if (!profile) throw new Error(`presets.json missing profile for anima`);
  return profile;
}

function collectAllSceneTasks(opts, input) {
  const popularContent = require('../../src/utils/popularContent.ts');
  const { artistTagsForEngine } = require('../../src/config/artistStyles.ts');
  const tasks = [];
  const popularRaw = input.data['data/popular-characters.json'];
  const characters = popularContent.parsePopularCharacters(popularRaw);
  const blueprintsRaw = input.data['data/scene-blueprints.json'];
  const blueprints = popularContent.parseSceneBlueprints(blueprintsRaw);
  const profile = resolveProfile(input.data['data/presets.json']);

  // 1. 热门角色场景蓝图（必须走 buildPopularPromptPlan 保证角色DNA）
  for (const character of characters) {
    if (opts.character && character.id !== opts.character) continue;
    const owned = blueprints.filter(bp => bp.characterId === character.id);

    for (const bp of owned) {
      const isHorizontal = bp.recommendedSize && (bp.recommendedSize.includes('1536x1152') || bp.recommendedSize.includes('1216x832') || bp.recommendedSize.includes('1344x768'));
      const width = isHorizontal ? 1216 : 832;
      const height = isHorizontal ? 832 : 1216;

      const outfit = (bp.outfitId && popularContent.findOutfit(character, bp.outfitId)) || popularContent.defaultOutfit(character);
      const decisions = popularContent.inferBlueprintDecisions(bp);
      const adult = Boolean(bp.adult);

      const plan = popularContent.buildPopularPromptPlan({
        character,
        outfit,
        blueprint: bp,
        engine: 'anima',
        profile,
        adultEnabled: true,
        shot: decisions.shot,
        lighting: decisions.lighting,
        composition: decisions.composition,
        artistTags: artistTagsForEngine([ARTIST_TAG], 'anima'),
      });

      if (!plan) continue;

      const cloneGuard = '(no clone:1.4), (no duplicate:1.4), (no twin:1.3), no duplicated character, no second copy, single subject only';
      const soloGuard = adult
        ? `(solo:1.5), (1girl:1.4), (single girl only:1.6), (one person only:1.6), no other person, no bystanders, ${cloneGuard}`
        : `(single girl only:1.4), (one person only:1.4), no second person, ${cloneGuard}`;

      const fullPrompt = plan.prompt.includes('\n')
        ? plan.prompt.replace('\n', `, ${soloGuard}\n`)
        : `${plan.prompt}, ${soloGuard}`;

      const bpNeg = Array.isArray(bp.negativeTokens) ? bp.negativeTokens.join(', ') : String(bp.negativeTokens || '');
      const cloneNegative = 'duplicate, clone, copy, doppelganger, twin, multiple girls, extra girl';
      const fullNegative = [plan.negative, bpNeg, cloneNegative].filter(Boolean).join(', ');

      tasks.push({
        id: bp.id,
        standardId: `pc_${character.id}_${bp.id}`,
        title: bp.title,
        story: bp.description || '',
        category: bp.category || '热门角色',
        characterId: character.id,
        rating: bp.adult || bp.rating === 'R18' ? 'R18' : (bp.rating === 'R15' ? 'R15' : 'All'),
        type: 'popular',
        prompt: fullPrompt,
        negative: fullNegative,
        width,
        height,
        outfitId: outfit?.id,
        adult,
        seed: Math.floor(Math.random() * 1000000000) + 100000000
      });
    }
  }

  // 2. 经典主线场景 (scenes.json - 宁宁/夏目主线)
  if (input.data['data/scenes.json']) {
    const scenes = input.data['data/scenes.json'];
    for (const sc of scenes) {
      if (opts.character && sc.char !== opts.character) continue;
      if (tasks.some(t => t.id === sc.id)) continue;

      const isHorizontal = sc.recommendedSize && (sc.recommendedSize.includes('1536x1152') || sc.recommendedSize.includes('1216x832') || sc.recommendedSize.includes('1344x768'));
      const width = isHorizontal ? 1216 : 832;
      const height = isHorizontal ? 832 : 1216;

      let prompt = sc.prompt || sc.title;
      if (!/@rella\b/i.test(prompt)) {
        prompt = `@rella, ${prompt}`;
      }
      const negative = sc.negative || 'worst quality, low quality, bad anatomy, blurry, watermark, duplicate, 2girls';

      tasks.push({
        id: sc.id,
        title: sc.title,
        characterId: sc.char || 'generic',
        prompt,
        negative,
        width,
        height,
        seed: Math.floor(Math.random() * 1000000000) + 100000000
      });
    }
  }

  if (opts.limit > 0) return tasks.slice(0, opts.limit);
  return tasks;
}

function buildPayload(task) {
  const payload = {
    modelId: MODEL_ID,
    prompt: task.prompt,
    negative: task.negative,
    width: task.width,
    height: task.height,
    steps: 30,
    cfg: 4.5,
    teaCache: true,
    teaCacheThresh: 0.08,
    seed: task.seed
  };

  // 专属女主角绑定官方 v21 训练 LoRA
  if (task.characterId === 'nene') {
    payload.character = 'nene';
    payload.loraId = 'L_NENE_V21_ANIMA';
    payload.loraStrength = 0.85;
  } else if (task.characterId === 'natsume') {
    payload.character = 'natsume';
    payload.loraId = 'L_NAT_V21_ANIMA';
    payload.loraStrength = 0.85;
  }

  return payload;
}

function loadInputs(opts) {
  const names = ['data/popular-characters.json', 'data/scene-blueprints.json', 'data/presets.json'];
  if (fs.existsSync(safety.noLinks(path.join(opts.root, 'data/scenes.json')))) names.push('data/scenes.json');
  return safety.snapshot(opts.root, names);
}

function candidateTasks(tasks) {
  return tasks.map(task => ({
    key: task.type === 'popular' ? `popular:${task.characterId}:${task.id}` : `scene:${task.id}`,
    metadata: { batch: task.type || 'scene', engine: 'anima', characterId: task.characterId,
      blueprintId: task.type === 'popular' ? task.id : undefined,
      blueprintTitle: task.type === 'popular' ? task.title : undefined,
      sceneId: task.type === 'popular' ? undefined : task.id,
      outfitId: task.outfitId, adult: task.adult,
      title: task.title, story: task.story || '',
      category: task.category || (task.type === 'popular' ? '热门角色' : '日常'),
      rating: task.rating || 'All', checkpoint: 'miaomiaoHarem_anima12.safetensors',
      intendedEntryId: task.standardId || task.id },
    payload: () => buildPayload(task),
  }));
}

async function main(args = process.argv.slice(2), deps = {}) {
  const opts = safety.parseArgs(args, { force: 'flag', character: 'value', limit: 'value' }, deps.env || process.env);
  if (opts.help) return safety.help(__filename, '[--force] [--character <id>] [--limit <n>]');
  opts.limit = Number(opts.limit || 0);
  if (!Number.isInteger(opts.limit) || opts.limit < 0) throw new Error('limit must be a non-negative integer');
  const input = loadInputs(opts);
  const tasks = candidateTasks(collectAllSceneTasks(opts, input));
  return safety.runCandidates({ opts, script: __filename, tasks, sources: input.sources }, deps);
}

module.exports = { main, loadInputs, collectAllSceneTasks, buildPayload, candidateTasks };
if (require.main === module) safety.runCli(main);
