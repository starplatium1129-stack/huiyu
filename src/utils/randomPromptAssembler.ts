import type { ArtistStyleOption } from '../config/artistStyles.ts'
import { normalizeArtistStyleIds } from '../config/artistStyles.ts'
import { COLOR_MOODS, COMPOSITION, EMOTION, LIGHTING, SHOT } from '../config/promptConstants.ts'
import { membersOfMutualGroup, mutualGroupOf, mutualGroupWithCategory } from '../utils/promptPolicy.ts'

/**
 * 随机灵感采样器（2026-08-29，详见 docs/guides/engineering/random-prompt-assembler-design.md）。
 *
 * 纯函数：数据池与随机源全部注入，无 Vue / IO 依赖，可被 node:test 直接单测。
 * 只产出「风格层」采样结果（RandomDraw），三引擎渲染完全复用现有
 * promptCompiler（createPromptPlan → renderPromptPlan），本模块不触碰渲染。
 *
 * 三条硬约束：
 * 1. 角色身份固定——identity token（CHAR_PROMPT / identityExclude）绝不进入采样池；
 * 2. 画师默认不注入（includeArtists=false，保留角色原生画风），keepArtists 恒保留；
 * 3. Mature 池无独立开关——本地直连本就放行，随机抽中即与显式门控词联动
 *    （评级提升由 isManualR18Tags：门控词正则 ∪ 词条池 Mature 分类命中，见
 *    usePromptAssembly.effectiveScene），此处只保证标签层面不与显式门控词冲突、不重复。
 */

export interface RandomInspirationOptions {
  /** 工作室角色（studio 模式）。popular 模式改传 identityExclude，不传 char。 */
  char?: 'nene' | 'natsume' | 'triad'
  /** 显式身份排除集（热门角色模式）：当前角色的 identityTokens + exactTokens +
   *  当前 outfit tokens。传入后替代内置 IDENTITY_TOKENS 查表，并跳过服装抽取
   *  （热门角色的服装由 outfit 系统管理，随机抽通用服装会与之打架）。 */
  identityExclude?: ReadonlySet<string>
  /** 「随机画师」开关，默认 false：不加画师 tag，保留角色原生画风。 */
  includeArtists?: boolean
  /** 用户手动已选画师，重掷恒保留（独立于 includeArtists）。 */
  keepArtists?: string[]
  /** 注入随机源（测试用）。缺省 Math.random。 */
  rng?: () => number
  /** 项目标签池（data/tags.json，经 sceneStore 加载）。 */
  tags: ReadonlyArray<{ en: string; cat: string }>
  /** 官方服装（loras.json outfit_guidance，key → token 列表）。 */
  officialOutfits?: Readonly<Record<string, readonly string[]>>
  /** 画师白名单，缺省 ARTIST_STYLE_OPTIONS。 */
  artists?: ReadonlyArray<ArtistStyleOption>
}

export interface RandomDraw {
  /** EMOTION id 列表（1~2 个，进入 store.selections.emotion）。 */
  emotions: string[]
  /** SHOT id 或 null。 */
  shot: string | null
  /** LIGHTING id 或 null。 */
  lighting: string | null
  /** COMPOSITION id 或 null。 */
  composition: string | null
  /** COLOR_MOODS id 或 null。 */
  colorMood: string | null
  /** 场景/动作/外观/身体/服装/Mature 等原始标签（写入 store.manualTags）。 */
  manualTags: string[]
  /** 归一后的画师 id（默认空数组）。 */
  artistStyleIds: string[]
}

// ── 常量：身份 token / 元标签 / 互斥分组 / 场景室内外 ──────────────────

/** 角色身份 token：与 CHAR_PROMPT 同源，采样池必须排除。 */
const IDENTITY_TOKENS: Record<string, ReadonlySet<string>> = {
  nene: new Set(['1girl', 'solo', 'ayachi_nene', 'white_hair', 'very_long_hair', 'low_twintails', 'purple_eyes', 'ahoge', 'pink_hair_ribbons']),
  natsume: new Set(['1girl', 'solo', 'shiki_natsume', 'black_hair', 'very_long_hair', 'yellow_eyes', 'mole_under_eye', 'hairclip']),
  triad: new Set(['2girls', '1girl', 'solo']),
}

/** 与身份/构图无关的元标签，随机时一律丢弃。 */
const META_TOKENS = new Set(['general', 'official_cg', 'visual_audited', 'anime', 'landscape', 'portrait', 'safe', 'sensitive', 'nsfw'])

/** 场景室内外互斥（未命中集合的标签视为中性，可与任意一侧共存）。 */
const INDOOR_SCENE = new Set([
  'indoor', 'indoors', 'classroom', 'library', 'bedroom', 'cafe', 'cafe_interior',
  'home_theater', 'storage_room', 'breakroom', 'kitchen', 'music_room', 'arcade',
  'garage', 'attic', 'oriental_room', 'workshop', 'convenience_store', 'hotel_room',
  'fitting_room', 'car_interior', 'lounge', 'bathroom', 'living_room', 'tatami',
  'safehouse', 'gymnasium', 'swimming_pool',
])
const OUTDOOR_SCENE = new Set([
  'beach', 'shrine', 'park', 'train_station', 'school_rooftop', 'rooftop', 'grassy_hill',
  'fireworks', 'street', 'bus_stop', 'stone_stairs', 'city_lights', 'cityscape',
  'balcony', 'ocean', 'wet_road', 'festival', 'greenhouse',
])

/** 温和身体细节（可随机）；其余 Body 标签（cleavage/no_panties 等）并入 Mature 池。 */
const BODY_MILD = new Set(['collarbone', 'shoulder_blade', 'bare_shoulders', 'wet_skin', 'water_droplets', 'bare_legs', 'backless', 'bare_streaks', 'wet_hair'])

/** 极端重度/道具约束标签（在常规随机灵感中过滤，优先唯美情调与高级感）。 */
const MATURE_HARDCORE = new Set([
  'anal', 'fellatio', 'blowjob', 'cunnilingus', 'facesitting', 'deepthroat',
  'ball_gag', 'gagged', 'gag', 'spanking', 'dildo', 'vibrator', 'fucking',
  'creampie', 'cum', 'cum_on_body', 'cum_drip', 'penis', 'multiple_penises',
  'clitoris', 'labia', 'urethra', 'prostate', 'tentacles', 'pegging', 'bondage',
  'tied_up', 'rope', 'handcuffs', 'blindfold', 'mating_press', 'sumata',
])

/** 核心独立主地点（建筑/大型场景，画面中只允许出现一个核心地点，防止空间重叠）。 */
const PRIMARY_LOCATIONS = new Set([
  'classroom', 'library', 'bedroom', 'cafe', 'cafe_interior',
  'home_theater', 'storage_room', 'breakroom', 'kitchen', 'music_room', 'arcade',
  'garage', 'attic', 'oriental_room', 'workshop', 'convenience_store', 'hotel_room',
  'fitting_room', 'car_interior', 'lounge', 'bathroom', 'living_room', 'tatami',
  'safehouse', 'gymnasium', 'swimming_pool', 'art_studio', 'infirmary', 'izakaya', 'steamy_bathroom',
  'beach', 'shrine', 'train_station', 'school_rooftop', 'rooftop', 'train_platform',
  'bus_stop', 'sea_wall', 'bridge', 'hotel_balcony', 'train_interior', 'rooftop_fence',
])

/** 下肢与鞋袜细节（特写近景镜头下自动屏蔽，防止肢体畸变）。 */
const FOOTWEAR_EXCLUDE = new Set([
  'boots', 'shoes', 'sneakers', 'heels', 'sandals', 'socks', 'stockings',
  'thighhighs', 'thigh_highs', 'barefoot', 'bare_feet', 'feet', 'bare_legs',
  'strappy_heels', 'mary_janes', 'combat_boots', 'ankle_boots', 'brown_boots',
  'white_tabi', 'asymmetrical_legwear', 'loose_socks', 'frilled_socks',
])

/** LIGHTING 主光源池（互斥）；back 逆光可叠加。 */
const LIGHT_MAIN = LIGHTING.filter(option => option.id !== 'back').map(option => option.id)

/** 情绪基调互斥家族：第二情绪不得与第一情绪同族。 */
const EMOTION_FAMILY: Readonly<Record<string, string>> = {
  happy: 'happy', joyful: 'happy', relaxed: 'happy',
  sad: 'sad', moved: 'sad', miss: 'sad', wronged: 'sad',
  calm: 'calm', gentle: 'calm', sleepy: 'calm',
  serious: 'serious', nervous: 'serious',
  love: 'love', shy: 'love', spoiled: 'love', expect: 'love',
}

/** 色彩情调与情绪弱联动：情绪 → 候选 mood id 池。 */
const COLOR_MOOD_LINK: Readonly<Record<string, readonly string[]>> = {
  happy: ['joy', 'love'], joyful: ['joy', 'love'], relaxed: ['calm', 'warmth'],
  sad: ['sad', 'tension'], moved: ['sad', 'joy'], miss: ['sad', 'tension'], wronged: ['sad'],
  calm: ['calm', 'warmth'], gentle: ['calm', 'warmth'], sleepy: ['warmth', 'calm'],
  serious: ['tension'], nervous: ['tension'],
  love: ['love', 'joy'], shy: ['love', 'joy'], spoiled: ['love', 'joy'], expect: ['joy'],
}

const ALL_EMOTION_IDS = EMOTION.map(option => option.id)
const ALL_SHOT_IDS = SHOT.map(option => option.id)
const ALL_COMPOSITION_IDS = COMPOSITION.map(option => option.id)
const ALL_COLOR_MOOD_IDS = COLOR_MOODS.map(option => option.id)

function normalizeTag(value: string): string {
  return String(value || '').trim().replace(/\s+/g, '_')
}

/** 从池中不重复抽取 n 个（洗牌取前 n），池不足时全取。 */
function draw(pool: readonly string[], count: number, rng: () => number, exclude?: ReadonlySet<string>): string[] {
  const candidates = pool.filter(item => !exclude || !exclude.has(item))
  if (!candidates.length) return []
  const result: string[] = []
  const remaining = [...candidates]
  const take = Math.min(count, remaining.length)
  for (let i = 0; i < take; i += 1) {
    const index = Math.floor(rng() * remaining.length)
    result.push(remaining.splice(index, 1)[0])
  }
  return result
}

function chance(probability: number, rng: () => number): boolean {
  return rng() < probability
}

/** 按互斥组语义添加标签：同组旧成员先移除，且天气与时段大类全局互斥（下雨不能下雪、白天不能夜晚）。 */
function addWithMutualGroup(target: string[], tag: string): boolean {
  const key = normalizeTag(tag)
  if (!key || target.includes(key)) return false
  const hit = mutualGroupWithCategory(key)
  if (hit) {
    if (hit.category === 'weather' || hit.category === 'time') {
      for (let i = target.length - 1; i >= 0; i--) {
        const otherHit = mutualGroupWithCategory(target[i])
        if (otherHit && otherHit.category === hit.category) {
          target.splice(i, 1)
        }
      }
    } else {
      for (const member of membersOfMutualGroup(hit.group, target)) {
        const i = target.indexOf(member)
        if (i >= 0) target.splice(i, 1)
      }
    }
  }
  target.push(key)
  return true
}

export function randomPromptPlan(options: RandomInspirationOptions): RandomDraw {
  const rng = options.rng ?? Math.random
  // 热门角色模式：identityExclude（identityTokens+exactTokens+outfit tokens）优先；
  // studio 模式：内置身份查表。两者都归一化后并入排除集。
  const explicitIdentity = options.identityExclude
  const identitySource: Iterable<string> = explicitIdentity
    ? explicitIdentity
    : (IDENTITY_TOKENS[options.char ?? 'nene'] ?? IDENTITY_TOKENS.nene)
  const exclude = new Set<string>()
  for (const token of identitySource) exclude.add(normalizeTag(token))
  META_TOKENS.forEach(token => exclude.add(token))

  // 跨角色特征单向隔离：单人抽取时，屏蔽其他主角的标志性外观特征
  if (!explicitIdentity && options.char !== 'triad') {
    if (options.char === 'nene') {
      for (const t of ['shiki_natsume', 'natsume', 'mole_under_eye', 'hairclip', 'two_red_hairclips', 'black_hair', 'yellow_eyes']) {
        exclude.add(normalizeTag(t))
      }
    } else if (options.char === 'natsume') {
      for (const t of ['ayachi_nene', 'nene', 'white_hair', 'purple_eyes', 'low_twintails', 'pink_hair_ribbons']) {
        exclude.add(normalizeTag(t))
      }
    }
  }

  const byCat = (cat: string): string[] =>
    options.tags.filter(tag => tag.cat === cat).map(tag => normalizeTag(tag.en)).filter(Boolean)

  const scenePool = byCat('Scene').filter(tag => !exclude.has(tag))
  const actionPool = byCat('Action').filter(tag => !exclude.has(tag))
  const appearancePool = byCat('Appearance').filter(tag => !exclude.has(tag))
  const stylePool = byCat('Style').filter(tag => !exclude.has(tag))
  const bodyPool = byCat('Body').filter(tag => BODY_MILD.has(tag))
  const maturePool = byCat('Mature').filter(tag => !exclude.has(tag) && !MATURE_HARDCORE.has(tag))
  const clothingPool = byCat('Clothing').filter(tag => !exclude.has(tag))

  const manualTags: string[] = []

  // ── 情绪（1~2，跨族） ────────────────────────────────────────────────
  const emotions: string[] = []
  const firstEmotion = draw(ALL_EMOTION_IDS, 1, rng)[0]
  if (firstEmotion) {
    emotions.push(firstEmotion)
    if (chance(0.3, rng)) {
      const family = EMOTION_FAMILY[firstEmotion]
      const secondPool = ALL_EMOTION_IDS.filter(id => EMOTION_FAMILY[id] !== family)
      const second = draw(secondPool, 1, rng)[0]
      if (second) emotions.push(second)
    }
  }

  // ── 色彩情调（50%，与情绪弱联动） ────────────────────────────────────
  let colorMood: string | null = null
  if (chance(0.5, rng)) {
    const linked = firstEmotion ? COLOR_MOOD_LINK[firstEmotion] : undefined
    const pool = linked && linked.length ? linked : ALL_COLOR_MOOD_IDS
    colorMood = draw(pool, 1, rng)[0] ?? null
  }

  // ── 镜头（100% 抽 1） + 构图（50%） ──────────────────────────────────
  const shot = draw(ALL_SHOT_IDS, 1, rng)[0] ?? null
  const composition = chance(0.5, rng) ? (draw(ALL_COMPOSITION_IDS, 1, rng)[0] ?? null) : null
  const isCloseUp = shot === 'close'

  // ── 光照（主光源 1 个 + 40% 叠逆光） ──────────────────────────────────
  let lighting: string | null = null
  if (chance(0.9, rng)) {
    lighting = draw(LIGHT_MAIN, 1, rng)[0] ?? null
    if (lighting && chance(0.4, rng)) {
      // back 逆光作为可叠加标签进入 manualTags（与主光源不互斥）
      addWithMutualGroup(manualTags, 'backlighting')
    }
  }

  // ── 场景（70% 1 个 / 30% 2 个，室内外互斥 + 核心建筑排他） ─────────
  const sceneCount = chance(0.7, rng) ? 1 : 2
  for (const scene of draw(scenePool, sceneCount, rng)) {
    if (!manualTags.length) {
      addWithMutualGroup(manualTags, scene)
      continue
    }
    const indoor = manualTags.some(tag => INDOOR_SCENE.has(tag))
    const outdoor = manualTags.some(tag => OUTDOOR_SCENE.has(tag))
    if (INDOOR_SCENE.has(scene) && outdoor) continue
    if (OUTDOOR_SCENE.has(scene) && indoor) continue
    const hasPrimaryLocation = manualTags.some(tag => PRIMARY_LOCATIONS.has(tag))
    if (hasPrimaryLocation && PRIMARY_LOCATIONS.has(scene)) continue
    addWithMutualGroup(manualTags, scene)
  }

  // ── 动作（60% 抽 1） ────────────────────────────────────────────────
  if (chance(0.6, rng)) {
    const action = draw(actionPool, 1, rng)[0]
    if (action) addWithMutualGroup(manualTags, action)
  }

  // ── 外观（60% 1 个 / 25% 2 个，已排除身份 token；特写镜头过滤下肢细节） ────
  const appearanceCandidates = isCloseUp
    ? appearancePool.filter(tag => !FOOTWEAR_EXCLUDE.has(tag))
    : appearancePool
  const appearanceCount = chance(0.6, rng) ? 1 : 0
  if (appearanceCount) {
    for (const item of draw(appearanceCandidates, chance(0.25, rng) ? 2 : 1, rng)) {
      addWithMutualGroup(manualTags, item)
    }
  }

  // ── 身体（50% 1 个，仅温和细节；特写镜头过滤下肢细节） ───────────────
  if (chance(0.5, rng)) {
    const bodyCandidates = isCloseUp
      ? bodyPool.filter(tag => !FOOTWEAR_EXCLUDE.has(tag))
      : bodyPool
    const body = draw(bodyCandidates, 1, rng)[0]
    if (body) addWithMutualGroup(manualTags, body)
  }

  // ── 风格媒介（30% 1 个，如 visual_novel_event_cg） ───────────────────
  if (chance(0.3, rng)) {
    const style = draw(stylePool, 1, rng)[0]
    if (style) addWithMutualGroup(manualTags, style)
  }

  // ── 服装（官方 60% / 通用 40%；triad 与热门角色不抽服装） ─────────────
  const officialOutfits = options.officialOutfits
  const officialKeys = officialOutfits ? Object.keys(officialOutfits) : []
  if (!explicitIdentity && options.char !== 'triad') {
    if (officialKeys.length && chance(0.6, rng)) {
      const key = draw(officialKeys, 1, rng)[0]
      if (key) {
        const tokens = (officialOutfits?.[key] ?? []).map(normalizeTag)
        const canonical = tokens[0]
        if (canonical) addWithMutualGroup(manualTags, canonical)
        // 额外补 0~2 个签名 token（官方套装通常 4~12 个 token，全塞会淹没画面）
        const extras = draw(tokens.slice(1), chance(0.5, rng) ? 2 : 1, rng)
        for (const extra of extras) addWithMutualGroup(manualTags, extra)
      }
    } else if (clothingPool.length) {
      const generic = draw(clothingPool, 1, rng)[0]
      if (generic) addWithMutualGroup(manualTags, generic)
    }
  }

  // ── Mature（50% 抽 1~4，无独立开关，本地直连本就放行） ──────────────
  // 2026-08-29 提额：20%→50%。此前的三重叠加（概率低 + isManualR18 正则只认
  // 5 个词 + 评级不升则负面压制）导致"想随机 NSFW 根本随机不到"；评级联动
  // 由 usePromptAssembly.isManualR18Tags（词条池 Mature 分类命中）兜住。
  if (maturePool.length && chance(0.5, rng)) {
    const roll = rng()
    const count = roll < 0.35 ? 1 : roll < 0.65 ? 2 : roll < 0.85 ? 3 : 4
    for (const tag of draw(maturePool, count, rng)) {
      addWithMutualGroup(manualTags, tag)
    }
  }

  // ── 画师（默认 0 位；includeArtists 开启后 0~2 位；keepArtists 恒保留） ──
  const artistPool = options.artists ?? []
  const keep = normalizeArtistStyleIds(options.keepArtists ?? [])
  const drawn: string[] = []
  if (options.includeArtists && artistPool.length) {
    const roll = rng()
    let count = 0
    if (roll < 0.6) count = 1
    else if (roll < 0.8) count = 2
    const excludeIds = new Set(keep)
    const candidates = artistPool.filter(artist => !excludeIds.has(artist.id))
    drawn.push(...draw(candidates.map(artist => artist.id), count, rng))
  }
  const artistStyleIds = normalizeArtistStyleIds([...keep, ...drawn])

  return {
    emotions,
    shot,
    lighting,
    composition,
    colorMood,
    manualTags,
    artistStyleIds,
  }
}
