import { COMPOSITION, LIGHTING, SHOT } from '../config/promptConstants.ts'
import { createPromptPlan, renderPromptPlan, type PromptPlan } from './promptCompiler.ts'
import { resolveDrawCapabilities } from './drawCapabilities.ts'
import { escapeKnownLiteralTags } from './promptLiteralTags.ts'
import { isManualR18Tags, mergeTokenText, normalizeKey, tokenize, type ModelProfile } from './promptPolicy.ts'

export interface FreePromptOptions {
  engine: 'anima' | 'krea2'
  profile?: ModelProfile | null
  manual?: readonly string[]
  emotion?: readonly string[]
  /** Director selection IDs; palette already contains the chosen visual phrases. */
  shot?: string | null
  lighting?: string | null
  composition?: string | null
  palette?: readonly string[]
  artistTags?: readonly string[]
  artistProse?: string
  visualDescription?: string
  /** Classification candidates only; unentered characters and works are never injected. */
  characterTokens?: readonly string[]
  copyrightTokens?: readonly string[]
  negativeCustom?: string
}

export interface FreePromptResult {
  plan: PromptPlan
  prompt: string
  negative: string
  adult: boolean
}

/** Compile an unbound subject without assigning an identity, gender or default scene. */
export function buildFreePromptPlan(input: FreePromptOptions): FreePromptResult {
  const profile = input.profile ?? null
  const manual = [...(input.manual || [])]
  const emotion = [...(input.emotion || [])]
  const palette = [...(input.palette || [])]
  const artistTags = [...(input.artistTags || [])]
  const description = String(input.visualDescription || '').trim()
  const camera = SHOT.find(option => option.id === input.shot)?.prompt || ''
  const lighting = LIGHTING.find(option => option.id === input.lighting)?.prompt || ''
  const composition = COMPOSITION.find(option => option.id === input.composition)?.prompt || ''
  const tags = [...manual, ...emotion, camera, lighting, composition, ...palette].filter(Boolean).join(', ')
  const negative = resolveDrawCapabilities(input.engine, profile).negative
    ? mergeTokenText(input.negativeCustom || '', profile?.negative_prefix || '') : ''
  const adult = isManualR18Tags(manual)

  // A profile's quality defaults and a negative prompt do not make an empty draft drawable.
  const artistContent = input.engine === 'krea2' ? input.artistProse?.trim() : artistTags.join(', ').trim()
  if (!tags.trim() && !description && !artistContent) {
    return { plan: createPromptPlan({ freeSubject: true }), prompt: '', negative, adult }
  }

  if (input.engine === 'krea2') {
    const plan = createPromptPlan({
      freeSubject: true,
      scenePrompt: manual.join(', '),
      sceneProse: description,
      emotion,
      camera: [camera],
      lighting: [lighting],
      composition: [composition],
      palette,
      manual,
      artistProse: input.artistProse,
    })
    return { plan, prompt: renderPromptPlan(plan, 'krea2', profile).prompt, negative, adult }
  }

  // User tokens precede profile defaults so an explicit weight wins deduplication.
  const sourceTags = mergeTokenText(tags, ...artistTags)
  const tagKeys = new Set(tokenize(sourceTags).map(tag => normalizeKey(tag.replace(/\\([()])/g, '$1'))))
  const plan = createPromptPlan({
    freeSubject: true,
    profile,
    scenePrompt: sourceTags,
    sceneProse: description,
    artists: artistTags,
    manual,
    camera: [camera],
    lighting: [lighting],
    characterTokens: [...(input.characterTokens || [])],
    copyrightTokens: (input.copyrightTokens || [])
      .filter(tag => tagKeys.has(normalizeKey(tag.replace(/\\([()])/g, '$1')))),
  })
  const qualityKeys = new Set(plan.quality.map(normalizeKey))
  plan.quality = tokenize(mergeTokenText(sourceTags, plan.quality.join(', ')))
    .filter(tag => qualityKeys.has(normalizeKey(tag)))
  const [tagLine, ...caption] = renderPromptPlan(plan, 'anima', profile).prompt.split('\n')
  return {
    plan,
    prompt: [escapeKnownLiteralTags(tagLine, manual), ...caption].join('\n'),
    negative,
    adult,
  }
}
