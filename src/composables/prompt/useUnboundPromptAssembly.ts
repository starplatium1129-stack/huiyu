import { computed, type Ref } from 'vue'
import type { PromptAssemblyState } from './usePromptAssembly'
import type { PopularPromptAssemblyState } from './usePopularPromptAssembly'
import { COLOR_MOODS, LIGHTING, SHOT, COMPOSITION, STUDIO_PROMPT_SUBJECTS } from '@/config/promptConstants'
import { artistStyleProse, artistTagsForEngine } from '@/config/artistStyles'
import { analyzeParts, checkArtDirection, mergeTokenText, type PromptEngine, type ModelProfile } from '@/utils/promptPolicy'
import { compilePromptRecipe } from '@/utils/promptRecipe'
import { resolveDrawCapabilities } from '@/utils/drawCapabilities'
import { mossArtistTags } from '@/utils/mossPrompt'

/** The workspace supplies selections; the shared recipe owns native prompt rendering. */
export function useUnboundPromptAssembly(pb: PromptAssemblyState & Pick<PopularPromptAssemblyState, 'popularCharacters'>, engine: Readonly<Ref<PromptEngine>>, profile: Readonly<Ref<ModelProfile | null>>) {
  const artists = computed(() => pb.directorMode === 'pro' ? pb.artistStyleIds : [])
  function buildResult(target: 'anima' | 'krea2' | 'moss') {
    const subjects = [...Object.values(STUDIO_PROMPT_SUBJECTS), ...pb.popularCharacters]
    return compilePromptRecipe({
      kind: 'free', engine: target, profile: target === 'moss' ? null : profile.value,
      manual: [...pb.manualTags], emotion: pb.emotionPrompt ? [pb.emotionPrompt] : [],
      shot: pb.selections.shot, lighting: pb.selections.lighting, composition: pb.selections.composition,
      palette: [COLOR_MOODS.find(item => item.id === pb.colorMood)?.prompt || ''],
      artistTags: target === 'moss' ? mossArtistTags(artists.value) : artistTagsForEngine(artists.value, target),
      artistProse: target === 'moss' ? '' : artistStyleProse(artists.value, target),
      visualDescription: pb.visualDescription, negativeCustom: pb.sdParams.negativeCustom,
      characterTokens: [...subjects.flatMap(subject => subject.characterTokens || []), ...(pb.referenceInput?.characterTokens || [])],
      copyrightTokens: [...subjects.flatMap(subject => subject.copyrightTokens || []), ...(pb.referenceInput?.copyrightTokens || [])],
    })
  }
  const result = computed(() => engine.value === 'sd' ? null : buildResult(engine.value))
  const structuredPlan = computed(() => result.value?.plan ?? null)
  const mossPlan = computed(() => buildResult('moss').plan)
  const positivePrompt = computed(() => {
    if (engine.value !== 'sd') return result.value?.prompt ?? ''
    const description = pb.visualDescription.trim()
    const directions = [
      [SHOT, pb.selections.shot], [LIGHTING, pb.selections.lighting],
      [COMPOSITION, pb.selections.composition], [COLOR_MOODS, pb.colorMood],
    ] as const
    const tags = [...pb.manualTags, pb.emotionPrompt, ...directions.map(([options, id]) => options.find(item => item.id === id)?.prompt)]
      .filter(Boolean).join(', ')
    const styles = artistTagsForEngine(artists.value, 'sd')
    if (!tags && !description && !styles.length) return ''
    return [mergeTokenText(tags, ...styles, profile.value?.quality_prefix || ''), description].filter(Boolean).join('\n')
  })
  const negativePrompt = computed(() => engine.value !== 'sd' ? result.value?.negative ?? ''
    : resolveDrawCapabilities('sd', profile.value).negative ? mergeTokenText(pb.sdParams.negativeCustom, profile.value?.negative_prefix || '') : '')
  const previewPrompt = computed(() => negativePrompt.value ? `${positivePrompt.value}\n[NEG]\n${negativePrompt.value}` : positivePrompt.value)
  const promptReport = computed(() => analyzeParts([
    { text: positivePrompt.value }, { cls: 'n', text: negativePrompt.value },
  ], engine.value, profile.value))
  const artViolations = computed(() => checkArtDirection(positivePrompt.value, profile.value))
  return { structuredPlan, mossPlan, positivePrompt, negativePrompt, previewPrompt, promptReport, artViolations }
}
