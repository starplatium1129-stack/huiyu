// Krea 风格配方 —— 官方散文段结构的风格层（数据 + 纯函数，无 DOM）。
//
// 依据 Krea 2 官方配方（docs.krea.ai Turbo / github krea-2 prompting.md）：
//   1. 风格语言放最前（"Add style language early"）；
//   2. 每配方 = 前置风格短语 lead + 可选后置媒介词 medium；
//   3. R18 配方保留分级标记，图片默认模糊；分级不限制配方使用。
//
// 当前 Krea 规则见 .agents/skills/studio-prompt-craft/references/krea.md：
//   - 动漫向配方 lead 统一补「平涂词族」：Krea 2 默认偏厚涂/半写实，
//     'polished' 词又引导光泽，二次元出图「油、糊、厚」；对策是明写
//     flat cel shading / flat colors / crisp line art / clean linework。
//   - 真人/电影向配方补「光线材质语言」（§6.2）：film grain、softbox 等可测量
//     光学线索比 ultra detailed 有用；质量词（8k/masterpiece）一律不进入配方。
//
// 该模块只负责解析配方与资格判定，不关心引擎渲染；Krea 用 lead+medium 织入
// 散文段，Anima 只取显式配方的 sd 短标签，渲染仍由 createPromptPlan +
// renderPromptPlan 单一入口完成。

export type RecipeEngine = 'sd' | 'krea2' | 'anima'

export interface KreaStyleRecipe {
  id: string
  name: string
  /** 前置风格短语（放正文最前）。 */
  lead: string
  /** 可选后置媒介词（放散文段末尾）。 */
  medium?: string
  /** Concise model-native fragments. Legacy lead remains the Krea prose source. */
  sd?: string
  /** 成人配方分级标记，不参与访问控制。 */
  adult: boolean
}

/** 蓝图 hint 只做结构性声明，交给本模块解析。 */
export interface StyleBlueprintHint {
  kreaStyleHint?: string
  animaStyleHint?: string
}

/** 已解析可用的风格：lead 必填，medium/adult 可选。 */
export interface ResolvedStyle {
  lead: string
  medium?: string
  sd?: string
  adult?: boolean
}

export const KREA_STYLE_RECIPES: readonly KreaStyleRecipe[] = Object.freeze([
  // ── 现代高精动漫 / 电影插画向（以透明光感、精细线稿与大气层次取代旧式平涂 CG）──
  { id: 'anime_key_visual', name: 'Anime 主视觉', lead: 'An exquisite modern Japanese anime key illustration with delicate fine linework, translucent luminous shading, rich chromatic depth, and cinematic atmospheric light', sd: 'anime key visual, clean lineart, flat cel shading, saturated colors', medium: 'theatrical anime illustration', adult: false },
  { id: 'vn_event_cg', name: '高精叙事 CG', lead: 'A high-craft modern Japanese anime illustration with refined translucent shading, crisp delicate linework, expressive light diffusion, and rich atmospheric depth', sd: 'visual novel event CG, refined cel shading, flat colors, crisp character work', medium: 'high-craft anime illustration', adult: false },
  { id: 'light_novel_cover', name: '轻小说封面', lead: 'An intricate modern Japanese light novel cover illustration with delicate fine linework, luminous translucent coloring, airy depth of field, and graceful character-forward framing', sd: 'light novel cover, clean lineart, flat colors, character-focused composition, polished illustration', medium: 'light novel cover illustration', adult: false },
  { id: 'cinematic_film_still', name: '电影感剧照', lead: 'A cinematic theatrical anime film still with dramatic spatial depth, sculptural light-and-shadow contrast, subtle film grain, and expansive atmospheric framing', sd: 'cinematic lighting, dramatic depth, film grain, balanced composition', medium: 'theatrical film still', adult: false },
  { id: 'soft_daily_illustration', name: '柔和日常插画', lead: 'A warm, luminous Japanese anime slice-of-life illustration with delicate linework, translucent natural sunlight, airy spatial depth, and gentle atmospheric clarity', sd: 'soft daily illustration, warm gentle tones, clean linework', medium: 'luminous anime illustration', adult: false },
  { id: 'fantasy_painting', name: '奇幻厚涂绘画', lead: 'A richly painted Japanese fantasy anime illustration with luminous painterly brushwork, intricate material light reflections, and sweeping atmospheric grandeur', sd: 'fantasy painting, painterly brushwork, atmospheric depth', medium: 'fantasy anime painting', adult: false },
  { id: 'anime_promo_art', name: 'Anime 宣传主图', lead: 'A breathtaking theatrical anime promo illustration with sweeping dynamic perspective, vivid jewel-toned light contrast, fine crisp linework, and radiant atmospheric depth', sd: 'anime promo art, dynamic composition, flat cel shading, vivid colors', medium: 'theatrical anime key art', adult: false },
  { id: 'dreamy_pastel', name: '梦幻粉彩', lead: 'An ethereal pastel anime illustration bathed in pearlescent diffused light, delicate fine linework, translucent color washes, and dreamy atmospheric depth', sd: 'dreamy pastel, soft diffused light, smooth flat colors', medium: 'ethereal pastel anime illustration', adult: false },
  { id: 'moody_night_scene', name: '氛围夜景', lead: 'A cinematic nocturnal anime illustration with deep sapphire-indigo shadows, luminous warm accent glows, translucent atmospheric haze, and crisp delicate linework', sd: 'moody night scene, deep shadows, flat colors, atmospheric glow', medium: 'nocturnal anime illustration', adult: false },
  { id: 'cel_1990s', name: '1990s 赛璐璐动画', lead: 'A 1990s theatrical cel anime frame with expressive ink contours, hand-painted atmospheric backgrounds, nostalgic color grading, and subtle analog film grain', sd: '1990s cel anime, bold outlines, crisp lineart, nostalgic flat colors', medium: 'retro cel anime illustration', adult: false },
  { id: 'shoujo_manga', name: '少女漫画', lead: 'A delicate luminous shoujo anime illustration with jewel-like expressive eyes, gossamer fine linework, pearlescent highlights, and airy romantic framing', sd: 'shoujo manga, expressive eyes, clean lineart, romantic framing', medium: 'shoujo anime illustration', adult: false },
  { id: 'soft_watercolor', name: '柔和水彩', lead: 'A luminous Japanese watercolor anime illustration with translucent layered washes, delicate ink linework, sparkling water-bloom highlights, and subtle paper grain', sd: 'soft watercolor, translucent washes, paper texture', medium: 'watercolor anime illustration', adult: false },
  { id: 'ink_wash_darkbrush', name: '水墨·暗刷', lead: 'An expressive ink wash and dark brush anime illustration with flowing calligraphic brushwork, dramatic monochrome tonal depth, and atmospheric mist', sd: 'ink wash, dark brush, monochrome texture', medium: 'ink wash illustration', adult: false },
  { id: 'neon_abstract', name: '霓虹抽象', lead: 'A vibrant neon-lit avant-garde anime illustration with luminous chromatic gradients, dynamic light refraction, and bold graphic energy', sd: 'neon abstract, luminous gradients, graphic shapes', medium: 'neon graphic anime artwork', adult: false },
  { id: 'rainy_window', name: '雨窗氛围', lead: 'A poetic rainy-window anime illustration with glistening raindrop reflections, soft bokeh light trails, delicate linework, and quiet luminous melancholy', sd: 'rainy window, diffused reflections, clean linework, intimate light', medium: 'rainy-window anime illustration', adult: false },
  { id: 'vintage_tarot', name: '复古塔罗海报', lead: 'An ornate vintage tarot anime illustration with gilded symbolic motifs, intricate fine linework, aged parchment print texture, and restrained jewel-toned colors', sd: 'vintage tarot, ornate symbolism, crisp lineart, aged print texture', medium: 'vintage tarot illustration', adult: false },
  // ── 工作室级画风（强响应剧场版动画美学）─────────────────────────────────
  { id: 'ghibli_style', name: '吉卜力工作室', lead: 'An expansive hand-painted Studio Ghibli-inspired anime film frame with gentle ink lines, rich gouache-watercolor background textures, lush sunlit greenery, weathered architecture, and serene aerial perspective', sd: 'Studio Ghibli style, gentle ink lines, hand-painted watercolor textures, lush vegetation', medium: 'Ghibli film aesthetic', adult: false },
  { id: 'shinkai_style', name: '新海诚 / CoMix Wave', lead: 'A breathtaking Makoto Shinkai and CoMix Wave Films theatrical anime frame with towering radiant clouds, intense amber-magenta and cobalt twilight contrast, luminous atmospheric light shafts, crisp backlit silhouettes, and shimmering mirror-like reflections', sd: 'Shinkai style, hyper-saturated sky, radiant light, luminous reflections, glowing clouds', medium: 'Shinkai theatrical aesthetic', adult: false },
  { id: 'kyotoani_style', name: '京都动画', lead: 'A luminous Kyoto Animation theatrical film frame with ultra-refined delicate linework, carefully observed atmospheric interior light, glistening eye reflections, airy depth of field, and tender translucent colors', sd: 'Kyoto Animation style, precise linework, interior clutter, soft window light, cel shading', medium: 'Kyoto Animation aesthetic', adult: false },
  { id: 'madhouse_style', name: 'Madhouse 都市青年', lead: 'A cinematic Madhouse urban noir anime frame with restrained sharp linework, cold cyan-blue shadows, warm sodium-amber light accents, wet asphalt reflections, and grounded architectural depth', sd: 'Madhouse style, urban noir, cold blue-green colors, sodium-yellow accents, hard cel shadows', medium: 'urban noir anime aesthetic', adult: false },
  { id: 'sunrise_1990s_ova', name: '1990s Sunrise 机甲 OVA', lead: 'A hand-painted 1990s Sunrise mecha OVA film frame with bold ink contours, dramatic hard-edged shadows, painted industrial backgrounds, analog film grain, and monumental mechanical scale', sd: '1990s Sunrise mecha OVA, bold ink contours, hard cel shadows, painted backgrounds, analog grain', medium: '1990s Sunrise mecha OVA aesthetic', adult: false },
  // ── 成人配方（现代通透光感与精致肌肤质感，避免旧式平涂生硬感）────────────
  { id: 'r18_sensual_cg', name: '成人·私密光影', lead: 'A high-craft mature Japanese anime illustration with delicate fine linework, translucent luminous skin shading, soft subsurface glow, and intimate atmospheric depth', medium: 'refined mature anime illustration', adult: true },
  { id: 'r18_elegant_boudoir', name: '成人·典雅闺阁', lead: 'An exquisite mature Japanese anime illustration with graceful fine linework, luminous pearlescent skin highlights, rich fabric textures, and moody intimate lighting', medium: 'exquisite mature anime illustration', adult: true },
])

/** Anima leaves rendering style to authored hints and selected artists. */
const ENGINE_DEFAULT: Readonly<Record<RecipeEngine, string | null>> = Object.freeze({
  sd: 'anime_key_visual',
  krea2: 'anime_key_visual',
  anima: null,
})

export function findStyleRecipe(
  recipes: readonly KreaStyleRecipe[],
  id: string | null | undefined,
): KreaStyleRecipe | null {
  if (!id) return null
  return recipes.find(recipe => recipe.id === id) ?? null
}

/** 按引擎取蓝图 hint（缺省字段可选，未声明返回 undefined）。 */
function styleHintForEngine(
  blueprint: StyleBlueprintHint | null,
  engine: RecipeEngine,
): string | undefined {
  return blueprint ? (engine === 'krea2' ? blueprint.kreaStyleHint : blueprint.animaStyleHint) : undefined
}

/**
 * 解析最终风格：手选配方 > 蓝图 hint > 引擎缺省。
 * - 手选 id 无效 → 回落到引擎缺省（Anima 为空）。
 * - hint 是自由风格短语（未命中配方）→ 直接作为前置短语，无媒介词、非成人。
 * - Anima 无 hint / 手选时不强制平涂、线稿或饱和度；显式配方照常保留。
 */
export function resolveStyleRecipe(
  recipes: readonly KreaStyleRecipe[],
  engine: RecipeEngine,
  blueprint: StyleBlueprintHint | null,
  selection: string | null,
): ResolvedStyle | null {
  const hint = styleHintForEngine(blueprint, engine)
  const requested = selection || hint || ENGINE_DEFAULT[engine]
  const recipe = findStyleRecipe(recipes, requested)
  if (recipe) {
    return { lead: recipe.lead, medium: recipe.medium, sd: recipe.sd, adult: recipe.adult || undefined }
  }
  if (selection) {
    // Unknown selections cannot become arbitrary style prose.
    return resolveStyleRecipe(recipes, engine, null, null)
  }
  if (hint) {
    if (String(hint).trim()) return { lead: String(hint).trim(), adult: false }
    return null
  }
  return null
}
