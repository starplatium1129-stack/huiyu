import { EXACT_MEANINGS } from './tagMeaningExact'

const WORD_MEANINGS: Record<string, string> = {
  all: '全部', angle: '角度', angel: '天使', apron: '围裙', at: '在', back: '背部',
  background: '背景', beach: '海边', black: '黑色', blue: '蓝色', body: '身体', both: '双手',
  bow: '蝴蝶结', bookstore: '书店', brown: '棕色', bun: '发髻', camera: '镜头', campus: '校园',
  casual: '日常', chair: '椅子', china: '旗袍', chinese: '中式', city: '城市',
  classroom: '教室', clear: '晴朗', clothes: '服装', close: '近景', closed: '闭合', composition: '构图',
  contact: '接触', cream: '奶油色', cute: '可爱', dark: '深色', day: '白天', desk: '书桌',
  detailed: '细节丰富', dim: '昏暗', direct: '直接', double: '双重', dress: '连衣裙',
  even: '均匀', expression: '表情', eye: '眼睛', eyes: '眼睛', face: '脸部', flower: '花朵',
  focus: '重点', floral: '花卉', footwear: '鞋履', full: '全身', girl: '女孩', gold: '金色',
  golden: '金色', hair: '头发', hall: '大厅', hand: '手', hands: '双手', high: '高',
  jacket: '外套', lecture: '讲堂', light: '光线', lighting: '光照', long: '长',
  looking: '看向', low: '低', maid: '女仆', medium: '中景', morning: '早晨', natural: '自然',
  night: '夜晚', notes: '笔记', official: '官方', one: '一件', open: '打开', outfit: '服装',
  pants: '长裤', pantyhose: '连裤袜', pillow: '枕头', pink: '粉色', portrait: '肖像',
  proportions: '比例', qipao: '旗袍', red: '红色', reserved: '克制', ribbon: '发带', room: '房间',
  school: '学校', scene: '场景', seat: '座位', shirt: '衬衫', shot: '镜头',
  shy: '害羞', side: '侧面', simple: '简单', sky: '天空', skirt: '裙子', slit: '开衩',
  small: '小型', soft: '柔和', standing: '站立', summer: '夏日',
  trim: '饰边', uniform: '制服', university: '大学', viewer: '镜头', warm: '暖色', white: '白色',
  wide: '广角', window: '窗边', with: '搭配', yellow: '黄色',
  // 高频补充（绘制台常用词条）
  blush: '脸红', smile: '微笑', gentle: '温柔', sad: '失落', angry: '生气',
  surprised: '惊讶', shy_look: '害羞神情',
  tears: '眼泪', crying: '哭泣', laughing: '大笑', wink: '眨眼',
  waiting: '等待', walking: '走路', running: '奔跑', sitting: '坐着', lying: '躺着', kneeling: '跪坐',
  leaning: '倚靠', jumping: '跳跃', sleeping: '睡觉', eye_contact: '眼神接触', feeding: '喂食',
  hugging: '拥抱', resting: '休息', stretching: '伸展', umbrella: '雨伞',
  backpack: '背包', handbag: '手袋', holding_item: '手持物品', holding_cup: '端着杯子',
  holding_book: '拿着书', books: '书本', papers: '文件',
  afternoon: '午后', evening: '傍晚', noon: '正午', sunrise: '日出',
  weather: '天气', rain: '雨', rainy: '下雨', snow: '雪', snowing: '下雪', cloudy: '多云',
  storm: '暴风雨', thunder: '雷', lightning: '闪电', fog: '雾', mist: '薄雾', wind: '风',
  breeze: '微风', cloud: '云', clouds: '云朵', moonlight: '月光', stars: '星星', starry: '星空',
  petals: '花瓣', blossom: '花朵', sakura: '樱花', cherry: '樱花', autumn: '秋天', winter: '冬天',
  fireworks: '烟花', lantern: '灯笼', candle: '蜡烛',
  candlelight: '烛光', neon: '霓虹', bright: '明亮', shadow: '阴影', shadows: '阴影',
  glow: '微光', sparkle: '闪光', sparkles: '闪光', gradient: '渐变',
  neon_lighting: '霓虹灯光', colorful: '多彩', purple: '紫色', violet: '紫罗兰', lavender: '薰衣草色',
  silver: '银色', gray: '灰色', grey: '灰色', green: '绿色', blonde: '金色',
  brunette: '棕发', twintails: '双马尾', ponytail: '单马尾', braid: '辫子', ahoge: '呆毛',
  bangs: '刘海', fringe: '刘海', hairclip: '发夹', hairpins: '发卡', hair_ornament: '发饰',
  loose_hair: '散发', wet_hair: '湿发', straight_hair: '直发', curly_hair: '卷发',
  pleated: '百褶', plaid: '格纹', striped: '条纹', blazer: '西装外套', sailor: '水手服',
  serafuku: '水手服', cardigan: '开衫', turtleneck: '高领', sweater: '毛衣', hoodie: '连帽卫衣',
  coat: '外套', trench_coat: '风衣', fur: '毛皮', kimono: '和服', yukata: '浴衣', furisode: '振袖',
  cheongsam: '旗袍', hanbok: '韩服', swimsuit: '泳装', bikini: '比基尼', pajamas: '睡衣',
  sleepwear: '睡衣', nightgown: '睡裙', bath_towel: '浴巾', miko: '巫女',
  shrine: '神社', temple: '寺庙', park: '公园', garden: '花园', rooftop: '天台', balcony: '阳台',
  hallway: '走廊', corridor: '走廊', library: '图书馆', kitchen: '厨房', dining: '餐厅',
  onsen: '温泉', bath: '浴室', bathroom: '浴室', train: '电车', station: '车站', bus: '公交',
  street: '街道', road: '道路', river: '河流', bridge: '桥', forest: '森林', mountain: '山',
  sea: '大海', pool: '泳池', gymnasium: '体育馆', arcade: '游戏厅',
  convenience_store: '便利店', supermarket: '超市', greenhouse: '温室', music_room: '音乐教室',
  piano: '钢琴', telescope: '望远镜', observatory: '天文台', clock: '时钟', phone: '手机',
  bench: '长椅', swing: '秋千', slide: '滑梯', ferris_wheel: '摩天轮', rooftop_garden: '屋顶花园',
  autumn_leaves: '秋叶', maple: '枫叶', ivy: '常春藤', grass: '草地', field: '田野',
  hill: '山坡', waterfall: '瀑布', pond: '池塘', fountain: '喷泉', snowman: '雪人',
  icicle: '冰凌', frost: '霜', dew: '露珠', rainbow: '彩虹', aurora: '极光', galaxy: '银河',
} as const

const GENERIC_MEANINGS = new Set(['场景词条', '场景成人词', 'v18 训练服装词'])

// WD14 反推高频词条中英词典（2026-08-29 新增，同 chunk 懒加载）。
import { WD14_ZH } from './tagMeaningZh'
import tagDictionary from '../../data/tags-dictionary.json'

function cleanTag(tag: string): string {
  let raw = String(tag || '')
    .replace(/^\s*<lora:|>\s*$/gi, '')
    .trim()
  // 仅当整词被括号整体包裹时才剥括号（如 (masterpiece:1.2) 加权语法）；
  // WD14 角色词尾的 (fate)/(genshin_impact) 等括号是词条的一部分，不能剥。
  if (/^\(.+\)$/.test(raw)) raw = raw.replace(/^\(+|\)+$/g, '')
  raw = raw.replace(/:\s*-?\d+(?:\.\d+)?\s*$/g, '')
  return raw.toLowerCase().replace(/[\s\-/]+/g, '_')
}

const PREPOSITION_WORDS = new Set([
  'of', 'on', 'at', 'in', 'the', 'a', 'an', 'to', 'for', 'with', 'from', 'by', 'into', 'under', 'over', 'behind',
])

function formatNaturalTitle(tag: string): string {
  const words = cleanTag(tag).split('_').filter(Boolean)
  if (!words.length) return String(tag || '').trim()
  return words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

/** Returns the catalog Chinese label when present, otherwise a readable token glossary. */
export function tagMeaning(tag: string, catalogLabel = ''): string {
  const supplied = String(catalogLabel || '').trim()
  if (supplied && !GENERIC_MEANINGS.has(supplied)) return supplied

  const normalized = cleanTag(tag)
  // 分片权威字典优先：分片维护的中文直接作为最高权威单一真相源
  const fromDict = (tagDictionary.meanings as Record<string, string>)[normalized]
  if (fromDict) return fromDict

  if (EXACT_MEANINGS[normalized]) return EXACT_MEANINGS[normalized]

  // WD14 反推高频词整词命中（2026-08-29）：只做整词精确匹配，不参与逐词回退
  if (WD14_ZH[normalized]) return WD14_ZH[normalized]

  // 整词优先：词表里的复合词（convenience_store、winter_coat…）先整体命中，
  // 否则回退到逐词翻译
  if (WORD_MEANINGS[normalized]) return WORD_MEANINGS[normalized]

  const words = normalized.split('_').filter(Boolean)
  // 如果包含介词短语（如 depth_of_field、standing_on_tiptoe 等未在精选表收录的短语），
  // 逐词直接拼接必然导致机翻车祸，此时优雅回退为自然英文标题
  const hasPreposition = words.some(w => PREPOSITION_WORDS.has(w))
  if (hasPreposition) {
    return formatNaturalTitle(tag)
  }

  const translated = words.map(word => WORD_MEANINGS[word])
  const translatedCount = translated.filter(Boolean).length
  // 只有当所有实词均有翻译，或者词数<=3且未翻译单词仅1个时，才进行“ · ”平滑拼接
  if (translatedCount === words.length || (words.length <= 3 && translatedCount >= words.length - 1 && translatedCount >= 1)) {
    return translated.map((meaning, index) => meaning || words[index]).join(' · ')
  }

  return formatNaturalTitle(tag)
}
