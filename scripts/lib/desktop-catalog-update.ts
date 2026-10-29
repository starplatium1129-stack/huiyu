import fs = require('node:fs');
import path = require('node:path');
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import snapshot = require('./catalog-snapshot');

const CATALOG_FILES = ['catalog.sqlite', 'catalog.sqlite-wal', 'catalog.sqlite-shm', 'catalog.identity.json'];
const PIN_FILES = ['data/prompt-pinned-scenes.json', 'data/prompt-pinned-scenes.json.br', 'data/prompt-pinned-scenes.json.gz'];

/** Explicitly adopt the bundled project snapshot after the user opts in.
 * Keep the whole old SQLite authority, including history and WAL, for recovery. */
function adoptProjectCatalog(app: string, runtime: string, evidence: string, incoming: string, recordCount: number) {
  const content = path.join(runtime, 'content');
  const replacementRuntime = path.join(evidence, 'replacement');
  const replacement = path.join(replacementRuntime, 'content');
  const previous = path.join(evidence, 'previous-catalog');
  const failed = path.join(evidence, 'failed-replacement');
  const within = (root: string, child: string) => {
    const rel = path.relative(root, child);
    return rel !== '' && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel);
  };
  const actualRuntime = fs.realpathSync(runtime);
  if (fs.lstatSync(content).isSymbolicLink() || !within(actualRuntime, fs.realpathSync(content))
      || !within(actualRuntime, fs.realpathSync(evidence))) throw Error('CATALOG_ADOPT_PATH: 内容库或备份目录不在用户运行目录内');
  const contentData = path.join(content, 'data');
  if (fs.lstatSync(contentData).isSymbolicLink() || !within(fs.realpathSync(content), fs.realpathSync(contentData))) {
    throw Error('CATALOG_ADOPT_PATH: 内容数据目录不在内容库内');
  }
  const currentPin = JSON.parse(fs.readFileSync(path.join(app, PIN_FILES[0]), 'utf8'));
  const snapshotPin = JSON.parse(fs.readFileSync(incoming, 'utf8')).records
    .find((record: { kind: string; id: string }) => record.kind === 'document' && record.id === 'prompt-pinned-scenes');
  if (!snapshotPin || !isDeepStrictEqual(currentPin, snapshotPin.data)) throw Error('CATALOG_ADOPT_INVALID: 项目定稿基线与内容快照不一致');
  const run = (root: string, runtimeRoot: string, command: string, args: string[] = []) => {
    const result = JSON.parse(execFileSync(path.join(app, 'huiyu-runtime.exe'),
      ['catalog', command, '--root', root, '--seed-root', app, '--runtime-root', runtimeRoot, ...args],
      { encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }));
    if (result.ok !== true) throw Error(`内容库${command}失败：${JSON.stringify(result)}`);
    return result;
  };
  const stats = run(app, replacementRuntime, 'stats');
  const total = Object.values<number>(stats.counts).reduce((sum, value) => sum + value, 0);
  if (total !== recordCount) throw Error('CATALOG_ADOPT_INCOMPLETE: 新内容库记录数与项目快照不一致');
  const args = ['--file', incoming, '--preserve-local'];
  const preview = run(app, replacementRuntime, 'import', args);
  if (preview.items.length || preview.preservedLocal.length) throw Error('CATALOG_ADOPT_INCOMPLETE: 新内容库与项目快照不一致');
  fs.mkdirSync(path.join(replacement, 'data'));
  for (const name of PIN_FILES) {
    const file = path.join(app, name);
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(replacement, name), fs.constants.COPYFILE_EXCL);
  }
  for (const name of ['catalog.sqlite', 'catalog.identity.json']) {
    if (!fs.lstatSync(path.join(content, name)).isFile() || !fs.lstatSync(path.join(replacement, name)).isFile()) {
      throw Error(`CATALOG_ADOPT_INVALID: 缺少内容库文件 ${name}`);
    }
  }
  fs.mkdirSync(previous);
  fs.writeFileSync(path.join(evidence, 'adoption.json'), JSON.stringify({ status: 'prepared', previous, replacement, content }));
  const movedOld: string[] = [];
  let oldMoved = false;
  try {
    for (const name of [...CATALOG_FILES, ...PIN_FILES]) {
      const file = path.join(content, name);
      if (!fs.existsSync(file)) continue;
      if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw Error(`CATALOG_ADOPT_INVALID: 非普通文件 ${name}`);
      fs.mkdirSync(path.dirname(path.join(previous, name)), { recursive: true });
      fs.renameSync(file, path.join(previous, name));
      movedOld.push(name);
    }
    oldMoved = true;
    for (const name of [...CATALOG_FILES, ...PIN_FILES]) {
      const file = path.join(replacement, name);
      if (fs.existsSync(file)) fs.renameSync(file, path.join(content, name));
    }
    const remaining = run(content, runtime, 'import', args);
    if (remaining.items.length || remaining.preservedLocal.length) throw Error('CATALOG_ADOPT_INCOMPLETE: 切换后内容库与项目快照不一致');
    fs.writeFileSync(path.join(evidence, 'adoption.json'), JSON.stringify({ status: 'complete', previous, content }));
    return { adoptedProjectCatalog: true, records: recordCount, previousCatalog: previous, evidence };
  } catch (error) {
    try {
      if (oldMoved) {
        fs.mkdirSync(failed);
        for (const name of [...CATALOG_FILES, ...PIN_FILES]) {
          const file = path.join(content, name);
          if (fs.existsSync(file)) {
            fs.mkdirSync(path.dirname(path.join(failed, name)), { recursive: true });
            fs.renameSync(file, path.join(failed, name));
          }
        }
      }
      for (const name of movedOld.reverse()) fs.renameSync(path.join(previous, name), path.join(content, name));
    } catch (rollback) {
      throw Error(`CATALOG_ADOPT_ROLLBACK_FAILED: 请从 ${previous} 恢复原内容库；${String(rollback)}`, { cause: error });
    }
    throw error;
  }
}

/** Called by deployment after the desktop has drained, using the installed payload. */
function updateCatalog(app: string, runtime: string, adopt = false) {
  const records = snapshot.read(app);
  if (!records) throw Error('CATALOG_SNAPSHOT_MISSING: 安装包缺少内容快照，请重新构建；不能宣称人物已更新。');
  // A new profile must be initialized by the desktop's atomic full-data seed,
  // not by opening SQLite before its reference/index files have been copied.
  if (!fs.existsSync(path.join(runtime, 'content'))) return { changed: 0, firstLaunch: true };
  const manifest = JSON.parse(fs.readFileSync(path.join(app, 'data/catalog/manifest.json'), 'utf8'));
  const evidence = path.join(runtime, 'content-update-backups', randomUUID());
  fs.mkdirSync(evidence, { recursive: true });
  const incoming = path.join(evidence, 'incoming.json');
  fs.writeFileSync(incoming, JSON.stringify({ version: 1, records, retired: manifest.retired || [] }));
  const run = (command: string, args: string[] = []) => {
    const result = JSON.parse(execFileSync(path.join(app, 'huiyu-runtime.exe'),
      ['catalog', command, '--root', path.join(runtime, 'content'), '--seed-root', app, '--runtime-root', runtime, ...args],
      { encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }));
    if (result.ok !== true) throw Error(`内容库${command}失败：${JSON.stringify(result)}`);
    return result;
  };
  // Application upgrades preserve personal creative overrides. Native import
  // retains their exact records and advances only the incoming seed baseline;
  // interactive/manual imports keep their existing strict conflict policy.
  run('export', ['--out', path.join(evidence, 'before')]);
  if (adopt) return adoptProjectCatalog(app, runtime, evidence, incoming, records.length);
  const args = ['--file', incoming, '--preserve-local'];
  const preview = run('import', args);
  fs.writeFileSync(path.join(evidence, 'preview.json'), JSON.stringify(preview));
  const applied = run('import', [...args, '--apply']);
  fs.writeFileSync(path.join(evidence, 'applied.json'), JSON.stringify(applied));
  const remaining = run('import', args);
  fs.writeFileSync(path.join(evidence, 'verified.json'), JSON.stringify(remaining));
  if (remaining.items.length) throw Error('CATALOG_UPDATE_INCOMPLETE: 导入后仍有内容差异，部署未完成。');
  return { changed: applied.items.length, preservedLocal: applied.preservedLocal, evidence };
}

if (require.main === module) {
  try {
    const [app, runtime, mode] = process.argv.slice(2);
    if (!app || !runtime) throw Error('需要安装网关和个人运行目录');
    if (mode && mode !== '--adopt-project-catalog') throw Error('未知内容库更新模式');
    console.log(JSON.stringify(updateCatalog(path.resolve(app), path.resolve(runtime), mode === '--adopt-project-catalog')));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
