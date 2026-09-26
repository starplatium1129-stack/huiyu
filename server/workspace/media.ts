import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertSafePath, syncDirectory } from './paths';
import { WorkspaceError } from './types';

export interface StoredMedia { alias: string; sha256: string; bytes: number; mime: string }
export const MAX_CHUNK_BYTES = 1024 * 1024;
export const digest = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export function mediaPath(root: string, hash: string): string {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new WorkspaceError('MEDIA_INVALID', 'Invalid media digest');
  return assertSafePath(root, `media/objects/${hash.slice(0, 2)}/${hash}`);
}

export function stagingPath(root: string, operationKey: string, alias: string): string {
  if (!/^[a-f0-9]{64}$/.test(operationKey)) throw new WorkspaceError('MEDIA_INVALID', 'Invalid operation identity');
  return assertSafePath(root, `media/staging/${operationKey}/${digest(alias)}`);
}

function openFile(root: string, file: string, flags: string): number {
  assertSafePath(root, path.relative(root, file));
  const fd = fs.openSync(file, flags);
  if (!fs.fstatSync(fd).isFile()) {
    fs.closeSync(fd);
    throw new WorkspaceError('MEDIA_INVALID', 'Media is not a regular file');
  }
  return fd;
}

export function checkAvailableSpace(root: string, bytes: number): void {
  const space = fs.statfsSync(root);
  if (space.bavail * space.bsize < bytes + 1024 * 1024) {
    throw new WorkspaceError('STORAGE_UNAVAILABLE', 'Insufficient space for workspace media');
  }
}

export function detectedMime(header: Buffer): string | undefined {
  if (header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(header.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (header.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = header.subarray(8, 12).toString('ascii');
    if (['avif', 'avis'].includes(brand)) return 'image/avif';
    if (['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V '].includes(brand)) return 'video/mp4';
  }
  if (header.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex')) && header.includes(Buffer.from('webm'))) return 'video/webm';
  return undefined;
}

export function verifyMedia(root: string, file: string, media: Pick<StoredMedia, 'sha256' | 'bytes' | 'mime'>, checkCancelled = () => {}): void {
  const fd = openFile(root, file, 'r');
  try {
    if (fs.fstatSync(fd).size !== media.bytes) throw new WorkspaceError('MEDIA_INVALID', 'Media byte length does not match');
    const hash = createHash('sha256');
    const chunk = Buffer.alloc(MAX_CHUNK_BYTES);
    let offset = 0;
    let header: Buffer | undefined;
    for (;;) {
      checkCancelled();
      const count = fs.readSync(fd, chunk, 0, chunk.length, offset);
      if (!count) break;
      if (!header) header = Buffer.from(chunk.subarray(0, Math.min(count, 4096)));
      hash.update(chunk.subarray(0, count));
      offset += count;
    }
    if (hash.digest('hex') !== media.sha256 || detectedMime(header ?? Buffer.alloc(0)) !== media.mime) {
      throw new WorkspaceError('MEDIA_INVALID', 'Media digest or actual file type does not match');
    }
  } finally { fs.closeSync(fd); }
}

export function uploadMediaChunk(root: string, operationKey: string, media: StoredMedia,
  offset: number, bytes: Uint8Array): number {
  if (!Number.isSafeInteger(offset) || offset < 0 || bytes.length === 0 || bytes.length > MAX_CHUNK_BYTES
    || offset + bytes.length > media.bytes) throw new WorkspaceError('MEDIA_INVALID', 'Invalid media chunk');
  const file = stagingPath(root, operationKey, media.alias);
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  assertSafePath(root, path.relative(root, directory));
  const fd = openFile(root, file, fs.existsSync(file) ? 'r+' : 'wx+');
  try {
    const currentLength = fs.fstatSync(fd).size;
    if (offset < currentLength) {
      if (offset + bytes.length > currentLength) throw new WorkspaceError('OPERATION_CONFLICT', 'Chunk overlaps an incomplete boundary');
      const existing = Buffer.alloc(bytes.length);
      fs.readSync(fd, existing, 0, existing.length, offset);
      if (!existing.equals(Buffer.from(bytes))) throw new WorkspaceError('OPERATION_CONFLICT', 'Retried chunk differs from stored bytes');
      return currentLength;
    }
    if (offset !== currentLength) throw new WorkspaceError('OPERATION_CONFLICT', 'Chunk offset does not match uploaded length');
    let written = 0;
    while (written < bytes.length) written += fs.writeSync(fd, bytes, written, bytes.length - written, offset + written);
    fs.fsyncSync(fd);
    return currentLength + bytes.length;
  } finally { fs.closeSync(fd); }
}

/** Publishing uses an exclusive link: an existing object is verified and never replaced. */
export function publishMedia(root: string, operationKey: string, media: StoredMedia, checkCancelled = () => {}): void {
  const destination = mediaPath(root, media.sha256);
  if (fs.existsSync(destination)) { verifyMedia(root, destination, media, checkCancelled); return; }
  const staged = stagingPath(root, operationKey, media.alias);
  verifyMedia(root, staged, media, checkCancelled);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  assertSafePath(root, path.relative(root, destination));
  try { fs.linkSync(staged, destination); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    verifyMedia(root, destination, media, checkCancelled);
  }
  syncDirectory(path.dirname(destination));
}

export function uploadedBytes(root: string, operationKey: string, alias: string): number {
  const file = stagingPath(root, operationKey, alias);
  if (!fs.existsSync(file)) return 0;
  const fd = openFile(root, file, 'r');
  try { return fs.fstatSync(fd).size; } finally { fs.closeSync(fd); }
}
