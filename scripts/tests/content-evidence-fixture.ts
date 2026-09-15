'use strict';
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const crypto: typeof import('node:crypto') = require('node:crypto');
const hash = (value: string|Buffer<ArrayBuffer>|NodeJS.ArrayBufferView<ArrayBufferLike>) => crypto.createHash('sha256').update(value).digest('hex');
const jsonHash = (value: { sources?: { path: string; sha256: string; bytes: number; }[]; recipeSource?: { path: string; sha256: string; }; key?: string; metadata?: { batch: string; engine: string; characterId: string; charName: string; outfitId: string; outfitName: string; persId: string; persName: string; intendedReferencePath: string; }; recipe?: { prompt: string; width: number; height: number; }; prompt?: string; width?: number; height?: number; seed?: number; schemaVersion?: number; generator?: string; runId?: `${string}-${string}-${string}-${string}-${string}`; candidateId?: `${string}-${string}-${string}-${string}-${string}`; recordId?: string; attempt?: number; status?: string; review?: { verdict: string; recordId: string; }; createdAt?: string; inputVersion?: string; payload?: { prompt: string; width: number; height: number; seed: number; }; payloadSha256?: string; image?: string; asset?: { path: string; bytes: number; sha256: string; }; batch?: string; engine?: string; characterId?: string; charName?: string; outfitId?: string; outfitName?: string; persId?: string; persName?: string; intendedReferencePath?: string; }) => hash(JSON.stringify(value));

function fixture(t: any) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'content-evidence-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'source');
  const candidateRoot = path.join(base, 'candidates');
  const publishedRoot = path.join(base, 'published');
  const put = (directory: string, file: string, value: string|Buffer<ArrayBuffer>|NodeJS.ArrayBufferView<ArrayBufferLike>|{ schemaVersion: number; generator: string; runId: `${string}-${string}-${string}-${string}-${string}`; candidateId: `${string}-${string}-${string}-${string}-${string}`; key: string; recordId: string; attempt: number; status: string; review: { verdict: string; recordId: string; }; createdAt: string; sources: { path: string; sha256: string; bytes: number; }[]; recipeSource: { path: string; sha256: string; }; inputVersion: string; payload: { prompt: string; width: number; height: number; seed: number; }; payloadSha256: string; image: string; asset: { path: string; bytes: number; sha256: string; }; batch: string; engine: string; characterId: string; charName: string; outfitId: string; outfitName: string; persId: string; persName: string; intendedReferencePath: string; }[]) => {
    const target = path.join(directory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
  };
  const sourceFile = 'data/neutral.json';
  const recipe = 'scripts/maintenance/render-all-outfits-references.js';
  put(root, sourceFile, { id: 'object', version: 1, description: 'Neutral fixture metadata' });
  put(root, recipe, 'throw new Error("fixture recipe must never execute");\n');
  const read = (directory: string, file: string) => fs.readFileSync(path.join(directory, file));
  const runId = crypto.randomUUID(), candidateId = crypto.randomUUID();
  const generator = 'render-all-outfits-references.js';
  put(candidateRoot, 'candidate-run.json', { schemaVersion: 1, kind: 'generation-candidates', runId, generator });
  const sources = [{ path: path.join(root, sourceFile), sha256: hash(read(root, sourceFile)), bytes: read(root, sourceFile).length }];
  const recipeSource = { path: path.join(root, recipe), sha256: hash(read(root, recipe)) };
  const metadata = { batch: 'reference', engine: 'anima', characterId: 'object', charName: 'Object', outfitId: 'coat', outfitName: 'Coat',
    persId: 'front', persName: 'Front', intendedReferencePath: 'object/coat/front.png' };
  const key = 'reference:object:coat:front';
  const payload = { prompt: 'NEUTRAL_PRIVATE_FIXTURE_PAYLOAD', width: 512, height: 512, seed: 100 };
  const recipePayload = { prompt: payload.prompt, width: 512, height: 512 };
  const inputVersion = jsonHash({ sources, recipeSource, key, metadata, recipe: recipePayload });
  const recordId = `${key}@attempt-1-${candidateId}`;
  const image = `images/${candidateId}.png`;
  // Deliberately generic binary bytes: the auditor must certify bytes, not claim
  // that a PNG decoder or visual review ran.
  const imageBytes = Buffer.from([0, 255, 1, 128, 5, 7, 9, 13, 17, 31]);
  put(candidateRoot, image, imageBytes);
  const record = { ...metadata, schemaVersion: 1, generator, runId, candidateId, key, recordId, attempt: 1,
    status: 'succeeded', review: { verdict: 'pending', recordId }, createdAt: '2026-09-01T00:00:00Z',
    sources, recipeSource, inputVersion, payload, payloadSha256: jsonHash(payload), image,
    asset: { path: image, bytes: imageBytes.length, sha256: hash(imageBytes) } };
  const exportRecords = (records: any = [record]) => {
    for (const item of records) put(candidateRoot, `records/${item.candidateId}.json`, item);
    put(candidateRoot, 'generation-manifest.json', records);
  };
  exportRecords();
  const decision = { verdict: 'pass', recordId, recordSha256: jsonHash(record), sha256: record.asset.sha256,
    inputVersion, reviewedAt: '2026-09-02T00:00:00Z', notes: 'PRIVATE_REVIEW_NOTES' };
  const decisions = { schemaVersion: 1, kind: 'content-human-review', runId,
    manifestSha256: hash(read(candidateRoot, 'generation-manifest.json')), records: { [key]: decision } };
  put(candidateRoot, 'decisions.json', decisions);
  const publication = { schemaVersion: 1, kind: 'content-publication-evidence', runId,
    manifestSha256: decisions.manifestSha256, reviewSha256: hash(read(candidateRoot, 'decisions.json')),
    records: { [key]: { recordId, recordSha256: jsonHash(record), inputVersion, sha256: record.asset.sha256,
      bytes: imageBytes.length, path: 'objects/front.bin', publishedAt: '2026-09-03T00:00:00Z' } } };
  put(candidateRoot, 'publication.json', publication);
  put(publishedRoot, 'objects/front.bin', imageBytes);
  const options = { root, candidateRoot, manifest: 'generation-manifest.json', sources: [sourceFile], recipe,
    decisions: 'decisions.json' };
  return { base, root, candidateRoot, publishedRoot, record, decisions, publication, options, exportRecords,
    put: (file: string, value: string|Buffer<ArrayBuffer>|NodeJS.ArrayBufferView<ArrayBufferLike>|{ schemaVersion: number; generator: string; runId: `${string}-${string}-${string}-${string}-${string}`; candidateId: `${string}-${string}-${string}-${string}-${string}`; key: string; recordId: string; attempt: number; status: string; review: { verdict: string; recordId: string; }; createdAt: string; sources: { path: string; sha256: string; bytes: number; }[]; recipeSource: { path: string; sha256: string; }; inputVersion: string; payload: { prompt: string; width: number; height: number; seed: number; }; payloadSha256: string; image: string; asset: { path: string; bytes: number; sha256: string; }; batch: string; engine: string; characterId: string; charName: string; outfitId: string; outfitName: string; persId: string; persName: string; intendedReferencePath: string; }[]) => put(candidateRoot, file, value), source: (file: string, value: string|Buffer<ArrayBuffer>|NodeJS.ArrayBufferView<ArrayBufferLike>|{ schemaVersion: number; generator: string; runId: `${string}-${string}-${string}-${string}-${string}`; candidateId: `${string}-${string}-${string}-${string}-${string}`; key: string; recordId: string; attempt: number; status: string; review: { verdict: string; recordId: string; }; createdAt: string; sources: { path: string; sha256: string; bytes: number; }[]; recipeSource: { path: string; sha256: string; }; inputVersion: string; payload: { prompt: string; width: number; height: number; seed: number; }; payloadSha256: string; image: string; asset: { path: string; bytes: number; sha256: string; }; batch: string; engine: string; characterId: string; charName: string; outfitId: string; outfitName: string; persId: string; persName: string; intendedReferencePath: string; }[]) => put(root, file, value), read };
}
export = { fixture, hash, jsonHash };
