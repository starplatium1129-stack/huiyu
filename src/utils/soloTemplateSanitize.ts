// 单人场景只删除明确的额外主体/人数词；身份特征由最终格式化阶段去重。

import { normalizeKey, splitBreaks, tokenize } from './promptPrimitives.ts'

/**
 * 单人引擎净化只删除「画面里明摆着第二个可见主体」的词：
 * 明确的男性主体、双人/多人计数词、以及指向第三方个体的词。
 * 不按 male / man 等子词匹配，避免删除 POV 手、前臂及接受者的互动关系。
 */
const SOLO_EXTRA_SUBJECT_TOKENS = new Set([
  '1boy', '1man', '1woman', '1boy1girl', '1girl1boy', '1man1woman',
  '2boys', '2girls', '2people', 'two_girls', 'three_girls',
  'multiple_girls', 'multiple_boys', 'multiple_people',
  'boy', 'man', 'male', 'men', 'boys', 'males', 'guy', 'guys',
  'another_girl', 'other_girl', 'second_girl', 'another_person', 'other_person',
  'background_girl', 'background_character', 'background_person', 'second_character',
])

export function sanitizeSoloTemplate(template: string): string {
  return splitBreaks(template).map(section => tokenize(section)
    .filter(token => !SOLO_EXTRA_SUBJECT_TOKENS.has(normalizeKey(token)))
    .join(', '))
    .filter(Boolean)
    .join(' BREAK ')
}
