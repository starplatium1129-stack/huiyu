import type { Scene } from '../types/scene'
import type { SceneBlueprint } from '../types/sceneBlueprint'
import type { DraftRandomVariation, PromptBuilderDraft } from './promptBuilderPersistence'
import { sceneShot, sceneLighting, sceneComposition, sceneColorMood } from './sceneInference.ts'
import { renderRandomVariationProse } from './randomVariationProse.ts'
import { inferBlueprintLighting } from './blueprintLighting.ts'
import { DIRECTOR_CONTROL_KEYS, isManualDirectorValue } from './promptDirector.ts'
import type { DirectorControlSources } from '../types/promptDirector.ts'
import { inferBlueprintDecisions } from './popularBlueprintDecisions.ts'

type Context = { char: string; sceneId: string | null; subject: unknown }
type Controls = { selections: { shot: string | null; lighting: string | null }; directorSources?: DirectorControlSources; visualDescription: string }
type Source = {
  id: string; char?: string; characterId?: string; prompt?: string; promptTokens?: string[];
  animaCaption?: string; promptProse?: string; tags?: string[]; sceneTags?: string[];
  time?: string; timeOfDay?: string; lighting?: string; camera?: string; location?: string; action?: unknown
}

export const randomVariationContext = (value: Context): string => JSON.stringify([value.char, value.sceneId, value.subject])
export function randomVariationSource(value: Source | null): string {
  if (!value) return ''
  return JSON.stringify([value.id, value.char, value.characterId, value.promptTokens?.join(', ') ?? value.prompt ?? '',
    value.promptProse ?? value.animaCaption ?? '', value.sceneTags ?? value.tags ?? [],
    value.timeOfDay ?? value.time ?? '', value.lighting, value.camera, value.location, value.action,
    ...(value.promptProse === undefined || value.animaCaption === undefined ? [] : [value.animaCaption])])
}
export function activeRandomVariation(variation: DraftRandomVariation | null, context: Context, source: Source | null) {
  return variation?.context === randomVariationContext(context) && variation.source === randomVariationSource(source) ? variation : null
}

// The compiler's existing ASCII gate remains authoritative for user descriptions.
const userDescription = (text: string) => /^[\x20-\x7e]+$/.test(text.trim()) ? text.trim() : ''
export function variedStudioScene(source: Scene, variation: DraftRandomVariation, controls: Controls): Scene {
  const shot = isManualDirectorValue(controls.directorSources, 'shot', controls.selections.shot, sceneShot(source)) ? controls.selections.shot : null
  const lighting = isManualDirectorValue(controls.directorSources, 'lighting', controls.selections.lighting, sceneLighting(source)) ? controls.selections.lighting : null
  const prose = userDescription(controls.visualDescription) || renderRandomVariationProse(variation.prose, shot, lighting, sceneLighting(source))
  return { ...source, prompt: [variation.prompt, ...variation.outfit].filter(Boolean).join(', '), tags: variation.tags,
    animaCaption: prose, promptProse: prose,
    camera: shot ? '' : source.camera, lighting: source.lighting || sceneLighting(source) || '', emotion: '' }
}
export function variedPopularScene(source: SceneBlueprint, variation: DraftRandomVariation, controls: Controls): SceneBlueprint {
  const inherited = inferBlueprintDecisions(source)
  const shot = isManualDirectorValue(controls.directorSources, 'shot', controls.selections.shot, inherited.shot) ? controls.selections.shot : null
  const lighting = isManualDirectorValue(controls.directorSources, 'lighting', controls.selections.lighting, inherited.lighting) ? controls.selections.lighting : null
  const prose = userDescription(controls.visualDescription) ? '' : renderRandomVariationProse(variation.prose, shot, lighting, inherited.lighting)
  return { ...source, promptTokens: variation.prompt.split(',').map(token => token.trim()).filter(Boolean),
    promptProse: prose, animaCaption: prose,
    sceneTags: variation.tags, camera: shot ? '' : source.camera,
    lighting: source.lighting || inferBlueprintLighting(source) || '', mood: '' }
}

export function sceneStyleBaseline(scene: Scene) {
  return { shot: sceneShot(scene), lighting: sceneLighting(scene), composition: sceneComposition(scene), colorMood: sceneColorMood(scene) }
}
export function hasEditedSceneStyle(draft: PromptBuilderDraft): boolean {
  const values = { ...draft.selections, colorMood: draft.colorMood }
  return Boolean(draft.randomVariation || draft.selections?.emotion?.length)
    || DIRECTOR_CONTROL_KEYS.some(key => isManualDirectorValue(draft.directorSources, key, values[key], draft.sceneStyleBaseline?.[key]))
}
