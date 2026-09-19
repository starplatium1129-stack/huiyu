import { errorMessage as runtimeErrorMessage } from '../lib/runtime-errors';
'use strict';


let fs: typeof import('fs') = require('fs');
let path: typeof import('path') = require('path');
let zlib: typeof import('zlib') = require('zlib');
let expectedDataVersion = (require('../lib/data-version') as typeof import('../lib/data-version')).expectedDataVersion;
let resolveContentRoot = (require('../lib/content-contract-root') as typeof import('../lib/content-contract-root')).resolveContentRoot;

/**
 * 数据根：AICS_DATA_ROOT || AICS_APP_ROOT || 仓库根（G11，与维护保存/store 链一致）。
 * 表示完整项目布局根（含 data/assets/src/stores）；夹具必须自备全部布局文件，
 * 缺文件按缺失报错，不回退读取生产数据。校验规则代码（popularContent /
 * kreaStyleRecipes 等 TS 模块）仍按代码仓库 require，与该根无关。
 */
let ROOT = resolveContentRoot(undefined);

/**
 * 浏览器读取 data/*.json 时带 ?v=DATA_VERSION，服务端按 immutable 缓存。
 * 这里用数据内容的稳定哈希锁定 DATA_VERSION：任何人改了 data 而忘了
 * 这里核对应用是否使用 virtual:data-version；该模块在 Vite 构建时从同一份
 * data 产物计算版本，因此维护脚本不再需要写入 sceneStore.ts。兼容旧版夹具
 * 中的数值常量校验，避免历史恢复工具失去诊断能力。
 * 哈希口径统一收口到 scripts/lib/data-version.js（与构建脚本共用）。
 */
function contentVersion() {
  return expectedDataVersion(ROOT);
}

function checkDataVersion() {
  let storeSource;
  try {
    storeSource = fs.readFileSync(path.join(ROOT, 'src', 'stores', 'sceneStore.ts'), 'utf8');
  } catch (error) {
    return ['src/stores/sceneStore.ts is missing or unreadable: ' + runtimeErrorMessage(error)];
  }
  let expected;
  try {
    expected = contentVersion();
  } catch (error) {
    return ['DATA_VERSION 计算失败（root=' + ROOT + ' 的 data/ 产物缺失或不可读）: ' + runtimeErrorMessage(error)];
  }
  if (/from\s+['"]virtual:data-version['"]/.test(storeSource)) return [];
  let match = /DATA_VERSION\s*=\s*(\d+)/.exec(storeSource);
  if (!match) return ['sceneStore.ts is missing DATA_VERSION or virtual:data-version'];
  let actual = Number(match[1]);
  if (actual !== expected) {
    return ['DATA_VERSION mismatch: sceneStore.ts has ' + actual + ', data content expects ' + expected
      + ' (旧版数值实现改过 data/*.json 后必须同步；当前源码应使用 virtual:data-version)'];
  }
  return [];
}

function readJson(relative: string) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
}

function validateContent(data: any, fileExists: any) {
  let errors: any[] = [];
  let characters: any = data.characters;
  let loras: any = data.loras;
  let scenes: any = data.scenes;
  fileExists = fileExists || function () { return true; };
  if (!Array.isArray(characters) || !characters.length) errors.push('characters.json must contain at least one character');
  if (!Array.isArray(loras) || !loras.length) errors.push('loras.json must contain at least one LoRA');
  if (!Array.isArray(scenes)) errors.push('scenes.json must be an array');
  if (errors.length) return errors;

  let characterIds = new Set();
  let characterLoras = new Set();
  characters.forEach(function (character: any, index: string) {
    let label = 'characters[' + index + ']';
    if (!character || typeof character !== 'object') { errors.push(label + ' must be an object'); return; }
    if (!/^[a-z][a-z0-9_-]*$/.test(character.id || '')) errors.push(label + '.id must be a stable lowercase key');
    if (characterIds.has(character.id)) errors.push(label + '.id is duplicated: ' + character.id);
    characterIds.add(character.id);
    ['name', 'source', 'speech'].forEach(function (key: any) {
      if (typeof character[key] !== 'string' || !character[key].trim()) errors.push(label + '.' + key + ' is required');
    });
    if (!character.portrait || typeof character.portrait.image !== 'string') errors.push(label + '.portrait.image is required');
    else if (!fileExists(character.portrait.image)) errors.push(label + '.portrait.image does not exist: ' + character.portrait.image);
    if (!character.visual_dna || !character.visual_dna.signature) errors.push(label + '.visual_dna.signature is required');
    if (!Array.isArray(character.traits) || character.traits.length < 3) errors.push(label + '.traits must contain identity anchors');
    // 热门角色（type=popular）无 LoRA：仅 heroine 强制 lora.name/weight。
    if (character.type !== 'popular') {
      if (!character.lora || typeof character.lora.name !== 'string') errors.push(label + '.lora.name is required');
      else characterLoras.add(character.lora.name);
      if (!(Number(character.lora && character.lora.weight) > 0 && Number(character.lora.weight) <= 2)) errors.push(label + '.lora.weight must be in (0, 2]');
    }
  });

  let loraIds = new Set();
  let loraNames = new Set();
  let sceneIds = new Set(scenes.map(function (scene: any) { return scene && scene.id; }).filter(Boolean));
  loras.forEach(function (lora: any, index: string) {
    let label = 'loras[' + index + ']';
    if (!lora || typeof lora !== 'object') { errors.push(label + ' must be an object'); return; }
    if (!lora.id || loraIds.has(lora.id)) errors.push(label + '.id is missing or duplicated');
    if (!lora.name || loraNames.has(lora.name)) errors.push(label + '.name is missing or duplicated');
    loraIds.add(lora.id); loraNames.add(lora.name);
    let strength = lora.strength || {};
    if (!(Number(strength.min) <= Number(strength.default) && Number(strength.default) <= Number(strength.max))) {
      errors.push(label + '.strength must satisfy min <= default <= max');
    }
    if (!Array.isArray(lora.compatible_models) || !lora.compatible_models.length) errors.push(label + '.compatible_models is required');
    (lora.test_scene || []).forEach(function (sceneId: any) {
      if (!sceneIds.has(sceneId)) errors.push(label + '.test_scene references unknown scene: ' + sceneId);
    });
  });

  characterLoras.forEach(function (name: any) {
    if (!loraNames.has(name)) errors.push('character references unknown LoRA: ' + name);
  });
  scenes.forEach(function (scene: any, index: string) {
    if (!scene || !scene.char) return;
    if (scene.char !== 'triad' && !characterIds.has(scene.char)) errors.push('scenes[' + index + '].char references unknown character: ' + scene.char);
    (Array.isArray(scene.character) ? scene.character : []).forEach(function (id: any) {
      if (!characterIds.has(id)) errors.push('scenes[' + index + '].character references unknown character: ' + id);
    });
  });
  return errors;
}

function validateSceneShards(data: any) {
  let errors: string[] = [];
  let scenes = data.scenes;
  if (!Array.isArray(scenes)) return errors;
  let byId = new Map(scenes.map(function (scene: any) { return [scene.id, scene]; }));
  let shards = ['nene', 'natsume', 'shared'].map(function (char: any) {
    let file = 'scenes-' + char + '.json';
    try {
      let items = readJson('data/' + file);
      if (!Array.isArray(items)) errors.push(file + ' must be an array');
      return { char: char, file: file, items: Array.isArray(items) ? items : [] };
    } catch (error) {
      errors.push(file + ' is missing or unreadable: ' + runtimeErrorMessage(error));
      return { char: char, file: file, items: [] };
    }
  });
  let seen = new Set();
  shards.forEach(function (shard: any) {
    shard.items.forEach(function (scene: any) {
      if (!scene || !scene.id) { errors.push(shard.file + ' contains an item without id'); return; }
      if (seen.has(scene.id)) { errors.push(scene.id + ' appears in multiple browser shards'); return; }
      seen.add(scene.id);
      let canonical = byId.get(scene.id);
      if (!canonical) { errors.push(shard.file + ' contains unknown scene ' + scene.id); return; }
      if (JSON.stringify(scene) !== JSON.stringify(canonical)) {
        errors.push(shard.file + ' scene ' + scene.id + ' differs from scenes.json');
      }
      let expectedChar = scene.char === 'natsume' ? 'natsume'
        : scene.char === 'triad' ? 'shared' : 'nene';
      if (expectedChar !== shard.char) {
        errors.push(scene.id + ' is placed in ' + shard.file + ' but char=' + scene.char);
      }
    });
  });
  if (seen.size !== scenes.length) {
    errors.push('browser shards cover ' + seen.size + ' scenes, expected ' + scenes.length);
  }

  try {
    let index = readJson('data/scenes-index.json');
    if (Number(index.total) !== scenes.length) errors.push('scenes-index.json total mismatch');
    let coreIds = Array.isArray(index.tiers && index.tiers.core) ? index.tiers.core : [];
    let coreFile = readJson('data/scenes-core.json');
    if (!Array.isArray(coreFile)) errors.push('scenes-core.json must be an array');
    else {
      if (coreFile.length !== coreIds.length) errors.push('scenes-core.json length differs from index tiers.core');
      coreIds.forEach(function (id: string, position: number) {
        if (!coreFile[position] || coreFile[position].id !== id || !byId.has(id)) {
          errors.push('scenes-core.json[' + position + '] does not match index tier id ' + id);
        }
      });
      if (coreFile.some(function (scene: any) { return !byId.has(scene.id); })) {
        errors.push('scenes-core.json references scenes outside scenes.json');
      }
    }
    let ordered = Array.isArray(index.orderedIds) ? index.orderedIds : [];
    if (ordered.length !== scenes.length) errors.push('scenes-index.json orderedIds length mismatch');
  } catch (error) {
    errors.push('scenes-index.json is missing or unreadable: ' + runtimeErrorMessage(error));
  }
  return errors;
}

function validatePopularContent() {
  let errors: any[] = [];
  try {
    let popular: typeof import('../../src/utils/popularContent.ts') = require('../../src/utils/popularContent.ts');
    let recipes: typeof import('../../src/config/kreaStyleRecipes.ts') = require('../../src/config/kreaStyleRecipes.ts');
    let characters = popular.parsePopularCharacters(readJson('data/popular-characters.json'));
    let blueprints = popular.parseSceneBlueprints(readJson('data/scene-blueprints.json'));
    if (characters.length < 1) errors.push('popular-characters.json must contain at least one character');
    characters.forEach(function (character: any) {
      let defaults = character.outfits.filter(function (outfit: any) { return outfit.default; });
      if (defaults.length !== 1) errors.push(character.id + ' must have exactly one default outfit');
      // 全字段污染扫描：identityProse/aliases/exactPrefixes/outfit prose+tokens 都覆盖。
      popular.scanCharacterPollution(character).forEach(function (leak: any) {
        errors.push('pollution: ' + leak);
      });
    });
    if (blueprints.length < 20) errors.push('scene-blueprints.json must contain at least 20 blueprints');
    let adultBlueprints = blueprints.filter(function (blueprint: any) { return blueprint.adult; });
    if (adultBlueprints.length < 1) errors.push('scene-blueprints.json should keep at least one adult-only blueprint gated by adultEligibility');
    let nonAdult = characters.filter(function (character: any) { return character.adultEligibility !== 'adult'; });
    nonAdult.forEach(function (character: any) {
      adultBlueprints.forEach(function (blueprint: any) {
        if (popular.blueprintEligible(blueprint, character, { adultEnabled: true })) {
          errors.push(character.id + ' must never reach adult blueprint ' + blueprint.id + ' (fail closed)');
        }
      });
    });
    (blueprints || []).forEach(function (blueprint: any) {
      let text = JSON.stringify(blueprint);
      if (popular.scanStudioTokenLeaks(text).length) {
        errors.push('blueprint ' + blueprint.id + ' must not reference nene/natsume tokens');
      }
      if (/(?:official_cg|visual_audited)/i.test(text)) {
        errors.push('blueprint ' + blueprint.id + ' must not leak retrieval metadata');
      }
      // kreaStyleHint / animaStyleHint：命中配方时，成人配方只允许挂在成人蓝图上
      // （成人蓝图对非 adult 角色 fail closed，hint 随蓝图一起被拦下）。
      ['kreaStyleHint', 'animaStyleHint'].forEach(function (key: any) {
        let hint = blueprint[key];
        if (typeof hint !== 'string' || !hint.trim()) return;
        let recipe = recipes.findStyleRecipe(recipes.KREA_STYLE_RECIPES, hint);
        if (recipe && recipe.adult && !blueprint.adult) {
          errors.push('blueprint ' + blueprint.id + ' ' + key + ' references adult recipe ' + recipe.id + ' but the blueprint is not adult');
        }
      });
    });
    // 配方本体契约：至少 8 个通用配方 + 独立显式的成人配方；成人配方只对 adult
    // 角色 + 成熟内容开关同时放行（unknown/underage 永远不可达）。
    let allRecipes = recipes.KREA_STYLE_RECIPES;
    let common = allRecipes.filter(function (recipe: any) { return !recipe.adult; });
    let adultRecipes = allRecipes.filter(function (recipe: any) { return recipe.adult; });
    if (common.length < 8) errors.push('kreaStyleRecipes must ship at least 8 common recipes, got ' + common.length);
    if (adultRecipes.length < 1) errors.push('kreaStyleRecipes must ship explicit adult-only recipes');
    allRecipes.forEach(function (recipe: any) {
      if (!recipe.lead || !recipe.lead.trim()) errors.push('kreaStyleRecipes.' + recipe.id + ' must have a lead phrase');
      if (/(?:ayachi_nene|shiki_natsume|nene_|natsume_)/i.test(recipe.lead + ' ' + (recipe.medium || ''))) {
        errors.push('kreaStyleRecipes.' + recipe.id + ' must not reference studio LoRA tokens');
      }
    });
    nonAdult.forEach(function (character: any) {
      adultRecipes.forEach(function (recipe: any) {
        if (recipes.recipeEligible(recipe, character, { adultEnabled: true })) {
          errors.push(character.id + ' must never reach adult style recipe ' + recipe.id + ' (fail closed)');
        }
      });
    });
  } catch (error) {
    errors.push('popular/scene-blueprints data failed to parse: ' + runtimeErrorMessage(error));
  }
  return errors;
}

/**
 * precompress 产物一致性校验（2026-08-28 工程审计 P0-4）。
 *
 * 服务端按文件名直发 .gz/.br（precompressed 中间件），此前没有任何机制
 * 校验压缩产物与源 json 内容一致：单独改源 json 而忘记重跑 precompress 时，
 * 服务端会静默发送过期压缩数据且无任何报错。这里对 data/ 下每个压缩产物
 * 解压后与源文件逐字节比对；孤儿产物（源文件已不存在）一并报红。
 *
 * 源文件存在但没有压缩产物不视为错误：fresh clone 自愈构建只重建 json，
 * .br/.gz 由 build/precompress 流程按需生成（与 precompress --check 的
 * 存在性检查互补，那边管缺产物，这边管产物过期）。
 */
function checkPrecompressArtifacts() {
  let errors: string[] = [];
  let dataDir = path.join(ROOT, 'data');
  if (!fs.existsSync(dataDir)) return errors;
  function walk(dir: string) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry: any) {
      let full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); return; }
      let packed = /^(.*)\.(br|gz)$/.exec(entry.name);
      if (!packed) return;
      let source = path.join(dir, packed[1]);
      let relative = path.relative(ROOT, full);
      if (!fs.existsSync(source)) {
        if (process.argv.includes('--fix')) {
          try {
            fs.unlinkSync(full);
            console.log(`[fix] Removed orphan precompressed artifact: ${relative}`);
            return;
          } catch {}
        }
        errors.push('orphan precompressed artifact: ' + relative + ' (源 json 已不存在，删除该产物或重跑 npm run precompress)');
        return;
      }
      let raw = fs.readFileSync(source);
      let decoded;
      try {
        decoded = packed[2] === 'br'
          ? zlib.brotliDecompressSync(fs.readFileSync(full))
          : zlib.gunzipSync(fs.readFileSync(full));
      } catch (error) {
        errors.push(relative + ' cannot be decompressed: ' + runtimeErrorMessage(error));
        return;
      }
      if (Buffer.compare(raw, decoded) !== 0) {
        if (process.argv.includes('--fix')) {
          try {
            const { compress } = require('./precompress');
            compress(source);
            console.log(`[fix] Recompressed stale artifact: ${source}`);
            return;
          } catch {}
        }
        errors.push(relative + ' 与源文件内容不一致（改过源 json 后必须重跑 npm run precompress，否则服务端会静默发送过期压缩数据）');
      }
    });
  }
  walk(dataDir);
  return errors;
}

/**
 * 2026-08-29 产品运营审计 P0-1：character-reference-view.json 曾积累 232 条 url 断链
 * （212 条命名漂移 + 5 个幽灵形态）长期无人报红——检查器 check-ref-urls.js 已存在但未接门禁。
 * 这里把磁盘存在性与形态条目唯一性纳入 test:content；断链/重复回潮时给出修复入口。
 */
function checkReferenceViewUrls() {
  let viewFile = path.join(ROOT, 'data', 'character-reference-view.json');
  if (!fs.existsSync(viewFile)) return ['data/character-reference-view.json is missing'];
  let view;
  try {
    view = JSON.parse(fs.readFileSync(viewFile, 'utf8'));
  } catch (error) {
    return ['character-reference-view.json cannot be parsed: ' + runtimeErrorMessage(error)];
  }
  // 参考核对与数据读取使用同一统一根：auditReferenceView 内部优先 env.AICS_APP_ROOT，
  // 当 AICS_DATA_ROOT 命中时必须把它对齐到 ROOT，避免两套根各查各的。
  let result = (require('./check-ref-urls') as typeof import('./check-ref-urls')).auditReferenceView(view, ROOT,
    Object.assign({}, process.env, { AICS_APP_ROOT: ROOT }));
  let errors = result.errors.map(function (error: any) { return 'character-reference-view: ' + error; });
  if (result.missing) errors.push('参考图缺失 ' + result.missing + '/' + result.total
    + '；素材根目录: ' + (result.refRoot || '(未配置)') + '。先确认素材路径与同步，不自动改写索引。');
  return errors;
}

/**
 * 2026-08-29 产品运营审计 P0-3：经典场景库分级互锁——rating='R18' 与 mature=true
 * 必须行级一致，防止 R18 内容借 All/mature=false 漏进全年龄流（红线 4 内容侧互锁）。
 */
function checkSceneRatingInterlock(data: any) {
  let errors: string[] = [];
  (data.scenes || []).forEach(function (scene: any) {
    let mature = Boolean(scene.mature);
    if (scene.rating === 'R18' && !mature) {
      errors.push('scene ' + scene.id + ': rating=R18 但 mature!=true（红线 4 分级互锁）');
    }
    if (mature && scene.rating !== 'R18') {
      errors.push('scene ' + scene.id + ': mature=true 但 rating=' + JSON.stringify(scene.rating) + '（红线 4 分级互锁）');
    }
  });
  return errors;
}

function main() {
  // 核心数据逐文件装载：缺文件/坏 JSON 输出定位到具体路径，不允许异常后继续报告成功。
  let data: Record<string, any> = {};
  let loadErrors: string[] = [];
  [['characters', 'data/characters.json'], ['loras', 'data/loras.json'], ['scenes', 'data/scenes.json']].forEach(function (entry: any) {
    try {
      data[entry[0]] = readJson(entry[1]);
    } catch (error) {
      loadErrors.push(entry[1] + ' is missing or unreadable: ' + runtimeErrorMessage(error));
    }
  });

  let errors = loadErrors.slice();
  if (!loadErrors.length) {
    errors = errors.concat(validateContent(data, function (relative: any) {
      // 样张/立绘 URL 允许携带缓存版本串（如 popular-*.png?v=2），存在性检查需剥离。
      let pathOnly = String(relative).replace(/\?.*$/, '');
      return fs.existsSync(path.resolve(ROOT, 'data', pathOnly));
    }));
    errors = errors.concat(validateSceneShards(data));
    errors = errors.concat(checkSceneRatingInterlock(data));
  }
  // 与核心数据无关的检查继续执行：坏夹具下一次暴露尽可能多的可定位问题。
  errors = errors.concat(validatePopularContent());
  errors = errors.concat(checkPrecompressArtifacts());
  errors = errors.concat(checkReferenceViewUrls());
  errors = errors.concat(checkDataVersion());
  if (errors.length) {
    console.error(errors.map(function (error: any) { return '  - ' + error; }).join('\n'));
    process.exitCode = 1;
    return;
  }
  console.log('Content contracts passed: ' + data.characters.length + ' characters, ' + data.loras.length + ' LoRAs, ' + data.scenes.length + ' scenes');
}

if (require.main === module) main();
export = { validateContent:validateContent };
