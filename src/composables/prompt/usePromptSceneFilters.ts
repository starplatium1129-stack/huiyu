import { ref, computed, watch, type Ref } from 'vue'
import type { Scene } from '@/types/scene'
import type { CharKey } from '@/types/promptHistory'

/** Display controls and scene filtering, independent of drafts and generation. */
export function usePromptSceneFilters(scenes: Readonly<Ref<Scene[]>>, char: Readonly<Ref<CharKey>>) {
  // ── UI state ────────────────────────────────────────────────────────────
  const focusMode     = ref(false)
  const directorMode  = ref<'basic' | 'pro'>('basic')
  const sceneSearch   = ref('')
  const sceneTheme    = ref('all')

  const scopedScenes = computed(() => {
    let list = scenes.value
    if (char.value !== 'triad') {
      list = list.filter(s => !s.char || s.char === char.value || s.char === 'both')
    }
    if (sceneTheme.value && sceneTheme.value !== 'all') {
      list = list.filter(s => s.category === sceneTheme.value || (s.series && s.series.includes(sceneTheme.value)))
    }
    return list
  })

  const searching = computed(() => !!sceneSearch.value.trim())
  // Normalize catalogue text once per data change, rather than on every keystroke.
  // Keep fields separate so a match cannot span a title, story or tag boundary.
  const searchDocuments = computed(() => searching.value ? new Map(scenes.value.map(scene => [scene,
    [scene.title || '', scene.story || '', ...(scene.tags || [])].map(text => text.toLowerCase()),
  ])) : null)
  watch(searching, active => { if (!active) void searchDocuments.value }, { flush: 'sync' })

  const filteredScenes = computed(() => {
    const list = scopedScenes.value, keyword = sceneSearch.value.trim().toLowerCase()
    if (!keyword) return list
    const documents = searchDocuments.value
    return list.filter(scene => documents?.get(scene)?.some(text => text.includes(keyword)))
  })

  return { focusMode, directorMode, sceneSearch, sceneTheme, filteredScenes }
}
