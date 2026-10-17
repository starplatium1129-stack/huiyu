import { ref, computed, type Ref } from 'vue'
import type { Scene } from '@/types/scene'
import type { CharKey } from '@/types/promptHistory'

/** Display controls and scene filtering, independent of drafts and generation. */
export function usePromptSceneFilters(scenes: Readonly<Ref<Scene[]>>, char: Readonly<Ref<CharKey>>) {
  // ── UI state ────────────────────────────────────────────────────────────
  const focusMode     = ref(false)
  const directorMode  = ref<'basic' | 'pro'>('basic')
  const sceneSearch   = ref('')
  const sceneTheme    = ref('all')

  const filteredScenes = computed(() => {
    let list = scenes.value
    if (char.value !== 'triad') {
      list = list.filter(s => !s.char || s.char === char.value || s.char === 'both')
    }
    if (sceneTheme.value && sceneTheme.value !== 'all') {
      list = list.filter(s => s.category === sceneTheme.value || (s.series && s.series.includes(sceneTheme.value)))
    }
    if (sceneSearch.value.trim()) {
      const kw = sceneSearch.value.trim().toLowerCase()
      list = list.filter(s =>
        s.title?.toLowerCase().includes(kw) ||
        s.story?.toLowerCase().includes(kw) ||
        s.tags?.some(t => t.toLowerCase().includes(kw))
      )
    }
    return list
  })


  return { focusMode, directorMode, sceneSearch, sceneTheme, filteredScenes }
}
