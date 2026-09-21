import { computed, onUnmounted, reactive, ref, shallowRef } from 'vue'
import { apiClient } from '@/api/client'
import { inspectModelFiles, type ModelInspection } from '@/live2d/modelInspector'
import { connectModelPreview, createModelPreviewUrls } from '@/live2d/modelPreview'
import { buildCalibratedProfile, calibrationValue, calibratedBinding, type CalibrationBinding, type ModelParameter } from '@/live2d/modelCalibration'
import { validateAdapterProfile, type Live2DAdapterProfile } from '@/live2d/adapterProfile'
import type { Live2DModelHandle, Live2DStageSession } from '@/live2d/types'
import { getCompanionCharacter, resolveCompanionAvatar } from '@/utils/companionRegistry'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'

interface SavedModel { id: string; revision: string; fingerprint: string; profile: Live2DAdapterProfile; disabled?: boolean; canRollback?: boolean }
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const emptyBinding = (): CalibrationBinding => ({ id: '', closed: 0, open: 1 })
function profileBindings(profile?: Live2DAdapterProfile): [CalibrationBinding, CalibrationBinding, CalibrationBinding] {
  const bindings: [CalibrationBinding, CalibrationBinding, CalibrationBinding] = [emptyBinding(), emptyBinding(), emptyBinding()]
  const mouth = profile?.parameterBindings.mouth
  if (mouth) bindings[0] = { id: mouth.id, closed: mouth.closed ?? 0, open: mouth.open ?? mouth.scale }
  for (const [index, id] of (profile?.parameterBindings.blink || []).slice(0, 2).entries()) {
    const calibration = profile?.parameterBindings.blinkCalibration?.[id]
    bindings[index + 1] = { id, closed: calibration?.closed ?? 0, open: calibration?.open ?? 1 }
  }
  return bindings
}

export function useModelStudio(hostId: string) {
  const inspection = shallowRef<ModelInspection | null>(null)
  const parameters = ref<ModelParameter[]>([])
  const busy = ref(false), ready = ref(false), message = ref('选择完整的 Cubism 3 模型文件夹，或打开已导入的角色。')
  const saved = shallowRef<SavedModel | null>(null)
  const needsReload = ref(false)
  const identity = reactive({ id: '', name: '', persona: '', author: '', terms: '' })
  const mouth = reactive(emptyBinding()), leftEye = reactive(emptyBinding()), rightEye = reactive(emptyBinding())
  const level = ref(0), blinkLevel = ref(1)
  const previewChannel = ref<'none' | 'mouth' | 'blink' | 'focus'>('none')
  const focusX = ref(0), focusY = ref(0)
  const expressions = ref<string[]>([]), motions = ref<{ group: string; index: number }[]>([])
  let session: Live2DStageSession | null = null, model: Live2DModelHandle | null = null
  let generation = 0, abort: AbortController | null = null, releaseUrls: (() => void) | null = null
  let request: AbortController | null = null
  let baseline = new Map<string, number>()
  let loadTimer: ReturnType<typeof setTimeout> | undefined
  let playbackTimer: ReturnType<typeof setTimeout> | undefined
  let playbackVersion = 0
  let playback: { group: string; started: boolean } | null = null
  const fingerprint = computed(() => saved.value?.fingerprint || inspection.value?.fingerprint || '')
  const endpoint = () => `/api/live2d-import/${encodeURIComponent(saved.value?.id || identity.id)}`
  const rawProfile = () => buildCalibratedProfile(identity.id, parameters.value, mouth, [leftEye, rightEye], saved.value?.profile)

  function stopTest() {
    playbackVersion++; clearTimeout(playbackTimer); playback = null
    previewChannel.value = 'none'
    try { model?.stopAnimation?.() } catch { /* A released SDK must not prevent teardown. */ }
    for (const [id, value] of baseline) {
      try { model?.setParameterValueById(id, value, 1) } catch { /* Continue restoring remaining parameters. */ }
    }
    try { model?.focus(0, 0) } catch { /* Best effort for a released model. */ }
  }
  function stopPreview() {
    generation++; clearTimeout(loadTimer); abort?.abort(); abort = null
    stopTest()
    const previous = session; session = null; model = null; baseline.clear()
    try { previous?.destroy() } catch { /* Continue cleanup even when a renderer has already failed. */ } finally {
      releaseUrls?.(); releaseUrls = null; ready.value = false; parameters.value = []; busy.value = false
    }
  }
  function dispose() { request?.abort(); request = null; stopPreview() }
  onUnmounted(dispose)

  function applyTest() {
    if (!model) return
    try {
      if (playback) {
        const group = model.getActiveMotionGroup?.()
        if (group === playback.group) playback.started = true
        else if (playback.started && group !== undefined) stopTest()
      }
      if (previewChannel.value === 'mouth' && mouth.id) {
        calibratedBinding(mouth, parameters.value)
        model.setParameterValueById(mouth.id, calibrationValue(mouth, level.value), 1)
      }
      if (previewChannel.value === 'blink') for (const eye of [leftEye, rightEye]) {
        if (eye.id) {
          calibratedBinding(eye, parameters.value)
          model.setParameterValueById(eye.id, calibrationValue(eye, blinkLevel.value), 1)
        }
      }
    } catch (error) {
      stopTest(); message.value = errorText(error)
    }
  }
  function test(channel: 'mouth' | 'blink' | 'focus') {
    try {
      if (!ready.value) throw new Error('请先加载预览')
      stopTest()
      for (const binding of channel === 'mouth' ? [mouth] : channel === 'blink' ? [leftEye, rightEye] : []) {
        if (binding.id) calibratedBinding(binding, parameters.value)
      }
      previewChannel.value = channel
      if (channel === 'focus') {
        if (![focusX.value, focusY.value].every(Number.isFinite)) throw new Error('凝视坐标必须为有效数字')
        model?.focus(Math.max(-1, Math.min(1, focusX.value)), Math.max(-1, Math.min(1, focusY.value)))
      }
      applyTest()
    } catch (error) { message.value = errorText(error) }
  }
  function selectBinding(binding: CalibrationBinding) {
    stopTest()
    const parameter = parameters.value.find(item => item.id === binding.id)
    if (parameter) { binding.closed = parameter.min; binding.open = parameter.max }
  }
  function restoreBindings(profile?: Live2DAdapterProfile) {
    const bindings = profileBindings(profile)
    for (const [index, binding] of [mouth, leftEye, rightEye].entries()) Object.assign(binding, bindings[index])
  }
  async function selectFiles(files: readonly File[]) {
    request?.abort(); request = null
    stopPreview(); saved.value = null; needsReload.value = false; inspection.value = null; restoreBindings()
    const token = generation; busy.value = true
    try {
      const result = await inspectModelFiles(files)
      if (token !== generation) return
      inspection.value = result
      expressions.value = result.candidates.expressions.map(item => item.name)
      motions.value = result.candidates.motions
      message.value = result.valid ? '文件检查通过。加载预览后才能读取真实参数并校准。' : '文件检查未通过，请补齐或修正下列文件。'
    } catch (error) { if (token === generation) message.value = errorText(error) }
    finally { if (token === generation) busy.value = false }
  }
  async function openExisting(id: string) {
    request?.abort(); request = null
    stopPreview(); inspection.value = null; saved.value = null; restoreBindings(); needsReload.value = false
    const token = generation; busy.value = true
    try {
      const value = await apiClient.request<SavedModel>(`/api/live2d-import/${encodeURIComponent(id)}`, { cache: 'no-store' })
      if (token !== generation) return
      const character = getCompanionCharacter(id)
      if (value.id !== id || !validateAdapterProfile(value.profile).valid || !value.fingerprint) throw new Error('已保存的模型配置无效')
      saved.value = value; identity.id = id; identity.name = character?.name || id
      identity.persona = character?.personaPrompt || ''; restoreBindings(value.profile)
      const avatar = resolveCompanionAvatar(id)?.avatar
      expressions.value = avatar?.expressions?.map(item => item.id) || []
      motions.value = Object.values(value.profile.interactions || {}).map(item => ({ group: item.group, index: 0 }))
      message.value = value.disabled ? '该模型已停用，文件和角色记忆仍保留。重新载入页面后角色列表会更新。' : '已读取当前配置。加载预览后可重新校准；保存时会检查版本冲突。'
    } catch (error) { if (token === generation) message.value = errorText(error) }
    finally { if (token === generation) busy.value = false }
  }
  async function preview() {
    if (saved.value?.disabled) { message.value = '该模型已停用，请重新载入页面更新角色列表'; return }
    stopPreview(); const token = generation; busy.value = true
    try {
      const controller = new AbortController(); abort = controller
      loadTimer = setTimeout(() => { if (token === generation) { stopPreview(); message.value = '模型加载超时，可修正文件后重试' } }, 30000)
      let modelUrl = saved.value ? resolveCompanionAvatar(identity.id)?.avatar.modelPath : undefined
      if (!saved.value && inspection.value) {
        const urls = await createModelPreviewUrls(inspection.value, controller.signal)
        if (token !== generation) { urls.release(); return }
        modelUrl = urls.modelUrl; releaseUrls = urls.release
      }
      if (!modelUrl) throw new Error('尚未选择可预览的模型')
      const connected = await connectModelPreview(`#${hostId}`, modelUrl, controller.signal, value => {
        if (token !== generation) return
        clearTimeout(loadTimer); model = value
        const enumeration = value.enumerateParameters?.()
        parameters.value = enumeration?.supported ? enumeration.parameters.map(item => ({ id: item.id, min: item.minimum, max: item.maximum, default: item.defaultValue, value: item.value })) : []
        baseline = new Map(parameters.value.map(item => [item.id, item.value ?? item.default]))
        value.onBeforeModelUpdate(() => { if (token === generation && model === value) applyTest() }); ready.value = true
        message.value = parameters.value.length ? `预览已加载，读取到 ${parameters.value.length} 个真实参数。候选需要逐项确认。` : '预览已加载，但运行库未提供参数枚举；不能保存猜测的参数绑定。'
      }, error => { if (token === generation) { stopPreview(); message.value = errorText(error) } })
      if (token !== generation) connected.destroy()
      else session = connected
    } catch (error) { if (token === generation) { stopPreview(); message.value = errorText(error) } }
    finally { if (token === generation) busy.value = false }
  }
  async function play(kind: 'expression' | 'motion', name: string, index = 0) {
    stopTest(); const current = model, token = generation, playbackToken = playbackVersion
    try {
      if (!current || !ready.value) throw new Error('请先加载预览')
      if (kind === 'expression' ? !expressions.value.includes(name) : !motions.value.some(item => item.group === name && item.index === index)) throw new Error('该项不在模型候选清单中')
      if (kind === 'motion') playback = { group: name, started: false }
      playbackTimer = setTimeout(() => {
        if (token === generation && playbackToken === playbackVersion) stopTest()
      }, kind === 'expression' ? 5000 : 30000)
      const result = kind === 'expression' ? await current?.expression(name) : await current?.motion(name, index, 3)
      if (token !== generation || current !== model || playbackToken !== playbackVersion) return
      if (!result) stopTest()
      message.value = result ? '正在预览，请观察实际效果；结束后恢复。' : '运行库未能播放该项'
    } catch (error) { if (token === generation && playbackToken === playbackVersion) { stopTest(); message.value = errorText(error) } }
  }
  function draftKey() { if (!fingerprint.value) throw new Error('请先选择模型'); return `aics-model-draft-${fingerprint.value}` }
  function saveDraft() {
    try {
      localStorage.setItem(draftKey(), JSON.stringify({ identity, mouth, leftEye, rightEye }))
      message.value = '草稿已保存在本机，尚未覆盖角色配置'
    } catch (error) { message.value = `草稿保存失败：${errorText(error)}` }
  }
  function restoreDraft() {
    try {
      const text = localStorage.getItem(draftKey()); if (!text) throw new Error('该模型没有草稿')
      if (!ready.value || !parameters.value.length) throw new Error('请先加载预览，才能按实际参数校验草稿')
      if (text.length > 65536) throw new Error('草稿过大')
      const value = JSON.parse(text)
      const readBinding = (binding: unknown): CalibrationBinding => {
        if (!binding || typeof binding !== 'object') throw new Error('草稿绑定无效')
        const b = binding as CalibrationBinding
        if (typeof b.id !== 'string' || ![b.closed, b.open].every(Number.isFinite)) throw new Error('草稿绑定无效')
        return { id: b.id, closed: b.closed, open: b.open }
      }
      const bindings = [readBinding(value.mouth), readBinding(value.leftEye), readBinding(value.rightEye)] as const
      const candidateIdentity = { ...identity }
      if (!saved.value) for (const key of Object.keys(candidateIdentity) as (keyof typeof identity)[]) {
        if (typeof value.identity?.[key] !== 'string' || value.identity[key].length > 8000) throw new Error('草稿角色资料无效')
        candidateIdentity[key] = value.identity[key]
      }
      buildCalibratedProfile(candidateIdentity.id, parameters.value, bindings[0], bindings.slice(1), saved.value?.profile)
      stopTest(); Object.assign(identity, candidateIdentity)
      for (const [index, binding] of [mouth, leftEye, rightEye].entries()) Object.assign(binding, bindings[index])
      message.value = '已恢复草稿，保存前仍需校验真实参数范围'
    } catch (error) { message.value = errorText(error) }
  }
  function undo() { stopTest(); restoreBindings(saved.value?.profile); message.value = '已撤销未保存的校准，模型文件未修改' }
  async function save() {
    if (!isLocalStudioHost() || busy.value || saved.value?.disabled) return
    const token = generation, controller = new AbortController(), previous = saved.value
    busy.value = true; request = controller
    try {
      if (!ready.value || !parameters.value.length) throw new Error('请先加载模型并读取真实参数')
      if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(identity.id) || ['nene', 'natsume'].includes(identity.id)) throw new Error('请输入独立的角色 ID（小写字母、数字、短横线或下划线）')
      const profile = rawProfile()
      if (previous) {
        if (identity.id !== previous.id) throw new Error('已导入角色的 ID 不能在校准中更改')
        const result = await apiClient.request<SavedModel>(endpoint(), { method: 'PUT', signal: controller.signal, body: { profile, revision: previous.revision, fingerprint: previous.fingerprint } })
        if (token !== generation || controller.signal.aborted) return
        saved.value = { ...previous, ...result, profile }
      } else {
        if (!identity.name.trim() || !identity.persona.trim() || !identity.author.trim() || !identity.terms.trim()) throw new Error('请填写角色名称、独立设定、来源与许可说明')
        if (!inspection.value?.valid) throw new Error('文件检查未通过')
        const form = new FormData()
        for (const item of inspection.value.entries) form.append('files', item.file, item.file.name)
        form.append('paths', JSON.stringify(inspection.value.entries.map(item => item.path)))
        form.append('metadata', JSON.stringify({ ...identity, entryPath: inspection.value.entryPath, profile }))
        const response = await fetch('/api/live2d-import', { method: 'POST', body: form, signal: controller.signal })
        const result = await response.json()
        if (token !== generation || controller.signal.aborted) return
        if (!response.ok) throw new Error(result.error || '导入失败')
        saved.value = { ...result, profile, fingerprint: result.fingerprint || fingerprint.value }
      }
      needsReload.value = true; message.value = '已保存。结束当前对话后重新载入页面，即可在角色列表使用。'
    } catch (error) { if (token === generation) message.value = `${errorText(error)}。若连接中断，请先重新读取配置确认结果，勿直接重复导入。` }
    finally { if (token === generation) busy.value = false; if (request === controller) request = null }
  }
  async function rollback() {
    if (!saved.value || busy.value || saved.value.disabled || !isLocalStudioHost()) return
    const token = generation, controller = new AbortController(), previous = saved.value
    busy.value = true; request = controller
    try {
      const value = await apiClient.request<SavedModel>(`${endpoint()}/rollback`, { method: 'POST', signal: controller.signal, body: { revision: previous.revision, fingerprint: previous.fingerprint } })
      if (token !== generation || controller.signal.aborted) return
      if (!validateAdapterProfile(value.profile).valid) throw new Error('返回的历史配置无效')
      stopTest(); saved.value = { ...previous, ...value }; restoreBindings(saved.value.profile); needsReload.value = true
      message.value = '已恢复上一份配置；重新载入页面后生效'
    } catch (error) { if (token === generation) message.value = errorText(error) }
    finally { if (token === generation) busy.value = false; if (request === controller) request = null }
  }
  function exportProfile() {
    try {
      const url = URL.createObjectURL(new Blob([JSON.stringify({ fingerprint: fingerprint.value, profile: rawProfile() }, null, 2)], { type: 'application/json' }))
      const link = document.createElement('a'); link.href = url; link.download = `${identity.id || 'model'}-profile.json`; link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (error) { message.value = errorText(error) }
  }
  async function deactivate() {
    if (!saved.value || saved.value.disabled || busy.value || !isLocalStudioHost()) return
    const token = generation, controller = new AbortController(), previous = saved.value
    busy.value = true; request = controller
    try {
      const value = await apiClient.request<SavedModel>(endpoint(), { method: 'DELETE', signal: controller.signal, body: { revision: previous.revision, fingerprint: previous.fingerprint } })
      if (token !== generation || controller.signal.aborted) return
      if (value.disabled !== true || value.id !== previous.id) throw new Error('服务器未确认模型停用，请重新读取配置')
      stopPreview(); saved.value = { ...previous, ...value }; needsReload.value = true
      message.value = '模型已停用。文件、聊天和角色记忆均保留；完成当前对话后重新载入页面，角色列表更新生效。'
    } catch (error) {
      if (token === generation) message.value = `${errorText(error)}。若连接中断，请重新读取配置确认停用结果。`
    } finally { if (token === generation) busy.value = false; if (request === controller) request = null }
  }
  async function importProfile(file: File) {
    const token = generation, expectedFingerprint = fingerprint.value
    try {
      if (!ready.value || !parameters.value.length || !expectedFingerprint) throw new Error('请先加载预览，才能校验配置的真实参数')
      if (file.size > 65536) throw new Error('配置文件过大')
      const data = JSON.parse(await file.text())
      if (token !== generation || expectedFingerprint !== fingerprint.value) return
      if (data.fingerprint !== expectedFingerprint || !validateAdapterProfile(data.profile).valid) throw new Error('配置与模型指纹不匹配，或配置无效')
      const p = data.profile as Live2DAdapterProfile
      const expected = saved.value?.profile
      if (expected && (p.avatarId !== expected.avatarId || p.profileId !== expected.profileId)) throw new Error('配置属于另一外观')
      const [candidateMouth, ...candidateEyes] = profileBindings(p)
      buildCalibratedProfile(identity.id, parameters.value, candidateMouth, candidateEyes, expected)
      stopTest(); restoreBindings(p); message.value = '已载入口型与眨眼校准，保存后生效'
    } catch (error) { if (token === generation) message.value = errorText(error) }
  }
  return { inspection, parameters, busy, ready, message, identity, saved, needsReload, mouth, leftEye, rightEye,
    level, blinkLevel, focusX, focusY, expressions, motions, fingerprint, selectFiles, openExisting, preview, test,
    selectBinding, stopTest, stopPreview, dispose, play, saveDraft, restoreDraft, undo, save, rollback, deactivate, exportProfile, importProfile }
}
