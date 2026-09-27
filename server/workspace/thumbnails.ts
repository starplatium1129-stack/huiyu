import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { assertSafePath } from './paths';

export interface ThumbnailSource { file: string; sha256: string; mime: string }
const CACHE_DIRECTORY = 'cache/thumbnails-v1';
export function thumbnailPath(root: string, sha256: string): string {
  return assertSafePath(root, `${CACHE_DIRECTORY}/${sha256}.jpg`);
}

/** Derived, disposable bytes: never a second media authority or part of backups.
 * The caller resolves the alias and verifies the immutable original before every
 * read. Bump the cache version when changing dimensions, format or quality. */
export async function readWorkspaceThumbnail(root: string, source: ThumbnailSource, checkCancelled: () => void): Promise<string | null> {
  if (!source.mime.startsWith('image/')) return null;
  checkCancelled();
  const file = thumbnailPath(root, source.sha256);
  let bytes: Buffer | undefined;
  try { bytes = fs.readFileSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!bytes) {
    // Match the existing browser decode budget. Native decode is bounded even
    // when a disconnected client can only discard its result after decoding.
    const image = sharp(source.file, { limitInputPixels: 32 * 1024 * 1024, animated: false });
    try {
      const metadata = await image.metadata();
      checkCancelled();
      if (!metadata.width || !metadata.height || metadata.width > 8192 || metadata.height > 8192) return null;
      bytes = await image.rotate().resize({ width: 560, withoutEnlargement: true })
        .flatten({ background: '#000000' }).jpeg({ quality: 82 }).timeout({ seconds: 5 }).toBuffer();
    } finally { image.destroy(); }
    checkCancelled();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = assertSafePath(root, `${CACHE_DIRECTORY}/${source.sha256}.${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, bytes, { flag: 'wx' });
      fs.renameSync(temporary, file);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  checkCancelled();
  return `data:image/jpeg;base64,${bytes.toString('base64')}`;
}
