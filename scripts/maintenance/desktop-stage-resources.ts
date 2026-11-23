'use strict';
// Stage the Rust gateway and the tools that it launches on demand.
import fs = require('node:fs');
import path = require('node:path');
import crypto = require('node:crypto');
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const { withWorkspaceLock }: typeof import('../lib/workspace-lock') = require('../lib/workspace-lock');
const { copyRustPayload, runtimeBuild }: typeof import('./desktop-rust-inputs') = require('./desktop-rust-inputs');
const catalog: typeof import('../lib/catalog-snapshot') = require('../lib/catalog-snapshot');
import { stageRemoteSceneRecipes } from '../lib/remote-scene-recipe-cache';
import { timeDesktopBuild } from '../lib/desktop-build-timing';
import buildEnvironment = require('../lib/desktop-build-environment');
const { includeAsset }: typeof import('../lib/resource-install-packaging') = require('../lib/resource-install-packaging');
import safe = require('../lib/delivery-paths');
import type { DesktopBuildProfile } from '../lib/desktop-build-profile';
type Logger = (message: string) => void;
interface StageOptions { root?: string; stage?: string; resourceProfile?: string; buildProfile?: DesktopBuildProfile; logger?: Logger }
const ROOT = path.resolve(__dirname, '../..');
const ENTRIES = ['docs', 'data', 'dist', 'assets', 'tools'];
const DATA_ROOTS=new Set(['character-reference-standards.json','character-reference-view.json','characters.json','curation.json','loras.json','popular-characters.json','popular-onboarding.json','presets.json','prompt-pinned-scenes.json','retired-scenes.json','scene-blueprints.json','scenes-core.json','scenes-index.json','scenes-natsume.json','scenes-nene.json','scenes-shared.json','scenes.json','tags-dictionary.json','tags.json']);
const DATA_SHARDS=new Set(['catalog','blueprints','popular','references','scenes','tags']);
// These HTTP responses come from Catalog::projection, before static files.
// Keep raw products for native maintenance and remote publication readers.
const CATALOG_PROJECTED_DATA=new Set(['characters.json','popular-characters.json','scene-blueprints.json','curation.json','tags.json','tags-dictionary.json','loras.json','scenes.json','scenes-nene.json','scenes-natsume.json','scenes-shared.json','scenes-core.json','scenes-index.json']);
const OFFLINE_TOOLS = ['Install-OfflineResources.cmd', 'offline-resource-assistant.ps1', 'install-offline-resources.ps1', 'offline-resource-job.ps1'];
const TOOLS=new Set(['nav.js','theme.js','local-status.js','translate-zh-ja.py','voxcpm-server.py','install-translation-model.ps1', ...OFFLINE_TOOLS]);
const INTERROGATE_TOOLS=new Set(['pixai_worker.py','pixai-manifest.json']);
const ADAPTER_TOOLS=['adapter_worker.py','adapter_contract.py','adapter_video.py','adapter_media.py','keyframe_sd.py','prepare_keyframes.py','adapter-models.json','managed-adapter-runtime.windows-x64.json','managed-adapter-models.json','managed-image-resources.json','managed-auxiliary-models.json','requirements-adapters.txt','resident_adapters.py','qwen_prefix_cache.py','native_memory.py','krea_style.py',
  'krea_adapter.py','krea_transport.py','video_memory.py','wan_pipeline.py','wan_a14b_sd.py','keyframe_server.py','import_wan.py','wan22-import.json','import_h3.py','h3_packed.py','h3_sparse.py','h3_modulation.py','h3_rotary.py','h3_text.py','h3_vae.py',
  'native_attention.py','video_acceleration.py','wan_motion.py','longcat_avatar.py','requirements-longcat-avatar.txt','mapped_weights.py','mapped_residency.py','moss_adapter.py','moss_pipeline.py','moss_preview.py','moss_spectrum.py','moss_execution.py','moss_int8.py','moss_text.py','moss_upscale.py','MOSS-LICENSE','SPECTRUM-LICENSE',
  'manga_worker.py','manga_contract.py','manga_screen.py','manga-screen.json','requirements-manga.txt','MANGASCREEN_LICENSE.txt',
  'manga_models.py','manga_cache.py','manga_line_model.py','qwen_manga_int8.py','qwen_manga_euler.py','qwen_manga_vae.py','MANGALINE_LICENSE.txt','requirements-manga-models.txt',
  'musetalk_native.py','musetalk_ink.py','studio_export.py','studio_export_media.py','studio_export_process.py','studio_export_enhance.py','studio_export_assets.py'];
const INFERENCE_TOOLS=new Set(['anima_rocm_fused.py','anima_qk_gfx1150.co','anima_composition.py','anima_lllite.py','anima_regions.py','worker.py','worker_lifecycle.py','anima_cache.py','anima_local_cache.py','anima_loader.py','anima_dependencies.py','anima_device.py','anima_execution.py','anima_memory.py','anima_vae.py','anima_tiling.py','MASK_PROCESSING_LICENSE.txt','resident_anima.py','resident_benchmark.py','anima_text_cache.py','anima_lora.py','anima_lora_fusion.py','native_hash.py','native_upload.py','locked_identity.py','anima_acceleration.py','anima_fused.py','anima_sampling.py','anima_res_scheduler.py','anima_refinement.py','anima_postprocess.py','anima_prompt_weights.py','anima_upscale.py','RCAS_LICENSE.txt','REMACRI_LICENSE.txt','inference_metrics.py','masked_anima.py','clipseg_mask.py','anima_conversion.py','anima_conversion_profile.py','ANIMA_CONVERSION_LICENSE.txt','teacache_anima.py','teacache_profile.py','teacache_calibration.py','TEACACHE_LICENSE.txt','requirements.txt','runtime-manifest.json','managed-runtime.windows-x64.json','managed-models.json']);
function includeTools(parts:string[],file:string):boolean {
  if(parts[0]==='inference') return parts.length===1 ? fs.statSync(file).isDirectory() : parts.length===2&&(INFERENCE_TOOLS.has(parts[1])||ADAPTER_TOOLS.includes(parts[1]));
  if(parts[0]==='interrogate') return parts.length===1 ? fs.statSync(file).isDirectory() : parts.length===2&&INTERROGATE_TOOLS.has(parts[1]);
  if(parts[0]==='voice') return parts.length===1 ? fs.statSync(file).isDirectory() : parts.length===2&&(parts[1]==='native_gpt_sovits.py'||parts[1]==='managed-voice-packs.json');
  return parts.length===1&&TOOLS.has(parts[0].replace(/\.(?:br|gz)$/i,''));
}
function includeData(parts:string[],file:string,catalogSnapshot=false):boolean {
  if(parts.some(part=>part.startsWith('.')))return false;
  if(catalogSnapshot&&parts.length===1&&/\.(?:br|gz)$/i.test(parts[0])&&CATALOG_PROJECTED_DATA.has(parts[0].replace(/\.(?:br|gz)$/i,'')))return false;
  // Current installs seed SQLite from the validated snapshot. Legacy shards
  // remain available to old source workspaces, never as a second bundled seed.
  if(catalogSnapshot&&['blueprints','popular','scenes'].includes(parts[0]))return false;
  if(parts.length===1&&DATA_SHARDS.has(parts[0]))return fs.statSync(file).isDirectory();
  // Nested shards are read locally; HTTP only exposes the named root products.
  // Their precompressed copies have no desktop consumer.
  if(DATA_SHARDS.has(parts[0]))return fs.statSync(file).isDirectory()||/\.json$/i.test(parts.at(-1)!);
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
function stageDesktopCli(root: string, gateway: string) {
  const source = safe.resolveSafe(root, 'tools/cli-anything-huiyu');
  const target = path.join(gateway, 'tools/cli-anything-huiyu');
  fs.mkdirSync(target, { recursive: true });
  for (const name of ['cli.mjs', 'muse.mjs', 'diagnostics.mjs', 'package.json', 'tool.json', 'SKILL.md', 'LICENSE']) {
    fs.copyFileSync(safe.resolveSafe(source, name), path.join(target, name));
  }
  execFileSync('rustc', ['--edition=2024', '-C', 'opt-level=s', '-C', 'strip=symbols',
    safe.resolveSafe(source, 'launcher.rs'), '-o', path.join(target, 'cli-anything-huiyu.exe')],
    { cwd: root, env: buildEnvironment.desktopBuildEnvironment(root), windowsHide: true, stdio: 'inherit' });
  fs.rmSync(path.join(target, 'cli-anything-huiyu.pdb'), { force: true });
}
function stageQqSdk(root: string, gateway: string) {
  const qq = path.join(gateway, 'qq-sdk');
  const modules = path.join(qq, 'node_modules');
  const sdkModule = safe.resolveSafe(root, 'node_modules/@tencent-connect/qqbot-nodejs');
  const sdkTarget = path.join(modules, '@tencent-connect/qqbot-nodejs');
  const resolveSdkDep = createRequire(path.join(sdkModule, 'package.json'));
  const wsModule = path.dirname(resolveSdkDep.resolve('ws/package.json'));
  const wsTarget = path.join(modules, 'ws');
  fs.mkdirSync(qq, { recursive: true });
  fs.copyFileSync(safe.resolveSafe(root, 'node_modules/node-win-x64/bin/node.exe'), path.join(qq, 'node.exe'));
  fs.copyFileSync(safe.resolveSafe(root, 'tools/qq/Node-LICENSE.txt'), path.join(qq, 'Node-LICENSE.txt'));
  fs.copyFileSync(safe.resolveSafe(root, 'scripts/maintenance/qq-sdk-worker.mjs'), path.join(qq, 'sdk-worker.mjs'));
  copyDir(path.join(sdkModule, 'dist'), path.join(sdkTarget, 'dist'), file => fs.statSync(file).isDirectory() || file.endsWith('.js'));
  copyDir(path.join(wsModule, 'lib'), path.join(wsTarget, 'lib'));
  for (const name of ['package.json', 'LICENSE']) {
    fs.copyFileSync(path.join(sdkModule, name), path.join(sdkTarget, name));
    fs.copyFileSync(path.join(wsModule, name), path.join(wsTarget, name));
  }
  for (const name of ['index.js', 'wrapper.mjs', 'browser.js']) {
    fs.copyFileSync(path.join(wsModule, name), path.join(wsTarget, name));
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
// This inventory describes the actual packaged bytes, not the source tree.
// It lets a later installer distinguish retired application files from extras.
function writeResourceInventory(stage: string) {
  const files: { path: string; bytes: number; sha256: string }[] = [];
  const scan = safe.pathScan(stage);
  function visit(directory: string) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) {
        const relative = path.relative(stage, file).replaceAll('\\', '/');
        const identity = safe.fileEntry(stage, relative, scan);
        if (identity.status !== 'file') throw Error(`Cannot inventory bundled resource: ${relative}`);
        files.push({ path: relative, bytes: identity.bytes, sha256: identity.sha256 });
      } else throw Error(`Bundled resource is not a regular file: ${file}`);
    }
  }
  visit(path.join(stage, 'gateway'));
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  fs.writeFileSync(path.join(stage, 'gateway/bundled-resource-inventory.json'), JSON.stringify({ schemaVersion: 1, kind: 'huiyu-bundled-resources', files }));
}
async function stageResources(options: StageOptions = {}) {
  const root = fs.realpathSync(options.root || ROOT), stage = path.resolve(options.stage || path.join(root, 'desktop-tauri/src-tauri/resources'));
  const rel = path.relative(root, stage).replaceAll('\\', '/');
  if (!rel || rel.startsWith('../') || path.isAbsolute(rel) || ['data', 'assets', 'dist', 'tools', 'docs', 'runtime-rs'].some(dir => rel === dir || rel.startsWith(dir + '/'))) throw Error('Staging destination must be an isolated child of workspace');
  safe.resolveSafe(root, rel, true);
  const logger = options.logger || console.log, profile = options.resourceProfile || process.env.AICS_DESKTOP_RESOURCE_PROFILE || 'full';
  if (!['full', 'base'].includes(profile)) throw Error('Resource profile must be full or base');
  const buildProfile = options.buildProfile || 'release';
  const runtime = runtimeBuild(root, buildProfile); // Fail before replacing or copying anything if source/executable binding is stale.
  const catalogRows = catalog.read(root);
  const catalogSnapshot = catalogRows !== null;
  for (const name of OFFLINE_TOOLS) {
    const file = safe.resolveSafe(root, `tools/${name}`);
    if (!fs.statSync(file).isFile() || fs.statSync(file).size === 0) throw Error(`Missing offline resource assistant: ${name}`);
  }
  fs.mkdirSync(path.dirname(stage), { recursive: true });
  const temporary = fs.mkdtempSync(`${stage}.tmp-${process.pid}-`), gateway = path.join(temporary, 'gateway');
  fs.mkdirSync(gateway);
  try {
    const report = copyRustPayload(root, gateway, buildProfile, runtime);
    stageQqSdk(root, gateway);
    stageDesktopCli(root, gateway);
    fs.copyFileSync(safe.resolveSafe(root, 'desktop-tauri/src-tauri/installer/generated/HuiyuResourceCleanup.exe'), path.join(gateway, 'installer-resource-cleanup.exe'));
    for (const source of ENTRIES) {
      const from = safe.resolveSafe(root, source);
      copyDir(from, path.join(gateway, source), file => {
        const rel = path.relative(from, file).split(path.sep);
        if(source==='data'&&!includeData(rel,file,catalogSnapshot))return false;
        if(source==='tools'&&!includeTools(rel,file))return false;
        // Desktop Chromium and modern browsers use Brotli; other clients can
        // still use the original file. Shipping both variants duplicates bytes.
        if ((source === 'dist' || source === 'data') && file.endsWith('.gz') && fs.existsSync(file.replace(/\.gz$/, '.br'))) return false;
        if (source === 'assets' && !includeAsset(rel.join('/'))) return false;
        // Promotional screenshots are referenced only by repository READMEs.
        if (source === 'docs' && rel[0] === 'images' && rel[1] === 'software-preview') return false;
        return !/\.(?:[cm]?ts|map)$/i.test(file) && !['node_modules', '.git', '__pycache__'].includes(path.basename(file));
      });
      logger(`[stage] ${source} -> gateway/${source}`);
    }
    const scripts = path.join(gateway, 'scripts/lib'); fs.mkdirSync(scripts, { recursive: true });
    for (const name of ['managed-comfyui.ps1', 'managed-voice.ps1', 'prepare-ai-environment.ps1', 'prepare-native-runtime.ps1', 'install-native-runtime.py', 'prepare-pixai-runtime.py']) fs.copyFileSync(safe.resolveSafe(root, `scripts/lib/${name}`), path.join(scripts, name));
    const inferencePrep = path.join(gateway, 'scripts/maintenance'); fs.mkdirSync(inferencePrep, { recursive: true });
    for (const name of ['prepare-inference.py', 'inspect-anima-checkpoint.py', 'convert-anima-checkpoint.py', 'calibrate-anima-teacache.py', 'import-anima-directory.py']) fs.copyFileSync(safe.resolveSafe(root, `scripts/maintenance/${name}`), path.join(inferencePrep, name));
    execFileSync(process.execPath, [path.join(__dirname, 'desktop-resource-profile.js'), root, gateway, profile], { windowsHide: true, stdio: 'pipe' });
    if (catalogRows) {
      const count = await timeDesktopBuild('remote scene recipes', () =>
        stageRemoteSceneRecipes(root, gateway, catalogRows, buildProfile === 'desktop-local', logger));
      logger(`[stage] 远程场景配方 ${count} 条`);
    }
    writeResourceInventory(temporary);
    const after = runtimeBuild(root, buildProfile);
    if (after.receipt.source.sha256 !== report.source || after.receipt.binary.sha256 !== report.runtime.sha256) throw Error('Rust build changed during staging');
    publishStage(temporary, stage, logger);
    logger(`[stage] Rust payload staged; releaseReady=${report.releaseReady}`);
    return { stage, runtimeExecutable: path.join(stage, 'gateway/huiyu-runtime.exe'), releaseReady: report.releaseReady, pending: report.pending };
  } catch (error) { fs.rmSync(temporary, { recursive: true, force: true }); throw error; }
}
if (require.main === module) withWorkspaceLock({ workspaceRoot: ROOT }, () => stageResources()).catch((error: any) => { console.error(`[stage] FAIL ${error.message}`); process.exitCode = 1; });
export = { includeData, resolveNpmInvocation, stageDesktopCli, stageResources };
