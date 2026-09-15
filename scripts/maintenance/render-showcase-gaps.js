#!/usr/bin/env node
'use strict';

/**
 * scripts/maintenance/render-showcase-gaps.js — 样张缺口补齐（showcase:fill-gaps）
 *
 * 只读活跃 manifest，缺口生成到 --output 待审核候选，人工审核后另行发布。
 * 装配层与生图台 UI 完全同参（usePopularPromptAssembly 对齐）：
 *   - resolveModelProfile 解析引擎模型 profile（quality_prefix / negative_prefix 契约）
 *   - inferBlueprintDecisions 推断导演三件套（shot / lighting / composition）注入编译产物
 *   - resolveStyleRecipe 按蓝图 hint 解析风格配方（成人配方 fail-closed）
 *   - matureTokens 池（tags.json Mature 分类）与 UI 同源
 *   - TeaCache 加速（thresh 0.08）、按蓝图 recommendedSize 出图（画幅轴向契约）
 *   - 明确失败自动换 seed 重试一轮；中断保留 job ID，重跑继续查询原任务
 *   - --redo-mine: 只重出带旧版 gap-render 指纹的问题条目（provenance notes 指纹识别）
 *
 * 用法:
 *   node scripts/maintenance/render-showcase-gaps.js [--only <charId,charId>] [--concurrency <n>]
 *       --output <候选目录> [--gateway <url>] [--dry-run] [--redo-mine] [--manifest <源manifest>]
 */

const fs = require('fs');
const path = require('path');
const safety = require('../lib/generation-candidates');

const MODEL_ID = 'anima-miaomiao-v1.2';
const ENGINE = 'anima';

function resolveManifest(opts) {
  if (opts.manifest) return safety.noLinks(path.resolve(opts.manifest));
  const { resolveSceneShowcaseDir } = require('../../server/config');
  const workspace = opts.env.AI_WORKSPACE_ROOT || path.resolve(opts.root, '..', 'AI');
  const directory = resolveSceneShowcaseDir(opts.root, opts.env.SCENE_SHOWCASE_DIR, workspace);
  if (!directory) throw new Error('no source showcase manifest; supply --manifest explicitly');
  if (opts.env.SCENE_SHOWCASE_DIR) {
    const relative = path.relative(path.resolve(opts.env.SCENE_SHOWCASE_DIR), directory);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('configured SCENE_SHOWCASE_DIR unavailable; refusing fallback');
    }
  }
  return safety.noLinks(path.join(directory, 'manifest.json'));
}

function loadInputs(opts) {
  const input = safety.snapshot(opts.root, ['data/popular-characters.json', 'data/scene-blueprints.json', 'data/presets.json', 'data/tags.json']);
  const manifestFile = resolveManifest(opts);
  const bytes = fs.readFileSync(manifestFile);
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (!Array.isArray(manifest.entries)) throw new Error('source manifest must contain entries');
  input.sources.push({ path: manifestFile, bytes: bytes.length, sha256: safety.hash(bytes) });
  return { ...input, manifest, manifestFile };
}

function collectTasks(opts, input) {
  const popular = require('../../src/utils/popularContent.ts');
  const { resolveModelProfile } = require('../../src/utils/promptPolicy.ts');
  const { parsePresetCatalog } = require('../../src/utils/promptBuilderPersistence.ts');
  const { KREA_STYLE_RECIPES, resolveStyleRecipe } = require('../../src/config/kreaStyleRecipes.ts');
  const characters = popular.parsePopularCharacters(input.data['data/popular-characters.json']);
  const blueprints = popular.parseSceneBlueprints(input.data['data/scene-blueprints.json']);
  const catalog = parsePresetCatalog(input.data['data/presets.json']);
  const profile = resolveModelProfile(catalog.modelProfiles, MODEL_ID, ENGINE);
  if (!profile) throw new Error(`找不到引擎 ${ENGINE} 的模型 profile，拒绝执行`);
  const tagsData = input.data['data/tags.json'];
  const matureTokenSet = new Set(tagsData.filter(t => t.cat === 'Mature').map(t => String(t.en).trim().toLowerCase().replace(/\s+/g, '_')));
  const manifest = input.manifest;
  const have = new Set(manifest.entries.filter(e => e.type === 'popular').map(e => e.id));
  const only = opts.only ? opts.only.split(',').map(s => s.trim()).filter(Boolean) : null;
  const decisionCache = new Map();
  function decisionsOf(bp) {
    if (!decisionCache.has(bp.id)) decisionCache.set(bp.id, popular.inferBlueprintDecisions(bp));
    return decisionCache.get(bp.id);
  }
  /** 与 UI 一致的装配参数（usePopularPromptAssembly 对齐）。 */
  function buildPlan(character, bp) {
    const d = decisionsOf(bp);
    return popular.buildPopularPromptPlan({
      character,
      outfit: character.outfits.find(o => o.id === bp.outfitId) || character.outfits[0],
      blueprint: bp,
      engine: ENGINE,
      profile,
      matureTokens: matureTokenSet,
      shot: d.shot,
      lighting: d.lighting,
      composition: d.composition,
      adultEnabled: true,
      style: resolveStyleRecipe(KREA_STYLE_RECIPES, 'anima', bp, null, character, { adultEnabled: true }),
      artist: 'rella',
    });
  }
  const tasks = [];
  for (const character of characters) {
    if (only && !only.includes(character.id)) continue;
    const own = blueprints.filter(b => b.characterId === character.id);
    for (const bp of own) {
      const entryId = `pc_${character.id}_${bp.id}`;
      const existing = manifest.entries.find(e => e.id === entryId && e.type === 'popular');
      if (opts['redo-mine']) {
        // 原有指纹筛选只决定候选选择，不赋予覆盖或审核权限。
        if (!existing || !/(?:gap-render|fill-gaps 批量补齐)/.test(existing.provenance?.review?.notes || existing.provenance?.notes || '')) continue;
      } else if (have.has(entryId)) continue;
      const [w, h] = String(bp.recommendedSize || '832x1216').split('x').map(Number);
      const plan = buildPlan(character, bp);
      let prompt = plan.prompt;
      if (!prompt.includes('@rella')) prompt = `@rella, ${prompt}`;
      const baseSeed = seedFor(entryId, 1);
      tasks.push({
        key: `popular:${character.id}:${bp.id}`,
        metadata: { batch: 'popular', engine: ENGINE, characterId: character.id,
          blueprintId: bp.id, blueprintTitle: bp.title,
          outfitId: (character.outfits.find(o => o.id === bp.outfitId) || character.outfits[0])?.id,
          title: `${character.displayName} / ${bp.title}`, story: bp.description || '', category: '热门角色',
          displayName: character.displayName, rating: bp.adult ? 'R18' : 'All', adult: !!bp.adult,
          intendedEntryId: entryId, sourceManifest: input.manifestFile },
        payload: attempt => ({
          modelId: MODEL_ID, prompt, negative: plan.negative,
          width: w || 832, height: h || 1216, steps: 30,
          cfg: 4.5, teaCache: true, teaCacheThresh: 0.08,
          seed: baseSeed + (attempt - 1) * 7919,
        }),
      });
    }
  }
  return tasks;
}

function seedFor(entryId, attempt) {
  const hash = [...entryId].reduce((a, ch) => a + ch.charCodeAt(0) * 31, 0);
  return 70000000 + (hash + attempt * 7919) % 90000000;
}

async function main(args = process.argv.slice(2), deps = {}) {
  const opts = safety.parseArgs(args, { only: 'value', 'redo-mine': 'flag', manifest: 'value' }, deps.env || process.env);
  if (opts.help) return safety.help(__filename, '[--only a,b] [--redo-mine] [--manifest <source manifest>]');
  const input = loadInputs(opts);
  const tasks = collectTasks(opts, input);
  return safety.runCandidates({ opts, script: __filename, tasks, sources: input.sources, maxAttempts: 2,
    pollMs: 1500, timeoutMs: 300000, protectedPaths: [path.dirname(input.manifestFile)] }, deps);
}

module.exports = { main, loadInputs, collectTasks, seedFor };
if (require.main === module) safety.runCli(main);
