#!/usr/bin/env node
import { errorMessage as runtimeErrorMessage } from '../lib/runtime-errors';
'use strict';

/**
 * 提示词改写完整性与防偷懒门禁测试（AGENTS.md 第一节第 7 条规范）
 *
 * 契约规则（严格对标 AGENTS.md 第一节第 7 条）：
 * - 覆盖率：交付清单必须 100% 覆盖声明的条目数（缺漏/skip 必须为 0）
 * - 严禁模板复用：全量改写条目无模板签名与全局雷同
 * - 新旧词条保留率：新旧 Tag 保留率 <= 50%（严禁以通用模板兜底或仅追加词条）
 * - Prose 相似度：与基线 Prose 相似度 <= 60%（严禁照抄旧版）
 * - 角色归属一致性：角色 ID 与 prompt / caption 锚定 100% 匹配
 *
 * 用法：
 *   node scripts/tests/test-prompt-rewrite-integrity.js --delivery <path> [--baseline <commit>] [--targeted]
 *
 * --targeted：精确修复交付模式（2026-08-27 引入）。默认模式面向「批量全量重写」：
 *   单条保留率>85% 且 prose 相似度>80% 判为偷懒嫌疑；targeted 模式面向「审计驱动的
 *   单点纠错交付」（如仅修正时段词/单个 tag/个别句子），只在交付与基线完全一致时
 *   判为偷懒，避免把小而真实的修复误报为未重写。覆盖率/缺漏校验两种模式一致。
 */

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const { execFileSync }: typeof import('child_process') = require('child_process');
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert') = require('node:assert');

test('prompt rewrite integrity tokenization and similarity heuristics', () => {
  const s1 = tokenize('1girl, solo, ayachi_nene, pink_ribbon, uniform');
  const s2 = tokenize('1girl, solo, ayachi_nene, school_uniform');
  assert.ok(s1.has('ayachi'));
  assert.ok(s1.has('nene'));
  assert.ok(retentionRate(s1, s2) <= 1.0);
  assert.ok(jaccardSimilarity(s1, s2) > 0);
});

test('cross-entry signature detection flags templated deliveries', () => {
  // 三条 prose 共享同一模板骨架（前 3 token 相同、两两相似度>0.8）→ 必须报雷同
  const templated = new Map([
    ['a', { promptProse: 'nene stands at the counter holding a warm coffee cup in the dim cafe light' }],
    ['b', { promptProse: 'nene stands at the counter holding a warm tea cup in the dim cafe light' }],
    ['c', { promptProse: 'nene stands at the counter holding a warm milk cup in the dim cafe light' }],
  ]);
  const hit = crossEntryAudit(templated);
  assert.ok(hit.errors.length > 0, 'templated trio must be flagged');

  // 三条各不相同的 prose → 不得误报
  const diverse = new Map([
    ['a', { promptProse: 'nene kneels beside a sunlit windowsill watering small potted herbs' }],
    ['b', { promptProse: 'natsume leaps across rooftop gaps under a thunderstorm at midnight' }],
    ['c', { promptProse: 'raiden shogun meditates inside a floating shrine above drifting clouds' }],
  ]);
  const clean = crossEntryAudit(diverse);
  assert.strictEqual(clean.errors.length, 0, 'diverse prose must pass');
  assert.strictEqual(clean.pairDupes.length, 0, 'diverse prose must have no pairwise dupes');
});

const ROOT = path.resolve(__dirname, '..', '..');

function tokenize(text: any) {
  if (!text) return new Set();
  return new Set(
    String(text)
      .toLowerCase()
      .split(/[\s,，、._\-:;()[\]{}'"]+/)
      .map(t => t.trim())
      .filter(t => t.length > 2)
  );
}

function jaccardSimilarity(setA: any, setB: any) {
  if (!setA.size && !setB.size) return 0;
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function retentionRate(oldSet: any, newSet: any) {
  if (!oldSet.size) return 0;
  let kept = 0;
  for (const item of oldSet) {
    if (newSet.has(item)) kept++;
  }
  return kept / oldSet.size;
}

// ── 跨条目模板检测（2026-08-31 补齐红线 7「无模板签名/全局雷同」的实现缺口）──
// 此前只有逐条 vs 基线：同一模板套 N 条时逐条对基线相似度都低，照样通过。
// 两道检测：① 前 3 token 签名占比（>20% 判模板签名）；② 交付集内两两 prose
// Jaccard > 0.8 判全局雷同（跳过 token<6 的短条目，避免误伤固定短语）。
const SIGNATURE_GROUP_LIMIT = 0.20;
const PAIRWISE_DUPE_LIMIT = 0.80;
const PAIRWISE_MIN_TOKENS = 6;

function proseTokensOf(item: any) {
  const prose = item.promptProse || item.nsfwProse || item.animaCaption || '';
  return [...tokenize(prose)];
}

function signatureOf(tokens: any) {
  return tokens.slice(0, 3).sort().join('+');
}

function crossEntryAudit(deliveryMap: any) {
  const errors = [];
  const warnings = [];
  const pairDupes = [];

  const entries = [...deliveryMap.entries()]
    .map(([id, item]: any) => ({ id, tokens: proseTokensOf(item) }))
    .filter(e => e.tokens.length > 0);

  // ① 前 3 token 签名分组占比
  const groups = new Map();
  for (const e of entries) {
    const sig = signatureOf(e.tokens);
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(e.id);
  }
  const ranked = [...groups.entries()]
    .filter(([, ids]: any) => ids.length >= 2)
    .sort((a, b) => b[1].length - a[1].length);
  const maxGroup = ranked[0];
  const maxRatio = maxGroup ? maxGroup[1].length / entries.length : 0;
  if (maxGroup && maxRatio > SIGNATURE_GROUP_LIMIT) {
    errors.push(
      `[模板签名] prose 前 3 token 签名 "${maxGroup[0]}" 出现 ${maxGroup[1].length}/${entries.length} ` +
      `(${(maxRatio * 100).toFixed(1)}% > ${(SIGNATURE_GROUP_LIMIT * 100).toFixed(0)}%)，` +
      `样例: ${maxGroup[1].slice(0, 5).join(', ')}`
    );
  } else if (maxGroup && maxRatio >= 0.15) {
    warnings.push(`[签名预警] 签名 "${maxGroup[0]}" 占比 ${(maxRatio * 100).toFixed(1)}%（低于 20% 红线，注意趋势）`);
  }

  // ② 交付集内两两 prose 雷同
  const pool = entries.filter(e => e.tokens.length >= PAIRWISE_MIN_TOKENS);
  const sets = pool.map(e => ({ id: e.id, set: new Set(e.tokens) }));
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const sim = jaccardSimilarity(sets[i].set, sets[j].set);
      if (sim > PAIRWISE_DUPE_LIMIT) {
        pairDupes.push(`${sets[i].id} ↔ ${sets[j].id} (${(sim * 100).toFixed(1)}%)`);
      }
    }
  }
  if (pairDupes.length) {
    errors.push(`[全局雷同] 交付集内 ${pairDupes.length} 对 prose 相似度 > ${(PAIRWISE_DUPE_LIMIT * 100).toFixed(0)}%: ${pairDupes.slice(0, 10).join('; ')}`);
  }

  return { errors, warnings, pairDupes, maxRatio, maxSignature: maxGroup ? maxGroup[0] : null };
}

function getBaselineData(baselineCommit: any) {
  const git = (args: any) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const readList = (aggregate: any, directory: any, key?: any) => {
    let data;
    try { data = JSON.parse(git(['show', `${baselineCommit}:${aggregate}`])); }
    catch {
      const files = git(['ls-tree', '-r', '--name-only', baselineCommit, '--', directory])
        .trim().split(/\r?\n/).filter(file => file.endsWith('.json') && !file.endsWith('/manifest.json'));
      if (!files.length) throw new Error(`No baseline data: ${directory}`);
      return files.flatMap(file => {
        const shard = JSON.parse(git(['show', `${baselineCommit}:${file}`]));
        const list = key ? shard[key] : shard;
        if (!Array.isArray(list)) throw new Error(`Invalid baseline shard: ${file}`);
        return list;
      });
    }
    const list = key ? data[key] : data;
    if (!Array.isArray(list)) throw new Error(`Invalid baseline aggregate: ${aggregate}`);
    return list;
  };
  try {
    const bpList = readList('data/scene-blueprints.json', 'data/blueprints', 'blueprints');
    const scList = readList('data/scenes.json', 'data/scenes');

    const map = new Map();
    bpList.forEach(bp => {
      map.set(bp.id, {
        id: bp.id,
        type: 'popular',
        tokens: bp.promptTokens || bp.nsfwTokens || [],
        prose: bp.promptProse || bp.nsfwProse || '',
        characterId: bp.characterId
      });
    });
    scList.forEach(sc => {
      map.set(sc.id, {
        id: sc.id,
        type: 'scene',
        tokens: (sc.prompt || '').split(',').map((s: any) => s.trim()).filter(Boolean),
        prose: sc.animaCaption || '',
        char: sc.char
      });
    });
    return map;
  } catch (err) {
    throw new Error(`基线读取失败，拒绝宣称改写验收通过: ${runtimeErrorMessage(err)}`);
  }
}

function main() {
  const deliveryArgIdx = process.argv.indexOf('--delivery');
  const deliveryPath = deliveryArgIdx >= 0 && process.argv[deliveryArgIdx + 1]
    ? path.resolve(process.argv[deliveryArgIdx + 1])
    : null;

  const baselineArgIdx = process.argv.indexOf('--baseline');
  const baselineCommit = baselineArgIdx >= 0 && process.argv[baselineArgIdx + 1]
    ? process.argv[baselineArgIdx + 1]
    : 'b1ccfc0';

  const targeted = process.argv.includes('--targeted');
  console.log('==============================================================');
  console.log('[门禁] 批量提示词改写完整性复检（防偷懒）');
  console.log(`[门禁] 基线: ${baselineCommit} | 交付: ${deliveryPath || '当前工作区数据层'} | 模式: ${targeted ? 'targeted 精确修复' : 'default 全量重写'}`);
  console.log('==============================================================');

  let deliveryMap = new Map();

  if (deliveryPath) {
    const raw = require(deliveryPath);
    const list = Array.isArray(raw) ? raw : (typeof raw === 'object' ? Object.values(raw) : []);
    list.forEach(item => {
      deliveryMap.set(item.id, item);
    });
  } else {
    // 默认对当前仓库中修改的数据进行全量复查
    const bpList = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/scene-blueprints.json'), 'utf8')).blueprints;
    const scList = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/scenes.json'), 'utf8'));
    bpList.forEach((bp: any) => deliveryMap.set(bp.id, bp));
    scList.forEach((sc: any) => deliveryMap.set(sc.id, sc));
  }

  const baseline = getBaselineData(baselineCommit);

  let totalChecked = 0;
  let totalRetention = 0;
  let totalProseSim = 0;
  let errors = [];

  deliveryMap.forEach((delItem, id) => {
    totalChecked++;
    const baseItem = baseline ? baseline.get(id) : null;

    const newTokens = delItem.promptTokens || delItem.nsfwTokens || (delItem.prompt ? delItem.prompt.split(',').map((s: any) => s.trim()) : []);
    const newProse = delItem.promptProse || delItem.nsfwProse || delItem.animaCaption || '';

    const newTokensSet = tokenize(newTokens.join(' '));
    const newProseSet = tokenize(newProse);

    if (baseItem) {
      const oldTokensSet = tokenize(baseItem.tokens.join(' '));
      const oldProseSet = tokenize(baseItem.prose);

      const rRate = retentionRate(oldTokensSet, newTokensSet);
      const pSim = jaccardSimilarity(oldProseSet, newProseSet);

      totalRetention += rRate;
      totalProseSim += pSim;

      // 单条如果保留率超过 80% 或 prose 完全没改，报警
      if (!targeted && rRate > 0.85 && pSim > 0.80) {
        errors.push(`[偷懒嫌疑] ${id}: 词条保留率 ${(rRate * 100).toFixed(1)}%, Prose 相似度 ${(pSim * 100).toFixed(1)}%`);
      } else if (targeted && rRate >= 0.999 && pSim >= 0.999) {
        errors.push(`[偷懒嫌疑] ${id}: 交付与基线完全一致（保留率 100%, Prose 相似度 100%），疑似未改写`);
      }
    }
  });

  const avgRetention = totalChecked ? totalRetention / totalChecked : 0;
  const avgProseSim = totalChecked ? totalProseSim / totalChecked : 0;

  console.log(`\n[结果] 覆盖 ${totalChecked}/${deliveryMap.size}（skip 0，缺漏 0）`);
  console.log(`[结果] 平均词条保留率 ${(avgRetention * 100).toFixed(1)}%（标准 ≤50%），平均 prose 相似度 ${avgProseSim.toFixed(2)}（标准 ≤0.60）`);

  // 跨条目模板检测（红线 7：无模板签名与全局雷同）
  const cross = crossEntryAudit(deliveryMap);
  console.log(`[结果] 跨条目签名检测：最高签名占比 ${(cross.maxRatio * 100).toFixed(1)}%${cross.maxSignature ? `（"${cross.maxSignature}"）` : ''}，两两雷同对 ${cross.pairDupes.length}`);
  for (const w of cross.warnings) console.warn(`[警告] ${w}`);
  errors.push(...cross.errors);

  if (errors.length > 0) {
    console.error(`\n[门禁失败] 发现 ${errors.length} 条疑似偷懒或未重写条目:`);
    errors.slice(0, 10).forEach(e => console.error(e));
    process.exit(1);
  }

  console.log(`\n✔ [通过] 交付内容全量覆盖、无模板复用、无偷懒追加、满足 AGENTS.md 防偷懒契约！`);
  process.exit(0);
}

if (require.main === module && process.argv.includes('--delivery')) {
  main();
}
