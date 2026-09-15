#!/usr/bin/env node
'use strict';

import { PathOrFileDescriptor } from 'node:fs';

/**
 * 参考库 URL 断链修复（2026-08-29 产品运营审计 P0-1）。
 *
 * data/character-reference-view.json 曾积累 232 条断链 + 25 处 nsfw_nude 重复条目，
 * 根因有二：
 *   1. 早期批量渲染以 <cid>_<oid>_ref_XX.png 前缀式命名落盘，未回写 JSON（212 条漂移）；
 *   2. sync-multi-outfit-standards.js 曾无条件追加 nsfw_nude 形态且对无资产服装
 *      回退角色根路径 url，重复执行即产生重复条目与幽灵形态（0 资产却声明 4 视角）。
 *
 * 本脚本幂等，可重复执行；三类修复：
 *   A. 前缀名漂移：磁盘文件重命名为目录式规范名（<cid>/<oid>/ref_XX.png），JSON 不动；
 *   B. 重复形态条目：standards + view 双侧按 outfitId 去重，保留资产齐全的首个条目；
 *   C. 幽灵形态：standards + view 双侧同步移除（镜像契约要求两侧服装集合一致，
 *      popular-characters.json 与蓝图引用不受影响——那才是出图提示词的事实源）。
 *
 * 修改前整目录快照到 runtime/maintenance-backups/<stamp>-ref-url-repair/，
 * 含重命名清单与删除清单，可人工回滚。--dry-run 只报告不落盘。
 * 门禁：validate-content-contracts.js 的 checkReferenceViewUrls 会在断链回潮时报红。
 */

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const VIEW_FILE = path.join(ROOT, 'data', 'character-reference-view.json');
const STANDARDS_FILE = path.join(ROOT, 'data', 'character-reference-standards.json');
// 2026-08-29：删除两个从未被引用的常量 ASSETS / PERSPECTIVE_COUNT ——
// 它们让 lint:js 报 4 个 error，进而被 pre-push 钩子挡下（见 .githooks/pre-push）。
const DRY_RUN = process.argv.includes('--dry-run');

function readJson(file: PathOrFileDescriptor) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function refUrlToPath(url: unknown) {
  // 2026-08-29：参考图迁出项目 → AI 工作区 CharacterReferences，URL 前缀
  // /character-references/；兼容旧 /assets/ 前缀兜底。
  if (String(url).startsWith('/character-references/')) {
    return path.join(refRoot, String(url).replace(/^\/character-references\//, ''));
  }
  return path.join(ROOT, 'assets', String(url).replace(/^\/assets\//, ''));
}

// 参考图实体根：优先 AI 工作区（AI_WORKSPACE_ROOT/CharacterReferences），
// 找不到退回项目 assets（兼容未迁移的旧环境）。
const refRoot = (() => {
  const ws = process.env.AI_WORKSPACE_ROOT || path.resolve(ROOT, '..', 'AI');
  const candidate = path.join(ws, 'CharacterReferences');
  return fs.existsSync(candidate) ? candidate : path.join(ROOT, 'assets');
})();

// 一个引用「可解析」= 规范名在盘，或前缀名在盘（A 类改名后即落到规范名）。
// dry-run 不落盘也用同一判定，保证试跑与实跑语义一致。
function refResolvable(ref: { url: unknown; }, cid: string, outfitId: unknown) {
  const target = refUrlToPath(ref.url);
  if (fs.existsSync(target)) return true;
  const prefixed = path.join(path.dirname(target), `${cid}_${outfitId}_${path.basename(target)}`);
  return fs.existsSync(prefixed);
}

function entryFullyOnDisk(entry: { references: unknown; outfitId: unknown; }, cid: string) {
  return (entry.references || []).every((ref: unknown) => refResolvable(ref, cid, entry.outfitId));
}

// A 类：目录内前缀名漂移 -> 重命名为目录式规范名
function repairDriftedFiles(view: ArrayLike<unknown>|{ [s: string]: unknown; }) {
  const renames: any[] = [];
  for (const [cid, profile] of Object.entries(view)) {
    for (const outfit of profile.outfits || []) {
      for (const ref of outfit.references || []) {
        const target = refUrlToPath(ref.url);
        if (fs.existsSync(target)) continue;
        const dir = path.dirname(target);
        const prefixed = path.join(dir, `${cid}_${outfit.outfitId}_${path.basename(target)}`);
        if (!fs.existsSync(prefixed)) continue; // 非漂移，留给幽灵清单
        renames.push({ from: path.relative(ROOT, prefixed), to: path.relative(ROOT, target) });
        if (!DRY_RUN) fs.renameSync(prefixed, target);
      }
    }
  }
  return renames;
}

// B+C 类：view 按 outfitId 去重并剔除幽灵形态；返回 { view, removed, deduped }
function pruneViewOutfits(view: ArrayLike<unknown>|{ [s: string]: unknown; }) {
  const removed: any[] = [];
  const deduped: any[] = [];
  const survivingIds: Record<string, any> = {};
  for (const [cid, profile] of Object.entries(view)) {
    const groups = new Map();
    for (const outfit of profile.outfits || []) {
      if (!groups.has(outfit.outfitId)) groups.set(outfit.outfitId, []);
      groups.get(outfit.outfitId).push(outfit);
    }
    const kept: any[] = [];
    for (const [oid, entries] of groups) {
      const valid = entries.filter((entry: unknown) => entryFullyOnDisk(entry, cid));
      if (!valid.length) {
        removed.push(`${cid}/${oid} (${entries.length} 条目，0 资产)`);
        continue;
      }
      if (entries.length > 1) deduped.push(`${cid}/${oid} (${entries.length} -> 1)`);
      // 重复条目间优先保留 default 形态，其余按原始顺序取首个资产齐全者
      const preferred = valid.find((e: { isDefault: unknown; }) => e.isDefault) || valid[0];
      kept.push(preferred);
    }
    survivingIds[cid] = new Set(kept.map((o: any) => o.outfitId));
    profile.outfits = kept;
  }
  return { removed, deduped, survivingIds };
}

// standards 与 view 逐 outfitId 对齐（镜像契约：两侧集合必须一致，且各自无重复条目）
function alignStandards(standards: { characters: unknown; }, survivingIds: { [x: string]: unknown; }) {
  const removed: any[] = [];
  for (const character of standards.characters) {
    const keep = survivingIds[character.id];
    if (!keep) continue; // view 已无此角色（当前两侧均为 50 角色，不应发生）
    const seen = new Set();
    const before = character.outfits.length;
    character.outfits = character.outfits.filter((o: { id: unknown; }) => {
      if (!keep.has(o.id) || seen.has(o.id)) return false;
      seen.add(o.id);
      return true;
    });
    if (character.outfits.length !== before) {
      removed.push(`${character.id}: ${before} -> ${character.outfits.length}`);
    }
  }
  return removed;
}

function snapshotBackup(renames: { from: string; to: string; }[]) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = path.join(ROOT, 'runtime', 'maintenance-backups', `${stamp}-ref-url-repair`);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(VIEW_FILE, path.join(dir, 'character-reference-view.json'));
  fs.copyFileSync(STANDARDS_FILE, path.join(dir, 'character-reference-standards.json'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    stamp, dryRun: DRY_RUN, renames,
    note: '回滚 = 恢复两份 json + 按 manifest.renames 反向重命名',
  }, null, 2) + '\n');
  return dir;
}

function countBroken(view: ArrayLike<unknown>|{ [s: string]: unknown; }) {
  let missing = 0;
  for (const [cid, profile] of Object.entries(view)) {
    for (const outfit of profile.outfits || []) {
      for (const ref of outfit.references || []) {
        if (!refResolvable(ref, cid, outfit.outfitId)) missing++;
      }
    }
  }
  return missing;
}

function main() {
  const view = readJson(VIEW_FILE);
  const standards = readJson(STANDARDS_FILE);
  const beforeRefs = Object.values(view).reduce((n: any, p: any) => n + (p.outfits || []).reduce((m: unknown, o: { references: unknown; }) => m + (o.references || []).length, 0), 0);

  const renames = repairDriftedFiles(view);
  const { removed, deduped, survivingIds } = pruneViewOutfits(view);
  const standardsRemoved = alignStandards(standards, survivingIds);

  const afterRefs = Object.values(view).reduce((n: any, p: any) => n + (p.outfits || []).reduce((m: unknown, o: { references: unknown; }) => m + (o.references || []).length, 0), 0);
  const stillBroken = countBroken(view);

  console.log(`[ref-url-repair] 漂移重命名: ${renames.length}`);
  console.log(`[ref-url-repair] 重复条目去重: ${deduped.length}`);
  console.log(`[ref-url-repair] 幽灵形态移除: view ${removed.length} / standards ${standardsRemoved.length}`);
  console.log(`[ref-url-repair] 视角总数: ${beforeRefs} -> ${afterRefs}`);
  console.log(`[ref-url-repair] 剩余断链: ${stillBroken}`);

  if (stillBroken > 0) {
    console.error('[ref-url-repair] 仍存在断链（既非漂移也无资产），请人工核对上方清单');
    process.exitCode = 1;
    return;
  }

  if (DRY_RUN) {
    console.log('[ref-url-repair] dry-run，未写盘');
    return;
  }

  const backupDir = snapshotBackup(renames);
  fs.writeFileSync(VIEW_FILE, JSON.stringify(view, null, 2) + '\n');
  fs.writeFileSync(STANDARDS_FILE, JSON.stringify(standards, null, 2) + '\n');
  console.log(`[ref-url-repair] 已备份并写盘: ${path.relative(ROOT, backupDir)}`);
}

main();
