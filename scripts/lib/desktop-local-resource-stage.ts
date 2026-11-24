import fs = require('node:fs');
import path = require('node:path');
import safe = require('./delivery-paths');
import type { FileIdentity, Snapshot } from './delivery-types';

type BytesIdentity = Pick<FileIdentity, 'bytes' | 'sha256'>;
type PlannedFile = { input: string; identity: BytesIdentity; changed: boolean };
type StageChange = { name: string; prior?: string; installed?: boolean };
const rel = (root: string, file: string) => safe.relative(path.relative(root, file));
const same = (a: BytesIdentity, b: BytesIdentity) => a.bytes === b.bytes && a.sha256 === b.sha256;

function fileIdentity(root: string, name: string, scan?: ReturnType<typeof safe.pathScan>): FileIdentity {
  const info = safe.fileEntry(root, name, scan);
  if (info.status !== 'file') throw Error('Cannot stage resource ' + name + ': ' + info.message);
  return info;
}

function regular(file: string) {
  const info = fs.lstatSync(file, { throwIfNoEntry: false });
  if (info && (!info.isFile() || info.nlink !== 1)) throw Error('Staging refuses non-regular or linked files: ' + file);
  return info;
}

/** Prepare only different output bytes, leaving the previous stage intact until
 * complete. All reuse is checked against hashes, including paths from untracked
 * products like Vite, Node, SDK modules and generated resource summaries. */
export class LocalResourceStage {
  private readonly inputs = new Map<string, FileIdentity>();
  private readonly priorFiles = new Set<string>();
  private readonly priorDirs = new Set<string>();
  private readonly files = new Map<string, PlannedFile>();
  private readonly dirs = new Set<string>();
  private readonly priorScan: ReturnType<typeof safe.pathScan>;
  private readonly sourceScan: ReturnType<typeof safe.pathScan>;
  private readonly changes: StageChange[] = [];
  requiresRecovery = false;
  private readonly removedDirs: string[] = [];
  private readonly createdDirs: string[] = [];
  private readonly candidates: string;
  private readonly backup: string;

  constructor(private readonly root: string, private readonly stage: string, scratch: string, source?: Snapshot) {
    for (const entry of source?.entries ?? []) if (entry.status === 'file') this.inputs.set(entry.path, entry);
    this.priorScan = safe.pathScan(stage);
    this.sourceScan = safe.pathScan(root);
    this.candidates = path.join(scratch, 'candidates');
    this.backup = path.join(scratch, 'rollback');
    fs.mkdirSync(this.candidates);
    fs.mkdirSync(this.backup);
    this.walk(stage);
  }

  private walk(directory: string, files = this.priorFiles, dirs = this.priorDirs) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const name = rel(this.stage, file);
      const checked = this.priorScan(name);
      if (entry.isDirectory() && checked.stat.isDirectory()) {
        dirs.add(name);
        this.walk(file, files, dirs);
      } else if (entry.isFile() && checked.stat.isFile() && checked.stat.nlink === 1n) files.add(name);
      else throw Error('Staging refuses non-regular or linked files: ' + file);
    }
  }

  directory(destination: string) {
    let name = rel(this.stage, destination);
    while (name !== '.') {
      this.dirs.add(name);
      name = path.posix.dirname(name);
    }
  }

  private source(file: string) {
    const name = rel(this.root, file);
    const checked = this.sourceScan(name);
    if (!checked.stat.isFile() || checked.stat.nlink !== 1n) throw Error('Staging refuses non-regular or linked files: ' + file);
    const expected = this.inputs.get(name);
    if (expected && checked.stat.size !== BigInt(expected.bytes)) throw Error('Source changed during desktop staging: ' + name);
    return expected ?? fileIdentity(this.root, name, this.sourceScan);
  }

  readSource(file: string) {
    const expected = this.source(file);
    const data = fs.readFileSync(safe.resolveSafe(this.root, rel(this.root, file)));
    if (!same(expected, { bytes: data.length, sha256: safe.sha256(data) }) || !same(expected, this.source(file))) {
      throw Error('Source changed during desktop staging: ' + file);
    }
    return data;
  }

  copy(source: string, destination: string) {
    const identity = this.source(source);
    this.plan(destination, identity, candidate => {
      fs.copyFileSync(safe.resolveSafe(this.root, rel(this.root, source)), candidate, fs.constants.COPYFILE_EXCL);
      if (!same(identity, this.source(source))) throw Error('Source changed during desktop staging: ' + source);
    });
  }

  write(destination: string, data: Buffer) {
    this.plan(destination, { bytes: data.length, sha256: safe.sha256(data) }, candidate => {
      fs.writeFileSync(candidate, data, { flag: 'wx' });
    });
  }

  private plan(destination: string, expected: BytesIdentity, produce: (candidate: string) => void) {
    const name = rel(this.stage, destination);
    if (this.files.has(name)) throw Error('Duplicate bundled resource: ' + name);
    if (path.dirname(destination) !== this.stage) this.directory(path.dirname(destination));
    if (this.priorFiles.has(name)) {
      const current = fileIdentity(this.stage, name, this.priorScan);
      if (same(current, expected)) {
        this.files.set(name, { input: current.path, identity: current, changed: false });
        return;
      }
    }
    const candidate = safe.resolveSafe(this.candidates, name, true);
    fs.mkdirSync(path.dirname(candidate), { recursive: true });
    produce(candidate);
    const identity = fileIdentity(this.candidates, name);
    if (!same(identity, expected)) throw Error('Copied resource differs from source: ' + name);
    this.files.set(name, { input: identity.path, identity, changed: true });
  }

  stagedBytes(name: string) {
    const item = this.files.get(name);
    if (!item) throw Error('Missing staged resource: ' + name);
    const tree = item.changed ? this.candidates : this.stage;
    const data = fs.readFileSync(safe.resolveSafe(tree, item.input));
    if (!same(item.identity, { bytes: data.length, sha256: safe.sha256(data) })) throw Error('Staged resource changed: ' + name);
    return data;
  }

  inventory() {
    return [...this.files.entries()].map(([name, item]) => {
      const tree = item.changed ? this.candidates : this.stage;
      const current = fileIdentity(tree, name, item.changed ? undefined : this.priorScan);
      if (!same(current, item.identity)) throw Error('Staged resource changed: ' + name);
      return { path: name, bytes: current.bytes, sha256: current.sha256 };
    }).sort((a, b) => a.path.localeCompare(b.path, 'en'));
  }

  private retire(name: string) {
    const destination = safe.resolveSafe(this.stage, name);
    if (!regular(destination)) throw Error('Staged resource disappeared: ' + name);
    const prior = safe.resolveSafe(this.backup, name, true);
    fs.mkdirSync(path.dirname(prior), { recursive: true });
    fs.renameSync(destination, prior);
    const change = { name, prior, installed: false };
    this.changes.push(change);
    return change;
  }

  publish() {
    let written = 0;
    try {
      for (const name of this.priorFiles) {
        if (!this.files.has(name) || this.files.get(name)?.changed) this.retire(name);
      }
      for (const name of [...this.priorDirs].filter(name => !this.dirs.has(name)).sort((a, b) => b.length - a.length)) {
        const directory = safe.resolveSafe(this.stage, name);
        fs.rmdirSync(directory);
        this.removedDirs.push(name);
      }
      for (const name of [...this.dirs].sort((a, b) => a.length - b.length)) {
        const directory = safe.resolveSafe(this.stage, name, true);
        if (!fs.lstatSync(directory, { throwIfNoEntry: false })) {
          fs.mkdirSync(directory);
          this.createdDirs.push(name);
        }
      }
      const changes = new Map(this.changes.map(change => [change.name, change]));
      for (const [name, item] of this.files) {
        if (!item.changed) continue;
        const destination = safe.resolveSafe(this.stage, name, true);
        if (fs.lstatSync(destination, { throwIfNoEntry: false })) throw Error('Unexpected staged resource: ' + name);
        const change: StageChange = changes.get(name) ?? { name };
        if (!changes.has(name)) this.changes.push(change);
        fs.renameSync(safe.resolveSafe(this.candidates, name), destination);
        change.installed = true;
        written++;
      }
      const files = new Set<string>(), dirs = new Set<string>();
      this.walk(this.stage, files, dirs);
      if (files.size !== this.files.size || dirs.size !== this.dirs.size
          || [...files].some(name => !this.files.has(name)) || [...dirs].some(name => !this.dirs.has(name))) {
        throw Error('Resource staging contents changed before publication');
      }
      for (const [name, planned] of this.files) {
        if (!same(planned.identity, fileIdentity(this.stage, name, this.priorScan))) {
          throw Error('Published resource differs from its binding: ' + name);
        }
      }
    } catch (error) {
      try {
        for (const change of this.changes) if (change.installed) {
          const destination = safe.resolveSafe(this.stage, change.name);
          if (!regular(destination)) throw Error('Staged resource disappeared: ' + change.name);
          fs.unlinkSync(destination);
        }
        for (const name of this.createdDirs.reverse()) fs.rmdirSync(safe.resolveSafe(this.stage, name));
        for (const name of this.removedDirs.reverse()) fs.mkdirSync(safe.resolveSafe(this.stage, name, true));
        for (const change of this.changes) if (change.prior) {
          const destination = safe.resolveSafe(this.stage, change.name, true);
          if (fs.lstatSync(destination, { throwIfNoEntry: false })) throw Error('Unexpected staged resource: ' + change.name);
          fs.renameSync(change.prior, destination);
        }
      } catch (rollback) {
        this.requiresRecovery = true;
        throw Error('Resource staging rollback needs recovery: ' + this.backup, { cause: new AggregateError([error, rollback]) });
      }
      throw error;
    }
    return { written, removed: this.changes.filter(change => change.prior && !change.installed).length };
  }
}
