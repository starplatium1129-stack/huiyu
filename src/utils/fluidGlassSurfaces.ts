import type { ObjectDirective } from 'vue'

const surfaces = new Set<HTMLElement>()
const observers = new Set<(element: HTMLElement, mounted: boolean) => void>()

function update(element: HTMLElement, enabled: boolean) {
  if (enabled === surfaces.has(element)) return
  if (enabled) surfaces.add(element)
  else surfaces.delete(element)
  for (const observer of observers) observer(element, enabled)
}

export const glassOptics: ObjectDirective<HTMLElement, boolean | undefined> = {
  mounted: (element, binding) => update(element, binding.value !== false),
  updated: (element, binding) => update(element, binding.value !== false),
  unmounted: element => update(element, false),
}

/** Only authored surfaces are registered. KeepAlive roots can reappear later. */
export function observeGlassSurfaces(observer: (element: HTMLElement, mounted: boolean) => void) {
  observers.add(observer)
  for (const element of surfaces) observer(element, true)
  return () => { observers.delete(observer) }
}
