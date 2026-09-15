'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { VERSIONED_FILES } = require('../scripts/lib/data-version');
const { prepareBlueprintWrite, applyBlueprintWrite } = require('../scripts/lib/blueprint-write');

function prepareBlueprints(rootDir, blueprints, previous = []) {
  const popular = require('../scripts/lib/popular-store');
  if (path.resolve(popular.shardsDir) !== path.resolve(rootDir, 'data', 'popular')) throw new Error('热门角色数据根与维护根不一致');
  const { characters } = popular.loadPopularShards();
  const oldById = new Map(previous.map(blueprint => [blueprint.id, blueprint]));
  const charactersById = new Map(characters.map(character => [character.id, character]));
  const franchiseByCharacter = new Map();
  for (const character of characters) {
    if (franchiseByCharacter.has(character.id)) throw new Error('热门角色身份重复：' + character.id);
    franchiseByCharacter.set(character.id, character.franchise);
  }
  for (const blueprint of blueprints) {
    const old = oldById.get(blueprint.id);
    // Preserve unchanged legacy bindings; new or edited bindings must name a real outfit.
    if (old && old.characterId === blueprint.characterId && old.outfitId === blueprint.outfitId) continue;
    const character = charactersById.get(blueprint.characterId);
    if (blueprint.outfitId && (!character || !(character.outfits || []).some(outfit => outfit.id === blueprint.outfitId))) {
      throw new Error('蓝图 ' + blueprint.id + ' 的服装不属于所选角色：' + blueprint.outfitId);
    }
  }
  return prepareBlueprintWrite({ rootDir, blueprints, franchiseByCharacter });
}

function applyBlueprints(prepared, writeFileAtomic) {
  return applyBlueprintWrite(prepared, { writeFileAtomic });
}

// Only refresh companions already present. Fresh checkouts do not require compression.
function refreshCompressedProducts(rootDir, writeFileAtomic) {
  for (const name of VERSIONED_FILES) {
    const file = path.join(rootDir, 'data', name);
    const bytes = fs.readFileSync(file);
    for (const ext of ['gz', 'br']) {
      const companion = file + '.' + ext;
      if (!fs.existsSync(companion)) continue;
      const old = fs.readFileSync(companion);
      try {
        const decoded = ext === 'gz' ? zlib.gunzipSync(old) : zlib.brotliDecompressSync(old);
        if (decoded.equals(bytes)) continue;
      } catch { /* A stale or damaged companion is replaced inside the transaction. */ }
      const packed = ext === 'gz' ? zlib.gzipSync(bytes) : zlib.brotliCompressSync(bytes, {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 },
      });
      writeFileAtomic(companion, packed);
    }
  }
}

function protectPinnedScenes(rootDir, previous, incoming) {
  const file = path.join(rootDir, 'data', 'prompt-pinned-scenes.json');
  const pins = JSON.parse(fs.readFileSync(file, 'utf8')).scenes || {};
  const current = new Map(previous.map(scene => [scene.id, scene]));
  const next = new Map(incoming.map(scene => [scene.id, scene]));
  for (const id of Object.keys(pins)) {
    const before = current.get(id);
    if (!before) continue;
    const after = next.get(id);
    if (!after) throw new Error('定稿场景不能在普通保存中删除：' + id);
    for (const key of ['prompt', 'negative', 'animaCaption', 'recommendedSize', 'rating', 'mature']) {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) throw new Error('定稿保护拒绝修改 ' + id + '.' + key);
    }
  }
}

module.exports = { prepareBlueprints, applyBlueprints, refreshCompressedProducts, protectPinnedScenes };
