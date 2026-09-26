import { profileLocalStorage as localStorage } from '../../platform/web/profileStorage.ts'
import { computed, ref, watch, type Ref } from 'vue'
import { STAGE_FRAMING_KEY as key } from '@/utils/storageKeys'

type Framing = { zoom: number; x: number; y: number }
export type StageSurface = 'room' | 'immersive' | 'companion'

/** Room defaults are calibrated independently; other surfaces keep their own framing. */
export function defaultStageFraming(character: string, surface: StageSurface): Framing {
  if (surface === 'room') {
    if (character === 'hatsune_miku') return { zoom: 1, x: 0, y: 0 }
    if (character === 'natsume') return { zoom: .9, x: 0, y: 0 }
    if (character === 'nene') return { zoom: 1.1, x: 0, y: 0 }
  }
  if (character === 'hatsune_miku') return surface === 'immersive'
    ? { zoom: 1, x: 0, y: -12 } : { zoom: 1, x: 0, y: 0 }
  return { zoom: 1, x: 0, y: 0 }
}

/** Presentation-only calibration. Author assets and outfit state are untouched. */
export function useStageFraming(character: Ref<string>, surface: () => StageSurface) {
  const defaults = (): Framing => defaultStageFraming(character.value, surface())
  const framing = ref<Framing>(defaults())
  function read() {
    try {
      const saved = JSON.parse(localStorage.getItem(key) || '{}')[`${surface()}:${character.value}`]
      framing.value = normalizeFraming(saved, defaults())
    } catch { framing.value = defaults() }
  }
  function save() {
    try {
      const all = JSON.parse(localStorage.getItem(key) || '{}')
      localStorage.setItem(key, JSON.stringify({ ...all, [`${surface()}:${character.value}`]: framing.value }))
    } catch { /* Storage may be unavailable; the current view remains adjustable. */ }
  }
  function update(field: keyof Framing, value: number) {
    framing.value = normalizeFraming({ ...framing.value, [field]: value }, defaults())
    save()
  }
  function reset() { framing.value = defaults(); save() }
  watch([character, surface], read, { immediate: true })
  const framingStyle = computed(() => ({
    '--stage-zoom': framing.value.zoom,
    '--stage-x': `${framing.value.x}%`,
    '--stage-y': `${framing.value.y}%`,
  }))
  return { framing, framingStyle, update, reset }
}

export function normalizeFraming(value: Partial<Framing> | null, fallback: Framing): Framing {
  const clamp = (v: unknown, base: number, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : base
  return { zoom: clamp(value?.zoom, fallback.zoom, .65, 2.2), x: clamp(value?.x, fallback.x, -25, 25), y: clamp(value?.y, fallback.y, -25, 25) }
}
