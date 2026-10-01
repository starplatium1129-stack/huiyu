import { COMPOSITION, LIGHTING, SHOT } from '../config/promptConstants.ts'
import { mutualGroupWithCategory, normalizeKey, tokenize } from './promptPolicy.ts'
import { isGarmentToken } from './popularPromptBuilder.ts'
import { isStableIdentityToken } from './interrogateReference.ts'
import type { DraftRandomVariation } from './promptBuilderPersistence.ts'

/** Authored rendering input, not search metadata or a character's recommended scene. */
export interface RandomSceneContext {
  source?: string
  prompt: string
  prose: string
  tags: string[]
  action: string
  time: string
  lighting: string | null
  shot: string | null
}

const key = (s: string) => normalizeKey(s).replace(/-/g, '_')
const motion = /(?:^|\b)(?:running|jogging|walking|swimming|cycling|dancing|jumping)(?:\b|$)|跑|行走|游泳|骑|跳舞|跳跃/i
const wardrobeClause = /\b(?:wearing|dressed in)\s+([^,;.]+)/gi
const garmentWords = (text: string) => (text.toLowerCase().match(/[a-z]+/g) ?? []).filter(isGarmentToken)
const hasEmbeddedWardrobe = (text: string) => tokenize(text).some(token => !isGarmentToken(key(token))
  && /(?:^|_)(?:wearing|dressed|uniform|dress|shirt|skirt|coat)(?:_|$)/.test(key(token)))

/** Only independent wardrobe clauses are replaceable. Unknown prose is retained. */
export function canVarySceneOutfit(scene: RandomSceneContext): boolean {
  if (scene.prompt.includes('\n') || hasEmbeddedWardrobe(scene.prompt)) return false
  let unsafe = false
  const clothingWords = new Set(tokenize(scene.prompt).filter(token => isGarmentToken(key(token)))
    .flatMap(token => key(token).split('_')).concat(['a', 'an', 'the', 'her', 'and']))
  const rest = scene.prose.replace(wardrobeClause, (match, clause: string) => {
    if (!garmentWords(clause).length || (clause.toLowerCase().match(/[a-z]+/g) ?? []).some(word => !clothingWords.has(word))) {
      unsafe = true
      return match
    }
    return ''
  })
  return !unsafe && garmentWords(rest).length === 0
}

export function sceneTimeBand(scene: RandomSceneContext): 'night' | 'day' | 'evening' | null {
  const text = `${scene.time} ${scene.tags.join(' ')} ${scene.prompt}`.replace(/_/g, ' ')
  if (/\b(?:night|midnight|moonlight)\b|夜|月光/.test(text)) return 'night'
  if (/\b(?:sunset|dusk|evening|golden hour)\b|黄昏|夕阳|傍晚|落日/.test(text)) return 'evening'
  if (/\b(?:morning|day|daytime|daylight|noon|afternoon)\b|白天|日间|清晨|上午|正午|午后/.test(text)) return 'day'
  return null
}

export function sceneAllowsLight(scene: RandomSceneContext, id: string): boolean {
  const band = sceneTimeBand(scene)
  const authored = `${scene.prompt} ${scene.tags.join(' ')}`
  if (id === 'window' && scene.lighting !== 'window' && !/window|窗/.test(authored)) return false
  if (id === 'overcast' && /clear_sky|sunny|sunshine/.test(authored)) return false
  if (band === 'night') return ['moon', 'lantern', 'back'].includes(id)
  if (band === 'day') return ['window', 'overcast', 'back'].includes(id)
  if (band === 'evening') return ['golden', 'lantern', 'back'].includes(id)
  return id === scene.lighting || id === 'back'
}

export function sceneAllowsAction(scene: RandomSceneContext, token: string): boolean {
  const authored = tokenize(scene.prompt).map(key)
  if (authored.includes(key(token))) return true
  // Explicit action/prose can encode occupied hands and props absent from tags.
  // Preserve these relationships rather than claiming to parse arbitrary prose.
  if (scene.action || scene.prose || scene.prompt.includes('\n') || motion.test(scene.prompt)) return false
  const poses = authored.map(mutualGroupWithCategory).filter(hit => hit?.category === 'pose')
  const hit = mutualGroupWithCategory(token)
  if (poses.length) return hit?.category === 'pose' && poses.some(pose => pose?.group === hit.group)
  return true
}

const cameraKeys = new Set(SHOT.filter(option => !['turn', 'over'].includes(option.id)).map(option => key(option.prompt ?? '')))
const lightKeys = new Set(LIGHTING.map(option => key(option.prompt ?? '')))
const compositionKeys = new Set(COMPOSITION.map(option => key(option.prompt ?? '')))

/** Remove known replaceable fields only; unknown relationship tokens survive. */
export function sceneVariationOverlay(scene: RandomSceneContext | undefined, outfit: string[],
  catalog: ReadonlyArray<{ en: string; cat: string }>, shot: string | null, lighting: string | null): DraftRandomVariation {
  const categories = new Map(catalog.flatMap(tag => tokenize(tag.en).map(token => [key(token), tag.cat] as const)))
  const variable = (token: string) => {
    const normalized = key(token)
    if (isStableIdentityToken(normalized) || ['looking_back', 'selfie'].includes(normalized)) return false
    if (outfit.length && (isGarmentToken(normalized) || categories.get(normalized) === 'Clothing'
      || mutualGroupWithCategory(normalized)?.category === 'outfit')) return true
    return (Boolean(shot) && (cameraKeys.has(normalized) || categories.get(normalized) === 'Camera'))
      || compositionKeys.has(normalized) || (Boolean(lighting) && (lightKeys.has(normalized) || categories.get(normalized) === 'Lighting'))
      || (!scene?.prose && categories.get(normalized) === 'Emotion')
  }
  const tokens = tokenize(scene?.prompt ?? '').filter(token => !variable(token))
  let prose = scene?.prose ?? ''
  if (outfit.length) prose = prose.replace(wardrobeClause, `wearing ${outfit.map(token => token.replace(/_/g, ' ')).join(', ')}`)
  return { context: '', source: scene ? scene.source ?? JSON.stringify([scene.prompt, scene.prose, scene.tags]) : '', prompt: tokens.join(', '), prose, tags: (scene?.tags ?? []).filter(token => !variable(token)), outfit: [...outfit] }
}
