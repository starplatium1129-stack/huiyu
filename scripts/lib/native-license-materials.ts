/** Byte preservation for this pinned native dependency audit, not a general
 * repository exemption mechanism. The caller supplies index or worktree bytes. */
import fs = require('node:fs');
import path = require('node:path');
import crypto = require('node:crypto');
import safe = require('./delivery-paths');

export const NATIVE_MANIFEST = 'runtime-rs/native-dependencies.windows-x64.json';
export const MATERIAL_ROOT = 'runtime-rs/native-licenses/';
export const MATERIAL_INDEX = `${MATERIAL_ROOT}materials.sha256.json`;
export type ReadNativeMaterial = (relativePath: string) => Buffer | null;
export interface NativeLicenseMaterial {
  readonly bytes: number;
  readonly sha256: string;
  readonly preserveBytes: boolean;
}

const RAW_DIRECTORIES = [
  'components/', 'build-win64-mxe-v8.18.6/', 'mxe-d973945/', 'libvips-8.18.6-release/',
];
const RAW_FILES = new Set([
  'build-win64-mxe-v8.18.6-evidence.json', 'components.json', 'GPL-3.0.txt', 'LGPL-3.0.txt',
  'libnsgif-vips-8.18.6-COPYING', 'libnsgif-vips-8.18.6-README.md',
  'libnsgif-vips-8.18.6-update.sh', 'librsvg-2.62.91-cargo-sources.json',
  'libvips-8.18.6-release-evidence.json', 'MPL-2.0.txt', 'onnxruntime-LICENSE.txt',
  'onnxruntime-ThirdPartyNotices.txt', 'sharp-libvips-third-party-README.md',
  'sharp-libvips-v1.3.3-THIRD-PARTY-NOTICES.md', 'sharp-libvips-v1.3.3-versions.properties',
  'sharp-libvips-v1.3.3-win.sh', 'sharp-libvips-versions.json', 'sharp-package-LICENSE.txt',
  'supplemental-evidence.json',
]);

/** This predicate alone grants nothing: callers must also find a descriptor
 * from the same tree's verified index and check the exact blob bytes. */
export function shouldPreserveMaterial(relativePath: string): boolean {
  if (relativePath === MATERIAL_INDEX) return true;
  if (!relativePath.startsWith(MATERIAL_ROOT)) return false;
  const file = relativePath.slice(MATERIAL_ROOT.length);
  return RAW_FILES.has(file) || RAW_DIRECTORIES.some(directory => file.startsWith(directory));
}

function digest(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function json(bytes: Buffer, label: string): Record<string, unknown> {
  try { return object(JSON.parse(bytes.toString('utf8')), label); }
  catch (error) { throw new Error(`${label} is not valid JSON metadata`, { cause: error }); }
}
function relative(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.includes('\\') || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value) || path.posix.normalize(value) !== value) {
    throw new Error(`${label} must use a safe relative POSIX path`);
  }
  for (const part of value.split('/')) {
    if (!part || part === '.' || part === '..' || /[\x00-\x1f\x7f:*?"<>|]/.test(part)
      || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) {
      throw new Error(`${label} contains an unsafe path component`);
    }
  }
  return value;
}
function descriptor(bytes: unknown, sha256: unknown, label: string, preserveBytes: boolean): NativeLicenseMaterial {
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0
    || typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(`${label} must bind a byte length and lowercase SHA-256`);
  }
  return { bytes, sha256, preserveBytes };
}

/** Root absent is valid for an older Git index. Root present requires its own
 * exact index binding; never consult another tree or fall back to disk here. */
export function loadNativeLicenseMaterials(readFile: ReadNativeMaterial): Map<string, NativeLicenseMaterial> {
  const materials = new Map<string, NativeLicenseMaterial>();
  const manifestBytes = readFile(NATIVE_MANIFEST);
  if (manifestBytes === null) return materials;
  const manifest = json(manifestBytes, NATIVE_MANIFEST);
  const evidence = object(manifest.licenseEvidence, 'licenseEvidence');
  if (evidence.index !== 'native-licenses/materials.sha256.json') throw new Error('Unexpected native material index path');
  const binding = descriptor(evidence.indexBytes, evidence.indexSha256, MATERIAL_INDEX, true);
  materials.set(MATERIAL_INDEX, binding);
  const indexBytes = readFile(MATERIAL_INDEX);
  verifyNativeLicenseMaterial(materials, MATERIAL_INDEX, indexBytes);
  const index = json(indexBytes!, MATERIAL_INDEX);
  if (index.schemaVersion !== 1 || !Array.isArray(index.files)) throw new Error('Native material index schema is invalid');
  const names = new Set<string>(['materials.sha256.json']);
  for (const [position, value] of index.files.entries()) {
    const entry = object(value, `material ${position}`);
    const file = relative(entry.file, `material ${position}`);
    if (file.split('/').some(part => part.toLowerCase() === '.downloads')) throw new Error('Source archive cache cannot enter the material inventory');
    const key = file.toLowerCase();
    if (names.has(key)) throw new Error(`Duplicate or self-referencing native material: ${file}`);
    names.add(key);
    const preserve = shouldPreserveMaterial(`${MATERIAL_ROOT}${file}`);
    materials.set(`${MATERIAL_ROOT}${file}`, descriptor(entry.bytes, entry.sha256, file, preserve));
  }
  if (!Array.isArray(manifest.licenses)) throw new Error('Native dependency license references are missing');
  for (const value of manifest.licenses) {
    const entry = object(value, 'native license reference');
    const file = relative(entry.file, 'native license reference');
    if (!file.startsWith('native-licenses/')) throw new Error(`Native license reference escaped its directory: ${file}`);
    const expected = descriptor(entry.bytes, entry.sha256, file, true);
    const indexed = materials.get(`runtime-rs/${file}`);
    if (!indexed || indexed.bytes !== expected.bytes || indexed.sha256 !== expected.sha256) {
      throw new Error(`Native license reference disagrees with the material index: ${file}`);
    }
  }
  for (const key of ['readme', 'components', 'librsvgCargoSourceIndex']) {
    const file = relative(evidence[key], `licenseEvidence.${key}`);
    if (!file.startsWith('native-licenses/') || !materials.has(`runtime-rs/${file}`)) {
      throw new Error(`Unbound native evidence reference: ${file}`);
    }
  }
  if (evidence.embeddedLibnsgif) {
    const embedded = object(evidence.embeddedLibnsgif, 'embedded libnsgif evidence');
    const file = relative(embedded.notice, 'embedded libnsgif notice');
    if (!file.startsWith('native-licenses/') || !materials.has(`runtime-rs/${file}`)) throw new Error(`Unbound embedded notice: ${file}`);
  }
  for (const [file] of materials) verifyNativeLicenseMaterial(materials, file, readFile(file));
  return materials;
}

/** Check the supplied blob from the same tree as its manifest, including files
 * normally checked as source. Only a matching raw-material blob is exempt. */
export function verifyNativeLicenseMaterial(
  materials: ReadonlyMap<string, NativeLicenseMaterial>, relativePath: string, bytes: Buffer | null,
): boolean {
  const expected = materials.get(relativePath);
  if (!expected) return false;
  if (bytes === null) throw new Error(`Native material is missing: ${relativePath}`);
  if (bytes.length !== expected.bytes || digest(bytes) !== expected.sha256) {
    throw new Error(`Native material byte length or SHA-256 changed: ${relativePath}`);
  }
  return expected.preserveBytes;
}

/** Used by the standalone check. Hygiene's Git-index reader should supply its
 * own blobs instead, preserving each index/worktree/untracked target boundary. */
export function readNativeMaterialFromWorktree(repositoryRoot: string): ReadNativeMaterial {
  const root = fs.realpathSync(repositoryRoot);
  return relativePath => {
    const name = relative(relativePath, 'repository material path');
    const entry = safe.fileEntry(root, name);
    if (entry.status === 'missing') return null;
    if (entry.status !== 'file') throw new Error(`Native material is unsafe or unreadable: ${name}`);
    const bytes = fs.readFileSync(safe.resolveSafe(root, name));
    if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256) throw new Error(`Native material changed while reading: ${name}`);
    return bytes;
  };
}

export function validateNativeLicenseMaterials(readFile: ReadNativeMaterial): { files: number; preserved: number } {
  const materials = loadNativeLicenseMaterials(readFile);
  let preserved = 0;
  for (const [file] of materials) {
    if (verifyNativeLicenseMaterial(materials, file, readFile(file))) preserved++;
  }
  return { files: materials.size, preserved };
}
