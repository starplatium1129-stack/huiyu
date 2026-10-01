import type { Scene } from '../types/scene'
import type { SceneBlueprint } from '../types/sceneBlueprint'
import type { DraftRandomVariation, PromptBuilderDraft } from './promptBuilderPersistence'
import { sceneShot, sceneLighting, sceneComposition, sceneColorMood } from './sceneInference.ts'
import { renderRandomVariationProse } from './randomVariationProse.ts'

type Context = { char: string; sceneId: string | null; subject: unknown }
type Controls = { selections: { shot: string | null; lighting: string | null }; visualDescription: string }
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
    value.timeOfDay ?? value.time ?? '', value.lighting, value.camera, value.location, value.action])
}
export function activeRandomVariation(variation: DraftRandomVariation | null, context: Context, source: Source | null) {
  return variation?.context === randomVariationContext(context) && variation.source === randomVariationSource(source) ? variation : null
}

// The compiler's existing ASCII gate remains authoritative for user descriptions.
const userDescription = (text: string) => /^[\x20-\x7e]+$/.test(text.trim()) ? text.trim() : ''
export function variedStudioScene(source: Scene, variation: DraftRandomVariation, controls: Controls): Scene {
  return { ...source, prompt: [variation.prompt, ...variation.outfit].filter(Boolean).join(', '), tags: variation.tags,
    animaCaption: userDescription(controls.visualDescription) || renderRandomVariationProse(variation.prose, controls.selections.shot, controls.selections.lighting),
    camera: controls.selections.shot ? '' : source.camera, lighting: controls.selections.lighting ? '' : source.lighting, emotion: '' }
}
export function variedPopularScene(source: SceneBlueprint, variation: DraftRandomVariation, controls: Controls): SceneBlueprint {
  return { ...source, promptTokens: variation.prompt.split(',').map(token => token.trim()).filter(Boolean),
    promptProse: userDescription(controls.visualDescription) ? '' : renderRandomVariationProse(variation.prose, controls.selections.shot, controls.selections.lighting),
    sceneTags: variation.tags, camera: controls.selections.shot ? '' : source.camera, lighting: controls.selections.lighting ? '' : source.lighting, mood: '' }
}

export function sceneStyleBaseline(scene: Scene) {
  return { shot: sceneShot(scene), lighting: sceneLighting(scene), composition: sceneComposition(scene), colorMood: sceneColorMood(scene) }
}
export function hasEditedSceneStyle(draft: PromptBuilderDraft): boolean {
  const baseline = draft.sceneStyleBaseline
  return Boolean(draft.randomVariation) || Boolean(baseline && (
    draft.selections?.emotion?.length || draft.selections?.shot !== baseline.shot
    || draft.selections?.lighting !== baseline.lighting || draft.selections?.composition !== baseline.composition
    || draft.colorMood !== baseline.colorMood))
}
