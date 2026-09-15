import { errorCode as runtimeErrorCode, errorMessage as runtimeErrorMessage, errorStatus as runtimeErrorStatus } from '../scripts/lib/runtime-errors';
'use strict';

import { Request,Response } from 'express-serve-static-core';
import { ParsedQs } from 'qs';

let { saveSnapshotBackup }: typeof import('./maintenance-backup') = require('./maintenance-backup');
let { sanitizeCuration, validateTags, decodeJpegDataUrl, readJson }: typeof import('./maintenance-validation') = require('./maintenance-validation');
const recoveryFs: typeof import('../scripts/lib/maintenance-recovery-fs') = require('../scripts/lib/maintenance-recovery-fs');
const { acquireMaintenanceLease, maintenanceReadToken, inspectMaintenanceLease }: typeof import('../scripts/lib/maintenance-lease') = require('../scripts/lib/maintenance-lease');
const { prepareMaintenanceTransaction, commitMaintenanceTransaction, rollbackMaintenanceTransaction, withMaintenanceTransaction }: typeof import('../scripts/lib/maintenance-transaction') = require('../scripts/lib/maintenance-transaction');
const { runMaintenanceNode }: typeof import('../scripts/lib/maintenance-transaction-process') = require('../scripts/lib/maintenance-transaction-process');
const { maintenanceReadBarrier }: typeof import('./maintenance-read-barrier') = require('./maintenance-read-barrier');
const products: typeof import('./maintenance-content-products') = require('./maintenance-content-products');
const { captureMaintenanceSnapshot }: typeof import('../scripts/lib/maintenance-transaction-snapshot') = require('../scripts/lib/maintenance-transaction-snapshot');
const writeFileAtomic = (file: string, bytes: string|Buffer<ArrayBuffer>) => recoveryFs.atomicWrite(file, bytes, true);
const writeJson = (file: string, value: unknown) => writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');

let fs: typeof import('fs') = require('fs');
let path: typeof import('path') = require('path');
let express: typeof import('express') = require('express');
let envelope: typeof import('../server/http-envelope') = require('../server/http-envelope');
let processTree: typeof import('../server/process-tree') = require('../server/process-tree');

// ── 维护路由分区总览（P1-10 轻度拆分，不做物理文件拆分，逻辑按区归位） ──
// ── 1. 事务与备份工具 ──
// ── 2. 校验与文件工具 ──
// ── 3. 路由：scenes/tags/curation ──
// ── 4. 路由：showcase/home-hero ──
// ── 5. 路由：run/backups ──
// ── 6. 进程管理 ──

// ── 0. 常量 ──
let MAINT_TIMEOUT_MS = 120000; // 维护脚本默认超时 120s

// 维护脚本名映射（script 文件名）——与任务表一一对应，集中在顶部便于总览
let SCRIPT_NAMES: any = {
  'lint-colors': 'lint-colors.js',
  'validate': 'validate-scenes.js',
  'classify': 'classify-scene-ratings.js',
  'optimize': 'optimize-scenes.js'
};
// 维护任务表——供 /api/maintenance/run 校验与执行，args 为脚本参数，label/desc 供前端展示
let MAINTENANCE_TASKS: any = {
  'lint-colors': { args:[], label:'检查硬编码颜色', desc:'扫描所有 HTML/CSS 中的 #XXXXXX 颜色，确保已替换为设计 token' },
  'validate':    { args:[], label:'完整场景校验', desc:'按模块检查场景数据：ID 唯一性、字段完整性、评级一致性' },
  'classify':    { args:['--write'], label:'更新场景评级', desc:'根据标签内容重新计算 All/R15/R18 评级' },
  'optimize':    { args:['--write'], label:'规范化提示词', desc:'统一标签命名、补全标准负面词、修复占位符' }
};

// ── 1. 事务与备份工具 ──
// 内容版本哈希与 scripts/lib/data-version.js 共用单一来源（13 个 data 产物的 sha1 派生）
let expectedDataVersion = (require('../scripts/lib/data-version') as typeof import('../scripts/lib/data-version')).expectedDataVersion;
// 场景写入侧治理（计划 006 D5）：稳定 ID 分配、增量分片写入、完整性校验、退役登记
let sceneWrite: typeof import('../scripts/lib/scene-write') = require('../scripts/lib/scene-write');

function syncSceneStoreDataVersion(rootDir: string) {
  let expected = expectedDataVersion(rootDir);
  let storePath = path.join(rootDir, 'src', 'stores', 'sceneStore.ts');
  if (fs.existsSync(storePath)) {
    let storeSource = fs.readFileSync(storePath, 'utf8');
    storeSource = storeSource.replace(/DATA_VERSION\s*=\s*\d+/, 'DATA_VERSION = ' + expected);
    writeFileAtomic(storePath, storeSource);
  }
  return expected;
}







function snapshotFiles(files: string[]) {
  return recoveryFs.snapshotFiles(files);
}

function restoreSnapshot(snapshot: unknown[]) {
  snapshot.forEach(function (item: any) {
    if (item.exists) writeFileAtomic(item.file, item.content);
    else recoveryFs.removeFile(item.file);
  });
}

/**
 * 尝试回滚，并把结果如实返回。
 *
 * 保存失败 + 回滚也失败 = 数据处于半写状态。原先两处 catch 都是空的，
 * 客户端只看到"保存失败"，完全不知道盘上已经被改了一半。
 */
function attemptRollback(snapshot: unknown, label: string) {
  if (!snapshot) return { ok:true };
  try {
    restoreSnapshot(snapshot);
    return { ok:true };
  } catch (error: any) {
    let detail = String(error && error.message || error);
    console.error('  ❌ 回滚失败（' + label + '），数据可能不一致:', detail);
    return { ok:false, error:detail };
  }
}



// ── 2. 校验与文件工具 ──








// ── 2. 校验与文件工具（续）── 本机判定与桌面打包判定
// 判定「直连本机」的逻辑只保留 server/security.js 一份，避免副本再次漂移。
let isDirectLocalRequest = (require('../server/security') as typeof import('../server/security')).isDirectLocalRequest;

function maintenanceLocalOnly(req: any, res: any, next: () => void) {
  if (!isDirectLocalRequest(req)) return envelope.fail(res, 403, '维护操作仅允许在本机执行');
  next();
}

/**
 * 打包模式（Tauri 安装版）判定：data 位于只读应用包、维护脚本未打包、
 * npm/系统 node 也读不了包内文件 —— 内容维护链路整体不可用。
 * 标志由 Tauri 壳仅在打包模式注入（main_shared.rs gateway_env → config.DESKTOP_PACKAGED）。
 */
function isDesktopPackagedMode(cfg: any) {
  return Boolean(cfg && cfg.DESKTOP_PACKAGED);
}

const DESKTOP_MAINTENANCE_UNAVAILABLE = '桌面应用模式下场景内容编辑不可用（数据位于只读的应用包内）。' +
  '请在源码开发模式（npm run dev / npm start）中编辑场景内容。';

function desktopMaintenanceUnavailable(req: Request<{},unknown,unknown,ParsedQs,Record<string,unknown>>, res: any) {
  return envelope.fail(res, 501, DESKTOP_MAINTENANCE_UNAVAILABLE, { code:'DESKTOP_MAINTENANCE_UNAVAILABLE' });
}

// ── 6. 进程管理 ──
/**
 * 网关在跑的子进程登记表：/api/maintenance/run 与场景保存校验链可能耗时
 * 数分钟，网关退出时必须连树回收，否则脚本会继续写文件直到自然结束。
 * 模块级共享：control.js 的构建进程也登记到这里（经 module.exports 暴露）。
 */
let activeChildren = new Set();

function trackChild(child: any) {
  activeChildren.add(child);
  child.once('close', function () { activeChildren.delete(child); });
  child.once('error', function () { activeChildren.delete(child); });
  return child;
}

function killActiveChildren() {
  activeChildren.forEach(function (child) { processTree.killProcessTree(child); });
  activeChildren.clear();
}

// ── 3. 路由：scenes/tags/curation ── · ── 4. 路由：showcase/home-hero ── · ── 5. 路由：run/backups ──
function createMaintenanceRouter(cfg: any) {
  let router = express.Router();
  const leaseOptions = { rootDir: cfg.ROOT_DIR, runtimeRoot: cfg.RUNTIME_ROOT, showcaseRoot: cfg.SCENE_SHOWCASE_DIR };
  if (!isDesktopPackagedMode(cfg)) maintenanceReadToken(leaseOptions);
  let sceneStore: typeof import('../scripts/lib/scene-store') = require('../scripts/lib/scene-store');

  if (!isDesktopPackagedMode(cfg)) router.use(['/data', '/scene-showcase'], maintenanceReadBarrier(leaseOptions));
  if (!isDesktopPackagedMode(cfg)) router.use('/api/maintenance/home-hero', (req, res, next) =>
    req.method === 'GET' ? maintenanceReadBarrier(leaseOptions)(req, res, next) : next());
  router.get('/api/maintenance/recovery-status', maintenanceLocalOnly, function (req, res) {
    if (isDesktopPackagedMode(cfg)) return desktopMaintenanceUnavailable(req, res);
    const state = inspectMaintenanceLease(leaseOptions);
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: state.status === 'free', status: state.status, recoveryRequired: state.recoveryRequired,
      code: state.code, transactionId: state.journal?.nonce, phase: state.journal?.phase, backup: state.journal?.backup?.id });
  });

  let SCENE_SHOWCASE_DIR = cfg.SCENE_SHOWCASE_DIR;
  let MAINTENANCE_BACKUP_DIR = path.join(cfg.RUNTIME_ROOT, 'maintenance-backups');

  function maintenanceSnapshot(deletedIds: never[]|undefined) {
    return captureMaintenanceSnapshot(leaseOptions, sceneStore, deletedIds);
  }

  function runNodeScript(script: string|string[], args: string|string[], timeoutMs: number, lease: unknown) {
    return runMaintenanceNode(script, args || [], timeoutMs || MAINT_TIMEOUT_MS, {
      rootDir: cfg.ROOT_DIR, repoRoot: path.join(__dirname, '..'), lease, trackChild, killChild: processTree.killProcessTree,
    });
  }

async function runMaintenanceChecks(lease: unknown) {
  let commands = [
    ['scripts/maintenance/classify-scene-ratings.js', ['--write']],
    ['scripts/maintenance/optimize-scenes.js', ['--write']],
    ['scripts/maintenance/validate-scenes.js', []]
  ];
  for (let i = 0; i < commands.length; i += 1) {
    let result: any = await runNodeScript(commands[i][0], commands[i][1], MAINT_TIMEOUT_MS, lease);
    if (result.status !== 0) {
      throw new Error((result.stderr || result.stdout || '维护校验失败').trim().slice(-1200));
    }
  }
}

  // 首页立绘 manifest 缓存（2026-08-21 性能审计 #8）：GET 是匿名公网端点，每次
  // 访问都同步扫版本目录 + 逐个 existsSync/readJson。5s TTL 兜底外部发布脚本的
  // 直接写盘；本地保存（下方 POST）成功后主动失效。POST 会原地改写返回对象，
  // 所以缓存命中必须返回两层浅拷贝。
  let HOME_HERO_CACHE_TTL_MS = 5000;
  let homeHeroCache = { at:0, manifest:null };

  function readHomeHeroManifest() {
    let fallback = { version:1, entries:{} };
    if (!SCENE_SHOWCASE_DIR) return fallback;
    let now = Date.now();
    if (homeHeroCache.manifest && now - homeHeroCache.at < HOME_HERO_CACHE_TTL_MS) {
      let hit: any = homeHeroCache.manifest;
      return Object.assign({}, hit, { entries: Object.assign({}, hit.entries) });
    }
    // 当前版本目录可能还没有 home-hero.json（发布流程先建目录后写 home 立绘；
    // 2026-08-15 实机：v20/v21 缺 home-hero.json，首页回退旧立绘）。
    // 从当前版本向旧版本回退，取最近一份完整 manifest。
    let showcaseRoot = path.dirname(SCENE_SHOWCASE_DIR);
    let currentName = path.basename(SCENE_SHOWCASE_DIR);
    let candidates = [];
    try {
      candidates = fs.readdirSync(showcaseRoot, { withFileTypes:true })
        .filter(function (entry) {
          return entry.isDirectory()
            && !entry.name.startsWith('.')
            && fs.existsSync(path.join(showcaseRoot, entry.name, 'manifest.json'));
        })
        .map(function (entry) { return path.join(showcaseRoot, entry.name); })
        .sort(function (a, b) { return path.basename(b).localeCompare(path.basename(a), 'zh-CN'); });
    } catch (e) { return fallback; }
    let ownIndex = candidates.findIndex(function (dir) { return path.basename(dir) === currentName; });
    let ordered = ownIndex >= 0 ? candidates.slice(ownIndex) : candidates;
    for (let i = 0; i < ordered.length; i++) {
      let source = path.join(ordered[i], 'home-hero.json');
      if (!fs.existsSync(source)) continue;
      try {
        let data = readJson(source);
        if (data && data.entries && typeof data.entries === 'object') {
          homeHeroCache.at = now;
          homeHeroCache.manifest = data;
          return data;
        }
      } catch (e) { /* try older version */ }
    }
    return fallback;
  }

  router.get('/api/maintenance/backups', maintenanceLocalOnly, function (req, res) {
    try {
      if (!fs.existsSync(MAINTENANCE_BACKUP_DIR)) return envelope.ok(res, { entries: [] });
      let dirents = fs.readdirSync(MAINTENANCE_BACKUP_DIR, { withFileTypes:true });
      let entries: unknown[] = [];
      dirents.forEach(function (entry) {
        if (!entry.isDirectory()) return;
        let id = entry.name;
        let manifestPath = path.join(MAINTENANCE_BACKUP_DIR, id, 'manifest.json');
        if (!fs.existsSync(manifestPath)) return;
        try {
          let manifest = readJson(manifestPath);
          entries.push({
            id: id,
            label: String(manifest && manifest.label || ''),
            createdAt: String(manifest && manifest.createdAt || ''),
            fileCount: Array.isArray(manifest && manifest.files) ? manifest.files.length : 0
          });
        } catch (e) { /* 跳过损坏的备份 */ }
      });
      entries.sort(function (a: any, b: any) {
        let ta = Date.parse(a.createdAt) || 0;
        let tb = Date.parse(b.createdAt) || 0;
        if (tb !== ta) return tb - ta;
        return String(b.id).localeCompare(String(a.id));
      });
      if (entries.length > 50) entries = entries.slice(0, 50);
      return envelope.ok(res, { entries: entries });
    } catch (error) {
      return envelope.fail(res, 500, runtimeErrorMessage(error) || '读取备份历史失败');
    }
  });

  // GET 必须公开：公网访客也要拿到运行时首页立绘配置（只含图片路径，
  // 不含任何敏感信息）。之前 maintenanceLocalOnly 把公网 403 掉，
  // 访客只能看到打包进 dist 的默认旧立绘——"公网首页还是老图"的根源。
  router.get('/api/maintenance/home-hero', function (req, res) {
    let manifest = readHomeHeroManifest();
    let entries: any = {};
    Object.keys(manifest.entries || {}).forEach(function (character) {
      if (!/^(nene|natsume)$/.test(character)) return;
      let entry = manifest.entries[character];
      if (!entry || entry.image !== 'home/' + character + '.jpg') return;
      entries[character] = {
        image:'/scene-showcase/home/' + character + '.jpg?v=' + encodeURIComponent(String(entry.updatedAt || manifest.version || 1)),
        updatedAt:entry.updatedAt || null
      };
    });
    res.json({ ok:true, version:manifest.version || 1, entries:entries });
  });

  (require('./maintenance-scene-save') as typeof import('./maintenance-scene-save')).registerSceneMaintenance({
    router, cfg, sceneStore, localOnly:maintenanceLocalOnly,
    packaged:isDesktopPackagedMode, unavailable:desktopMaintenanceUnavailable,
    maintenanceSnapshot, attemptRollback, runMaintenanceChecks, runNodeScript,
    syncVersion:syncSceneStoreDataVersion, timeoutMs:MAINT_TIMEOUT_MS
  });

  router.post('/api/maintenance/showcase', maintenanceLocalOnly, express.json({ limit:'26mb' }), function (req, res) {
    let snapshot;
    let lease;
    try {
      if (!SCENE_SHOWCASE_DIR) return envelope.fail(res, 503, '尚未找到 SceneShowcase 目录');
      lease = acquireMaintenanceLease(leaseOptions);
      let id = String(req.body && req.body.id || '').trim();
      if (!/^(sc\d{3}|pc_[a-zA-Z0-9_-]+|[a-zA-Z0-9_-]+)$/.test(id)) return envelope.fail(res, 400, '需要合法场景或蓝图 ID');
      let scenes = sceneStore.loadSceneShards().scenes;
      let scene = scenes.find(function (item) { return item.id === id; });
      let popularBlueprint: any = null;
      let popularCharacter = null;

      if (!scene) {
        let bpPath = path.join(cfg.ROOT_DIR, 'data', 'scene-blueprints.json');
        let popPath = path.join(cfg.ROOT_DIR, 'data', 'popular-characters.json');
        if (fs.existsSync(bpPath) && fs.existsSync(popPath)) {
          let allBp = readJson(bpPath);
          let allPop = readJson(popPath);
          let bpList = Array.isArray(allBp) ? allBp : (allBp.blueprints || []);
          let popList = Array.isArray(allPop) ? allPop : (allPop.characters || []);
          popularBlueprint = bpList.find(function (b: { id: string; characterId: string; }) {
            return b.id === id || ('pc_' + b.characterId + '_' + b.id) === id;
          });
          if (popularBlueprint) {
            popularCharacter = popList.find(function (c: any) { return c.id === popularBlueprint.characterId; });
          }
        }
      }

      if (!scene && !popularBlueprint) return envelope.fail(res, 404, '场景或蓝图不存在，不能保存孤立样张：' + id);
      let buffer = decodeJpegDataUrl(req.body && req.body.image, '原图');
      let thumbBuffer = req.body && req.body.thumbnail ? decodeJpegDataUrl(req.body.thumbnail, '缩略图') : buffer;
      if (buffer.length > 15 * 1024 * 1024 || thumbBuffer.length > 3 * 1024 * 1024) return envelope.fail(res, 413, '原图必须在 15MB 以内，缩略图必须在 3MB 以内');
      let imageDir = path.join(SCENE_SHOWCASE_DIR, 'images');
      let thumbDir = path.join(SCENE_SHOWCASE_DIR, 'thumbs');
      let manifestPath = path.join(SCENE_SHOWCASE_DIR, 'manifest.json');
      let affected = [manifestPath];
      ['jpg', 'png', 'webp'].forEach(function (ext) {
        affected.push(path.join(imageDir, id + '.' + ext));
        affected.push(path.join(thumbDir, id + '.' + ext));
      });
      snapshot = snapshotFiles(affected);
      let backupDir = prepareMaintenanceTransaction(lease, leaseOptions, snapshot, 'showcase-' + id);
      writeFileAtomic(path.join(imageDir, id + '.jpg'), buffer);
      writeFileAtomic(path.join(thumbDir, id + '.jpg'), thumbBuffer);
      ['png', 'webp'].forEach(function (ext) {
        let oldImage = path.join(imageDir, id + '.' + ext);
        let oldThumb = path.join(thumbDir, id + '.' + ext);
        if (fs.existsSync(oldImage)) fs.unlinkSync(oldImage);
        if (fs.existsSync(oldThumb)) fs.unlinkSync(oldThumb);
      });
      let manifest = fs.existsSync(manifestPath) ? readJson(manifestPath) : { version:23, entries:[] };
      if (!Array.isArray(manifest.entries)) manifest.entries = [];
      let manifestEntryId = scene ? id : (id.startsWith('pc_') ? id : ('pc_' + popularBlueprint.characterId + '_' + popularBlueprint.id));
      let idx = manifest.entries.findIndex(function (entry: { id: string; }) { return entry.id === manifestEntryId; });
      let entry = scene ? {
        id: scene.id,
        title: scene.title,
        category: scene.category,
        story: scene.story,
        char: scene.char,
        rating: scene.rating,
        attempt: 1,
        image: 'images/' + id + '.jpg',
        thumb: 'thumbs/' + id + '.jpg'
      } : {
        id: manifestEntryId,
        title: (popularCharacter ? popularCharacter.displayName : popularBlueprint.characterId) + ' / ' + popularBlueprint.title,
        story: popularBlueprint.description || '',
        category: '热门角色',
        char: popularBlueprint.characterId,
        displayName: popularCharacter ? popularCharacter.displayName : popularBlueprint.characterId,
        rating: popularBlueprint.adult ? 'R18' : 'All',
        attempt: 1,
        type: 'popular',
        image: 'images/' + id + '.jpg',
        thumb: 'thumbs/' + id + '.jpg'
      };
      if (idx >= 0) manifest.entries[idx] = entry;
      else manifest.entries.push(entry);
      manifest.entryCount = manifest.entries.length;
      manifest.sceneCount = manifest.entries.length;
      manifest.counts = manifest.counts || {};
      manifest.counts.popular = manifest.entries.filter(function (e: { type: string; }) { return e.type === 'popular'; }).length;
      writeJson(manifestPath, manifest);
      commitMaintenanceTransaction(lease);
      lease = undefined;
      res.json({ ok:true, file:entry.image, thumb:entry.thumb, backup:path.basename(backupDir), message:'样张与轻量缩略图已安全保存，旧版本已备份' });
    } catch (error: any) {
      let rollback = lease ? rollbackMaintenanceTransaction(lease, leaseOptions) : { ok: !error.recoveryRequired };
      lease = undefined;
      res.status(runtimeErrorStatus(error, 'statusCode') || (rollback.ok ? 400 : 500)).json({
        ok:false,
        error:runtimeErrorMessage(error), code:runtimeErrorCode(error), recoveryRequired:!rollback.ok,
        rolledBack:rollback.ok,
        dataIntegrity:rollback.ok ? 'restored' : 'INCONSISTENT',
        recovery:rollback.ok ? undefined
          : '自动回滚也失败了（' + rollback.error + '）。样张目录可能只写了一半，'
            + '请用 runtime 备份目录里最近一份 showcase-* 手动恢复。'
      });
    } finally { if (lease) rollbackMaintenanceTransaction(lease, leaseOptions); }
  });

  router.post('/api/maintenance/home-hero', maintenanceLocalOnly, express.json({ limit:'26mb' }), function (req, res) {
    let snapshot;
    let lease;
    try {
      if (!SCENE_SHOWCASE_DIR) return envelope.fail(res, 503, '尚未找到 SceneShowcase 目录');
      lease = acquireMaintenanceLease(leaseOptions);
      let character = String(req.body && req.body.character || '');
      if (!/^(nene|natsume)$/.test(character)) return envelope.fail(res, 400, '首页主视觉角色无效');
      let action = String(req.body && req.body.action || 'replace');
      let root = path.join(SCENE_SHOWCASE_DIR, 'home');
      let imagePath = path.join(root, character + '.jpg');
      let manifestPath = path.join(SCENE_SHOWCASE_DIR, 'home-hero.json');
      snapshot = snapshotFiles([imagePath, manifestPath]);
      let backupDir = prepareMaintenanceTransaction(lease, leaseOptions, snapshot, 'home-hero-' + character);
      let manifest = readHomeHeroManifest();
      if (action === 'reset') {
        if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
        delete manifest.entries[character];
      } else {
        let buffer = decodeJpegDataUrl(req.body && req.body.image, '首页主视觉');
        if (buffer.length > 15 * 1024 * 1024) return envelope.fail(res, 413, '首页主视觉必须在 15MB 以内');
        fs.mkdirSync(root, { recursive:true });
        writeFileAtomic(imagePath, buffer);
        manifest.entries[character] = {
          image:'home/' + character + '.jpg',
          updatedAt:new Date().toISOString()
        };
      }
      manifest.version = Number(manifest.version || 1) + 1;
      writeJson(manifestPath, manifest);
      // 写盘成功后立即失效缓存，维护端保存后立刻能读到新配置
      homeHeroCache.at = 0;
      commitMaintenanceTransaction(lease);
      lease = undefined;
      res.json({ ok:true, character:character, action:action, backup:path.basename(backupDir), message:action === 'reset' ? '已恢复内置首页主视觉' : '首页主视觉已保存' });
    } catch (error: any) {
      let rollback = lease ? rollbackMaintenanceTransaction(lease, leaseOptions) : { ok: !error.recoveryRequired };
      lease = undefined;
      res.status(runtimeErrorStatus(error, 'statusCode') || (rollback.ok ? 400 : 500)).json({ ok:false, error:runtimeErrorMessage(error), code:runtimeErrorCode(error), recoveryRequired:!rollback.ok, rolledBack:rollback.ok, dataIntegrity:rollback.ok ? 'restored' : 'INCONSISTENT' });
    } finally { if (lease) rollbackMaintenanceTransaction(lease, leaseOptions); }
  });

  // ── 5. 路由：run/backups ── 维护脚本一键执行（SCRIPT_NAMES / MAINTENANCE_TASKS 已上移顶部常量区）

  // 必须异步。原先这里是 spawnSync(timeout:120000) —— 跑在 POST handler 里，
  // 期间整个事件循环停摆：SD 代理、进行中的 /api/chat NDJSON 流、/api/tts 的
  // 音频中继全部一起卡死，最坏 2 分钟。/api/maintenance/scenes 早就改成
  // runNodeScript + await 了，这条路径漏了。
  router.post('/api/maintenance/run', maintenanceLocalOnly, express.json({ limit:'2kb' }), async function (req, res) {
    if (isDesktopPackagedMode(cfg)) return desktopMaintenanceUnavailable(req, res);
    let task = String(req.body && req.body.task || '').trim();
    if (!MAINTENANCE_TASKS[task]) {
      return envelope.fail(res, 400, '不支持的任务：' + task);
    }

    let script = 'scripts/maintenance/' + (SCRIPT_NAMES[task] || task + '.js');
    let args = MAINTENANCE_TASKS[task].args;
    let result;
    try {
      result = await sceneWrite.withSceneWriteLock(() => withMaintenanceTransaction(leaseOptions,
        () => maintenanceSnapshot([]), async (lease: unknown) => {
          const before = sceneStore.loadSceneShards().scenes;
          let output: any = await runNodeScript(script, args, MAINT_TIMEOUT_MS, lease);
          if (output.status !== 0) throw Object.assign(new Error((output.stderr || output.stdout || '维护校验失败').trim().slice(-1200)), { statusCode: 400 });
          if (task === 'classify' || task === 'optimize') {
            products.refreshCompressedProducts(cfg.ROOT_DIR, writeFileAtomic);
            syncSceneStoreDataVersion(cfg.ROOT_DIR);
          }
          products.protectPinnedScenes(cfg.ROOT_DIR, before, sceneStore.loadSceneShards().scenes);
          return output;
        }, 'maintenance-' + task));
    } catch (error: any) {
      return res.status(runtimeErrorStatus(error, 'statusCode') || 504).json({
        ok:false,
        code:runtimeErrorCode(error), recoveryRequired:Boolean(error.recoveryRequired), rolledBack:error.rolledBack, dataIntegrity:error.dataIntegrity,
        task:task,
        label:MAINTENANCE_TASKS[task].label,
        output:'执行出错：' + runtimeErrorMessage(error),
        exitCode:1
      });
    }

    let output = (result.stdout || '') + (result.stderr || '');
    if (output.length > 8000) output = output.slice(0, 8000) + '\n...(truncated)';
    output = output.trim();
    if (!output) output = '任务完成，无输出';
    let payload = {
      task: task,
      label: MAINTENANCE_TASKS[task].label,
      output: output,
      exitCode: result.status
    };
    if (result.status !== 0) return envelope.fail(res, 400, output, payload);
    return envelope.ok(res, payload);
  });

  return {
    router:router,
    sceneStore:sceneStore,
    close:killActiveChildren
  };
}

export = {
  createMaintenanceRouter:createMaintenanceRouter,
  // 子进程登记/回收共享给 control.js（build-web 的构建进程也要在网关退出时回收）
  trackChild:trackChild,
  killActiveChildren:killActiveChildren,
  // 进程树终止由 server/process-tree.js 统一实现（P3 收口）
  killProcessTree:processTree.killProcessTree,
  isDesktopPackagedMode:isDesktopPackagedMode,
  _test:{
    decodeJpegDataUrl:decodeJpegDataUrl,
    isDirectLocalRequest:isDirectLocalRequest,
    maintenanceLocalOnly:maintenanceLocalOnly,
    restoreSnapshot:restoreSnapshot,
    sanitizeCuration:sanitizeCuration,
    saveSnapshotBackup:saveSnapshotBackup,
    snapshotFiles:snapshotFiles,
    validateTags:validateTags,
    writeFileAtomic:writeFileAtomic
  }
};
