import { COMPOSITION, SHOT } from '../config/promptConstants.ts'
import { mutualGroupWithCategory, normalizeKey, tokenize } from './promptPolicy.ts'
import { isGarmentToken } from './popularIdentity.ts'
import { isStableIdentityToken } from './interrogateReference.ts'
import type { DraftRandomVariation } from './promptBuilderPersistence.ts'
import { lightingTokenId } from './promptLighting.ts'
import { isWardrobeContextTag } from './wardrobeContent.ts'
import { RANDOM_SETTINGS } from './randomSceneSettings.ts'

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
  rawLighting?: string
  camera?: string
  weather?: string
  otherProse?: string
  fixedTokens?: string[]
  composition?: string | null
  colorMood?: string | null
}

const key = (s: string) => normalizeKey(s).replace(/-/g, '_')
const motion = /(?:^|\b)(?:running|jogging|walking|swimming|cycling|dancing|jumping)(?:\b|$)|跑|行走|游泳|骑|跳舞|跳跃/i
const wardrobeClause = /\b(?:wearing|dressed in)\s+([^,;.]+)/gi
const garmentWords = (text: string) => (text.toLowerCase().match(/[a-z]+/g) ?? []).filter(isGarmentToken)
const hasEmbeddedWardrobe = (text: string) => tokenize(text).some(token => !isGarmentToken(key(token))
  && /(?:^|_)(?:wearing|dressed|uniform|dress|shirt|skirt|coat)(?:_|$)/.test(key(token)))

/** Only independent wardrobe clauses are replaceable. Unknown prose is retained. */
export function canVarySceneOutfit(scene: RandomSceneContext): boolean {
  if (scene.otherProse || scene.fixedTokens?.length || scene.prompt.includes('\n') || hasEmbeddedWardrobe(scene.prompt)) return false
  if (/\b(?:nude|naked|topless|bottomless|unclothed|undressed)\b/i.test([scene.prompt, scene.prose].join(' ').replace(/_/g, ' '))) return false
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

function sceneTimeBand(scene: RandomSceneContext): 'night' | 'day' | 'evening' | null {
  const text = `${scene.time} ${scene.tags.join(' ')} ${scene.prompt} ${scene.prose} ${scene.otherProse ?? ''}`.toLowerCase().replace(/_/g, ' ')
  if (/\b(?:night|midnight|moonlight)\b|夜|月光/.test(text)) return 'night'
  if (/\b(?:sunset|dusk|evening|golden hour)\b|黄昏|夕阳|傍晚|落日/.test(text)) return 'evening'
  if (/\b(?:morning|day|daytime|daylight|noon|afternoon)\b|白天|日间|清晨|上午|正午|午后/.test(text)) return 'day'
  return null
}

export function randomSceneLightOptions(scene: RandomSceneContext): string[] {
  if (scene.lighting) return [scene.lighting]
  // An unmapped emitter (e.g. a projector) is still an authored light.
  const text = [scene.prompt, scene.prose, scene.otherProse, scene.weather, ...scene.tags, ...(scene.fixedTokens ?? [])].join(' ').replace(/_/g, ' ').toLowerCase()
  const known = tokenize(scene.prompt).map(lightingTokenId).find(Boolean)
  if (known) return [known]
  if (scene.rawLighting || /light|lit\b|glow|\blamp|\bsun\b|\bneon\b|光|灯/.test(text)) return []
  const band = sceneTimeBand(scene)
  const facts = new Set([...tokenize(scene.prompt), ...scene.tags].map(key))
  const settings = RANDOM_SETTINGS.filter(setting => facts.has(setting.tags[0]))
  const indoor = facts.has('indoors') || /\b(?:room|interior)\b/.test(text)
    || settings.some(setting => ['window', 'lantern'].includes(setting.lighting) && !setting.tags.includes('lantern'))
  const cloudy = /rain|overcast|cloudy|snow|阴|雨|雪/.test(text)
  if (band === 'night') return indoor || cloudy ? ['lantern'] : ['moon']
  if (indoor || /window|窗/.test(text)) return ['window']
  if (cloudy) return ['overcast']
  if (band === 'evening') return ['golden']
  if (band === 'day' || /clear sky|sunny|晴/.test(text)) return ['back']
  return settings.length ? [...new Set(settings.map(setting => setting.lighting))] : ['back']
}

export function sceneAllowsAction(scene: RandomSceneContext, token: string): boolean {
  const authored = tokenize(scene.prompt).map(key)
  if (authored.includes(key(token))) return true
  // Explicit action/prose can encode occupied hands and props absent from tags.
  // Preserve these relationships rather than claiming to parse arbitrary prose.
  if (scene.action || scene.prose || scene.otherProse || scene.fixedTokens?.length || scene.prompt.includes('\n') || motion.test(scene.prompt)) return false
  const poses = authored.map(mutualGroupWithCategory).filter(hit => hit?.category === 'pose')
  const hit = mutualGroupWithCategory(token)
  if (poses.length) return hit?.category === 'pose' && poses.some(pose => pose?.group === hit.group)
  return true
}

const cameraKeys = new Set(SHOT.filter(option => !['turn', 'over'].includes(option.id)).map(option => key(option.prompt ?? '')))
const compositionKeys = new Set(COMPOSITION.map(option => key(option.prompt ?? '')))

export function randomSceneWardrobe(catalog: ReadonlyArray<{ en: string; cat: string }>) {
  const clothing = new Set(catalog.filter(tag => tag.cat === 'Clothing').flatMap(tag => tokenize(tag.en).map(key)))
  return (token: string): boolean => {
    const normalized = key(token)
    if (/^(?:holding|carrying)_/.test(normalized) || ['umbrella', 'blanket', 'pillow', 'whipped_cream'].includes(normalized)) return false
    return !isWardrobeContextTag(normalized) && !isStableIdentityToken(normalized)
      && (isGarmentToken(normalized) || clothing.has(normalized) || mutualGroupWithCategory(normalized)?.category === 'outfit')
  }
}

/** Remove known replaceable fields only; unknown relationship tokens survive. */
export function sceneVariationOverlay(scene: RandomSceneContext | undefined, outfit: string[],
  catalog: ReadonlyArray<{ en: string; cat: string }>, replaceShot: boolean, replaceComposition: boolean): DraftRandomVariation {
  if (!scene) return { context: '', source: '', prompt: '', prose: '', tags: [], outfit: [...outfit] }
  const isWardrobe = randomSceneWardrobe(catalog)
  const variable = (token: string) => {
    const normalized = key(token)
    if (isStableIdentityToken(normalized) || ['looking_back', 'selfie'].includes(normalized)) return false
    if (outfit.length && isWardrobe(token)) return true
    return (replaceShot && cameraKeys.has(normalized)) || (replaceComposition && compositionKeys.has(normalized))
  }
  const prompt = scene.prompt.split('\n').map(line => tokenize(line).filter(token => !variable(token)).join(', ')).join('\n')
  let prose = scene?.prose ?? ''
  if (outfit.length) prose = prose.replace(wardrobeClause, `wearing ${outfit.map(token => token.replace(/_/g, ' ')).join(', ')}`)
  return { context: '', source: scene.source ?? JSON.stringify([scene.prompt, scene.prose, scene.tags]), prompt,
    prose, tags: scene.tags.filter(token => !variable(token)), outfit: [...outfit] }
}
