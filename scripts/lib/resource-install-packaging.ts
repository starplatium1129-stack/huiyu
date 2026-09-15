'use strict';

import { PathLike } from 'node:fs';

const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const sharp: typeof import('sharp') = require('sharp');
const { noLinks, child, within, readBytes, digest, writeAtomic }: typeof import('./resource-install-fs') = require('./resource-install-fs');

// Profile generation runs only inside a fresh desktop staging directory. Every original URL
// remains available offline; base changes only popular portraits, never thumbnails/brand/Live2D.
async function applyResourceProfile({ root, gatewayRoot, profile = 'full' }) {
  if (!['full', 'base'].includes(profile)) throw new Error('Resource profile must be full or base');
  root = path.resolve(root); gatewayRoot = path.resolve(gatewayRoot);
  const source = path.join(root, 'assets');
  const target = path.join(gatewayRoot, 'assets');
  if (within(source, target) || within(target, source) || within(gatewayRoot, root)) throw new Error('Profile output overlaps source assets');
  noLinks(fs, source); noLinks(fs, target);
  const entries: { rel: string; sourceBytes: unknown; }[] = [];
  function walk(directory: PathLike, prefix = '') {
    noLinks(fs, directory);
    for (const name of fs.readdirSync(directory).sort()) {
      const rel = prefix + name;
      const file = child(directory, name);
      const stat = noLinks(fs, file);
      if (rel.toLowerCase() === 'character-references' || rel.toLowerCase().startsWith('character-references/')) continue;
      if (stat.isDirectory()) walk(file, rel + '/');
      else entries.push({ rel, sourceBytes: stat.size });
    }
  }
  walk(source);
  const optional = [];
  let sourceBytes = 0;
  let baseBytes = 0;
  for (const entry of entries) {
    const sourceFile = child(source, entry.rel);
    const targetFile = child(target, entry.rel);
    const original = readBytes(fs, sourceFile, entry.sourceBytes);
    let staged = readBytes(fs, targetFile, entry.sourceBytes);
    if (!original.equals(staged)) throw new Error('Staged asset differs before profiling: ' + entry.rel);
    const portrait = /^characters\/popular-[a-zA-Z0-9_-]+\.(png|jpe?g|webp)$/.test(entry.rel);
    if (profile === 'base' && portrait) {
      const name = path.posix.basename(entry.rel).replace(/\.[^.]+$/, '.webp');
      const thumb = child(target, 'characters/thumbs/' + name);
      const thumbnail = await sharp(readBytes(fs, thumb)).metadata();
      if (!thumbnail.width || !thumbnail.height) throw new Error('A base portrait requires a valid offline thumbnail');
      const input = sharp(original, { limitInputPixels: 100_000_000 });
      const meta = await input.metadata();
      if (meta.pages && meta.pages !== 1) throw new Error('Animated portrait cannot be reduced');
      const candidate = await input.resize({ width: 768, height: 1024, fit: 'inside', withoutEnlargement: true }).toBuffer();
      if (candidate.length < original.length) {
        staged = candidate;
        writeAtomic(fs, targetFile, staged);
        const check = await sharp(readBytes(fs, targetFile, staged.length)).metadata();
        if (!check.width || !check.height || check.format !== meta.format) throw new Error('Preview readback failed');
        optional.push({ path: 'assets/' + entry.rel, bytes: original.length, sha256: digest(original),
          baseBytes: staged.length, baseSha256: digest(staged), width: check.width, height: check.height });
      }
    }
    sourceBytes += original.length; baseBytes += staged.length;
  }
  const report = { schemaVersion: 1, kind: 'desktop-resource-layers', profile,
    files: entries.length, bundledBytes: baseBytes, fullResourceBytes: sourceBytes,
    optionalOriginalBytes: optional.reduce((sum, item) => sum + item.bytes, 0),
    firstRequiredDownloadBytes: 0, optional, preservesOriginalUrls: true,
    note: 'Byte/decoder checks only; actual image quality and Windows display acceptance are separate.' };
  writeAtomic(fs, path.join(gatewayRoot, 'resource-layers.json'), Buffer.from(JSON.stringify(report, null, 2) + '\n'));
  return report;
}
export = { applyResourceProfile };
