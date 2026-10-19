import { computed, onDeactivated, onScopeDispose, reactive, ref, shallowRef, watch, type Ref } from 'vue'
import type { AnimaGenerationState } from '@/types/anima'
import type { AnimaSubmission } from './animaSessionContract'
import type { useAnimaSession } from './useAnimaSession'
import { apiClient } from '@/api/client'
import { runtimeResourceIdentity } from '@/platform/runtimeUrl'
import { onDesktopRuntime } from '@/platform/desktop/runtime'
import { assertWorkspaceMediaAuthority, workspaceMediaSource } from '@/platform/desktop/workspaceMediaSource'
import { maintenanceFrozen, registerMaintenanceParticipant } from '@/platform/maintenanceParticipants'
import { ANIMA_REGION_PROMPT_LIMIT, ANIMA_SKETCH_MAX_BYTES, MAX_ANIMA_REGIONS,
  type AnimaCompositionCapabilities, type AnimaCompositionRequest,
  type AnimaPromptRegion, type AnimaRegionPreset } from '@/types/animaComposition'

type Sketch = { blob: Blob; name: string; url: string; width: number; height: number }
export interface AnimaCompositionBindings {
  state: Ref<AnimaGenerationState>
  busy: Readonly<Ref<boolean>>
  preparing: Ref<boolean>
  cancelPreparation: Ref<(() => void) | null>
  contextKey: Readonly<Ref<string>>
  capture: () => AnimaSubmission | null
  generate: ReturnType<typeof useAnimaSession>['generate']
  flash: (message: string) => void
}
const message = (error: unknown) => error instanceof Error ? error.message : '构图准备失败，请重试。'
const presets: Record<AnimaRegionPreset, Pick<AnimaPromptRegion, 'x' | 'y' | 'width' | 'height'>> = {
  left: { x: 0, y: 0, width: .5, height: 1 }, right: { x: .5, y: 0, width: .5, height: 1 },
  top: { x: 0, y: 0, width: 1, height: .5 }, bottom: { x: 0, y: .5, width: 1, height: .5 },
  center: { x: .25, y: .25, width: .5, height: .5 },
}

/** The workspace owns this draft; closing its editor only cancels preparation. */
export function useAnimaComposition(bindings: AnimaCompositionBindings) {
  const sketch = shallowRef<Sketch | null>(null)
  const sketchSettings = reactive({ strength: 1, start: 0, end: 1 })
  const regions = ref<AnimaPromptRegion[]>([])
  const selectedId = ref(''), editorOpen = ref(false), reading = ref(false), error = ref('')
  let disposed = false, imageRevision = 0, controller: AbortController | null = null
  let preparedRuntime = ''
  const capabilities = computed(() => {
    const state = bindings.state.value
    return state.models.find(model => model.id === state.modelId)?.capabilities as AnimaCompositionCapabilities | undefined
  })
  const baseIssue = computed(() => bindings.state.value.family !== 'anima' || bindings.state.value.provider === 'comfy'
    ? '构图控制仅支持原生 Anima，请先选择原生绘图服务。'
    : bindings.state.value.provider !== 'native' ? '请先连接原生 Anima 服务，再使用构图控制。' : '')
  const sketchIssue = computed(() => baseIssue.value || (capabilities.value?.sketchControl !== true
    || capabilities.value?.sketchControlStatus?.available !== true
    ? capabilities.value?.sketchControlStatus?.reason || '草图控制尚未就绪，请先检查本地模型与推理设置。' : ''))
  const regionIssue = computed(() => baseIssue.value || (capabilities.value?.regionalPrompting !== true
    ? '当前模型尚未提供区域提示词，请先检查原生 Anima 服务。' : ''))
  const selectedRegion = computed(() => regions.value.find(region => region.id === selectedId.value) ?? null)
  const locked = computed(() => bindings.busy.value || bindings.preparing.value || reading.value)
  const aspectRatio = computed(() => `${bindings.state.value.width} / ${bindings.state.value.height}`)
  const stretched = computed(() => !!sketch.value && Math.abs(sketch.value.width / sketch.value.height
    - bindings.state.value.width / bindings.state.value.height) > .01)
  const draftIssue = computed(() => {
    if (baseIssue.value) return baseIssue.value
    if (!sketch.value && !regions.value.length) return '请导入草图，或添加至少一个区域。'
    if (sketch.value && sketchIssue.value) return sketchIssue.value
    if (regions.value.length && regionIssue.value) return regionIssue.value
    if (bindings.state.value.hiresFix) return '构图控制暂不支持高清修复，请先关闭高清。'
    if (sketch.value && (!Number.isFinite(sketchSettings.strength) || sketchSettings.strength < 0 || sketchSettings.strength > 2
      || !Number.isFinite(sketchSettings.start) || !Number.isFinite(sketchSettings.end)
      || sketchSettings.start < 0 || sketchSettings.end > 1 || sketchSettings.start >= sketchSettings.end)) return '请确认草图强度为 0–2，起止比例满足 0 ≤ 开始 < 结束 ≤ 1。'
    for (const [index, region] of regions.value.entries()) {
      if (!region.prompt.trim() || region.prompt.length > ANIMA_REGION_PROMPT_LIMIT) return `请填写区域 ${index + 1} 的正向提示词（最多 ${ANIMA_REGION_PROMPT_LIMIT} 字符）。`
      if (![region.x, region.y, region.width, region.height].every(Number.isFinite) || region.x < 0 || region.y < 0
        || region.width <= 0 || region.height <= 0 || region.x + region.width > 1 + 1e-6
        || region.y + region.height > 1 + 1e-6) return `区域 ${index + 1} 超出画幅，请调整位置和大小。`
    }
    return ''
  })
  const canGenerate = computed(() => !locked.value && !draftIssue.value)
  function cancelPreparation() {
    if (!controller) return
    controller.abort(); controller = null; bindings.preparing.value = false
  }
  bindings.cancelPreparation.value = cancelPreparation
  function closeEditor() { editorOpen.value = false; cancelPreparation(); imageRevision++; reading.value = false }
  function openEditor() { if (!disposed) editorOpen.value = true }
  function removeSketch() {
    if (locked.value) return
    imageRevision++
    if (sketch.value) URL.revokeObjectURL(sketch.value.url)
    sketch.value = null; error.value = ''
  }
  async function selectSketch(blob: Blob, name = '草图.png') {
    if (disposed || !editorOpen.value || locked.value || maintenanceFrozen()) return
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(blob.type) || !blob.size || blob.size > ANIMA_SKETCH_MAX_BYTES) {
      error.value = '请选择不超过 16 MiB 的 PNG、JPEG 或 WebP 图片。'; return
    }
    const revision = ++imageRevision, runtime = runtimeResourceIdentity(), context = bindings.contextKey.value
    reading.value = true; error.value = ''
    try {
      const source = workspaceMediaSource(blob), image = await createImageBitmap(blob)
      const width = image.width, height = image.height; image.close()
      if (disposed || revision !== imageRevision || runtime !== runtimeResourceIdentity() || context !== bindings.contextKey.value) return
      if (source) assertWorkspaceMediaAuthority(source.authority)
      if (!width || !height) throw new Error('图片无法读取，请更换草图。')
      const previous = sketch.value
      sketch.value = { blob, name: name.slice(0, 160), url: URL.createObjectURL(blob), width, height }
      if (previous) URL.revokeObjectURL(previous.url)
    } catch (cause) { if (!disposed && revision === imageRevision) error.value = message(cause) }
    finally { if (revision === imageRevision) reading.value = false }
  }
  function addRegion() {
    if (locked.value || regionIssue.value || regions.value.length >= MAX_ANIMA_REGIONS) return
    const region = { id: `region-${crypto.randomUUID()}`, prompt: '', ...presets[regions.value.length === 1 ? 'right' : 'left'] }
    regions.value.push(region); selectedId.value = region.id; error.value = ''
  }
  function removeRegion(id: string) {
    if (locked.value) return
    const index = regions.value.findIndex(region => region.id === id)
    if (index < 0) return
    regions.value.splice(index, 1)
    if (selectedId.value === id) selectedId.value = regions.value[Math.min(index, regions.value.length - 1)]?.id || ''
    error.value = ''
  }
  function applyPreset(preset: AnimaRegionPreset) {
    if (!locked.value && selectedRegion.value) Object.assign(selectedRegion.value, presets[preset])
  }
  function updateBounds(key: 'x' | 'y' | 'width' | 'height', percent: number) {
    if (locked.value || !selectedRegion.value || !Number.isFinite(percent)) return
    selectedRegion.value[key] = Math.round(percent * 100) / 10000
  }
  async function generate() {
    if (disposed || locked.value || maintenanceFrozen()) return
    if (draftIssue.value) { error.value = draftIssue.value; return }
    const captured = bindings.capture()
    if (!captured || captured.family !== 'anima') { error.value = '当前 Anima 配方尚未就绪，请先确认模型与提示词。'; return }
    const submission = JSON.parse(JSON.stringify(captured)) as typeof captured
    if (submission.request.hiresFix) { error.value = '请先关闭高清修复，再按构图生成。'; return }
    if (submission.request.initImage || submission.request.maskImage || submission.request.maskPrompt) {
      error.value = '构图控制暂不与图生图或局部重绘同时使用，请回到普通绘制配方。'; return
    }
    const selected = sketch.value, settings = { ...sketchSettings }
    const frozenRegions = regions.value.map(region => ({ ...region, prompt: region.prompt.trim() }))
    const active = new AbortController(), runtime = runtimeResourceIdentity(), context = bindings.contextKey.value
    let handedOff = false
    controller = active; preparedRuntime = runtime; bindings.preparing.value = true; error.value = ''
    const current = () => !disposed && controller === active && !active.signal.aborted
      && runtime === runtimeResourceIdentity() && context === bindings.contextKey.value
    try {
      const controls: AnimaCompositionRequest = {}
      if (selected) {
        const source = workspaceMediaSource(selected.blob)
        const uploaded = await apiClient.request<{ ok: boolean; name: string }> (source ? '/api/workspace/anima-images' : '/api/anima/images/raw', {
          method: 'POST', signal: active.signal, timeoutMs: 30_000,
          ...(source ? { body: { source: 'workspace', alias: source.alias, sha256: source.sha256, bytes: source.bytes } }
            : { body: selected.blob, headers: { 'Content-Type': 'application/octet-stream' } }),
        })
        if (!current()) return
        if (source) assertWorkspaceMediaAuthority(source.authority)
        if (!uploaded.ok || !uploaded.name) throw new Error('草图上传未完成，请重试。')
        controls.sketchControl = { image: uploaded.name, ...settings }
      }
      if (!current()) return
      if (frozenRegions.length) controls.regions = frozenRegions
      Object.assign(submission.request, controls, { teaCache: false })
      // The existing generation session owns admission and cancellation from here.
      controller = null; bindings.preparing.value = false; editorOpen.value = false
      handedOff = true
      await bindings.generate({}, submission)
    } catch (cause) {
      if (current() || handedOff && !disposed && context === bindings.contextKey.value && runtime === runtimeResourceIdentity()) {
        error.value = message(cause); bindings.flash(`${handedOff ? '构图生成' : '构图准备'}失败：${error.value}`)
      }
    } finally {
      if (controller === active) { controller = null; bindings.preparing.value = false }
    }
  }
  const stopContext = watch(bindings.contextKey, () => { imageRevision++; reading.value = false; cancelPreparation() }, { flush: 'sync' })
  const stopRuntime = onDesktopRuntime(() => { if (controller && preparedRuntime !== runtimeResourceIdentity()) cancelPreparation() })
  const releaseMaintenance = registerMaintenanceParticipant(() => {
    if (reading.value || controller || sketch.value || regions.value.length) throw new Error('构图草稿仅保留在当前页面，请先移除草图与区域，再切换工作区。')
  })
  onDeactivated(closeEditor)
  onScopeDispose(() => {
    disposed = true; closeEditor(); stopContext(); stopRuntime(); releaseMaintenance()
    if (bindings.cancelPreparation.value === cancelPreparation) bindings.cancelPreparation.value = null
    if (sketch.value) URL.revokeObjectURL(sketch.value.url)
  })
  return { sketch, sketchSettings, regions, selectedId, selectedRegion, editorOpen, reading, error, locked,
    capabilities, baseIssue, sketchIssue, regionIssue, draftIssue, canGenerate, aspectRatio, stretched,
    state: bindings.state, preparing: bindings.preparing, openEditor, closeEditor, cancelPreparation,
    selectSketch, removeSketch, addRegion, removeRegion, applyPreset, updateBounds, generate }
}
export type AnimaCompositionSession = ReturnType<typeof useAnimaComposition>
