#!/usr/bin/env node
'use strict';

/**
 * scripts/maintenance/generate-all-scenes-showcase-miaomiao.js
 *
 * 全库场景样张待审核候选生成（MiaoMiao Harem v1.6 专属正规编译版）：
 *
 * 核心特性：
 * - 提示词编译：通过 compilePromptRecipe 解析角色、当前衣装、场景和 @rella 画风
 * - 专属女主角：宁宁/夏目单人场景绑定官方 v21 LoRA (0.85 强度)
 * - 底模：MiaoMiao Harem Anima v1.6 (anima-miaomiao-v1.6)
 * - 极速画幅：832x1216 (竖版) / 1216x832 (横版)
 * - 加速机制：TeaCache（本机对照阈值 0.10，实际收益依输入而定）
 * - 存储：显式 --output 隔离目录，PNG 原图与 generation-manifest.json；不自动发布
 */

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const safety: typeof import('../lib/generation-candidates') = require('../lib/generation-candidates');
import type { CandidateOptions, CandidateTask, GenerationOptions } from '../lib/generation-types';
type Options = CandidateOptions & { character?: string; franchise?: string; limit: number; 'scenes-only'?: boolean; 'popular-only'?: boolean };
type SceneTask = {
  id: string; characterId: string; title: string; prompt: string; negative: string;
  width: number; height: number; seed: number; type?: 'popular'; standardId?: string;
  story?: string; category?: string; rating?: 'All' | 'R18'; outfitId?: string; adult?: boolean;
};
const MODEL_ID = 'anima-miaomiao-v1.6';
const PROFILE_ID = 'anima_miaomiao_v16';
const ARTIST_TAG = 'rella';

function resolveProfile(presets: unknown) {
  const { parsePresetCatalog }: typeof import('../../src/utils/modelProfileDefaults.ts') = require('../../src/utils/modelProfileDefaults.ts');
  const profile = parsePresetCatalog(presets).modelProfiles.find(item =>
    item.id === PROFILE_ID && item.model_id === MODEL_ID && item.engine === 'anima');
  if (!profile) throw new Error(`presets.json missing profile ${PROFILE_ID} for ${MODEL_ID}`);
  return profile;
}

function collectAllSceneTasks(opts: Options, input: ReturnType<typeof safety.snapshot>) {
  const popularContent: typeof import('../../src/utils/popularContent.ts') = require('../../src/utils/popularContent.ts');
  const { compilePromptRecipe }: typeof import('../../src/utils/promptRecipe.ts') = require('../../src/utils/promptRecipe.ts');
  const { showcaseSubjectGuards }: typeof import('../../src/utils/blueprintComposition.ts') = require('../../src/utils/blueprintComposition.ts');
  const promptPolicy: typeof import('../../src/utils/promptPolicy.ts') = require('../../src/utils/promptPolicy.ts');
  const { artistTagsForEngine }: typeof import('../../src/config/artistStyles.ts') = require('../../src/config/artistStyles.ts');
  const { parsePromptScenes }: typeof import('../../src/utils/promptCatalog.ts') = require('../../src/utils/promptCatalog.ts');
  const loraData: typeof import('../../data/loras.json') = require('../../data/loras.json');
  const tasks: SceneTask[] = [];
  const popularRaw = input.data['data/popular-characters.json'];
  const characters = popularContent.parsePopularCharacters(popularRaw);
  const blueprintsRaw = input.data['data/scene-blueprints.json'];
  const blueprints = popularContent.parseSceneBlueprints(blueprintsRaw);
  const profile = resolveProfile(input.data['data/presets.json']);

  // 1. 热门角色场景蓝图，沿共享入口解析绑定与导演默认值。
  if (!opts['scenes-only']) {
    for (const character of characters) {
      if (opts.franchise && character.franchise !== opts.franchise) continue;
      if (opts.character && character.id !== opts.character) continue;
      const owned = blueprints.filter(bp => bp.characterId === character.id);

      for (const bp of owned) {
        const isHorizontal = bp.recommendedSize && (bp.recommendedSize.includes('1536x1152') || bp.recommendedSize.includes('1216x832') || bp.recommendedSize.includes('1344x768'));
        const width = isHorizontal ? 1216 : 832;
        const height = isHorizontal ? 832 : 1216;

        const outfit = (bp.outfitId && popularContent.findOutfit(character, bp.outfitId)) || popularContent.defaultOutfit(character);
        const guards = showcaseSubjectGuards(bp);

        const plan = compilePromptRecipe({
          kind: 'popular',
          character,
          outfit,
          blueprint: bp,
          engine: 'anima',
          profile,
          artistTags: artistTagsForEngine([ARTIST_TAG], 'anima'),
          manual: promptPolicy.tokenize(guards.prompt),
        });

        tasks.push({
          id: bp.id,
          standardId: `pc_${character.id}_${bp.id}`,
          title: bp.title,
          story: bp.description || '',
          category: bp.category || '热门角色',
          characterId: character.id,
          rating: bp.adult ? 'R18' : 'All',
          type: 'popular',
          prompt: plan.prompt,
          negative: plan.negative,
          width,
          height,
          outfitId: outfit?.id,
          adult: Boolean(bp.adult),
          seed: Math.floor(Math.random() * 1000000000) + 100000000
        });
      }
    }
  }

  // 2. 经典主线场景 (scenes.json - 宁宁/夏目主线)
  if (!opts['popular-only'] && input.data['data/scenes.json']) {
    const scenes = parsePromptScenes(input.data['data/scenes.json']);
    for (const sc of scenes) {
      if (opts.character && sc.char !== opts.character) continue;
      if (tasks.some(t => t.id === sc.id)) continue;

      const isHorizontal = sc.recommendedSize && (sc.recommendedSize.includes('1536x1152') || sc.recommendedSize.includes('1216x832') || sc.recommendedSize.includes('1344x768'));
      const width = isHorizontal ? 1216 : 832;
      const height = isHorizontal ? 832 : 1216;

      const characterId = sc.char === 'both' ? 'triad' : sc.char || '';
      const activeLoras: Record<string, string> = characterId === 'nene' ? { nene: 'L_NENE_V21_ANIMA' }
        : characterId === 'natsume' ? { natsume: 'L_NAT_V21_ANIMA' } : {};
      const plan = compilePromptRecipe({
        kind: 'studio',
        character: characterId,
        scene: sc,
        engine: 'anima',
        profile,
        activeLoras,
        loraMeta: loraData,
        artistTags: artistTagsForEngine([ARTIST_TAG], 'anima'),
      });

      tasks.push({
        id: sc.id,
        title: sc.title,
        characterId: sc.char || 'generic',
        prompt: plan.prompt,
        negative: plan.negative,
        width,
        height,
        seed: Math.floor(Math.random() * 1000000000) + 100000000
      });
    }
  }

  if (opts.limit > 0) return tasks.slice(0, opts.limit);
  return tasks;
}

function buildPayload(task: SceneTask) {
  const payload: ReturnType<CandidateTask['payload']> = {
    modelId: MODEL_ID,
    prompt: task.prompt,
    negative: task.negative,
    width: task.width,
    height: task.height,
    steps: 30,
    cfg: 4.5,
    teaCache: true,
    teaCacheThresh: 0.10,
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

function loadInputs(opts: Options) {
  const names = ['data/popular-characters.json', 'data/scene-blueprints.json', 'data/presets.json'];
  if (fs.existsSync(safety.noLinks(path.join(opts.root, 'data/scenes.json')))) names.push('data/scenes.json');
  return safety.snapshot(opts.root, names);
}

function candidateTasks(tasks: SceneTask[]): CandidateTask[] {
  return tasks.map(task => ({
    key: task.type === 'popular' ? `popular:${task.characterId}:${task.id}` : `scene:${task.id}`,
    metadata: { batch: task.type || 'scene', engine: 'anima', characterId: task.characterId,
      blueprintId: task.type === 'popular' ? task.id : undefined,
      blueprintTitle: task.type === 'popular' ? task.title : undefined,
      sceneId: task.type === 'popular' ? undefined : task.id,
      outfitId: task.outfitId, adult: task.adult,
      title: task.title, story: task.story || '',
      category: task.category || (task.type === 'popular' ? '热门角色' : '日常'),
      rating: task.rating || 'All', checkpoint: 'miaomiaoHarem_anima16.safetensors',
      intendedEntryId: task.standardId || task.id },
    payload: () => buildPayload(task),
  }));
}

async function main(args: string[] = process.argv.slice(2), deps: GenerationOptions = {}) {
  const parsed = safety.parseArgs(args, { force: 'flag', character: 'value', franchise: 'value', limit: 'value', 'scenes-only': 'flag', 'popular-only': 'flag' });
  if (parsed.help) return safety.help(__filename, '[--force] [--scenes-only] [--popular-only] [--franchise <name>] [--character <id>] [--limit <n>]');
  const opts = { ...parsed, limit: Number(parsed.limit || 0) };
  if (!Number.isInteger(opts.limit) || opts.limit < 0) throw new Error('limit must be a non-negative integer');
  const input = loadInputs(opts);
  const tasks = candidateTasks(collectAllSceneTasks(opts, input));
  return safety.runCandidates({ opts, script: __filename, tasks, sources: input.sources }, deps);
}

if (require.main === module) safety.runCli(main);
