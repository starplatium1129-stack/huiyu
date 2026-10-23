import type { PromptFamily, PromptSceneContext, PromptPlan } from '../types/prompt'
export type { PromptFamily, PromptSceneContext, PromptPlan } from '../types/prompt'
export { plainEnglish } from './promptProse.ts'

import { formatPromptForEngine, normalizeKey, tokenize, type ModelProfile } from './promptPolicy.ts'
import { resolveDrawCapabilities } from './drawCapabilities.ts'
import { sceneShot } from './sceneInference.ts'
import { authoredSceneCaption } from './promptCaption.ts'
import { lightingOverride, lightingTokenId } from './promptLighting.ts'
import { sanitizeVisualArtifacts } from './promptVisualText.ts'
import { orderedAnimaTags } from './animaPromptOrder.ts'
import { cameraTokensFromText, mergeCameraControls, resolveCameraTags } from './promptCamera.ts'
import { compositionIntent, compositionTokens } from './blueprintComposition.ts'
import { SHOT } from '../config/promptConstants.ts'
import { normalizeProseKey } from './promptPhraseTables.ts'
import { cleanPromptProse as clean, promptSentence as sentence, plainEnglish } from './promptProse.ts'
import { renderKreaPrompt } from './promptKreaRenderer.ts'

export interface PromptCompilerInput {
  freeSubject?: boolean
  profile?: ModelProfile | null; identity?: string; controls?: string[]; scenePrompt?: string
  characterTokens?: string[]; copyrightTokens?: string[]
  artists?: string[]; artistProse?: string
  exactTokens?: string[]
  emotion?: string[]; camera?: string[]; lighting?: string[]; palette?: string[]; composition?: string[]
  cameraSource?: 'scene' | 'manual'
  lightingSource?: 'scene' | 'manual'
  authoredLighting?: string
  manual?: string[]; negative?: string; rating?: string; visualDescription?: string
  style?: string[]; medium?: string; subjectProse?: string; outfitProse?: string; sceneProse?: string
  scene?: PromptSceneContext | null
}

const split = (value: string | undefined): string[] => tokenize(value || '').filter(Boolean)
function conflictsWithFairSkin(value: string): boolean {
  const text = normalizeKey(value).replace(/_/g, ' ')
  if (/^(?:tan|tanned|dark skinned (?:female|male))$/.test(text)) return true
  // Ignore negated skin descriptions; unrelated hair, eye and clothing colors do not match.
  const positive = text.replace(/\b(?:no|not|without|avoid|don't|doesn't|isn't|aren't)\s+(?:\w+\s+){0,3}skin(?:ned)?\b/g, '')
  return /\b(?:dark|tan|tanned|brown|black|olive|bronze|colored|blue|green|purple|red|gray|grey|orange|yellow|pink)\s+skin(?:ned)?\b/.test(positive)
}

/**
 * Anima uses tags for identity and clothing, captions for authored scene relationships.
 * Do not repeat the character and outfit dossiers after their tags. Only visual fields are read;
 * title, story, dialogue, search metadata, and audit metadata never enter here.
 */
function buildAnimaVisualDirection(plan: PromptPlan): string {
  const authored = clean(String(plan.scene?.animaCaption || plan.sceneProse || ''))
  // Tags already carry camera, light, action and environment. Only authored
  // relationships belong in the caption; never reconstruct and truncate them.
  return authored
    ? sentence(sanitizeVisualArtifacts(authoredSceneCaption(plan, authored)))
    : sentence(sanitizeVisualArtifacts(plan.visualDescription))
}

export function createPromptPlan(input: PromptCompilerInput): PromptPlan {
  const isRating = (tag: string) => /^(?:safe|general|sensitive|questionable|explicit|nsfw)$/.test(normalizeKey(tag))
  const promptRating = input.profile?.rating_mode === 'prompt'
  const authoredRating = promptRating && [...split(input.scenePrompt), ...(input.manual || []), ...(input.controls || [])].some(isRating)
  const quality = split(input.profile?.quality_prefix)
  const sceneIdentity = input.scene?.identityTokensOverride
  const defaultCamera = SHOT.find(option => option.id === sceneShot(input.scene ?? null))?.prompt
  const inheritedCamera = input.cameraSource !== undefined
    ? input.cameraSource === 'scene'
    : !input.camera?.length || Boolean(defaultCamera && input.camera.every(token => normalizeKey(token) === normalizeKey(defaultCamera)))
  const camera = mergeCameraControls(input.camera || [], cameraTokensFromText(input.scene?.camera),
    inheritedCamera)
  const plan: PromptPlan = {
    freeSubject: input.freeSubject,
    quality: authoredRating ? quality.filter(tag => !isRating(tag)) : quality,
    rating: !promptRating && input.rating ? [input.rating] : [],
    identity: Array.isArray(sceneIdentity) && sceneIdentity.length ? [...sceneIdentity] : split(input.identity),
    exactControls: [...new Set(input.controls || [])],
    characterTokens: [...new Set(input.characterTokens || [])], copyrightTokens: [...new Set(input.copyrightTokens || [])],
    artists: [...new Set(input.artists || [])],
    preserveTokens: [...new Set(input.exactTokens || [])],
    sceneVisualFragments: split(input.scenePrompt), emotion: [...(input.emotion || [])],
    camera, lighting: [...(input.lighting || [])], palette: [...(input.palette || [])],
    cameraSource: input.cameraSource, lightingSource: input.lightingSource,
    authoredLighting: input.authoredLighting,
    composition: [...(input.composition || [])], manual: [...(input.manual || [])],
    negative: split(input.negative), visualDescription: plainEnglish(input.visualDescription),
    style: [...new Set(input.style || [])],
    medium: String(input.medium || '').trim(),
    subjectProse: String(input.scene?.identityProseOverride || input.subjectProse || '').trim(),
    outfitProse: String(input.outfitProse || '').trim(),
    sceneProse: String(input.sceneProse || '').trim(),
    scene: input.scene ? {
      ...input.scene,
      tags: input.scene.tags ? [...input.scene.tags] : undefined,
      usage: input.scene.usage ? [...input.scene.usage] : undefined,
      identityTokensOverride: input.scene.identityTokensOverride ? [...input.scene.identityTokensOverride] : undefined,
    } : null,
    artistProse: String(input.artistProse || '').trim(),
  }
  if (compositionIntent(input.scene) !== 'single') {
    const source = { ...input.scene, promptTokens: plan.sceneVisualFragments }
    plan.identity = compositionTokens(plan.identity, source)
    plan.sceneVisualFragments = compositionTokens(plan.sceneVisualFragments, source)
    plan.subjectProse = plan.subjectProse.replace(/\bis the only prominent character,\s*/i, 'is ')
  }
  // Studio's default low twintails must yield to an explicitly authored updo,
  // loose hairstyle or braids. Authored/exact scene and manual tokens stay intact.
  if ([...plan.sceneVisualFragments, ...plan.exactControls, ...plan.manual]
    .some(token => /(?:^|_)(?:hair_up|hair_down|twin_braids|two(?:_[a-z]+){0,3}_braids)(?:_|$)/.test(normalizeKey(token)))) {
    plan.identity = plan.identity.filter(token => normalizeKey(token) !== 'low_twintails')
  }
  // An explicit scene variant can remove Nene's default hair ribbons.
  if ([...plan.sceneVisualFragments, ...plan.manual].some(token => /^no_hair_ribbons?$/.test(normalizeKey(token)))) {
    plan.identity = plan.identity.filter(token => !['pink_hair_ribbons', 'hair_ribbon'].includes(normalizeKey(token)))
    plan.subjectProse = plan.subjectProse.replace(/\bpink hair ribbons\b/gi, 'no ribbons in her hair')
  }
  const light = lightingOverride(plan)
  if (light) {
    const exact = new Set([...plan.preserveTokens, ...(input.profile?.exact_tokens || [])].map(normalizeKey))
    plan.sceneVisualFragments = plan.sceneVisualFragments.filter(token => exact.has(normalizeKey(token))
      || input.profile?.exact_prefixes?.some(prefix => token.toLowerCase().startsWith(prefix.toLowerCase()))
      || lightingTokenId(token) !== light.source)
  }
  if (['anima-miaomiao-v1.6', 'anima-miaomiao-realskin-2.9b-v1.0'].includes(input.profile?.model_id || '')) {
    const authored = [...plan.identity, ...plan.exactControls, ...plan.sceneVisualFragments, ...plan.manual]
    // Inspect only authored positive content, including the caption actually sent to Anima.
    if ([...authored, buildAnimaVisualDirection(plan)].some(conflictsWithFairSkin)) {
      plan.quality = plan.quality.filter(tag => normalizeKey(tag) !== 'fair_skin')
    }
  }
  return plan
}

function allTags(plan: PromptPlan, includeStyle = true): string[] {
  const raw = [ ...plan.quality, ...plan.rating, ...plan.identity, ...plan.exactControls, ...plan.artists,
    ...(includeStyle ? plan.style : []), ...plan.sceneVisualFragments, ...plan.emotion, ...plan.camera, ...plan.lighting, ...plan.palette,
    ...plan.composition, ...plan.manual ].filter(Boolean)
  return raw.map(tag => {
    const k = normalizeProseKey(tag)
    if (k === 'burning_red_ears') return 'blushing ears'
    return tag
  })
}

export function renderPromptPlan(plan: PromptPlan, family: PromptFamily, profile?: ModelProfile | null): { prompt: string; negative: string } {
  const capabilities = resolveDrawCapabilities(family, profile)
  if (capabilities.promptFormat === 'natural-language') {
    return renderKreaPrompt(plan)
  }
  const tags = allTags(plan)
  if (capabilities.promptFormat === 'anima-tags') {
    const formatted = formatPromptForEngine(
      orderedAnimaTags(plan, resolveCameraTags(tags, plan.manual, plan.camera), profile?.strip_quality_tokens === true),
      'anima',
      plan.preserveTokens.concat(profile?.exact_tokens || []),
      profile?.exact_prefixes || [],
    )
    const direction = buildAnimaVisualDirection(plan)
    // 换行是可审计的标签/散文边界，不参与模型 token 去重或精确 LoRA 控制。
    return { prompt: [formatted, direction].filter(Boolean).join('\n'), negative: '' }
  }
  return { prompt: tags.join(', '), negative: plan.negative.join(', ') }
}
