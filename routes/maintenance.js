'use strict';
var { saveSnapshotBackup } = require('./maintenance-backup');
var { sanitizeCuration, validateTags, decodeJpegDataUrl, readJson, writeFileAtomic, writeJson } = require('./maintenance-validation');

var fs = require('fs');
var path = require('path');
var cp = require('child_process');
var express = require('express');
var envelope = require('../server/http-envelope');
var processTree = require('../server/process-tree');

// ── 维护路由分区总览（P1-10 轻度拆分，不做物理文件拆分，逻辑按区归位） ──
// ── 1. 事务与备份工具 ──
// ── 2. 校验与文件工具 ──
// ── 3. 路由：scenes/tags/curation ──
// ── 4. 路由：showcase/home-hero ──
// ── 5. 路由：run/backups ──
// ── 6. 进程管理 ──

// ── 0. 常量 ──
var MAINT_LOG_CAP = 64 * 1024; // 子进程 stdout/stderr 截断上限，避免多话脚本撑爆内存
var MAINT_TIMEOUT_MS = 120000; // 维护脚本默认超时 120s

// 维护脚本名映射（script 文件名）——与任务表一一对应，集中在顶部便于总览
var SCRIPT_NAMES = {
  'lint-colors': 'lint-colors.js',
  'validate': 'validate-scenes.js',
  'classify': 'classify-scene-ratings.js',
  'optimize': 'optimize-scenes.js'
};
// 维护任务表——供 /api/maintenance/run 校验与执行，args 为脚本参数，label/desc 供前端展示
var MAINTENANCE_TASKS = {
  'lint-colors': { args:[], label:'检查硬编码颜色', desc:'扫描所有 HTML/CSS 中的 #XXXXXX 颜色，确保已替换为设计 token' },
  'validate':    { args:[], label:'完整场景校验', desc:'按模块检查场景数据：ID 唯一性、字段完整性、评级一致性' },
  'classify':    { args:['--write'], label:'更新场景评级', desc:'根据标签内容重新计算 All/R15/R18 评级' },
  'optimize':    { args:['--write'], label:'规范化提示词', desc:'统一标签命名、补全标准负面词、修复占位符' }
};

// ── 1. 事务与备份工具 ──
// 内容版本哈希与 scripts/lib/data-version.js 共用单一来源（13 个 data 产物的 sha1 派生）
var expectedDataVersion = require('../scripts/lib/data-version').expectedDataVersion;
// 场景写入侧治理（计划 006 D5）：稳定 ID 分配、增量分片写入、完整性校验、退役登记
var sceneWrite = require('../scripts/lib/scene-write');

function syncSceneStoreDataVersion(rootDir) {
  var expected = expectedDataVersion(rootDir);
  var storePath = path.join(rootDir, 'src', 'stores', 'sceneStore.ts');
  if (fs.existsSync(storePath)) {
    var storeSource = fs.readFileSync(storePath, 'utf8');
    storeSource = storeSource.replace(/DATA_VERSION\s*=\s*\d+/, 'DATA_VERSION = ' + expected);
    fs.writeFileSync(storePath, storeSource, 'utf8');
  }
  return expected;
}







function snapshotFiles(files) {
  return Array.from(new Set(files)).map(function (file) {
    var exists = fs.existsSync(file);
    return { file:file, exists:exists, content:exists ? fs.readFileSync(file) : null };
  });
}

function restoreSnapshot(snapshot) {
  if (snapshot.shardsDir) {
    var original = new Set(snapshot.map(function (item) { return item.file; }));
    fs.readdirSync(snapshot.shardsDir).filter(function (name) { return name.endsWith('.json'); }).forEach(function (name) {
      var file = path.join(snapshot.shardsDir, name);
      if (!original.has(file)) fs.unlinkSync(file);
    });
  }
  snapshot.forEach(function (item) {
    if (item.exists) writeFileAtomic(item.file, item.content);
    else if (fs.existsSync(item.file)) fs.unlinkSync(item.file);
  });
}

/**
 * 尝试回滚，并把结果如实返回。
 *
 * 保存失败 + 回滚也失败 = 数据处于半写状态。原先两处 catch 都是空的，
 * 客户端只看到"保存失败"，完全不知道盘上已经被改了一半。
 */
function attemptRollback(snapshot, label) {
  if (!snapshot) return { ok:true };
  try {
    restoreSnapshot(snapshot);
    return { ok:true };
  } catch (error) {
    var detail = String(error && error.message || error);
    console.error('  ❌ 回滚失败（' + label + '），数据可能不一致:', detail);
    return { ok:false, error:detail };
  }
}



// ── 2. 校验与文件工具 ──








// ── 2. 校验与文件工具（续）── 本机判定与桌面打包判定
// 判定「直连本机」的逻辑只保留 server/security.js 一份，避免副本再次漂移。
var isDirectLocalRequest = require('../server/security').isDirectLocalRequest;

function maintenanceLocalOnly(req, res, next) {
  if (!isDirectLocalRequest(req)) return envelope.fail(res, 403, '维护操作仅允许在本机执行');
  next();
}

/**
 * 打包模式（Tauri 安装版）判定：data 位于只读应用包、维护脚本未打包、
 * npm/系统 node 也读不了包内文件 —— 内容维护链路整体不可用。
 * 标志由 Tauri 壳仅在打包模式注入（main_shared.rs gateway_env → config.DESKTOP_PACKAGED）。
 */
function isDesktopPackagedMode(cfg) {
  return Boolean(cfg && cfg.DESKTOP_PACKAGED);
}

const DESKTOP_MAINTENANCE_UNAVAILABLE = '桌面应用模式下场景内容编辑不可用（数据位于只读的应用包内）。' +
  '请在源码开发模式（npm run dev / npm start）中编辑场景内容。';

function desktopMaintenanceUnavailable(req, res) {
  return envelope.fail(res, 501, DESKTOP_MAINTENANCE_UNAVAILABLE, { code:'DESKTOP_MAINTENANCE_UNAVAILABLE' });
}

// ── 6. 进程管理 ──
/**
 * 网关在跑的子进程登记表：/api/maintenance/run 与场景保存校验链可能耗时
 * 数分钟，网关退出时必须连树回收，否则脚本会继续写文件直到自然结束。
 * 模块级共享：control.js 的构建进程也登记到这里（经 module.exports 暴露）。
 */
var activeChildren = new Set();

function trackChild(child) {
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
function createMaintenanceRouter(cfg) {
  var router = express.Router();
  var sceneStore = require('../scripts/lib/scene-store');

  var SCENE_SHOWCASE_DIR = cfg.SCENE_SHOWCASE_DIR;
  var MAINTENANCE_BACKUP_DIR = path.join(cfg.RUNTIME_ROOT, 'maintenance-backups');

  function maintenanceSnapshot(deletedIds) {
    var dataDir = path.join(cfg.ROOT_DIR, 'data');
    var files = [
      ...require('../scripts/lib/data-version').VERSIONED_FILES.flatMap(function (name) {
        return ['', '.gz', '.br'].map(function (suffix) { return path.join(dataDir, name + suffix); });
      }),
      path.join(cfg.ROOT_DIR, 'src', 'stores', 'sceneStore.ts'),
      path.join(sceneStore.shardsDir, 'manifest.json'),
      path.join(dataDir, 'retired-scenes.json'),
      path.join(dataDir, 'characters.json'),
      path.join(dataDir, 'loras.json'),
      path.join(dataDir, 'curation.json'),
      path.join(dataDir, 'tags.json')
    ];
    var shardInfo = sceneStore.loadSceneShards();
    shardInfo.sources.forEach(function (item) { files.push(item.source); });
    if (SCENE_SHOWCASE_DIR) {
      files.push(path.join(SCENE_SHOWCASE_DIR, 'manifest.json'));
      (deletedIds || []).forEach(function (id) {
        ['jpg', 'png', 'webp'].forEach(function (ext) {
          files.push(path.join(SCENE_SHOWCASE_DIR, 'images', id + '.' + ext));
          files.push(path.join(SCENE_SHOWCASE_DIR, 'thumbs', id + '.' + ext));
        });
      });
    }
    var snapshot = snapshotFiles(files);
    snapshot.shardsDir = sceneStore.shardsDir;
    return snapshot;
  }

  function runNodeScript(script, args, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var child = trackChild(cp.spawn(process.execPath, [script].concat(args || []), {
      cwd:path.join(__dirname, '..'), windowsHide:true,
      env: { ...process.env, AICS_DATA_ROOT:cfg.ROOT_DIR, AICS_APP_ROOT:cfg.ROOT_DIR }
    }));
    var stdout = '';
    var stderr = '';
    var settled = false;
    var effectiveTimeout = timeoutMs || MAINT_TIMEOUT_MS;

    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      // 脚本可能又 spawn 了子进程（如 validate 链），只 kill 本体会让它们
      // 变孤儿继续写文件；连树一起收。
      processTree.killProcessTree(child);
      reject(new Error(path.basename(script) + ' 执行超时（' + Math.round(effectiveTimeout / 1000) + ' 秒）'));
    }, effectiveTimeout);

    child.stdout.on('data', function (chunk) {
      if (stdout.length < MAINT_LOG_CAP) stdout += String(chunk);
    });
    child.stderr.on('data', function (chunk) {
      if (stderr.length < MAINT_LOG_CAP) stderr += String(chunk);
    });
    child.on('error', function (error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', function (code) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status:code, stdout:stdout, stderr:stderr });
    });
  });
}

async function runMaintenanceChecks() {
  var commands = [
    ['scripts/maintenance/classify-scene-ratings.js', ['--write']],
    ['scripts/maintenance/optimize-scenes.js', ['--write']],
    ['scripts/maintenance/validate-scenes.js', []]
  ];
  for (var i = 0; i < commands.length; i += 1) {
    var result = await runNodeScript(commands[i][0], commands[i][1], MAINT_TIMEOUT_MS);
    if (result.status !== 0) {
      throw new Error((result.stderr || result.stdout || '维护校验失败').trim().slice(-1200));
    }
  }
}

  // 首页立绘 manifest 缓存（2026-08-21 性能审计 #8）：GET 是匿名公网端点，每次
  // 访问都同步扫版本目录 + 逐个 existsSync/readJson。5s TTL 兜底外部发布脚本的
  // 直接写盘；本地保存（下方 POST）成功后主动失效。POST 会原地改写返回对象，
  // 所以缓存命中必须返回两层浅拷贝。
  var HOME_HERO_CACHE_TTL_MS = 5000;
  var homeHeroCache = { at:0, manifest:null };

  function readHomeHeroManifest() {
    var fallback = { version:1, entries:{} };
    if (!SCENE_SHOWCASE_DIR) return fallback;
    var now = Date.now();
    if (homeHeroCache.manifest && now - homeHeroCache.at < HOME_HERO_CACHE_TTL_MS) {
      var hit = homeHeroCache.manifest;
      return Object.assign({}, hit, { entries: Object.assign({}, hit.entries) });
    }
    // 当前版本目录可能还没有 home-hero.json（发布流程先建目录后写 home 立绘；
    // 2026-08-15 实机：v20/v21 缺 home-hero.json，首页回退旧立绘）。
    // 从当前版本向旧版本回退，取最近一份完整 manifest。
    var showcaseRoot = path.dirname(SCENE_SHOWCASE_DIR);
    var currentName = path.basename(SCENE_SHOWCASE_DIR);
    var candidates = [];
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
    var ownIndex = candidates.findIndex(function (dir) { return path.basename(dir) === currentName; });
    var ordered = ownIndex >= 0 ? candidates.slice(ownIndex) : candidates;
    for (var i = 0; i < ordered.length; i++) {
      var source = path.join(ordered[i], 'home-hero.json');
      if (!fs.existsSync(source)) continue;
      try {
        var data = readJson(source);
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
      var dirents = fs.readdirSync(MAINTENANCE_BACKUP_DIR, { withFileTypes:true });
      var entries = [];
      dirents.forEach(function (entry) {
        if (!entry.isDirectory()) return;
        var id = entry.name;
        var manifestPath = path.join(MAINTENANCE_BACKUP_DIR, id, 'manifest.json');
        if (!fs.existsSync(manifestPath)) return;
        try {
          var manifest = readJson(manifestPath);
          entries.push({
            id: id,
            label: String(manifest && manifest.label || ''),
            createdAt: String(manifest && manifest.createdAt || ''),
            fileCount: Array.isArray(manifest && manifest.files) ? manifest.files.length : 0
          });
        } catch (e) { /* 跳过损坏的备份 */ }
      });
      entries.sort(function (a, b) {
        var ta = Date.parse(a.createdAt) || 0;
        var tb = Date.parse(b.createdAt) || 0;
        if (tb !== ta) return tb - ta;
        return String(b.id).localeCompare(String(a.id));
      });
      if (entries.length > 50) entries = entries.slice(0, 50);
      return envelope.ok(res, { entries: entries });
    } catch (error) {
      return envelope.fail(res, 500, error.message || '读取备份历史失败');
    }
  });

  // GET 必须公开：公网访客也要拿到运行时首页立绘配置（只含图片路径，
  // 不含任何敏感信息）。之前 maintenanceLocalOnly 把公网 403 掉，
  // 访客只能看到打包进 dist 的默认旧立绘——"公网首页还是老图"的根源。
  router.get('/api/maintenance/home-hero', function (req, res) {
    var manifest = readHomeHeroManifest();
    var entries = {};
    Object.keys(manifest.entries || {}).forEach(function (character) {
      if (!/^(nene|natsume)$/.test(character)) return;
      var entry = manifest.entries[character];
      if (!entry || entry.image !== 'home/' + character + '.jpg') return;
      entries[character] = {
        image:'/scene-showcase/home/' + character + '.jpg?v=' + encodeURIComponent(String(entry.updatedAt || manifest.version || 1)),
        updatedAt:entry.updatedAt || null
      };
    });
    res.json({ ok:true, version:manifest.version || 1, entries:entries });
  });

  require('./maintenance-scene-save').registerSceneMaintenance({
    router, cfg, sceneStore, localOnly:maintenanceLocalOnly,
    packaged:isDesktopPackagedMode, unavailable:desktopMaintenanceUnavailable,
    maintenanceSnapshot, attemptRollback, runMaintenanceChecks, runNodeScript,
    syncVersion:syncSceneStoreDataVersion, timeoutMs:MAINT_TIMEOUT_MS
  });

  router.post('/api/maintenance/showcase', maintenanceLocalOnly, express.json({ limit:'26mb' }), function (req, res) {
    var snapshot;
    try {
      if (!SCENE_SHOWCASE_DIR) return envelope.fail(res, 503, '尚未找到 SceneShowcase 目录');
      var id = String(req.body && req.body.id || '').trim();
      if (!/^(sc\d{3}|pc_[a-zA-Z0-9_-]+|[a-zA-Z0-9_-]+)$/.test(id)) return envelope.fail(res, 400, '需要合法场景或蓝图 ID');
      var scenes = sceneStore.loadSceneShards().scenes;
      var scene = scenes.find(function (item) { return item.id === id; });
      var popularBlueprint = null;
      var popularCharacter = null;

      if (!scene) {
        var bpPath = path.join(cfg.ROOT_DIR, 'data', 'scene-blueprints.json');
        var popPath = path.join(cfg.ROOT_DIR, 'data', 'popular-characters.json');
        if (fs.existsSync(bpPath) && fs.existsSync(popPath)) {
          var allBp = readJson(bpPath);
          var allPop = readJson(popPath);
          var bpList = Array.isArray(allBp) ? allBp : (allBp.blueprints || []);
          var popList = Array.isArray(allPop) ? allPop : (allPop.characters || []);
          popularBlueprint = bpList.find(function (b) {
            return b.id === id || ('pc_' + b.characterId + '_' + b.id) === id;
          });
          if (popularBlueprint) {
            popularCharacter = popList.find(function (c) { return c.id === popularBlueprint.characterId; });
          }
        }
      }

      if (!scene && !popularBlueprint) return envelope.fail(res, 404, '场景或蓝图不存在，不能保存孤立样张：' + id);
      var buffer = decodeJpegDataUrl(req.body && req.body.image, '原图');
      var thumbBuffer = req.body && req.body.thumbnail ? decodeJpegDataUrl(req.body.thumbnail, '缩略图') : buffer;
      if (buffer.length > 15 * 1024 * 1024 || thumbBuffer.length > 3 * 1024 * 1024) return envelope.fail(res, 413, '原图必须在 15MB 以内，缩略图必须在 3MB 以内');
      var imageDir = path.join(SCENE_SHOWCASE_DIR, 'images');
      var thumbDir = path.join(SCENE_SHOWCASE_DIR, 'thumbs');
      fs.mkdirSync(imageDir, { recursive:true }); fs.mkdirSync(thumbDir, { recursive:true });
      var manifestPath = path.join(SCENE_SHOWCASE_DIR, 'manifest.json');
      var affected = [manifestPath];
      ['jpg', 'png', 'webp'].forEach(function (ext) {
        affected.push(path.join(imageDir, id + '.' + ext));
        affected.push(path.join(thumbDir, id + '.' + ext));
      });
      snapshot = snapshotFiles(affected);
      var backupDir = saveSnapshotBackup(snapshot, MAINTENANCE_BACKUP_DIR, 'showcase-' + id);
      writeFileAtomic(path.join(imageDir, id + '.jpg'), buffer);
      writeFileAtomic(path.join(thumbDir, id + '.jpg'), thumbBuffer);
      ['png', 'webp'].forEach(function (ext) {
        var oldImage = path.join(imageDir, id + '.' + ext);
        var oldThumb = path.join(thumbDir, id + '.' + ext);
        if (fs.existsSync(oldImage)) fs.unlinkSync(oldImage);
        if (fs.existsSync(oldThumb)) fs.unlinkSync(oldThumb);
      });
      var manifest = fs.existsSync(manifestPath) ? readJson(manifestPath) : { version:23, entries:[] };
      if (!Array.isArray(manifest.entries)) manifest.entries = [];
      var manifestEntryId = scene ? id : (id.startsWith('pc_') ? id : ('pc_' + popularBlueprint.characterId + '_' + popularBlueprint.id));
      var idx = manifest.entries.findIndex(function (entry) { return entry.id === manifestEntryId; });
      var entry = scene ? {
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
      manifest.counts.popular = manifest.entries.filter(function (e) { return e.type === 'popular'; }).length;
      writeJson(manifestPath, manifest);
      res.json({ ok:true, file:entry.image, thumb:entry.thumb, backup:path.basename(backupDir), message:'样张与轻量缩略图已安全保存，旧版本已备份' });
    } catch (error) {
      var rollback = attemptRollback(snapshot, 'showcase');
      res.status(rollback.ok ? 400 : 500).json({
        ok:false,
        error:error.message,
        rolledBack:rollback.ok,
        dataIntegrity:rollback.ok ? 'restored' : 'INCONSISTENT',
        recovery:rollback.ok ? undefined
          : '自动回滚也失败了（' + rollback.error + '）。样张目录可能只写了一半，'
            + '请用 runtime 备份目录里最近一份 showcase-* 手动恢复。'
      });
    }
  });

  router.post('/api/maintenance/home-hero', maintenanceLocalOnly, express.json({ limit:'26mb' }), function (req, res) {
    var snapshot;
    try {
      if (!SCENE_SHOWCASE_DIR) return envelope.fail(res, 503, '尚未找到 SceneShowcase 目录');
      var character = String(req.body && req.body.character || '');
      if (!/^(nene|natsume)$/.test(character)) return envelope.fail(res, 400, '首页主视觉角色无效');
      var action = String(req.body && req.body.action || 'replace');
      var root = path.join(SCENE_SHOWCASE_DIR, 'home');
      var imagePath = path.join(root, character + '.jpg');
      var manifestPath = path.join(SCENE_SHOWCASE_DIR, 'home-hero.json');
      snapshot = snapshotFiles([imagePath, manifestPath]);
      var backupDir = saveSnapshotBackup(snapshot, MAINTENANCE_BACKUP_DIR, 'home-hero-' + character);
      var manifest = readHomeHeroManifest();
      if (action === 'reset') {
        if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
        delete manifest.entries[character];
      } else {
        var buffer = decodeJpegDataUrl(req.body && req.body.image, '首页主视觉');
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
      res.json({ ok:true, character:character, action:action, backup:path.basename(backupDir), message:action === 'reset' ? '已恢复内置首页主视觉' : '首页主视觉已保存' });
    } catch (error) {
      var rollback = attemptRollback(snapshot, 'home-hero');
      res.status(rollback.ok ? 400 : 500).json({ ok:false, error:error.message, rolledBack:rollback.ok, dataIntegrity:rollback.ok ? 'restored' : 'INCONSISTENT' });
    }
  });

  // ── 5. 路由：run/backups ── 维护脚本一键执行（SCRIPT_NAMES / MAINTENANCE_TASKS 已上移顶部常量区）

  // 必须异步。原先这里是 spawnSync(timeout:120000) —— 跑在 POST handler 里，
  // 期间整个事件循环停摆：SD 代理、进行中的 /api/chat NDJSON 流、/api/tts 的
  // 音频中继全部一起卡死，最坏 2 分钟。/api/maintenance/scenes 早就改成
  // runNodeScript + await 了，这条路径漏了。
  router.post('/api/maintenance/run', maintenanceLocalOnly, express.json({ limit:'2kb' }), async function (req, res) {
    if (isDesktopPackagedMode(cfg)) return desktopMaintenanceUnavailable(req, res);
    var task = String(req.body && req.body.task || '').trim();
    if (!MAINTENANCE_TASKS[task]) {
      return envelope.fail(res, 400, '不支持的任务：' + task);
    }

    var script = 'scripts/maintenance/' + (SCRIPT_NAMES[task] || task + '.js');
    var args = MAINTENANCE_TASKS[task].args;
    var result;
    try {
      result = await sceneWrite.withSceneWriteLock(async function () {
        var output = await runNodeScript(script, args, MAINT_TIMEOUT_MS);
        if (output.status === 0 && (task === 'classify' || task === 'optimize')) syncSceneStoreDataVersion(cfg.ROOT_DIR);
        return output;
      });
    } catch (error) {
      return res.status(504).json({
        ok:false,
        task:task,
        label:MAINTENANCE_TASKS[task].label,
        output:'执行出错：' + error.message,
        exitCode:1
      });
    }

    var output = (result.stdout || '') + (result.stderr || '');
    if (output.length > 8000) output = output.slice(0, 8000) + '\n...(truncated)';
    output = output.trim();
    if (!output) output = '任务完成，无输出';
    var payload = {
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

module.exports = {
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
