#!/usr/bin/env node
import { errorMessage as runtimeErrorMessage } from '../lib/runtime-errors';
import gateway = require('../lib/generation-gateway');
import catalog = require('../lib/generation/anima-model-catalog');
import type { GatewayRecord } from '../lib/generation-types';
const { object }: typeof import('../lib/content-history-reader') = require('../lib/content-history-reader');
'use strict';


/**
 * render-design-sheets.js — 角色三视图设计图（character sheet）批量渲染
 *
 * 用途：为热门角色生成 front / side / back 三视角的人物设计图基线，
 *       供 H3 视频创作当「2D 设定图 → 3D 模型」流程中的设定图使用。
 *
 * 数据源：
 *   - data/character-reference-view.json     任务事实源（哪些 design 条目还是 pending）
 *   - data/character-reference-standards.json 提示词素材（identityProse + outfit.prose 为主，
 *        identityTokens + outfit.tokens 作为词表保底——prose 带角色气质语义，token 精确锚定特征）
 * 输出：E:/code/2/lora/AI/CharacterReferences/<角色>/[<服装>/]ref_design_<view>.png
 *
 * 增量与断点续跑：默认只跑 view.json 中 pending 的 design 条目；目标文件已存在则跳过；
 *   --all 强制重跑（同条目同 seed，可复现；要变体请加 --seed-shift）。
 * 稳定 seed：sha1(角色/服装/视角) 派生，同一条目任何时候重跑都得到同一张图。
 *
 * 当前引擎与参数（2026-08-30 首轮 153 张底模为 Anima Aesthetic v1.1）：
 *   MiaoMiao Harem Anima v1.6 + qwen_3_06b CLIP + qwen_image_vae，
 *   960×1536，30 steps Euler/normal，CFG 4.5，ImageSharpenKJ RCAS 0.75。
 *   通过绘遇原生图像网关提交；保留原有尺寸、采样和 RCAS 配方。
 *   TeaCache 默认 rel_l1_thresh=0.10，
 *   --no-teacache 可关。
 *
 * 用法：
 *   node scripts/maintenance/render-design-sheets.js [--chars=a,b] [--outfits=x,y]
 *        [--views=front,side,back] [--all] [--dry-run] [--limit=N] [--seed-shift=N]
 *   --chars/--outfits/--views   按角色/服装/视角过滤（不传 = 全部）
 *   --all                       强制重跑已生成的条目（默认只跑 pending）
 *   --dry-run                   只列出任务不真正出图
 *   --limit=N                   只跑前 N 个任务（试跑）
 *   --seed-shift=N              seed 偏移，用于同条目换变体（默认 0）
 *
 * 环境变量：
 *   GATEWAY_URL    默认 http://127.0.0.1:3000
 *   AICS_RUNTIME_ROOT 保存请求与可续查的任务编号
 *   AI_WORKSPACE_ROOT 默认 <项目根>/../AI（参考图根目录所在）
 */

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const crypto: typeof import('crypto') = require('crypto');
const { compress }: typeof import('../lib/precompressed-artifacts') = require('../lib/precompressed-artifacts');

const HOST = gateway.gatewayUrl();
const ROOT = path.resolve(process.env.AICS_DATA_ROOT || process.env.AICS_APP_ROOT || path.join(__dirname, '..', '..'));
const VIEW_FILE = path.join(ROOT, 'data', 'character-reference-view.json');
const REF_ROOT = process.env.AI_WORKSPACE_ROOT
  ? path.join(process.env.AI_WORKSPACE_ROOT, 'CharacterReferences')
  : path.resolve(ROOT, '..', 'AI', 'CharacterReferences');
const JOB_ROOT = path.join(process.env.AICS_RUNTIME_ROOT || path.join(ROOT, 'runtime'), 'reference-design-jobs');

// 负面词：基础词照抄项目前端权威来源 promptBuilderStore.ts NEGATIVE_DEFAULT，
// 双人参考页保留防双子镜像追加词（identical twins /
// merged bodies / fused limbs / duplicate person / cloned face / swapped hair），
// 防掀裙追加自然语言负面（2026-08-31：back 视角曾翻车成掀裙）。
const NEGATIVE =
  'worst quality, low quality, lowres, bad anatomy, bad hands, extra fingers, fewer fingers, missing fingers, extra limbs, missing limbs, deformed, mutilated, disfigured, bad proportions, duplicate, cloned face, ugly, blurry, jpeg artifacts, watermark, text, signature, logo, monochrome, grayscale, frame, border, username, artist name, bad_prompt, bad_prompt_version2, bad-hands-5, ng_deepnegative_v1_75t, scenery, cityscape, complex_background, identical twins, merged bodies, fused limbs, duplicate person, swapped hair, extra person, skirt lift, lifted skirt, skirt blown up';

// 视角模板（2026-08-31 修订）：side/back 曾翻车为双子镜像 / 掀裙，
// 靠负面词压制（见 NEGATIVE，照抄项目现成词表），视角词保持标准。
const VIEWS: Partial<Record<string, string>> = {
  front: 'front_view, facing_viewer, looking_at_viewer, solo, single character',
  side: 'side_view, profile, looking_ahead, solo, single character',
  back: 'back_view, from_behind, solo, single character',
};
// 自然站姿 + 单一角色 + 单角度（避免 character_sheet 把多角度塞进一张图）
const SHEET =
  'standing, full_body, natural_pose, hands_relaxed, one_hand_at_side, simple_background, plain_background, gray_background, even_lighting, soft_lighting, character_reference, reference_sheet, design_reference';

function log(msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}
function fail(msg: string) {
  console.error(`[${new Date().toISOString().slice(11, 19)}] ✗ ${msg}`);
  process.exit(1);
}

// ── CLI 解析 ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`用法: node scripts/maintenance/render-design-sheets.js [选项]

三视图设计图批量渲染（增量默认只跑 view.json 中 pending 的条目，已存在自动跳过）

选项:
  --chars=a,b      只跑指定角色（逗号分隔，默认全部）
  --outfits=x,y    只跑指定服装（逗号分隔，默认全部）
  --views=f,s,b    只跑指定视角 front/side/back（逗号分隔，默认全部）
  --all            强制重跑已生成的条目（同条目同 seed 可复现）
  --dry-run        只列出任务不出图
  --limit=N        只跑前 N 个任务（试跑）
  --seed-shift=N   seed 偏移，同条目换变体用
  --no-teacache    关闭 TeaCache 加速（默认开：rel_l1_thresh=0.10，沿用生产管线默认）
  --tea-thresh=N   自定义 TeaCache rel_l1_thresh（0 = 关闭；生产默认 0.10）

环境变量: GATEWAY_URL / AICS_RUNTIME_ROOT / AI_WORKSPACE_ROOT
依赖: 绘遇网关，已启用原生绘图并准备 MiaoMiao 1.6 完整模型`);
  process.exit(0);
}
function pick(flag: string) {
  const hit = args.find(a => a.startsWith(flag + '='));
  if (!hit) return null;
  return hit.slice(flag.length + 1).split(',').map(s => s.trim()).filter(Boolean);
}
const charsFilter = pick('--chars');
const outfitsFilter = pick('--outfits');
const viewsFilter = pick('--views');
const all = args.includes('--all');
const dryRun = args.includes('--dry-run');
const limit = Number((args.find(a => a.startsWith('--limit=')) || '').split('=')[1] || 0) || null;
const seedShift = Number((args.find(a => a.startsWith('--seed-shift=')) || '').split('=')[1] || 0) || 0;
// MiaoMiao 1.6 的本机对照缓存：0.10、起止比例 0–1、CUDA 缓存。
// 需要对照画质可 --no-teacache 关闭，或 --tea-thresh=<值> 调档（0 = 关闭）。
const teaThreshArg = args.find(a => a.startsWith('--tea-thresh='));
const teaThresh = teaThreshArg ? Number(teaThreshArg.split('=')[1]) : (args.includes('--no-teacache') ? 0 : 0.10);

// ── 工具 ─────────────────────────────────────────────────────────────────────
function stableSeed(charId: string, outfitId: string, view: string) {
  const digest = crypto.createHash('sha1').update(`${charId}/${outfitId}/${view}`).digest();
  return (digest.readUInt32BE(0) % 1000000) + seedShift * 1000000;
}

/**
 * 契约（2026-08-31 定稿，勿违反）：
 *   「照抄，不创作」——identityProse / outfit.prose / identityTokens / outfitTokens
 *   一律原样取自 data/character-reference-standards.json，脚本内禁止改写、增删或
 *   自行发明任何角色/服装描述词（教训：自编体型 tag 出过 NSFW 身材、浪费整轮重跑）。
 *   脚本只允许追加：质量词前缀 + 视角/站姿技术后缀（VIEWS/SHEET，非角色内容）。
 */
function buildPrompt(identityProse: string, identity: string, outfitProse: string, outfit: string, viewTags: string) {
  return `score_7, score_6, masterpiece, best quality, ${identityProse}, ${outfitProse}, ${identity}, ${outfit}, ${viewTags}, ${SHEET}`;
}

const lifetime = new AbortController();
process.once('SIGINT', () => lifetime.abort());
process.once('SIGTERM', () => lifetime.abort());

async function requireNative() {
  const response = await fetch(HOST + '/api/anima/status', { redirect: 'error', signal: AbortSignal.timeout(10000) });
  const data: unknown = await response.json();
  if (!response.ok || !object(data) || data.provider !== 'native' || !Array.isArray(data.models)
    || !data.models.some((model: unknown) => object(model) && model.id === 'anima-miaomiao-v1.6' && model.available === true))
    throw new Error('请在绘遇控制室启用原生绘图，准备 MiaoMiao 1.6 完整模型并重启；不会回退 ComfyUI');
}

async function submitAndWait(text: string, seed: number, destination: string) {
  const model = catalog.MODELS['anima-miaomiao-v1.6'];
  const payload = { modelId: 'anima-miaomiao-v1.6', prompt: text, negative: NEGATIVE, seed,
    width: 960, height: 1536, steps: model.steps, cfg: model.cfg,
    teaCache: teaThresh > 0, teaCacheThresh: teaThresh };
  // Sampler/scheduler and the text-to-image RCAS 0.75 pass belong to the
  // gateway's fixed MiaoMiao recipe; those are not public request parameters.
  const identity = crypto.createHash('sha256').update(JSON.stringify({ gateway: HOST, destination, payload })).digest('hex');
  const receipt = path.join(JOB_ROOT, identity + '.json');
  let record: GatewayRecord = { gateway: HOST, payload, seed, status: 'new' };
  if (fs.existsSync(receipt)) {
    const saved: unknown = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    if (!object(saved) || saved.gateway !== HOST || JSON.stringify(saved.payload) !== JSON.stringify(payload)
      || typeof saved.status !== 'string' || saved.jobId !== undefined && typeof saved.jobId !== 'string')
      throw new Error('原请求记录无效，已保留，请人工核对：' + receipt);
    record = saved as GatewayRecord;
    if (!record.jobId && record.status !== 'new') throw new Error('原请求接收状态未知，不会重发；请核对网关和记录：' + receipt);
    if (all && ['saved', 'failed', 'cancelled'].includes(record.status)) {
      fs.copyFileSync(receipt, path.join(JOB_ROOT, identity + '.' + crypto.randomUUID() + '.json'), fs.constants.COPYFILE_EXCL);
      record = { gateway: HOST, payload, seed, status: 'new' };
    } else if (['failed', 'cancelled'].includes(record.status)) throw new Error('原任务已结束；核对后使用 --all 或新的 --seed-shift 开始新创作：' + receipt);
  }
  const save = (value: GatewayRecord) => {
    fs.mkdirSync(JOB_ROOT, { recursive: true });
    const pending = receipt + '.tmp';
    fs.writeFileSync(pending, JSON.stringify(value));
    fs.renameSync(pending, receipt);
  };
  try {
    const result = await gateway.generate(record, save, { signal: lifetime.signal });
    if (record.provider !== 'native') throw new Error('返回任务不是原生图像，未写入目标文件');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const pending = destination + '.tmp';
    fs.writeFileSync(pending, result.buffer);
    fs.renameSync(pending, destination);
    record.status = 'saved'; save(record);
  } finally {
    if (lifetime.signal.aborted && record.jobId) {
      const response = await fetch(HOST + '/api/anima/jobs/' + encodeURIComponent(record.jobId), {
        method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(10000),
      }).catch(() => null);
      log(response?.ok ? '已请求取消原任务；任务编号保留，可重开核对' : '取消尚未确认；任务编号保留，请在绘遇核对');
    }
  }
}

/**
 * 目标文件在参考图根下的相对路径。
 * 2026-08-31 修复：原实现按「磁盘上是否存在 <charId>/<outfitId> 目录」决定输出位置——
 * 尚无独立目录的非默认服装（如 silk_sleepwear）会被错误落到角色根目录，
 * 覆盖该角色的默认服装设计图（11 张被覆盖事故）。改为按 isDefault 判定：
 * 默认服装 → 角色根；非默认 → <角色>/<服装>/（目录由调用方确保存在）。
 */
function targetRelPath(charId: string, outfitId: string, view: string, isDefault: boolean) {
  return isDefault
    ? path.join(charId, `ref_design_${view}.png`)
    : path.join(charId, outfitId, `ref_design_${view}.png`);
}

// ── 收集任务 ─────────────────────────────────────────────────────────────────
const referenceStore: typeof import('../lib/reference-store') = require('../lib/reference-store');
const { view, standards } = referenceStore.readReferenceLibrary(ROOT);
const stdByChar = new Map(standards.characters.map(c => [c.id, c]));

type DesignTask = { charId: string; outfitId: string; viewName: string; viewTags: string; identityProse: string; identity: string;
  outfitProse: string; outfitTokens: string; rel: string; abs: string };
const tasks: DesignTask[] = [];
const skipped = { existing: 0, missingTokens: 0 };

for (const profile of Object.values(view)) {
  const charId = profile.characterId;
  if (charsFilter && !charsFilter.includes(charId)) continue;
  const stdChar = stdByChar.get(charId);
  const identityProse = (stdChar && stdChar.identityProse || '').trim();
  const identity = (stdChar?.identityTokens || []).join(', ').trim();
  for (const o of profile.outfits || []) {
    if (outfitsFilter && !outfitsFilter.includes(o.outfitId)) continue;
    const stdOutfit = stdChar?.outfits.find(x => x.id === o.outfitId);
    const outfitProse = (stdOutfit && stdOutfit.prose || '').trim();
    const outfitTokens = (stdOutfit?.tokens || []).join(', ').trim();
    for (const ref of o.references || []) {
      if (!ref.id || !String(ref.id).startsWith('ref_design_')) continue;
      const viewName = ref.id.replace('ref_design_', '');
      if (viewsFilter && !viewsFilter.includes(viewName)) continue;
      const needRun = all || (ref.pending === true && !ref.url);
      const rel = targetRelPath(charId, o.outfitId, viewName, o.isDefault === true);
      const abs = path.join(REF_ROOT, rel);
      if (!needRun && fs.existsSync(abs)) { skipped.existing++; continue; }
      if (!identityProse || !outfitProse) { skipped.missingTokens++; continue; }
      const viewTags = VIEWS[viewName];
      if (!viewTags) throw new Error(`Unsupported design view: ${viewName}`);
      // 非默认服装输出到 <角色>/<服装>/ 子目录：目录不存在则创建，避免落回角色根覆盖默认图。
      tasks.push({ charId, outfitId: o.outfitId, viewName, viewTags, identityProse, identity, outfitProse, outfitTokens, rel, abs });
    }
  }
}

if (dryRun) {
  log(`[dry-run] 待跑 ${tasks.length} 张（跳过：已存在 ${skipped.existing} / 缺 token ${skipped.missingTokens}）`);
  tasks.slice(0, limit || 20).forEach((t, i) =>
    log(`  ${i + 1}. ${t.charId}/${t.outfitId}/${t.viewName} -> ${t.rel}`));
  process.exit(0);
}

async function main() {
  await requireNative();
if (!tasks.length) {
  log('没有待跑任务（全部已完成或已被过滤），继续执行 view.json 回填后退出');
}

log(`待跑 ${tasks.length} 张（跳过：已存在 ${skipped.existing} / 缺 token ${skipped.missingTokens}）`);
const slice = limit ? tasks.slice(0, limit) : tasks;
let ok = 0;

for (const t of slice) {
  const seed = stableSeed(t.charId, t.outfitId, t.viewName);
  const text = buildPrompt(t.identityProse, t.identity, t.outfitProse, t.outfitTokens, t.viewTags);
  log(`▶ ${t.charId}/${t.outfitId}/${t.viewName} (seed ${seed})`);
  // No retry after an ambiguous POST; the saved job ID is the only continuation.
  await submitAndWait(text, seed, t.abs);
  ok++;
  log(`  ✓ 已存 ${path.relative(REF_ROOT, t.abs)}`);
}
log(`=== 完成: 本次 ${slice.length} 成功 ${ok} ===`);

// ── 后处理：view.json pending→url + 重建预压缩产物 ─────────────────────────
try {
  // Rendering can take hours: update the current source, not the initial snapshot.
  const current = referenceStore.readReferenceLibrary(ROOT);
  let filled = 0;
  for (const profile of Object.values(current.view)) {
    for (const o of profile.outfits || []) {
      for (const ref of o.references || []) {
        if (!ref.id || !String(ref.id).startsWith('ref_design_') || !ref.pending) continue;
        // 双路径探测：服装子目录优先、角色根兜底。与 targetRelPath 的 isDefault
        // 语义解耦——此前 hasCustomDir 启发式在服装目录被 4 视角渲染创建后猜错
        // 路径，导致已渲染文件永远回填不上（2026-09-06 实测漏 57 条）。
        const candidates = [
          `/character-references/${profile.characterId}/${o.outfitId}/${ref.id}.png`,
          `/character-references/${profile.characterId}/${ref.id}.png`,
        ];
        const hit = candidates.find(c => fs.existsSync(path.join(REF_ROOT, c.replace(/^\/character-references\//, ''))));
        if (hit) {
          ref.url = hit;
          delete ref.pending;
          filled++;
        }
      }
    }
  }
  if (filled) {
    referenceStore.writeReferenceLibrary(ROOT, current.standards, current.view);
    const c = compress(VIEW_FILE);
    log(`view.json 已更新: ${filled} 个 design 条目填 url，${c ? `预压缩产物已重建（br ${c.brotli}B / gz ${c.gzip}B）` : '小文件无需预压缩'}`);
  } else {
    log('view.json 无新增可填条目');
  }
} catch (e) {
  log('view.json 更新失败: ' + runtimeErrorMessage(e));
}
}

async function runOwned() {
  fs.mkdirSync(JOB_ROOT, { recursive: true });
  const lockPath = path.join(JOB_ROOT, 'active.lock');
  let lock: number;
  try { lock = fs.openSync(lockPath, 'wx'); }
  catch { throw new Error('设计图维护已有操作或未清理的中断记录；请核对 ' + lockPath); }
  try { fs.writeFileSync(lock, String(process.pid)); await main(); }
  finally { fs.closeSync(lock); fs.unlinkSync(lockPath); }
}
runOwned().catch((error: unknown) => fail(error instanceof Error ? error.stack || error.message : String(error)));
