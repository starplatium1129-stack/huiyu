import bundledPresetCatalog from '../../data/presets.json'
import { parsePresetCatalog } from './promptBuilderPersistence'
import type { ModelProfile } from './promptPolicy'

/** Read-only upgrade defaults, loaded with the catalog rather than the route. */
export function fillMissingModelProfiles(personal: ModelProfile[]): ModelProfile[] {
  const ids = new Set(personal.map(profile => profile.id))
  const models = new Set(personal.map(profile => profile.model_id))
  const missing = parsePresetCatalog(bundledPresetCatalog).modelProfiles.filter(profile =>
    !ids.has(profile.id) && (!profile.model_id || !models.has(profile.model_id)))
  return [...personal, ...missing].map(profile => JSON.parse(JSON.stringify(profile)))
}
