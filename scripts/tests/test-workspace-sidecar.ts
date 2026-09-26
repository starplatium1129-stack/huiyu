import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
const { stageResources }: typeof import('../maintenance/desktop-stage-resources') = require('../maintenance/desktop-stage-resources');
const { NODE_SHA256, NODE_VERSION }: typeof import('../maintenance/prepare-tauri') = require('../maintenance/prepare-tauri');
import type { WorkspaceService } from '../../server/workspace/client';

const projectRoot = path.resolve(__dirname, '../..');
const digest = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function write(root: string, relative: string, content: string): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// Only the tiny surrounding package is a fixture. Every workspace module below is
// the actual build output, passed through the production stager and Tauri map.
function stagePackagedWorkspace(root: string): { installed: string; manifest: { path: string; sha256: string }[] } {
  for (const directory of ['server', 'routes', 'scripts/lib', 'docs', 'data', 'dist', 'assets', 'tools']) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  write(root, 'server.js', 'module.exports = {};\n');
  write(root, 'dist/index.html', '<!doctype html>\n');
  write(root, 'services/fixture.ts', 'export const fixture = true;\n');
  write(root, 'services/fixture.js', 'exports.fixture = true;\n');
  write(root, 'tsconfig.runtime.json', JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'CommonJS',
    declaration: true, rootDir: 'services', outDir: 'services' }, include: ['services/**/*.ts'],
    exclude: ['services/**/*.js', 'services/**/*.d.ts'] }));
  for (const file of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(projectRoot, file), path.join(root, file));
  const sourceWorkspace = path.join(projectRoot, 'server/workspace');
  const names = fs.readdirSync(sourceWorkspace).filter(name => name.endsWith('.ts') && !name.endsWith('.d.ts'))
    .map(name => name.replace(/\.ts$/, '.js')).sort();
  assert.ok(names.includes('worker.js') && names.includes('client.js'), 'actual workspace worker and client must be compiled');
  const manifest = names.map(name => {
    const source = path.join(sourceWorkspace, name);
    assert.ok(fs.existsSync(source), 'run build:runtime before sidecar acceptance');
    const target = path.join(root, 'server/workspace', name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    return { path: 'gateway/server/workspace/' + name, sha256: digest(source) };
  });
  const tauri = path.join(root, 'desktop-tauri/src-tauri');
  const stage = path.join(tauri, 'resources');
  stageResources({ root, stage, logger: () => {}, installDependencies: gateway => {
    // Workspace uses Node builtins; no download/install or developer dependencies are needed.
    fs.mkdirSync(path.join(gateway, 'node_modules'));
  } });
  write(tauri, 'icons/icon.ico', 'non-executed fixture icon');
  const config = JSON.parse(fs.readFileSync(path.join(projectRoot, 'desktop-tauri/src-tauri/tauri.conf.json'), 'utf8'));
  assert.equal(config.bundle.resources['resources/gateway/server'], 'gateway/server');
  assert.ok(config.bundle.externalBin.includes('binaries/node'));
  const installed = path.join(root, 'installed');
  for (const [source, destination] of Object.entries(config.bundle.resources as Record<string, string>)) {
    const target = path.resolve(installed, destination);
    assert.ok(target.startsWith(installed + path.sep));
    fs.cpSync(path.join(tauri, source), target, { recursive: true });
  }
  for (const item of manifest) {
    assert.equal(digest(path.join(stage, item.path)), item.sha256);
    assert.equal(digest(path.join(installed, item.path)), item.sha256);
  }
  write(root, 'packaged-workspace-manifest.json', JSON.stringify(manifest));
  return { installed, manifest };
}

async function runPackagedProbe(): Promise<void> {
  const assert: typeof import('node:assert/strict') = require('node:assert/strict');
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  const gateway = process.argv[1];
  const root = process.argv[2];
  const { openWorkspace } = require(path.join(gateway, 'server/workspace/client.js')) as { openWorkspace(options: {
    root: string; workspaceId: string; create?: boolean;
  }): Promise<WorkspaceService> };
  const workspaceId = 'packaged-worker-fixture';
  const context = { principalId: 'sidecar-probe', workspaceId, protocolVersion: 1 as const };
  await assert.rejects(openWorkspace({ root: path.join(gateway, 'runtime', 'private-workspace'), workspaceId, create: true }),
    { code: 'WORKSPACE_LOCATION' });
  let service = await openWorkspace({ root, workspaceId, create: true });
  let closed = false;
  try {
    const status = await service.request({ kind: 'status' }, context);
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLxQAAAAASUVORK5CYII=', 'base64');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await service.request({ kind: 'prepareSave', operationId: 'save-one', artwork: { id: 7, image_id: 'image-seven', title: 'sidecar original' },
      media: { alias: 'image-seven', sha256, bytes: bytes.length, mime: 'image/png' } }, context);
    await service.request({ kind: 'uploadChunk', operationId: 'save-one', offset: 0, data: bytes }, context);
    const saved = await service.request({ kind: 'commitSave', operationId: 'save-one' }, context);
    let backupFinished = false;
    let writeDuringCopy = false;
    const backupRequest = service.request({ kind: 'backup', operationId: 'backup-one' }, context)
      .then(result => { backupFinished = true; return result; });
    const patchRequest = service.request({ kind: 'patchArtwork', operationId: 'patch-after-backup', id: 7,
      expectedRevision: saved.revision, patch: { title: 'newer live edit' } }, context)
      .then(result => { writeDuringCopy = !backupFinished; return result; });
    const backup = await backupRequest;
    await patchRequest;
    assert.equal(writeDuringCopy, true, 'new artwork writes must complete while immutable backup files are copying');
    assert.deepEqual(await service.request({ kind: 'backup', operationId: 'backup-one' }, context), backup);
    const restored = await service.request({ kind: 'restoreBackup', operationId: 'restore-one', backupId: backup.backupId }, context);
    assert.deepEqual(await service.request({ kind: 'restoreBackup', operationId: 'restore-one', backupId: backup.backupId }, context), restored);
    await service.close();
    closed = true;
    service = await openWorkspace({ root, workspaceId });
    closed = false;
    assert.equal((await service.request({ kind: 'getArtwork', id: 7 }, context))?.body.title, 'newer live edit');
    const media = await service.request({ kind: 'readMedia', alias: 'image-seven' }, context);
    assert.deepEqual(Buffer.from(media.data), bytes);
    const candidateRoot = path.join(root, 'restore-candidates', restored.candidateId);
    assert.equal(JSON.parse(fs.readFileSync(path.join(candidateRoot, 'candidate.json'), 'utf8')).activated, false);
    const candidate = await openWorkspace({ root: candidateRoot, workspaceId });
    try {
      assert.equal((await candidate.request({ kind: 'getArtwork', id: 7 }, context))?.body.title, 'sidecar original');
      assert.deepEqual(Buffer.from((await candidate.request({ kind: 'readMedia', alias: 'image-seven' }, context)).data), bytes);
    } finally { await candidate.close(); }
    console.log(JSON.stringify({ node: process.version, sqlite: status.sqliteVersion, schemaVersion: status.schemaVersion,
      saved: true, reopened: true, backup: true, restoredCandidate: true, queuedWritePreserved: true, writeDuringCopy }));
  } finally { if (!closed) await service.close(); }
}

test('pinned Windows sidecar loads the staged production workspace worker and completes save/reopen/backup', { timeout: 60_000 }, () => {
  assert.equal(process.platform, 'win32', 'R2 sidecar acceptance requires the Windows sidecar environment');
  const sidecar = path.join(projectRoot, 'desktop-tauri/src-tauri/binaries/node-x86_64-pc-windows-msvc.exe');
  assert.ok(fs.existsSync(sidecar), 'sidecar missing; this test never downloads a replacement');
  assert.equal(digest(sidecar), NODE_SHA256);
  assert.equal(execFileSync(sidecar, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim(), NODE_VERSION);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-packaged-workspace-'));
  try {
    const { installed, manifest } = stagePackagedWorkspace(root);
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    const source = `(${runPackagedProbe.toString()})().catch(error => { console.error(error); process.exitCode = 1; });`;
    const output = execFileSync(sidecar, ['--disable-warning=ExperimentalWarning', '-e', source,
      path.join(installed, 'gateway'), path.join(root, 'workspace-data')], {
      cwd: installed, env, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024,
    });
    const result = JSON.parse(output.trim());
    assert.equal(result.node, NODE_VERSION);
    assert.equal(result.restoredCandidate, true);
    console.log(JSON.stringify({ ...result, sidecarSha256: NODE_SHA256, packagedModules: manifest.length,
      workerSha256: manifest.find(item => item.path.endsWith('/worker.js'))?.sha256 }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
