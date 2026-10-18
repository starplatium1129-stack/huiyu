'use strict';

// Publication creates an immutable sibling version. The active directory and
// project indexes are never overwritten; configuration activation is explicit.
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const { randomUUID }: typeof import('node:crypto') = require('node:crypto');
const { CODE_ROOT, hash, noLinks }: typeof import('./generation-candidates') = require('./generation-candidates');
const { lockFile, writeJson, flushDir }: typeof import('./resource-install-fs') = require('./resource-install-fs');
const R: typeof import('./reference-candidate-review') = require('./reference-candidate-review');
const { object }: typeof import('./content-history-reader') = require('./content-history-reader');
const MARKER = 'reference-release.json';
const VIEW = 'character-reference-view.json';
type ImageFile = { path: string; bytes: number; sha256: string };
type Approval = Record<string, unknown> & { key: string };
type Release = {
  schemaVersion: 1; kind: 'reference-release'; identity: string; files: ImageFile[];
  viewSha256: string; sourceStandardsSha256: string; sourceViewSha256: string;
  candidateManifestSha256: string; reviewSha256: string; baseIdentity: string;
  approvals?: Approval[]; createdAt?: unknown;
};
type ViewReference = Record<string, unknown> & { id: string; url?: string; pending?: boolean };
type ReferenceView = Record<string, Record<string, unknown> & {
  outfits?: (Record<string, unknown> & { outfitId: string; references?: ViewReference[] | null })[] | null;
}>;
type PublicationOptions = { from: string; root?: string; review: string; source: string; target: string; apply?: boolean };

function scanImages(root: string) {
  noLinks(root);
  if (!fs.statSync(root).isDirectory()) throw new Error('Reference source must be a directory');
  const files: ImageFile[] = [];
  function visit(directory: string, prefix = '') {
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
  const keys = new Set<string>();
  for (const file of files) {
    const key = file.path.toLowerCase();
    if (keys.has(key)) throw new Error('Reference paths collide on Windows');
    keys.add(key);
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function seal(release: Omit<Release, 'schemaVersion' | 'kind' | 'identity'>) {
  return R.jsonHash({ files: release.files, viewSha256: release.viewSha256,
    sourceStandardsSha256: release.sourceStandardsSha256, sourceViewSha256: release.sourceViewSha256,
    candidateManifestSha256: release.candidateManifestSha256, reviewSha256: release.reviewSha256,
    baseIdentity: release.baseIdentity, ...(release.approvals ? { approvals: release.approvals } : {}) });
}

function readView(value: unknown): ReferenceView {
  if (!object(value) || !Object.values(value).every(character => object(character)
    && (character.outfits == null || (Array.isArray(character.outfits) && character.outfits.every((outfit: unknown) => object(outfit)
      && typeof outfit.outfitId === 'string' && (outfit.references == null || (Array.isArray(outfit.references)
        && outfit.references.every((reference: unknown) => object(reference) && typeof reference.id === 'string'
          && (reference.url === undefined || typeof reference.url === 'string')
          && (reference.pending === undefined || typeof reference.pending === 'boolean'))))))))) {
    throw new Error('Invalid reference view');
  }
  return value as ReferenceView;
}

function validateView(view: ReferenceView, files: ImageFile[]) {
  const available = new Set(files.map(file => file.path));
  for (const character of Object.values(view)) {
    for (const outfit of character.outfits || []) {
      for (const reference of outfit.references || []) {
        if (reference.pending || !reference.url?.startsWith('/character-references/')) continue;
        const rel = R.relativeImage(reference.url.slice('/character-references/'.length));
        if (!available.has(rel)) throw new Error('Published reference view points to a missing image: ' + rel);
      }
    }
  }
}

function resolveReferenceRelease(directory: string, { dataRoot = CODE_ROOT }: { dataRoot?: string } = {}) {
  const root = path.resolve(directory);
  const marker = path.join(root, MARKER);
  noLinks(marker);
  if (!fs.existsSync(marker)) return null; // Existing unversioned libraries retain their old handling.
  const value = R.json(marker);
  if (!object(value) || value.schemaVersion !== 1 || value.kind !== 'reference-release'
      || !['identity', 'viewSha256', 'sourceStandardsSha256', 'sourceViewSha256', 'candidateManifestSha256', 'reviewSha256', 'baseIdentity']
        .every(key => typeof value[key] === 'string' && R.SHA.test(value[key]))
      || !Array.isArray(value.files)
      || (value.approvals !== undefined && (!Array.isArray(value.approvals)
        || !value.approvals.every((approval: unknown) => object(approval) && typeof approval.key === 'string')))) throw new Error('Invalid reference release identity');
  const files = scanImages(root);
  if (R.jsonHash(files) !== R.jsonHash(value.files)) throw new Error('Reference release is incomplete or its bytes changed');
  const release = value as Release; // File records match the scanned files; seal fields and approval keys are checked above.
  if (seal(release) !== release.identity) throw new Error('Invalid reference release identity');
  const viewFile = path.join(root, VIEW);
  const viewBytes = R.bytes(viewFile);
  if (hash(viewBytes) !== release.viewSha256) throw new Error('Reference release index changed');
  const sourceView = path.join(dataRoot, 'data', VIEW);
  if (hash(R.bytes(sourceView)) !== release.sourceViewSha256
      || hash(R.bytes(path.join(dataRoot, R.SOURCE))) !== release.sourceStandardsSha256) throw new Error('Reference release belongs to a different source version');
  validateView(readView(JSON.parse(viewBytes.toString('utf8'))), files);
  return { referenceRoot: root, viewFile, identity: release.identity, release };
}

function paths(options: PublicationOptions, inspection: ReturnType<typeof R.inspectCandidates>) {
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

function preparePublication(options: PublicationOptions) {
  const inspection = R.inspectCandidates(options);
  const review = R.json(path.resolve(options.review));
  const { items, records: decisions } = R.attachReview(inspection, review);
  const selected = paths(options, inspection);
  const base = resolveReferenceRelease(selected.source, { dataRoot: inspection.sourceRoot });
  const originals = scanImages(selected.source);
  const sourceView = R.bytes(path.join(inspection.sourceRoot, 'data', VIEW));
  const view = readView(base ? R.json(base.viewFile) : JSON.parse(sourceView.toString('utf8')));
  const additions = items.filter(item => item.integrity === 'pass' && item.review === 'pass');
  const approvals = new Map<string, Approval>((base?.release.approvals || []).map(approval => [approval.key, approval]));
  for (const item of additions) {
    const record = inspection.records.find(record => record.recordId === item.recordId)!;
    const outfits = view[record.characterId]?.outfits;
    const matches = outfits?.filter(outfit => outfit.outfitId === record.outfitId) || [];
    const refs = matches.length === 1 ? matches[0].references?.filter(reference => reference.id === record.persId) || [] : [];
    if (refs.length !== 1) throw new Error('Candidate target is absent or ambiguous in the current reference index: ' + item.key);
    Object.assign(refs[0], { url: '/character-references/' + item.intendedReferencePath,
      fileName: path.posix.basename(item.intendedReferencePath), pending: false });
    // Evidence belongs to the sealed release, not the strict runtime view schema.
    approvals.set(item.key, { key: item.key, path: item.intendedReferencePath,
      recordId: item.recordId, inputVersion: item.inputVersion, sha256: item.sha256,
      review: decisions[item.key], candidateManifestSha256: inspection.manifestSha256 });
  }
  const planned = new Map(originals.map(file => [file.path, file]));
  for (const item of additions) {
    const record = inspection.records.find(record => record.recordId === item.recordId)!;
    if (!object(record.asset) || typeof record.asset.bytes !== 'number' || typeof item.sha256 !== 'string') throw new Error('Missing verified candidate asset');
    planned.set(item.intendedReferencePath, { path: item.intendedReferencePath, bytes: record.asset.bytes, sha256: item.sha256 });
  }
  const files = [...planned.values()].sort((a, b) => a.path.localeCompare(b.path));
  if (new Set(files.map(file => file.path.toLowerCase())).size !== files.length) throw new Error('Publication paths collide on Windows');
  validateView(view, files);
  const viewBytes = Buffer.from(JSON.stringify(view, null, 2) + '\n');
  const release: Release = { schemaVersion: 1, kind: 'reference-release', files,
    viewSha256: hash(viewBytes), sourceStandardsSha256: hash(R.bytes(inspection.sourceFile)),
    sourceViewSha256: hash(sourceView), candidateManifestSha256: inspection.manifestSha256,
    reviewSha256: hash(R.bytes(path.resolve(options.review))), baseIdentity: base?.identity || R.jsonHash(originals),
    approvals: [...approvals.values()].sort((a, b) => a.key.localeCompare(b.key)),
    createdAt: new Date().toISOString(), identity: '' };
  release.identity = seal(release);
  return { ...selected, inspection, items, originals, additions, viewBytes, release,
    ready: items.length > 0 && additions.length === items.length };
}

async function publishReferenceCandidates(options: PublicationOptions) {
  const plan = preparePublication(options);
  const summary = { mode: options.apply ? 'publish' : 'preview', target: plan.target, identity: plan.release.identity,
    candidates: plan.items.length, approved: plan.additions.length, ready: plan.ready,
    pending: plan.items.filter(item => item.review === 'pending').map(item => item.key),
    rejected: plan.items.filter(item => item.integrity !== 'pass' || item.review === 'fail' || item.review === 'stale').map(item => item.key),
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
  if (!object(owner) || owner.kind !== 'reference-publication-staging' || owner.schemaVersion !== 1) throw new Error('Invalid publication staging owner');
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
    const finalPlan = preparePublication(options);
    if (!finalPlan.ready || finalPlan.release.identity !== plan.release.identity) throw new Error('Publication inputs changed before commit');
    if (fs.existsSync(plan.target)) throw new Error('Target appeared during publication');
    fs.renameSync(staging, plan.target);
    flushDir(fs, path.dirname(plan.target));
    resolveReferenceRelease(plan.target, { dataRoot: plan.inspection.sourceRoot });
    return { ...summary, exitCode: 0 };
  } finally { unlock(); }
}

export = { publishReferenceCandidates };
