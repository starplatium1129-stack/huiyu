// ── Krea 散文短语改写表（自 promptCompiler.ts 拆出，2026-09-05 单体门禁收编）──
// 纯数据 + 纯函数：把 Danbooru tag 改写成 Krea 2 自然语言短语。
export function proseToken(value: string): string {
  const token = value.replace(/^\(+|\)+$/g, '').replace(/<lora:[^>]+>/gi, '').replace(/:\s*-?\d+(?:\.\d+)?\s*$/g, '').trim()
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
  if (!readable) return ''
  if (/^(?:nene|natsume)_/i.test(readable)) return ''
  return readable.replace(/_/g, ' ').replace(/\b1girl\b/gi, 'one girl').replace(/\bsolo\b/gi, 'alone')
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
  looking_at_viewer: 'looking toward the viewer', looking_back: 'looking back over her shoulder',
  holding_papers: 'holding a stack of papers', holding_hands: 'holding the viewer\'s hand',
  one_hand_adjusting_hair_ribbon: 'using one hand to adjust her pink hair ribbon',
  holding_papers_in_other_arm: 'holding lecture papers securely in her other arm',
  carrying_sandals_in_one_hand: 'carrying her sandals visibly in one hand',
  walking_on_beach: 'walking barefoot along the wet beach',
  holding_letter: 'holding a letter', standing: 'standing', sitting: 'sitting', waiting: 'waiting',
  in_love: 'showing quiet affection', eye_contact: 'maintaining direct eye contact',
  tears: 'with tears in her eyes', crying: 'crying', sleeping: 'sleeping peacefully',
  sitting_on_counter: 'sitting on a counter', sitting_on_lap: 'sitting on the viewer\'s lap',
  sitting_on_bed: 'sitting gracefully in bed', sitting_on_desk: 'sitting on a desk',
  lying_on_bed: 'lying softly in bed', lying_on_side: 'reclining gracefully on her side',
  lying_on_back: 'lying gracefully on her back', legs_apart: 'with her legs parted gently',
  spread_legs: 'with her legs parted sensually', kneeling: 'kneeling softly', hugging_pillow: 'hugging a soft white pillow',
  straddling_viewer: 'straddling the viewer', clinging_to_viewer: 'clinging to the viewer',
  hair_blowing: 'with her hair moving in the breeze', windblown_hair: 'with her hair moving in the breeze',
  wet_hair: 'with glistening wet hair', wet_skin: 'with translucent glistening skin',
  wet_clothes: 'with clinging wet fabric', bare_back: 'with her smooth bare back',
  bare_legs: 'with her slender bare legs', bare_shoulders: 'with her delicate bare shoulders',
  bare_chest: 'with her soft bare chest', exposed_breasts: 'with her supple bare breasts',
  breasts_out: 'with her exposed bare breasts', topless: 'topless with her bare breasts exposed',
  cleavage: 'with an alluring cleavage', sideboob: 'revealing delicate sideboob',
  underboob: 'revealing subtle underboob', no_bra: 'wearing no bra',
  no_panties: 'wearing no panties', panties_aside: 'with her panties pulled aside',
  pulling_down_panties: 'pulling down her panties', unbuttoned_shirt: 'with her unbuttoned shirt falling open',
  open_shirt: 'with her shirt open revealing her bare chest', off_shoulder: 'with her clothes sliding off her shoulders',
  lifted_skirt: 'with her skirt gently lifted', bottomless: 'bottomless with bare thighs',
  nude: 'completely nude', naked: 'completely naked', fully_nude: 'completely nude',
  nipples: 'with delicate pink nipples', areola: 'with tender areolas', pussy: 'with her intimate curves',
  cameltoe: 'with delicate contours', collarbone: 'with a slender delicate collarbone',
  navel: 'with her delicate navel visible', slender_thighs: 'with slender fair thighs',
  parted_lips: 'with softly parted lips', open_mouth: 'with mouth softly open in a breathless sigh',
  ahegao: 'with an intensely flushed, ecstatically blushing face and parted lips',
  closed_eyes: 'with eyes closed in serenity', half_closed_eyes: 'with drowsy half-closed eyes',
  averting_gaze: 'shyly averting her gaze', heavy_breathing: 'breathing heavily with flushed cheeks',
  drooling: 'with a tiny glistening drop at the corner of her lips',
  // ── Explicit Sex & Erotic Actions ──
  sex: 'engaged in intimate lovemaking',
  intercourse: 'engaged in passionate intercourse',
  vaginal: 'during vaginal intercourse',
  anal: 'during anal intercourse',
  oral: 'performing oral pleasure',
  fellatio: 'performing fellatio with her lips softly wrapped around him',
  blowjob: 'giving a passionate blowjob with saliva glistening on her lips',
  deepthroat: 'engaged in deepthroat with tears in her flushed eyes',
  cunnilingus: 'receiving oral pleasure with arched back and trembling thighs',
  paizuri: 'performing a breast slip paizuri with her soft cleavage tightly pressed',
  titfuck: 'performing paizuri with breasts pressed around him',
  handjob: 'stroking gently with her delicate hand',
  fingering: 'touching herself intimately with glistening fingertips',
  masturbation: 'pleasuring herself intimately with arched back',
  female_masturbation: 'pleasuring herself intimately with flushed cheeks',
  missionary: 'in missionary position with legs spread softly',
  doggystyle: 'on all fours from behind in doggystyle position',
  cowgirl_position: 'riding on top in cowgirl position with bouncing breasts',
  mating_press: 'in a passionate mating press position with legs pressed back',
  spooning: 'in a cozy side-by-side spooning embrace',
  grinding: 'grinding her hips intimately with flushed cheeks',
  penetration: 'during intimate penetration',
  cum: 'with glistening white love liquid',
  cum_on_face: 'with splashes of white liquid across her blushing cheeks',
  cum_in_mouth: 'with white liquid inside her softly open mouth',
  cum_on_breasts: 'with white liquid splashed across her bare breasts',
  cum_on_body: 'with glistening white liquid on her smooth skin',
  internal_cumshot: 'with white liquid overflowing from her intimate entrance',
  creampie: 'with glistening white liquid slowly overflowing from within her',
  excessive_cum: 'with abundant glistening white liquid coating her thighs',
  sweat: 'with glistening beads of sweat',
  sweaty_skin: 'with dewy glistening sweaty skin',
  after_sex: 'resting peacefully in bed after passionate lovemaking',
  panty_pull: 'delicately pulling her panties aside with one finger',
  skirt_lift: 'lifting her skirt with both hands revealing her bare thighs',
  grabbed_breasts: 'with hands gently fondling her soft bare breasts',
  groping: 'being caressed intimately across her soft curves',
})

export function actionPhrase(value: string): string {
  const key = normalizeProseKey(value)
  if (ACTION_REWRITES[key]) return ACTION_REWRITES[key]
  if (/^holding_one_clearly_wrapped_sweet_/.test(key)) {
    return 'presenting one clearly wrapped sweet in both cupped hands, with the folded paper wrapper fully visible'
  }
  const readable = proseToken(value)
  if (/^holding_/.test(key)) return `holding ${readable.replace(/^holding\s+/i, '')}`
  if (/^sitting_on_/.test(key)) return `sitting on ${readable.replace(/^sitting on\s+/i, '')}`
  if (/^lying_on_/.test(key)) return `lying on ${readable.replace(/^lying on\s+/i, '')}`
  if (/^looking_at_/.test(key)) return `looking toward ${readable.replace(/^looking at\s+/i, '')}`
  return readable
}

const OUTFIT_REWRITES: Readonly<Record<string, string>> = Object.freeze({
  casual_clothes: 'casual clothes', naked_apron: 'only a cafe apron', apron_only: 'only an apron',
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
  soft_eyes: 'soft-eyed', bright_eyes: 'bright-eyed', red_ears: 'flushed cheeks',
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
  three_quarter_view: 'a three-quarter view', over_the_shoulder: 'an over-the-shoulder view', selfie: 'a selfie composition',
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

const ENVIRONMENT_REWRITES: Readonly<Record<string, string>> = Object.freeze({
  classroom: 'inside a classroom', classroom_window: 'beside a classroom window',
  movie_theater: 'inside a dark movie theater', cafe: 'inside a cafe', cafe_interior: 'inside a cafe',
  bedroom: 'inside a bedroom', living_room: 'inside a living room', kitchen: 'inside a kitchen',
  bathroom: 'inside a bathroom', library: 'inside a library', shrine: 'at a shrine',
  rooftop: 'on a rooftop', beach: 'on a beach', park: 'in a park', garden: 'in a garden',
  swimming_pool: 'beside a swimming pool', safehouse: 'inside a safehouse', hotel_room: 'inside a hotel room',
  morning: 'in the morning', afternoon: 'in the afternoon', evening: 'in the evening',
  night: 'at night', late_night: 'late at night', dawn: 'at dawn', sunset: 'at sunset',
  clear_sky: 'beneath a clear sky', starry_sky: 'beneath a starry sky', rain: 'in the rain',
  snow: 'in falling snow', snowfall: 'in falling snow', indoors: 'indoors', outdoors: 'outdoors',
  dark_interior: 'in a dim interior', warm_wooden_cafe: 'inside a warm wooden cafe',
  wall_racks_filled_with_white_cups: 'with wall racks filled with white cups',
})

export function environmentPhrase(value: string): string {
  const key = normalizeProseKey(value)
  if (ENVIRONMENT_REWRITES[key]) return ENVIRONMENT_REWRITES[key]
  const phrase = proseToken(value)
  if (!phrase) return ''
  if (/(?:interior|room|classroom|bedroom|bathroom|kitchen|library|cafe|theater|studio|office)$/.test(key)) return `inside ${phrase}`
  return `with ${phrase}`
}
