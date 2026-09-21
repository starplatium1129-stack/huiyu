#!/usr/bin/env node
'use strict';

import { PathOrFileDescriptor } from 'node:fs';

/**
 * 登记「已上架但尚无参考资产」的角色形态，消除 standards / view 的形态集合漂移。
 *
 * 背景（2026-09-06，优化报告 P1-04）：
 *   sync-multi-outfit-standards.js 按磁盘资产存在性过滤形态（幽灵形态不入 standards），
 *   而 character-reference-view.json 是合并写入（Object.assign(existing, tsRecord)），
 *   手工/其他脚本先填进去的服装会被保留。于是出现「view 有 5 套服装 0 视角、
 *   standards 0 套」的漂移，test:contract 的镜像契约直接报红。
 *
 * 本脚本做的是**登记**不是**渲染**：
 *   - standards 补齐形态条目（id/name/prose/tokens/isDefault/isNsfw 与 view 逐字段对齐）
 *   - view 补齐 7 个标准视角定义，全部 pending（无 url）→ check:ref-urls 跳过，不制造断链
 *   真实资产由 render-all-outfits-references.js 渲染（--ids= 定向），
 *   渲染后跑 sync-multi-outfit-standards.js 回填 url 并自动去掉 pending。
 *
 * 按 popular → standards/view 做形态级差额对账：已登记的形态不动，缺失的形态补为
 * 7 个 pending 视角。保留旧的「standards 为空但 view 已有形态」兼容路径。
 *
 * 用法:
 *   node scripts/maintenance/register-pending-reference-outfits.js [--dry-run] [--ids a,b,c]
 */

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const STANDARDS_FILE = path.join(ROOT, 'data', 'character-reference-standards.json');
const VIEW_FILE = path.join(ROOT, 'data', 'character-reference-view.json');
const POPULAR_FILE = path.join(ROOT, 'data', 'popular-characters.json');

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const idsArg = argv.find((a: any) => a.startsWith('--ids='));
const onlyIds = idsArg ? new Set(idsArg.slice('--ids='.length).split(',').map((s: any) => s.trim()).filter(Boolean)) : null;

const readJson = (file: PathOrFileDescriptor) => JSON.parse(fs.readFileSync(file, 'utf8'));

function isReferenceNsfw(outfit: any) {
  return Boolean(outfit.isNsfw === true
    || /私密|泳装|浴|裸/.test(String(outfit.name || ''))
    || String(outfit.id || '').includes('nsfw'));
}

function pendingReferences(perspectives: any[]) {
  return perspectives.map((p: any) => ({
    id: p.id,
    name: p.name,
    shotType: p.shotType,
    lens: p.lens,
    targetUsage: p.targetUsage,
    fileName: `${p.id}.png`,
    url: '',
    pending: true,
  }));
}

function standardOutfit(popOutfit: any, existingOutfits: any[]) {
  const hasDefault = existingOutfits.some((o: any) => o.isDefault === true);
  return {
    id: popOutfit.id,
    name: popOutfit.name,
    isDefault: hasDefault ? false : Boolean(popOutfit.default === true || popOutfit.isDefault === true),
    isNsfw: isReferenceNsfw(popOutfit),
    prose: popOutfit.prose || String(popOutfit.name || popOutfit.id),
    tokens: Array.isArray(popOutfit.tokens) && popOutfit.tokens.length ? popOutfit.tokens : [popOutfit.id],
  };
}

function viewOutfit(standard: any, perspectives: any[]) {
  return {
    outfitId: standard.id,
    outfitName: standard.name,
    isDefault: standard.isDefault,
    isNsfw: standard.isNsfw,
    prose: standard.prose,
    references: pendingReferences(perspectives),
  };
}

function main() {
  const standards = readJson(STANDARDS_FILE);
  const view = readJson(VIEW_FILE);
  const popular = readJson(POPULAR_FILE);
  const perspectives = standards.perspectives;

  const popularById = new Map((popular.characters || []).map((c: any) => [c.id, c]));

  const standardById = new Map<string, any>(standards.characters.map((c: any) => [c.id, c] as [string, any]));
  const targets: any[] = [];
  const errors: string[] = [];
  let addedOutfits = 0;

  for (const popChar of popular.characters || []) {
    if (onlyIds && !onlyIds.has(popChar.id)) continue;
    const character = standardById.get(popChar.id);
    const viewChar = view[popChar.id];
    if (!character || !viewChar) {
      errors.push(`${popChar.id}: standards/view 角色记录缺失`);
      continue;
    }

    const standardIds = new Set(character.outfits.map((o: any) => o.id));
    const viewIds = new Set((viewChar.outfits || []).map((o: any) => o.outfitId));
    const missing = (popChar.outfits || []).filter((o: any) => !standardIds.has(o.id) || !viewIds.has(o.id));
    if (!missing.length) continue;

    const added: any[] = [];
    for (const popOutfit of missing) {
      let standard = character.outfits.find((o: any) => o.id === popOutfit.id);
      if (!standardIds.has(popOutfit.id)) {
        standard = standardOutfit(popOutfit, character.outfits);
        character.outfits.push(standard);
        standardIds.add(popOutfit.id);
      }
      if (!viewIds.has(popOutfit.id)) {
        viewChar.outfits.push(viewOutfit(standard, perspectives));
        viewIds.add(popOutfit.id);
      }
      added.push(popOutfit.id);
      addedOutfits += 1;
    }
    targets.push({
      id: popChar.id,
      displayName: popChar.displayName,
      outfits: added,
      perspectivesPerOutfit: perspectives.length,
    });
  }

  // 兼容早期 view 已有形态、standards 整个角色为空的登记数据；不属于 popular 的
  // studio 角色也必须继续能通过 reference:register 自愈。
  for (const character of standards.characters) {
    if (character.outfits.length > 0 || !(view[character.id]?.outfits || []).length) continue;
    if (onlyIds && !onlyIds.has(character.id)) continue;
    const viewChar = view[character.id];
    const popChar: any = popularById.get(character.id);
    const added: string[] = [];
    for (const vo of viewChar.outfits) {
      const popOutfit = (popChar?.outfits || []).find((o: any) => o.id === vo.outfitId);
      const fallback = {
        id: vo.outfitId,
        name: vo.outfitName,
        default: vo.isDefault,
        isDefault: vo.isDefault,
        isNsfw: vo.isNsfw,
        prose: vo.prose,
        tokens: (popOutfit?.tokens || []).length ? popOutfit.tokens : [vo.outfitId],
      };
      character.outfits.push(standardOutfit(popOutfit || fallback, character.outfits));
      vo.references = pendingReferences(perspectives);
      added.push(vo.outfitId);
      addedOutfits += 1;
    }
    targets.push({ id: character.id, displayName: character.displayName, outfits: added, perspectivesPerOutfit: perspectives.length });
  }

  if (errors.length) {
    console.error('[register-pending] 无法安全登记：');
    for (const error of errors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }

  if (!targets.length) {
    console.log('[register-pending] 没有待登记的服装差额');
    return;
  }

  console.log(`[register-pending] 待登记角色 ${targets.length} 位：`);
  for (const r of targets) {
    console.log(`  - ${r.id} (${r.displayName}): ${r.outfits.length} 套形态（${r.outfits.join(', ')}） × ${r.perspectivesPerOutfit} 视角`);
  }
  const total = addedOutfits * perspectives.length;
  console.log(`[register-pending] 合计登记 ${total} 条视角条目（全部 pending，渲染后由 sync 回填 url）`);

  if (dryRun) {
    console.log('[register-pending] --dry-run：未写入任何文件');
    return;
  }

  fs.writeFileSync(STANDARDS_FILE, JSON.stringify(standards, null, 2) + '\n', 'utf8');
  fs.writeFileSync(VIEW_FILE, JSON.stringify(view, null, 2) + '\n', 'utf8');
  console.log(`[register-pending] 已写入 standards 与 view（记得跑 data:build 更新 DATA_VERSION）`);
}

main();
