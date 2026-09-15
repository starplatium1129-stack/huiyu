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
 * 只处理「standards 为空但 view 已有形态」的角色，不动任何已登记资产的角色。
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

function main() {
  const standards = readJson(STANDARDS_FILE);
  const view = readJson(VIEW_FILE);
  const popular = readJson(POPULAR_FILE);
  const perspectives = standards.perspectives;

  const popularById = new Map((popular.characters || []).map((c: any) => [c.id, c]));

  const targets = standards.characters.filter((c: { outfits: string|any[]; id: string; }) => {
    if (c.outfits.length > 0) return false;
    if (!(view[c.id]?.outfits || []).length) return false;
    return onlyIds ? onlyIds.has(c.id) : true;
  });

  if (!targets.length) {
    console.log('[register-pending] 没有待登记的角色（standards 为空且 view 已有形态）');
    return;
  }

  const report: any[] = [];
  for (const character of targets) {
    const viewChar = view[character.id];
    const popChar: any = popularById.get(character.id);
    const outfits: any[] = [];

    for (const vo of viewChar.outfits) {
      const popOutfit = (popChar?.outfits || []).find((o: any) => o.id === vo.outfitId);
      // popular 无此形态 = 命名漂移或幽灵形态：tokens 退回形态 id 自身，保证 schema minItems 1。
      const tokens = (popOutfit?.tokens || []).length ? popOutfit.tokens : [vo.outfitId];
      outfits.push({
        id: vo.outfitId,
        name: vo.outfitName,
        isDefault: Boolean(vo.isDefault),
        isNsfw: Boolean(vo.isNsfw),
        prose: vo.prose,
        tokens,
      });
      // view 侧补齐标准视角定义；真实视角与设计图一律 pending，避免制造断链。
      vo.references = perspectives.map((p: any) => ({
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

    character.outfits = outfits;
    report.push({
      id: character.id,
      displayName: character.displayName,
      outfits: outfits.length,
      perspectivesPerOutfit: perspectives.length,
      driftedFromPopular: outfits.filter((o: any) => !(popChar?.outfits || []).some((p: any) => p.id === o.id)).map((o: any) => o.id),
    });
  }

  console.log(`[register-pending] 待登记角色 ${targets.length} 位：`);
  for (const r of report) {
    const drift = r.driftedFromPopular.length ? ` ⚠ 与 popular 命名漂移: ${r.driftedFromPopular.join(', ')}` : '';
    console.log(`  - ${r.id} (${r.displayName}): ${r.outfits} 套形态 × ${r.perspectivesPerOutfit} 视角${drift}`);
  }
  const total = report.reduce((sum: any, r: any) => sum + r.outfits * r.perspectivesPerOutfit, 0);
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
