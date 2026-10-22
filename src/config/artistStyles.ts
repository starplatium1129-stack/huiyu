import type { ArchiveIconName } from '../components/visual/icons/types.ts'
import { resolveDrawCapabilities } from '../utils/drawCapabilities.ts'

// Curated artist tags verified against the current Danbooru artist records and
// the Illustrious/Anima model tag indexes. WAI consumes canonical Danbooru tags;
// Anima's official prompt contract requires a leading @ and spaces.

export type ArtistStyleEngine = 'sd' | 'anima' | 'krea2'
export type ArtistStyleVerification = 'project' | 'curated' | 'tag'
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
  'kantoku shirabi bunbun morikura_en anmi rella mika_pikazo nardack fuzichoco hxxg swav so-bin muririn kobuichi yoneyama_mai hiten_(hitenkei) lam_(ramdayo) tiv lack ask_(askzy) azuuru paryi hisasi suimya tsunako atdan jazz_jack rucarachi kousaki_rui xinzoruo nekotomi_chao momoco_haru ponkan8 shirotaka abe_tsukasa fujiwara_cocoa kazutake_hazano fujimoto_tatsuki takeuchi_takashi gweda eufoniuz solar_(happymonk) alllisso mesilmen xiayehongming huanxiang_heitu liduke alchemaniac asano_kyoji isayama_hajime yokoyari_mengo wei_at_w hidulume yabuki_kentarou'.split(' '),
)

/** Lightweight sampling candidates derived from the same whitelist as normalization. */
export const ARTIST_STYLE_CANDIDATES: ReadonlyArray<Readonly<Pick<ArtistStyleOption, 'id'>>> =
  Object.freeze([...ARTIST_STYLE_IDS].map(id => Object.freeze({ id })))

const ARTIST_STYLE_ALIASES: Record<string, string> = {
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
      const tag = animaArtistTag(parsed.id)
      return parsed.weight !== 1 ? `(${tag}:${parsed.weight})` : tag
    }
    return parsed.weight !== 1 ? `(${parsed.id}:${parsed.weight})` : parsed.id
  }).filter(Boolean)
}

/**
 * Krea2 自然语言风格描述表：Danbooru 画师 tag 对 Krea2 无效，
 * 这里把画师风格转成 Krea2 能理解的英文散文风格描述。
 * 未收录的画师会退回 `in the style of {name}`。
 */
const KREA_ARTIST_PROSE: Record<string, string> = {
  yoneyama_mai: 'cinematic anime illustration with flowing dynamic lines, expressive mood lighting, and a film-like color palette',
  rella: 'ethereal anime illustration with dreamy night glow, luminous colors, and cinematic lighting',
  swav: 'high-impact fantasy poster art with magical lighting and strong spatial depth',
  hidulume: 'cinematic anime illustration with dynamic eye-tracking visual guidance, wide atmospheric perspective, and luminous translucent airiness',
  kantoku: 'clear and soft Japanese anime style with gentle sunlight, clean lines, and cute girls',
  momoco_haru: 'light novel illustration with glossy watery eyes, bright fair skin, and lively youthful charm',
  ponkan8: 'clear watercolor cel style with bright youthful spring atmosphere',
  shirotaka: 'delicate fantasy adventure illustration with soft watery highlights and refined detail',
  abe_tsukasa: 'classical cinematic fantasy illustration with dignified composition and quiet atmosphere',
  fujiwara_cocoa: 'gothic cool moe style with clean elegant lines and a touch of mystery',
  kazutake_hazano: 'warm healing illustration with gentle holy soft lines and comforting atmosphere',
  azuuru: 'ethereal watercolor style with translucent hair and a wandering traveler mood',
  'hiten_(hitenkei)': 'soft light Japanese illustration with refined features and clear healing air',
  tiv: 'light novel cover style with delicate ambient light and flowing hair',
  anmi: 'light macaron pastel watercolor style with graceful elegant figures',
  tsunako: 'bright cute anime girl style with vivid colors and energetic charm',
  morikura_en: 'bright commercial character art with natural everyday light and energetic mood',
  paryi: 'popular beautiful girl illustration with silky hair and bright clear eyes',
  muririn: 'Yuzusoft-style bright cel shading with rounded faces and clear transparent skin',
  kobuichi: 'Yuzusoft-style crisp cel art with clean outlines and vivid colors',
  nekotomi_chao: 'Doga Kobo-style lively delicate cel shading with expressive fine lines',
  atdan: 'pure adult-oriented anime style with delicate skin and shy expressions',
  jazz_jack: 'refreshing energetic anime style with clean lines and lively girls',
  hisasi: 'classic adult-oriented soft coloring with sweet shy atmosphere',
  suimya: 'soft erotic atmosphere with moist glossy highlights and lazy intimate mood',
  rucarachi: 'delicate game character fan art with fine linework, soft harmonious coloring, and charming bright-eyed girls',
  'lam_(ramdayo)': 'highly saturated neon trendy illustration with bold eye makeup and graphic composition',
  mika_pikazo: 'vivid pop art anime style with bold geometric color blocking and energetic vibes',
  bunbun: 'dynamic game key visual style with clear costume design and action pose',
  fujimoto_tatsuki: 'raw cinematic manga style with rough textures and intense emotional tension',
  takeuchi_takashi: 'TYPE-MOON style dignified anime illustration with sharp determined eyes and iconic servant designs',
  shirabi: 'bold dramatic anime illustration with strong outlines and theatrical lighting',
  'ask_(askzy)': 'cool noble anime illustration with silky smooth coloring and restrained elegance',
  hxxg: 'dynamic wide-angle perspective with colorful special effects and deep spatial composition',
  nardack: 'jewel-toned fantasy illustration with luxurious costumes and sparkling details',
  fuzichoco: 'ornate Japanese fantasy style with layered watercolor and decorative details',
  lack: 'rich fantasy thick painting with mature heavy colors and epic atmosphere',
  'so-bin': 'dark gothic oil painting style with heavy fabrics and solemn epic mood',
  kousaki_rui: 'refined elegant FGO-style illustration with graceful coloring and majestic atmosphere',
  xinzoruo: 'seductive dark anime style with deep chiaroscuro and dangerous atmosphere',
  gweda: 'delicate Korean-style anime illustration with soft thick-paint shading, glossy glass-like eyes, and refined beautiful girls',
  eufoniuz: 'soft adult-oriented anime fan art with cute rounded girls, smooth skin shading, and intimate sweet atmosphere',
  'solar_(happymonk)': 'glossy adult-oriented game character fan art with bright skin, seductive poses, and vibrant colors',
  alllisso: 'polished anime game character fan art with clean lineart, vibrant colors, and appealing soft shading',
  mesilmen: 'soft adult-oriented anime game fan art with smooth skin shading, expressive eyes, and intimate sweet atmosphere',
  xiayehongming: 'Chinese illustration with bold color-block rendering without outlines, strong light-dark contrast, and classical oriental elegance',
  huanxiang_heitu: 'ornate Chinese fantasy illustration with divine-demonic motifs, intricate decorative details, and luminous elegant figures',
  liduke: 'soft delicate thick-paint illustration with gentle light diffusion, warm skin tones, and serene feminine charm',
  alchemaniac: 'cool melancholic illustration with deep sea atmosphere, subdued palette, and refined elegant lines',
  asano_kyoji: 'dramatic WIT Studio anime style with bold dark line art, sharp expressive eyes, dynamic motion tension, and gritty cinematic atmosphere',
  isayama_hajime: 'intense gritty manga illustration with raw emotional tension, deep shadowed eyes, and powerful resolute expression',
  yokoyari_mengo: 'expressive anime manga style with luminous starry eyes, delicate emotional linework, and radiant idol highlights',
  wei_at_w: 'sleek futuristic concept art with tactical techwear design, sharp clean lines, and atmospheric cool lighting',
  yabuki_kentarou: 'clean delicate anime illustration with translucent skin, glossy expressive eyes, soft blush, and refined soft-cel coloring in classic romantic comedy manga style',
}

export function artistStyleProse(ids: readonly string[], engine: ArtistStyleEngine = 'sd'): string {
  const normalized = normalizeArtistStyleIds(ids)
  if (!normalized.length) return ''
  const parsedList = normalized.map(parseArtistStyleItem).filter((item): item is ParsedArtistStyle => Boolean(item))
  if (!parsedList.length) return ''
  if (engine === 'krea2') {
    return parsedList.map(item => {
      const base = KREA_ARTIST_PROSE[item.id] || `in the style of ${artistDisplayName(item.id)}`
      if (item.weight >= 1.1) return `strongly featuring ${base}`
      if (item.weight <= 0.8) return `with subtle hints of ${base}`
      return base
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
