'use strict';

const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const zlib: typeof import('node:zlib') = require('node:zlib');
const { VERSIONED_FILES }: typeof import('../scripts/lib/data-version') = require('../scripts/lib/data-version');
const { prepareBlueprintWrite, applyBlueprintWrite }: typeof import('../scripts/lib/blueprint-write') = require('../scripts/lib/blueprint-write');
const recoveryFs: typeof import('../scripts/lib/maintenance-recovery-fs') = require('../scripts/lib/maintenance-recovery-fs');

function prepareBlueprints(rootDir: any, blueprints: any, previous: any = []) {
  const popular: typeof import('../scripts/lib/popular-store') = require('../scripts/lib/popular-store');
  if (path.resolve(popular.shardsDir) !== path.resolve(rootDir, 'data', 'popular')) throw new Error('热门角色数据根与维护根不一致');
  const { characters } = popular.loadPopularShards();
  const oldById = new Map(previous.map((blueprint: any) => [blueprint.id, blueprint]));
  const charactersById = new Map(characters.map(character => [character.id, character]));
  const franchiseByCharacter = new Map();
  for (const character of characters) {
    if (franchiseByCharacter.has(character.id)) throw new Error('热门角色身份重复：' + character.id);
    franchiseByCharacter.set(character.id, character.franchise);
  }
  for (const blueprint of blueprints) {
    const old: any = oldById.get(blueprint.id);
    // Preserve unchanged legacy bindings; new or edited bindings must name a real outfit.
    if (old && old.characterId === blueprint.characterId && old.outfitId === blueprint.outfitId) continue;
    const character = charactersById.get(blueprint.characterId);
    if (blueprint.outfitId && (!character || !(character.outfits || []).some((outfit: any) => outfit.id === blueprint.outfitId))) {
      throw new Error('蓝图 ' + blueprint.id + ' 的服装不属于所选角色：' + blueprint.outfitId);
    }
  }
  return prepareBlueprintWrite({ rootDir, blueprints, franchiseByCharacter });
}

function applyBlueprints(prepared: any, writeFileAtomic: any) {
  return applyBlueprintWrite(prepared, { writeFileAtomic });
}

// Only refresh companions already present. Fresh checkouts do not require compression.
function refreshCompressedProducts(rootDir: any, writeFileAtomic?: any, files?: any) {
  const captured = files && new Set(files);
  for (const file of new Set(files ? files.filter((file: any) => file.endsWith('.json')) : VERSIONED_FILES.map(name => path.join(rootDir, 'data', name)))) {
    const bytes = recoveryFs.readBytes(file, true);
    for (const ext of ['gz', 'br']) {
      const companion = file + '.' + ext;
      if (captured && !captured.has(companion)) continue;
      const old = recoveryFs.readBytes(companion, true);
      if (old === null) continue;
      if (bytes === null) { recoveryFs.removeFile(companion); continue; }
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

function includeCompressedSnapshots(snapshot: any) {
  const files = snapshot.map((item: any) => item.file);
  for (const item of snapshot) {
    if (!item.file.endsWith('.json')) continue;
    for (const ext of ['gz', 'br']) if (recoveryFs.safePath(item.file + '.' + ext)) files.push(item.file + '.' + ext);
  }
  return recoveryFs.snapshotFiles(files);
}

function protectPinnedScenes(rootDir: any, previous: any, incoming: any) {
  const file = path.join(rootDir, 'data', 'prompt-pinned-scenes.json');
  const pins = JSON.parse(fs.readFileSync(file, 'utf8')).scenes || {};
  const current = new Map(previous.map((scene: any) => [scene.id, scene]));
  const next = new Map(incoming.map((scene: any) => [scene.id, scene]));
  for (const id of Object.keys(pins)) {
    const before: any = current.get(id);
    if (!before) continue;
    const after: any = next.get(id);
    if (!after) throw new Error('定稿场景不能在普通保存中删除：' + id);
    for (const key of ['prompt', 'negative', 'animaCaption', 'recommendedSize', 'rating', 'mature']) {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) throw new Error('定稿保护拒绝修改 ' + id + '.' + key);
    }
  }
}

export = { prepareBlueprints, applyBlueprints, refreshCompressedProducts, includeCompressedSnapshots, protectPinnedScenes };
