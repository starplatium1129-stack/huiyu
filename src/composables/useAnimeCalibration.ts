import { computed, ref } from 'vue'
import { normalizeCalibration, sameCalibration, type AnimeCalibration, type CalibrationKey } from '@/anime25d/calibration'
import { writeAnimeCalibration } from '@/anime25d/modelStore'

export function useAnimeCalibration(apply: (value: AnimeCalibration) => void) {
  const value = ref(normalizeCalibration()), saved = ref(normalizeCalibration())
  const saving = ref(false), message = ref(''), error = ref('')
  let fingerprint = '', revision = 0
  let preview: HTMLCanvasElement | null = null, previewTime = 0
  const dirty = computed(() => !sameCalibration(value.value, saved.value))
  function attach(id: string, initial: AnimeCalibration) {
    revision++; fingerprint = id; saving.value = false; message.value = ''; error.value = ''
    value.value = normalizeCalibration(initial); saved.value = normalizeCalibration(initial)
    apply(value.value)
  }
  function update(key: CalibrationKey, number: number) {
    value.value = normalizeCalibration({ ...value.value, [key]: number })
    message.value = ''; error.value = ''; apply(value.value)
  }
  function reset() {
    value.value = normalizeCalibration(); message.value = ''; error.value = ''; apply(value.value)
  }
  function revert() {
    value.value = normalizeCalibration(saved.value); message.value = ''; error.value = ''; apply(value.value)
  }
  async function save() {
    if (!fingerprint || saving.value) return
    const id = fingerprint, ticket = revision, snapshot = normalizeCalibration(value.value)
    saving.value = true; error.value = ''; message.value = ''
    try {
      await writeAnimeCalibration(id, snapshot)
      if (ticket !== revision) return
      saved.value = snapshot; message.value = '校准已保存到本机'
    } catch (reason) {
      if (ticket === revision) error.value = `校准保存失败：${reason instanceof Error ? reason.message : String(reason)}`
    } finally { if (ticket === revision) saving.value = false }
  }
  return { value, dirty, saving, message, error, attach, update, reset, revert, save,
    setPreview(canvas: HTMLCanvasElement | null) { preview = canvas; previewTime = 0 },
    drawPreview(source: HTMLCanvasElement, face: { x0: number; x1: number; y0: number; y1: number }, time: number) {
      if (!preview || time - previewTime < 1 / 30) return
      previewTime = time
      const context = preview.getContext('2d')
      if (!context) return
      const width = face.x1 - face.x0, height = face.y1 - face.y0
      const size = Math.max(width * 3.4, height * 3.2)
      context.clearRect(0, 0, preview.width, preview.height)
      context.drawImage(source, (face.x0 + face.x1 - size) / 2, face.y0 - height * .8,
        size, size, 0, 0, preview.width, preview.height)
    },
    clear() { revision++; fingerprint = ''; previewTime = 0; saving.value = false; message.value = ''; error.value = '' } }
}
