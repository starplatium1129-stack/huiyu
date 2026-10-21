import { GENERATION_FILTER_FIELDS, normalizeGalleryFilterSnapshot, type GalleryFilterSnapshot } from '@/composables/gallery/galleryGenerationConditions'
import { writeProfileLocal, profileLocalStorage, type ProfileWriteReceipt } from '@/platform/web/profileStorage'
import { GALLERY_FILTER_PRESETS_KEY } from '@/utils/storageKeys'
import type { SettingDefinition } from './settingsRepository'

const GALLERY_FILTER_PRESET_LIMIT = 24
export const GALLERY_FILTER_NAME_LIMIT = 60
// Cross-window merges can exceed the UI creation count. Bound bytes instead of
// making valid concurrent additions unreadable and impossible to remove.
const GALLERY_FILTER_PRESET_MAX_BYTES = 4 * 1024 * 1024
function withinPresetBudget(raw: string): boolean {
  return raw.length <= GALLERY_FILTER_PRESET_MAX_BYTES && new TextEncoder().encode(raw).byteLength <= GALLERY_FILTER_PRESET_MAX_BYTES
}
export interface GalleryFilterPreset { id: string; name: string; filters: GalleryFilterSnapshot }
const GALLERY_FILTER_PRESETS_SETTING: SettingDefinition<GalleryFilterPreset[]> = {
  key: GALLERY_FILTER_PRESETS_KEY,
  parse(raw) {
    if (raw === null) return []
    if (!withinPresetBudget(raw)) return null
    try {
      const object: unknown = JSON.parse(raw)
      if (!object || typeof object !== 'object' || Array.isArray(object)) return null
      const entries = Object.entries(object)
      const presets: GalleryFilterPreset[] = []
      for (const [id, entry] of entries) {
        if (!/^[a-zA-Z0-9-]{1,80}$/.test(id) || !entry || typeof entry !== 'object') return null
        const value = entry as Record<string, unknown>
        if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > GALLERY_FILTER_NAME_LIMIT) return null
        if (!value.filters || typeof value.filters !== 'object') return null
        const input = value.filters as Record<string, unknown>
        if (typeof input.favoriteOnly !== 'boolean' || ['projectFilter', 'searchQuery', 'tagFilter'].some(field => typeof input[field] !== 'string')
          || !input.generation || typeof input.generation !== 'object') return null
        const filters = normalizeGalleryFilterSnapshot(input)
        const generation = input.generation as Record<string, unknown>
        if (GENERATION_FILTER_FIELDS.some(field => generation[field] !== filters.generation[field])) return null
        presets.push({ id, name: value.name.trim(), filters })
      }
      return presets
    } catch { return null }
  },
  // Flat IDs let the existing profile conflict merge preserve independent presets.
  serialize(value) {
    const raw = JSON.stringify(Object.fromEntries(value.map(preset => [preset.id, { name: preset.name, filters: normalizeGalleryFilterSnapshot(preset.filters) }])))
    if (!withinPresetBudget(raw)) throw new Error('筛选组合资料过大，请缩短搜索条件后重试。')
    return raw
  },
}
function createGalleryFilterPreferences() {
  function read(): GalleryFilterPreset[] {
    const presets = GALLERY_FILTER_PRESETS_SETTING.parse(profileLocalStorage.getItem(GALLERY_FILTER_PRESETS_KEY))
    if (!presets) throw new Error('已保存的筛选组合格式无法读取，请先核对本机资料。')
    return presets
  }
  let receipt: ProfileWriteReceipt | null = null
  async function commit(change: (presets: GalleryFilterPreset[]) => GalleryFilterPreset[]) {
    await receipt?.confirm()
    const next = change(read())
    receipt = writeProfileLocal(GALLERY_FILTER_PRESETS_KEY, GALLERY_FILTER_PRESETS_SETTING.serialize(next))
    await receipt.confirm()
    return read()
  }
  return {
    read,
    save(name: string, filters: GalleryFilterSnapshot) {
      const title = name.trim()
      const snapshot = normalizeGalleryFilterSnapshot(filters)
      if (!title || title.length > GALLERY_FILTER_NAME_LIMIT) return Promise.reject(new Error(`组合名称需为 1–${GALLERY_FILTER_NAME_LIMIT} 个字。`))
      return commit(presets => {
        const existing = presets.find(preset => preset.name === title)
        if (!existing && presets.length >= GALLERY_FILTER_PRESET_LIMIT) throw new Error(`最多保存 ${GALLERY_FILTER_PRESET_LIMIT} 个组合，请先移除不再使用的组合。`)
        const preset = { id: existing?.id || crypto.randomUUID(), name: title, filters: snapshot }
        return existing ? presets.map(value => value.id === existing.id ? preset : value) : [...presets, preset]
      })
    },
    remove(id: string) { return commit(presets => presets.filter(preset => preset.id !== id)) },
  }
}
export const galleryFilterPreferences = createGalleryFilterPreferences()
