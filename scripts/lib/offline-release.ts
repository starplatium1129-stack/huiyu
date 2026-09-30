'use strict';

// Build inputs are explicit. Export only files used by the current viewer; never
// discover private references, local model candidates, user art or review attempts.
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const { child, noLinks, readBytes, digest, within, mkdir, writeAtomic, relativePath }: typeof import('./resource-install-fs') = require('./resource-install-fs');
const { serviceable }: typeof import('./resource-install-resolver') = require('./resource-install-resolver');
const { manifest, packageIdentity }: typeof import('./resource-install-policy') = require('./resource-install-policy');
const { manifestContentIdentity }: typeof import('./resource-pack-delta') = require('./resource-pack-delta');

interface Entry { path: string; bytes: number; sha256: string }
interface Input { path: string; source?: string; contents?: Buffer; entry: Entry }
interface Options { root: string; showcaseRoot: string; releaseId: string; destination: string }
const SAMPLE = /^(?:images|thumbs)\/(?:sc\d{3,}|artist_[a-zA-Z0-9_-]+|pc_[a-zA-Z0-9_-]+|lora_[a-zA-Z0-9_-]+)\.(?:jpg|png|webp)$/;
function json(value: unknown) { return Buffer.from(JSON.stringify(value, null, 2) + '\n'); }
function fileEntry(source: string, rel: string): Input {
  relativePath(rel);
  const stat = noLinks(fs, source);
  if (!stat?.isFile()) throw new Error('Expected an ordinary file: ' + rel);
  const bytes = readBytes(fs, source, stat.size);
  return { path: rel, source, entry: { path: rel, bytes: bytes.length, sha256: digest(bytes) } };
}
function generated(rel: string, contents: Buffer): Input {
  return { path: rel, contents, entry: { path: rel, bytes: contents.length, sha256: digest(contents) } };
}
function entries(inputs: Input[], prefix: string): Entry[] {
  return inputs.map(input => ({ ...input.entry, path: input.path.slice(prefix.length) }));
}
function assertDirectory(directory: string) {
  if (!path.isAbsolute(directory) || !noLinks(fs, directory)?.isDirectory()) throw new Error('Existing absolute directory required: ' + directory);
}
function planRelease(options: Options) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(options.releaseId)) throw new Error('Release ID must be 1–64 safe ASCII characters');
  const root = path.resolve(options.root), showcaseRoot = path.resolve(options.showcaseRoot);
  assertDirectory(root); assertDirectory(showcaseRoot);
  const destination = path.resolve(options.destination);
  if ([root, showcaseRoot].some(source => within(source, destination) || within(destination, source))) {
    throw new Error('Release output must be separate from source project and showcase');
  }
  if (noLinks(fs, destination, { missing: true })) throw new Error('Release output already exists');
  const inputs: Input[] = [];
  const walk = (dir: string, prefix: string) => {
    noLinks(fs, dir);
    for (const name of fs.readdirSync(dir).sort()) {
      const rel = prefix + name;
      if (/^assets\/(?:character-references|live2d-candidates)(?:\/|$)/i.test(rel) || name.startsWith('.')) continue;
      const source = child(root, rel), stat = noLinks(fs, source);
      if (stat?.isDirectory()) walk(source, rel + '/');
      else if (serviceable(rel)) inputs.push(fileEntry(source, 'pack/' + rel));
    }
  };
  walk(child(root, 'assets'), 'assets/');
  if (!inputs.length) throw new Error('At least one serviceable public resource is required');
  const resourceManifest = manifest({ schemaVersion: 1, kind: 'resource-manifest', entries: entries(inputs, 'pack/'), unverified: [] });
  const raw = json(resourceManifest);
  inputs.push(generated('pack/manifest.json', raw));
  const sourceManifest = fileEntry(child(showcaseRoot, 'manifest.json'), 'showcase/manifest.json');
  const showcase = JSON.parse(readBytes(fs, sourceManifest.source!, sourceManifest.entry.bytes).toString('utf8'));
  if (!Array.isArray(showcase.entries) || !showcase.entries.length) throw new Error('A nonempty published showcase entries array is required');
  const names = new Set<string>(), ids = new Set<string>();
  const counts: Record<string, number> = {};
  const ratings: Record<string, number> = {};
  const showcaseInputs = [sourceManifest];
  for (const item of showcase.entries) {
    if (!item || typeof item.id !== 'string' || ids.has(item.id.toLowerCase()) || !['All', 'R15', 'R18'].includes(item.rating)) throw new Error('Invalid or duplicate showcase entry');
    ids.add(item.id.toLowerCase());
    counts[item.type || 'scene'] = (counts[item.type || 'scene'] || 0) + 1;
    ratings[item.rating] = (ratings[item.rating] || 0) + 1;
    for (const [kind, folder] of [['image', 'images'], ['thumb', 'thumbs']] as const) {
      const rel = item[kind] ?? `${folder}/${item.id}.jpg`;
      if (typeof rel !== 'string' || !SAMPLE.test(rel) || !rel.startsWith(folder + '/')) throw new Error('Unsafe or unsupported showcase path');
      relativePath(rel);
      if (names.has(rel.toLowerCase())) throw new Error('Duplicate showcase file path');
      names.add(rel.toLowerCase());
      showcaseInputs.push(fileEntry(child(showcaseRoot, rel), 'showcase/' + rel));
    }
  }
  inputs.push(...showcaseInputs);
  inputs.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const metadata = {
    schemaVersion: 1, kind: 'huiyu-offline-release', releaseId: options.releaseId,
    appVersion: JSON.parse(readBytes(fs, child(root, 'package.json')).toString('utf8')).version,
    resourcePack: { path: 'pack', packageIdentity: packageIdentity(raw), targetIdentity: manifestContentIdentity(resourceManifest) },
    showcase: { path: 'showcase', entries: entries(showcaseInputs, 'showcase/'), contentIdentity: manifestContentIdentity({ entries: entries(showcaseInputs, 'showcase/') }) },
    files: inputs.map(input => input.entry),
  };
  const releaseBytes = json(metadata);
  return { options: { ...options, root, showcaseRoot, destination }, inputs, releaseBytes,
    summary: { releaseId: options.releaseId, destination, resourceFiles: resourceManifest.entries.length,
      showcaseEntries: showcase.entries.length, showcaseTypes: counts, showcaseRatings: ratings,
      files: inputs.length + 1, bytes: inputs.reduce((total, item) => total + item.entry.bytes, releaseBytes.length),
      expectedReleaseSha256: digest(releaseBytes),
      note: 'Byte-complete current assets/showcase only. Model weights, upstream environments and private references are separate. Existing review/provenance are preserved; no new visual approval is asserted.' } };
}
async function applyRelease(plan: ReturnType<typeof planRelease>, signal?: AbortSignal) {
  const destination = plan.options.destination;
  if (noLinks(fs, destination, { missing: true })) throw new Error('Release output already exists');
  mkdir(fs, path.dirname(destination));
  const staging = fs.mkdtempSync(destination + '.staging-');
  const check = () => { if (signal?.aborted) throw new Error('CANCELLED'); };
  try {
    for (const input of [...plan.inputs, generated('release.json', plan.releaseBytes)]) {
      await new Promise<void>(resolve => setImmediate(resolve));
      check();
      const target = child(staging, input.path);
      const bytes = input.contents ?? readBytes(fs, input.source!, input.entry.bytes);
      if (bytes.length !== input.entry.bytes || digest(bytes) !== input.entry.sha256) throw new Error('Source changed after planning: ' + input.path);
      mkdir(fs, path.dirname(target)); writeAtomic(fs, target, bytes);
      const copied = readBytes(fs, target, input.entry.bytes);
      if (digest(copied) !== input.entry.sha256) throw new Error('Copied resource differs: ' + input.path);
    }
    check();
    if (noLinks(fs, destination, { missing: true })) throw new Error('Release output appeared during staging');
    if (process.platform !== 'win32') throw new Error('Atomic no-overwrite publication is currently Windows only');
    fs.renameSync(staging, destination);
    return { ...plan.summary, applied: true };
  } catch (error) {
    throw new Error(`Offline release incomplete; retained staging: ${staging}`, { cause: error });
  }
}
export = { planRelease, applyRelease };
