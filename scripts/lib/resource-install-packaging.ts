'use strict';


const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const sharp: typeof import('sharp') = require('sharp');
const { noLinks, child, within, readBytes, digest, writeAtomic }: typeof import('./resource-install-fs') = require('./resource-install-fs');

/** Brand masters produce the shipped SVG/ICO/tray assets; they are not runtime URLs. */
function includeAsset(relative: string): boolean {
  return relative !== 'app-icon.png' && relative !== 'brand-mark.svg'
    && !/\.(?:[cm]?ts|map)$/i.test(relative)
    && !/^(?:character-references|live2d-candidates)(?:\/|$)/i.test(relative);
}

type AssetEntry = { rel: string; sourceBytes: number };
type LocalAssetStage = {
  assets: AssetEntry[];
  readOriginal: (relative: string) => Buffer;
  readThumbnail: (relative: string) => Buffer;
  stageAsset: (relative: string, bytes: Buffer) => void;
  stageReport: (bytes: Buffer) => void;
};
const isPortrait = (relative: string) => /^characters\/popular-[a-zA-Z0-9_-]+\.(png|jpe?g|webp)$/.test(relative);
const canPackPng = (relative: string) => relative === 'live2d/nene/textures/texture_00.png'
  || (isPortrait(relative) && /\.png$/i.test(relative));

function profileTransformsAsset(entry: AssetEntry, profile: string): boolean {
  return (profile === 'base' && isPortrait(entry.rel))
    || (canPackPng(entry.rel) && entry.sourceBytes > 256 * 1024);
}

// Every original URL remains available offline. Base changes only popular
// portraits, never thumbnails/brand/Live2D.
async function applyResourceProfile({ root, gatewayRoot, profile = 'full', local }: {
  root: string; gatewayRoot: string; profile?: string; local?: LocalAssetStage;
}) {
  if (!['full', 'base'].includes(profile)) throw new Error('Resource profile must be full or base');
  root = path.resolve(root); gatewayRoot = path.resolve(gatewayRoot);
  const source = path.join(root, 'assets');
  const target = path.join(gatewayRoot, 'assets');
  if (within(source, target) || within(target, source) || within(gatewayRoot, root)) throw new Error('Profile output overlaps source assets');
  noLinks(fs, source);
  if (!local) noLinks(fs, target);
  const entries: AssetEntry[] = local?.assets ?? [];
  function walk(directory: string, prefix = '') {
    noLinks(fs, directory);
    for (const name of fs.readdirSync(directory).sort()) {
      const rel = prefix + name;
      const file = child(directory, name);
      const stat = noLinks(fs, file);
      if (!includeAsset(rel)) continue;
      if (stat!.isDirectory()) walk(file, rel + '/');
      else entries.push({ rel, sourceBytes: stat!.size });
    }
  }
  if (!local) walk(source);
  const optional = [];
  const pngCache = path.join(root, 'runtime/desktop-png-cache');
  noLinks(fs, pngCache, { missing: true });
  fs.mkdirSync(pngCache, { recursive: true });
  noLinks(fs, pngCache);
  let sourceBytes = 0;
  let baseBytes = 0;
  for (const entry of entries) {
    const sourceFile = child(source, entry.rel);
    const targetFile = child(target, entry.rel);
    if (local && !profileTransformsAsset(entry, profile)) {
      sourceBytes += entry.sourceBytes;
      baseBytes += entry.sourceBytes;
      continue;
    }
    const original = local ? local.readOriginal(entry.rel) : readBytes(fs, sourceFile, entry.sourceBytes);
    let staged = local ? original : readBytes(fs, targetFile, entry.sourceBytes);
    if (!original.equals(staged)) throw new Error('Staged asset differs before profiling: ' + entry.rel);
    const portrait = isPortrait(entry.rel);
    if (profile === 'base' && portrait) {
      const name = path.posix.basename(entry.rel).replace(/\.[^.]+$/, '.webp');
      const thumb = child(target, 'characters/thumbs/' + name);
      const thumbnail = await sharp(local ? local.readThumbnail('characters/thumbs/' + name) : readBytes(fs, thumb)).metadata();
      if (!thumbnail.width || !thumbnail.height) throw new Error('A base portrait requires a valid offline thumbnail');
      const input = sharp(original, { limitInputPixels: 100_000_000 });
      const meta = await input.metadata();
      if (meta.pages && meta.pages !== 1) throw new Error('Animated portrait cannot be reduced');
      const candidate = await input.resize({ width: 768, height: 1024, fit: 'inside', withoutEnlargement: true }).toBuffer();
      if (candidate.length < original.length) {
        staged = candidate;
        if (!local) writeAtomic(fs, targetFile, staged);
        const check = await sharp(local ? staged : readBytes(fs, targetFile, staged.length)).metadata();
        if (!check.width || !check.height || check.format !== meta.format) throw new Error('Preview readback failed');
        optional.push({ path: 'assets/' + entry.rel, bytes: original.length, sha256: digest(original),
          baseBytes: staged.length, baseSha256: digest(staged), width: check.width, height: check.height });
      }
    }
    // Re-encode large static portraits losslessly. Keep original dimensions,
    // pixels, format and URLs; cache by input bytes to avoid repeat build work.
    if (canPackPng(entry.rel) && staged.length > 256 * 1024) {
      const cache = child(pngCache, digest(staged) + '-png9-rgb-v2.png');
      let packed: Buffer | null = null;
      if (fs.existsSync(cache) && fs.existsSync(cache + '.sha256')) {
        const bytes = readBytes(fs, cache);
        if (digest(bytes) === readBytes(fs, cache + '.sha256').toString('utf8')) packed = bytes;
      }
      if (!packed) {
        const input = sharp(staged, { limitInputPixels: 100_000_000 });
        const metadata = await input.metadata();
        if ((!metadata.pages || metadata.pages === 1) && metadata.depth === 'uchar' && metadata.space === 'srgb' && !metadata.icc) {
          packed = await input.keepMetadata().png({ compressionLevel: 9, adaptiveFiltering: true, palette: false }).toBuffer();
          writeAtomic(fs, cache, packed);
          writeAtomic(fs, cache + '.sha256', Buffer.from(digest(packed)));
        }
      }
      if (packed && packed.length < staged.length) {
        staged = packed;
        if (!local) writeAtomic(fs, targetFile, staged);
        const layer = optional.find(item => item.path === 'assets/' + entry.rel);
        if (layer) { layer.baseBytes = staged.length; layer.baseSha256 = digest(staged); }
      }
    }
    local?.stageAsset(entry.rel, staged);
    sourceBytes += original.length; baseBytes += staged.length;
  }
  const report = { schemaVersion: 1, kind: 'desktop-resource-layers', profile,
    files: entries.length, bundledBytes: baseBytes, fullResourceBytes: sourceBytes,
    optionalOriginalBytes: optional.reduce((sum, item) => sum + item.bytes, 0),
    firstRequiredDownloadBytes: 0, optional, preservesOriginalUrls: true,
    note: 'Byte/decoder checks only; actual image quality and Windows display acceptance are separate.' };
  const bytes = Buffer.from(JSON.stringify(report, null, 2) + '\n');
  if (local) local.stageReport(bytes);
  else writeAtomic(fs, path.join(gatewayRoot, 'resource-layers.json'), bytes);
  return report;
}
export = { applyResourceProfile, includeAsset, profileTransformsAsset };
