import type { Scene } from '../types/scene'
import type { DirectorControlSources } from '../types/promptDirector'
import { CHAR_PROMPT, STUDIO_PROMPT_SUBJECTS, SHOT, LIGHTING, COMPOSITION, COLOR_MOODS } from '../config/promptConstants.ts'
import {
  assembleNegative, characterControlTokens, isManualR18Tags, profileRatingTag,
  sceneRating, sceneSupportsCharacter, sceneTemplateText, tokenize, type ModelProfile,
} from './promptPolicy.ts'
import { sceneComposition, sceneLighting, sceneShot, sceneColorMood } from './sceneInference.ts'
import { createPromptPlan, renderPromptPlan } from './promptCompiler.ts'
import { isManualDirectorValue } from './promptDirector.ts'
import { studioDualSubject } from './studioDualSubject.ts'

export interface PromptLoraMetadata {
  id?: string
  name?: string
  prompt_contract?: unknown
}

export interface StudioPromptOptions {
  character: string
  scene: Scene | null
  engine: 'anima' | 'krea2'
  profile?: ModelProfile | null
  activeLoras?: Record<string, string>
  loraMeta?: readonly PromptLoraMetadata[]
  identity?: string
  /** Explicit replacement controls, e.g. an adopted reference outfit. */
  controls?: string[]
  manual?: string[]
  emotion?: string[]
  shot?: string | null
  lighting?: string | null
  composition?: string | null
  directorSources?: DirectorControlSources
  palette?: string[]
  artistTags?: string[]
  artistProse?: string
  visualDescription?: string
  negativeCustom?: string
  matureTokens?: ReadonlySet<string>
}

/** The same selected LoRA contract applies to editing, batch recipes and content previews. */
export function studioPromptProfile(
  base: ModelProfile | null, engine: string, activeLoras: Record<string, string> = {},
  metadata: readonly PromptLoraMetadata[] = [],
): ModelProfile | null {
  if (!base || engine !== 'anima') return base
  const selected = Object.values(activeLoras).filter(Boolean)
  const contracts = metadata.filter(meta => selected.some(id =>
    meta.id === id || meta.name === id || meta.id?.includes(id) || meta.name?.includes(id)))
    .flatMap(meta => meta.prompt_contract && typeof meta.prompt_contract === 'object'
      ? [meta.prompt_contract as { exact_tokens?: unknown; exact_prefixes?: unknown }] : [])
  if (!contracts.length) return base
  const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  return {
    ...base,
    exact_tokens: [...new Set([...(base.exact_tokens || []), ...contracts.flatMap(c => strings(c.exact_tokens))])],
    exact_prefixes: [...new Set([...(base.exact_prefixes || []), ...contracts.flatMap(c => strings(c.exact_prefixes))])],
  }
}

export function studioSubjectProse(character: string): string {
  if (character === 'nene') return 'Ayachi Nene is the only prominent character, a young adult woman with white hair, purple eyes, an ahoge, and pink hair ribbons'
  if (character === 'natsume') return 'Shiki Natsume is the only prominent character, a young adult woman with black hair, golden-yellow eyes, two red hairclips, and a small mole beneath one eye'
  return ''
}

/** Resolve the scene once, then pass all authored context to the public renderer. */
export function buildStudioPromptPlan(options: StudioPromptOptions) {
  const { character, engine } = options
  const manual = [...(options.manual || [])]
  const manualAdult = isManualR18Tags(manual, options.matureTokens)
  const supported = options.scene && sceneSupportsCharacter(options.scene, character) ? options.scene : null
  const scene: Scene | null = manualAdult
    ? { ...(supported || { id: 'custom_r18', title: '自定义 R18', prompt: '', tags: [], negative: '' }), rating: 'R18', mature: true }
    : supported
  const activeLoras = engine === 'anima' ? options.activeLoras || {} : {}
  const profile = studioPromptProfile(options.profile ?? null, engine, activeLoras, options.loraMeta)
  const inherited = { shot: sceneShot(scene), lighting: sceneLighting(scene), composition: sceneComposition(scene) }
  const selections = {
    shot: options.shot === undefined ? inherited.shot : options.shot,
    lighting: options.lighting === undefined ? inherited.lighting : options.lighting,
    composition: options.composition === undefined ? inherited.composition : options.composition,
  }
  const cameraSource = isManualDirectorValue(options.directorSources, 'shot', selections.shot, inherited.shot) ? 'manual' : 'scene'
  const lightingSource = isManualDirectorValue(options.directorSources, 'lighting', selections.lighting, inherited.lighting) ? 'manual' : 'scene'
  const template = sceneTemplateText(scene, { char: character, manualTags: new Set(manual), shot: selections.shot, engine, profile })
  const subject = character === 'triad' && engine === 'krea2'
    ? studioDualSubject(template) : { scenePrompt: template, subjectProse: studioSubjectProse(character) }
  const plan = createPromptPlan({
    profile, identity: options.identity ?? CHAR_PROMPT[character] ?? '',
    ...STUDIO_PROMPT_SUBJECTS[character], ...subject,
    controls: options.controls ?? characterControlTokens(scene, character, activeLoras),
    artists: [...(options.artistTags || [])], artistProse: options.artistProse,
    camera: selections.shot ? [SHOT.find(item => item.id === selections.shot)?.prompt || ''] : [],
    lighting: selections.lighting ? [LIGHTING.find(item => item.id === selections.lighting)?.prompt || ''] : [],
    composition: selections.composition ? [COMPOSITION.find(item => item.id === selections.composition)?.prompt || ''] : [],
    cameraSource, lightingSource,
    manual, emotion: [...(options.emotion || [])],
    palette: options.palette ? [...options.palette] : tokenize(COLOR_MOODS.find(mood => mood.id === sceneColorMood(scene))?.prompt || ''),
    negative: scene?.negative || '', rating: profileRatingTag(profile, scene) || sceneRating(scene).toLowerCase(),
    visualDescription: options.visualDescription, scene,
  })
  return {
    plan, ...renderPromptPlan(plan, engine, profile),
    negative: assembleNegative(profile, scene, engine, { character, shot: selections.shot, custom: options.negativeCustom }),
    adult: sceneRating(scene) === 'R18', profile, selections,
  }
}
