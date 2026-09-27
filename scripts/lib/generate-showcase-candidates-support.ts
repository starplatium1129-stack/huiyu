'use strict';

// generate-showcase-candidates: file validation and candidate identifiers.
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const crypto: typeof import('crypto') = require('crypto');
const { SCENE_SHOWCASE_DIR, AI_ROOT }: typeof import('./generate-showcase-candidates-settings.js') = require('./generate-showcase-candidates-settings.js');

// ── helpers ────────────────────────────────────────────────────────────────

function argument(name: any, fallback: any = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function splitList(value: any) { return String(value || '').split(',').map((item: any) => item.trim()).filter(Boolean); }

function stableSeed(key: any) {
  const digest = crypto.createHash('sha256').update(`showcase-candidates-2026-08-12:${key}`).digest();
  return digest.readUInt32BE(0) & 0x7fffffff;
}

function writeJsonAtomic(file: any, value: any) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}

function shouldReuse(record: any, imagePath: any, force: any) {
  if (force || !record || record.status !== 'succeeded' || !record.image) return false;
  if (!fs.existsSync(imagePath)) return false;
  try { return fs.statSync(imagePath).size > 1000; } catch (error) { return false; }
}

/**
 * Guard against ever writing into the public showcase directory. Both the
 * default and any explicit --output are validated at plan time and at write
 * time. The realpath resolution keeps `..`-style tricks from bypassing it.
 */
function assertNotShowcase(outputDir: any) {
  const resolved = path.resolve(outputDir);
  const candidates = [
    path.resolve(SCENE_SHOWCASE_DIR),
    path.resolve(AI_ROOT, 'SceneShowcase', '2026-07-22_v14'),
  ];
  for (const base of candidates) {
    if (resolved === base || resolved.startsWith(base + path.sep)) {
      throw new Error(`refusing to write candidates into the public showcase directory: ${outputDir}`);
    }
  }
  return resolved;
}

// ── image mechanical inspection (magic + dimensions, no visual judgement) ───

function pngInfo(buffer: any) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(sig)) return null;
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { mime: 'image/png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function jpegInfo(buffer: any) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) break;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return { mime: 'image/jpeg', width, height };
    }
    offset += 2 + length;
  }
  return { mime: 'image/jpeg', width: 0, height: 0 };
}

function webpInfo(buffer: any) {
  if (buffer.length < 30 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') return null;
  const tag = buffer.toString('ascii', 12, 16);
  if (tag === 'VP8X') {
    const width = 1 + buffer.readUIntLE(24, 3);
    const height = 1 + buffer.readUIntLE(27, 3);
    return { mime: 'image/webp', width, height };
  }
  if (tag === 'VP8 ' && buffer.length >= 30) {
    return { mime: 'image/webp', width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (tag === 'VP8L' && buffer.length >= 25) {
    const bits = buffer.readUInt32LE(21);
    return { mime: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return { mime: 'image/webp', width: 0, height: 0 };
}

function imageInfo(buffer: any) {
  return pngInfo(buffer) || jpegInfo(buffer) || webpInfo(buffer) || null;
}

// ── main ───────────────────────────────────────────────────────────────────

function recordIdOf(candidate: any) {
  return candidate.recordId || `${candidate.key}@attempt-${candidate.attempt || 1}`;
}

function imageRelFor(candidate: any) {
  const base = candidate.key.replace(/[:\/\\]/g, '_');
  const attemptSuffix = candidate.attempt > 1 ? `_attempt-${candidate.attempt}` : '';
  return `images/${candidate.batch}/${base}${attemptSuffix}.png`;
}

export = {
  stableSeed, splitList, argument, assertNotShowcase, recordIdOf, shouldReuse, imageRelFor,
  writeJsonAtomic, imageInfo,
};
