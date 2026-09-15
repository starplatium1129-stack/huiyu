import type { PathLike } from 'node:fs';
import type { RequestOptions } from 'node:http';
import { errorMessage as runtimeErrorMessage } from '../lib/runtime-errors';
'use strict';

import { PathOrFileDescriptor } from 'node:fs';

/**
 * Prepare all ignored Tauri inputs from tracked sources.
 *
 * The web directory is a tiny deterministic frontendDist placeholder because
 * the real windows navigate to the local gateway. The gateway resources are
 * staged separately, and the Node sidecar is downloaded from the official
 * Node release endpoint with a fixed SHA-256 check.
 */

const crypto: typeof import('crypto') = require('crypto');
const fs: typeof import('fs') = require('fs');
const https: typeof import('https') = require('https');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { execFileSync }: typeof import('child_process') = require('child_process');
const { withDesktopBuildLock }: typeof import('./desktop-build-lock') = require('./desktop-build-lock');
const { stageResources }: typeof import('./desktop-stage-resources') = require('./desktop-stage-resources');

const ROOT = path.resolve(__dirname, '../..');
const SIDECAR_DIR = path.join(ROOT, 'desktop-tauri', 'src-tauri', 'binaries');
const SIDECAR_PATH = path.join(SIDECAR_DIR, 'node-x86_64-pc-windows-msvc.exe');

const NODE_VERSION = 'v24.18.0';
const NODE_URL = `https://nodejs.org/dist/${NODE_VERSION}/win-x64/node.exe`;
const NODE_SHA256 = '9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de';
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 5;
const WEB_INDEX = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>绘遇 · HUIYU</title>
</head>
<body>
  <p>runtime navigates to the local gateway</p>
</body>
</html>
`;

function sha256(filePath: PathOrFileDescriptor) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function download(url: string|URL|RequestOptions|undefined, destination: PathLike, redirects: any = 0) {
  return new Promise<any>((resolve: any, reject: any) => {
    const request = https.get(url, (response: any) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        if (redirects >= MAX_REDIRECTS) {
          reject(new Error(`download redirect limit exceeded: ${url}`));
          return;
        }
        download(new URL(response.headers.location, url).toString(), destination, redirects + 1)
          .then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`download failed: ${url} -> HTTP ${response.statusCode}`));
        return;
      }
      const output = fs.createWriteStream(destination, { flags: 'wx' });
      response.pipe(output);
      output.on('finish', () => output.close(resolve));
      output.on('error', reject);
      response.on('error', reject);
    });
    request.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
      request.destroy(new Error(`download timed out after ${DOWNLOAD_TIMEOUT_MS}ms: ${url}`));
    });
    request.on('error', reject);
  });
}

async function ensureNodeSidecar(options: any = {}) {
  const sidecarDir = options.sidecarDir || SIDECAR_DIR;
  const sidecarPath = options.sidecarPath || SIDECAR_PATH;
  const downloadFile = options.downloadFile || download;
  const runFile = options.execFileSync || execFileSync;
  fs.mkdirSync(sidecarDir, { recursive: true });
  if (fs.existsSync(sidecarPath) && sha256(sidecarPath) === NODE_SHA256) {
    console.log(`[tauri] sidecar node ${NODE_VERSION} already verified`);
  } else {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-tauri-node-'));
    const tempPath = path.join(tempDir, 'node.exe');
    const backupPath = `${sidecarPath}.previous-${crypto.randomUUID()}`;
    let oldMoved = false;
    let published = false;
    try {
      console.log(`[tauri] downloading ${NODE_URL}`);
      await downloadFile(NODE_URL, tempPath);
      const actual = sha256(tempPath);
      if (actual !== NODE_SHA256) {
        throw new Error(`Node SHA256 mismatch: expected ${NODE_SHA256}, got ${actual}`);
      }
      if (fs.existsSync(sidecarPath)) {
        fs.renameSync(sidecarPath, backupPath);
        oldMoved = true;
      }
      fs.renameSync(tempPath, sidecarPath);
      published = true;
    } catch (error) {
      if (!published && oldMoved && !fs.existsSync(sidecarPath) && fs.existsSync(backupPath)) {
        fs.renameSync(backupPath, sidecarPath);
      }
      throw error;
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    if (oldMoved) {
      try {
        fs.rmSync(backupPath, { force:true });
      } catch (error) {
        console.warn(`[tauri] could not remove previous Node sidecar: ${runtimeErrorMessage(error)}`);
      }
    }
    console.log(`[tauri] sidecar node ${NODE_VERSION} downloaded and verified`);
  }

  const version = runFile(sidecarPath, ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  if (version !== NODE_VERSION) {
    throw new Error(`Node sidecar version mismatch: expected ${NODE_VERSION}, got ${version}`);
  }
}

async function prepareTauri(options: any = {}) {
  await (require('./build-game-installer') as typeof import('./build-game-installer')).buildGameInstaller();
  const root = options.root || ROOT;
  const webDir = options.webDir || path.join(root, 'desktop-tauri', 'web');
  const sidecarDir = options.sidecarDir || path.join(root, 'desktop-tauri', 'src-tauri', 'binaries');
  const sidecarPath = options.sidecarPath || path.join(sidecarDir, 'node-x86_64-pc-windows-msvc.exe');
  const stage = options.stage || path.join(root, 'desktop-tauri', 'src-tauri', 'resources');
  fs.mkdirSync(webDir, { recursive: true });
  fs.writeFileSync(path.join(webDir, 'index.html'), WEB_INDEX, 'utf8');
  console.log('[tauri] generated desktop-tauri/web/index.html');
  await ensureNodeSidecar({
    sidecarDir,
    sidecarPath,
    downloadFile: options.downloadFile,
    execFileSync: options.execFileSync,
  });
  const staged = stageResources({
    root,
    stage,
    installDependencies: options.installDependencies,
    logger: options.logger,
  });
  console.log('[tauri] prepare complete');
  await (options.verifyGateway || (require('./verify-desktop-gateway') as typeof import('./verify-desktop-gateway')).verifyDesktopGateway)({ root });
  return { webDir, sidecarPath, ...staged };
}

async function main() {
  await withDesktopBuildLock({ workspaceRoot: ROOT }, () => prepareTauri());
}

if (require.main === module) {
  main().catch((error: any) => {
    console.error(`[tauri] prepare failed: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

export = {
  ensureNodeSidecar,
  prepareTauri,
  sha256,
};
