#!/usr/bin/env node
'use strict';

/**
 * Real sample-candidate generation for the artist / popular-character /
 * latest-LoRA showcase refresh round.
 *
 * Writes ONLY into an isolated review directory (default
 * AI/Reviews/ShowcaseRefresh/2026-08-12_artist_popular_latest-lora) and NEVER
 * into the public SceneShowcase directory. Every image records full provenance
 * in an atomically-updated manifest; already-valid images are reused on resume.
 * Visual acceptance is a separate manual review step - this script never claims
 * a visual pass.
 *
 * Since the 2026-08-12 main-thread visual review, keys listed in
 * REVIEW_OVERRIDES are re-planned as attempt-2 candidates with minimal prompt
 * reinforcement / negative additions / deterministic seed offsets / explicit
 * camera framing. Original attempt-1 images are never overwritten; attempt-2
 * files are written beside them as `<key>_attempt-2.png` and recorded with
 * `attempt`, `supersedes` and `reviewReason` so both attempts can be compared.
 *
 * A third review round (attempt-3) re-runs the keys listed in
 * ATTEMPT_3_OVERRIDES that still failed visual acceptance. They build on the
 * same production pipeline, write beside prior attempts as
 * `<key>_attempt-3.png`, and set `supersedes` to the key's latest prior
 * attempt (attempt-2 when that key has one, otherwise attempt-1) so the
 * re-review chain stays readable. `--attempt 3` filters the plan to only
 * attempt-3 candidates, so a re-run never regenerates attempt-1/2.
 *
 * HISTORICAL NOTE (2026-08-12 correction): the attempt-2/3 mole rules for
 * 四季夏目 pinned "mole under left eye / mole on left cheek" as if they were
 * the correct contract. Visual review of assets/characters/natsume-official.webp
 * proved that was a main-thread misjudgement: the beauty mark sits under the
 * character's OWN right eye (viewer-left in a front-facing pose). Those
 * attempt-2/3 records, prompts and images are deliberately preserved verbatim
 * so the already-generated history stays consistent - they are historical
 * misjudgements, NOT the current contract. A fourth review round
 * (ATTEMPT_4_OVERRIDES) re-runs only the two keys that still fail acceptance
 * with the corrected mole side and 960x1536 coverage:
 *   latest-lora:natsume:sd:fullbody     (supersedes attempt-3)
 *   latest-lora:natsume:anima:fullbody  (supersedes attempt-2)
 * `--attempt 4` filters the plan to exactly those two candidates.
 *
 * Prompts are assembled exclusively through the production prompt pipeline
 * (src/utils/promptCompiler.ts / promptPolicy.ts / popularContent.ts) and the
 * production gateway API, so no ad-hoc prompt variant is introduced here.
 */

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const crypto: typeof import('crypto') = require('crypto');

const promptPolicy: typeof import('../../src/utils/promptPolicy.ts') = require('../../src/utils/promptPolicy.ts');
const promptCompiler: typeof import('../../src/utils/promptCompiler.ts') = require('../../src/utils/promptCompiler.ts');
const popularContent: typeof import('../../src/utils/popularContent.ts') = require('../../src/utils/popularContent.ts');
const artistCatalog: typeof import('../../src/config/artistStyleCatalog.ts') = require('../../src/config/artistStyleCatalog.ts');
const { artistStyleProse, artistTagsForEngine }: typeof import('../../src/config/artistStyles.ts') = require('../../src/config/artistStyles.ts');
const kreaRecipes: typeof import('../../src/config/kreaStyleRecipes.ts') = require('../../src/config/kreaStyleRecipes.ts');
const qualityPromptContract: typeof import('./quality-prompt-contract.js') = require('./quality-prompt-contract.js');

const genConst: any = (require('../../routes/generation.js') as typeof import('../../routes/generation.js')).constants;
const animaConst = (require('../../routes/anima.js') as typeof import('../../routes/anima.js')).constants;

const ROOT = path.resolve(__dirname, '..', '..');
const AI_ROOT = path.resolve(ROOT, '..', 'AI');
const presets: typeof import('../../data/presets.json') = require('../../data/presets.json');
const popularData: unknown = readJson(path.join(ROOT, 'data', 'popular-characters.json'));
const blueprintData: unknown = readJson(path.join(ROOT, 'data', 'scene-blueprints.json'));
const loraData: typeof import('../../data/loras.json') = require('../../data/loras.json');

const { createPromptPlan, renderPromptPlan } = promptCompiler;
const {
  assembleNegative, formatPromptForEngine, resolveModelProfile, profileRatingTag,
} = promptPolicy;

const DEFAULT_OUTPUT = path.join(AI_ROOT, 'Reviews', 'ShowcaseRefresh', '2026-08-12_artist_popular_latest-lora');
const SCENE_SHOWCASE_DIR = path.resolve(AI_ROOT, 'SceneShowcase');
const MANIFEST_NAME = 'generation-manifest.json';
const REVIEW_INDEX_NAME = 'review-index.json';
const CONTACT_SHEET_NAME = 'contact-sheet.html';

const WAI_PROFILE_ID = 'wai_illustrious_v17';
const WAI_MODEL_ID = 'waiIllustriousSDXL_v170';
const WAI_CHECKPOINT = genConst.CHECKPOINT;
const ANIMA_BASE_ID = 'anima-base-v1.0';
const ANIMA_AESTHETIC_ID = 'anima-aesthetic-v1.1';
const KREA_MODEL_ID = 'krea2-turbo-fp8';
const POPULAR_BLUEPRINT_ID = ''; // 已废弃：popular 批次按角色取专属原型场景（2026-08-14）
const DEFAULT_LORA_STRENGTH = 0.85;

// Studio identity line mirror of src/stores/promptBuilderStore.ts CHAR_PROMPT.
// A contract sentinel (test-showcase-candidate-contract.js) pins these strings
// against the store source so they cannot drift.
// 2026-09-05 审计 P1-05：natsume 行同步 store 的 52ed8a39 版（对齐自训 LoRA 标准特征），
// 此前脚本仍停留在旧词组（very_long_black_hair/golden_yellow_eyes/two_red_hairclips/no_hair_ribbon）。
const STUDIO_CHAR_PROMPT: any = Object.freeze({
  nene: '1girl, solo, ayachi_nene, white_hair, very_long_hair, low_twintails, purple_eyes, ahoge, pink_hair_ribbons',
  natsume: '1girl, solo, shiki_natsume, black_hair, very_long_hair, yellow_eyes, mole_under_eye, hairclip',
});

// Neutral adult-female subject unrelated to the studio LoRA characters. Only
// the artist tag varies across the artist batch (same seed, same WAI params).
const ARTIST_NEUTRAL_SUBJECT = Object.freeze({
  identity: '1girl, solo, long_hair, brown_hair, amber_eyes, looking_at_viewer',
  controls: ['casual_clothes', 'white_shirt', 'open_jacket', 'city_street', 'outdoors', 'day', 'depth_of_field'],
});

/**
 * Review overrides from the main thread's visual pass (2026-08-12). Each entry
 * turns the attempt-1 candidate into a deterministic attempt-2: minimal prompt
 * reinforcement, negative additions, optional seed offset (0 = keep seed) and
 * optional explicit camera framing. Positive/negative tokens are applied by the
 * engine-specific formatter inside the build functions, keeping the Anima
 * space contract and the WAI raw-tag contract intact.
 *
 * HISTORICAL NOTE: the natsume anima closeup entry below ("痣必须在左眼下",
 * promptAppend "mole under left eye") encodes the 2026-08-12 main-thread
 * misjudgement about the mole side. It is kept verbatim so the attempt-2 record
 * matches the already-generated history; see ATTEMPT_4_OVERRIDES for the
 * corrected contract (character's own right eye / viewer-left cheek).
 */
const REVIEW_OVERRIDES: any = Object.freeze({
  'artist:bunbun': {
    reviewReason: '与 baseline 太接近且服装纽扣崩；换 seed + WAI 权重 tag (bunbun:1.2)，negative 压制纽扣/扣具',
    seedOffset: 1,
    artistTag: '(bunbun:1.2)',
    negativeAppend: ['malformed buttons', 'clothing fasteners'],
  },
  'artist:nardack': {
    reviewReason: '颈部白色光斑与背包带断裂；换 seed + 权重 tag (nardack:1.1)，negative 压制光斑/断带',
    seedOffset: 2,
    artistTag: '(nardack:1.1)',
    negativeAppend: ['abnormal light spot on neck', 'broken bag strap'],
  },
  'popular:emilia_rezero': {
    reviewReason: '默认白紫战袍而非普通蓝紫裙；强化 white/lilac dress 与紫色花饰',
    seedOffset: 3,
    promptAppend: ['white dress', 'lilac dress', 'purple flower ornament', 'brooch', 'long sleeves'],
    negativeAppend: ['casual dress', 'blue dress'],
  },
  'popular:hatsune_miku': {
    reviewReason: '经典 V2 服装缺失；强化 sleeveless/黑百褶裙/黑高筒靴/发饰/青绿领带',
    seedOffset: 4,
    promptAppend: ['sleeveless', 'detached black sleeves', 'black pleated skirt', 'black thighhigh boots', 'futuristic hair ornaments', 'teal necktie'],
    negativeAppend: ['short sleeves', 'white socks', 'red bow', 'blue skirt'],
  },
  'popular:misaka_mikoto': {
    reviewReason: '黄毛衣马甲与常盘台校服特征缺失；强化 sweater vest/hairpin/细微电光',
    seedOffset: 5,
    promptAppend: ['yellow sweater vest', 'tokidai school uniform', 'hairpin', 'subtle electricity sparks'],
    negativeAppend: ['bare white shirt only', 'missing sweater vest'],
  },
  'popular:sakurajima_mai': {
    reviewReason: '发色偏差；强化纯黑发 + 白兔发夹',
    seedOffset: 6,
    promptAppend: ['solid raven-black hair', 'white bunny hair clip'],
    negativeAppend: ['blonde hair', 'brown hair', 'two-tone hair', 'inner-dyed hair'],
  },
  'popular:tokisaki_kurumi': {
    reviewReason: '异色瞳/时钟瞳孔与绯黑哥特礼服缺失；强化 heterochromia + clock motifs',
    seedOffset: 7,
    promptAppend: ['heterochromia', 'left eye golden clock-face pupil', 'right eye red', 'crimson-and-black gothic astral dress', 'clock motifs'],
    negativeAppend: ['both red eyes', 'plain black dress'],
  },
  'popular:yukinoshita_yukino': {
    reviewReason: '发色偏差；强化纯黑长发',
    seedOffset: 8,
    promptAppend: ['pure solid black long hair'],
    negativeAppend: ['blonde hair', 'brown hair', 'two-tone hair', 'inner color streaks'],
  },
  'popular:yuzuriha_inori': {
    reviewReason: '默认 funeral_parade 被渲染成白色系；按 data red_dress 词强化标志性红衣（红金鱼裙/战斗连体衣）',
    seedOffset: 9,
    promptAppend: ['red_dress', 'layered_skirt', 'long_sleeves', 'red dress', 'red combat bodysuit'],
    negativeAppend: ['white sleeveless shirt', 'casual shorts'],
  },
  'latest-lora:nene:sd:closeup': {
    reviewReason: '标准 bust-up 而非 macro；完整头顶 ahoge/粉发带/领口',
    seedOffset: 11,
    camera: 'bust',
    promptAppend: ['collar'],
    negativeAppend: ['extreme close-up', 'cropped head'],
  },
  'latest-lora:nene:sd:fullbody': {
    reviewReason: '真正帽尖到鞋底 full body standing，不能只到大腿',
    seedOffset: 12,
    camera: 'full_body',
    promptAppend: ['standing'],
    negativeAppend: ['cropped legs', 'cowboy shot', 'kneeling', 'sitting'],
  },
  'latest-lora:natsume:sd:fullbody': {
    reviewReason: '站姿完整，两枚红发夹并展示鞋',
    seedOffset: 13,
    camera: 'full_body',
    promptAppend: ['standing', 'two red hairclips', 'shoes'],
    negativeAppend: ['kneeling', 'sitting', 'cropped feet', 'missing hairclips'],
  },
  'latest-lora:natsume:anima:closeup': {
    // 2026-08-12 历史误判（见上方 HISTORICAL NOTE）：夏目痣实际在人物自身右眼下
    // （正面图为观察者左侧），此"左眼痣"规则仅保留以匹配已生成历史，不是正确契约。
    reviewReason: '痣必须在左眼下，不能右眼；换 seed + 显式 mole under left eye',
    seedOffset: 14,
    promptAppend: ['mole under left eye'],
    negativeAppend: ['mole under right eye'],
  },
  'latest-lora:natsume:anima:fullbody': {
    reviewReason: '保留优秀旗袍全身，去掉额外白发带；同 seed 加 negative hair ribbon/white ribbon/hairband',
    seedOffset: 0,
    negativeAppend: ['hair ribbon', 'white ribbon', 'hairband'],
  },
});

/**
 * Third review round (attempt-3) from the 2026-08-12 main thread: the six keys
 * below still failed the attempt-2 visual pass. Each is a deterministic
 * attempt-3 candidate that builds on the production pipeline with stronger
 * prompt reinforcement, extra negatives and a fresh seed. `supersedes` points
 * at the key's attempt-2 when that key has one, otherwise at its latest prior
 * attempt (attempt-1). Attempt-1/2 records and images are never touched.
 *
 * HISTORICAL NOTE: the three natsume entries below reinforce "mole under left
 * eye / mole on left cheek" - a 2026-08-12 main-thread misjudgement kept
 * verbatim so the attempt-3 records match the already-generated history. The
 * corrected contract (character's own right eye / viewer-left cheek) lives in
 * ATTEMPT_4_OVERRIDES.
 */
const ATTEMPT_3_OVERRIDES: any = Object.freeze({
  'artist:so-bin': {
    reviewReason: '与 baseline 区分不足；保持 WAI 原始画师 tag 兼容，(so-bin:1.3) 权重强化 + 暗黑厚涂笔触，场景仍为白衬衫+敞开外套+白天城市，换 seed',
    seedOffset: 31,
    artistTag: '(so-bin:1.3)',
    promptAppend: ['dramatic dark shadows', 'heavy painterly brushwork', 'dark fantasy oil-paint texture'],
    negativeAppend: ['night', 'night scene', 'dark night'],
  },
  'popular:makima': {
    reviewReason: '缺同心圆圈圈眼与后背单麻花辫；强化 golden/ringed eyes + single back braid + 黑西裤，negative 压制红瞳/散发/百褶裙/呆毛，换 seed',
    seedOffset: 32,
    promptAppend: ['golden eyes', 'ringed eyes', 'concentric circles in eyes', 'single long back braid', 'black suit trousers'],
    negativeAppend: ['solid red eyes', 'loose untied hair', 'pleated skirt', 'ahoge'],
  },
  'latest-lora:nene:sd:fullbody': {
    reviewReason: '两次均裁到大腿；强化 full body/standing/feet/shoes/full length portrait，negative 压制大腿裁切与缺脚，保持 832x1216，换 seed',
    seedOffset: 33,
    camera: 'full_body',
    promptAppend: ['full body', 'standing', 'feet', 'shoes', 'full length portrait'],
    negativeAppend: ['cropped legs', 'cowboy shot', 'thigh cut-off', 'missing feet', 'cropped feet'],
  },
  'latest-lora:natsume:sd:closeup': {
    // 2026-08-12 历史误判（见上方 HISTORICAL NOTE）：夏目痣在人物自身右眼下，
    // 此处"左眼/左颊痣"规则仅保留以匹配已生成历史，不是正确契约。
    reviewReason: '痣落在错误眼下；强化 mole under left eye/mole on left cheek/two red hairclips，negative 压制右眼/右颊痣，换 seed',
    seedOffset: 34,
    promptAppend: ['mole under left eye', 'mole on left cheek', 'two red hairclips'],
    negativeAppend: ['mole under right eye', 'mole on right cheek'],
  },
  'latest-lora:natsume:sd:fullbody': {
    // 2026-08-12 历史误判（见上方 HISTORICAL NOTE）：夏目痣在人物自身右眼下，
    // 此处"左眼/左颊痣"规则仅保留以匹配已生成历史，不是正确契约。
    reviewReason: 'attempt-2 缺痣与发夹；强化左眼痣/左颊痣/两枚红发夹 + full body 站姿露鞋，negative 压制缺痣/缺发夹/跪坐/裁脚，换 seed',
    seedOffset: 35,
    camera: 'full_body',
    promptAppend: ['mole under left eye', 'mole on left cheek', 'two red hairclips', 'full body', 'standing', 'shoes'],
    negativeAppend: ['mole under right eye', 'mole on right cheek', 'missing mole', 'missing hairclips', 'kneeling', 'sitting', 'cropped feet'],
  },
  'latest-lora:natsume:anima:closeup': {
    // 2026-08-12 历史误判（见上方 HISTORICAL NOTE）：夏目痣在人物自身右眼下，
    // 此处"左眼/左颊痣"规则仅保留以匹配已生成历史，不是正确契约。
    reviewReason: '两次痣均错误；Anima 空格契约下强化 mole under left eye/mole on left cheek/two red hairclips，negative 压制右眼/右颊痣，换 seed',
    seedOffset: 36,
    promptAppend: ['mole under left eye', 'mole on left cheek', 'two red hairclips'],
    negativeAppend: ['mole under right eye', 'mole on right cheek'],
  },
});

/**
 * Fourth review round (attempt-4) from the 2026-08-12 main thread. Only the two
 * natsume fullbody keys below still failed acceptance after the prior rounds
 * (the Anima fullbody has no attempt-3, so its chain stops at attempt-2). They
 * re-run the production pipeline with the CORRECTED mole contract confirmed
 * against assets/characters/natsume-official.webp: 四季夏目's beauty mark sits
 * under the character's OWN right eye (viewer-left in a front-facing pose).
 * `mole under right eye` is paired with `viewer-left cheek beauty mark` to
 * remove mirror ambiguity; negatives suppress the wrong side (character-left /
 * viewer-right), double moles, a missing mole, missing/single hairclips, white
 * or extra hair ribbons, kneeling and cropped feet. Coverage rises to
 * 960x1536 (64-aligned, within the WAI bounds and under the Anima 1.5M area
 * cap) to keep facial micro-features legible at full-body scale. WAI keeps the
 * raw tag / LoRA contract; Anima keeps the score_7 + res_multistep/simple space
 * contract. `supersedes` points at the key's latest prior attempt, and the seed
 * is fresh vs every prior attempt for that key.
 */
const ATTEMPT_4_OVERRIDES: any = Object.freeze({
  'latest-lora:natsume:sd:fullbody': {
    reviewReason: '2026-08-12 历史误判修正：夏目痣在人物自身右眼下（正面图为观察者左侧）；强化 mole under right eye + viewer-left cheek beauty mark + 两枚红发夹，无额外发带，完整旗袍站姿含鞋；negative 压制人物左眼/双侧/缺痣/缺发夹/白发带/跪坐/裁脚；960x1536 提升全身脸部微特征清晰度，换 seed',
    seedOffset: 41,
    width: 960,
    height: 1536,
    camera: 'full_body',
    promptAppend: ['mole under right eye', 'viewer-left cheek beauty mark', 'two red hairclips', 'full body', 'standing', 'shoes'],
    negativeAppend: ['mole under left eye', 'mole on left cheek', 'beauty mark on right cheek', 'mole on both cheeks', 'moles under both eyes', 'missing mole', 'missing hairclips', 'single hairclip', 'hair ribbon', 'white ribbon', 'hairband', 'kneeling', 'sitting', 'cropped feet'],
  },
  'latest-lora:natsume:anima:fullbody': {
    reviewReason: '2026-08-12 历史误判修正：夏目痣在人物自身右眼下（正面图为观察者左侧）；Anima 空格契约下强化 mole under right eye + viewer-left cheek beauty mark + two red hairclips，无额外发带，完整旗袍站姿含鞋；negative 压制人物左眼/双侧/缺痣/缺发夹/白发带/跪坐/裁脚；960x1536 提升全身脸部微特征清晰度，换 seed',
    seedOffset: 42,
    width: 960,
    height: 1536,
    camera: 'full_body',
    promptAppend: ['mole under right eye', 'viewer-left cheek beauty mark', 'two red hairclips', 'full body', 'standing', 'shoes'],
    negativeAppend: ['mole under left eye', 'mole on left cheek', 'beauty mark on right cheek', 'mole on both cheeks', 'moles under both eyes', 'missing mole', 'missing hairclips', 'single hairclip', 'hair ribbon', 'white ribbon', 'hairband', 'kneeling', 'sitting', 'cropped feet'],
  },
});

// ── helpers ────────────────────────────────────────────────────────────────

function argument(name: any, fallback: any = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
function splitList(value: any) { return String(value || '').split(',').map((item: any) => item.trim()).filter(Boolean); }
function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`读取 ${path.relative(ROOT, file)} 失败：${error instanceof Error ? error.message : String(error)}`);
  }
}
function stableSeed(key: any) {
  const digest = crypto.createHash('sha256').update(`showcase-candidates-2026-08-12:${key}`).digest();
  return digest.readUInt32BE(0) & 0x7fffffff;
}
function writeJsonAtomic(file: any, value: any) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}
function shouldReuse(record: any, imagePath: any, force: any) {
  if (force || !record || record.status !== 'succeeded' || !record.image) return false;
  if (!fs.existsSync(imagePath)) return false;
  try { return fs.statSync(imagePath).size > 1000; } catch (error) { return false; }
}
function profileById(id: any): any {
  const profile = (presets.model_profiles || []).find((item: any) => item.id === id);
  if (!profile) throw new Error(`presets.json missing profile ${id}`);
  return profile;
}
function loraMetaById(id: any) {
  const meta = (loraData || []).find((item: any) => item.id === id);
  if (!meta) throw new Error(`loras.json missing LoRA ${id}`);
  return meta;
}
function appendNegative(negative: any, tokens: any, engine: any, profile: any) {
  if (!tokens || !tokens.length) return negative;
  const extra = engine === 'anima' && profile
    ? formatPromptForEngine(tokens.join(', '), 'anima', profile.exact_tokens, profile.exact_prefixes)
    : tokens.join(', ');
  return [negative, extra].filter(Boolean).join(', ');
}

/**
 * Guard against ever writing into the public showcase directory. Both the
 * default and any explicit --output are validated at plan time and at write
 * time. The realpath resolution keeps `..`-style tricks from bypassing it.
 */
function assertNotShowcase(outputDir: any) {
  const resolved = path.resolve(outputDir);
  const candidates = [
    path.resolve(SCENE_SHOWCASE_DIR),
    path.resolve(AI_ROOT, 'SceneShowcase', '2026-07-22_v14'),
  ];
  for (const base of candidates) {
    if (resolved === base || resolved.startsWith(base + path.sep)) {
      throw new Error(`refusing to write candidates into the public showcase directory: ${outputDir}`);
    }
  }
  return resolved;
}

// ── image mechanical inspection (magic + dimensions, no visual judgement) ───

function pngInfo(buffer: any) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(sig)) return null;
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { mime: 'image/png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}
function jpegInfo(buffer: any) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) break;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return { mime: 'image/jpeg', width, height };
    }
    offset += 2 + length;
  }
  return { mime: 'image/jpeg', width: 0, height: 0 };
}
function webpInfo(buffer: any) {
  if (buffer.length < 30 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') return null;
  const tag = buffer.toString('ascii', 12, 16);
  if (tag === 'VP8X') {
    const width = 1 + buffer.readUIntLE(24, 3);
    const height = 1 + buffer.readUIntLE(27, 3);
    return { mime: 'image/webp', width, height };
  }
  if (tag === 'VP8 ' && buffer.length >= 30) {
    return { mime: 'image/webp', width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (tag === 'VP8L' && buffer.length >= 25) {
    const bits = buffer.readUInt32LE(21);
    return { mime: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return { mime: 'image/webp', width: 0, height: 0 };
}
function imageInfo(buffer: any) {
  return pngInfo(buffer) || jpegInfo(buffer) || webpInfo(buffer) || null;
}

// ── prompt assembly (production pipeline only) ─────────────────────────────

function waiProfile() { return profileById(WAI_PROFILE_ID); }

function buildArtistPrompt(artistTag: any, override?: any) {
  const profile: any = waiProfile();
  const artists = override && override.artistTag
    ? [override.artistTag]
    : (artistTag ? [artistTag] : []);
  const plan = createPromptPlan({
    profile,
    identity: ARTIST_NEUTRAL_SUBJECT.identity,
    controls: [...ARTIST_NEUTRAL_SUBJECT.controls],
    artists,
    rating: profileRatingTag(profile, { rating: 'ALL' }),
  });
  const rendered = renderPromptPlan(plan, 'sd', profile);
  let prompt = rendered.prompt;
  if (override && override.promptAppend) {
    prompt = `${prompt}, ${override.promptAppend.join(', ')}`;
  }
  let negative = assembleNegative(profile, { rating: 'ALL' }, 'sd', { shot: 'medium' });
  negative = appendNegative(negative, override && override.negativeAppend, 'sd', null);
  return { prompt, negative };
}

// 双引擎画师 prompt：Anima 用 @artist 原生标签；Krea2 用自然语言风格短语。
function buildArtistPromptFor(engine: any, artistId: any) {
  if (engine === 'krea2') {
    const plan = createPromptPlan({
      subjectProse: 'A young adult woman with long brown hair and amber eyes',
      outfitProse: 'a white shirt under an open casual jacket',
      sceneProse: 'standing on a city street outdoors in the daytime',
      style: ['A polished anime key visual'],
      artistProse: artistId ? artistStyleProse([artistId]) : '',
      rating: 'safe',
    });
    const rendered = renderPromptPlan(plan, 'krea2', kreaProfile());
    return { prompt: rendered.prompt, negative: '' };
  }
  const base = resolveModelProfile(presets.model_profiles as any, ANIMA_AESTHETIC_ID, 'anima');
  const plan = createPromptPlan({
    profile: base,
    identity: ARTIST_NEUTRAL_SUBJECT.identity,
    controls: [...ARTIST_NEUTRAL_SUBJECT.controls],
    artists: artistId ? artistTagsForEngine([artistId], 'anima') : [],
    rating: profileRatingTag(base, { rating: 'ALL' }),
  });
  const rendered = renderPromptPlan(plan, 'anima', base);
  const negative = assembleNegative(base, { rating: 'ALL' }, 'anima', { shot: 'medium' });
  return { prompt: rendered.prompt, negative };
}

function buildStudioPrompt({ engine, characterId, composition, loraId, override }: any) {
  const charPrompt = STUDIO_CHAR_PROMPT[characterId];
  const loraMeta: any = loraId ? loraMetaById(loraId) : null;
  const closeup = composition === 'closeup';
  const scene = closeup
    ? { rating: 'ALL', prompt: 'close_up' }
    : {
        rating: 'ALL',
        prompt: characterId === 'nene' ? 'nene_witch_canonical, full_body' : 'natsume_official_qipao, full_body',
      };
  const activeLoras = {
    nene: engine === 'sd' ? genConst.LORAS.L_NENE_V18_WD14.file : loraId,
    natsume: engine === 'sd' ? genConst.LORAS.L_NAT_V18_WD14.file : loraId,
  };
  const controls = promptPolicy.characterControlTokens(scene, characterId, activeLoras);
  const camera = override && override.camera
    ? [override.camera]
    : (closeup ? ['close_up'] : ['full_body']);

  if (engine === 'sd') {
    const profile: any = waiProfile();
    const plan = createPromptPlan({
      profile,
      identity: charPrompt,
      controls,
      camera,
      rating: profileRatingTag(profile, scene),
    });
    const rendered = renderPromptPlan(plan, 'sd', profile);
    const loraTag = `<lora:${loraMeta.name}:${DEFAULT_LORA_STRENGTH}>`;
    let prompt = `${rendered.prompt}, ${loraTag}`;
    if (override && override.promptAppend) prompt = `${prompt}, ${override.promptAppend.join(', ')}`;
    let negative = assembleNegative(profile, scene, 'sd', { shot: closeup ? 'close' : 'wide' });
    negative = appendNegative(negative, override && override.negativeAppend, 'sd', null);
    return { prompt, negative };
  }

  // Anima: merge the LoRA prompt contract (exact tokens/prefixes) into the
  // base profile exactly like usePromptAssembly does at runtime.
  const base = profileById('anima_base_v10');
  const contract = loraMeta && loraMeta.prompt_contract
    ? { tokens: loraMeta.prompt_contract.exact_tokens || [], prefixes: loraMeta.prompt_contract.exact_prefixes || [] }
    : { tokens: [], prefixes: [] };
  const profile: any = Object.assign({}, base, {
    exact_tokens: [...new Set([...(base.exact_tokens || []), ...contract.tokens])],
    exact_prefixes: [...new Set([...(base.exact_prefixes || []), ...contract.prefixes])],
  });
  const plan = createPromptPlan({
    profile,
    identity: charPrompt,
    controls,
    camera,
    rating: profileRatingTag(profile, scene),
  });
  const rendered = renderPromptPlan(plan, 'anima', profile);
  let prompt = rendered.prompt;
  if (override && override.promptAppend) {
    prompt = `${prompt}, ${formatPromptForEngine(override.promptAppend.join(', '), 'anima', profile.exact_tokens, profile.exact_prefixes)}`;
  }
  let negative = assembleNegative(profile, scene, 'anima', { shot: closeup ? 'close' : 'wide' });
  negative = appendNegative(negative, override && override.negativeAppend, 'anima', profile);
  return { prompt, negative };
}

function buildPopularPrompt(character: any, blueprint: any, profile: any, override: any) {
  const outfit = popularContent.defaultOutfit(character);
  const decisions = popularContent.inferBlueprintDecisions(blueprint);
  const result = popularContent.buildPopularPromptPlan({
    character,
    outfit,
    blueprint,
    engine: 'anima',
    profile,
    adultEnabled: false,
    shot: decisions.shot,
    lighting: decisions.lighting,
    composition: decisions.composition,
  });
  if (!result) throw new Error(`popular prompt build failed for ${character.id}`);
  let prompt = result.prompt;
  if (override && override.promptAppend) {
    prompt = `${prompt}, ${formatPromptForEngine(override.promptAppend.join(', '), 'anima', profile && profile.exact_tokens, profile && profile.exact_prefixes)}`;
  }
  let negative = result.negative;
  negative = appendNegative(negative, override && override.negativeAppend, 'anima', profile);
  return { prompt, negative, outfit, decisions };
}

// ── batch planning ─────────────────────────────────────────────────────────

function artistBatch(seedBase: any) {
  const artists = [...artistCatalog.ARTIST_STYLE_OPTIONS];
  const size = waiProfile().size.match(/(\d+)\s*[x×]\s*(\d+)/i);
  const width = size ? Number(size[1]) : 1024;
  const height = size ? Number(size[2]) : 1344;
  const records: any[] = [];
  records.push({ key: 'no-artist', artistId: '', displayName: 'no-artist baseline' });
  artists.forEach((artist: any) => records.push({ key: artist.id, artistId: artist.id, displayName: artist.name }));
  return records.map((record: any) => {
    const { prompt, negative } = buildArtistPrompt(record.artistId ? record.artistId : null, undefined);
    return {
      batch: 'artist',
      key: `artist:${record.key}`,
      subject: 'neutral-adult-female',
      sceneId: 'artist-city-street',
      characterId: '',
      artistId: record.artistId,
      displayName: record.displayName,
      engine: 'sd',
      modelId: WAI_MODEL_ID,
      checkpoint: WAI_CHECKPOINT,
      loraId: '',
      loraFile: '',
      loraStrength: null,
      seed: seedBase,
      width, height,
      steps: 30, cfg: 6, sampler: 'Euler a', scheduler: 'normal',
      prompt, negative,
    };
  });
}

/** 默认衣装样张必须选同衣装的全年龄场景，不能因排序选中成人条目。 */
function characterDefaultBlueprint(blueprints: any, characterId: any, outfitId: any) {
  const match = blueprints.find((bp: any) => bp.characterId === characterId && !bp.adult && bp.outfitId === outfitId)
    || blueprints.find((bp: any) => !bp.characterId && !bp.adult);
  if (!match) throw new Error(`no safe default-outfit blueprint for ${characterId}`);
  return match;
}

function popularBatch(seedBase: any) {
  const characters = popularContent.parsePopularCharacters(popularData);
  const blueprints = popularContent.parseSceneBlueprints(blueprintData);
  const profile = resolveModelProfile(presets.model_profiles as any, ANIMA_AESTHETIC_ID, 'anima');
  if (!profile) throw new Error('anima_aesthetic_v11 profile missing');
  return characters.map((character: any) => {
    const blueprint = characterDefaultBlueprint(blueprints, character.id, popularContent.defaultOutfit(character).id);
    const { prompt, negative, outfit } = buildPopularPrompt(character, blueprint, profile, undefined);
    const model = animaConst.MODELS[ANIMA_AESTHETIC_ID];
    const size = blueprint.recommendedSize.match(/(\d+)\s*[x×]\s*(\d+)/i);
    return {
      batch: 'popular',
      key: `popular:${character.id}`,
      subject: character.id,
      sceneId: blueprint.id,
      characterId: character.id,
      artistId: '',
      displayName: `${character.displayName} (${character.franchise})`,
      engine: 'anima',
      modelId: ANIMA_AESTHETIC_ID,
      checkpoint: model.file,
      loraId: '',
      loraFile: '',
      loraStrength: null,
      seed: stableSeed(`popular:${character.id}:${seedBase}`),
      width: size ? Number(size[1]) : 832,
      height: size ? Number(size[2]) : 1216,
      steps: 24, cfg: 3.0, sampler: 'res_multistep', scheduler: 'simple',
      prompt, negative,
      recommendedEngine: character.recommendedEngine,
      engineOverride: character.recommendedEngine === ANIMA_AESTHETIC_ID ? '' : character.recommendedEngine,
      outfitId: outfit.id,
      adultEligibility: character.adultEligibility,
    };
  });
}

function latestLoraBatch(seedBase: any) {
  const charConfigs = [
    { characterId: 'nene', label: '绫地宁宁', sdLoraId: 'L_NENE_V18_WD14', animaLoraId: 'L_NENE_V21_ANIMA' },
    { characterId: 'natsume', label: '四季夏目', sdLoraId: 'L_NAT_V18_WD14', animaLoraId: 'L_NAT_V21_ANIMA' },
  ];
  const engineSpecs = [
    ['sd', 'wai', WAI_MODEL_ID, genConst.CHECKPOINT, 30, 6, 'Euler a', 'normal'],
    ['anima', 'anima', ANIMA_AESTHETIC_ID, animaConst.MODELS[ANIMA_AESTHETIC_ID].file, 24, 3.0, 'res_multistep', 'simple'],
  ];
  const loraFileFor = (loraId: any) => {
    const genLora = genConst.LORAS[loraId];
    if (genLora) return genLora.file;
    const animaLora = animaConst.LORAS[loraId];
    if (animaLora) return animaLora.file;
    return loraMetaById(loraId).name;
  };
  const compositionSpecs = [
    ['closeup', '近景身份', 1024, 1024],
    ['fullbody', '官方服装/全身', 832, 1216],
  ];
  const records: any[] = [];
  charConfigs.forEach((config: any) => {
    engineSpecs.forEach(([engine, engineLabel, modelId, checkpoint, steps, cfg, sampler, scheduler]: any) => {
      const loraId = engine === 'sd' ? config.sdLoraId : config.animaLoraId;
      compositionSpecs.forEach(([composition, compoLabel, width, height]: any) => {
        const { prompt, negative } = buildStudioPrompt({ engine, characterId: config.characterId, composition, loraId });
        records.push({
          batch: 'latest-lora',
          key: `latest-lora:${config.characterId}:${engine}:${composition}`,
          subject: `${config.characterId}-${composition}`,
          sceneId: composition,
          characterId: config.characterId,
          artistId: '',
          displayName: `${config.label} · ${compoLabel} · ${engineLabel.toUpperCase()}`,
          engine,
          modelId,
          checkpoint,
          loraId,
          loraFile: loraFileFor(loraId),
          loraStrength: DEFAULT_LORA_STRENGTH,
          seed: stableSeed(`latest-lora:${config.characterId}:${engine}:${composition}:${seedBase}`),
          width, height,
          steps, cfg, sampler, scheduler,
          prompt, negative,
        });
      });
    });
  });
  return records;
}

function reviewOverrideJobs(basePlan: any) {
  const byKey = new Map(basePlan.map((candidate: any) => [candidate.key, candidate]));
  return Object.keys(REVIEW_OVERRIDES).map((key: any) => {
    const base = byKey.get(key);
    if (!base) throw new Error(`review override key ${key} is not part of the candidate plan`);
    return buildAttemptTwo(base, REVIEW_OVERRIDES[key]);
  });
}

function rebuildWithOverride(base: any, override: any) {
  if (base.batch === 'artist') {
    const { prompt, negative } = buildArtistPrompt(base.artistId || null, override);
    return Object.assign({}, base, { prompt, negative });
  }
  if (base.batch === 'popular') {
    const characters = popularContent.parsePopularCharacters(popularData);
    const blueprints = popularContent.parseSceneBlueprints(blueprintData);
    const character: any = popularContent.findCharacter(characters, base.subject);
    const blueprint = popularContent.findBlueprint(blueprints, base.sceneId)
      || characterDefaultBlueprint(blueprints, base.subject, popularContent.defaultOutfit(character).id);
    const profile = resolveModelProfile(presets.model_profiles as any, ANIMA_AESTHETIC_ID, 'anima');
    const { prompt, negative } = buildPopularPrompt(character, blueprint, profile, override);
    return Object.assign({}, base, { prompt, negative });
  }
  if (base.batch === 'latest-lora') {
    const { prompt, negative } = buildStudioPrompt({
      engine: base.engine,
      characterId: base.characterId,
      composition: base.sceneId,
      loraId: base.loraId,
      override,
    });
    return Object.assign({}, base, { prompt, negative });
  }
  throw new Error(`review override not supported for batch ${base.batch}`);
}

function buildReviewAttempt(base: any, override: any, attempt: any, supersedes: any) {
  const rebuilt = rebuildWithOverride(base, override);
  return Object.assign({}, rebuilt, {
    attempt,
    recordId: `${base.key}@attempt-${attempt}`,
    supersedes,
    reviewReason: override.reviewReason,
    seed: (base.seed + (Number(override.seedOffset) || 0)) % 2147483647,
    // attempt-4 may override the base size (960x1536) to keep facial
    // micro-features legible at full-body scale; earlier attempts keep their
    // planned size because they carry no width/height override.
    width: Number(override.width) || rebuilt.width,
    height: Number(override.height) || rebuilt.height,
  });
}

function buildAttemptTwo(base: any, override: any) {
  return buildReviewAttempt(base, override, 2, `${base.key}@attempt-1`);
}

function buildAttemptThree(base: any, override: any) {
  // supersedes the key's attempt-2 when that key has one, otherwise attempt-1.
  const supersedes = REVIEW_OVERRIDES[base.key]
    ? `${base.key}@attempt-2`
    : `${base.key}@attempt-1`;
  return buildReviewAttempt(base, override, 3, supersedes);
}

function buildAttemptFour(base: any, override: any) {
  // supersedes the key's latest prior attempt: attempt-3 when that key has one,
  // otherwise attempt-2 when present, otherwise attempt-1.
  const prior = ATTEMPT_3_OVERRIDES[base.key] ? 3 : REVIEW_OVERRIDES[base.key] ? 2 : 1;
  return buildReviewAttempt(base, override, 4, `${base.key}@attempt-${prior}`);
}

function reviewAttemptThreeJobs(basePlan: any) {
  const byKey = new Map(basePlan.map((candidate: any) => [candidate.key, candidate]));
  return Object.keys(ATTEMPT_3_OVERRIDES).map((key: any) => {
    const base = byKey.get(key);
    if (!base) throw new Error(`attempt-3 key ${key} is not part of the candidate plan`);
    return buildAttemptThree(base, ATTEMPT_3_OVERRIDES[key]);
  });
}

function reviewAttemptFourJobs(basePlan: any) {
  const byKey = new Map(basePlan.map((candidate: any) => [candidate.key, candidate]));
  return Object.keys(ATTEMPT_4_OVERRIDES).map((key: any) => {
    const base = byKey.get(key);
    if (!base) throw new Error(`attempt-4 key ${key} is not part of the candidate plan`);
    return buildAttemptFour(base, ATTEMPT_4_OVERRIDES[key]);
  });
}

// ── 双引擎全矩阵批次（2026-08-13）───────────────────────────────────────────
// 热门角色：18 角色 × 24 蓝图 × {anima, krea2}，adultEnabled=true（3 成人角色 ×
// 3 成人蓝图 = 每引擎 9 张 R18）。fail-closed 过滤后每引擎 387 组合，双引擎 774。
// 画师：12 画师 + no-artist baseline × {anima, krea2}。

function kreaProfile() {
  return resolveModelProfile(presets.model_profiles as any, KREA_MODEL_ID, 'krea2');
}

function nearestSize(engine: any, blueprint: any) {
  const explicit = String(blueprint.recommendedSize || '');
  const match = explicit.match(/^(\d+)\s*[x×]\s*(\d+)$/i);
  const desired = match ? [Number(match[1]), Number(match[2])] : [832, 1216];
  const sizes = engine === 'krea2'
    ? ['1024x1024', '1024x1536', '1536x1024']
    : ['832x1216', '1024x1024', '1216x832'];
  const ratio = desired[0] / desired[1];
  const nearest = sizes
    .map((size: any) => {
      const [w, h] = size.split('x').map(Number);
      return { size, w, h, delta: Math.abs(w / h - ratio) };
    })
    .sort((a: any, b: any) => a.delta - b.delta)[0];
  return { width: nearest.w, height: nearest.h };
}

function popularGridBatch(seedBase: any) {
  const characters = popularContent.parsePopularCharacters(popularData);
  const blueprints = popularContent.parseSceneBlueprints(blueprintData);
  const animaProfile = resolveModelProfile(presets.model_profiles as any, ANIMA_AESTHETIC_ID, 'anima');
  const krea = kreaProfile();
  if (!animaProfile || !krea) throw new Error('anima_aesthetic_v11 / krea2_turbo_fp8 profile missing');
  const records: any[] = [];
  for (const character of characters) {
    // 角色感知：只枚举该角色的专属原型场景 + 通用成人蓝图（fail-closed）。
    const eligible = popularContent.eligibleBlueprints(blueprints, character, { adultEnabled: true });
    for (const blueprint of eligible) {
      for (const engine of ['anima', 'krea2'] as const) {
        const profile = engine === 'anima' ? animaProfile : krea;
        const decisions = popularContent.inferBlueprintDecisions(blueprint);
        const style = kreaRecipes.resolveStyleRecipe(
          kreaRecipes.KREA_STYLE_RECIPES,
          engine,
          blueprint,
          null,
          character.adultEligibility === 'adult' ? { adultEligibility: 'adult' } : null,
          { adultEnabled: true },
        );
        const result = popularContent.buildPopularPromptPlan({
          character,
          outfit: popularContent.defaultOutfit(character),
          blueprint,
          engine,
          profile,
          adultEnabled: true,
          shot: decisions.shot,
          lighting: decisions.lighting,
          composition: decisions.composition,
          style: style ? {
            lead: style.lead,
            medium: style.medium,
            sd: style.sd,
            adult: style.adult === true,
          } : undefined,
        });
        if (!result) continue;
        const size = nearestSize(engine, blueprint);
        const model = engine === 'anima' ? animaConst.MODELS[ANIMA_AESTHETIC_ID] : animaConst.MODELS[KREA_MODEL_ID];
        records.push({
          batch: 'popular-grid',
          key: `popular-grid:${character.id}:${blueprint.id}:${engine}`,
          subject: character.id,
          sceneId: blueprint.id,
          characterId: character.id,
          artistId: '',
          displayName: `${character.displayName} / ${blueprint.title}${result.adult ? ' (R18)' : ''}`,
          engine,
          modelId: engine === 'anima' ? ANIMA_AESTHETIC_ID : KREA_MODEL_ID,
          checkpoint: model.file,
          loraId: '',
          loraFile: '',
          loraStrength: null,
          seed: stableSeed(`popular-grid:${character.id}:${blueprint.id}:${engine}:${seedBase}`),
          width: size.width,
          height: size.height,
          steps: engine === 'anima' ? 24 : 8,
          cfg: engine === 'anima' ? 3.0 : 1,
          sampler: engine === 'anima' ? 'res_multistep' : 'euler',
          scheduler: 'simple',
          prompt: result.prompt,
          negative: result.negative || '',
          adult: result.adult,
          recommendedEngine: character.recommendedEngine,
          engineOverride: character.recommendedEngine === engine ? '' : character.recommendedEngine,
          outfitId: popularContent.defaultOutfit(character).id,
          adultEligibility: character.adultEligibility,
        });
      }
    }
  }
  return records;
}

function artistGridBatch(seedBase: any) {
  const artists = [...artistCatalog.ARTIST_STYLE_OPTIONS];
  const records: any[] = [];
  for (const engine of ['anima', 'krea2']) {
    const entries = [{ key: 'no-artist', artistId: '', displayName: 'no-artist baseline' }]
      .concat(artists.map((artist: any) => ({ key: artist.id, artistId: artist.id, displayName: artist.name })));
    for (const entry of entries) {
      const { prompt, negative } = buildArtistPromptFor(engine, entry.artistId || null);
      const width = engine === 'krea2' ? 1024 : 832;
      const height = engine === 'krea2' ? 1536 : 1216;
      records.push({
        batch: 'artist-grid',
        key: `artist-grid:${entry.key}:${engine}`,
        subject: 'neutral-adult-female',
        sceneId: 'artist-city-street',
        characterId: '',
        artistId: entry.artistId,
        displayName: `${entry.displayName} (${engine})`,
        engine,
        modelId: engine === 'anima' ? ANIMA_AESTHETIC_ID : KREA_MODEL_ID,
        checkpoint: engine === 'anima' ? animaConst.MODELS[ANIMA_AESTHETIC_ID].file : animaConst.MODELS[KREA_MODEL_ID].file,
        loraId: '',
        loraFile: '',
        loraStrength: null,
        seed: stableSeed(`artist-grid:${entry.key}:${engine}:${seedBase}`),
        width,
        height,
        steps: engine === 'anima' ? 24 : 8,
        cfg: engine === 'anima' ? 3.0 : 1,
        sampler: engine === 'anima' ? 'res_multistep' : 'euler',
        scheduler: 'simple',
        prompt,
        negative,
      });
    }
  }
  return records;
}

function planAllBatches(seedBase: any) {
  const base = [
    ...artistBatch(seedBase),
    ...popularBatch(seedBase),
    ...latestLoraBatch(seedBase),
    ...popularGridBatch(seedBase),
    ...artistGridBatch(seedBase),
  ].map((candidate: any) => Object.assign({}, candidate, {
    attempt: 1,
    recordId: `${candidate.key}@attempt-1`,
  }));
  const withTwo = base.concat(reviewOverrideJobs(base));
  const withThree = withTwo.concat(reviewAttemptThreeJobs(base));
  return withThree.concat(reviewAttemptFourJobs(base)).map((candidate: any) => Object.assign({}, candidate, {
    promptHealth: qualityPromptContract.inspectCandidatePrompt(candidate),
  }));
}

/**
 * Pure candidate filter shared by the CLI and tests. An empty filter list means
 * "no constraint". `attempts` narrows to specific review rounds, so
 * `--keys a,b,c --attempt 3` selects only the attempt-3 candidates for those
 * keys instead of every attempt (the existing `--keys` behaviour of including
 * all attempts stays intact when `--attempt` is absent).
 */
function filterPlanned(planned: any, filters: any) {
  const batch = (filters && filters.batch) || [];
  const keys = (filters && filters.keys) || [];
  const attempts = (filters && filters.attempts) || [];
  return planned.filter((candidate: any) =>
    (!batch.length || batch.includes(candidate.batch))
    && (!keys.length || keys.includes(candidate.key))
    && (!attempts.length || attempts.includes(candidate.attempt)));
}

// ── gateway job runner ─────────────────────────────────────────────────────

async function gatewayJson(base: any, pathname: any, options: any) {
  const url = base.replace(/\/$/, '') + pathname;
  const response = await fetch(url, Object.assign({ cache: 'no-store' }, options || {}));
  let data = null;
  try { data = await response.json(); } catch (error) { /* keep null */ }
  return { response, data };
}

async function submitCandidate(base: any, candidate: any) {
  const body: any = { prompt: candidate.prompt, negative: candidate.negative };
  let routeBase;
  if (candidate.engine === 'krea2') {
    routeBase = '/api/creative/jobs';
    Object.assign(body, {
      modelId: candidate.modelId,
      width: candidate.width, height: candidate.height,
      seed: candidate.seed,
    });
  } else if (candidate.batch === 'artist' || (candidate.batch === 'latest-lora' && candidate.engine === 'sd')) {
    routeBase = '/api/generation/jobs';
    Object.assign(body, {
      profile: WAI_PROFILE_ID,
      modelId: WAI_MODEL_ID,
      character: candidate.characterId || '',
      loras: candidate.loraId ? [{ id: candidate.loraId, strength: candidate.loraStrength }] : [],
      width: candidate.width, height: candidate.height,
      steps: candidate.steps, cfg: candidate.cfg, seed: candidate.seed,
      sampler: candidate.sampler, scheduler: '',
      hiresFix: false,
    });
  } else {
    routeBase = '/api/anima/jobs';
    Object.assign(body, {
      modelId: candidate.modelId,
      width: candidate.width, height: candidate.height,
      steps: candidate.steps, cfg: candidate.cfg, seed: candidate.seed,
    });
    if (candidate.loraId) {
      body.loraId = candidate.loraId;
      body.loraStrength = candidate.loraStrength;
      body.character = candidate.characterId;
    }
  }
  const submitted = await gatewayJson(base, routeBase, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (submitted.response.status !== 202 || !submitted.data || !submitted.data.ok || !submitted.data.job || !submitted.data.job.id) {
    return { ok: false, error: `submission failed (HTTP ${submitted.response.status}): ${JSON.stringify(submitted.data)}` };
  }
  const job = submitted.data.job;
  const pollBase = routeBase === '/api/anima/jobs' ? '/api/anima/jobs' : (routeBase === '/api/creative/jobs' ? '/api/creative/jobs' : '/api/generation/jobs');
  const deadline = Date.now() + 15 * 60 * 1000;
  let current = job;
  while (Date.now() < deadline) {
    const state = await gatewayJson(base, `${pollBase}/${encodeURIComponent(current.id)}`, undefined);
    const polled = state.response.ok && state.data && state.data.ok ? state.data.job : null;
    if (polled) current = polled;
    if (current.status === 'failed' || current.status === 'cancelled') {
      return { ok: false, error: `job failed: ${current.error || current.status} (${current.code || ''})` };
    }
    if (current.status === 'succeeded' && current.resultUrl) break;
    await new Promise<any>((resolve: any) => setTimeout(resolve, 2000));
  }
  if (current.status !== 'succeeded' || !current.resultUrl) {
    return { ok: false, error: `job timed out: ${current.status}` };
  }
  const imageResponse = await fetch(base.replace(/\/$/, '') + current.resultUrl, { cache: 'no-store' });
  if (!imageResponse.ok) return { ok: false, error: `result fetch failed (HTTP ${imageResponse.status})` };
  const buffer = Buffer.from(await imageResponse.arrayBuffer());
  return {
    ok: true,
    buffer,
    provider: current.provider || '',
    jobId: current.id,
    seed: (current.metadata && current.metadata.seed) || current.seed || candidate.seed,
    infotexts: current.metadata ? current.metadata : {},
  };
}

// ── main ───────────────────────────────────────────────────────────────────

function recordIdOf(candidate: any) {
  return candidate.recordId || `${candidate.key}@attempt-${candidate.attempt || 1}`;
}
function imageRelFor(candidate: any) {
  const base = candidate.key.replace(/[:\/\\]/g, '_');
  const attemptSuffix = candidate.attempt > 1 ? `_attempt-${candidate.attempt}` : '';
  return `images/${candidate.batch}/${base}${attemptSuffix}.png`;
}

async function main() {
  const batchFilter = splitList(argument('--batch'));
  const keyFilter = splitList(argument('--keys'));
  // --attempt narrows to specific review rounds, e.g. --attempt 3 regenerates
  // only attempt-3 candidates and never re-runs attempt-1/2.
  const attemptFilter = splitList(argument('--attempt')).map(Number).filter(Number.isInteger);
  const output = assertNotShowcase(path.resolve(argument('--output', DEFAULT_OUTPUT)));
  const gateway = argument('--gateway', 'http://127.0.0.1:3000');
  const seedBase = Number(argument('--seed', '20260812')) || 20260812;
  const force = process.argv.includes('--force');
  const dryRun = process.argv.includes('--dry-run');
  const limit = Math.max(1, Number(argument('--limit', '9999')) || 9999);

  fs.mkdirSync(output, { recursive: true });
  const manifestPath = path.join(output, MANIFEST_NAME);
  const manifest = fs.existsSync(manifestPath) ? readJson(manifestPath) : [];

  const planned = planAllBatches(seedBase);
  const selected = filterPlanned(planned, {
    batch: batchFilter,
    keys: keyFilter,
    attempts: attemptFilter,
  });
  if (dryRun) {
    console.log(JSON.stringify({ output, gateway, totalPlanned: planned.length, selected: selected.length, candidates: selected }, null, 2));
    return;
  }

  console.log(`output: ${output}`);
  console.log(`planned ${planned.length} candidates, selected ${selected.length}`);

  const records = new Map(manifest.map((record: any) => [record.recordId || `${record.key}@attempt-${record.attempt || 1}`, record]));
  let generated = 0;
  let reused = 0;
  let failed = 0;

  for (let index = 0; index < selected.length; index += 1) {
    const candidate = selected[index];
    if (generated + reused >= limit) break;
    const recordId = recordIdOf(candidate);
    const previous: any = records.get(recordId);
    const previousImage = previous && previous.image ? path.join(output, previous.image.split('/').join(path.sep)) : '';
    if (shouldReuse(previous, previousImage, force)) {
      console.log(`[reuse] ${candidate.key}@attempt-${candidate.attempt} -> ${previous.image}`);
      reused += 1;
      continue;
    }

    console.log(`[generate] ${candidate.key}@attempt-${candidate.attempt} seed ${candidate.seed} ${candidate.width}x${candidate.height}${candidate.reviewReason ? ` :: ${candidate.reviewReason}` : ''}`);
    const result: any = await submitCandidate(gateway, candidate);
    const imageRel = imageRelFor(candidate);
    const imageFile = path.join(output, imageRel.split('/').join(path.sep));

    if (!result.ok) {
      records.set(recordId, Object.assign({}, candidate, {
        status: 'failed', error: result.error, generatedAt: new Date().toISOString(), image: '', jobId: result.jobId || '',
      }));
      writeJsonAtomic(manifestPath, [...records.values()]);
      failed += 1;
      console.log(`[failed] ${candidate.key}@attempt-${candidate.attempt}: ${result.error}`);
      continue;
    }

    const info = imageInfo(result.buffer);
    if (!info || !result.buffer.length) {
      records.set(recordId, Object.assign({}, candidate, {
        status: 'failed', error: 'engine returned a non-image payload', generatedAt: new Date().toISOString(), image: '',
      }));
      writeJsonAtomic(manifestPath, [...records.values()]);
      failed += 1;
      console.log(`[failed] ${candidate.key}@attempt-${candidate.attempt}: non-image payload`);
      continue;
    }

    fs.mkdirSync(path.dirname(imageFile), { recursive: true });
    fs.writeFileSync(imageFile, result.buffer);
    records.set(recordId, Object.assign({}, candidate, {
      status: 'succeeded',
      error: '',
      generatedAt: new Date().toISOString(),
      image: imageRel,
      bytes: result.buffer.length,
      mime: info.mime,
      actualWidth: info.width,
      actualHeight: info.height,
      sha256: crypto.createHash('sha256').update(result.buffer).digest('hex'),
      jobId: result.jobId,
      provider: result.provider,
      actualSeed: result.seed,
      infotexts: result.infotexts,
    }));
    writeJsonAtomic(manifestPath, [...records.values()]);
    generated += 1;
    console.log(`[ok] ${candidate.key}@attempt-${candidate.attempt} -> ${imageRel} (${result.buffer.length} bytes, ${info.width}x${info.height}, ${info.mime})`);
  }

  const normalized = [...records.values()].map((record: any) =>
    record.attempt ? record : Object.assign({}, record, { attempt: 1 }))
    .sort((a: any, b: any) => (a.recordId || a.key).localeCompare(b.recordId || b.key));
  writeJsonAtomic(manifestPath, normalized);
  console.log(JSON.stringify({ output, generated, reused, failed }, null, 2));

  const verified = verifyOutput(output);
  console.log(`verification: ${verified.checked}/${verified.total} images pass mechanical checks`);
}

// ── mechanical verification + review index ─────────────────────────────────

function verifyOutput(output: any) {
  const manifestPath = path.join(output, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) throw new Error('no manifest to verify');
  const manifest = readJson(manifestPath);
  const entries: any[] = [];
  let checked = 0;
  for (const record of manifest) {
    const entry: any = {
      batch: record.batch, key: record.key, subject: record.subject,
      sceneId: record.sceneId, characterId: record.characterId, artistId: record.artistId,
      displayName: record.displayName, engine: record.engine, provider: record.provider,
      modelId: record.modelId, checkpoint: record.checkpoint,
      loraId: record.loraId, loraFile: record.loraFile, loraStrength: record.loraStrength,
      seed: record.actualSeed ?? record.seed, width: record.width, height: record.height,
      steps: record.steps, cfg: record.cfg, sampler: record.sampler, scheduler: record.scheduler,
      prompt: record.prompt, negative: record.negative,
      generatedAt: record.generatedAt, image: record.image,
      status: record.status, error: record.error || '',
      attempt: record.attempt || 1,
      recordId: record.recordId || `${record.key}@attempt-${record.attempt || 1}`,
      supersedes: record.supersedes || '',
      reviewReason: record.reviewReason || '',
    };
    if (record.status !== 'succeeded') { entries.push(entry); continue; }
    checked += 1;
    const file = path.join(output, record.image.split('/').join(path.sep));
    entry.pathExists = fs.existsSync(file);
    entry.bytes = record.bytes || 0;
    entry.sha256 = record.sha256 || '';
    let dimsOk = true;
    let mime = '';
    if (entry.pathExists) {
      const buffer = fs.readFileSync(file);
      const info: any = imageInfo(buffer);
      mime = info ? info.mime : '';
      entry.mime = mime;
      entry.magicWidth = info ? info.width : 0;
      entry.magicHeight = info ? info.height : 0;
      dimsOk = Boolean(info) && info.width === record.width && info.height === record.height;
      entry.nonEmpty = buffer.length > 1000;
      entry.expectedMimeOk = mime.startsWith('image/');
    } else {
      entry.nonEmpty = false;
      entry.expectedMimeOk = false;
    }
    entry.dimensionsMatch = dimsOk;
    entry.mechanicalPass = Boolean(entry.pathExists && entry.nonEmpty && entry.expectedMimeOk && dimsOk);
    entries.push(entry);
  }
  // Mark attempt-1 entries superseded when a later attempt succeeded.
  const superseding = new Map(entries.filter((entry: any) => entry.attempt > 1).map((entry: any) => [entry.key, entry.recordId]));
  entries.forEach((entry: any) => {
    if (entry.attempt === 1 && superseding.has(entry.key)) entry.supersededBy = superseding.get(entry.key);
  });
  const reviewIndex = {
    generatedAt: new Date().toISOString(),
    outputDir: output,
    purpose: 'candidate set for main-thread visual review; mechanical checks only, no visual pass claimed',
    totals: {
      planned: manifest.length,
      succeeded: manifest.filter((record: any) => record.status === 'succeeded').length,
      failed: manifest.filter((record: any) => record.status === 'failed').length,
      mechanicalPass: entries.filter((entry: any) => entry.mechanicalPass).length,
      attempts: entries.reduce((acc: any, entry: any) => { acc[entry.attempt] = (acc[entry.attempt] || 0) + 1; return acc; }, {}),
    },
    entries,
  };
  writeJsonAtomic(path.join(output, REVIEW_INDEX_NAME), reviewIndex);
  writeContactSheet(output, reviewIndex);
  return { checked, total: manifest.length, pass: reviewIndex.totals.mechanicalPass };
}

function escapeHtml(value: any) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function writeContactSheet(output: any, reviewIndex: any) {
  const rows = reviewIndex.entries.map((entry: any) => {
    const attemptBadge = entry.attempt > 3
      ? `<span class="attempt4">attempt-4 · 右眼痣修正重出</span>`
      : entry.attempt > 2
        ? `<span class="attempt3">attempt-3 · 复核重出</span>`
        : entry.attempt > 1
          ? `<span class="attempt2">attempt-2 · 复核覆盖</span>`
          : '<span class="attempt1">attempt-1</span>';
    const badge = entry.status === 'succeeded'
      ? `<span class="ok">${entry.mechanicalPass ? '机械通过' : '机械未过'}</span>`
      : `<span class="fail">${escapeHtml(entry.status)}</span>`;
    const image = entry.status === 'succeeded' && entry.pathExists
      ? `<a class="thumb" href="${escapeHtml(entry.image)}"><img loading="lazy" src="${escapeHtml(entry.image)}" alt="${escapeHtml(entry.key)}"></a>`
      : '<div class="thumb empty">无图片</div>';
    const meta = [
      ['batch', entry.batch], ['key', entry.key], ['attempt', entry.attempt],
      ['display', entry.displayName], ['engine', entry.engine], ['model', entry.checkpoint],
      entry.loraId ? ['lora', `${entry.loraId} @${entry.loraStrength}`] : null,
      ['seed', entry.seed], ['size', `${entry.width}x${entry.height}`],
      ['params', `${entry.steps}s / cfg ${entry.cfg} / ${entry.sampler} / ${entry.scheduler}`],
      ['char', entry.characterId || '-'], ['artist', entry.artistId || '-'],
      entry.supersedes ? ['supersedes', entry.supersedes] : null,
      entry.supersededBy ? ['supersededBy', entry.supersededBy] : null,
      ['generatedAt', entry.generatedAt],
    ].filter(Boolean).map(([label, value]: any) => `<div class="meta"><span>${escapeHtml(label)}</span><code>${escapeHtml(String(value))}</code></div>`).join('');
    const reasonBlock = entry.reviewReason
      ? `<div class="reason">审核覆盖：${escapeHtml(entry.reviewReason)}</div>` : '';
    const promptBlock = entry.prompt
      ? `<details><summary>Prompt</summary><pre>${escapeHtml(entry.prompt)}</pre><pre class="neg">${escapeHtml(entry.negative || '')}</pre></details>`
      : '';
    const errorBlock = entry.error ? `<div class="error">${escapeHtml(entry.error)}</div>` : '';
    return `<section class="card" data-batch="${escapeHtml(entry.batch)}" data-status="${escapeHtml(entry.status)}" data-attempt="${entry.attempt}">
      ${image}${badge}${attemptBadge}${reasonBlock}${meta}${promptBlock}${errorBlock}
    </section>`;
  }).join('');
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>候选样张联系表 · ShowcaseRefresh 2026-08-12</title>
<style>
body{font-family:system-ui,Segoe UI,Microsoft YaHei,sans-serif;margin:0;background:#15121c;color:#eee}
header{padding:16px 20px;background:#1e1a2a;position:sticky;top:0;z-index:5}
h1{font-size:16px;margin:0}header p{margin:4px 0 0;font-size:12px;color:#9a93b0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:14px;padding:16px 20px}
.card{background:#201c2e;border:1px solid #332c4a;border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px}
.thumb{display:block;text-align:center;background:#000;border-radius:8px;overflow:hidden}
.thumb img{max-width:100%;max-height:420px;object-fit:contain}
.thumb.empty{height:120px;line-height:120px;color:#666}
.ok{color:#6fd08a;font-size:12px;font-weight:600}.fail{color:#ff7d7d;font-size:12px;font-weight:600}
.attempt2{color:#ffc66d;font-size:12px;font-weight:700}.attempt3{color:#ff8fa3;font-size:12px;font-weight:700}.attempt4{color:#7fd0ff;font-size:12px;font-weight:700}.attempt1{color:#8b86a0;font-size:12px}
.reason{color:#ffc66d;font-size:12px;background:#332a1a;border-radius:6px;padding:4px 6px}
.meta{display:flex;gap:8px;font-size:12px;align-items:baseline}
.meta span{color:#9a93b0;min-width:64px}
.meta code{color:#d8d0f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
details summary{cursor:pointer;font-size:12px;color:#9a93b0}
pre{font-size:11px;white-space:pre-wrap;word-break:break-all;color:#c9c2e4;margin:4px 0 0;max-height:180px;overflow:auto}
pre.neg{color:#b08a8a}
.error{color:#ff7d7d;font-size:12px}
</style></head><body>
<header><h1>候选样张联系表 · 2026-08-12 artist/popular/latest-lora</h1>
<p>输出目录：<code>${escapeHtml(reviewIndex.outputDir)}</code> · 记录 ${reviewIndex.totals.planned} · 成功 ${reviewIndex.totals.succeeded} · 失败 ${reviewIndex.totals.failed} · 机械通过 ${reviewIndex.totals.mechanicalPass} · attempt 分布 ${JSON.stringify(reviewIndex.totals.attempts)}（仅机械校验，视觉判定由主线程完成）</p></header>
<div class="grid">${rows}</div>
</body></html>`;
  writeJsonAtomic2(path.join(output, CONTACT_SHEET_NAME), html);
}

function writeJsonAtomic2(file: any, content: any) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content, 'utf8');
  fs.renameSync(temporary, file);
}

if (require.main === module) {
  main().catch((error: any) => {
    console.error(error && error.stack || error);
    process.exitCode = 1;
  });
}

export = {
  planAllBatches, artistBatch, popularBatch, latestLoraBatch,
  reviewOverrideJobs, buildAttemptTwo, buildAttemptThree, buildAttemptFour,
  reviewAttemptThreeJobs, reviewAttemptFourJobs,
  buildArtistPrompt, buildStudioPrompt, buildPopularPrompt,
  assertNotShowcase, imageInfo, verifyOutput, shouldReuse, writeJsonAtomic,
  recordIdOf, imageRelFor, filterPlanned,
  REVIEW_OVERRIDES, ATTEMPT_3_OVERRIDES, ATTEMPT_4_OVERRIDES,
  constants: {
    DEFAULT_OUTPUT, MANIFEST_NAME, REVIEW_INDEX_NAME, CONTACT_SHEET_NAME,
    WAI_PROFILE_ID, WAI_MODEL_ID, WAI_CHECKPOINT, ANIMA_BASE_ID, ANIMA_AESTHETIC_ID,
    POPULAR_BLUEPRINT_ID, DEFAULT_LORA_STRENGTH, STUDIO_CHAR_PROMPT, ARTIST_NEUTRAL_SUBJECT,
  },
};
