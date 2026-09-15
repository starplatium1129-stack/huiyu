'use strict';

const io: typeof import('./maintenance-recovery-fs') = require('./maintenance-recovery-fs');
const { fs, path, crypto, failure } = io;

function saveSnapshotBackup(snapshot: any, backupRoot: any, label: any, options?: any) {
  if (!Array.isArray(snapshot) || snapshot.length > 20000 || !/^[A-Za-z0-9_-]{1,100}$/.test(label)) throw failure('MAINTENANCE_ARGUMENT', '备份参数无效');
  const ctx = options ? io.context(options) : null;
  if (ctx && !io.samePath(backupRoot, ctx.backupRoot)) throw failure('MAINTENANCE_PATH', '备份必须位于专用 runtime/maintenance-backups');
  const seen = new Set();
  const items = snapshot.map(item => {
    const file = ctx ? io.targetPath(ctx, item.file) : path.resolve(item.file);
    io.safePath(file);
    if (seen.has(io.keyPath(file)) || typeof item.exists !== 'boolean' || (item.exists && !Buffer.isBuffer(item.content) && typeof item.content !== 'string')) throw failure('MAINTENANCE_ARGUMENT', '备份条目无效或重复');
    seen.add(io.keyPath(file));
    return { file, exists: item.exists, content: item.exists ? Buffer.from(item.content) : null };
  });
  const key = ctx ? io.readKey(ctx) : null;
  io.ensureDirectory(backupRoot);
  const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + label + '-' + crypto.randomUUID();
  const target = path.join(backupRoot, id);
  const staging = path.join(backupRoot, '.pending-' + crypto.randomUUID());
  io.ensureDirectory(path.join(staging, 'files'));
  const files = items.map((item, index) => {
    const backup = item.exists ? String(index).padStart(5, '0') + '.bin' : '';
    if (item.exists) io.atomicWrite(path.join(staging, 'files', backup), item.content);
    return { source: item.file, existed: item.exists, backup, sha256: item.exists ? io.digest(item.content) : null, size: item.exists ? item.content!.length : 0 };
  });
  const manifest = { schemaVersion: 2, kind: 'maintenance-backup', createdAt: new Date().toISOString(), label, files,
    root: ctx ? ctx.root : null, runtimeRoot: ctx ? ctx.runtimeRoot : null, showcaseRoot: ctx ? ctx.showcaseRoot : null,
    runtimeIdentity: ctx ? io.directoryIdentity(ctx.runtimeRoot) : null,
    showcaseIdentity: ctx?.showcaseRoot ? io.directoryIdentity(ctx.showcaseRoot) : null };
  io.writeJson(path.join(staging, 'manifest.json'), key ? io.seal(manifest, key) : { ...manifest, sha256: io.digest(io.canonical(manifest)) });
  io.safePath(backupRoot, 'directory', false);
  fs.renameSync(staging, target);
  io.syncDirectory(backupRoot);
  return target;
}

function readBackup(options: any, id: any, expectedHash?: any) {
  const ctx = io.context(options);
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw failure('MAINTENANCE_PATH', '备份 ID 必须是专用目录内的单个名称');
  const directory = path.join(ctx.backupRoot, id);
  io.safePath(directory, 'directory', false);
  const bytes = io.readBytes(path.join(directory, 'manifest.json'));
  const sha256 = io.digest(bytes);
  if (expectedHash && sha256 !== expectedHash) throw failure('MAINTENANCE_INVALID_BACKUP', '备份 manifest 哈希不匹配');
  const manifest = io.unseal(io.readJson(path.join(directory, 'manifest.json')), io.readKey(ctx));
  if (manifest.schemaVersion !== 2 || manifest.kind !== 'maintenance-backup' || !io.equal(manifest.root, ctx.root)
    || !io.samePath(manifest.runtimeRoot || '', ctx.runtimeRoot) || manifest.showcaseRoot !== ctx.showcaseRoot
    || !io.equal(manifest.runtimeIdentity, io.directoryIdentity(ctx.runtimeRoot))
    || !io.equal(manifest.showcaseIdentity, ctx.showcaseRoot ? io.directoryIdentity(ctx.showcaseRoot) : null)
    || !Array.isArray(manifest.files) || manifest.files.length > 20000) throw failure('MAINTENANCE_INVALID_BACKUP', '拒绝 legacy、未知 schema 或根身份不匹配的备份');
  if (fs.readdirSync(directory).sort().join('|') !== 'files|manifest.json') throw failure('MAINTENANCE_INVALID_BACKUP', '备份中存在未知文件');
  io.safePath(path.join(directory, 'files'), 'directory', false);
  const names = new Set();
  const targets = new Set();
  const entries = manifest.files.map((item: any) => {
    const file = io.targetPath(ctx, item.source);
    if (targets.has(io.keyPath(file)) || typeof item.existed !== 'boolean') throw failure('MAINTENANCE_INVALID_BACKUP', '备份目标重复或格式无效');
    targets.add(io.keyPath(file));
    let content = null;
    if (item.existed) {
      if (!/^\d{5}\.bin$/.test(item.backup) || names.has(item.backup)) throw failure('MAINTENANCE_INVALID_BACKUP', '备份文件名无效');
      names.add(item.backup);
      content = io.readBytes(path.join(directory, 'files', item.backup));
      if (io.digest(content) !== item.sha256 || content!.length !== item.size) throw failure('MAINTENANCE_INVALID_BACKUP', '备份内容哈希不匹配：' + item.source);
    } else if (item.backup !== '' || item.sha256 !== null || item.size !== 0) throw failure('MAINTENANCE_INVALID_BACKUP', '不存在文件的备份身份无效');
    return { file, exists: item.existed, content, expected: { exists: item.existed, sha256: item.sha256, size: item.size } };
  });
  if (fs.readdirSync(path.join(directory, 'files')).sort().join('|') !== [...names].sort().join('|')) throw failure('MAINTENANCE_INVALID_BACKUP', '备份包含未声明的文件');
  return { directory, id, sha256, manifest, entries };
}

function restoreEntries(options: any, entries: any, assertOwned: any = () => {}) {
  const ctx = io.context(options);
  // Validate the entire scope before the first mutation, then each path again on use.
  for (const item of entries) io.targetPath(ctx, item.file);
  for (const item of entries) {
    assertOwned();
    const file = io.targetPath(io.context(options), item.file);
    const expected = item.expected || { exists: item.exists, sha256: item.exists ? io.digest(item.content) : null, size: item.exists ? item.content.length : 0 };
    if (io.equal(io.fileState(file), expected)) continue;
    if (item.exists) io.atomicWrite(file, item.content, true);
    else io.removeFile(file);
  }
  for (const item of entries) {
    const expected = item.expected || { exists: item.exists, sha256: item.exists ? io.digest(item.content) : null, size: item.exists ? item.content.length : 0 };
    if (!io.equal(io.fileState(io.targetPath(ctx, item.file)), expected)) throw failure('MAINTENANCE_INCONSISTENT', '恢复后字节核验失败：' + item.file);
  }
}

export = { saveSnapshotBackup, readBackup, restoreEntries };
