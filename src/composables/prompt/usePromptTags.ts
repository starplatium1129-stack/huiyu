import { computed, ref, watch } from 'vue'
import { mutualGroupWithCategory } from '@/utils/promptPolicy'
import { createPromptTagDictionary, type PromptTagSource } from '@/utils/promptTagDictionary'

/** All import paths (typing, random, WD14, drafts and Remix) share this state. */
export function usePromptTags(catalog: () => readonly PromptTagSource[], flash: (message: string) => void) {
  const manualTags = ref(new Set<string>())
  const tagDictionary = computed(() => createPromptTagDictionary(catalog()))
  watch([manualTags, tagDictionary], () => {
    const next = new Set([...manualTags.value].map(tagDictionary.value.canonicalize).filter(Boolean))
    if (next.size !== manualTags.value.size || [...next].some(tag => !manualTags.value.has(tag))) manualTags.value = next
  }, { deep: true, flush: 'sync' })

  function addManualTag(input: string): 'added' | 'replaced' | 'duplicate' {
    const tag = tagDictionary.value.canonicalize(input)
    const next = new Set(manualTags.value)
    if (!tag || next.has(tag)) return 'duplicate'
    const incoming = mutualGroupWithCategory(tag)
    const replaced = incoming ? [...next].filter(candidate => {
      const existing = mutualGroupWithCategory(candidate)
      return existing?.category === incoming.category && existing.group !== incoming.group
    }) : []
    replaced.forEach(candidate => next.delete(candidate))
    next.add(tag)
    manualTags.value = next
    if (replaced.length) flash(`已用「${tag}」替换冲突词条「${replaced.join('、')}」`)
    return replaced.length ? 'replaced' : 'added'
  }
  function toggleManualTag(input: string) {
    const tag = tagDictionary.value.canonicalize(input)
    if (!manualTags.value.has(tag)) { addManualTag(tag); return }
    manualTags.value = new Set([...manualTags.value].filter(value => value !== tag))
  }
  return { manualTags, tagDictionary, addManualTag, toggleManualTag }
}
