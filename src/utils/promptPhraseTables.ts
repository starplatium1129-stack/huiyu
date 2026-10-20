// ── Krea 散文短语改写表（自 promptCompiler.ts 拆出，2026-09-05 单体门禁收编）──
// 纯数据 + 纯函数：把 Danbooru tag 改写成 Krea 2 自然语言短语。
export function proseToken(value: string): string {
  const token = value.trim().replace(/^\((.*):\s*-?\d+(?:\.\d+)?\s*\)$/g, '$1')
    .replace(/^\(([^()]*)\)$/g, '$1').replace(/<lora:[^>]+>/gi, '').replace(/:\s*-?\d+(?:\.\d+)?\s*$/g, '').trim()
  if (!token || /^(?:score_\d+|best_quality|amazing_quality|masterpiece|very_aesthetic|absurdres|newest|highres|highly_detailed|safe|sensitive|nsfw|nene_r18|natsume_r18)$/i.test(token)) return ''
  // 官方服装触发词在 Krea 散文流中映射为自然英文词组（规则见 .agents/skills/studio-prompt-craft/references/krea.md），
  // 而非直接擦除——服装细节必须保留进散文。
  const readable = token
    .replace(/^ayachi_nene$/i, 'Nene').replace(/^shiki_natsume$/i, 'Natsume')
    .replace(/^nene_witch_canonical$/i, 'witch costume')
    .replace(/^nene_school_uniform$/i, 'navy school uniform')
    .replace(/^nene_sailor_uniform$/i, 'sailor school uniform')
    .replace(/^nene_red_cardigan_uniform$/i, 'school uniform with a red cardigan')
    .replace(/^nene_blue_pajamas$/i, 'blue pajamas')
    .replace(/^nene_green_sleepwear$/i, 'green sleepwear')
    .replace(/^nene_bat_dress$/i, 'black bat-themed dress')
    .replace(/^nene_black_dress$/i, 'black dress')
    .replace(/^natsume_cafe_uniform$/i, 'cafe maid uniform')
    .replace(/^natsume_pink_cafe_uniform$/i, 'pink cafe maid uniform')
    .replace(/^natsume_official_qipao$/i, 'official qipao')
    .replace(/^natsume_maid_uniform$/i, 'maid uniform')
    .replace(/^natsume_winter_coat$/i, 'winter coat')
    .replace(/^natsume_sleepwear$/i, 'sleepwear')
    .replace(/^nene_holding_marriage_contract$/i, 'Nene is holding a marriage contract')
    .replace(/^nene_interlacing_fingers_with_viewer$/i, "Nene is interlacing her fingers with the viewer's")
    .replace(/^natsume_fixing_nene_hair_ornament$/i, "Natsume is fixing Nene's hair ornament")
  if (!readable) return ''
  if (/^(?:nene|natsume)_/i.test(readable)) return ''
  return readable.replace(/_/g, ' ').replace(/\b1girl\b/gi, 'one girl').replace(/\b2people\b/gi, 'two people').replace(/\bsolo\b/gi, 'alone')
}

export function normalizeProseKey(value: string): string {
  return String(value || '')
    .replace(/^\(+|\)+$/g, '')
    .replace(/:\s*-?\d+(?:\.\d+)?\s*$/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
}

const ACTION_REWRITES: Readonly<Record<string, string>> = Object.freeze({
  smile: 'smiling', gentle_smile: 'wearing a gentle smile', blush: 'blushing softly',
  blushing: 'with flushed cheeks', deep_blush: 'deeply blushing', heavy_blush: 'with bright rosy blushing cheeks',
  looking_at_viewer: 'looking toward the viewer', looking_back: 'looking back over the shoulder',
  holding_papers: 'holding papers', holding_hands: 'holding hands',
  holding_viewer_right_hand: "holding the viewer's right hand", holding_viewer_left_hand: "holding the viewer's left hand",
  one_hand_adjusting_hair_ribbon: 'using one hand to adjust a hair ribbon',
  holding_papers_in_other_arm: 'holding papers in the other arm',
  carrying_sandals_in_one_hand: 'carrying sandals in one hand',
  walking_on_beach: 'walking on the beach',
  holding_letter: 'holding a letter', standing: 'standing', sitting: 'sitting', waiting: 'waiting',
  sweeping_shrine_steps_with_bamboo_broom: 'sweeping the shrine steps with a bamboo broom',
  skirt_hem_caught_on_flower_stand: 'skirt hem caught on a flower stand',
  hand_gripping_dress_edge: 'gripping the edge of a dress with one hand',
  tripping_on_long_kimono_hem: 'tripping on the hem of a long kimono',
  squeezing_sweater_sleeve: 'squeezing a sweater sleeve',
  in_love: 'showing quiet affection', eye_contact: 'maintaining direct eye contact',
  tears: 'with tears in the eyes', crying: 'crying', sleeping: 'sleeping',
  sitting_on_counter: 'sitting on a counter', sitting_on_lap: 'sitting on a lap',
  sitting_on_bed: 'sitting in bed', sitting_on_desk: 'sitting on a desk',
  lying_on_bed: 'lying in bed', lying_on_side: 'lying on one side',
  lying_on_back: 'lying on the back', legs_apart: 'with legs apart',
  spread_legs: 'with legs spread', kneeling: 'kneeling', hugging_pillow: 'hugging a pillow',
  straddling_viewer: 'straddling the viewer', clinging_to_viewer: 'clinging to the viewer',
  hair_blowing: 'with hair moving in the breeze', windblown_hair: 'with hair moving in the breeze',
  wet_hair: 'with wet hair', wet_skin: 'with wet skin',
  wet_clothes: 'with wet clothes', bare_back: 'with a bare back',
  bare_legs: 'with bare legs', bare_shoulders: 'with bare shoulders',
  no_bra: 'wearing no bra', no_panties: 'wearing no panties',
  panties_aside: 'with panties pulled aside', unbuttoned_shirt: 'with an unbuttoned shirt',
  open_shirt: 'with an open shirt', off_shoulder: 'with clothing off the shoulders',
  lifted_skirt: 'with a lifted skirt', skirt_lift: 'with a lifted skirt',
  fully_nude: 'completely nude',
  parted_lips: 'with parted lips', open_mouth: 'with an open mouth',
  closed_eyes: 'with eyes closed', half_closed_eyes: 'with eyes half closed',
  averting_gaze: 'averting the gaze', heavy_breathing: 'breathing heavily',
  // Other tags stay literal. Authored prose owns participants, hands, exposure,
  // body details and emotion; a vocabulary alias must not invent those facts.
})

export function actionPhrase(value: string): string {
  const key = normalizeProseKey(value)
  if (ACTION_REWRITES[key]) return ACTION_REWRITES[key]
  const readable = proseToken(value)
  if (/^holding_/.test(key)) return `holding ${readable.replace(/^holding\s+/i, '')}`
  if (/^sitting_on_/.test(key)) return `sitting on ${readable.replace(/^sitting on\s+/i, '')}`
  if (/^lying_on_/.test(key)) return `lying on ${readable.replace(/^lying on\s+/i, '')}`
  if (/^looking_at_/.test(key)) return `looking toward ${readable.replace(/^looking at\s+/i, '')}`
  return readable
}

const OUTFIT_REWRITES: Readonly<Record<string, string>> = Object.freeze({
  casual_clothes: 'casual clothes', naked_apron: 'only an apron', apron_only: 'only an apron',
  nude: 'no clothing', naked: 'no clothing', school_uniform: 'a school uniform',
  maid_uniform: 'a maid uniform', cafe_uniform: 'a cafe uniform', pajamas: 'pajamas',
})

export function outfitPhrase(value: string): string {
  const key = normalizeProseKey(value)
  return OUTFIT_REWRITES[key] || proseToken(value)
}

const MOOD_REWRITES: Readonly<Record<string, string>> = Object.freeze({
  smile: 'smiling', gentle_smile: 'gently smiling', slight_smile: 'wearing a slight smile',
  shy_smile: 'wearing a shy smile', blush: 'softly flushed', subtle_blush: 'faintly flushed',
  heavy_blush: 'deeply flushed', shy: 'shy', happy: 'happy', calm: 'calm', relaxed: 'relaxed',
  serious: 'serious', sad: 'sad', melancholic: 'melancholic', nervous: 'nervous',
  expectant: 'expectant', panicked: 'panicked', embarrassed: 'embarrassed',
  tears_in_eyes: 'tearful', teary_eyes: 'tearful', tears_of_joy: 'moved to tears of joy',
  tsundere: 'guarded and flustered', sensual: 'sensual', intimate: 'intimate',
  romantic_atmosphere: 'romantic', seductive_look: 'seductive', passionate_look: 'passionate',
  expressionless: 'composed and expressionless', in_love: 'quietly affectionate',
  soft_eyes: 'soft-eyed', bright_eyes: 'bright-eyed', red_ears: 'flushed ears',
  heavy_breathing: 'breathless',
})

export function moodPhrase(value: string): string {
  const key = normalizeProseKey(value)
  return MOOD_REWRITES[key] || proseToken(value)
}

export function compactMood(values: string[]): string[] {
  const result = [...new Set(values)]
  const remove = (...phrases: string[]) => phrases.forEach(phrase => {
    const index = result.indexOf(phrase)
    if (index >= 0) result.splice(index, 1)
  })
  if (result.includes('gently smiling') || result.includes('wearing a shy smile')) remove('smiling', 'wearing a slight smile')
  if (result.includes('deeply flushed')) remove('softly flushed', 'faintly flushed')
  else if (result.includes('softly flushed')) remove('faintly flushed')
  return result
}

const CAMERA_REWRITES: Readonly<Record<string, string>> = Object.freeze({
  close_up: 'a close-up', extreme_close_up: 'an extreme close-up', close_up_detail: 'a detail close-up',
  medium_shot: 'a medium shot', upper_body: 'upper-body framing', half_body: 'half-body framing',
  waist_up: 'waist-up framing', waist_up_close_shot: 'a waist-up close shot', cowboy_shot: 'a cowboy shot',
  wide_shot: 'a wide shot', long_shot: 'a long shot', full_body: 'full-body framing',
  pov: 'a first-person viewpoint', pov_shot: 'a first-person viewpoint', profile: 'a profile view',
  high_angle: 'a high angle', low_angle: 'a low angle', from_above: 'a view from above',
  from_below: 'a view from below', side_view: 'a side view', dutch_angle: 'a Dutch angle',
  cinematic_16_9_clockwise_dutch_angle: 'a cinematic 16:9 clockwise Dutch angle',
  portrait_shot: 'a portrait shot', establishing_shot: 'an establishing shot', face_focus: 'tight facial focus',
  three_quarter_view: 'a three-quarter view', over_the_shoulder: 'an over-the-shoulder view', over_shoulder: 'an over-the-shoulder view', selfie: 'a selfie composition',
  eye_level: 'an eye-level viewpoint', front_view: 'a front view', back_view: 'a back view', from_behind: 'a back view', from_side: 'a side view',
  medium_close_up: 'a medium close-up', overhead_shot: 'a directly overhead view', bird_s_eye_view: "a bird's-eye view",
})

export function cameraPhrase(value: string): string {
  const key = normalizeProseKey(value)
  return CAMERA_REWRITES[key] || proseToken(value)
}

const LIGHT_REWRITES: Readonly<Record<string, string>> = Object.freeze({
  window_light: 'soft window light', golden_hour: 'golden-hour light', golden_light: 'warm golden light',
  backlight: 'backlighting', backlit: 'backlighting', rim_light: 'rim light', moonlight: 'moonlight',
  lantern_light: 'warm lantern light', overcast: 'soft overcast light', soft_light: 'soft light',
  soft_lighting: 'soft lighting', warm_light: 'warm light', warm_lighting: 'warm lighting',
  cinematic_lighting: 'cinematic lighting', volumetric_lighting: 'volumetric light',
  screen_light: 'the glow of a screen', dim_lighting: 'dim light', shadows: 'deep shadow',
  strong_shadows: 'strong shadows', soft_shadows: 'soft shadows', morning_light: 'morning light',
  diffused_light: 'diffused light', sunlight: 'sunlight', backlighting: 'backlighting',
})

export function lightPhrase(value: string): string {
  const key = normalizeProseKey(value)
  return LIGHT_REWRITES[key] || proseToken(value)
}

const ENVIRONMENT_RE = /(?:^|_)(?:background|classroom|clubroom|cafe|coffee|beach|ocean|sea|forest|street|station|bedroom|bathroom|shrine|park|garden|rooftop|city|library|bookstore|kitchen|palace|ruins|bridge|river|theater|backstage|supermarket|aquarium|cinema|safehouse|hotel|balcony|pool|tatami|office|elevator|train|vehicle|apartment|living_room|studio|gallery|store|shop|festival|bookshelf|blackboard|desk|window|wall|rack|indoors|outdoors|interior)(?:_|$)/

export function isEnvironmentKey(key: string): boolean {
  return ENVIRONMENT_RE.test(key)
}

/** Both renderers omit outdoor sky phrases when their environment is explicitly indoors. */
export function removeIndoorSkyPhrases(environment: string[]): void {
  if (environment.some(item => /inside|indoors/.test(item))) {
    for (let index = environment.length - 1; index >= 0; index -= 1) {
      if (/beneath a (?:clear|starry) sky/.test(environment[index])) environment.splice(index, 1)
    }
  }
}

const ENVIRONMENT_REWRITES: Readonly<Record<string, string>> = Object.freeze({
  classroom: 'inside a classroom', classroom_window: 'beside a classroom window',
  movie_theater: 'inside a dark movie theater', cafe: 'at a cafe', cafe_interior: 'inside a cafe',
  bedroom: 'inside a bedroom', living_room: 'inside a living room', kitchen: 'inside a kitchen',
  bathroom: 'inside a bathroom', library: 'inside a library', shrine: 'at a shrine',
  backstage: 'indoors backstage', supermarket: 'inside a supermarket', aquarium: 'inside an aquarium',
  mirrored_elevator_walls: 'inside an elevator with mirrored walls',
  rooftop: 'on a rooftop', beach: 'on a beach', park: 'in a park', garden: 'in a garden',
  swimming_pool: 'beside a swimming pool', safehouse: 'inside a safehouse', hotel_room: 'inside a hotel room',
  morning: 'in the morning', afternoon: 'in the afternoon', evening: 'in the evening',
  night: 'at night', late_night: 'late at night', dawn: 'at dawn', sunset: 'at sunset',
  clear_sky: 'beneath a clear sky', starry_sky: 'beneath a starry sky', rain: 'in the rain',
  snow: 'with snow', snowfall: 'in falling snow', snowing: 'in falling snow', indoors: 'indoors', outdoors: 'outdoors',
  dark_interior: 'in a dim interior', warm_wooden_cafe: 'inside a warm wooden cafe',
  wall_racks_filled_with_white_cups: 'with wall racks filled with white cups',
})

export function environmentPhrase(value: string): string {
  const key = normalizeProseKey(value)
  if (ENVIRONMENT_REWRITES[key]) return ENVIRONMENT_REWRITES[key]
  const phrase = proseToken(value)
  if (!phrase) return ''
  if (/(?:^|_)(?:outdoor|open_air)(?:_|$)/.test(key)) return `outdoors at ${phrase}`
  if (/(?:^|_)(?:interior|room|classroom|bedroom|bathroom|kitchen|library|cafe|theater|studio|office)$/.test(key)) return `inside ${phrase}`
  return `with ${phrase}`
}
