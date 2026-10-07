import { useControlStatus } from './useControlStatus'
import type { ControlStatus } from '@/types/api'
import { effectScope, ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { expect, it, vi } from 'vitest'
import { useControlActions } from './useControlActions'

it('configuration saves ignore repeated clicks and allow retry after failure', async () => {
  const status = {
    statusLoaded: ref(true), lastStatus: () => ({}), pollStatus: vi.fn(), feedbackText: ref(''),
    sdHost: ref('http://localhost:7860'), comfyHost: ref('http://localhost:8188'), ttsHost: ref('http://localhost:9880'),
    ttsEngine: ref('voxcpm2'), voiceNeneLora: ref('nene.safetensors'), voiceNatsumeLora: ref('natsume.safetensors'),
    voiceNeneRef: ref(''), voiceNenePrompt: ref(''), voiceNatsumeRef: ref(''), voiceNatsumePrompt: ref(''),
  } as unknown as Parameters<typeof useControlActions>[0]
  let reject!: (error: Error) => void
  const saveConfig = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail }))
  const showToast = vi.fn()
  const control = { saveConfig } as unknown as NonNullable<Parameters<typeof useControlActions>[1]['control']>
  const actions = useControlActions(status, { control, showToast })
  status.statusLoaded.value = false
  await actions.saveConfig(new KeyboardEvent('keydown', { key: 'Enter' }))
  await actions.saveConfig()
  expect(saveConfig).not.toHaveBeenCalled()
  status.statusLoaded.value = true
  for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
    const ignored = actions.saveConfig(new KeyboardEvent('keydown', { key: 'Enter', ...composition }))
    expect(saveConfig).not.toHaveBeenCalled()
    await ignored
  }
  const first = actions.saveConfig(new KeyboardEvent('keydown', { key: 'Enter' }))
  await actions.saveConfig()
  expect(saveConfig).toHaveBeenCalledTimes(1)
  expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({ ttsEngine: 'voxcpm2', voices: expect.objectContaining({
    nene: expect.objectContaining({ loraWeightsPath: 'nene.safetensors' }), natsume: expect.objectContaining({ loraWeightsPath: 'natsume.safetensors' }),
  }) }))
  expect(actions.savingConfig.value).toBe(true)
  reject(new Error('network failed'))
  await first
  expect(actions.savingConfig.value).toBe(false)
  expect(showToast).toHaveBeenCalledWith('network failed', true)
  saveConfig.mockResolvedValue(undefined)
  await actions.saveConfig()
  expect(saveConfig).toHaveBeenCalledTimes(2)
  expect(showToast).toHaveBeenCalledWith('生成服务配置已保存')
})

it('reports saved configuration awaiting restart and does not start sharing with stale settings', async () => {
  let pending = false
  const status = {
    statusLoaded: ref(true), lastStatus: () => ({ restartRequired: pending }), pollStatus: vi.fn(), feedbackText: ref(''), opBusy: ref(false),
    sdHost: ref('http://localhost:7860'), comfyHost: ref('http://localhost:8188'), ttsHost: ref('http://localhost:9880'),
    ttsEngine: ref('gpt-sovits'), voiceNeneLora: ref(''), voiceNatsumeLora: ref(''),
    voiceNeneRef: ref(''), voiceNenePrompt: ref(''), voiceNatsumeRef: ref(''), voiceNatsumePrompt: ref(''),
  } as unknown as Parameters<typeof useControlActions>[0]
  const saveConfig = vi.fn().mockResolvedValue({ ok: true, restartRequired: true, message: '配置已保存，重新启动应用后生效' })
  const start = vi.fn()
  const showToast = vi.fn()
  const control = { saveConfig, start } as unknown as NonNullable<Parameters<typeof useControlActions>[1]['control']>
  const actions = useControlActions(status, { control, showToast })
  await actions.saveConfig()
  expect(showToast).toHaveBeenCalledWith('配置已保存，重新启动应用后生效')
  pending = true
  await actions.doStart()
  expect(saveConfig).toHaveBeenCalledTimes(1)
  expect(start).not.toHaveBeenCalled()
})

it('owns a preference write across stale polls and reconciles an uncertain response without inversion', async () => {
  let finish!: (value: { ok: true; autoStartVoice: boolean }) => void
  let fail!: (error: Error) => void
  let read!: (value: ControlStatus) => void
  const savePreference = vi.fn(() => new Promise<{ ok: true; autoStartVoice: boolean }>((resolve, reject) => { finish = resolve; fail = reject }))
  const getStatus = vi.fn(() => new Promise<ControlStatus>(resolve => { read = resolve }))
  const control = { savePreference, getStatus } as unknown as NonNullable<Parameters<typeof useControlActions>[1]['control']>
  const showToast = vi.fn()
  const status = useControlStatus({ api: control, showToast })
  const actions = useControlActions(status, { control, showToast })
  const snapshot = (enabled: boolean) => ({ ok: true, running: true, voices: {}, scripts: {}, autoStartVoice: enabled }) as ControlStatus
  status.renderStatus(snapshot(false))
  const oldPoll = status.pollStatus()
  const oldRead = read
  status.autoStartVoice.value = true
  const save = actions.saveAutoStartVoice()
  expect(status.savingAutoStartVoice.value).toBe(true)
  await actions.saveAutoStartVoice()
  expect(savePreference).toHaveBeenCalledOnce()
  status.renderStatus(snapshot(false))
  expect(status.autoStartVoice.value).toBe(true)
  finish({ ok: true, autoStartVoice: true })
  await Promise.resolve()
  oldRead(snapshot(false)); await oldPoll
  expect(status.autoStartVoice.value).toBe(true)
  read(snapshot(true)); await save
  expect(showToast).toHaveBeenCalledWith('已开启：下次自动启动语音')
  status.autoStartVoice.value = false
  const uncertain = actions.saveAutoStartVoice()
  fail(new Error('response lost'))
  await Promise.resolve()
  expect(status.autoStartVoice.value).toBe(false)
  read(snapshot(false)); await uncertain
  expect(status.autoStartVoice.value).toBe(false)
  expect(status.savingAutoStartVoice.value).toBe(false)
  expect(showToast).toHaveBeenCalledWith(expect.stringContaining('保存结果尚未确认'), true)
  status.stopPolling()
})

it('serializes service and mode submissions even when an in-flight status has no operation', async () => {
  let finish!: (value: { ok: true }) => void
  const serviceAction = vi.fn(() => new Promise<{ ok: true }>(resolve => { finish = resolve }))
  const switchMode = vi.fn().mockResolvedValue({ ok: true })
  const control = { serviceAction, switchMode, getStatus: vi.fn().mockResolvedValue({ ok: true }), getLogs: vi.fn().mockResolvedValue({ logs: [], total: 0 }) } as unknown as NonNullable<Parameters<typeof useControlActions>[1]['control']>
  const status = useControlStatus({ api: control, showToast: vi.fn() })
  const actions = useControlActions(status, { control, showToast: vi.fn() })
  const pending = actions.serviceAction('comfy', 'start')
  status.renderStatus({ ok: true, operation: null } as ControlStatus)
  expect(status.opBusy.value).toBe(true)
  await actions.serviceAction('comfy', 'start')
  await actions.switchMode('chat')
  expect(serviceAction).toHaveBeenCalledOnce()
  expect(switchMode).not.toHaveBeenCalled()
  finish({ ok: true }); await pending
  await actions.switchMode('chat')
  expect(switchMode).toHaveBeenCalledOnce()
  status.stopPolling()
})

it('locks sharing with all service commands and cannot revive polling after its owner is disposed', async () => {
  vi.useFakeTimers()
  let finish!: (value: { ok: true }) => void
  const control = { saveConfig: vi.fn().mockResolvedValue({ ok: true }),
    start: vi.fn(() => new Promise<{ ok: true }>(resolve => { finish = resolve })), stop: vi.fn(),
    serviceAction: vi.fn(), switchMode: vi.fn(), getStatus: vi.fn(), getLogs: vi.fn(),
  } as unknown as NonNullable<Parameters<typeof useControlActions>[1]['control']>
  const scope = effectScope()
  const { status, actions } = scope.run(() => {
    const status = useControlStatus({ api: control, showToast: vi.fn() })
    return { status, actions: useControlActions(status, { control, showToast: vi.fn() }) }
  })!
  try {
    status.renderStatus({ ok: true, operation: null } as ControlStatus)
    const sharing = actions.doStart(); await flushPromises()
    status.renderStatus({ ok: true, operation: null } as ControlStatus)
    expect(status.opBusy.value).toBe(true)
    await actions.doStart(); await actions.doStop(); await actions.serviceAction('comfy', 'start'); await actions.switchMode('chat')
    expect(control.start).toHaveBeenCalledOnce()
    expect(control.stop).not.toHaveBeenCalled()
    expect(control.serviceAction).not.toHaveBeenCalled()
    expect(control.switchMode).not.toHaveBeenCalled()
    scope.stop(); finish({ ok: true }); await sharing
    expect(vi.getTimerCount()).toBe(0)
    expect(control.getStatus).not.toHaveBeenCalled()
    status.startPolling()
    expect(vi.getTimerCount()).toBe(0)
  } finally { scope.stop(); vi.useRealTimers() }
})

it('holds the rebuild lock during native package detection and releases it for a later allowed retry', async () => {
  let detect!: (value: boolean) => void
  const isPackaged = vi.fn(() => new Promise<boolean>(resolve => { detect = resolve }))
  const previousHost = Object.getOwnPropertyDescriptor(window, '__TAURI__')
  Object.defineProperty(window, '__TAURI__', { configurable: true, value: { core: { invoke: isPackaged } } })
  const buildWeb = vi.fn().mockResolvedValue({ durationMs: 1000 }), showToast = vi.fn()
  const actions = useControlActions({ pollStatus: vi.fn() } as unknown as Parameters<typeof useControlActions>[0], {
    showToast, maintenance: { buildWeb } as unknown as NonNullable<Parameters<typeof useControlActions>[1]['maintenance']>,
  })
  try {
    const blocked = actions.buildWeb()
    expect(actions.buildingWeb.value).toBe(true)
    await actions.buildWeb()
    expect(isPackaged).toHaveBeenCalledExactlyOnceWith('is_packaged')
    detect(true); await blocked
    expect(buildWeb).not.toHaveBeenCalled()
    expect(actions.buildingWeb.value).toBe(false)
    const allowed = actions.buildWeb()
    await actions.buildWeb()
    detect(false); await allowed
    expect(buildWeb).toHaveBeenCalledOnce()
    expect(actions.buildingWeb.value).toBe(false)
  } finally {
    if (previousHost) Object.defineProperty(window, '__TAURI__', previousHost)
    else Reflect.deleteProperty(window, '__TAURI__')
  }
})
