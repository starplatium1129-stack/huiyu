export interface OutfitBundle {
  id: string
  character: 'nene' | 'natsume'
  label: string
  tags: string[]
}

export const TAG_CATEGORY_LABELS: Record<string, string> = {
  all: '全部',
  Clothing: '服装',
  Action: '动作',
  Emotion: '情绪',
  Scene: '场景',
  Lighting: '光照',
  Appearance: '外观',
  Camera: '镜头',
  Style: '画风',
  Body: '身体',
  Mature: '成人',
  Character: '角色',
  'Official Outfit': '官方服装',
}

/**
 * UI catalog key normalization only. Prompt token policy stays inside
 * usePromptAssembly/promptPolicy so this view remains a consumer.
 */
export function normalizeCatalogKey(token: string): string {
  return String(token || '')
    .replace(/^\s*\[NEG\]\s*/i, '')
    .replace(/^\s*<lora:|>\s*$/gi, '')
    .replace(/^\s*\(+|\)+\s*$/g, '')
    .replace(/:\s*-?\d+(?:\.\d+)?\s*$/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s\-/]+/g, '_')
}

export const OUTFIT_BUNDLES: OutfitBundle[] = [
  {
    id: 'nene-witch', character: 'nene', label: '宁宁 · 经典魔女服',
    tags: ['nene_witch_canonical', 'official_witch_outfit', 'witch_hat', 'pink_striped_hat_ribbon', 'black_cape', 'vivid_pink_lining', 'criss_cross_halter', 'crop_top', 'strap_between_breasts', 'striped_bow', 'bare_midriff', 'cleavage', 'sideboob', 'underboob', 'no_bra', 'black_pleated_mini_skirt', 'asymmetrical_legwear', 'striped_thighhighs', 'single_thighhigh', 'frilled_socks', 'black_boots'],
  },
  {
    id: 'nene-virgin-killer', character: 'nene', label: '宁宁 · 纯白露背毛衣',
    tags: ['virgin_killer_sweater', 'backless_sweater', 'turtleneck_sweater', 'sleeveless_sweater', 'sideboob', 'bare_back', 'bare_shoulders', 'bare_legs', 'frilled_socks'],
  },
  {
    id: 'nene-sheer-bunny', character: 'nene', label: '宁宁 · 半透情趣兔女郎',
    tags: ['sheer_bunny_suit', 'bunny_suit', 'bunny_ears', 'translucent_cloth', 'see-through', 'cleavage_cutout', 'bare_shoulders', 'garter_straps', 'black_thighhighs', 'stiletto_heels'],
  },
  {
    id: 'nene-front-tie-bikini', character: 'nene', label: '宁宁 · 前系带条纹比基尼',
    tags: ['front-tie_bikini', 'triangle_bikini', 'striped_bikini', 'side-tie_panties', 'cleavage', 'bare_shoulders', 'bare_midriff', 'barefoot'],
  },
  {
    id: 'nene-santa', character: 'nene', label: '宁宁 · 露肩雪绒圣诞装',
    tags: ['santa_costume', 'red_dress', 'white_fur_trim', 'santa_hat', 'santa_capelet', 'off_shoulder', 'black_belt', 'white_thighhighs', 'black_boots'],
  },
  {
    id: 'nene-school', character: 'nene', label: '宁宁 · 学院制服',
    tags: ['nene_school_uniform', 'school_uniform', 'blazer', 'yellow_bowtie', 'plaid_skirt', 'pleated_skirt', 'grey_skirt', 'black_thighhighs'],
  },
  {
    id: 'nene-sailor', character: 'nene', label: '宁宁 · 水手制服',
    tags: ['nene_sailor_uniform', 'grey_sailor_collar', 'black_shirt', 'sailor_shirt', 'serafuku'],
  },
  {
    id: 'nene-blue-pajamas', character: 'nene', label: '宁宁 · 蓝色睡衣',
    tags: ['nene_blue_pajamas', 'pajamas', 'animal_print', 'cat_print', 'long_sleeves'],
  },
  {
    id: 'nene-green-sleepwear', character: 'nene', label: '宁宁 · 绿色睡衣',
    tags: ['nene_green_sleepwear', 'sleepwear', 'nightgown', 'polka_dot', 'short_sleeves', 'twin_braids'],
  },
  {
    id: 'natsume-qipao', character: 'natsume', label: '夏目 · 官方旗袍',
    tags: ['natsume_official_qipao', 'chinese_clothes', 'china_dress', 'red_dress', 'floral_print', 'side_slit', 'long_sleeves', 'black_thighhighs', 'hair_bun', 'double_bun', 'hair_flower', 'red_flower'],
  },
  {
    id: 'natsume-virgin-killer', character: 'natsume', label: '夏目 · 黑色修身露背毛衣',
    tags: ['virgin_killer_sweater', 'black_sweater', 'backless_sweater', 'turtleneck_sweater', 'sleeveless_sweater', 'sideboob', 'bare_back', 'bare_shoulders', 'bare_legs'],
  },
  {
    id: 'natsume-glossy-bunny', character: 'natsume', label: '夏目 · 黑色漆皮兔女郎',
    tags: ['bunny_suit', 'glossy_latex', 'bunny_ears', 'bowtie', 'cuffs', 'bare_shoulders', 'cleavage', 'fishnet_thighhighs', 'high_heels'],
  },
  {
    id: 'natsume-criss-cross-bikini', character: 'natsume', label: '夏目 · 黑色缠腰绑带水着',
    tags: ['criss-cross_bikini', 'black_bikini', 'wrap_bikini', 'side-tie_panties', 'midriff_straps', 'cleavage', 'bare_midriff', 'barefoot'],
  },
  {
    id: 'natsume-velvet-santa', character: 'natsume', label: '夏目 · 抹胸红丝绒圣诞裙',
    tags: ['santa_costume', 'red_dress', 'white_fur_trim', 'santa_hat', 'off_shoulder', 'black_belt', 'black_thighhighs', 'high_heels'],
  },
  {
    id: 'natsume-cafe', character: 'natsume', label: '夏目 · 咖啡店制服',
    tags: ['natsume_cafe_uniform', 'white_shirt', 'suspenders', 'suspender_skirt', 'brown_skirt', 'long_sleeves', 'collared_shirt', 'purple_ribbon', 'hair_flower'],
  },
  {
    id: 'natsume-maid', character: 'natsume', label: '夏目 · 女仆服',
    tags: ['natsume_maid_uniform', 'maid', 'maid_apron', 'white_apron', 'maid_headdress', 'long_sleeves', 'frills'],
  },
  {
    id: 'natsume-sleepwear', character: 'natsume', label: '夏目 · 睡衣',
    tags: ['natsume_sleepwear', 'shirt', 'blue_shirt', 'pillow', 'on_bed'],
  },
]

export const R18_CONTROLS = [
  { character: 'nene', tag: 'nene_r18', label: '宁宁 R18' },
  { character: 'natsume', tag: 'natsume_r18', label: '夏目 R18' },
] as const

export const NON_MANUAL_TAGS = new Set([
  'masterpiece', 'best_quality', 'highly_detailed', 'absurdres', 'very_aesthetic',
  'amazing_quality', 'newest', 'ultra_detailed', 'highres', 'score_9', 'score_8_up',
  'worst_quality', 'low_quality', 'normal_quality', 'lowres', 'blurry', 'jpeg_artifacts',
  'text', 'watermark', 'logo', 'signature', 'bad_anatomy', 'bad_hands', 'extra_fingers',
  'missing_fingers', 'fused_fingers', 'extra_arms', 'extra_legs', 'deformed',
  'bad_proportions', 'duplicate', 'cropped', 'child', 'loli', 'underage',
])
