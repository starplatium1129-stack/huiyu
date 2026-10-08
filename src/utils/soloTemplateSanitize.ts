// 单人引擎防分身净化（2026-09-05 从 promptPolicy.ts 抽出：单体门禁 844>822 拆分）。
// 单人引擎（Anima/Krea）场景净化：只删除明确可见的额外主体/人数词。
// POV、望向镜头、牵手、浪漫氛围与中心互动/动作全部保留（viewer 相关，
// 不产生画面中第二个可见人物）。SD 引擎保留原样（WebUI 有完整双人支持）。

import { normalizeKey, splitBreaks, tokenize } from './promptPrimitives.ts'

const NATSUME_IDENTITY_TOKENS = new Set([
  '1girl', 'solo', 'shiki_natsume', 'black_hair', 'long_hair', 'very_long_hair',
  'very_long_black_hair', 'yellow_eyes', 'golden_yellow_eyes', 'mole_under_eye',
  'hairclip', 'two_red_hairclips', 'two_red_hairclips_only', 'no_hair_ribbon',
])

const NENE_IDENTITY_TOKENS = new Set([
  '1girl', 'solo', 'ayachi_nene', 'white_hair', 'very_long_hair', 'low_twintails',
  'purple_eyes', 'ahoge', 'pink_hair_ribbons', 'hair_ribbon',
])

/**
 * 单人引擎净化只删除「画面里明摆着第二个可见主体」的词：
 * 明确的男性主体、双人/多人计数词、以及指向第三方个体的词。
 * POV / 望向镜头 / 牵手 / 浪漫氛围 / 互动动作全部保留 —— 它们是
 * 面向 viewer 或对单主体成立的内容，不是画面中多出来的可见人物。
 */
const SOLO_EXTRA_SUBJECT_TOKENS = new Set([
  '1boy', '1man', '1woman', '1boy1girl', '1girl1boy', '1man1woman',
  '2boys', '2girls', '2people', 'two_girls', 'three_girls',
  'multiple_girls', 'multiple_boys', 'multiple_people',
  'boy', 'man', 'male', 'men', 'boys', 'males', 'guy', 'guys',
  'another_girl', 'other_girl', 'second_girl', 'another_person', 'other_person',
  'background_girl', 'background_character', 'background_person', 'second_character',
])

/** 明确的男性主体标记（含下划线前缀/后缀词，如 male_arms / man_s_hands）。 */
const SOLO_MALE_SUBJECT_RE = /(?:^|_)(?:male|man|men|boy|boys|guy|guys)(?:_|$)/i

function isExtraSoloSubjectToken(key: string): boolean {
  if (SOLO_EXTRA_SUBJECT_TOKENS.has(key)) return true
  return SOLO_MALE_SUBJECT_RE.test(key)
}

function sanitizeSections(template: string, identityTokens: Set<string> | null): string {
  return splitBreaks(template).map(section => tokenize(section)
    .filter(token => {
      const key = normalizeKey(token)
      // 身份锚点由 charPrompt 行提供，模板里重复的删掉即可；互动词保留。
      if (identityTokens && identityTokens.has(key)) return false
      return !isExtraSoloSubjectToken(key)
    })
    .join(', '))
    .filter(Boolean)
    .join(' BREAK ')
}

export function sanitizeNatsumeSoloTemplate(template: string): string {
  return sanitizeSections(template, NATSUME_IDENTITY_TOKENS)
}

export function sanitizeNeneSoloTemplate(template: string): string {
  return sanitizeSections(template, NENE_IDENTITY_TOKENS)
}

export function sanitizeSoloTemplate(template: string): string {
  return sanitizeSections(template, null)
}
