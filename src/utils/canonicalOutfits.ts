/** Official training tags and their authored Krea descriptions share one definition.
 * Tags are exact training vocabulary; renderers must not expand or paraphrase them. */
export const CANONICAL_OUTFITS = {
  neneWitch: {
    tags: [
      'nene_witch_canonical', 'witch_hat', 'black_cape', 'criss-cross_halter',
      'crop_top', 'strap_between_breasts', 'pink_bow', 'pink_ribbon',
      'black_skirt', 'asymmetrical_legwear', 'striped_thighhighs',
      'single_thighhigh', 'single_sock', 'frilled_socks', 'midriff',
    ],
    prose: 'her canonical black witch costume with a cape, hat, pink accents, and asymmetrical striped legwear',
  },
  neneSchool: {
    tags: [
      'nene_school_uniform', 'school_uniform', 'blazer', 'yellow_bowtie',
      'plaid_skirt', 'pleated_skirt', 'grey_skirt', 'black_thighhighs',
      'zettai_ryouiki',
    ],
    prose: 'her navy school uniform with a blazer, yellow bow tie, pleated plaid skirt, and black thigh-highs',
  },
  neneSailor: {
    tags: [
      'nene_sailor_uniform', 'school_uniform', 'grey_sailor_collar',
      'black_shirt', 'sailor_shirt', 'serafuku',
    ],
    prose: 'her dark sailor school uniform with a gray sailor collar',
  },
  neneRedCardigan: {
    tags: [
      'nene_red_cardigan_uniform', 'cardigan', 'white_shirt', 'pleated_skirt',
      'black_skirt', 'white_socks',
    ],
    prose: 'her school uniform with a burgundy cardigan, white shirt, pleated black skirt, and white socks',
  },
  neneBluePajamas: {
    tags: [
      'nene_blue_pajamas', 'pajamas', 'animal_print', 'cat_print',
      'long_sleeves',
    ],
    prose: 'her blue long-sleeved cat-print button-up pajamas',
  },
  neneGreenSleepwear: {
    tags: [
      'nene_green_sleepwear', 'sleepwear', 'nightgown', 'polka_dot',
      'short_sleeves', 'twin_braids',
    ],
    prose: 'her mint-green short-sleeved polka-dot sleepwear',
  },
  neneBatDress: {
    tags: [
      'nene_bat_dress', 'black_dress', 'asymmetrical_clothes',
      'bat_hair_ornament', 'black_thighhighs', 'garter_straps',
    ],
    prose: 'her black bat-themed dress with garter straps and black thigh-highs',
  },
  neneBlackDress: {
    tags: [
      'nene_black_dress', 'black_dress', 'skirt', 'garter_straps',
      'thighhighs',
    ],
    prose: 'her black dress with garter straps and thigh-highs',
  },
  natsumeQipao: {
    tags: [
      'natsume_official_qipao', 'chinese_clothes', 'china_dress', 'red_dress',
      'floral_print', 'side_slit', 'long_sleeves', 'black_thighhighs',
      'hair_bun', 'double_bun', 'hair_flower', 'red_flower',
    ],
    prose: 'her official long-sleeved red floral qipao with a side slit and black thigh-highs, with her hair in two buns decorated with red flowers',
  },
  natsumeCafe: {
    tags: [
      'natsume_cafe_uniform', 'white_shirt', 'suspenders', 'suspender_skirt',
      'brown_skirt', 'long_sleeves', 'collared_shirt', 'purple_ribbon',
      'hair_flower',
    ],
    prose: 'her cafe uniform with a long-sleeved white collared shirt, suspenders, a brown skirt, a purple ribbon, and a hair flower',
  },
  natsumePinkCafe: {
    tags: [
      'natsume_pink_cafe_uniform', 'pink_shirt', 'pink_skirt', 'waist_apron',
      'white_apron', 'frills', 'striped',
    ],
    prose: 'her pink cafe uniform with a frilled white waist apron',
  },
  natsumeMaid: {
    tags: [
      'natsume_maid_uniform', 'maid', 'maid_apron', 'white_apron',
      'maid_headdress', 'long_sleeves', 'frills',
    ],
    prose: 'her dark long-sleeved cafe maid uniform with a white apron, frills, and a maid headdress',
  },
  natsumeWinter: {
    tags: [
      'natsume_winter_coat', 'coat', 'fur_trim', 'hair_ribbon', 'hair_flower',
    ],
    prose: 'her fur-trimmed winter coat with floral hair ornaments',
  },
  natsumeSleepwear: {
    tags: [
      'natsume_sleepwear', 'shirt', 'blue_shirt', 'pillow', 'on_bed',
    ],
    prose: 'her pale blue sleepwear',
  },
} as const

/** Existing LoRA consumers use the same tag arrays, without a second outfit catalogue. */
export const TRAINED_OUTFIT_BUNDLES = Object.fromEntries(
  Object.entries(CANONICAL_OUTFITS).map(([key, outfit]) => [key, outfit.tags]),
) as { readonly [K in keyof typeof CANONICAL_OUTFITS]: typeof CANONICAL_OUTFITS[K]['tags'] }
