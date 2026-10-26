/**
 * franchiseLabel.ts — 作品（franchise / 作品源）中文展示名（跨页面共享）。
 *
 * 数据源两种形态，首页、角色库、角色档案与绘图选择器共用同一份映射：
 * - characters.json 的 source 写成「公司《中文名 / 英文名》」：
 *     miHoYo《原神 / Genshin Impact》 / TYPE-MOON《Fate/stay night》
 * - popular-characters.json 的 franchise 是纯英文：Genshin Impact / Re:Zero …
 *
 * 规则（确定性，不碰数据文件）：
 * 1. 整串已知映射（Arknights / Arknights: Endfield 等）；
 * 2. 《》括号内整段已知映射（Fate/stay night 等纯 ASCII 作品名）；
 * 3. 《》内取「纯汉字段」（无假名）优先，其次任何 CJK 段；
 * 4. 仍未命中保留原文。
 */

/** 纯英文作品名 → 中文展示名 */
const FRANCHISE_CN: Record<string, string> = {
  'Arknights': '明日方舟',
  'Arknights: Endfield': '明日方舟：终末地',
  'Sabbat of the Witch': '魔女的夜宴',
  "Cafe Stella and the Reapers' Butterflies": '星光咖啡馆与死神之蝶',
  'Genshin Impact': '原神',
  'Fate': 'Fate 系列',
  'Fate/stay night': '命运之夜',
  'Re:Zero': 'Re：从零开始的异世界生活',
  'Rascal Does Not Dream of Bunny Girl Senpai': '青春猪头少年不会梦到兔女郎学姐',
  'Date A Live': '约会大作战',
  "Frieren: Beyond Journey's End": '葬送的芙莉莲',
  'Guilty Crown': '罪恶王冠',
  'Oregairu': '我的青春恋爱物语果然有问题',
  'Wandering Witch': '魔女之旅',
  'A Certain Scientific Railgun': '某科学的超电磁炮',
  'Chainsaw Man': '电锯人',
  'Mushoku Tensei': '无职转生',
  'My Dress-Up Darling': '更衣人偶坠入爱河',
  'Engage Kiss': '契约之吻',
  'VOCALOID': '虚拟歌手（VOCALOID）',
  "86 -Eighty Six-": "86－不存在的战区",
  "Alya Sometimes Hides Her Feelings in Russian": "不时轻声地用俄语遮羞的邻座艾莉同学",
  "Attack on Titan": "进击的巨人",
  "Azur Lane": "碧蓝航线",
  "Blue Archive": "蔚蓝档案",
  "Bocchi the Rock!": "孤独摇滚！",
  "Code Geass": "反叛的鲁路修",
  "Cyberpunk: Edgerunners": "赛博朋克：边缘行者",
  "Grisaia": "灰色系列",
  "High School DxD": "恶魔高校 DxD",
  "Honkai: Star Rail": "崩坏：星穹铁道",
  "Hyouka": "冰菓",
  "Kaguya-sama: Love Is War": "辉夜大小姐想让我告白",
  "Kaoru Hana wa Rin to Saku": "薰香花朵凛然绽放",
  "Kara no Kyoukai": "空之境界",
  "Kimetsu no Yaiba": "鬼灭之刃",
  "Neon Genesis Evangelion": "新世纪福音战士",
  "NieR:Automata": "尼尔：机械纪元",
  "OVERLORD": "不死者之王",
  "Oshi no Ko": "我推的孩子",
  "Otonari no Tenshi-sama": "邻家的天使同学",
  "SPY x FAMILY": "间谍过家家",
  "Saenai Heroine no Sodatekata": "路人女主的养成方法",
  "Saint Cecilia and Pastor Lawrence": "白圣女与黑牧师",
  "Sora no Otoshimono": "天降之物",
  "Sword Art Online": "刀剑神域",
  "The Dangers in My Heart": "我心里危险的东西",
  "The Magical Girl and the Evil Officer": "曾经魔法少女和大恶魔经常为敌",
  "To LOVE-Ru": "出包王女",
  "Tsukihime": "月姬",
  "Violet Evergarden": "紫罗兰永恒花园",
  "YUZUSOFT": "柚子社作品",
  "Zenless Zone Zero": "绝区零",
  "The Pet Girl of Sakurasou": "樱花庄的宠物女孩",
  "Eromanga Sensei": "埃罗芒阿老师",
  "SSSS.GRIDMAN": "SSSS.古立特",
  "Horimiya": "堀与宫村",
  "The Rising of the Shield Hero": "盾之勇者成名录",
  "DARLING in the FRANXX": "DARLING in the FRANXX／国家队",
  "One-Punch Man": "一拳超人",
  "Detective Conan": "名侦探柯南",
  "Yosuga no Sora": "缘之空",
  "Witch on the Holy Night": "魔法使之夜",
  "Wuthering Waves": "鸣潮",
  "Too Many Losing Heroines!": "败犬女主太多了！",
  "2.5 Dimensional Seduction": "2.5次元的诱惑",
  "Wistoria: Wand and Sword": "杖与剑的魔剑谭",
  "Vivy: Fluorite Eye's Song": "Vivy—萤石眼之歌—",
  "The Apothecary Diaries": "药屋少女的呢喃",
  "Delicious in Dungeon": "迷宫饭",
  "Goddess of Victory: NIKKE": "胜利女神：妮姬",
  "Fatal Fury": "饿狼传说／拳皇",
  "BanG Dream!": "BanG Dream!／少女乐团派对",
}

/** Every catalog franchise must explicitly register a display label. Unknown imports remain identifiable. */
function hasFranchiseLabel(source: string): boolean { return Object.hasOwn(FRANCHISE_CN, String(source || '').trim()) }

const HAS_HAN = /[\u4e00-\u9fff]/
const HAS_KANA = /[\u3040-\u30ff]/

/** 作品展示名：映射表优先 → 《》内纯汉字段 → 《》内 CJK 段 → 原文。 */
export function franchiseLabel(source: string): string {
  const raw = String(source || '').trim()
  if (!raw) return ''
  if (hasFranchiseLabel(raw)) return FRANCHISE_CN[raw]
  // 取最后一对《》（同一出处可能写多个作品，如御坂美琴的
  // 「《魔法禁书目录》/《某科学的超电磁炮》」，角色所属取最后的作品）。
  const brackets = raw.match(/《([^》]+)》/g)
  const bracket = brackets && brackets.length ? brackets[brackets.length - 1] : null
  if (bracket) {
    const inner = bracket.slice(1, -1)
    if (hasFranchiseLabel(inner)) return FRANCHISE_CN[inner]
    const parts = inner.split('/').map(part => part.trim()).filter(Boolean)
    if (!parts.length) return inner
    const han = parts.find(part => HAS_HAN.test(part) && !HAS_KANA.test(part))
    if (han) return han
    const cjk = parts.find(part => HAS_HAN.test(part))
    if (cjk) return cjk
    return inner
  }
  return raw
}
const normalizeFranchise = (value: string) => value.normalize('NFKC').replace(/[\s:：‐‑–—－-]+/g, '').toLowerCase()
const GROUP_ALIASES: Record<string, string> = { 'Fate/stay night': 'Fate', '命运之夜': 'Fate', 'Grisaia no Kajitsu': 'Grisaia', '灰色的果实': 'Grisaia' }
const GROUP_KEYS = new Map<string, string>()
for (const [key, label] of Object.entries(FRANCHISE_CN)) {
  const canonical = GROUP_ALIASES[key] || key
  GROUP_KEYS.set(normalizeFranchise(key), canonical)
  GROUP_KEYS.set(normalizeFranchise(label), canonical)
}
for (const [alias, canonical] of Object.entries(GROUP_ALIASES)) GROUP_KEYS.set(normalizeFranchise(alias), canonical)

/** Group by work identity, not by author/publisher prefixes or translated spelling. */
export function franchiseKey(source: string): string {
  const raw = String(source || '').trim()
  const brackets = raw.match(/《([^》]+)》/g)
  const inner = brackets?.at(-1)?.slice(1, -1) || raw
  for (const candidate of [raw, inner, ...inner.split('/').map(part => part.trim()), franchiseLabel(raw)]) {
    const key = GROUP_KEYS.get(normalizeFranchise(candidate))
    if (key) return key
  }
  return franchiseLabel(raw)
}
