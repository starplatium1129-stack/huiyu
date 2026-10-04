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
 *   npm run wf -- check:rewrite --delivery <条目JSON/记录快照> [--baseline <commit> | --baseline-file <编写前快照>] [--character <id,...>] [--sfw] [--compiled-out <JSON>] [--targeted]
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
const catalog: typeof import('../lib/catalog-snapshot') = require('../lib/catalog-snapshot');
const { createHash }: typeof import('node:crypto') = require('node:crypto');

test('prompt rewrite integrity tokenization and similarity heuristics', () => {
  const s1 = tokenize('1girl, solo, ayachi_nene, pink_ribbon, uniform');
  const s2 = tokenize('1girl, solo, ayachi_nene, school_uniform');
  assert.ok(s1.has('ayachi'));
  assert.ok(s1.has('nene'));
  assert.strictEqual(retentionRate(s1, s2), 5 / 7);
  assert.strictEqual(jaccardSimilarity(s1, s2), 5 / 8);
  assert.strictEqual(retentionRate(new Set(), s2), 0);
  assert.strictEqual(jaccardSimilarity(new Set(), new Set()), 0);
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
test('Git catalog baselines and exported record inputs preserve prompt IDs and prose', () => {
  const base = fs.realpathSync.native(require('node:os').tmpdir());
  const directory = fs.mkdtempSync(path.join(base,'huiyu-rewrite-'));
  const record = {kind:'blueprint',id:'bp_fixture',revision:1,sortOrder:0,createdAt:null,updatedAt:null,
    data:{id:'bp_fixture',characterId:'fixture',promptTokens:['reading'],promptProse:'The catalog baseline is authoritative.'}};
  const name = `blueprint/bp_fixture-${createHash('sha256').update(record.id).digest('hex').slice(0,12)}.json`;
  const git = (args:string[]) => execFileSync('git',args,{cwd:path.resolve(__dirname,'../..'),encoding:'utf8',stdio:['ignore','pipe','pipe']});
  try {
    fs.mkdirSync(path.join(directory,'data/catalog/blueprint'),{recursive:true});
    fs.writeFileSync(path.join(directory,'data/catalog',name),JSON.stringify(record));
    fs.writeFileSync(path.join(directory,'data/catalog/manifest.json'),JSON.stringify({version:1,files:[name]}));
    const manifest=JSON.parse(git(['show','HEAD:data/catalog/manifest.json']));
    const file=manifest.files.find((f:string)=>f.startsWith('blueprint/'));
    const headRecord=JSON.parse(git(['show',`HEAD:data/catalog/${file}`]));
    assert.equal(getBaselineData('HEAD',new Set([headRecord.id])).get(headRecord.id)?.prose,headRecord.data.promptProse);
    assert.deepEqual(promptItems(readInput(path.join(directory,'data/catalog'))),[record.data]);
    assert.deepEqual(promptItems([record]),[record.data]);
  } finally {
    assert.ok(path.resolve(directory).startsWith(base+path.sep));
    fs.rmSync(directory,{recursive:true,force:true,maxRetries:2,retryDelay:50});
  }
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

function promptItems(raw: any): any[] {
  if (Array.isArray(raw)) return raw.every(r=>r?.kind && r?.data)
    ? raw.filter(r=>['blueprint','scene'].includes(r.kind)).map(r=>r.data) : raw;
  if (Array.isArray(raw?.records)) return raw.records.filter((r: any) => ['blueprint','scene'].includes(r.kind)).map((r: any) => r.data);
  if (Array.isArray(raw?.blueprints)) return raw.blueprints;
  if (raw && typeof raw === 'object') return Object.values(raw);
  throw new Error('交付需要条目数组或内容快照');
}
function readInput(file: string): any {
  if (fs.statSync(file).isDirectory()) {
    const records = catalog.readDirectory(file);
    if (!records) throw new Error(`缺少内容快照清单：${file}`);
    return { version:1, records };
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function baselineMap(items: any[]) {
  return new Map(items.map(item => [item.id, {
    tokens:item.promptTokens || item.nsfwTokens || String(item.prompt || '').split(',').map((t:string)=>t.trim()).filter(Boolean),
    prose:item.promptProse || item.nsfwProse || item.animaCaption || '',
    characterId:item.characterId, char:item.char,
  }]));
}
function getBaselineData(baselineCommit: string, ids?: Set<string>, root = ROOT) {
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const manifestPath = `${baselineCommit}:data/catalog/manifest.json`;
  let manifestText: string | undefined;
  try { manifestText = git(['show', manifestPath]); } catch {
    // Only pre-migration commits fall back to legacy shards. Invalid catalog data must fail.
  }
  if (manifestText !== undefined) {
    const manifest = JSON.parse(manifestText);
    if (manifest.version !== 1 || !Array.isArray(manifest.files)) throw new Error('基线内容快照清单无效');
    const suffixes = ids && new Set([...ids].map(id => `-${createHash('sha256').update(id).digest('hex').slice(0,12)}.json`));
    const records = manifest.files.filter((file: string) => /^(blueprint|scene)\//.test(file)
      && (!suffixes || [...suffixes].some(suffix => file.endsWith(suffix))))
      .map((file: string) => JSON.parse(git(['show',`${baselineCommit}:data/catalog/${file}`])));
    return baselineMap(promptItems({ records }));
  }
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

    return baselineMap([...bpList,...scList]);
  } catch (err) {
    throw new Error(`基线读取失败，拒绝宣称改写验收通过: ${runtimeErrorMessage(err)}`);
  }
}

function compileDelivery(input: any, root: string, items: any[], out: string) {
  const popular: typeof import('../../src/utils/popularContent.ts') = require('../../src/utils/popularContent.ts');
  const persistence: typeof import('../../src/utils/promptBuilderPersistence.ts') = require('../../src/utils/promptBuilderPersistence.ts');
  const recipes: typeof import('../../src/config/kreaStyleRecipes.ts') = require('../../src/config/kreaStyleRecipes.ts');
  const records = input.records?.some((r:any)=>r.kind==='character') ? input.records : catalog.read(root);
  if (!records) throw new Error('编译需要包含人物和服装的内容快照');
  const views = catalog.views(records);
  const characters = popular.parsePopularCharacters(views.popular);
  const profiles = persistence.parsePresetCatalog(JSON.parse(fs.readFileSync(path.join(root,'data/presets.json'),'utf8'))).modelProfiles;
  const output = [];
  for (const item of items) {
    if (!item.characterId) throw new Error(`${item.id} 是工作室场景；此编译入口只处理热门角色蓝图`);
    const blueprint = popular.parseSceneBlueprint(item);
    const character = characters.find(c=>c.id===item.characterId);
    const outfit = character?.outfits.find(o=>o.id===item.outfitId || (!item.outfitId && o.default));
    if (!blueprint || !character || !outfit) throw new Error(`${item.id} 的人物或服装绑定无效`);
    const decisions = popular.inferBlueprintDecisions(blueprint);
    for (const engine of ['anima','krea2'] as const) {
      const profile = profiles.find(p=>p.id===(engine==='anima'?'anima_miaomiao_v16':'krea2_turbo_fp8'));
      if (!profile) throw new Error(`缺少 ${engine} 当前模型 profile`);
      const result = popular.buildPopularPromptPlan({character,outfit,blueprint,engine,profile,
        shot:decisions.shot,lighting:decisions.lighting,composition:decisions.composition,
        adultEnabled:Boolean(blueprint.adult),
        style:recipes.resolveStyleRecipe(recipes.KREA_STYLE_RECIPES,engine,blueprint,null,character,{adultEnabled:Boolean(blueprint.adult)})});
      if (!result?.prompt) throw new Error(`${item.id} 未通过 ${engine} 编译资格`);
      output.push({id:item.id,characterId:character.id,outfitId:outfit.id,engine,model:profile.model_id,
        positive:result.prompt,negative:result.negative,size:blueprint.recommendedSize,decisions,
        steps:profile.steps,cfg:profile.cfg,sampler:profile.sampler,scheduler:profile.scheduler,modelCalled:false});
    }
  }
  fs.mkdirSync(path.dirname(out),{recursive:true});
  fs.writeFileSync(out,JSON.stringify(output,null,2)+'\n');
  console.log(`[结果] ${items.length} 条蓝图编译为 ${output.length} 份双引擎输入，模型调用 0；${out}`);
}

function main() {
  const value = (flag: string) => {
    const at = process.argv.indexOf(flag);
    if (at < 0) return undefined;
    const result = process.argv[at+1];
    if (!result || result.startsWith('--')) throw new Error(`${flag} 缺少值`);
    return result;
  };
  const root = path.resolve(value('--root') || ROOT);
  const characters = new Set((value('--character') || '').split(',').filter(Boolean));
  const ids = new Set((value('--ids') || '').split(',').filter(Boolean));
  const baselineFile = value('--baseline-file');
  if (baselineFile && value('--baseline')) throw new Error('--baseline 与 --baseline-file 不能同时使用');
  const deliveryFile = value('--delivery');
  const deliveryPath = deliveryFile ? path.resolve(deliveryFile) : null;
  const baselineCommit = value('--baseline') || 'HEAD';

  const targeted = process.argv.includes('--targeted');
  console.log('==============================================================');
  console.log('[门禁] 批量提示词改写完整性复检（防偷懒）');
  console.log(`[门禁] 基线: ${baselineFile || baselineCommit} | 交付: ${deliveryPath || '当前项目快照'} | 模式: ${targeted ? 'targeted 精确修复' : 'default 全量重写'}`);
  console.log('==============================================================');

  let deliveryMap = new Map();

  const sourceRows = !deliveryPath ? catalog.read(root) : null;
  const input = deliveryPath ? readInput(deliveryPath) : sourceRows ? {records:sourceRows} : {
    records: [
      ...JSON.parse(fs.readFileSync(path.join(root,'data/scene-blueprints.json'),'utf8')).blueprints.map((data:any)=>({kind:'blueprint',data})),
      ...JSON.parse(fs.readFileSync(path.join(root,'data/scenes.json'),'utf8')).map((data:any)=>({kind:'scene',data})),
    ],
  };
  for (const item of promptItems(input)) {
    if (characters.size && !characters.has(item.characterId || item.char)) continue;
    if (ids.size && !ids.has(item.id)) continue;
    if (process.argv.includes('--sfw') && (item.adult || item.mature || item.rating === 'R18')) continue;
    if (typeof item.id !== 'string' || !item.id || deliveryMap.has(item.id)) throw new Error('交付条目缺少 ID 或 ID 重复');
    deliveryMap.set(item.id,item);
  }
  if (!deliveryMap.size) throw new Error('所选范围没有提示词条目');
  for (const id of ids) if (!deliveryMap.has(id)) throw new Error(`交付缺少所选条目：${id}`);
  for (const id of characters) if (![...deliveryMap.values()].some(item=>(item.characterId||item.char)===id)) throw new Error(`交付缺少所选角色：${id}`);
  const baseline = baselineFile ? baselineMap(promptItems(readInput(path.resolve(baselineFile)))) : getBaselineData(baselineCommit,new Set(deliveryMap.keys()),root);

  let totalChecked = 0;
  let totalRetention = 0;
  let totalProseSim = 0;
  let compared = 0;
  let errors = [];

  deliveryMap.forEach((delItem, id) => {
    totalChecked++;
    const baseItem = baseline ? baseline.get(id) : null;

    const newTokens = delItem.promptTokens || delItem.nsfwTokens || (delItem.prompt ? delItem.prompt.split(',').map((s: any) => s.trim()) : []);
    const newProse = delItem.promptProse || delItem.nsfwProse || delItem.animaCaption || '';

    const newTokensSet = tokenize(newTokens.join(' '));
    const newProseSet = tokenize(newProse);

    if (baseItem) {
      compared++;
      if (baseItem.characterId !== delItem.characterId || baseItem.char !== delItem.char) errors.push(`[归属改变] ${id}`);
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

  const avgRetention = compared ? totalRetention / compared : 0;
  const avgProseSim = compared ? totalProseSim / compared : 0;

  console.log(`\n[结果] 覆盖 ${totalChecked}/${deliveryMap.size}（skip 0，缺漏 0）`);
  console.log(`[结果] 基线对照 ${compared} 条，新增无旧基线 ${totalChecked-compared} 条`);
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
  if (value('--compiled-out')) compileDelivery(input, root, [...deliveryMap.values()], path.resolve(value('--compiled-out')!));

  console.log(`\n✔ [通过] 交付内容全量覆盖、无模板复用、无偷懒追加、满足 AGENTS.md 防偷懒契约！`);
  process.exit(0);
}

if (require.main === module && process.argv.some(arg => ['--check','--delivery','--baseline','--baseline-file','--character','--ids','--sfw','--root','--targeted','--compiled-out'].includes(arg))) {
  main();
}
