import { shallowRef } from 'vue'
import { catalogApi } from '../api/catalogApi'
import { parseSceneBlueprints, type SceneBlueprint } from '../utils/popularContent.ts'
import { requireDataCollection } from '../utils/dataRecords.ts'
import { isLocalStudioHost } from '../utils/runtimeEnvironment'

/** Only requested characters enter reactive state; remote fallback shares in-flight parsing. */
export function useBlueprintCatalog(fetchFallback: () => Promise<unknown>) {
  const sceneBlueprints = shallowRef<SceneBlueprint[]>([])
  let epoch = 0
  const loaded = shallowRef(new Set<string>()), requests = new Map<string, Promise<void>>()
  let fallback: Promise<Map<string, SceneBlueprint[]>> | null = null

  function fallbackGroups() {
    if (fallback) return fallback
    const request = fetchFallback().then(raw => {
      const groups = new Map<string, SceneBlueprint[]>()
      for (const blueprint of parseSceneBlueprints(requireDataCollection(raw, 'blueprints'))) {
        const id = blueprint.characterId ?? ''
        if (!groups.has(id)) groups.set(id, [])
        groups.get(id)!.push(blueprint)
      }
      return groups
    }).finally(() => { if (fallback === request) fallback = null })
    // Do not retain an entire remote catalog across requests: each subsequent
    // uncached character must still pass the server's live publication checks.
    fallback = request
    return request
  }

  function loadBlueprintCharacter(id: string): Promise<void> {
    if (loaded.value.has(id)) return Promise.resolve()
    const existing = requests.get(id)
    if (existing) return existing
    const selectedEpoch = epoch
    const request = (async () => {
      const parsed = isLocalStudioHost()
        ? parseSceneBlueprints((await catalogApi.blueprints(id)).blueprints)
        : (await fallbackGroups()).get(id) ?? []
      if (epoch === selectedEpoch) {
        sceneBlueprints.value = [...sceneBlueprints.value.filter(item => item.characterId !== id), ...parsed.filter(item => item.characterId === id)]
        loaded.value = new Set([...loaded.value, id])
      }
    })().finally(() => { if (requests.get(id) === request) requests.delete(id) })
    requests.set(id, request)
    return request
  }

  function invalidate(ids?: ReadonlySet<string>) {
    ++epoch; requests.clear(); fallback = null
    if (!ids) { loaded.value = new Set(); sceneBlueprints.value = [] }
    else if (ids.size) {
      loaded.value = new Set([...loaded.value].filter(id => !ids.has(id)))
      sceneBlueprints.value = sceneBlueprints.value.filter(item => !ids.has(item.characterId ?? ''))
    }
  }
  return { sceneBlueprints, loadBlueprintCharacter, hasBlueprintCharacter: (id: string) => loaded.value.has(id), invalidate }
}
