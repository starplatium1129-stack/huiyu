import type { PromptPlan } from '../types/prompt'
import { normalizeArtistStyleIds, parseArtistStyleItem } from '../config/artistStyles.ts'
import { CANONICAL_OUTFITS } from './canonicalOutfits.ts'
import { authoredSceneCaption } from './promptCaption.ts'
import { resolveCameraTags } from './promptCamera.ts'
import { normalizeKey, tokenize } from './promptPrimitives.ts'
import { proseToken } from './promptPhraseTables.ts'
import { tagKey } from './animaPromptOrder.ts'
import { isGarmentToken } from './popularIdentity.ts'
import { mutualGroupWithCategory } from './promptDiagnostics.ts'
import { cleanCastNegative, cleanCastProse } from './promptCast.ts'
import { buildMossCastLayout, cleanMossCastText, formatCastOutfitClause, mossReferencePerformance } from './mossCast.ts'
import {
  compileMossLayout, isMossLayoutInput, mossLayoutJson, mossNormalizedBox, mossSubjectBox, mossTextBox, mossTriptychBox,
  type MossCanvasSize, type MossLayoutItem, type MossLayoutSide,
} from './mossLayout.ts'

// MIAOKA's shared BASE v1.0/v1.1 positive and negative recipe.
const MOSS_QUALITY = 'masterpiece, best quality, very aesthetic, ultra-detailed, high contrast'
export const MOSS_NEGATIVE = 'extra toes, lowres, (bad), text, error, fewer, extra, missing, worst quality, jpeg artifacts, low quality, watermark, unfinished, displeasing, oldest, early, signature, artistic error, username, bad feet, scan, [abstract], english text, shiny hair'

/** MOSS consumes names/styles as tags; it does not parse artist weights. */
export function mossArtistTags(ids: readonly string[]): string[] {
  return normalizeArtistStyleIds(ids).flatMap(item => {
    const parsed = parseArtistStyleItem(item)
    if (!parsed) return []
    return [parsed.id === 'blue_archive_style' ? parsed.id : '@' + parsed.id]
  })
}

const compositionPlacement = new Map<string, MossLayoutSide | 'center'>([
  ['subject_on_the_left_side_of_the_image', 'left'],
  ['subject_on_the_right_side_of_the_image', 'right'],
  ['centered_composition', 'center'],
])

function mergeSceneNegative(base: string, scene: string[]) {
  const seen = new Set(tokenize(base).map(normalizeKey))
  const additional = scene.flatMap(tokenize).filter(token => {
    const key = normalizeKey(token)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return [base.trim(), ...additional].filter(Boolean).join(', ')
}

/** Undefined means no panel instructions. Null keeps an incomplete or ambiguous instruction in prose. */
function triptychCaptions(text: string): string[] | null | undefined {
  const labels = /(?:^|[\r\n;；])[ \t]*(?:(left|middle|center|right) panel|(左|中|右)格)[ \t]*[:：][ \t]*([^\r\n;；]*)/gi
  const captions = new Map<string, string>()
  for (const [, side, chinese, action] of text.matchAll(labels)) {
    const namedSide = side?.toLowerCase()
    const key = namedSide === 'left' || chinese === '左' ? 'left'
      : namedSide === 'right' || chinese === '右' ? 'right' : 'middle'
    if (captions.has(key) || !/[\p{L}\p{N}]/u.test(action)) return null
    captions.set(key, action.trim())
  }
  const left = captions.get('left'), middle = captions.get('middle'), right = captions.get('right')
  if (captions.size) return left && middle && right ? [left, middle, right] : null

  const ordered = /(?:^|[.!?。！？\r\n])\s*(?:from )?left to right\s*[,：:]\s*(?:the )?three panels show\b[ \t]*([^.!?。！？\r\n]*)/gi
  const sequences = [...text.matchAll(ordered)]
  if (!sequences.length) return undefined
  const actions = sequences[0][1]
  if (sequences.length !== 1 || /["“”()]/.test(actions)) return null
  const segments = actions.split(/[,，;；]/).map(part => part.trim())
  if (segments.length !== 3 || !segments.every(part => /[\p{L}\p{N}]/u.test(part))) return null
  const last = segments[2].match(/^(?:and\s+)?then\s+(.+)$/i)?.[1]
  return last ? [segments[0], segments[1], last] : null
}

function describedScreenSide(caption: string): MossLayoutSide | undefined {
  const sides = new Set<MossLayoutSide>()
  for (const sentence of caption.split(/[.!?。！？\r\n]/)) {
    if (/\b(?:no|not|without|avoid|omit|don't|empty|blank)\b|不要|不放|空白|留白/i.test(sentence)) continue
    const english = /\b(?:on|in|at|to) (?:the )?(?:far )?(left|right)(?:[- ]hand)?(?: (?:side|third|half|edge))? of (?:the )?(?:image|frame|canvas|composition|shot)\b/gi
    // A location alone can describe light, a hand, or empty space. Require a subject or placement cue.
    const staging = /\b(?:subject|figure|character|person|woman|man|girl|boy|she|he|stand(?:s|ing)?|sit(?:s|ting)?|kneel(?:s|ing)?|lean(?:s|ing)?|pose[ds]?|posing|rest(?:s|ing)?|place[ds]?|position(?:ed|s)?|framed|put)\b/i
    if (staging.test(sentence)) {
      for (const [, side] of sentence.matchAll(english)) sides.add(side.toLowerCase() === 'left' ? 'left' : 'right')
    }
    if (/(?:站在|站着|坐在|坐着|靠在|靠着|摆在|摆着|放在|置于|位于|(?:人物|女孩|男孩|女人|男人|角色)在)/.test(sentence)) {
      for (const [, side] of sentence.matchAll(/(?:画面|构图|图像|画幅)的?([左右])(?:侧|半边|边沿|边|三分之一)/g)) {
        sides.add(side === '左' ? 'left' : 'right')
      }
    }
  }
  return sides.size === 1 ? sides.values().next().value : undefined
}

function mossLettering(caption: string) {
  // Keep the literal, including line breaks, whenever the caption explicitly asks for quoted text.
  const quotes = /"([^"]+)"|(?:^|(?<=[\s:=]))'([^']+)'|“([^”]+)”|‘([^’]+)’|「([^」]+)」|『([^』]+)』/gu
  const englishCue = /\b(?:text|lettering|caption|title|headline|words?|label|sign|poster|speech bubble)\b(?:[ \t]+((?:at|in|on) [\w -]{1,40}?))?[ \t]*(?:(?:that[ \t]+)?(?:reads?|says?|reading|saying|is))?[ \t]*[:=]?[ \t]*$/i
  const leadingPlacement = /\b(?:at|in|on|across) (?:the )?((?:top|bottom|upper|lower|left|right|center)(?:[- ](?:left|right|center))?(?: (?:corner|edge|half|third))?)(?: of the (?:poster|sign|frame|canvas))?\s*[,]?\s*(?:(?:a|an|the) )?$/i
  const chineseCue = /(?:(左上角|右上角|左下角|右下角|顶部|底部|上方|下方|左侧|右侧|居中)[ \t]*(?:的(?:标题|标语))?[ \t]*)?(?:写上|写着|文字内容|标题内容|标语内容)[ \t]*[:：]?[ \t]*$/
  return [...caption.matchAll(quotes)].flatMap(match => {
    const [, ...quoted] = match
    const text = quoted.find(value => value?.trim())
    const before = caption.slice(0, match.index).trimEnd().split(/[.!?。！？\n]/).at(-1) ?? ''
    const cue = before.match(englishCue) ?? before.match(chineseCue)
    if (!text || !cue || /\b(?:no|not|without|avoid|exclude|omit|don't)\b|不要|不含|没有|无文字/i.test(before)) return []
    const placement = cue[1] ?? before.slice(0, cue.index).match(leadingPlacement)?.[1] ?? ''
    return { caption: cue[0].trim().replace(/[:=：]$/, ''), text, placement,
      quoteStart: match.index, quoteEnd: match.index + match[0].length }
  })
}

function addMossLettering(caption: string, items: MossLayoutItem[], size: MossCanvasSize, itemLimit = Infinity) {
  const existingTexts = new Set(items.filter(item => item.label === 'text' && item.text).map(item => item.text!.trim().toLowerCase()))
  const letterings = mossLettering(caption)
  for (const lettering of letterings) {
    if (items.length >= itemLimit || existingTexts.has(lettering.text.trim().toLowerCase())) continue
    items.push({ label: 'text', caption: lettering.caption, text: lettering.text, bbox: mossTextBox(size, lettering.placement) })
  }
  // Outer quotes delimit the instruction. The model can otherwise paint them as extra glyphs.
  return letterings.reduceRight((value, item) =>
    value.slice(0, item.quoteStart) + item.text + value.slice(item.quoteEnd), caption)
}

/** Render MOSS visual facts without an Anima/Krea profile or LoRA controls. */
export function renderMossDrawingPrompt(plan: PromptPlan | null, description: string, negative: string,
  size?: MossCanvasSize, options?: { forceLayout?: boolean }) {
  const authored = description.trim()
  const layout = plan?.mossLayout
  const castSubjects = layout?.castLayout && layout.subjects?.length ? layout.subjects : null
  const mergeNegative = (base: string) => {
    const merged = mergeSceneNegative(base, plan?.negative ?? [])
    if (!castSubjects) return merged
    const castNegative = cleanCastNegative(merged)
    return castSubjects.length > 1 ? mergeSceneNegative(castNegative, ['duplicate character', 'clone']) : castNegative
  }
  if (isMossLayoutInput(authored)) {
    const layout = compileMossPrompt(authored, negative, size)
    return { raw: authored, prompt: layout.prompt, negative: mergeNegative(layout.negative) }
  }

  const rawTags = plan ? [
    ...plan.rating, ...(plan.freeSubject || castSubjects ? [] : plan.characterTokens),
    ...(plan.freeSubject || castSubjects ? [] : plan.copyrightTokens), ...plan.artists,
    ...plan.identity, ...plan.exactControls, ...plan.sceneVisualFragments,
    ...plan.emotion, ...plan.camera, ...plan.lighting, ...plan.palette, ...plan.composition, ...plan.manual,
  ].flatMap(tokenize) : []
  const seen = new Set<string>(), outfits = new Set<string>()
  const tags = resolveCameraTags(rawTags, plan?.manual || [], plan?.camera || []).flatMap(value => {
    let token = value.replace(/<lora:[^>]+>/gi, '').replace(/\\([()])/g, '$1').trim()
    token = token.replace(/^\((.*):\s*-?\d+(?:\.\d+)?\)$/, '$1').trim()
    let key = normalizeKey(token)
    if (!key || key === 'break' || /^score_\d+(?:_up)?$/.test(key)) return []
    if (key === 'safe') { token = 'general'; key = 'general' }
    if (/^(?:nene|natsume)_/.test(key)) {
      if (castSubjects) return []
      const outfit = Object.values(CANONICAL_OUTFITS).find(item => item.tags[0] === key)
      if (outfit) outfits.add(outfit.prose)
      else {
        token = proseToken(token)
        key = normalizeKey(token)
      }
      if (outfit || !key) return []
    }
    if (seen.has(key)) return []
    seen.add(key)
    return [token.replace(/_/g, ' ')]
  })
  const sceneProse = plan?.sceneProse || plan?.scene?.promptProse || plan?.scene?.animaCaption || ''
  const scene = plan && sceneProse ? authoredSceneCaption(plan, sceneProse, false) : ''
  const cleanProse = (value: string) => value.replace(/<lora:[^>]+>/gi, '').replace(/\bBREAK\b/g, ', ').trim()
  const subjectProse = cleanProse(plan?.subjectProse ?? '')
  const appearance = [subjectProse, plan?.outfitProse, ...outfits].filter((value): value is string => !!value)
    .map(cleanProse).filter(Boolean)
  // MOSS tag order places the character, series and artist before ordinary visual tags.
  // Free subjects only classify names actually adopted from the picture.
  const names = new Set(plan?.characterTokens.map(tagKey)), works = new Set(plan?.copyrightTokens.map(tagKey))
  const groups: string[][] = [[], [], [], [], []]
  for (const token of tags) {
    const key = tagKey(token)
    const group = /^(?:general|sensitive|questionable|explicit|nsfw|\d{4})$/.test(key) ? 0
      : names.has(key) ? 1 : works.has(key) ? 2 : key.startsWith('@') ? 3 : 4
    groups[group].push(token)
  }
  const ordered = groups.flat()
  const cleanScene = cleanProse(scene)
  if (layout && castSubjects) {
    const common = [
      layout.interaction,
      cleanCastProse(cleanMossCastText(authored)),
      cleanCastProse(cleanMossCastText(cleanScene)),
      cleanMossCastText(ordered.join(', ')),
    ].filter(Boolean)
    if (size) {
      const { items, canvas, extraPeople, castSummary } = buildMossCastLayout(layout, castSubjects, size)
      const people = extraPeople === 1 ? 'One additional supporting character appears in the frame.'
        : extraPeople > 1 ? extraPeople + ' additional supporting characters appear in the frame.' : ''
      const caption = [...new Set([castSummary, people, ...common].filter(Boolean))].join('\n') || 'Character portrait.'
      const summary = addMossLettering(caption, items, size, 16)
      const raw = mossLayoutJson(summary, items, canvas)
      const compiled = compileMossPrompt(raw, negative, size)
      return { raw, prompt: compiled.prompt, negative: mergeNegative(compiled.negative) }
    }
    const castPreview = castSubjects.map(subject => cleanCastProse(cleanMossCastText(subject.caption)))
    const raw = [...new Set([...common, ...castPreview].filter(Boolean))].join('\n')
    const compiled = compileMossPrompt(raw, negative)
    return { raw, prompt: compiled.prompt, negative: mergeNegative(compiled.negative) }
  }
  const refLayout = plan?.mossLayout?.referenceLayout
  const captionWithTags = (facts: string[]) => [...new Set([authored, ...appearance, cleanScene, facts.join(', ')].filter(Boolean))].join('\n')
  let caption = captionWithTags(ordered)
  if (!caption && refLayout?.layout.items.length) {
    caption = refLayout.layout.items.map(item => cleanProse(item.caption)).filter(Boolean).join('\n')
  }
  if (!caption) return { raw: '', prompt: '', negative: mergeNegative(negative) }
  if (size) {
    const intent = plan?.mossLayout?.compositionIntent || plan?.scene?.compositionIntent
    const userPanels = triptychCaptions(authored)
    const panels = userPanels === undefined ? triptychCaptions(scene) : userPanels
    const subjects = plan?.mossLayout?.subjects
    const explicitlySplit = subjects?.length === 2 && subjects.every(subject => subject.side) && subjects[0].side !== subjects[1].side
    const people = ordered.flatMap(tag => tag.match(/^(\d+)\s*(?:girls?|boys?|people|women|men|others?)$/i)?.[1] ?? [])
    const singleSubject = intent !== 'group' && !subjects?.length
      && people.length <= 1 && !people.some(count => Number(count) > 1)
      && !ordered.some(tag => /^(?:group|multiple girls|multiple boys)$/i.test(tag))
    const mainCharacter = singleSubject && Boolean(subjectProse || people[0] === '1')
    const explicitSide = singleSubject && intent !== 'triptych' && panels === undefined ? describedScreenSide(authored) : undefined
    const manualPlacement = singleSubject && intent !== 'triptych' && panels === undefined
      ? [...(plan?.manual ?? []), ...(plan?.composition ?? [])].map(tag => compositionPlacement.get(normalizeKey(tag))).find(Boolean)
      : undefined
    const sceneSide = singleSubject && intent !== 'triptych' && panels === undefined && !explicitSide && !manualPlacement
      ? describedScreenSide(cleanScene) : undefined
    const authoredSide = explicitSide ?? sceneSide
    if (authoredSide) caption = captionWithTags(ordered.filter(tag => {
      const side = compositionPlacement.get(normalizeKey(tag))
      return !side || side === authoredSide
    }))
    const placement = singleSubject && intent !== 'triptych' && panels === undefined
      ? explicitSide ?? manualPlacement ?? sceneSide ?? ordered.map(tag => compositionPlacement.get(normalizeKey(tag))).find(Boolean)
      : undefined
    // A single positioned person can own adopted clothes and poses. Untargeted
    // facts stay global in group scenes instead of dressing both people alike.
    const expression = new Set(plan?.emotion.flatMap(tokenize).map(tagKey))
    const characterFacts = ordered.filter(tag => (!subjectProse && (names.has(tagKey(tag)) || / (?:hair|eyes)$/.test(tag)))
      || expression.has(tagKey(tag)) || isGarmentToken(normalizeKey(tag)) || mutualGroupWithCategory(tag)?.category === 'pose'
      || /^(?:holding|carrying|looking|sitting|standing|lying|leaning) |^on (?:bed|desk)$/.test(tag))
    const subjectFacts = mainCharacter ? characterFacts : []
    const subjectAppearance = [...appearance, subjectFacts.join(', ')].filter(Boolean).join('\n')
    const subjectCaption = mainCharacter ? [subjectAppearance, authored || cleanScene].filter(Boolean).join('\n') || caption : caption
    const useReferenceLayout = Boolean(refLayout?.layout.items.length && panels === undefined && !explicitlySplit && !explicitSide)
    const refCharIndices = useReferenceLayout
      ? refLayout!.layout.items.flatMap((item, index) => item.label === 'character' ? [index] : [])
      : []
    let primaryRefOutfit = ''
    const items: MossLayoutItem[] = panels
      ? panels.map((action, index) => ({
          label: mainCharacter ? 'character' : 'object',
          caption: [action, mainCharacter ? appearance.join('\n') : ''].filter(Boolean).join('\n'),
          bbox: mossTriptychBox(size, index),
        }))
      : explicitlySplit && panels === undefined
        ? subjects.map(subject => ({ label: 'character', caption: subject.caption, bbox: mossSubjectBox(size, subject.side) }))
        : useReferenceLayout
          ? (() => {
              const bound = Boolean(refLayout!.boundSubject)
              const multiChar = refCharIndices.length > 1
              let primaryCharIndex = refCharIndices[0] ?? -1
              if (multiChar) {
                let bestArea = -1
                for (const idx of refCharIndices) {
                  const [y1, x1, y2, x2] = refLayout!.layout.items[idx].bbox
                  const area = (y2 - y1) * (x2 - x1)
                  if (area > bestArea) { bestArea = area; primaryCharIndex = idx }
                }
              }
              const targetAppearance = (multiChar
                ? appearance.map(line => line.replace(/\bis the only prominent character,\s*/i, 'is '))
                : appearance).filter(Boolean)
              const targetFallback = targetAppearance.length
                ? targetAppearance : ordered.filter(tag => names.has(tagKey(tag)))
              return refLayout!.layout.items.map((item, index): MossLayoutItem => {
                const bbox = mossNormalizedBox(size, item.bbox)
                const localCaption = cleanProse(item.caption)
                if (item.label === 'text') {
                  return { label: 'text', caption: localCaption, text: item.text!.trim(), bbox }
                }
                if (item.label === 'object') {
                  return { label: 'object', caption: localCaption, bbox }
                }
                const localLower = localCaption.toLowerCase()
                const extraFacts = !multiChar
                  ? characterFacts.filter(tag => !localLower.includes(tag.toLowerCase())).join(', ')
                  : ''
                if (bound) {
                  if (index === primaryCharIndex) {
                    const explicitOutfit = Boolean(refLayout!.explicitOutfit)
                    if (!multiChar) {
                      const identity = (subjectProse || targetFallback[0] || '').replace(/[.!?]+$/, '').trim()
                      const { outfit: refOutfit, pose: refPose } = mossReferencePerformance(item, [], explicitOutfit)
                      if (explicitOutfit && plan?.outfitProse) {
                        const chosen = formatCastOutfitClause(plan.outfitProse)
                        const head = [identity, chosen].filter(Boolean).join(', ')
                        const headSentence = head ? `${head}${/[.!?]$/.test(head) ? '' : '.'}` : ''
                        const poseSentence = refPose ? `${refPose.charAt(0).toUpperCase()}${refPose.slice(1)}${/[.!?]$/.test(refPose) ? '' : '.'}` : ''
                        const combined = [headSentence, poseSentence].filter(Boolean).join(' ')
                        return { label: 'character', caption: combined || localCaption, bbox }
                      }
                      if (refOutfit) {
                        primaryRefOutfit = refOutfit
                        const head = identity ? `${identity}, ${refOutfit}.` : `${refOutfit.charAt(0).toUpperCase()}${refOutfit.slice(1)}.`
                        const poseSentence = refPose ? `${refPose.charAt(0).toUpperCase()}${refPose.slice(1)}${/[.!?]$/.test(refPose) ? '' : '.'}` : ''
                        const combined = [head, poseSentence, extraFacts].filter(Boolean).join(' ')
                        return { label: 'character', caption: combined || localCaption, bbox }
                      }
                    }
                    const combined = [...targetFallback, localCaption, extraFacts].filter(Boolean).join('\n')
                    return { label: 'character', caption: combined || localCaption, bbox }
                  }
                  return { label: 'character', caption: localCaption, bbox }
                }
                const combined = [localCaption, extraFacts].filter(Boolean).join('\n')
                return { label: 'character', caption: combined || localCaption, bbox }
              })
            })()
          : placement ? [{ label: mainCharacter ? 'character' : 'object', caption: subjectCaption, bbox: mossSubjectBox(size, placement) }] : []
    if (primaryRefOutfit && subjectProse) {
      const boundSummary = `${subjectProse.replace(/[.!?]+$/, '')}, ${primaryRefOutfit}.`
      caption = caption.includes(subjectProse) ? caption.replace(subjectProse, boundSummary) : `${boundSummary}\n${caption}`
    }
    let summary = addMossLettering(caption, items, size)
    if (options?.forceLayout && !items.length) {
      items.push({ label: mainCharacter ? 'character' : 'object', caption: subjectCaption, bbox: mossSubjectBox(size) })
    }
    if (items.length) {
      if (useReferenceLayout && refLayout?.boundSubject && refCharIndices.length > 1) {
        summary = summary.replace(/\bis the only prominent character,\s*/i, 'is ')
      }
      const layoutCanvas = panels ? 'multi_panel' : useReferenceLayout ? refLayout!.layout.canvas : 'single'
      const raw = mossLayoutJson(summary, items, layoutCanvas)
      const compiled = compileMossPrompt(raw, negative, size)
      return { raw, prompt: compiled.prompt, negative: mergeNegative(compiled.negative) }
    }
  }
  const compiled = compileMossPrompt(caption, negative)
  return { raw: caption, prompt: compiled.prompt, negative: mergeNegative(compiled.negative) }
}

/** Only explicit lettering cues relax the author defaults; custom exclusions remain intact. */
function mossTextIntent(text: string): boolean {
  const tags = text.split(/[,\n]/).map(normalizeKey)
  return tags.some(tag => ['text', 'english_text', 'chinese_text', 'japanese_text', 'korean_text', 'lettering', 'speech_bubble'].includes(tag))
    || mossLettering(text).length > 0
}

function mossTextNegative(negative: string, hasText: boolean): string {
  return hasText && negative.trim() === MOSS_NEGATIVE
    ? tokenize(negative).filter(token => !['text', 'english_text'].includes(normalizeKey(token))).join(', ')
    : negative.trim()
}

export function compileMossPrompt(prompt: string, negative: string, size?: MossCanvasSize) {
  const text = prompt.trim()
  if (isMossLayoutInput(text)) {
    const layout = compileMossLayout(text, size)
    return { prompt: layout.prompt, negative: mossTextNegative(negative, layout.hasText || mossTextIntent(layout.caption)) }
  }
  const authored = new Set(text.split(/[,\n]/).map(token => token.trim().toLowerCase()))
  const quality = MOSS_QUALITY.split(', ').filter(token => !authored.has(token))
  return { prompt: [quality.join(', '), text].filter(Boolean).join('\n'), negative: mossTextNegative(negative, mossTextIntent(text)) }
}
