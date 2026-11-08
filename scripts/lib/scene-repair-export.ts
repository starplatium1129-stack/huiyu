import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, object, type RepairCatalog, type Data } from './scene-repair-content';
import type { Item } from './scene-repair-session';
import safety = require('./generation-candidates');

const comparable = (value: Data) => hash({ ...value, revision: 0, updatedAt: null });
function atomic(file: string, value: unknown) {
  safety.noLinks(file);
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); fs.renameSync(temp, file);
}

/** Export selected records through the native tool, then publish only those files.
 * A whole-directory swap would discard drafts not yet listed in the project manifest. */
export async function exportSelection(catalog: RepairCatalog, selected: string[], items: Map<string, Item>, output: string) {
  const isolated = path.join(output, `snapshot-${randomUUID()}`);
  await catalog.call('export', ['--out', isolated, ...selected.flatMap(slot => ['--record', slot])]);
  const snapshot: unknown = JSON.parse(fs.readFileSync(path.join(isolated, 'manifest.json'), 'utf8'));
  if (!object(snapshot) || !Array.isArray(snapshot.files)) throw new Error('定向导出清单无效');
  const directory = path.join(catalog.root, 'data/catalog'), published: string[] = [], paths: string[] = [];
  for (const relative of snapshot.files) {
    catalog.signal.throwIfAborted();
    if (typeof relative !== 'string' || !/^(blueprint|scene)\/[a-z0-9_-]+-[a-f0-9]{12}\.json$/i.test(relative)) throw new Error('定向导出路径无效');
    const incoming: unknown = JSON.parse(fs.readFileSync(path.join(isolated, relative), 'utf8'));
    if (!object(incoming)) throw new Error('定向导出记录无效');
    const slot = `${incoming.kind}:${incoming.id}`, item = items.get(slot);
    if (!item || !selected.includes(slot) || hash(incoming.data) !== hash(item.rounds.at(-1)!.data))
      throw new Error('内容库在导出期间发生变化，保留项目快照');
    const target = safety.noLinks(path.join(directory, relative));
    const before = fs.existsSync(target) ? fs.readFileSync(target) : undefined;
    if (before) {
      const previous: unknown = JSON.parse(before.toString('utf8'));
      if (!object(previous) || ![comparable(item.original.record as unknown as Data), comparable(incoming)].includes(comparable(previous))) {
        console.error(`[导出待补] ${slot}：项目文件有独立修改，已保留`); continue;
      }
      if (comparable(previous) !== comparable(incoming)) incoming.revision = Math.max(Number(incoming.revision), Number(previous.revision) + 1);
      else { published.push(slot); paths.push(relative); continue; }
    }
    if (before && !fs.readFileSync(target).equals(before) || !before && fs.existsSync(target)) {
      console.error(`[导出待补] ${slot}：项目文件刚被其他会话修改，已保留`); continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true }); atomic(target, incoming);
    published.push(slot); paths.push(relative);
  }
  const manifestFile = safety.noLinks(path.join(directory, 'manifest.json')), bytes = fs.readFileSync(manifestFile);
  const manifest: unknown = JSON.parse(bytes.toString('utf8'));
  if (!object(manifest) || !Array.isArray(manifest.files) || !manifest.files.every(file => typeof file === 'string')) throw new Error('项目快照清单无效');
  const merged = [...new Set([...manifest.files as string[], ...paths])].sort();
  if (hash(merged) !== hash(manifest.files)) {
    if (!fs.readFileSync(manifestFile).equals(bytes)) throw new Error('清单发生并发修改，已保留；下次自动补导出');
    atomic(manifestFile, { ...manifest, files: merged });
  }
  return published;
}
