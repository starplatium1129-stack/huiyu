import { errorCode as runtimeErrorCode, errorMessage as runtimeErrorMessage } from './runtime-errors';
/**
 * scripts/lib/scene-write.js — 场景写入侧治理（计划 006 / D5）
 *
 * 职责边界：日常保存走「稳定目标 + 增量写分片」；全量重切只属于显式维护
 * （split-scenes / clean-scenes 经 scene-store.writeSceneSet）。这里不迁移
 * 数据库、不打开安装版写入口；兼容既有 scNNN，sc999 后自然续接 sc1000。
 *
 * 关键约定：
 * - 已有场景留在原分片文件（存储细节），展示分类改名不迁移物理分组；
 *   仅 char 归属真正变化时才跨组移动。
 * - 新增场景按 targetFile 落组，追加到该组最后一个批次；批次满才新开批次，
 *   不重新平衡既有文件。清空后的批次保留为 []，避免制造缺号让后续分片
 *   被 expandShardFiles 截断。
 * - 已退役 ID 永不复用；ID 分配与保存前检查都读取 retired-scenes.json。
 */
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const store: typeof import('./scene-store') = require('./scene-store');
const recoveryFs: typeof import('./maintenance-recovery-fs') = require('./maintenance-recovery-fs');

const shardsDir = store.shardsDir;

/** 读取已退役场景 ID 集合；文件缺失视为空（fresh clone）。 */
function readRetiredSceneIds(dataDir?: string) {
  const dir = dataDir || path.join(shardsDir, '..');
  let data;
  try {
    data = store.readJson(path.join(dir, 'retired-scenes.json'));
  } catch (error) {
    if (runtimeErrorCode(error) === 'ENOENT') return new Set();
    throw new Error('retired-scenes.json 无法读取，停止场景写入: ' + runtimeErrorMessage(error));
  }
  if (!data || !Array.isArray(data.records)
    || data.records.some((record: { id: string; }) => !record || typeof record.id !== 'string' || !record.id.trim())) {
    throw new Error('retired-scenes.json 格式无效，停止场景写入');
  }
  return new Set(data.records.map((record: any) => record.id));
}

/** 写入侧确认稳定 ID：活跃及退役身份都参与分配，不复用旧身份。 */
function allocateSceneId(activeIds: any, retiredIds: any) {
  return (require('./scene-id') as typeof import('./scene-id')).nextSceneId(activeIds || [], retiredIds || []);
}

// ── 源分片完整性（manifest ↔ 目录 ↔ 内容） ──────────────────────────────

function groupPrefix(baseFile: string) {
  return baseFile.replace(/\.json$/, '');
}

/** 校验 data/scenes 源分片：缺号、孤立分片、重复 ID、归属冲突。
 *  与 test-scene-shard-integrity.js（产物层 oracle）互补，这里只看源文件层。 */
function verifyShardIntegrity() {
  const problems = [];
  let manifest;
  try {
    manifest = store.readJson(path.join(shardsDir, 'manifest.json'));
  } catch (error) {
    return { ok: false, problems: ['manifest.json 无法读取: ' + runtimeErrorMessage(error)] };
  }
  if (!manifest || !Array.isArray(manifest.files) || !manifest.files.length) {
    return { ok: false, problems: ['manifest.json 必须声明非空 files 数组'] };
  }
  const manifestNames = new Set();
  for (const entry of manifest.files) {
    if (!entry || typeof entry.file !== 'string'
      || !/^[a-zA-Z0-9_-]+\.json$/.test(entry.file) || entry.file === 'manifest.json') {
      problems.push('manifest.json 包含无效分片文件名（必须是目录内的基础 JSON 文件名）');
    } else if (manifestNames.has(entry.file)) {
      problems.push('manifest.json 重复声明 ' + entry.file);
    } else {
      manifestNames.add(entry.file);
    }
  }
  if (problems.length) return { ok: false, problems };
  const declared = new Set((manifest.files || []).map((entry: any) => entry.file));
  const declaredPrefixes = new Set((manifest.files || []).map((entry: { file: string; }) => groupPrefix(entry.file)));
  const characterOf = new Map((manifest.files || []).map((entry: any) => [entry.file, entry.character]));

  const seenIds = new Map();
  for (const entry of manifest.files || []) {
    const base = groupPrefix(entry.file);
    let files;
    try {
      files = fs.readdirSync(shardsDir);
    } catch (error) {
      return { ok: false, problems: ['data/scenes 目录无法读取: ' + runtimeErrorMessage(error)] };
    }
    const batchFiles = files
      .filter((name) => name.startsWith(base + '.') && /^\.\d+\.json$/.test(name.slice(base.length)));
    for (const name of batchFiles) {
      const suffix = name.slice(base.length);
      if (!/^\.[1-9]\d*\.json$/.test(suffix) || !Number.isSafeInteger(Number(suffix.slice(1, -5)))) {
        problems.push(name + ': 非规范批次编号（须从 .1 开始且无前导零）');
      }
    }
    const numbers = batchFiles
      .map((name) => Number(name.slice(base.length + 1, -5)))
      .sort((a, b) => a - b);
    // 任意批次文件都必须校验；缺少 .1 时读取器会退回单文件，仍有截断风险。
    if (numbers.length) {
      if (files.includes(entry.file)) problems.push(base + ': 单文件与批次文件并存（展开时单文件会被忽略，需先重切）');
      let expected = 1;
      for (const number of numbers) {
        if (number > expected) {
          problems.push(base + ': 批次缺号 .' + expected + ' 且其后仍有分片 .'
            + number + '（读取会截断，属孤立分片）');
        }
        expected = number + 1;
      }
    } else if (!files.includes(entry.file)) {
      problems.push('manifest 声明的 ' + entry.file + ' 不存在');
    }
    // 内容层：JSON 可读、ID 唯一、char 归属与 manifest 一致
    const groupFiles = files.filter((name) => name === entry.file
      || (name.startsWith(base + '.') && /^\.\d+\.json$/.test(name.slice(base.length))));
    for (const file of groupFiles) {
      let scenes;
      try {
        scenes = store.readJson(path.join(shardsDir, file));
      } catch (error) {
        problems.push(file + ': 无法读取 (' + runtimeErrorMessage(error) + ')');
        continue;
      }
      if (!Array.isArray(scenes)) {
        problems.push(file + ': 根必须是数组');
        continue;
      }
      for (const scene of scenes) {
        const id = String(scene && scene.id || '');
        if (!id) {
          problems.push(file + ': 存在缺少 id 的场景');
          continue;
        }
        if (seenIds.has(id)) {
          problems.push(id + ' 同时出现在 ' + seenIds.get(id) + ' 和 ' + file);
        } else {
          seenIds.set(id, file);
        }
        const expectedCharacter = characterOf.get(entry.file);
        if (scene.char && expectedCharacter && scene.char !== expectedCharacter) {
          problems.push(id + ' 的 char=' + scene.char + ' 与 ' + file + ' 声明的 character=' + expectedCharacter + ' 不一致');
        }
      }
    }
  }
  // 未声明却像分片的文件（批次文件折算回所属组再比对，如 nene-core.1.json → nene-core）
  for (const name of fs.existsSync(shardsDir) ? fs.readdirSync(shardsDir) : []) {
    if (name === 'manifest.json' || !name.endsWith('.json')) continue;
    const prefix = groupPrefix(name).replace(/\.\d+$/, '');
    if (!declared.has(name) && !declaredPrefixes.has(prefix)) {
      problems.push(name + ': 未在 manifest.json 声明（非本清单管理的分片文件）');
    }
  }
  return { ok: problems.length === 0, problems };
}

// ── 增量分片写入 ────────────────────────────────────────────────────────

function sameScene(left: any, right: any) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** 组内当前批次文件名（磁盘真实形态，按展开顺序）：单文件 → [base.json]，
 *  批次 → [base.1.json, ...]。workingFiles 优先（同一事务内已改写的形态）。 */
function groupFileOrder(entry: { file: string; }, workingFiles: any[]|Map<any,any>) {
  const base = groupPrefix(entry.file);
  const names = workingFiles ? [...workingFiles.keys()] : fs.readdirSync(shardsDir);
  const batch = names
    .filter((name: any) => name.startsWith(base + '.') && /^\.\d+\.json$/.test(name.slice(base.length)))
    .sort((a: any, b: any) => Number(a.slice(base.length + 1, -5)) - Number(b.slice(base.length + 1, -5)));
  if (batch.length) return batch;
  return names.includes(entry.file) ? [entry.file] : [];
}

/**
 * 增量应用一次保存：只改写受影响的分片文件，不做全量重切。
 *
 * @param {Array} incoming 客户端提交的完整场景集（含新增/修改，缺的即下架）
 * @param {{ sources: Array<{entry,file,scenes}> }} previous loadSceneShards() 结果
 * @param {{ retiredIds?: Set<string>, planOnly?: boolean }} options 保存前已读出的退役 ID；planOnly 不写入
 * @returns {{ addedIds:string[], updatedIds:string[], removedIds:string[], touchedFiles:string[] }}
 */
function applySceneChanges(incoming: any, previous: any, options?: any) {
  const integrity = verifyShardIntegrity();
  if (!integrity.ok) throw new Error('场景分片完整性检查失败: ' + integrity.problems.join('; '));
  const options_ = options || {};
  const retiredIds = options_.retiredIds || new Set();
  /** fileName → 场景数组（工作副本，最后统一落盘） */
  const working = new Map();
  /** fileName → manifest entry */
  const entryOf = new Map();
  for (const source of previous.sources) {
    if (!working.has(source.file)) working.set(source.file, source.scenes.slice());
    entryOf.set(source.file, source.entry);
  }
  const touched = new Set<string>();
  const addedIds = [];
  const updatedIds = [];
  const removedIds = [];

  const idMap = new Map();
  for (const [file, scenes] of working) {
    for (const scene of scenes) idMap.set(String(scene.id), { file, scene });
  }

  function appendToGroup(entry: any, scene: any) {
    if (!entry) throw new Error('manifest does not declare a shard for scene ' + String(scene.id));
    const base = groupPrefix(entry.file);
    const order = groupFileOrder(entry, working);
    const batchSize = store.batchSizeFor(previous.manifest, entry);
    if (!order.length) {
      working.set(entry.file, [scene]);
      entryOf.set(entry.file, entry);
      touched.add(entry.file);
      return;
    }
    const last: any = order[order.length - 1];
    const lastScenes = working.get(last);
    if (lastScenes.length >= batchSize) {
      // 满批：单文件形态先升级为批次形态（内容原样搬进 .1），新场景进下一个批次
      if (last === entry.file) {
        const renamed = base + '.1.json';
        working.set(renamed, lastScenes);
        working.delete(entry.file);
        entryOf.set(renamed, entry);
        entryOf.delete(entry.file);
        for (const existing of lastScenes) {
          const location = idMap.get(String(existing.id));
          if (location && location.file === entry.file) location.file = renamed;
        }
        touched.add(renamed);
        touched.add(entry.file);
      }
      const lastNumber = /^\.(\d+)\.json$/.exec(last.slice(base.length));
      const nextNumber = lastNumber ? Number(lastNumber[1]) + 1 : 2;
      const nextFile = base + '.' + nextNumber + '.json';
      working.set(nextFile, [scene]);
      entryOf.set(nextFile, entry);
      touched.add(nextFile);
      return;
    }
    lastScenes.push(scene);
    touched.add(last);
  }

  function removeFrom(file: any, id: string) {
    const scenes = working.get(file);
    const index = scenes.findIndex((scene: any) => String(scene.id) === id);
    if (index >= 0) scenes.splice(index, 1);
    touched.add(file);
  }

  const incomingIds = new Set();
  for (const scene of incoming) {
    const id = String(scene.id);
    incomingIds.add(id);
    const prev = idMap.get(id);
    if (!prev) {
      if (retiredIds.has(id)) {
        throw new Error(id + ' 已在 retired-scenes.json 中，不能复用已退役身份；'
          + '请改用新的场景 ID（写入侧分配见 GET /api/maintenance/scenes-state）');
      }
      appendToGroup(previous.manifest.files.find((entry: { file: string; }) => entry.file === store.targetFile(scene)), scene);
      addedIds.push(id);
      continue;
    }
    if (!sameScene(prev.scene, scene)) {
      const prevEntry = entryOf.get(prev.file);
      const expectedCharacter = prevEntry && prevEntry.character;
      if (expectedCharacter && scene.char !== expectedCharacter) {
        // char 归属真正变化才跨组移动；分类文字变化不迁移物理分组
        removeFrom(prev.file, id);
        appendToGroup(previous.manifest.files.find((entry: { file: string; }) => entry.file === store.targetFile(scene)), scene);
      } else {
        const scenes = working.get(prev.file);
        const index = scenes.findIndex((item: any) => String(item.id) === id);
        scenes[index] = scene;
        touched.add(prev.file);
      }
      updatedIds.push(id);
    }
  }
  for (const [id, location] of idMap) {
    if (!incomingIds.has(id)) {
      removeFrom(location.file, id);
      removedIds.push(id);
    }
  }

  const changes = {
    addedIds: addedIds.sort(),
    updatedIds: updatedIds.sort(),
    removedIds: removedIds.sort(),
    touchedFiles: [...touched].sort(),
  };
  if (options_.planOnly) return changes;
  for (const file of touched) {
    const scenes = working.get(file);
    if (scenes) {
      recoveryFs.atomicWrite(path.join(shardsDir, file), store.jsonText(store.sortScenes(scenes)));
    } else {
      // 单文件升级为批次形态：原 base.json 已被 .1.json 取代
      recoveryFs.removeFile(path.join(shardsDir, file));
    }
  }
  return changes;
}

// ── 保存副作用（自 routes/maintenance.js 下放，行为保持一致） ────────────

/**
 * 保存后清理 characters/loras/curation 中指向已不存在场景的引用。
 * io 由调用方注入（routes/maintenance-validation 的 readJson/writeJson/sanitizeCuration），
 * 保持与原实现完全相同的落盘格式。
 */
function cleanOrphanedSceneRefs(options: any) {
  const { rootDir, io } = options;
  const activeIds = new Set(store.loadSceneShards().scenes.map((scene) => scene.id));
  const dataDir = path.join(rootDir, 'data');

  const charactersPath = path.join(dataDir, 'characters.json');
  const characters = io.readJson(charactersPath);
  let changed = false;
  characters.forEach((character: { lora: { recommended_scene: any[]; }; }) => {
    const recommended = character.lora && character.lora.recommended_scene;
    if (Array.isArray(recommended)) {
      const filtered = recommended.filter((id) => activeIds.has(id));
      if (filtered.length !== recommended.length) {
        character.lora.recommended_scene = filtered;
        changed = true;
      }
    }
  });
  if (changed) io.writeJson(charactersPath, characters);

  const lorasPath = path.join(dataDir, 'loras.json');
  const loras = io.readJson(lorasPath);
  changed = false;
  loras.forEach((lora: { related_scenes: any[]; scenes: any[]; }) => {
    const related = lora.related_scenes || lora.scenes;
    if (Array.isArray(related)) {
      const filtered = related.filter((id) => activeIds.has(id));
      if (filtered.length !== related.length) {
        if (lora.related_scenes) lora.related_scenes = filtered;
        if (lora.scenes) lora.scenes = filtered;
        changed = true;
      }
    }
  });
  if (changed) io.writeJson(lorasPath, loras);

  const curationPath = path.join(dataDir, 'curation.json');
  const curation = io.sanitizeCuration(io.readJson(curationPath), activeIds);
  io.writeJson(curationPath, curation);
}

/**
 * 把本次保存中消失的场景登记进 retired-scenes.json（退役 ID 永不复用），
 * 并删除对应样张图与 showcase manifest 条目。
 */
function retireRemovedScenes(options: any) {
  const { incomingScenes, previousScenes, rootDir, showcaseDir, io, log } = options;
  const incomingIds = new Set(incomingScenes.map((scene: any) => scene.id));
  const retiredPath = path.join(rootDir, 'data', 'retired-scenes.json');
  const data = io.readJson(retiredPath);
  const retiredRecords = data.records || [];
  const retiredIds = new Set(retiredRecords.map((record: any) => record.id));
  const added: any[] = [];

  previousScenes.forEach((scene: any) => {
    if (!incomingIds.has(scene.id) && !retiredIds.has(scene.id)) {
      retiredRecords.push({ id: scene.id, retiredAt: new Date().toISOString().split('T')[0], reason: '在场景管理中下架' });
      added.push(scene.id);
    }
  });

  if (added.length) {
    data.records = retiredRecords;
    io.writeJson(retiredPath, data);
    if (log) log('  🗑 已登记 ' + added.length + ' 个下架场景: ' + added.join(', '));
  }

  if (added.length && showcaseDir) {
    added.forEach((sceneId) => {
      ['jpg', 'png', 'webp'].forEach((ext) => {
        const imagePath = path.join(showcaseDir, 'images', sceneId + '.' + ext);
        const thumbPath = path.join(showcaseDir, 'thumbs', sceneId + '.' + ext);
        if (fs.existsSync(imagePath)) { fs.unlinkSync(imagePath); if (log) log('  🖼 已删除样张: images/' + sceneId + '.' + ext); }
        if (fs.existsSync(thumbPath)) { fs.unlinkSync(thumbPath); if (log) log('  🖼 已删除缩略图: thumbs/' + sceneId + '.' + ext); }
      });
      const manifestPath = path.join(showcaseDir, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        const manifest = io.readJson(manifestPath);
        if (manifest && Array.isArray(manifest.entries)) {
          manifest.entries = manifest.entries.filter((entry: any) => entry.id !== sceneId);
          manifest.entryCount = manifest.entries.length;
          manifest.sceneCount = manifest.entries.length;
          io.writeJson(manifestPath, manifest);
        }
      }
    });
  }
  return added;
}

// ── 保存事务锁 ──────────────────────────────────────────────────────────

/** 单进程内串行化场景保存：两个并发 POST 不再交错写分片。
 *  前一个任务失败不阻塞后一个（队列吞掉 rejection，结果由调用方自己处理）。 */
let sceneWriteQueue = Promise.resolve();
function withSceneWriteLock<T>(task: () => T | PromiseLike<T>): Promise<T> {
  const run = sceneWriteQueue.then(task, task);
  sceneWriteQueue = run.then(() => {}, () => {});
  return run;
}

export = {
  allocateSceneId,
  applySceneChanges,
  cleanOrphanedSceneRefs,
  readRetiredSceneIds,
  retireRemovedScenes,
  verifyShardIntegrity,
  withSceneWriteLock,
};
