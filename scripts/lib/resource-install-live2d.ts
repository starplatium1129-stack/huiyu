'use strict';

const path: typeof import('node:path') = require('node:path');
const { child, readBytes, digest }: typeof import('./resource-install-fs') = require('./resource-install-fs');

// Overlay an entire model dependency graph or none of it. Never fill holes in a new
// model with old textures/physics. Unknown schemas stay on the bundled model.
function completeLive2dPaths(root: any, entries: any, io: any) {
  const byPath = new Map(entries.map((entry: any) => [entry.path, entry]));
  const groups = [];
  for (const entry of entries) {
    if (!entry.path.startsWith('assets/live2d/') || !/\.model3\.json$/i.test(entry.path)) continue;
    try {
      const bytes = readBytes(io, child(root, entry.path));
      if (digest(bytes) !== entry.sha256) continue;
      const model = JSON.parse(bytes.toString('utf8'));
      const files = model.FileReferences;
      if (model.Version !== 3 || !files || typeof files.Moc !== 'string'
        || !Array.isArray(files.Textures) || !files.Textures.length) continue;
      const refs = [files.Moc, ...files.Textures];
      for (const name of ['Physics', 'Pose', 'DisplayInfo', 'UserData']) if (files[name] !== undefined) refs.push(files[name]);
      if (files.Expressions !== undefined) {
        if (!Array.isArray(files.Expressions)) continue;
        for (const item of files.Expressions) refs.push(item?.File);
      }
      if (files.Motions !== undefined) {
        if (!files.Motions || typeof files.Motions !== 'object' || Array.isArray(files.Motions)) continue;
        for (const motions of Object.values(files.Motions)) {
          if (!Array.isArray(motions)) throw new Error('Invalid motion group');
          for (const item of motions) { refs.push(item?.File); if (item?.Sound !== undefined) refs.push(item.Sound); }
        }
      }
      const directory = path.posix.dirname(entry.path);
      const required = new Set([entry.path]);
      for (const ref of refs) {
        if (typeof ref !== 'string' || !ref || /[\\:%?#\x00-\x1f]/.test(ref)
          || ref.startsWith('/') || path.posix.normalize(ref) !== ref
          || ref.split('/').some(part => !part || part.startsWith('.'))) throw new Error('Unsafe dependency');
        const rel = directory + '/' + ref;
        if (!byPath.has(rel)) throw new Error('Dependency not in verified serving manifest');
        required.add(rel);
      }
      groups.push({ model: entry.path, directory: directory + '/', paths: [...required] });
    } catch { /* Missing, invalid or incompatible model falls back as a whole. */ }
  }
  return groups;
}
export = { completeLive2dPaths };
