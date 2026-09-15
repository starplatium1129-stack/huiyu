'use strict';

// Publication creates an immutable sibling version. The active directory and
// project indexes are never overwritten; configuration activation is explicit.
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const { randomUUID }: typeof import('node:crypto') = require('node:crypto');
const { CODE_ROOT, hash, noLinks }: typeof import('./generation-candidates') = require('./generation-candidates');
const { lockFile, writeJson, flushDir }: typeof import('./resource-install-fs') = require('./resource-install-fs');
const R: typeof import('./reference-candidate-review') = require('./reference-candidate-review');
const MARKER = 'reference-release.json';
const VIEW = 'character-reference-view.json';

function scanImages(root: any) {
  noLinks(root);
  if (!fs.statSync(root).isDirectory()) throw new Error('Reference source must be a directory');
  const files: any = [];
  function visit(directory: any, prefix = '') {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      const rel = prefix + name;
      noLinks(file);
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) visit(file, rel + '/');
      else if (!prefix && [MARKER, VIEW].includes(name)) continue;
      else {
        R.relativeImage(rel);
        const value = R.bytes(file);
        files.push({ path: rel, bytes: value.length, sha256: hash(value) });
      }
    }
  }
  visit(root);
  const keys = new Set();
  for (const file of files) {
    const key = file.path.toLowerCase();
    if (keys.has(key)) throw new Error('Reference paths collide on Windows');
    keys.add(key);
  }
  return files.sort((a: any, b: any) => a.path.localeCompare(b.path));
}

function seal(release: any) {
  return R.jsonHash({ files: release.files, viewSha256: release.viewSha256,
    sourceStandardsSha256: release.sourceStandardsSha256, sourceViewSha256: release.sourceViewSha256,
    candidateManifestSha256: release.candidateManifestSha256, reviewSha256: release.reviewSha256,
    baseIdentity: release.baseIdentity, ...(release.approvals ? { approvals: release.approvals } : {}) });
}

function validateView(view: any, files: any) {
  if (!view || typeof view !== 'object' || Array.isArray(view)) throw new Error('Invalid reference view');
  const available = new Set(files.map((file: any) => file.path));
  for (const character of Object.values(view)) {
    for (const outfit of character?.outfits || []) {
      for (const reference of outfit.references || []) {
        if (reference.pending || !reference.url?.startsWith('/character-references/')) continue;
        const rel = R.relativeImage(reference.url.slice('/character-references/'.length));
        if (!available.has(rel)) throw new Error('Published reference view points to a missing image: ' + rel);
      }
    }
  }
}

function resolveReferenceRelease(directory: any, { dataRoot = CODE_ROOT } = {}) {
  const root = path.resolve(directory);
  const marker = path.join(root, MARKER);
  noLinks(marker);
  if (!fs.existsSync(marker)) return null; // Existing unversioned libraries retain their old handling.
  const release = R.json(marker);
  if (release.schemaVersion !== 1 || release.kind !== 'reference-release' || !R.SHA.test(release.identity)
      || !Array.isArray(release.files) || seal(release) !== release.identity) throw new Error('Invalid reference release identity');
  const files = scanImages(root);
  if (R.jsonHash(files) !== R.jsonHash(release.files)) throw new Error('Reference release is incomplete or its bytes changed');
  const viewFile = path.join(root, VIEW);
  const viewBytes = R.bytes(viewFile);
  if (hash(viewBytes) !== release.viewSha256) throw new Error('Reference release index changed');
  const sourceView = path.join(dataRoot, 'data', VIEW);
  if (hash(R.bytes(sourceView)) !== release.sourceViewSha256
      || hash(R.bytes(path.join(dataRoot, R.SOURCE))) !== release.sourceStandardsSha256) throw new Error('Reference release belongs to a different source version');
  validateView(JSON.parse(viewBytes), files);
  return { referenceRoot: root, viewFile, identity: release.identity, release };
}

function paths(options: any, inspection: any) {
  const source = noLinks(path.resolve(options.source));
  const target = noLinks(path.resolve(options.target));
  if (R.within(source, target) || R.within(target, source)
      || R.within(inspection.directory, target) || R.within(target, inspection.directory)) throw new Error('Publication must use a separate new version directory');
  for (const root of [CODE_ROOT, inspection.sourceRoot]) {
    const archive = path.join(root, 'scripts/archive/reference-releases');
    if (R.within(target, root) || (R.within(root, target) && !R.within(archive, target))) throw new Error('Release output overlaps project sources or runtime files');
  }
  if (!fs.statSync(noLinks(path.dirname(target))).isDirectory()) throw new Error('Release parent directory must already exist');
  return { source, target };
}

function preparePublication(options: any) {
  const inspection = R.inspectCandidates(options);
  const review = R.json(path.resolve(options.review));
  const items = R.attachReview(inspection, review);
  const selected = paths(options, inspection);
  const base = resolveReferenceRelease(selected.source, { dataRoot: inspection.sourceRoot });
  const originals = scanImages(selected.source);
  const sourceView = R.bytes(path.join(inspection.sourceRoot, 'data', VIEW));
  const view = base ? R.json(base.viewFile) : JSON.parse(sourceView);
  const additions = items.filter((item: any) => item.integrity === 'pass' && item.review === 'pass');
  const approvals = new Map((base?.release.approvals || []).map((approval: any) => [approval.key, approval]));
  for (const item of additions) {
    const record = inspection.records.find(record => record.recordId === item.recordId);
    const outfits = view[record.characterId]?.outfits;
    const matches = Array.isArray(outfits) ? outfits.filter(outfit => outfit.outfitId === record.outfitId) : [];
    const refs = matches.length === 1 && Array.isArray(matches[0].references) ? matches[0].references.filter((reference: any) => reference.id === record.persId) : [];
    if (refs.length !== 1) throw new Error('Candidate target is absent or ambiguous in the current reference index: ' + item.key);
    Object.assign(refs[0], { url: '/character-references/' + item.intendedReferencePath,
      fileName: path.posix.basename(item.intendedReferencePath), pending: false });
    // Evidence belongs to the sealed release, not the strict runtime view schema.
    approvals.set(item.key, { key: item.key, path: item.intendedReferencePath,
      recordId: item.recordId, inputVersion: item.inputVersion, sha256: item.sha256,
      review: review.records[item.key], candidateManifestSha256: inspection.manifestSha256 });
  }
  const planned = new Map(originals.map((file: any) => [file.path, file]));
  for (const item of additions) {
    const record = inspection.records.find(record => record.recordId === item.recordId);
    planned.set(item.intendedReferencePath, { path: item.intendedReferencePath, bytes: record.asset.bytes, sha256: item.sha256 });
  }
  const files = [...planned.values()].sort((a, b) => a.path.localeCompare(b.path));
  if (new Set(files.map(file => file.path.toLowerCase())).size !== files.length) throw new Error('Publication paths collide on Windows');
  validateView(view, files);
  const viewBytes = Buffer.from(JSON.stringify(view, null, 2) + '\n');
  const release = { schemaVersion: 1, kind: 'reference-release', files,
    viewSha256: hash(viewBytes), sourceStandardsSha256: hash(R.bytes(inspection.sourceFile)),
    sourceViewSha256: hash(sourceView), candidateManifestSha256: inspection.manifestSha256,
    reviewSha256: hash(R.bytes(path.resolve(options.review))), baseIdentity: base?.identity || R.jsonHash(originals),
    approvals: [...approvals.values()].sort((a, b) => a.key.localeCompare(b.key)),
    createdAt: new Date().toISOString() };
  release.identity = seal(release);
  return { ...selected, inspection, items, originals, additions, viewBytes, release,
    ready: items.length > 0 && additions.length === items.length };
}

async function publishReferenceCandidates(options: any, deps = {}) {
  const plan = preparePublication(options);
  const summary = { mode: options.apply ? 'publish' : 'preview', target: plan.target, identity: plan.release.identity,
    candidates: plan.items.length, approved: plan.additions.length, ready: plan.ready,
    pending: plan.items.filter((item: any) => item.review === 'pending').map((item: any) => item.key),
    rejected: plan.items.filter((item: any) => item.integrity !== 'pass' || item.review === 'fail' || item.review === 'stale').map((item: any) => item.key),
    activation: 'Configure the gateway reference root explicitly; the active library and source indexes are unchanged.' };
  if (!options.apply) return { ...summary, exitCode: plan.ready ? 0 : 3 };
  if (!plan.ready) throw new Error('Every selected reference candidate must have current, explicit human approval');
  const store = noLinks(path.join(path.dirname(plan.target), '.aics-reference-publish'));
  if (!fs.existsSync(store)) fs.mkdirSync(store);
  const marker = path.join(store, 'store.json');
  if (!fs.existsSync(marker)) {
    if (fs.readdirSync(store).length) throw new Error('Unrecognized reference publication staging directory');
    fs.writeFileSync(marker, JSON.stringify({ kind: 'reference-publication-staging', schemaVersion: 1 }), { flag: 'wx' });
  }
  const owner = R.json(marker);
  if (owner.kind !== 'reference-publication-staging' || owner.schemaVersion !== 1) throw new Error('Invalid publication staging owner');
  const locks = noLinks(path.join(store, 'locks'));
  fs.mkdirSync(locks, { recursive: true });
  const unlock = lockFile({ io: fs, store }, hash(plan.target));
  try {
    if (fs.existsSync(plan.target)) {
      const existing = resolveReferenceRelease(plan.target, { dataRoot: plan.inspection.sourceRoot });
      if (existing?.identity !== plan.release.identity) throw new Error('Target already exists with different content');
      return { ...summary, mode: 'already-published', exitCode: 0 };
    }
    const staging = path.join(store, 'version-' + randomUUID());
    fs.mkdirSync(staging);
    for (const file of plan.originals) {
      const target = path.join(staging, file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const image = R.bytes(path.join(plan.source, file.path));
      if (hash(image) !== file.sha256) throw new Error('Source reference changed during publication');
      fs.writeFileSync(target, image, { flag: 'wx' });
    }
    for (const item of plan.additions) {
      const target = path.join(staging, item.intendedReferencePath);
      const image = R.bytes(path.join(plan.inspection.directory, item.image));
      if (hash(image) !== item.sha256) throw new Error('Candidate changed during publication');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, image);
    }
    writeJson(fs, path.join(staging, MARKER), plan.release);
    fs.writeFileSync(path.join(staging, VIEW), plan.viewBytes, { flag: 'wx' });
    resolveReferenceRelease(staging, { dataRoot: plan.inspection.sourceRoot });
    await deps.onPhase?.('prepared', { staging, target: plan.target });
    const finalPlan = preparePublication(options);
    if (!finalPlan.ready || finalPlan.release.identity !== plan.release.identity) throw new Error('Publication inputs changed before commit');
    if (fs.existsSync(plan.target)) throw new Error('Target appeared during publication');
    fs.renameSync(staging, plan.target);
    flushDir(fs, path.dirname(plan.target));
    await deps.onPhase?.('published', { target: plan.target });
    resolveReferenceRelease(plan.target, { dataRoot: plan.inspection.sourceRoot });
    return { ...summary, exitCode: 0 };
  } finally { unlock(); }
}

export = { MARKER, VIEW, scanImages, resolveReferenceRelease, preparePublication, publishReferenceCandidates };
