'use strict';
// Stage only Rust runtime inputs. Node/Vite are build tools, never shipped services.
import fs = require('node:fs');
import path = require('node:path');
import crypto = require('node:crypto');
import { execFileSync } from 'node:child_process';
const { withDesktopBuildLock }: typeof import('./desktop-build-lock') = require('./desktop-build-lock');
const { copyRustPayload, runtimeBuild }: typeof import('./desktop-rust-inputs') = require('./desktop-rust-inputs');
import safe = require('../lib/delivery-paths');
type Logger = (message: string) => void;
interface StageOptions { root?: string; stage?: string; resourceProfile?: string; logger?: Logger }
const ROOT = path.resolve(__dirname, '../..');
const ENTRIES = ['docs', 'data', 'dist', 'assets', 'tools'];
const DATA_ROOTS=new Set(['character-reference-standards.json','character-reference-view.json','characters.json','curation.json','loras.json','popular-characters.json','popular-onboarding.json','presets.json','prompt-pinned-scenes.json','retired-scenes.json','scene-blueprints.json','scenes-core.json','scenes-index.json','scenes-natsume.json','scenes-nene.json','scenes-shared.json','scenes.json','tags-dictionary.json','tags.json']);
const DATA_SHARDS=new Set(['blueprints','popular','references','scenes','tags']);
const TOOLS=new Set(['nav.js','theme.js','local-status.js','translate-zh-ja.py','install-translation-model.ps1']);
function includeData(parts:string[],file:string):boolean {
  if(parts.some(part=>part.startsWith('.')))return false;
  if(parts.length===1&&DATA_SHARDS.has(parts[0]))return fs.statSync(file).isDirectory();
  if(DATA_SHARDS.has(parts[0]))return fs.statSync(file).isDirectory()||/\.json(?:\.(?:br|gz))?$/i.test(parts.at(-1)!);
  return parts.length===1&&DATA_ROOTS.has(parts[0].replace(/\.(?:br|gz)$/i,''));
}
function copyDir(src: string, dest: string, include: (file: string) => boolean = () => true) {
  if (fs.lstatSync(src).isSymbolicLink()) throw Error(`Staging refuses linked directories: ${src}`);
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name), to = path.join(dest, entry.name);
    if (!include(from)) continue;
    if (entry.isSymbolicLink()) throw Error(`Staging refuses linked inputs: ${from}`);
    if (entry.isDirectory()) copyDir(from, to, include);
    else if (entry.isFile()) fs.copyFileSync(from, to);
    else throw Error(`Staging input is not a regular file: ${from}`);
  }
}
function resolveNpmInvocation() {
  const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs/node_modules/npm/bin/npm-cli.js')];
  const cli = candidates.find(file => file && fs.existsSync(file));
  if (cli) return { command: process.execPath, args: [cli] };
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: [] as string[] };
}
function publishStage(tempStage: string, stage: string, logger: Logger) {
  const backup = `${stage}.previous-${process.pid}-${crypto.randomUUID()}`;
  let moved = false;
  try { if (fs.existsSync(stage)) { fs.renameSync(stage, backup); moved = true; } fs.renameSync(tempStage, stage); }
  catch (error) { if (moved && !fs.existsSync(stage)) fs.renameSync(backup, stage); throw error; }
  if (moved) { try { fs.rmSync(backup, { recursive: true, force: true }); } catch { logger('[stage] Previous stage retained for cleanup'); } }
}
function stageResources(options: StageOptions = {}) {
  const root = fs.realpathSync(options.root || ROOT), stage = path.resolve(options.stage || path.join(root, 'desktop-tauri/src-tauri/resources'));
  const rel = path.relative(root, stage).replaceAll('\\', '/');
  if (!rel || rel.startsWith('../') || path.isAbsolute(rel) || ['data', 'assets', 'dist', 'tools', 'docs', 'runtime-rs'].some(dir => rel === dir || rel.startsWith(dir + '/'))) throw Error('Staging destination must be an isolated child of workspace');
  safe.resolveSafe(root, rel, true);
  const logger = options.logger || console.log, profile = options.resourceProfile || process.env.AICS_DESKTOP_RESOURCE_PROFILE || 'full';
  if (!['full', 'base'].includes(profile)) throw Error('Resource profile must be full or base');
  runtimeBuild(root); // Fail before replacing or copying anything if source/executable binding is stale.
  fs.mkdirSync(path.dirname(stage), { recursive: true });
  const temporary = fs.mkdtempSync(`${stage}.tmp-${process.pid}-`), gateway = path.join(temporary, 'gateway');
  fs.mkdirSync(gateway);
  try {
    const report = copyRustPayload(root, gateway);
    for (const source of ENTRIES) {
      const from = safe.resolveSafe(root, source);
      copyDir(from, path.join(gateway, source), file => {
        const rel = path.relative(from, file).split(path.sep);
        if(source==='data'&&!includeData(rel,file))return false;
        if(source==='tools'&&(rel.length!==1||!TOOLS.has(rel[0].replace(/\.(?:br|gz)$/i,''))))return false;
        if (source === 'assets' && ['character-references', 'live2d-candidates'].includes(rel[0])) return false;
        return !/\.(?:[cm]?ts|map)$/i.test(file) && !['node_modules', '.git', '__pycache__'].includes(path.basename(file));
      });
      logger(`[stage] ${source} -> gateway/${source}`);
    }
    const scripts = path.join(gateway, 'scripts/lib'); fs.mkdirSync(scripts, { recursive: true });
    for (const name of ['managed-webui.ps1', 'managed-comfyui.ps1']) fs.copyFileSync(safe.resolveSafe(root, `scripts/lib/${name}`), path.join(scripts, name));
    execFileSync(process.execPath, [path.join(__dirname, 'desktop-resource-profile.js'), root, gateway, profile], { windowsHide: true, stdio: 'pipe' });
    const after = runtimeBuild(root);
    if (after.receipt.source.sha256 !== report.source || after.receipt.binary.sha256 !== report.runtime.sha256) throw Error('Rust build changed during staging');
    publishStage(temporary, stage, logger);
    logger(`[stage] Rust payload staged; releaseReady=${report.releaseReady}`);
    return { stage, runtimeExecutable: path.join(stage, 'gateway/huiyu-runtime.exe'), releaseReady: report.releaseReady, pending: report.pending };
  } catch (error) { fs.rmSync(temporary, { recursive: true, force: true }); throw error; }
}
if (require.main === module) withDesktopBuildLock({ workspaceRoot: ROOT }, () => stageResources()).catch((error: any) => { console.error(`[stage] FAIL ${error.message}`); process.exitCode = 1; });
export = { copyDir, publishStage, resolveNpmInvocation, stageResources };
