import fs = require('node:fs');
import path = require('node:path');
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import snapshot = require('./catalog-snapshot');

/** Called by deployment after the desktop has drained, using the installed payload. */
export function updateCatalog(app: string, runtime: string) {
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
      ['catalog', command, '--root', app, '--runtime-root', runtime, ...args],
      { encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }));
    if (result.ok !== true) throw Error(`内容库${command}失败：${JSON.stringify(result)}`);
    return result;
  };
  const preview = run('import', ['--file', incoming]);
  fs.writeFileSync(path.join(evidence, 'preview.json'), JSON.stringify(preview));
  // The native three-way merge rejects conflicts before any record is changed.
  run('export', ['--out', path.join(evidence, 'before')]);
  const applied = run('import', ['--file', incoming, '--apply']);
  fs.writeFileSync(path.join(evidence, 'applied.json'), JSON.stringify(applied));
  const remaining = run('import', ['--file', incoming]);
  if (remaining.items.length) throw Error('CATALOG_UPDATE_INCOMPLETE: 导入后仍有内容差异，部署未完成。');
  return { changed: applied.items.length, evidence };
}

if (require.main === module) {
  try {
    const [app, runtime] = process.argv.slice(2);
    if (!app || !runtime) throw Error('需要安装网关和个人运行目录');
    console.log(JSON.stringify(updateCatalog(path.resolve(app), path.resolve(runtime))));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
