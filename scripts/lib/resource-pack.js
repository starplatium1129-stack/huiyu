'use strict';

/**
 * scripts/lib/resource-pack.js — 离线资源候选包暂存导出（受控复制，G10）
 *
 * 职责：
 *  - 给定 root 与 root 内清单：先复用现有清单核验（结构/重复/越界/排除域/未核验项/
 *    缺失/字节/哈希全部通过），显式 --apply 才把已列普通文件复制到
 *    `<root>/scripts/archive/resource-packs/<name>/` 新目录，保留 `assets/...` 相对
 *    结构，并写入可被 audit:resource-manifest 再次核验的 manifest.json。
 *  - 默认只预览计划（零写入）；--help/--plan 不读取目标。目标只要已存在（含空目录）
 *    即拒绝，不覆盖任何旧包；包名限字母/数字/下划线/短横线（≤64 字符），不允许路径片段。
 *  - 目标祖先链拒绝符号链接/junction：任何已存在祖先若是链接或 realpath 与字面路径
 *    不一致，先于任何写入被拒；不存在祖先由本工具以真实目录创建。
 *  - 复制写入本次专用暂存目录 `.staging-<name>-<随机>`，逐项核验候选副本与声明字节/
 *    SHA-256 一致（读回校验），再整体用 verifyManifestEntries 复核，全部成功后才把
 *    暂存目录重命名为最终包名；发布后用现有 verifyManifest 做最终验收。
 *  - 复制期间源变化、写入失败、目标冲突等一律不报告成功；失败时暂存目录保留并给出
 *    路径（不是可用候选包），不删除任何目录（含无关目录）。
 *  - 不是安装器/下载器：不转换/重采样图片，不执行复制内容，不做 ZIP 解压/安装/
 *    缓存淘汰，无网络行为。输出只称「候选包已通过字节核验」，不代表图片质量、
 *    审核或部署完成。
 *  - 暂存发布协议抽为通用 applyPackPlan（G13）：全包模式与增量模式
 *    （scripts/lib/resource-pack-delta.js）共用同一复制核验、元数据读回、发布与
 *    验收路径，增量模式不另造通道。
 *
 * 只读复用 scripts/lib/resource-manifest.js 导出（不修改该库）：
 * SCHEMA_VERSION / UsageError / verifyManifest / verifyManifestEntries / resolveRealpathBoundary。
 * io 可注入（测试用记录型 fs 证明访问与写入边界）。
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { SCHEMA_VERSION, UsageError, verifyManifest, verifyManifestEntries, resolveRealpathBoundary, checkManifestPath } = require('./resource-manifest');

const PACKS_DIR_SEGMENTS = Object.freeze(['scripts', 'archive', 'resource-packs']);
const PACK_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const STAGING_PREFIX = '.staging-';

const BYTE_ONLY_NOTE = '候选包已通过字节核验仅表示复制内容与清单记录一致；不代表图片质量、内容审核或部署完成，也不是可信发布源。';

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function relFromRoot(rootReal, abs) {
  return path.relative(rootReal, abs).split(path.sep).join('/');
}

function sameRealPath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function resolveRootReal(root, io) {
  if (!root || typeof root !== 'string') throw new UsageError('--root 缺失或不是字符串');
  let rootReal;
  try {
    rootReal = io.realpathSync(root);
  } catch (err) {
    throw new UsageError(`root 不可解析: ${err.message}`);
  }
  let st;
  try {
    st = io.statSync(rootReal);
  } catch (err) {
    throw new UsageError(`root 不可访问: ${err.message}`);
  }
  if (!st.isDirectory()) throw new UsageError('root 不是目录');
  return rootReal;
}

/** 包名校验：限字母/数字/下划线/短横线（≤64 字符），拒绝路径片段与特殊字符。 */
function validatePackName(name) {
  if (typeof name !== 'string' || !PACK_NAME_RE.test(name)) {
    throw new UsageError(`--name 仅允许字母、数字、下划线、短横线（1-64 字符，不允许路径片段），收到: ${JSON.stringify(name)}`);
  }
  return name;
}

function destinationAbsPath(rootReal, name) {
  return path.join(rootReal, ...PACKS_DIR_SEGMENTS, name);
}

/**
 * 目标解析与真实路径边界检查（只解析路径，零写入）：逐段检查已存在祖先——必须是
 * 真实目录（非符号链接/junction，realpath 与字面路径一致，仍在 root 内）；最终路径
 * 不得存在（含空目录、文件与链接）。返回 { ok, rootReal, destAbs, errors }。
 */
function checkDestination({ root, name, io = nodeFs }) {
  validatePackName(name);
  const rootReal = resolveRootReal(root, io);
  const destAbs = destinationAbsPath(rootReal, name);
  const errors = [];
  let cur = rootReal;
  for (const seg of [...PACKS_DIR_SEGMENTS, name]) {
    cur = path.join(cur, seg);
    let st;
    try {
      st = io.lstatSync(cur);
    } catch (err) {
      if (err.code === 'ENOENT') break; // 自此以下不存在；--apply 时按真实目录创建
      errors.push({ path: relFromRoot(rootReal, cur), code: 'destination-stat-error', message: `目标祖先不可访问: ${err.message}` });
      return { ok: false, rootReal, destAbs, errors };
    }
    if (st.isSymbolicLink()) {
      errors.push({ path: relFromRoot(rootReal, cur), code: 'link-in-destination-chain', message: '目标祖先是符号链接/junction，拒绝在链接内写入候选目录' });
      return { ok: false, rootReal, destAbs, errors };
    }
    if (!st.isDirectory()) {
      errors.push({ path: relFromRoot(rootReal, cur), code: 'destination-not-directory', message: '目标祖先存在但不是目录' });
      return { ok: false, rootReal, destAbs, errors };
    }
    let real;
    try {
      real = io.realpathSync(cur);
    } catch (err) {
      errors.push({ path: relFromRoot(rootReal, cur), code: 'realpath-error', message: `无法解析目标祖先真实路径: ${err.message}` });
      return { ok: false, rootReal, destAbs, errors };
    }
    if (!sameRealPath(real, cur)) {
      errors.push({ path: relFromRoot(rootReal, cur), code: 'link-in-destination-chain', message: `目标祖先真实路径 ${real} 与字面路径不一致（重解析点/junction），拒绝写入` });
      return { ok: false, rootReal, destAbs, errors };
    }
  }
  let destSt = null;
  try {
    destSt = io.lstatSync(destAbs);
  } catch (err) {
    if (err.code !== 'ENOENT') errors.push({ path: relFromRoot(rootReal, destAbs), code: 'destination-stat-error', message: `无法确认目标状态: ${err.message}` });
  }
  if (destSt) {
    const kind = destSt.isSymbolicLink() ? '（符号链接/junction）' : destSt.isDirectory() ? '（目录）' : '（文件）';
    errors.push({ path: relFromRoot(rootReal, destAbs), code: 'destination-exists', message: `目标已存在${kind}，不覆盖任何旧包` });
  }
  return { ok: errors.length === 0, rootReal, destAbs, errors };
}

/**
 * 读取 root 内清单（与 resource-manifest 同语义：路径解析与真实路径边界先于读取；
 * 越界/不可读抛 UsageError → 退出 2），JSON 解析失败与结构/核验问题作为结果错误
 * （退出 1）。核验复用 verifyManifestEntries：不支持格式、重复/越界、排除域、
 * 非空 unverified、缺失、错大小/错哈希全部在此被拒。
 */
function loadVerifiedManifest({ rootReal, manifestPath, io }) {
  if (!manifestPath || typeof manifestPath !== 'string') throw new UsageError('--manifest 缺失或不是字符串');
  const resolved = path.resolve(rootReal, manifestPath);
  // 与 resource-manifest 的 isInsideRoot 同语义（跨盘符时 path.relative 返回绝对路径，须拒绝）
  const relNative = path.relative(rootReal, resolved);
  const inside = relNative !== '' && relNative !== '..' && !relNative.startsWith('..' + path.sep) && !path.isAbsolute(relNative);
  if (!inside) throw new UsageError(`--manifest 必须位于 root 内: ${manifestPath}`);
  const rel = relNative.split(path.sep).join('/');
  const boundary = resolveRealpathBoundary(io, resolved, rootReal);
  if (!boundary.ok) throw new UsageError(`--manifest ${boundary.message}`);
  let raw;
  try {
    raw = io.readFileSync(resolved);
  } catch (err) {
    throw new UsageError(`--manifest 不可读取: ${err.message}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(raw.toString('utf8'));
  } catch (err) {
    return { ok: false, manifest: null, verification: null, manifestRel: rel, errors: [{ code: 'bad-manifest', message: `清单 JSON 解析失败: ${err.message}` }] };
  }
  const verification = verifyManifestEntries({ root: rootReal, manifest, io });
  if (!verification.ok) return { ok: false, manifest, verification, manifestRel: rel, errors: verification.errors };
  return { ok: true, manifest, verification, manifestRel: rel, errors: [] };
}

function planTotals(loaded) {
  if (!loaded.ok || !loaded.manifest || !Array.isArray(loaded.manifest.entries)) return { files: 0, bytes: 0 };
  // 核验通过时条目无重复，字节数直接对已核验条目求和
  return { files: loaded.manifest.entries.length, bytes: loaded.manifest.entries.reduce((acc, e) => acc + e.bytes, 0) };
}

/**
 * 预览计划（零写入，但会读取清单并核验源文件）：校验包名/root/目标边界与清单内容，
 * 输出将复制的条目、目标路径与核验摘要。--help/--plan 的零读取由 CLI 层保证。
 */
function planResourcePack({ root, name, manifestPath, io = nodeFs } = {}) {
  const dest = checkDestination({ root, name, io });
  const loaded = loadVerifiedManifest({ rootReal: dest.rootReal, manifestPath, io });
  const errors = [...dest.errors, ...loaded.errors];
  const ok = errors.length === 0;
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'resource-pack-plan',
    mode: 'preview',
    ok,
    name,
    root: dest.rootReal,
    manifestPath: loaded.manifestRel,
    destination: relFromRoot(dest.rootReal, dest.destAbs),
    totals: planTotals(loaded),
    verification: loaded.verification ? { verified: loaded.verification.totals.verified, errorCount: loaded.verification.totals.errorCount } : null,
    entries: loaded.ok ? loaded.manifest.entries.map((e) => ({ path: e.path, bytes: e.bytes, sha256: e.sha256 })) : null,
    errors,
    notes: [
      '预览模式零写入；--apply 将把上列已核验文件复制到目标新目录（目标必须不存在，不覆盖任何旧包）。',
      BYTE_ONLY_NOTE,
    ],
  };
}

/** 复制单个条目到暂存目录并读回核验；任何失败推入 errors 并返回 false（快速终止）。 */
function copyEntryVerified({ rootReal, staging, entry, io, errors }) {
  const srcAbs = path.join(rootReal, ...entry.path.split('/'));
  const boundary = resolveRealpathBoundary(io, srcAbs, rootReal);
  if (!boundary.ok) {
    errors.push({ path: entry.path, code: boundary.code, message: `复制前真实路径边界检查失败: ${boundary.message}` });
    return false;
  }
  const sourceScope = checkManifestPath(relFromRoot(rootReal, boundary.realTarget));
  if (!sourceScope.ok) {
    errors.push({ path: entry.path, code: 'out-of-scope', message: '复制时源真实目标进入排除域或离开 assets，未读取' });
    return false;
  }
  let buf;
  try {
    if (!io.statSync(srcAbs).isFile()) throw new Error('源不再是普通文件');
    buf = io.readFileSync(srcAbs);
  } catch (err) {
    errors.push({ path: entry.path, code: 'read-error', message: `源读取失败: ${err.message}` });
    return false;
  }
  if (buf.length !== entry.bytes) {
    errors.push({ path: entry.path, code: 'size-mismatch', expected: entry.bytes, actual: buf.length, message: '复制时源字节数与清单不一致（源可能已变化），已终止' });
    return false;
  }
  const srcHash = sha256Hex(buf);
  if (srcHash !== entry.sha256.toLowerCase()) {
    errors.push({ path: entry.path, code: 'hash-mismatch', expected: entry.sha256.toLowerCase(), actual: srcHash, message: '复制时源 SHA-256 与清单不一致（源可能已变化），已终止' });
    return false;
  }
  const stageAbs = path.join(staging, ...entry.path.split('/'));
  try {
    io.mkdirSync(path.dirname(stageAbs), { recursive: true });
    io.writeFileSync(stageAbs, buf, { flag: 'wx' });
  } catch (err) {
    errors.push({ path: entry.path, code: 'write-error', message: `候选副本写入失败: ${err.message}` });
    return false;
  }
  let back;
  try {
    back = io.readFileSync(stageAbs);
  } catch (err) {
    errors.push({ path: entry.path, code: 'read-error', message: `候选副本读回失败: ${err.message}` });
    return false;
  }
  const backHash = sha256Hex(back);
  if (back.length !== entry.bytes || backHash !== entry.sha256.toLowerCase()) {
    errors.push({ path: entry.path, code: 'copy-verify-failed', expected: entry.sha256.toLowerCase(), actual: backHash, message: '候选副本字节/SHA-256 与清单不一致，不发布最终包' });
    return false;
  }
  return true;
}

/** 全包模式的候选包元数据：manifest.json 与源清单条目逐条一致。 */
function fullPackMetadata({ plan, destAbs, rootReal }) {
  const bytes = plan.entries.reduce((acc, e) => acc + e.bytes, 0);
  const packManifest = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'resource-manifest',
    generatedAt: new Date().toISOString(),
    root: destAbs,
    scope: {
      scanRoot: 'assets/',
      followsSymbolicLinks: false,
      pack: {
        note: '离线资源候选包（暂存导出）：只字节复制源清单已列文件，不补入未列文件，不转换、不执行复制内容',
        sourceRoot: rootReal,
        sourceManifestPath: plan.manifestPath,
      },
      coverageNote: BYTE_ONLY_NOTE,
    },
    totals: { files: plan.entries.length, bytes, unverified: 0 },
    entries: plan.entries.map((e) => ({ path: e.path, bytes: e.bytes, sha256: e.sha256 })),
    unverified: [],
  };
  return [{ name: 'manifest.json', object: packManifest, mismatchCode: 'manifest-write-mismatch' }];
}

/**
 * 通用暂存发布协议（全包与增量模式共用，G13 拆出）：plan 通过后写入专用暂存目录，
 * 逐项复制并读回核验；buildMetadata({ plan, destAbs, rootReal }) 产出元数据文件
 * （manifest.json，增量模式另有 delta.json）并逐一读回比对，整体用 verifyManifest
 * 复核暂存树，全部成功后才原子改名为最终包名并做发布后验收。失败不报告成功；
 * 暂存目录保留并在结果中给出路径。不修改源清单与源文件，不添加未列条目。
 */
function applyPackPlan({ plan, io = nodeFs, platform = process.platform, resultKind, buildMetadata }) {
  const base = {
    schemaVersion: SCHEMA_VERSION,
    kind: resultKind,
    mode: 'apply',
    ok: false,
    name: plan.name,
    root: plan.root,
    manifestPath: plan.manifestPath,
    destination: plan.destination,
    destinationCreated: false,
    stagingPath: null,
    totals: plan.totals,
    verification: plan.verification,
    finalVerification: null,
    entries: plan.entries,
    errors: plan.errors,
    notes: plan.notes,
  };
  if (!plan.ok) return base;
  if (platform !== 'win32') return {
    ...base,
    errors: [{ code: 'unsupported-platform', message: '--apply 仅支持 Windows；其他平台请使用只读预览，避免 rename 覆盖已有空目录' }],
  };

  const rootReal = plan.root;
  const destAbs = destinationAbsPath(rootReal, plan.name);
  const packsDir = path.join(rootReal, ...PACKS_DIR_SEGMENTS);
  const errors = [];
  let staging = null;
  let destinationCreated = false;
  try {
    const writeBoundary = checkDestination({ root: rootReal, name: plan.name, io });
    if (!writeBoundary.ok) return { ...base, errors: writeBoundary.errors };
    io.mkdirSync(packsDir, { recursive: true });
    staging = io.mkdtempSync(path.join(packsDir, `${STAGING_PREFIX}${plan.name}-`));
    for (const entry of plan.entries) {
      if (!copyEntryVerified({ rootReal, staging, entry, io, errors })) break;
    }
    let metadataFiles = null;
    if (errors.length === 0) {
      metadataFiles = buildMetadata({ plan, destAbs, rootReal });
      for (const file of metadataFiles) {
        try {
          io.writeFileSync(path.join(staging, file.name), `${JSON.stringify(file.object, null, 2)}\n`);
        } catch (err) {
          errors.push({ code: 'write-error', message: `候选包 ${file.name} 写入失败: ${err.message}` });
          break;
        }
      }
    }
    if (errors.length === 0) {
      // 发布前逐个读回磁盘元数据，不能以内存对象掩盖清单写入损坏或丢条目。
      for (const file of metadataFiles) {
        let persisted = null;
        try {
          persisted = JSON.parse(io.readFileSync(path.join(staging, file.name), 'utf8'));
        } catch (err) {
          errors.push({ code: file.mismatchCode, message: `磁盘 ${file.name} 不可解析: ${err.message}` });
          break;
        }
        if (JSON.stringify(persisted) !== JSON.stringify(file.object)) {
          errors.push({ code: file.mismatchCode, message: `磁盘 ${file.name} 与预期内容不同，不发布最终包` });
          break;
        }
      }
      if (errors.length === 0) {
        const stagedVerification = verifyManifest({ root: staging, manifestPath: 'manifest.json', io });
        if (!stagedVerification.ok) errors.push(...stagedVerification.errors);
      }
    }
    if (errors.length === 0) {
      const publishBoundary = checkDestination({ root: rootReal, name: plan.name, io });
      if (!publishBoundary.ok) errors.push(...publishBoundary.errors);
      let destSt = null;
      try {
        destSt = io.lstatSync(destAbs);
      } catch (err) {
        if (err.code !== 'ENOENT') errors.push({ path: plan.destination, code: 'destination-stat-error', message: `发布前无法确认目标状态: ${err.message}` });
      }
      if (destSt) errors.push({ path: plan.destination, code: 'destination-exists', message: '复制期间目标已出现，不覆盖；暂存目录保留' });
    }
    if (errors.length === 0) {
      try {
        io.renameSync(staging, destAbs);
        staging = null;
        destinationCreated = true;
      } catch (err) {
        errors.push({ path: plan.destination, code: 'publish-failed', message: `暂存目录无法放到最终包名: ${err.message}` });
      }
    }
    if (errors.length > 0) {
      return {
        ...base,
        ok: false,
        destinationCreated,
        stagingPath: staging ? relFromRoot(rootReal, staging) : null,
        errors,
        notes: [
          ...plan.notes,
          staging ? `暂存目录保留（残缺，不是可用候选包）: ${staging}` : null,
        ].filter(Boolean),
      };
    }
    for (const file of metadataFiles) {
      try {
        const persisted = JSON.parse(io.readFileSync(path.join(destAbs, file.name), 'utf8'));
        if (JSON.stringify(persisted) !== JSON.stringify(file.object)) {
          errors.push({ code: file.mismatchCode, message: '发布后 ' + file.name + ' 与预期内容不同，候选包不可用' });
        }
      } catch (err) {
        errors.push({ code: file.mismatchCode, message: '发布后 ' + file.name + ' 不可读取或解析: ' + err.message });
      }
    }
    const finalVerify = verifyManifest({ root: destAbs, manifestPath: 'manifest.json', io });
    return {
      ...base,
      ok: finalVerify.ok && errors.length === 0,
      destinationCreated: true,
      finalVerification: { ok: finalVerify.ok && errors.length === 0, verified: finalVerify.totals.verified, errorCount: finalVerify.totals.errorCount + errors.length },
      errors: [...errors, ...finalVerify.errors],
      notes: finalVerify.ok && errors.length === 0
        ? [...plan.notes, `候选包已通过字节核验并写入 ${plan.destination}；可用 audit:resource-manifest --root <包目录> --manifest manifest.json 复核。`]
        : [...plan.notes, '候选包已写到目标位置但发布后核验失败，不要作为可用候选包使用。'],
    };
  } catch (err) {
    return {
      ...base,
      ok: false,
      destinationCreated,
      stagingPath: staging ? relFromRoot(rootReal, staging) : null,
      errors: [...errors, { code: 'internal-error', message: err && err.stack ? err.stack : String(err) }],
      notes: [...plan.notes, staging ? `暂存目录保留: ${staging}` : null].filter(Boolean),
    };
  }
}

/**
 * 暂存导出（--apply，仅 Windows）：复用预览的全部检查，经通用 applyPackPlan 协议
 * 完成复制与发布；全包 manifest.json 与源清单条目逐条一致。
 */
function stageResourcePack({ root, name, manifestPath, io = nodeFs, platform = process.platform } = {}) {
  const plan = planResourcePack({ root, name, manifestPath, io });
  return applyPackPlan({ plan, io, platform, resultKind: 'resource-pack-result', buildMetadata: fullPackMetadata });
}

module.exports = { PACKS_DIR_SEGMENTS, PACK_NAME_RE, STAGING_PREFIX, UsageError, BYTE_ONLY_NOTE, validatePackName, checkDestination, loadVerifiedManifest, planResourcePack, applyPackPlan, stageResourcePack };
