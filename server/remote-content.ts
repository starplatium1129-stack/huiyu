import type { RequestHandler } from 'express';
import type { GatewayConfig } from './config-types';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import security from './security';
import publicDataFiles from './public-data';

// A local operator supplies this review-bound index; URL/rating supplied by a
// requester never authorizes content. No index means no remote content release.
type ReleasedResource = {
  url: string; rating: 'All'; sha256: string; bytes: number;
  reviewedAt: string;
};
type RemoteRelease = { version: 1; resources: ReleasedResource[] };
const MAX_JSON = 16 * 1024 * 1024;
const MAX_IMAGE = 32 * 1024 * 1024;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const digestPattern = /^[a-f0-9]{64}$/;

function namespace(raw: string): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(raw); } catch { return null; }
  // Windows static serving accepts backslashes too. Detect the namespace before
  // rejecting aliases, including case, dot segments and encoded separators.
  const normalized = path.posix.normalize(decoded.replace(/\\/g, '/'));
  return /^\/(data|assets|character-references|scene-showcase)(?:\/|$)/i.exec(normalized)?.[1]?.toLowerCase() || null;
}

function canonical(raw: string): boolean {
  return !/[\\%\x00-\x1f:?#]/.test(raw) && raw === path.posix.normalize(raw)
    && !raw.split('/').slice(1).some(segment => !segment || segment.startsWith('.'));
}

async function readBounded(file: string, max: number): Promise<Buffer> {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > max) throw new Error('Invalid resource size');
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    if (offset !== stat.size) throw new Error('Resource changed during read');
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}

async function rootedFile(root: string, relative: string): Promise<string> {
  const [base, file] = await Promise.all([fs.realpath(root), fs.realpath(path.join(root, relative))]);
  const rel = path.relative(base, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Resource outside root');
  return file;
}

// Review projections only contain directory metadata. Deliberately allowlist
// fields rather than deleting a few known secret/prompt fields from full data.
function directoryProjection(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(directoryProjection).filter(item => item !== null);
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (row.rating !== 'All' || typeof row.id !== 'string' || !row.id.trim()
    || ['mature', 'isNsfw', 'nsfw'].some(key => row[key] !== undefined && row[key] !== false)) return null;
  const output: Record<string, unknown> = { id: row.id, rating: 'All' };
  for (const key of ['name', 'nameZh', 'title', 'titleZh', 'franchise', 'category', 'character', 'char', 'type']) {
    if (typeof row[key] === 'string') output[key] = row[key];
  }
  return output;
}

function projectData(name: string, value: unknown): unknown {
  if (name === 'popular-characters.json') {
    const rows = value && typeof value === 'object' ? (value as Record<string, unknown>).characters : null;
    return { characters: Array.isArray(rows) ? directoryProjection(rows) : [] };
  }
  if (name === 'manifest.json') {
    const rows = value && typeof value === 'object' ? (value as Record<string, unknown>).entries : null;
    return { entries: Array.isArray(rows) ? directoryProjection(rows) : [] };
  }
  return Array.isArray(value) ? directoryProjection(value) : [];
}

export function createRemoteContent(config: GatewayConfig): RequestHandler {
  return async (req, res, next) => {
    const domain = namespace(req.path);
    if (!domain) return next();
    // Never permit a shared cache to reuse a local source response remotely.
    res.setHeader('Cache-Control', 'private, no-store');
    res.vary('X-Token');
    res.vary('Cookie');
    res.vary('X-Forwarded-For');
    if (security.isDirectLocalRequest(req)) return next();
    const deny = () => res.status(403).json({ ok: false, code: 'CONTENT_NOT_PUBLISHED', error: '此内容尚未审核为远程可用，请在本机工作室查看。' });
    if (!canonical(req.path) || !/^(GET|HEAD)$/.test(req.method)) { deny(); return; }
    // Reference releases have a separate review contract and remain local-only.
    if (domain === 'character-references' || req.path === '/data/character-reference-view.json') { deny(); return; }
    try {
      const indexFile = path.join(config.RUNTIME_ROOT, 'state', 'remote-content-release.json');
      const indexBytes = await readBounded(indexFile, MAX_JSON);
      const release: RemoteRelease = JSON.parse(indexBytes.toString('utf8'));
      if (release.version !== 1 || !Array.isArray(release.resources)) { deny(); return; }
      const matches = release.resources.filter(entry => entry.url === req.path);
      const entry = matches[0];
      if (matches.length !== 1 || !entry || entry.rating !== 'All' || !digestPattern.test(entry.sha256)
        || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || !Number.isFinite(Date.parse(entry.reviewedAt))) { deny(); return; }
      let root: string;
      let relative: string;
      let jsonName: string | null = null;
      if (domain === 'data') {
        relative = req.path.slice('/data/'.length);
        if (!publicDataFiles.includes(relative)) { deny(); return; }
        root = path.join(config.ROOT_DIR, 'data');
        jsonName = relative;
      } else if (domain === 'scene-showcase') {
        if (!config.SCENE_SHOWCASE_DIR) { deny(); return; }
        root = config.SCENE_SHOWCASE_DIR;
        relative = req.path.slice('/scene-showcase/'.length);
        if (relative === 'manifest.json') jsonName = relative;
      } else {
        root = config.ASSETS_ROOT;
        relative = req.path.slice('/assets/'.length);
        // Private model candidates must never be published through this index.
        if (/^live2d-candidates(?:\/|$)/i.test(relative)) { deny(); return; }
      }
      if (!jsonName && !/\.(png|jpe?g|webp|avif)$/i.test(relative)) { deny(); return; }
      const maximum = jsonName ? MAX_JSON : MAX_IMAGE;
      if (entry.bytes > maximum) { deny(); return; }
      const bytes = await readBounded(await rootedFile(root, relative), maximum);
      if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256) { deny(); return; }
      // Revalidate review bytes before publishing: revocation during I/O must
      // not serve a now-unapproved resource. Serve checked bytes, never sendFile.
      if (!indexBytes.equals(await readBounded(indexFile, MAX_JSON))) { deny(); return; }
      if (jsonName) {
        res.json(projectData(jsonName, JSON.parse(bytes.toString('utf8'))));
      } else {
        res.type(path.extname(relative)).send(bytes);
      }
    } catch { deny(); }
  };
}

export { directoryProjection };
