import { computed, onActivated, onDeactivated, onScopeDispose, shallowRef, watch } from 'vue'
import {
  applyCharacterAtmosphere, characterThemeStyle, clearCharacterAtmosphere, STUDIO_CHARACTER_THEMES,
  type CharacterThemeCatalog, type CharacterThemeRecord,
} from '@/utils/characterTheme'

let cachedCatalog: CharacterThemeCatalog | null = null
let catalogRequest: Promise<CharacterThemeCatalog> | null = null
function loadCatalog(): Promise<CharacterThemeCatalog> {
  if (cachedCatalog) return Promise.resolve(cachedCatalog)
  return catalogRequest ??= import('@/utils/characterThemeCatalog')
    .then(module => (cachedCatalog = module.POPULAR_CHARACTER_THEMES))
    .finally(() => { catalogRequest = null })
}

/** Theme loading never owns the character selection or generation state. */
export function useCharacterAtmosphere(character: () => string, records: () => readonly CharacterThemeRecord[]) {
  const catalog = shallowRef(cachedCatalog ?? STUDIO_CHARACTER_THEMES)
  const style = computed(() => characterThemeStyle(character(), records(), catalog.value))
  let active = true
  let disposed = false
  let revision = 0

  function sync() {
    const request = ++revision
    if (!active || disposed) return
    const id = character()
    if (cachedCatalog) catalog.value = cachedCatalog
    // Built-ins are synchronous; an uncached character uses its validated data
    // accent (or the existing default) while the optional calibration loads.
    applyCharacterAtmosphere(id, records(), catalog.value)
    if (!id || STUDIO_CHARACTER_THEMES[id] || cachedCatalog) return
    void loadCatalog().then(value => {
      if (disposed || !active || request !== revision || id !== character()) return
      catalog.value = value
      applyCharacterAtmosphere(id, records(), value)
    }).catch(() => {
      // Keep the safe theme. The request cache is cleared so switching character
      // or reactivating this workspace can retry a failed optional download.
    })
  }
  function deactivate() {
    active = false
    revision += 1
    clearCharacterAtmosphere()
  }
  watch([character, records], sync, { immediate: true })
  onActivated(() => { active = true; sync() })
  onDeactivated(deactivate)
  onScopeDispose(() => { disposed = true; deactivate() })
  return style
}
