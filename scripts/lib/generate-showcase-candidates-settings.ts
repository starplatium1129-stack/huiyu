'use strict';

// generate-showcase-candidates: historical review configuration and catalog inputs.
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const genConst: any = (require('./generation/sd-catalog.js') as typeof import('./generation/sd-catalog.js'));

const ROOT = path.resolve(__dirname, '..', '..');

const AI_ROOT = path.resolve(ROOT, '..', 'AI');

const popularData: unknown = readJson(path.join(ROOT, 'data', 'popular-characters.json'));

const blueprintData: unknown = readJson(path.join(ROOT, 'data', 'scene-blueprints.json'));

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

const POPULAR_BLUEPRINT_ID = '';

// 已废弃：popular 批次按角色取专属原型场景（2026-08-14）
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

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`读取 ${path.relative(ROOT, file)} 失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

export = {
  SCENE_SHOWCASE_DIR, AI_ROOT, WAI_PROFILE_ID, ARTIST_NEUTRAL_SUBJECT, ANIMA_AESTHETIC_ID,
  STUDIO_CHAR_PROMPT, DEFAULT_LORA_STRENGTH, WAI_MODEL_ID, WAI_CHECKPOINT, popularData, blueprintData,
  REVIEW_OVERRIDES, ATTEMPT_3_OVERRIDES, ATTEMPT_4_OVERRIDES, KREA_MODEL_ID, DEFAULT_OUTPUT,
  MANIFEST_NAME, readJson, REVIEW_INDEX_NAME, CONTACT_SHEET_NAME, ANIMA_BASE_ID, POPULAR_BLUEPRINT_ID,
};
