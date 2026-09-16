#!/usr/bin/env node
import { errorMessage as runtimeErrorMessage } from '../lib/runtime-errors';
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
 * 引擎与参数（与 2026-08-30 首轮 153 张基线一致）：
 *   anima-aesthetic-v1.1 + qwen_3_06b CLIP + qwen_image_vae，
 *   960×1536，30 steps res_multistep，CFG 4.5，ImageSharpenKJ RCAS 0.75。
 *   2026-08-31 起不再手写 workflow——直接复用生产构建器
 *   routes/anima/workflows.js 的 buildWorkflow（模型/参数/TeaCache/RCAS
 *   全部由项目单一事实源决定），TeaCache 默认 rel_l1_thresh=0.08（生产默认），
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
 *   COMFY_HOST     默认 http://127.0.0.1:8188
 *   COMFY_OUTPUT   默认 <AI 工作区>/ComfyUI/output
 *   AI_WORKSPACE_ROOT 默认 <项目根>/../AI（参考图根目录所在）
 */

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const crypto: typeof import('crypto') = require('crypto');
const { compress }: typeof import('./precompress.js') = require('./precompress.js');

const HOST = process.env.COMFY_HOST || 'http://127.0.0.1:8188';
const ROOT = path.resolve(__dirname, '..', '..');
const VIEW_FILE = path.join(ROOT, 'data', 'character-reference-view.json');
const STANDARDS_FILE = path.join(ROOT, 'data', 'character-reference-standards.json');
const REF_ROOT = process.env.AI_WORKSPACE_ROOT
  ? path.join(process.env.AI_WORKSPACE_ROOT, 'CharacterReferences')
  : path.resolve(ROOT, '..', 'AI', 'CharacterReferences');
const COMFY_OUTPUT = process.env.COMFY_OUTPUT || path.resolve(REF_ROOT, '..', 'ComfyUI', 'output');

// 负面词：基础词照抄项目前端权威来源 promptBuilderStore.ts NEGATIVE_DEFAULT，
// 防双子镜像追加词照抄 src/utils/sdRequest.ts DUAL_SAFETY_NEGATIVE（identical twins /
// merged bodies / fused limbs / duplicate person / cloned face / swapped hair），
// 防掀裙追加自然语言负面（2026-08-31：back 视角曾翻车成掀裙）。
const NEGATIVE =
  'worst quality, low quality, lowres, bad anatomy, bad hands, extra fingers, fewer fingers, missing fingers, extra limbs, missing limbs, deformed, mutilated, disfigured, bad proportions, duplicate, cloned face, ugly, blurry, jpeg artifacts, watermark, text, signature, logo, monochrome, grayscale, frame, border, username, artist name, bad_prompt, bad_prompt_version2, bad-hands-5, ng_deepnegative_v1_75t, scenery, cityscape, complex_background, identical twins, merged bodies, fused limbs, duplicate person, swapped hair, extra person, skirt lift, lifted skirt, skirt blown up';

// 视角模板（2026-08-31 修订）：side/back 曾翻车为双子镜像 / 掀裙，
// 靠负面词压制（见 NEGATIVE，照抄项目现成词表），视角词保持标准。
const VIEWS: any = {
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
  --no-teacache    关闭 TeaCache 加速（默认开：rel_l1_thresh=0.08，照抄生产管线默认）
  --tea-thresh=N   自定义 TeaCache rel_l1_thresh（0 = 关闭；生产默认 0.08）

环境变量: COMFY_HOST / COMFY_OUTPUT / AI_WORKSPACE_ROOT
依赖: ComfyUI http://127.0.0.1:8188（--disable-smart-memory）`);
  process.exit(0);
}
function pick(flag: any, splitter: any = ',') {
  const hit = args.find((a: any) => a.startsWith(flag + '='));
  if (!hit) return null;
  return hit.slice(flag.length + 1).split(splitter).map((s: any) => s.trim()).filter(Boolean);
}
const charsFilter = pick('--chars');
const outfitsFilter = pick('--outfits');
const viewsFilter = pick('--views');
const all = args.includes('--all');
const dryRun = args.includes('--dry-run');
const limit = Number((args.find((a: any) => a.startsWith('--limit=')) || '').split('=')[1] || 0) || null;
const seedShift = Number((args.find((a: any) => a.startsWith('--seed-shift=')) || '').split('=')[1] || 0) || 0;
// TeaCache 加速（2026-08-31 接入）：默认关？不——与生产管线一致默认开。
// 参数照抄 routes/anima/workflows.js 现成契约：rel_l1_thresh=0.08（生产默认 teaCacheThresh || 0.08），
// start_percent 0 / end_percent 1 / cache_device cuda。res_multistep 必须保持
// （docs 168 行：TeaCache 在 SDE 采样器下失效，1.90x vs 1.04x）。
// 需要对照画质可 --no-teacache 关闭，或 --tea-thresh=<值> 调档（0 = 关闭）。
const teaThreshArg = args.find((a: any) => a.startsWith('--tea-thresh='));
const teaThresh = teaThreshArg ? Number(teaThreshArg.split('=')[1]) : (args.includes('--no-teacache') ? 0 : 0.08);

// ── 工具 ─────────────────────────────────────────────────────────────────────
function stableSeed(charId: any, outfitId: any, view: any) {
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
function buildPrompt(identityProse: any, identity: any, outfitProse: any, outfit: any, viewTags: any) {
  return `score_7, score_6, masterpiece, best quality, ${identityProse}, ${outfitProse}, ${identity}, ${outfit}, ${viewTags}, ${SHEET}`;
}

// ── 工作流：复用生产渲染管线构建器，不再平行实现 ────────────────────────────
// 2026-08-31 教训：此前手写一份等价 workflow JSON 属「平行实现」，
// 被用户点名「项目里都有现成的，为什么自己造」。现改为直接 require 生产
// routes/anima/workflows.js 的 buildWorkflow——UNET/CLIP/VAE/KSampler/TeaCache/
// RCAS 全部由项目单一事实源（anima-model-catalog + anima-generation-contract +
// 生产节点图）决定。脚本只保留两处脚本专属：
//   1) SaveImage filename_prefix（design_batch_tmp，避免与正式管线输出混名）
//   2) 分辨率 960×1536（三视图竖版比例；属 anima 家族官方推荐尺寸集，
//      anima-model-catalog 中 base/2.9b/yume 均列出 960x1536）
const prodBuildWorkflow = require(path.join(ROOT, 'routes', 'anima', 'workflows.js')).buildWorkflow;
const { MODELS } = require(path.join(ROOT, 'server', 'anima-model-catalog.js'));
// 2026-09-06：按用户指定参考库本轮统一切 MiaoMiao Harem Anima v1.6（TeaCache 生产默认不变）。
const MODEL_ID = 'anima-miaomiao-v1.6';
const MODEL = MODELS[MODEL_ID];

function buildWorkflow(text: any, seed: any) {
  const wf = prodBuildWorkflow({
    modelId: MODEL_ID,
    prompt: text,
    negative: NEGATIVE,
    width: 960,
    height: 1536,
    seed,
    steps: MODEL.steps,
    cfg: MODEL.cfg,
    sampler: MODEL.sampler,
    scheduler: MODEL.scheduler,
    teaCache: teaThresh > 0,
    teaCacheThresh: teaThresh || 0.08,
  });
  // 输出文件名走本脚本专用前缀（生产构建器用 OUTPUT_FILENAME_PREFIX）
  wf['10'].inputs.filename_prefix = 'design_batch_tmp';
  return wf;
}

async function comfyAlive() {
  try {
    const resp = await fetch(HOST + '/system_stats', { signal: AbortSignal.timeout(5000) });
    return resp.ok;
  } catch {
    return false;
  }
}

/** 提交工作流并等待完成；成功后返回 ComfyUI 保存的输出文件名（精确取自 history，不扫目录）。 */
async function submitAndWait(text: string, seed: number) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let resp;
    try {
      resp = await fetch(HOST + '/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: buildWorkflow(text, seed) }),
      });
    } catch {
      log('  submit 网络错误，重试');
      continue;
    }
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      log('  submit fail: ' + JSON.stringify(data).slice(0, 120));
      continue;
    }
    const id = data.prompt_id;
    for (let i = 0; i < 240; i++) {
      await new Promise<any>((r: any) => setTimeout(r, 2000));
      try {
        const h = await (await fetch(HOST + '/history/' + id)).json();
        const entry = h[id];
        if (!entry) continue;
        if (entry.status && entry.status.completed) {
          const images = entry.outputs && entry.outputs['10'] && entry.outputs['10'].images;
          if (images && images.length) {
            const img = images[0];
            return img.subfolder ? path.join(img.subfolder, img.filename) : img.filename;
          }
          return null;
        }
        if (entry.status && entry.status.status_str === 'error') {
          log('  渲染错误，重试');
          break;
        }
      } catch {
        /* 轮询瞬时错误忽略 */
      }
    }
  }
  return null;
}

/** 把 ComfyUI 输出移到参考图目录（同盘 rename 原子移动，避开 unlink 钩子）。 */
function moveOutput(relFile: string, destDir: string, destFile: string) {
  const src = path.join(COMFY_OUTPUT, relFile);
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, destFile);
  try {
    fs.renameSync(src, dest);
  } catch {
    try {
      fs.copyFileSync(src, dest); // 兜底：rename 失败则复制（源文件留待手工清理）
    } catch (e) {
      log('  moveOutput 失败: ' + runtimeErrorMessage(e));
      return false;
    }
  }
  return true;
}

/**
 * 目标文件在参考图根下的相对路径。
 * 2026-08-31 修复：原实现按「磁盘上是否存在 <charId>/<outfitId> 目录」决定输出位置——
 * 尚无独立目录的非默认服装（如 silk_sleepwear）会被错误落到角色根目录，
 * 覆盖该角色的默认服装设计图（11 张被覆盖事故）。改为按 isDefault 判定：
 * 默认服装 → 角色根；非默认 → <角色>/<服装>/（目录由调用方确保存在）。
 */
function targetRelPath(charId: string, outfitId: string, view: any, isDefault: boolean) {
  return isDefault
    ? path.join(charId, `ref_design_${view}.png`)
    : path.join(charId, outfitId, `ref_design_${view}.png`);
}

// ── 收集任务 ─────────────────────────────────────────────────────────────────
if (!fs.existsSync(VIEW_FILE)) fail('缺 data/character-reference-view.json');
if (!fs.existsSync(STANDARDS_FILE)) fail('缺 data/character-reference-standards.json');

const view = JSON.parse(fs.readFileSync(VIEW_FILE, 'utf8'));
const standards = JSON.parse(fs.readFileSync(STANDARDS_FILE, 'utf8'));
const stdByChar = new Map((standards.characters || []).map((c: any) => [c.id, c]));

const tasks: any[] = [];
const skipped = { existing: 0, missingTokens: 0 };

for (const profile of Object.values<any>(view)) {
  const charId = profile.characterId;
  if (charsFilter && !charsFilter.includes(charId)) continue;
  const stdChar: any = stdByChar.get(charId);
  const identityProse = (stdChar && stdChar.identityProse || '').trim();
  const identity = (stdChar && (stdChar.identityTokens || []).join(', ')).trim();
  for (const o of profile.outfits || []) {
    if (outfitsFilter && !outfitsFilter.includes(o.outfitId)) continue;
    const stdOutfit = stdChar && stdChar.outfits && stdChar.outfits.find((x: any) => x.id === o.outfitId);
    const outfitProse = (stdOutfit && stdOutfit.prose || '').trim();
    const outfitTokens = (stdOutfit && (stdOutfit.tokens || []).join(', ')).trim();
    for (const ref of o.references || []) {
      if (!ref.id || !String(ref.id).startsWith('ref_design_')) continue;
      const viewName = ref.id.replace('ref_design_', '');
      if (viewsFilter && !viewsFilter.includes(viewName)) continue;
      const needRun = all || (ref.pending === true && !ref.url);
      const rel = targetRelPath(charId, o.outfitId, viewName, o.isDefault === true);
      const abs = path.join(REF_ROOT, rel);
      if (!needRun && fs.existsSync(abs)) { skipped.existing++; continue; }
      if (!identityProse || !outfitProse) { skipped.missingTokens++; continue; }
      // 非默认服装输出到 <角色>/<服装>/ 子目录：目录不存在则创建，避免落回角色根覆盖默认图。
      if (o.isDefault !== true) { try { fs.mkdirSync(path.dirname(abs), { recursive: true }); } catch (error) {} }
      tasks.push({ charId, outfitId: o.outfitId, viewName, identityProse, identity, outfitProse, outfitTokens, rel, abs });
    }
  }
}

if (dryRun) {
  log(`[dry-run] 待跑 ${tasks.length} 张（跳过：已存在 ${skipped.existing} / 缺 token ${skipped.missingTokens}）`);
  tasks.slice(0, limit || 20).forEach((t: any, i: any) =>
    log(`  ${i + 1}. ${t.charId}/${t.outfitId}/${t.viewName} -> ${t.rel}`));
  process.exit(0);
}

async function main() {
  if (!(await comfyAlive())) {
    fail(`ComfyUI 不可达（${HOST}）——请先启动 ComfyUI（--disable-smart-memory）再跑`);
  }
if (!tasks.length) {
  log('没有待跑任务（全部已完成或已被过滤），继续执行 view.json 回填后退出');
}

log(`待跑 ${tasks.length} 张（跳过：已存在 ${skipped.existing} / 缺 token ${skipped.missingTokens}）`);
const slice = limit ? tasks.slice(0, limit) : tasks;
let ok = 0, failCount = 0;

for (const t of slice) {
  const seed = stableSeed(t.charId, t.outfitId, t.viewName);
  const text = buildPrompt(t.identityProse, t.identity, t.outfitProse, t.outfitTokens, VIEWS[t.viewName]);
  log(`▶ ${t.charId}/${t.outfitId}/${t.viewName} (seed ${seed})`);
  const outFile = await submitAndWait(text, seed);
  if (!outFile) {
    log('  ✗ 生成失败');
    failCount++;
    continue;
  }
  const destDir = path.dirname(t.abs);
  if (moveOutput(outFile, destDir, path.basename(t.abs))) {
    ok++;
    log(`  ✓ 已存 ${path.relative(REF_ROOT, t.abs)}`);
  } else {
    log(`  ✗ 未找到输出文件（${outFile}）`);
    failCount++;
  }
}
log(`=== 完成: 本次 ${slice.length} 成功 ${ok} 失败 ${failCount} ===`);

// ── 后处理：view.json pending→url + 重建预压缩产物 ─────────────────────────
try {
  let filled = 0;
  for (const profile of Object.values<any>(view)) {
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
        const hit = candidates.find((c: any) => fs.existsSync(path.join(REF_ROOT, c.replace(/^\/character-references\//, ''))));
        if (hit) {
          ref.url = hit;
          delete ref.pending;
          filled++;
        }
      }
    }
  }
  if (filled) {
    fs.writeFileSync(VIEW_FILE, JSON.stringify(view, null, 2) + '\n', 'utf8');
    const c: any = compress(VIEW_FILE);
    log(`view.json 已更新: ${filled} 个 design 条目填 url，预压缩产物已重建（br ${c.brotli}B / gz ${c.gzip}B）`);
  } else {
    log('view.json 无新增可填条目');
  }
} catch (e) {
  log('view.json 更新失败: ' + runtimeErrorMessage(e));
}
}

main().catch((e: any) => fail(e.stack || e.message));
