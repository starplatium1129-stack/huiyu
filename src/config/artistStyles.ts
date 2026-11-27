import type { ArchiveIconName } from '../components/visual/icons/types.ts'
import { resolveDrawCapabilities } from '../utils/drawCapabilities.ts'

// Curated artist tags verified against the current Danbooru artist records and
// the Illustrious/Anima model tag indexes. WAI consumes canonical Danbooru tags;
// Anima artist names use @ and spaces, while named styles remain ordinary tags.

export type ArtistStyleEngine = 'sd' | 'anima' | 'krea2'
export type ArtistStyleVerification = 'project' | 'curated' | 'tag' | 'style'
export type ArtistCategory = 'cinematic' | 'pure' | 'trend' | 'grand'

export interface ArtistStyleOption {
  id: string
  name: string
  cnName?: string
  waiTag: string
  animaTag: string
  description: string
  masterpiece?: string
  verification: ArtistStyleVerification
  category?: ArtistCategory
  keywords?: string[]
}

export interface ParsedArtistStyle {
  id: string
  weight: number
}

export type { ArtistComboPreset } from './artistComboPresets.ts'

export const ARTIST_CATEGORIES: ReadonlyArray<{ id: 'all' | ArtistCategory; label: string; icon: ArchiveIconName }> = [
  { id: 'all', label: '全部', icon: 'palette' },
  { id: 'cinematic', label: '电影光影', icon: 'wideshot' },
  { id: 'pure', label: '清透少女', icon: 'flower' },
  { id: 'trend', label: '潮流先锋', icon: 'lightning' },
  { id: 'grand', label: '华丽厚涂', icon: 'manager' },
] as const

const ARTIST_STYLE_IDS = new Set(
  'kantoku shirabi bunbun morikura_en anmi rella mika_pikazo nardack fuzichoco hxxg swav so-bin muririn kobuichi yoneyama_mai hiten_(hitenkei) lam_(ramdayo) tiv lack ask_(askzy) azuuru paryi hisasi suimya mignon tsunako atdan jazz_jack rucarachi kousaki_rui xinzoruo nekotomi_chao momoco_haru ponkan8 shirotaka abe_tsukasa fujiwara_cocoa kazutake_hazano fujimoto_tatsuki takeuchi_takashi gweda eufoniuz solar_(happymonk) alllisso mesilmen xiayehongming huanxiang_heitu liduke alchemaniac namie-kun ryuuzaki_ichi sho_(sho_lwlw) banban_(vvvviiiiiia) norizc yuji_(fantasia) lm7_(op-center) cenm0 chuzenji skade wenquangua infukun m9nokuro starshadowmagician five-fall asano_kyoji isayama_hajime yokoyari_mengo wei_at_w hidulume yabuki_kentarou betanonbeet blue_archive_style oouso okkimon uof dairi ebifurya hammer_(sunset_beach) haruyama_kazunori ruu_(tksymkw) itomugi-kun yaegashi_nan mizuki_hitoshi kouji_(campus_life) kanon_(kurogane_knights)'.split(' '),
)

/** Lightweight sampling candidates derived from the same whitelist as normalization. */
export const ARTIST_STYLE_CANDIDATES: ReadonlyArray<Readonly<Pick<ArtistStyleOption, 'id'>>> =
  Object.freeze([...ARTIST_STYLE_IDS].map(id => Object.freeze({ id })))

const ARTIST_STYLE_ALIASES: Record<string, string> = {
  Uof: 'uof',
  UOF: 'uof',
  uof1052237: 'uof',
  Okkimon: 'okkimon',
  _okkizzz: 'okkimon',
  okkizzz: 'okkimon',
  azure: 'azuuru',
  'azure_(azure_cpt)': 'azuuru',
  azuuru: 'azuuru',
  nekotomi: 'nekotomi_chao',
  nekotomi_chao: 'nekotomi_chao',
  momoco: 'momoco_haru',
  'momoco_(momopoco)': 'momoco_haru',
  momoco_haru: 'momoco_haru',
  gweda8593: 'gweda',
  eufoniuz1026: 'eufoniuz',
  'SOLar_Bim': 'solar_(happymonk)',
  solar_bim: 'solar_(happymonk)',
  alllisso_: 'alllisso',
  anon: 'betanonbeet',
  betabeet: 'betanonbeet',
  // 明日方舟系画师别名（2026-08-31 调研收录，Danbooru 主 tag 与 pixiv/微博名映射）
  shimonokun: 'xiayehongming',
  'xiaye_hongming': 'xiayehongming',
  hohoanime: 'xiayehongming',
  'gensou_kuro_usagi': 'huanxiang_heitu',
  'huanxiang_heitu': 'huanxiang_heitu',
  '幻想黑兔': 'huanxiang_heitu',
  'li_duke': 'liduke',
  '麻痹的小日子': 'liduke',
  'gilangak92': 'alchemaniac',
  'alchemaniaC': 'alchemaniac',
  namie: 'namie-kun',
  nambarimasu: 'namie-kun',
  namgoreng: 'namie-kun',
  ryuzakiichi: 'ryuuzaki_ichi',
  '竜崎いち': 'ryuuzaki_ichi',
  sho_lwlw: 'sho_(sho_lwlw)',
  masarustrongest: 'sho_(sho_lwlw)',
  '轟将': 'sho_(sho_lwlw)',
  vvvviiiiiia: 'banban_(vvvviiiiiia)',
  '板板': 'banban_(vvvviiiiiia)',
  yuji: 'yuji_(fantasia)',
  lm7: 'lm7_(op-center)',
  '温泉瓜': 'wenquangua',
  'STAR影法师': 'starshadowmagician',
  '伍秋秋秋秋': 'five-fall',
  fivefallall: 'five-fall',
  // 巨人、我推、终末地原画师别名
  asano: 'asano_kyoji',
  'asano kyoji': 'asano_kyoji',
  '浅野恭司': 'asano_kyoji',
  isayama: 'isayama_hajime',
  'isayama hajime': 'isayama_hajime',
  '谏山创': 'isayama_hajime',
  mengo: 'yokoyari_mengo',
  'yokoyari mengo': 'yokoyari_mengo',
  '横枪萌果': 'yokoyari_mengo',
  'wei': 'wei_at_w',
  'wei_w': 'wei_at_w',
  '唯@w': 'wei_at_w',
  '唯@W': 'wei_at_w',
  'hidulme': 'hidulume',
  'hidzz': 'hidulume',
  'ひづるめ': 'hidulume',
  // 出包王女 / 矢吹健太朗
  yabuki: 'yabuki_kentarou',
  'yabuki kentaro': 'yabuki_kentarou',
  'yabuki kentarou': 'yabuki_kentarou',
  '矢吹健太朗': 'yabuki_kentarou',
  '矢吹': 'yabuki_kentarou',
}

function artistDisplayName(id: string): string {
  if (id === 'azuuru') return 'Azure'
  return id.replace(/_\(.+$/, '').replace(/_/g, ' ').replace(/\b[a-z]/g, letter => letter.toUpperCase())
}

export const DEFAULT_ARTIST_STYLE_LIMIT = 3

export function parseArtistStyleItem(item: unknown): ParsedArtistStyle | null {
  const trimmed = String(item || '').trim()
  if (!trimmed) return null
  const colonIdx = trimmed.indexOf(':')
  let id = colonIdx >= 0 ? trimmed.slice(0, colonIdx).trim() : trimmed
  if (ARTIST_STYLE_ALIASES[id]) id = ARTIST_STYLE_ALIASES[id]
  if (!ARTIST_STYLE_IDS.has(id)) return null
  let weight = 1
  if (colonIdx >= 0) {
    const parsed = parseFloat(trimmed.slice(colonIdx + 1).trim())
    if (!Number.isNaN(parsed) && parsed > 0 && parsed <= 2) {
      weight = Math.round(parsed * 100) / 100
    }
  }
  return { id, weight }
}

export function serializeArtistStyleItem(id: string, weight = 1): string {
  const rounded = Math.round(weight * 100) / 100
  return rounded !== 1 ? `${id}:${rounded}` : id
}

export function normalizeArtistStyleIds(value: unknown, limit = DEFAULT_ARTIST_STYLE_LIMIT): string[] {
  if (!Array.isArray(value)) return []
  const result: string[] = []
  const seenIds = new Set<string>()
  for (const raw of value) {
    const parsed = parseArtistStyleItem(raw)
    if (!parsed || seenIds.has(parsed.id)) continue
    seenIds.add(parsed.id)
    result.push(serializeArtistStyleItem(parsed.id, parsed.weight))
    if (result.length >= limit) break
  }
  return result
}

/** Artist names from the catalogue or the pinned PixAI v1.0 artist-style vocabulary. */
export function animaArtistTag(name: string): string {
  return `@${name.trim().replace(/^@/, '').replace(/_/g, ' ').replace(/\\([()])/g, '$1').replace(/[()]/g, '\\$&')}`
}

export function artistTagsForEngine(ids: readonly string[], engine: ArtistStyleEngine): string[] {
  const capabilities = resolveDrawCapabilities(engine)
  if (capabilities.promptFormat === 'natural-language') return []
  return normalizeArtistStyleIds(ids).map(item => {
    const parsed = parseArtistStyleItem(item)
    if (!parsed) return ''
    if (capabilities.promptFormat === 'anima-tags') {
      const tag = parsed.id === 'blue_archive_style' ? 'blue archive style' : animaArtistTag(parsed.id)
      return parsed.weight !== 1 ? `(${tag}:${parsed.weight})` : tag
    }
    return parsed.weight !== 1 ? `(${parsed.id}:${parsed.weight})` : parsed.id
  }).filter(Boolean)
}

/**
 * Krea 2 自然语言光学/色彩/笔触风格描述表：
 * Krea 2（Qwen3-VL-4B 编码器）不直接识别 Danbooru 画师名，但对具体的
 * 色彩色相、光学折射、笔触媒介、线稿密度和空间空气感高度敏感。
 */
const KREA_ARTIST_PROSE: Record<string, string> = {
  blue_archive_style: 'crisp modern Japanese anime game illustration with radiant sky-blue and sunlit white color harmony, clean airy linework, bright translucent shading, and refreshing youthful clarity',
  yoneyama_mai: 'high-craft theatrical Japanese anime illustration with sweeping kinetic linework, prismatic chromatic aberration at light edges, translucent backlit hair strands, expressive teal-coral-and-amber color contrast, and cinematic shallow depth of field',
  rella: 'museum-grade Japanese anime illustration with luminous pearlescent coloring, crystalline light refraction, ultra-fine delicate linework, translucent backlit hair strands, iridescent turquoise-gold-and-sapphire shadow harmony, and ethereal poetic grandeur',
  swav: 'grand cinematic fantasy anime key illustration with sweeping architectural perspective, dramatic volumetric light shafts, glowing arcane rim lighting, painterly brushwork, and monumental atmospheric depth',
  hidulume: 'expansive theatrical Japanese anime illustration with dynamic wide-angle visual flow, luminous translucent airiness, sparkling floating light particles, crisp backlit silhouettes, and radiant sky-to-shadow atmospheric perspective',
  kantoku: 'luminous modern Japanese anime illustration with crisp fine linework, translucent dappled sunlight filtering across silky hair and fluttering fabrics, vibrant clear color harmony, and refreshing airy atmosphere',
  momoco_haru: 'delicate modern light novel anime illustration with jewel-like glistening eyes, translucent fair skin with soft warm subsurface glow, fine feather-light hair strands, and dreamy pastel-lit clarity',
  ponkan8: 'airy Japanese light novel watercolor-anime illustration with translucent layered color washes, fine crisp ink linework, warm sunlit spring highlights, and expressive emotional delicacy',
  shirotaka: 'refined fantasy light novel anime illustration with translucent watery specular highlights, delicate ornate fabric folds, airy atmospheric depth, and poetic sunlit color harmony',
  abe_tsukasa: 'classical theatrical fantasy anime illustration with restrained dignified linework, soft natural painterly light, muted pastoral-and-twilight tones, and serene contemplative spatial depth',
  fujiwara_cocoa: 'elegant gothic Japanese anime illustration with crisp delicate linework, deep velvet-indigo and ivory color contrast, translucent crystalline highlights, and refined melancholic grace',
  kazutake_hazano: 'warm healing Japanese anime illustration with gossamer soft linework, radiant golden ambient light diffusion, translucent pearlescent tones, and gentle poetic serenity',
  azuuru: 'ethereal Japanese watercolor-anime illustration with luminous translucent hair strands, soft prismatic light scatter, airy turquoise-and-amber washes, and expansive wandering atmosphere',
  'hiten_(hitenkei)': 'luminous high-craft Japanese anime illustration with ultra-fine delicate linework, warm translucent sunlight glow across hair and skin, sparkling bokeh particles, and tender cinematic clarity',
  tiv: 'graceful modern light novel cover anime illustration with flowing windblown hair, luminous translucent ambient light, delicate pearlescent highlights, and refined pastel-jewel color harmony',
  anmi: 'luminous pastel watercolor-anime illustration with delicate balletic linework, translucent macaron-toned glazing, soft sunlit sparkle on fabrics, and airy graceful elegance',
  tsunako: 'vibrant modern Japanese anime key illustration with sparkling multi-layered jewel eyes, crisp fine linework, luminous candy-and-celestial gradients, and energetic radiant highlights',
  morikura_en: 'fresh modern Japanese anime illustration with clean expressive linework, bright translucent natural daylight, soft warm skin bounce light, and crisp contemporary color clarity',
  paryi: 'high-craft modern anime character illustration with lustrous silky hair strands, crystalline bright eyes, delicate crisp linework, and translucent luminous color shading',
  muririn: 'refined modern Japanese anime illustration with crisp translucent shading, luminous pastel-warm skin tones, sparkling clear eyes, and delicate clean linework',
  kobuichi: 'vibrant modern Japanese anime illustration with crisp expressive linework, luminous saturated color accents, clean translucent highlights, and polished character clarity',
  nekotomi_chao: 'lively theatrical Japanese anime illustration with delicate fine linework, expressive translucent light-and-shadow modeling, soft ambient rim glow, and airy emotional warmth',
  atdan: 'exquisite modern Japanese anime illustration with translucent luminous skin rendering, delicate fine linework, glossy subtle light reflections on fabrics and water, and intimate soft ambient glow',
  jazz_jack: 'crisp vibrant Japanese anime illustration with confident clean linework, luminous sunlit color contrast, expressive dynamic framing, and refreshing translucent highlights',
  hisasi: 'soft luminous modern Japanese anime illustration with smooth translucent skin shading, warm ambient blush tones, fine clean linework, and tender intimate light',
  suimya: 'intimate luminous Japanese anime illustration with moist pearlescent skin highlights, translucent warm indoor light, delicate silky hair rendering, and dreamy atmospheric softness',
  mignon: 'high-craft Japanese anime illustration with extraordinarily translucent luminous skin shading, delicate fine linework, soft subsurface warmth, glistening highlights, and intimate clarity',
  rucarachi: 'delicate modern Japanese anime illustration with fine crisp linework, soft harmonious luminous coloring, expressive sparkling eyes, and refined atmospheric polish',
  'lam_(ramdayo)': 'striking contemporary neon-pop anime illustration with intense chromatic contrast, jewel-sharp luminous eye details, bold directional rim light, and sleek graphic visual impact',
  mika_pikazo: 'vivid avant-garde pop-art Japanese anime illustration with dazzling electric color contrast, luminous prismatic highlights, bold graphic framing, and kinetic modern energy',
  bunbun: 'dynamic modern Japanese anime key illustration with sleek precise linework, dramatic directional backlighting, rich costume material sheen, and cinematic spatial momentum',
  fujimoto_tatsuki: 'raw cinematic Japanese anime-manga illustration with expressive textured ink linework, stark dramatic lighting contrast, moody muted film colors, and visceral emotional tension',
  takeuchi_takashi: 'dignified theatrical Japanese anime key visual with sharp noble eye expression, crisp refined linework, dramatic backlit aura, and stately ceremonial color contrast',
  shirabi: 'dramatic modern Japanese anime illustration with crisp decisive linework, theatrical directional light-and-shadow modeling, rich saturated accents, and atmospheric depth',
  'ask_(askzy)': 'refined noble Japanese anime illustration with ultra-smooth silky painterly shading, cool pearl-and-crimson color harmony, delicate translucent light falloff, and restrained poetic elegance',
  hxxg: 'breathtaking wide-angle theatrical anime illustration with sweeping dramatic perspective, radiant chromatic light effects, layered luminous particles, and colossal spatial depth',
  nardack: 'opulent jewel-toned fantasy anime illustration with intricate gilded embroidery, sparkling crystalline light scatter, delicate linework, and rich royal color harmony',
  fuzichoco: 'ornate luminous Japanese fantasy anime illustration with richly layered translucent watercolor-and-ink detail, kaleidoscope-like floral and architectural motifs, and radiant atmospheric glow',
  lack: 'richly painted epic fantasy anime illustration with sculpted painterly brushwork, dramatic chiaroscuro fire-and-twilight lighting, heavy material textures, and grand heroic weight',
  'so-bin': 'dark gothic painterly anime illustration with expressive oil-and-ink brushwork, luminous golden-crimson highlights emerging from deep obsidian shadows, and solemn mythic grandeur',
  kousaki_rui: 'majestic refined Japanese fantasy anime illustration with graceful delicate linework, luminous translucent silk and metallic sheen, and stately atmospheric lighting',
  xinzoruo: 'seductive dark gothic anime illustration with deep dramatic chiaroscuro, luminous crimson-and-moonlit skin highlights, glossy dark textures, and mysterious nocturnal tension',
  gweda: 'high-craft luminous East Asian anime illustration with silky painterly translucent shading, crystalline glass-like eyes, soft pearlescent rim light, and refined atmospheric elegance',
  eufoniuz: 'soft luminous modern Japanese anime illustration with smooth translucent skin shading, warm golden ambient glow, delicate fine linework, and tender intimate atmosphere',
  'solar_(happymonk)': 'vibrant glossy modern Japanese anime illustration with radiant luminous skin highlights, rich saturated colors, crisp fine linework, and dramatic warm rim lighting',
  alllisso: 'refined modern Japanese anime illustration with crisp fine linework, luminous translucent shading, harmonious vibrant colors, and clean atmospheric depth',
  mesilmen: 'tender luminous modern Japanese anime illustration with smooth translucent skin rendering, expressive sparkling eyes, soft golden rim light, and intimate atmospheric warmth',
  betanonbeet: 'clean modern Japanese anime illustration with refined fine linework, luminous translucent shading, harmonious color tones, and airy atmospheric clarity',
  xiayehongming: 'painterly Eastern fantasy anime illustration with sculpted color-block light planes, bold dramatic warm-cool contrast, flowing ink-like silhouettes, and classical poetic elegance',
  huanxiang_heitu: 'ornate celestial Eastern fantasy anime illustration with intricate gilded motifs, luminous jade-and-gold light dispersion, translucent flowing silks, and transcendent mythic atmosphere',
  liduke: 'silky high-craft painterly anime illustration with gentle luminous light diffusion, refined muted-warm and cool-slate color harmony, subtle fabric textures, and serene poise',
  alchemaniac: 'ethereal cool-toned anime illustration with deep-sea cerulean and pearl-silver palette, delicate flowing ink lines, translucent watery light caustics, and poetic melancholy',
  'namie-kun': 'delicate luminous anime illustration with dreamy pastel-jewel coloring, sparkling translucent eyes, soft feather-light hair shading, and airy poetic charm',
  ryuuzaki_ichi: 'refined dark-fantasy anime illustration with cool slate-and-silver color restraint, intricate tailored costume detail, crisp fine linework, and moody atmospheric depth',
  'sho_(sho_lwlw)': 'finely crafted atmospheric anime illustration with soft directional light, richly textured layered fabrics, delicate fine linework, and serene spatial depth',
  'banban_(vvvviiiiiia)': 'dramatic high-fashion anime illustration with bold crisp silhouettes, striking warm-and-cool directional lighting, refined textile sheen, and editorial cinematic tension',
  norizc: 'luminous fantasy anime illustration with airy translucent fabrics, sparkling natural light refraction, delicate fine linework, and expansive sunlit atmosphere',
  'yuji_(fantasia)': 'vibrant luminous fantasy anime illustration with jewel-bright transparent colors, delicate ornate details, playful sunlit bokeh, and crisp airy clarity',
  'lm7_(op-center)': 'stylized high-craft anime concept illustration with razor-sharp silhouettes, subtle weathered textures, cool atmospheric lighting, and striking graphic poise',
  cenm0: 'expressive modern anime character illustration with crisp dynamic linework, lively luminous color accents, detailed layered attire, and fresh directional light',
  chuzenji: 'refined atmospheric anime illustration with delicate razor-fine linework, cool poetic twilight lighting, subtle fabric luster, and quiet cinematic elegance',
  skade: 'aristocratic atmospheric anime illustration with elongated graceful silhouettes, cool silver-blue and muted crimson tones, soft luminous mist, and refined painterly depth',
  wenquangua: 'delicate luminous anime illustration with soft pearlescent color transitions, expressive fine linework, airy light diffusion, and refined character grace',
  infukun: 'bold architectural anime concept illustration with crisp commanding silhouettes, dramatic directional rim lighting, sleek dark-and-accent color contrast, and sharp presence',
  m9nokuro: 'elegant minimalist-toned anime illustration with restrained monochrome-and-jewel accents, crisp fine linework, soft overcast studio lighting, and refined texture detail',
  starshadowmagician: 'radiant celestial anime illustration with sparkling iridescent light particles, luminous sapphire-and-gold color harmony, intricate flowing garments, and dreamy grandeur',
  'five-fall': 'expressive modern anime illustration with striking graphic silhouettes, crisp confident linework, vivid directional light accents, and rich atmospheric polish',
  asano_kyoji: 'dramatic theatrical anime film frame with expressive dark ink linework, sharp intense eye focus, kinetic motion energy, and gritty sunlit cinematic depth',
  isayama_hajime: 'intense raw Japanese manga-anime illustration with textured expressive ink hatching, stark shadowed eyes, heavy dramatic light contrast, and gripping emotional weight',
  yokoyari_mengo: 'dazzling modern Japanese anime illustration with luminous starry crystalline eyes, delicate glowing highlights, vibrant magenta-cyan chromatic light, and glossy theatrical polish',
  wei_at_w: 'sleek futuristic anime concept illustration with sharp architectural linework, cool cyan-and-steel atmospheric lighting, crisp tactical fabric textures, and cinematic depth',
  yabuki_kentarou: 'exquisite luminous Japanese anime illustration with ultra-smooth translucent skin shading, glistening expressive eyes, delicate fine linework, and warm airy clarity',
}

export function artistStyleProse(ids: readonly string[], engine: ArtistStyleEngine = 'sd'): string {
  const normalized = normalizeArtistStyleIds(ids)
  if (!normalized.length) return ''
  const parsedList = normalized.map(parseArtistStyleItem).filter((item): item is ParsedArtistStyle => Boolean(item))
  if (!parsedList.length) return ''
  if (engine === 'krea2') {
    return parsedList.map((item, index) => {
      const base = KREA_ARTIST_PROSE[item.id] || `high-craft Japanese anime illustration inspired by ${artistDisplayName(item.id)}`
      if (index === 0) {
        if (item.weight >= 1.1) return `${base}, rendered with heightened stylistic intensity`
        if (item.weight <= 0.8) return `${base}, applied with a restrained subtle touch`
        return base
      }
      if (item.weight >= 1.1) return `strongly blended with ${base}`
      if (item.weight <= 0.8) return `accented with subtle hints of ${base}`
      return `blended with ${base}`
    }).join(', ')
  }
  const names = parsedList.map(item => {
    const name = artistDisplayName(item.id)
    if (item.weight >= 1.1) return `${name} (dominant)`
    if (item.weight <= 0.8) return `${name} (subtle)`
    return name
  })
  if (names.length === 1) return `with visual styling inspired by ${names[0]}`
  if (names.length === 2) return `with visual styling inspired by ${names[0]} and ${names[1]}`
  return `with visual styling inspired by ${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`
}
