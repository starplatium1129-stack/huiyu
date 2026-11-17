import path = require('node:path');
import { DatabaseSync } from 'node:sqlite';
import { deflateRawSync } from 'node:zlib';
import snapshots = require('./catalog-snapshot');
import anima = require('./generation/anima-model-catalog');
import adapters from '../../tools/inference/adapter-models.json';
import { compilePromptRecipe, type PromptRecipe } from '../../src/utils/promptRecipe.ts';
import { parsePopularCharacter, parseSceneBlueprint, defaultOutfit, findOutfit } from '../../src/utils/popularContent.ts';
import { parsePromptScenes, parsePromptLoras } from '../../src/utils/promptCatalog.ts';
import { parsePresetCatalog } from '../../src/utils/modelProfileDefaults.ts';
import { parseScenePromptLoras, resolveModelProfile } from '../../src/utils/promptPolicy.ts';
import { sceneRecommendedSize } from '../../src/utils/sceneInference.ts';
import { renderMossDrawingPrompt } from '../../src/utils/mossPrompt.ts';
import { OUTFIT_BUNDLES } from '../../src/composables/scene/useDirectorCatalog.ts';
import { closestSceneSize } from './scene-repair-content';
import presets from '../../data/presets.json';

const { endfieldAnimaBinding } = require('../../src/utils/loraCatalog.ts') as {
  endfieldAnimaBinding: (id: string, family: string, model: string) =>
    { character: string; loraId: string; loraStrength: number } | null;
};

type Row = NonNullable<ReturnType<typeof snapshots.read>>[number];
const ANIMA = 'anima-miaomiao-v1.6';
const MOSS = adapters.models['moss-miaomiao-base-v1.1'];

const WARDROBE = OUTFIT_BUNDLES.map(outfit => ({ ...outfit, key: `studio/${outfit.id}` }));
type Binding = { character: string; loraId: string; loraStrength: number };

// Store exact compiler output. A scene and its alternate outfits share a
// compression dictionary, and a request reads only the selected two rows.
export function stageRemoteSceneRecipes(root: string, gateway: string, rows: Row[]) {
  const profile = resolveModelProfile(parsePresetCatalog(presets).modelProfiles, ANIMA, 'anima');
  if (!profile || profile.model_id !== ANIMA) throw Error('远程场景缺少 MiaoMiao 1.6 编译配置');
  const loras = rows.find(row => row.kind === 'document' && row.id === 'loras');
  if (!loras) throw Error('远程场景缺少 LoRA 目录');
  const loraMeta = parsePromptLoras(loras.data);
  const characters = new Map(rows.filter(row => row.kind === 'character').map(row => [row.id, row]));
  const outfits = new Map<string, Row[]>();
  for (const row of rows) {
    if (row.kind !== 'outfit') continue;
    const group = outfits.get(row.data.characterId) ?? [];
    group.push(row);
    outfits.set(row.data.characterId, group);
  }
  const popular = new Map([...outfits].map(([id, wardrobe]) => [id, parsePopularCharacter({
    ...characters.get(id)?.data.popular, id, outfits: wardrobe.map(item => item.data.outfit),
  })]));
  const model = anima.MODELS[ANIMA];
  function bytes(recipe: PromptRecipe, desired: string, sources: string[][], binding: Binding | null = null) {
    const size = desired.replace('×', 'x');
    const [width, height] = closestSceneSize(model.sizes, size).split('x').map(Number);
    const [mossWidth, mossHeight] = closestSceneSize(MOSS.sizes, size).split('x').map(Number);
    const renderAnima = (input: PromptRecipe) => {
      const { prompt, negative } = compilePromptRecipe(input);
      return { prompt, negative, width, height, steps: model.steps, cfg: model.cfg, sampler: model.sampler, scheduler: model.scheduler };
    };
    const primary = renderAnima(recipe);
    const withLora = binding ? {
      ...renderAnima(recipe.kind === 'studio' ? { ...recipe, activeLoras: { [recipe.character]: binding.loraId }, loraMeta } : recipe), ...binding,
    } : null;
    const moss = compilePromptRecipe({ ...recipe, engine: 'moss', profile: null });
    const { prompt, negative } = renderMossDrawingPrompt(moss.plan, '', '', { width: mossWidth, height: mossHeight });
    if (!primary.prompt.trim() || !prompt.trim()) throw Error(`远程场景编译结果为空 ${JSON.stringify(sources)}`);
    return Buffer.from(JSON.stringify({ sources, anima: primary, animaWithLora: withLora,
      animaLoraSource: binding && recipe.kind === 'studio' ? ['document', 'loras'] : null,
      moss: { prompt, negative, width: mossWidth, height: mossHeight, steps: MOSS.steps, cfg: MOSS.cfg },
    }));
  }
  function studioBinding(character: string, weight = 0.85): Binding | null {
    const lora = Object.entries(anima.LORAS).find(([, value]) => value.character === character && value.compatibleModels.includes(ANIMA));
    if (!lora) return null;
    const [loraId, spec] = lora;
    return { character, loraId, loraStrength: Math.max(spec.minStrength, Math.min(spec.maxStrength, weight)) };
  }
  const db = new DatabaseSync(path.join(gateway, 'remote-scene-recipes.sqlite'));
  let written = 0;
  const defaultSize = profile.size || '832x1216';
  try {
    db.exec(`PRAGMA user_version = 3;
      CREATE TABLE recipes (kind TEXT NOT NULL, id TEXT NOT NULL, recipe BLOB NOT NULL,
        PRIMARY KEY (kind, id)) WITHOUT ROWID, STRICT;
      CREATE TABLE outfit_overrides (kind TEXT NOT NULL, scene TEXT NOT NULL, outfit TEXT NOT NULL, recipe BLOB NOT NULL,
        PRIMARY KEY (kind, scene, outfit)) WITHOUT ROWID, STRICT;
      CREATE TABLE studio_wardrobe (id TEXT NOT NULL PRIMARY KEY, character TEXT NOT NULL,
        title TEXT NOT NULL, terms TEXT NOT NULL, tags TEXT NOT NULL) STRICT;
      BEGIN;`);
    const insert = db.prepare('INSERT INTO recipes (kind, id, recipe) VALUES (?, ?, ?)');
    const alternate = db.prepare('INSERT INTO outfit_overrides (kind, scene, outfit, recipe) VALUES (?, ?, ?, ?)');
    const insertOutfit = db.prepare('INSERT INTO studio_wardrobe (id, character, title, terms, tags) VALUES (?, ?, ?, ?, ?)');
    for (const outfit of WARDROBE) {
      insertOutfit.run(outfit.key, outfit.character, outfit.label, [outfit.label, outfit.id, ...outfit.tags].join(' ').toLowerCase(), JSON.stringify(outfit.tags));
      const recipe: PromptRecipe = { kind: 'studio', character: outfit.character, scene: null, engine: 'anima', profile,
        outfitOverride: { tokens: outfit.tags, replaced: null },
      };
      insert.run('outfit', outfit.key, deflateRawSync(bytes(recipe, defaultSize, [['character', outfit.character]], studioBinding(outfit.character))));
    }
    for (const [id, wardrobe] of outfits) {
      const character = popular.get(id);
      if (!character) throw Error(`服装缺少角色 ${id}`);
      const binding = endfieldAnimaBinding(id, 'anima', ANIMA);
      for (const row of wardrobe) {
        const outfit = findOutfit(character, row.data.outfit.id);
        if (!outfit) throw Error(`无法编译远程服装 ${row.id}`);
        const recipe: PromptRecipe = { kind: 'popular', character, outfit, blueprint: null, outfitExplicit: true, engine: 'anima', profile };
        insert.run('outfit', row.id, deflateRawSync(bytes(recipe, defaultSize, [['character', id], ['outfit', row.id]], binding)));
      }
    }
    for (const row of rows) {
      if (row.kind === 'scene') {
        const [scene] = parsePromptScenes([row.data]);
        if (!scene || !['nene', 'natsume', 'triad', 'none'].includes(scene.char || '')) throw Error(`无法编译远程场景 ${row.id}`);
        const character = scene.char || 'none';
        const recipe: PromptRecipe = { kind: 'studio', character, scene, engine: 'anima', profile };
        const desired = sceneRecommendedSize(scene);
        const binding = studioBinding(character, parseScenePromptLoras(scene)[0]?.weight ?? undefined);
        const sources = [['scene', row.id]];
        const base = bytes(recipe, desired, sources, binding);
        insert.run(row.kind, row.id, deflateRawSync(base));
        for (const outfit of WARDROBE.filter(outfit => outfit.character === character)) {
          const replacement = bytes({ ...recipe, outfitOverride: { tokens: outfit.tags, replaced: null } }, desired, sources, binding);
          alternate.run(row.kind, row.id, outfit.key, deflateRawSync(replacement, { dictionary: base }));
        }
      } else if (row.kind === 'blueprint') {
        const blueprint = parseSceneBlueprint(row.data);
        const character = blueprint && popular.get(blueprint.characterId || '');
        const original = character && blueprint && (blueprint.outfitId ? findOutfit(character, blueprint.outfitId) : defaultOutfit(character));
        const wardrobe = character && outfits.get(character.id);
        const originalRecord = original && wardrobe?.find(item => item.data.outfit?.id === original.id);
        if (!blueprint || !character || !original || !originalRecord || !wardrobe) throw Error(`远程蓝图缺少有效的人物或服装绑定 ${row.id}`);
        const recipe: PromptRecipe = { kind: 'popular', character, outfit: original, blueprint, engine: 'anima', profile };
        const desired = blueprint.recommendedSize || defaultSize;
        const binding = endfieldAnimaBinding(character.id, 'anima', ANIMA);
        const sources = [['blueprint', row.id], ['character', character.id], ['outfit', originalRecord.id]];
        const base = bytes(recipe, desired, sources, binding);
        insert.run(row.kind, row.id, deflateRawSync(base));
        for (const target of wardrobe) {
          const outfit = findOutfit(character, target.data.outfit.id)!;
          const input = outfit.id === original.id && blueprint.adult
            ? { ...recipe, outfitOverride: outfit.tokens, outfitOverrideProse: outfit.prose }
            : { ...recipe, outfit, outfitExplicit: true };
          const replacementSources = target.id === originalRecord.id ? sources : [...sources, ['outfit', target.id]];
          const replacement = bytes(input, desired, replacementSources, binding);
          alternate.run(row.kind, row.id, target.id, deflateRawSync(replacement, { dictionary: base }));
        }
      } else {
        continue;
      }
      written++;
    }
    db.exec('COMMIT;');
  } finally {
    db.close();
  }
  if (!written) throw Error(`未生成远程场景配方 ${root}`);
  return written;
}
