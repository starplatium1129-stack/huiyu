import { computed, type Ref } from 'vue'
import type { PromptAssemblyState } from './usePromptAssembly'
import { COLOR_MOODS, LIGHTING, SHOT, COMPOSITION } from '@/config/promptConstants'
import { artistStyleProse, artistTagsForEngine } from '@/config/artistStyles'
import { analyzeParts, checkArtDirection, type PromptEngine } from '@/utils/promptPolicy'
import { escapeKnownLiteralTags } from '@/utils/promptLiteralTags'
import { resolveDrawCapabilities } from '@/utils/drawCapabilities'
import type { ModelProfile } from '@/utils/promptPolicy'

/** Free subjects retain source content without the character compiler's identity, rating or scene defaults. */
export function useUnboundPromptAssembly(pb: PromptAssemblyState, engine: Readonly<Ref<PromptEngine>>, profile: Readonly<Ref<ModelProfile | null>>) {
  const positivePrompt = computed(() => {
    const artists = pb.directorMode === 'pro' ? pb.artistStyleIds : []
    const directions = [
      pb.emotionPrompt,
      SHOT.find(item => item.id === pb.selections.shot)?.prompt,
      LIGHTING.find(item => item.id === pb.selections.lighting)?.prompt,
      COMPOSITION.find(item => item.id === pb.selections.composition)?.prompt,
      COLOR_MOODS.find(item => item.id === pb.colorMood)?.prompt,
    ].filter(Boolean)
    const tags = [...pb.manualTags, ...directions].join(', ')
    if (engine.value === 'krea2') {
      // Keep all recognized subjects and counts; do not synthesize a woman or an empty-scene guard.
      const description = tags.replace(/\(([^()\n]+):\s*-?\d+(?:\.\d+)?\s*\)/g, '$1').replace(/_/g, ' ').replace(/\b(\d+)(girls?|boys?)\b/g, '$1 $2')
      return [description, pb.visualDescription.trim(), artistStyleProse(artists, 'krea2')].filter(Boolean).join('\n')
    }
    const styledTags = [tags, ...artistTagsForEngine(artists, engine.value)].filter(Boolean).join(', ')
    const formatted = engine.value === 'anima' ? escapeKnownLiteralTags(styledTags, [...pb.manualTags]) : styledTags
    return [formatted, pb.visualDescription.trim()].filter(Boolean).join('\n')
  })
  const negativePrompt = computed(() => resolveDrawCapabilities(engine.value, profile.value).negative ? pb.sdParams.negativeCustom.trim() : '')
  const previewPrompt = computed(() => negativePrompt.value ? `${positivePrompt.value}\n[NEG]\n${negativePrompt.value}` : positivePrompt.value)
  const promptReport = computed(() => analyzeParts([
    { cls: 'q', text: positivePrompt.value }, ...(negativePrompt.value ? [{ cls: 'n' as const, text: negativePrompt.value }] : []),
  ], engine.value))
  const artViolations = computed(() => checkArtDirection(positivePrompt.value))
  return { positivePrompt, negativePrompt, previewPrompt, promptReport, artViolations }
}
