#!/usr/bin/env node
'use strict';

/**
 * audit-showcase-rella.js — 逐张审核 rella 样张（强制角色身份判定）。
 *
 * 对 generation-manifest.json 中每条 succeeded 记录：
 *   - 用 image-inspect.js（CLIProxyAPI + gemini-3.7-flash-high）逐张看图
 *   - 审核维度：① 角色身份（是否是对应角色，必须对照档案特征）② 单人主体
 *     ③ 肢体/面部 ④ 乱码/伪影 ⑤ 场景契合
 *   - 输出 audit-results.json（verdict: pass | fail | review，身份不符强制 fail）
 *
 * Usage:
 *   node scripts/maintenance/audit-showcase-rella.js \
 *       [--manifest <generation-manifest.json>] [--out <audit-results.json>] \
 *       [--limit <n>] [--resume]
 */

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const { spawnSync }: typeof import('child_process') = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_MANIFEST = path.join(ROOT, '..', 'AI', 'Reviews', 'ShowcaseRefresh', '2026-08-15_v33-arknights-rella', 'generation-manifest.json');
const DEFAULT_OUT = path.join(ROOT, '..', 'AI', 'Reviews', 'ShowcaseRefresh', '2026-08-15_v33-arknights-rella', 'audit-results.json');

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}

const characters = readJson(path.join(ROOT, 'data', 'popular-characters.json')).characters;

function expectedFeatures(character, outfitId) {
  const top = (character.identityTokens || []).filter(t => !['1girl', 'solo', 'arknights'].includes(t)).slice(0, 10).join(' / ');
  const outfit = (character.outfits || []).find(o => o.id === outfitId)
    || (character.outfits || []).find(o => o.isDefault) || (character.outfits || [])[0];
  return `${character.displayName}（${character.originalName}）\n身份描述：${character.identityProse}\n关键标识：${top}\n主服装：${outfit ? outfit.prose : '（未定义）'}`;
}

function buildPrompt(record) {
  const character = characters.find(c => c.id === record.characterId) || { displayName: record.characterId, identityProse: '', identityTokens: [] };
  const expected = expectedFeatures(character, record.outfitId) + `\n本张实际提交的场景：${record.prompt || record.blueprintTitle}`;
  return `你是画师样张审核员。这是「${record.displayName}」的出图审核（画师 @rella 风格，蓝图「${record.blueprintTitle}」）。\n\n【该角色的预期特征】\n${expected}\n\n请逐项审核并严格按格式输出：\n1) 角色身份：画面中的人物是否确实是「${character.displayName}」本人？必须逐项对照预期特征（发色/瞳色/发型/标志特征/服装），明确回答 是 或 否，并说明依据（若不像，说清被画成了什么/哪里不像）；\n2) 单人主体【判定规则】：a) 若画面出现第二个『同一主角』的完整人物（分身/复制体/镜像克隆/并排双主角），一律判不通过；b) 背景出现的明显不同路人/宾客/顾客（小尺寸、远离主角、非主角同款），属于合理的场景人物，可通过；c) 若画面有镜面元素（镜子/水面倒影/玻璃反光），同一主角的自然镜像可通过，镜中出现另一个完整人物/镜像与主体不一致则判不通过。请明确说明：主角是否仅一人、有无同款分身/复制体、背景路人情况、有无镜面及其合理性；\n3) 肢体与面部：有无崩坏（手/脸/肢体/穿模/结构错误）；\n4) 乱码伪影：有无文字乱码、水印、生成伪影；\n5) 场景契合：场景与蓝图主题是否匹配（蓝图：${record.blueprintTitle}）。\n\n【输出格式】（必须两行开头，后面可加详细说明）\n第一行：结论：通过 / 不通过 / 需注意\n第二行：角色身份：是 / 否\n之后：逐项说明。行内不要使用代码片段符号。`;
}

/** 新旧对比审核提示词（旧样张已存在时使用）：左图=新生成，右图=线上旧版。 */
function buildComparePrompt(record) {
  const character = characters.find(c => c.id === record.characterId) || { displayName: record.characterId, identityProse: '', identityTokens: [] };
  const expected = expectedFeatures(character, record.outfitId);
  return `你是画师样张审核员。这是「${record.displayName}」的新旧样张对比审核（画师 @rella 风格，蓝图「${record.blueprintTitle}」）。\n\n【该角色的预期特征】\n${expected}\n\n图中左图=新生成样张，右图=当前线上旧版样张。请逐项对比并严格按格式输出：\n1) 角色身份：两张图是否都正确还原「${character.displayName}」？（发色/瞳色/发型/标志特征/服装），分别回答 是/否；\n2) 单人主体【判定规则】：a) 任一张图若出现第二个『同一主角』的完整人物（分身/复制体/镜像克隆/并排双主角），则该图判不通过；b) 背景出现的明显不同路人/宾客/顾客（小尺寸、远离主角、非主角同款），属于合理的场景人物，可通过；c) 镜面元素（镜子/水面倒影/玻璃反光）：同一主角自然镜像可通过，镜中出现另一个完整人物/镜像与主体不一致则判不通过。请分别说明两图：主角是否仅一人、有无同款分身、背景路人情况、有无镜面及合理性；\n3) 画质对比：哪张完成度更高（线条/光影/细节/背景）？哪张有崩坏/伪影/乱码/水印？\n4) 场景契合：哪张更符合蓝图「${record.blueprintTitle}」的主题与构图？\n5) 表情与氛围：哪张的表情更符合角色性格与场景氛围？\n\n【输出格式】（必须两行开头，后面可加详细说明）\n第一行：结论：新图更好 / 旧图更好 / 差不多 / 新图不通过 / 旧图不通过 / 都不通过\n第二行：角色身份：新=是/否，旧=是/否\n之后：逐项说明。行内不要使用代码片段符号。`;
}

function parseVerdict(output) {
  const text = String(output || '');
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const concl = lines.find(l => l.startsWith('结论'));
  const identity = lines.find(l => l.startsWith('角色身份'));
  let verdict = 'review';
  if (concl) {
    // 对比模式结论：新图更好/旧图更好/差不多/新图不通过/旧图不通过/都不通过
    if (/旧图更好|旧图更佳|保留旧图|旧版更好/.test(concl)) verdict = 'skip';
    else if (/都不通过|两张.{0,6}不通过|全部不通过/.test(concl)) verdict = 'fail';
    else if (/新图不通过|新样张不通过|左图不通过/.test(concl)) verdict = 'fail';
    else if (/旧图不通过|旧版不通过|右图不通过/.test(concl)) verdict = 'pass';
    else if (/新图更好|新图更佳|新样张更好|差不多|不相上下|难分伯仲|平手|各有千秋/.test(concl)) verdict = 'pass';
    else if (/不通过/.test(concl)) verdict = 'fail';
    else if (/通过/.test(concl)) verdict = 'pass';
    else verdict = 'review';
  }
  // 身份判定：单图模式「角色身份：否」→ fail；
  // 对比模式「角色身份：新=否，旧=是」→ 新身份错但旧对 → skip（保留旧）；新=否 旧=否 → fail
  if (identity) {
    const newMatch = identity.match(/新\s*[=：:]\s*(是|否)/);
    const oldMatch = identity.match(/旧\s*[=：:]\s*(是|否)/);
    if (newMatch) {
      if (newMatch[1] === '否') {
        verdict = (oldMatch && oldMatch[1] === '是') ? 'skip' : 'fail';
      }
    } else if (identity.includes('：否') || identity.includes(':否') || identity.includes('身份：否')) {
      verdict = 'fail';
    }
  }
  // 严重多人/分身/分镜错误 → 强制 fail 或按新旧图归属降级（防结论漏判：vision 有时结论写「通过」但详情描述分身）。
  // 2026-08-18 用户裁定：双人一律不通过；镜子/倒影需判断合理性——上下文含「镜」时
  // 不强制 fail（交由 vision 在审核提示词指导下判定），无镜面的双人描述则硬 fail。
  // 对比模式下按「左/新 vs 右/旧」归属：新图双人→skip（保留旧样张），旧图双人→pass（换新图）。
  const multiPattern = /(双人错误|分身错误|复制分身|出现两个|同时存在.{0,10}两个|严重.{0,6}(双人|分身|多人)|两个完整.{0,4}(人物|角色)|多余人物|画面.{0,6}两个|分镜|双格|拼贴|上下两格|双分镜)/i;
  const multi = text.match(multiPattern);
  if (multi) {
    const ctx = text.slice(Math.max(0, multi.index - 30), multi.index + 50);
    const negated = /(无|非|不是|不构成|未|仅|只有|不算|没有)/.test(ctx);
    const hasMirror = /(镜|倒影|反光|水面映)/.test(ctx);
    if (!negated && !hasMirror) {
      if (/左图|新图|新样张|左边|左侧图/.test(ctx)) verdict = 'skip'; // 新图双人 → 保留旧样张
      else if (/右图|旧图|旧版|右边|右侧图/.test(ctx)) verdict = 'pass'; // 旧图双人 → 采用新图
      else verdict = 'fail';
    }
    // 有镜面元素：不强制 fail；但若 vision 明确描述「镜中第二人/另一个完整人物」则仍 fail
    if (hasMirror && !negated && /(镜中.{0,6}(另一个|第二|完整人物|真人)|另一个.{0,4}(人物|角色|女孩|女人))/.test(ctx)) {
      verdict = 'fail';
    }
  }
  return { verdict, summary: text.slice(0, 1200), identityLine: identity || '' };
}

async function main() {
  const manifestPath = path.resolve(argument('--manifest', DEFAULT_MANIFEST));
  const outPath = path.resolve(argument('--out', DEFAULT_OUT));
  const limit = Math.max(1, Number(argument('--limit', '9999')) || 9999);
  // 2026-08-18：审核并行化（AGENTS.md 批量审核 4-6 并发）；默认 4，上限 6。
  const concurrency = Math.max(1, Math.min(6, Number(argument('--concurrency', '4')) || 4));
  const resume = process.argv.includes('--resume');
  // 2026-08-18 用户裁定：对比线上旧样张择优——旧图更好则保留旧（skip 不发布）。
  const legacyManifestFile = argument('--legacy', '');
  const legacyImages = new Map();
  if (legacyManifestFile && fs.existsSync(legacyManifestFile)) {
    const lm = readJson(legacyManifestFile);
    for (const e of lm.entries || []) {
      if (typeof e !== 'object' || e === null || !(e.id || '').startsWith('pc_')) continue;
      const bp = (e.id || '').replace('pc_' + e.char + '_', '');
      if (bp === e.id || !e.image) continue;
      legacyImages.set(`${e.char}:${bp}`, path.join(path.dirname(legacyManifestFile), String(e.image).split('/').join(path.sep)));
    }
    console.log(`[legacy] loaded ${legacyImages.size} existing showcase samples for comparison`);
  }

  const records = readJson(manifestPath).filter(r => r.status === 'succeeded');
  const audit = resume && fs.existsSync(outPath) ? readJson(outPath) : {};
  // resume：只审「未审过(新 attempt / 无记录) + fail + review」，保留 pass/skip 已定案。
  const pending = records.filter(r => {
    const verdict = audit[r.recordId] && audit[r.recordId].verdict;
    return !verdict || verdict === 'fail' || verdict === 'review';
  });
  if (limit < pending.length) pending.length = limit;
  console.log(`[plan] ${records.length} succeeded records, ${pending.length} to inspect (concurrency ${concurrency})`);

  let inspected = 0;
  let pass = 0, fail = 0, review = 0, skip = 0;
  let cursor = 0;

  async function inspectOne(record) {
    const imagePath = path.join(path.dirname(manifestPath), record.image);
    if (!fs.existsSync(imagePath)) {
      audit[record.recordId] = { ok: false, verdict: 'fail', summary: 'image file missing', inspectedAt: new Date().toISOString() };
      fail += 1;
      console.log(`[missing] ${record.recordId}: ${imagePath}`);
      return;
    }
    const legacyPath = legacyImages.get(`${record.characterId}:${record.blueprintId}`);
    const compare = Boolean(legacyPath && fs.existsSync(legacyPath));
    const inspectScript = path.join(ROOT, 'scripts', 'maintenance', 'image-inspect.js');
    const args = compare
      ? [inspectScript, imagePath, legacyPath, '--mode', 'group', '-p', buildComparePrompt(record)]
      : [inspectScript, imagePath, '-p', buildPrompt(record)];
    const result = spawnSync(process.execPath, args, {
      encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024,
    });
    const output = (result.stdout || '') + (result.stderr || '');
    const { verdict, summary, identityLine } = parseVerdict(output);
    audit[record.recordId] = { ok: result.status === 0 && !result.error, verdict, summary, identityLine, compare, inspectedAt: new Date().toISOString() };
    inspected += 1;
    if (verdict === 'pass') pass += 1;
    else if (verdict === 'fail') fail += 1;
    else if (verdict === 'skip') skip += 1;
    else review += 1;
    console.log(`[${verdict}${compare ? '*cmp' : ''}] ${record.recordId}${identityLine ? ' | ' + identityLine : ''}`);
    if (inspected % 10 === 0) {
      writeJsonAtomic(outPath, audit);
      console.log(`  ...progress ${inspected}/${pending.length} (pass ${pass} fail ${fail} review ${review} skip ${skip})`);
    }
  }

  async function worker() {
    while (cursor < pending.length) {
      const record = pending[cursor];
      cursor += 1;
      await inspectOne(record);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, () => worker()));
  writeJsonAtomic(outPath, audit);
  console.log(JSON.stringify({ inspected, pass, fail, review, skip, total: records.length }, null, 2));
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
