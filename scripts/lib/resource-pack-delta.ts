import { errorMessage as runtimeErrorMessage } from './runtime-errors';
'use strict';

/**
 * scripts/lib/resource-pack-delta.js — 增量资源候选包：只复制差异文件（G13）
 *
 * 职责：
 *  - 在 G10 全包导出之上提供 --base-manifest 增量模式：给定 root 内旧/新两份清单，
 *    复用 resource-manifest 的纯比较（compareManifests），只把 added/changed 项复制到
 *    候选包；unchanged 不进候选文件，removed 仅作为差异记录，不删除任何源/目标资源。
 *  - 旧清单只做读取与结构核验（统一由 compareManifests 对两侧执行 parseManifestStructure），
 *    不读取旧清单对应的磁盘资产（其 removed 文件可已不存在）；新清单继续走 G10 完整
 *    核验（loadVerifiedManifest），不能用增量缩小绕过新清单损坏。任一清单结构错误或
 *    非空 unverified 即整体拒绝。
 *  - 候选 manifest.json 只列实际复制的 added/changed 项（可被现有 verifier / audit:
 *    resource-manifest 核验）；另写 delta.json 记录旧/新清单内容身份（按稳定
 *    path/bytes/sha256 计算 contentIdentity，不含 generatedAt/root）、四类数量与移除
 *    路径，供以后基线匹配用。两个元数据文件都在最终改名前经 applyPackPlan 读回核对。
 *  - 产物是增量候选，不是完整可安装包，也不能当作已安装更新；零差异时输出明确的
 *    零资产候选。复制/暂存/发布协议完全复用 resource-pack 的 applyPackPlan，不另造
 *    宽松通道；Windows-only apply、排除域、独占写入、同名拒绝等 G10 回归全部保留。
 *
 * 不冒充数字签名/可信来源；不实现安装，不执行删除；io 可注入（测试用记录型 fs）。
 */

const nodeFs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const { createHash }: typeof import('node:crypto') = require('node:crypto');
const { SCHEMA_VERSION, UsageError, compareManifests, resolveRealpathBoundary }: typeof import('./resource-manifest') = require('./resource-manifest');
const { BYTE_ONLY_NOTE, checkDestination, loadVerifiedManifest, applyPackPlan }: typeof import('./resource-pack') = require('./resource-pack');

const IDENTITY_BASIS = 'contentIdentity = SHA-256(JSON.stringify(按码元顺序排序的 [path, bytes, sha256小写] 三元组数组))；只由清单条目决定，不含 generatedAt/root 等非条目字段，不受生成时间影响';
function comparePath(a: string, b: string) { return a < b ? -1 : a > b ? 1 : 0; }

function sha256Hex(buffer: string|NodeJS.ArrayBufferView<ArrayBufferLike>|Buffer<ArrayBuffer>) {
  return createHash('sha256').update(buffer).digest('hex');
}

type PackEntry = { path: string; bytes: number; sha256: string };
type ResourceManifest = { entries: PackEntry[] };

function sumEntryBytes(entries: PackEntry[]) {
  return entries.reduce((acc, e) => acc + e.bytes, 0);
}

/** 清单内容身份（纯函数）：只由条目 (path, bytes, sha256) 决定，与 generatedAt/root 无关。 */
function manifestContentIdentity(manifest: ResourceManifest) {
  const triples = (manifest && Array.isArray(manifest.entries) ? manifest.entries : [])
    .map((e: PackEntry) => [e.path, e.bytes, e.sha256.toLowerCase()])
    .sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0));
  return sha256Hex(Buffer.from(JSON.stringify(triples), 'utf8'));
}

function manifestIdentityRecord(rel: string, manifest: ResourceManifest) {
  return {
    path: rel,
    contentIdentity: manifestContentIdentity(manifest),
    entryCount: manifest.entries.length,
    totalBytes: sumEntryBytes(manifest.entries),
  };
}

/**
 * 读取 root 内旧清单（仅读取与解析，不做磁盘内容核验）：路径与真实路径边界检查
 * 先于读取，越界/不可读抛 UsageError（退出 2）；JSON 解析失败作为结果错误（退出 1）。
 * 结构核验统一交给 compareManifests（对两侧一致执行，任何结构错误/非空 unverified
 * 都会阻止发布）。
 */
function loadBaseManifestStructure({ rootReal, manifestPath, io }: { rootReal: string; manifestPath: string; io: typeof import('node:fs') }) {
  if (!manifestPath || typeof manifestPath !== 'string') {
    throw new UsageError('--base-manifest 缺失或不是字符串（增量模式需要 --base-manifest <旧JSON> 与 --manifest <新JSON> 同用）');
  }
  const resolved = path.resolve(rootReal, manifestPath);
  // 与 resource-manifest / resource-pack 的 isInsideRoot 同语义（跨盘符拒绝绝对 relative）
  const relNative = path.relative(rootReal, resolved);
  const inside = relNative !== '' && relNative !== '..' && !relNative.startsWith('..' + path.sep) && !path.isAbsolute(relNative);
  if (!inside) throw new UsageError(`--base-manifest 必须位于 root 内: ${manifestPath}`);
  const rel = relNative.split(path.sep).join('/');
  const boundary = resolveRealpathBoundary(io, resolved, rootReal);
  if (!boundary.ok) throw new UsageError(`--base-manifest ${boundary.message}`);
  let raw;
  try {
    raw = io.readFileSync(resolved);
  } catch (err) {
    throw new UsageError(`--base-manifest 不可读取: ${runtimeErrorMessage(err)}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(raw.toString('utf8'));
  } catch (err) {
    return { ok: false, manifest: null, manifestRel: rel, errors: [{ code: 'bad-manifest', message: `旧清单 JSON 解析失败: ${runtimeErrorMessage(err)}` }] };
  }
  return { ok: true, manifest, manifestRel: rel, errors: [] };
}

/**
 * 增量预览计划（零写入；读取两份清单，新清单源文件按 G10 完整核验）：比较后只保留
 * added/changed 作为候选复制条目，removed 仅记录。--help/--plan 的零读取由 CLI 层保证。
 */
function planResourcePackDelta({ root, name, manifestPath, baseManifestPath, io = nodeFs }: { root: string; name: string; manifestPath: string; baseManifestPath: string; io?: typeof import('node:fs') }) {
  if (!manifestPath || typeof manifestPath !== 'string') {
    throw new UsageError('--manifest 缺失或不是字符串（增量模式需要 --base-manifest <旧JSON> 与 --manifest <新JSON> 同用）');
  }
  const dest = checkDestination({ root, name, io });
  const loaded = loadVerifiedManifest({ rootReal: dest.rootReal, manifestPath, io });
  const baseLoaded = loadBaseManifestStructure({ rootReal: dest.rootReal, manifestPath: baseManifestPath, io });
  const errors = [...dest.errors, ...loaded.errors, ...baseLoaded.errors];
  let candidates = null;
  let delta = null;
  if (errors.length === 0) {
    const diff = compareManifests({ oldManifest: baseLoaded.manifest, newManifest: loaded.manifest });
    if (!diff.ok) {
      errors.push(...(diff.errors as unknown[]));
    } else {
      const newByPath = new Map(loaded.manifest.entries.map((e: PackEntry) => [e.path, e]));
      const changedEntries = diff.changed as Array<{ path: string }>;
      candidates = [...(diff.added as PackEntry[]), ...changedEntries]
        .map((d) => newByPath.get(d.path))
        .filter((e): e is PackEntry => Boolean(e))
        .sort((a, b) => comparePath(a.path, b.path));
      delta = {
        baseManifest: manifestIdentityRecord(baseLoaded.manifestRel, baseLoaded.manifest),
        newManifest: manifestIdentityRecord(loaded.manifestRel, loaded.manifest),
        totals: diff.totals,
        removed: diff.removed,
      };
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'resource-pack-delta-plan',
    mode: 'preview',
    ok: errors.length === 0,
    name,
    root: dest.rootReal,
    manifestPath: loaded.manifestRel,
    baseManifestPath: baseLoaded.manifestRel,
    delta,
    totals: candidates ? { files: candidates.length, bytes: sumEntryBytes(candidates) } : { files: 0, bytes: 0 },
    verification: loaded.verification ? { verified: loaded.verification.totals.verified, errorCount: loaded.verification.totals.errorCount } : null,
    entries: candidates ? candidates.map((e) => ({ path: e.path, bytes: e.bytes, sha256: e.sha256 })) : null,
    errors,
    notes: [
      '增量候选预览：仅复制 added/changed 项；unchanged 不进候选文件，removed 仅作为差异记录，不删除任何源/目标资源。',
      '旧清单只做结构核验，不读取其对应磁盘资产；新清单继续按全包同套完整核验，任一清单结构错误/非空 unverified 即拒绝。',
      '增量候选包不是完整可安装包，不能当作已安装更新；零差异时输出明确的零资产候选。',
      BYTE_ONLY_NOTE,
    ],
  };
}

/** 增量模式的候选包元数据：manifest.json（仅实际复制条目）+ delta.json（差异记录）。 */
function deltaMetadataFiles({ plan, destAbs, rootReal }: any) {
  const bytes = sumEntryBytes(plan.entries);
  const packManifest = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'resource-manifest',
    generatedAt: new Date().toISOString(),
    root: destAbs,
    scope: {
      scanRoot: 'assets/',
      followsSymbolicLinks: false,
      pack: {
        note: '离线资源增量候选包（暂存导出）：只字节复制基线差异中的 added/changed 项；unchanged 不进包，removed 仅记录不删除；不是完整可安装包',
        sourceRoot: rootReal,
        sourceManifestPath: plan.manifestPath,
        baseManifestPath: plan.baseManifestPath,
        deltaTotals: plan.delta.totals,
      },
      coverageNote: `增量候选包的 manifest.json 仅列实际复制的 added/changed 项，不代表基线全集；${BYTE_ONLY_NOTE}`,
    },
    totals: { files: plan.entries.length, bytes, unverified: 0 },
    entries: plan.entries.map((e: any) => ({ path: e.path, bytes: e.bytes, sha256: e.sha256 })),
    unverified: [],
  };
  const deltaJson = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'resource-pack-delta',
    generatedAt: new Date().toISOString(),
    identityBasis: IDENTITY_BASIS,
    baseManifest: plan.delta.baseManifest,
    newManifest: plan.delta.newManifest,
    totals: plan.delta.totals,
    removed: plan.delta.removed,
    candidate: {
      files: plan.entries.length,
      bytes,
      zeroAssets: plan.entries.length === 0,
      note: '增量候选：manifest.json 仅列实际复制的 added/changed 项；unchanged 未复制，removed 仅记录、未删除任何资源；不是完整可安装包，不能当作已安装更新',
    },
    notes: [BYTE_ONLY_NOTE],
  };
  return [
    { name: 'manifest.json', object: packManifest, mismatchCode: 'manifest-write-mismatch' },
    { name: 'delta.json', object: deltaJson, mismatchCode: 'delta-write-mismatch' },
  ];
}

/**
 * 增量暂存导出（--apply，仅 Windows）：复用全包 applyPackPlan 协议（专用暂存目录、
 * 逐项读回核验、元数据读回比对、发布前后核验），额外写 delta.json 并同样读回核对。
 */
function stageResourcePackDelta({ root, name, manifestPath, baseManifestPath, io = nodeFs, platform = process.platform }: { root: string; name: string; manifestPath: string; baseManifestPath: string; io?: typeof nodeFs; platform?: NodeJS.Platform }) {
  const plan = planResourcePackDelta({ root, name, manifestPath, baseManifestPath, io });
  const result = applyPackPlan({ plan, io, platform, resultKind: 'resource-pack-delta-result', buildMetadata: deltaMetadataFiles });
  return { ...result, baseManifestPath: plan.baseManifestPath, delta: plan.delta };
}

export = { IDENTITY_BASIS, manifestContentIdentity, planResourcePackDelta, stageResourcePackDelta };
