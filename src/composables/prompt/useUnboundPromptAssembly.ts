import { computed, type Ref } from 'vue'
import type { PromptAssemblyState } from './usePromptAssembly'
import { COLOR_MOODS, LIGHTING, SHOT, COMPOSITION } from '@/config/promptConstants'
import { artistStyleProse, artistTagsForEngine } from '@/config/artistStyles'
import { analyzeParts, checkArtDirection, mergeTokenText, type PromptEngine } from '@/utils/promptPolicy'
import { escapeKnownLiteralTags } from '@/utils/promptLiteralTags'
import { resolveDrawCapabilities } from '@/utils/drawCapabilities'
import type { ModelProfile } from '@/utils/promptPolicy'

/** Free subjects use model quality defaults without adding character, rating or scene defaults. */
export function useUnboundPromptAssembly(pb: PromptAssemblyState, engine: Readonly<Ref<PromptEngine>>, profile: Readonly<Ref<ModelProfile | null>>) {
  const positivePrompt = computed(() => {
    const family = engine.value
    const artists = pb.directorMode === 'pro' ? pb.artistStyleIds : []
    const description = pb.visualDescription.trim()
    const directions = [
      [SHOT, pb.selections.shot], [LIGHTING, pb.selections.lighting],
      [COMPOSITION, pb.selections.composition], [COLOR_MOODS, pb.colorMood],
    ] as const
    let tags = [...pb.manualTags, pb.emotionPrompt,
      ...directions.map(([options, id]) => options.find(item => item.id === id)?.prompt),
    ].filter(Boolean).join(', ')
    if (family === 'krea2') {
      // Keep all recognized subjects and counts; do not synthesize a woman or an empty-scene guard.
      tags = tags.replace(/\(([^()\n]+):\s*-?\d+(?:\.\d+)?\s*\)/g, '$1').replace(/_/g, ' ').replace(/\b(\d+)(girls?|boys?)\b/g, '$1 $2')
    } else {
      const styleTags = artistTagsForEngine(artists, family)
      // Model defaults alone must not turn an empty draft into a drawable scene.
      if (!tags && !description && !styleTags.length) return ''
      // User tokens come first so explicit weights survive deduplication.
      tags = mergeTokenText(tags, ...styleTags, profile.value?.quality_prefix || '')
      if (family === 'anima') tags = escapeKnownLiteralTags(tags, [...pb.manualTags])
    }
    return [tags, description, family === 'krea2' ? artistStyleProse(artists, family) : ''].filter(Boolean).join('\n')
  })
  const negativePrompt = computed(() => resolveDrawCapabilities(engine.value, profile.value).negative
    ? mergeTokenText(pb.sdParams.negativeCustom, profile.value?.negative_prefix || '') : '')
  const previewPrompt = computed(() => negativePrompt.value ? `${positivePrompt.value}\n[NEG]\n${negativePrompt.value}` : positivePrompt.value)
  const promptReport = computed(() => analyzeParts([
    { text: positivePrompt.value }, { cls: 'n', text: negativePrompt.value },
  ], engine.value))
  const artViolations = computed(() => checkArtDirection(positivePrompt.value))
  return { positivePrompt, negativePrompt, previewPrompt, promptReport, artViolations }
}
