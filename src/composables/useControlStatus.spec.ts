import { describe, expect, it, vi } from 'vitest'
import { computed, nextTick, ref } from 'vue'
import { useRoomSetup } from './chat/useRoomSetup'
import { controlApi } from '@/api/controlApi'
import { flushPromises } from '@vue/test-utils'
import { useControlStatus } from './useControlStatus'
import type { ControlStatus, ControlOperationView } from '@/types/api'

function snapshot(overrides: Partial<ControlStatus> = {}): ControlStatus {
  return {
    ok: true, running: true, sdOnline: false, comfyOnline: true, ttsOnline: false,
    ollamaOnline: false, ollamaModels: [], ollamaVram: 0, webuiManaged: false,
    comfyManaged: true, modeBusy: false, operation: null, sdHost: 'http://127.0.0.1:7860',
    comfyHost: 'http://127.0.0.1:8188', ttsHost: 'http://127.0.0.1:9880', ollamaHost: '',
    localLink: '', shareLinkAvailable: false, tunnelStatus: 'disabled', tunnelAvailable: true,
    uptime: 10, voices: {}, scripts: { voiceStart: true, voiceStop: true, webui: true, comfy: true },
    ...overrides,
  }
}
const running: ControlOperationView = { id: 'one', kind: 'chat', label: 'prepare', status: 'running', stageIndex: 0, stages: [], message: '', startedAt: 1, finishedAt: 0, error: '' }

describe('control room state', () => {
  it('lets a slow first status finish instead of aborting it on every polling interval', async () => {
    vi.useFakeTimers()
    let resolveStatus!: (value: ControlStatus) => void
    const getStatus = vi.fn(() => new Promise<ControlStatus>(resolve => { resolveStatus = resolve }))
    const status = useControlStatus({ showToast: vi.fn(), api: {
      getStatus,
      getLogs: vi.fn().mockResolvedValue({ logs: [], total: 0 }),
      getShareLink: vi.fn().mockResolvedValue({ shareLink: '' }),
    } as never })
    try {
      status.startPolling()
      await vi.advanceTimersByTimeAsync(6500)
      expect(getStatus).toHaveBeenCalledOnce()
      expect(status.statusLoaded.value).toBe(false)
      resolveStatus(snapshot())
      await vi.advanceTimersByTimeAsync(0)
      expect(status.statusLoaded.value).toBe(true)
      await vi.advanceTimersByTimeAsync(2500)
      expect(getStatus).toHaveBeenCalledTimes(2)
    } finally { status.stopPolling(); vi.useRealTimers() }
  })

  it('suspends the progress clock while hidden and cannot resurrect it after stop', async () => {
    vi.useFakeTimers()
    let hidden = false
    const visibility = vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
    const running = snapshot({ operation: { status: 'running', stages: [], stageIndex: 0 } as unknown as ControlStatus['operation'] })
    const status = useControlStatus({ showToast: vi.fn(), api: {
      getStatus: vi.fn().mockResolvedValue(running),
      getLogs: vi.fn().mockResolvedValue({ logs: [], total: 0 }),
    } as never })
    try {
      status.startPolling()
      await vi.advanceTimersByTimeAsync(0)
      expect(vi.getTimerCount()).toBe(2)
      hidden = true
      document.dispatchEvent(new Event('visibilitychange'))
      expect(vi.getTimerCount()).toBe(0)
      // A late read or local operation update must not restart the hidden clock.
      status.renderStatus(running)
      await nextTick()
      expect(vi.getTimerCount()).toBe(0)
      hidden = false
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
      expect(vi.getTimerCount()).toBe(2)
      status.renderStatus(snapshot({ operation: { ...running.operation! } }))
      status.stopPolling()
      await nextTick()
      expect(vi.getTimerCount()).toBe(0)
      status.startPolling()
      await vi.advanceTimersByTimeAsync(0)
      expect(vi.getTimerCount()).toBe(2)
    } finally { status.stopPolling(); visibility.mockRestore(); vi.useRealTimers() }
  })

  it('includes ComfyUI in readiness and the four-service count', () => {
    const status = useControlStatus({ showToast: vi.fn() })
    status.renderStatus(snapshot())
    expect(status.readyLabel.value).toBe('1 / 4 服务在线')
    expect(status.feedbackText.value).toBe('画面创作就绪')
    status.renderStatus(snapshot({ ttsOnline: true, llama: { online: true, managed: true, host: 'http://127.0.0.1:8080', label: 'llama.cpp' } }))
    expect(status.readyLabel.value).toBe('3 / 4 服务在线')
    expect(status.feedbackText.value).toBe('画面、语音与聊天均已就绪')
    status.renderStatus(snapshot({ ttsOnline: true, ollamaOnline: true }))
    expect(status.feedbackText.value).toBe('画面、语音与聊天均已就绪')
    status.renderStatus(snapshot({ ttsOnline: true }))
    expect(status.feedbackText.value).toBe('画面与语音就绪')
    status.stopPolling()
  })
  it('preserves edits to several fields across polls and accepts acknowledged saves', () => {
    const status = useControlStatus({ showToast: vi.fn() })
    status.renderStatus(snapshot())
    status.sdHost.value = 'http://127.0.0.1:7861'
    status.voiceNenePrompt.value = 'new voice prompt'
    status.ttsEngine.value = 'voxcpm2'
    status.voiceNeneLora.value = 'new-nene.safetensors'
    status.renderStatus(snapshot({ voices: { nene: { promptText: 'old voice prompt' } } } as Partial<ControlStatus>))
    expect(status.sdHost.value).toBe('http://127.0.0.1:7861')
    expect(status.voiceNenePrompt.value).toBe('new voice prompt')
    expect(status.ttsEngine.value).toBe('voxcpm2')
    expect(status.voiceNeneLora.value).toBe('new-nene.safetensors')
    expect(status.activeVoiceEngine.value).toBe('GPT-SoVITS')
    status.renderStatus(snapshot({ sdHost: 'http://127.0.0.1:7861' }))
    status.renderStatus(snapshot({ sdHost: 'http://127.0.0.1:7862' }))
    expect(status.sdHost.value).toBe('http://127.0.0.1:7862')
    status.stopPolling()
  })
  it('retains uncertain operations but accepts authoritative null without late-log resurrection', async () => {
    let finish!: (value: { operation: ControlOperationView; logs: string[]; total: number }) => void
    const status = useControlStatus({ showToast: vi.fn(), api: {
      getStatus: vi.fn().mockRejectedValue(new Error('offline')),
      getLogs: vi.fn(() => new Promise(resolve => { finish = resolve })),
    } as never })
    status.renderStatus(snapshot({ operation: running }))
    await status.pollStatus(true)
    expect(status.statusError.value).toContain('无法连接')
    expect(status.comfyOnline.value).toBe(true)
    expect(status.serviceChecking.value).toBe(false)
    expect(status.opBusy.value).toBe(true)
    const degradedLogs = status.pollLogs()
    status.renderStatus(snapshot({ ok: false }))
    finish({ operation: { ...running, status: 'completed' }, logs: [], total: 0 })
    await degradedLogs
    expect(status.opBusy.value).toBe(false)
    status.renderStatus(snapshot({ operation: running }))
    const oldLogs = status.pollLogs()
    status.renderStatus(snapshot())
    expect(status.statusError.value).toBe('')
    expect(status.opBusy.value).toBe(false)
    finish({ operation: running, logs: ['retained log'], total: 1 })
    await oldLogs
    expect(status.operation.value).toBeNull()
    expect(status.logs.value).toEqual(['retained log'])
    const beforeCommand = status.pollLogs()
    status.operationSubmitting.value = true
    status.renderStatus(snapshot())
    expect(status.opBusy.value).toBe(true)
    status.operationSubmitting.value = false
    finish({ operation: running, logs: [], total: 1 })
    await beforeCommand
    expect(status.operation.value).toBeNull()
    status.stopPolling()
  })

  it.each([
    [false, true, '本地聊天模型仍未就绪'],
    [true, false, '角色语音仍未就绪'],
    [true, true, '聊天环境已就绪'],
  ] as const)('keeps room preparation locked through readiness checks (chat %s, voice %s)', async (online, voiceReady, expected) => {
    vi.useFakeTimers()
    const switchMode = vi.spyOn(controlApi, 'switchMode').mockResolvedValue({ ok: true, operation: running })
    const getStatus = vi.spyOn(controlApi, 'getStatus').mockResolvedValue(snapshot({ operation: { ...running, status: 'completed' } }))
    let finish!: () => void
    const room = useRoomSetup({
      chatProvider: ref('local'), apiConfigured: ref(false), ollamaOnline: ref(online), autoVoice: ref(false),
      currentCharacter: computed(() => ({ voice: 'fixture' })),
      voice: { refreshAvailability: vi.fn().mockResolvedValue(undefined), readyFor: () => voiceReady, prepare: vi.fn() },
      refreshChatStatus: () => new Promise<void>(resolve => { finish = resolve }), setError: vi.fn(),
      updateVoiceCapability: vi.fn(), isDisposed: () => false,
    } as unknown as Parameters<typeof useRoomSetup>[0])
    try {
      await room.prepareRoom(); await flushPromises()
      expect(room.preparingRoom.value).toBe(true)
      expect(room.roomSetupText.value).toContain('正在核对')
      await room.prepareRoom()
      expect(switchMode).toHaveBeenCalledOnce()
      finish(); await flushPromises()
      expect(room.preparingRoom.value).toBe(false)
      expect(room.roomSetupText.value).toContain(expected)
      expect(vi.getTimerCount()).toBe(0)
    } finally { room.destroy(); switchMode.mockRestore(); getStatus.mockRestore(); vi.useRealTimers() }
  })

  it.each(['failed refresh', 'disposal'] as const)('does not publish readiness after a %s', async outcome => {
    vi.useFakeTimers()
    const switchMode = vi.spyOn(controlApi, 'switchMode').mockResolvedValue({ ok: true, operation: running })
    const getStatus = vi.spyOn(controlApi, 'getStatus').mockResolvedValue(snapshot({ operation: { ...running, status: 'completed' } }))
    let reject!: (cause: Error) => void, disposed = false
    const room = useRoomSetup({
      chatProvider: ref('local'), apiConfigured: ref(false), ollamaOnline: ref(true), autoVoice: ref(false),
      currentCharacter: computed(() => ({ voice: 'fixture' })),
      voice: { refreshAvailability: vi.fn().mockResolvedValue(undefined), readyFor: () => true, prepare: vi.fn() },
      refreshChatStatus: () => new Promise<void>((_resolve, fail) => { reject = fail }), setError: vi.fn(),
      updateVoiceCapability: vi.fn(), isDisposed: () => disposed,
    } as unknown as Parameters<typeof useRoomSetup>[0])
    try {
      await room.prepareRoom(); await flushPromises()
      const before = room.roomSetupText.value
      if (outcome === 'disposal') { disposed = true; room.destroy() }
      reject(new Error('offline')); await flushPromises()
      expect(room.roomSetupText.value).not.toContain('聊天环境已就绪')
      if (outcome === 'disposal') expect(room.roomSetupText.value).toBe(before)
      else {
        expect(room.preparingRoom.value).toBe(false)
        expect(room.roomSetupText.value).toContain('服务状态尚未确认')
      }
      expect(vi.getTimerCount()).toBe(0)
    } finally { room.destroy(); switchMode.mockRestore(); getStatus.mockRestore(); vi.useRealTimers() }
  })

  it('releases room preparation when its operation disappears or is replaced, without claiming success', async () => {
    vi.useFakeTimers()
    const switchMode = vi.spyOn(controlApi, 'switchMode').mockResolvedValue({ ok: true, operation: running })
    const getStatus = vi.spyOn(controlApi, 'getStatus')
    const refreshChatStatus = vi.fn().mockResolvedValue(undefined), refreshAvailability = vi.fn().mockResolvedValue(undefined)
    const setError = vi.fn()
    const room = useRoomSetup({
      chatProvider: ref('local'), apiConfigured: ref(false), ollamaOnline: ref(false), autoVoice: ref(false),
      currentCharacter: computed(() => ({ voice: 'fixture' })),
      voice: { refreshAvailability, readyFor: () => false }, refreshChatStatus, setError,
      updateVoiceCapability: vi.fn(), isDisposed: () => false,
    } as unknown as Parameters<typeof useRoomSetup>[0])
    try {
      for (const operation of [null, { ...running, id: 'replacement' }]) {
        getStatus.mockResolvedValue(snapshot({ operation }))
        await room.prepareRoom()
        await flushPromises()
        expect(room.preparingRoom.value).toBe(false)
        expect(room.roomSetupText.value).toContain('尚未确认')
        expect(vi.getTimerCount()).toBe(0)
      }
      expect(switchMode).toHaveBeenCalledTimes(2)
      expect(refreshChatStatus).toHaveBeenCalledTimes(2)
      expect(refreshAvailability).toHaveBeenCalledTimes(2)
      expect(setError).toHaveBeenCalledWith(expect.stringContaining('尚未确认'))
      getStatus.mockResolvedValue(snapshot({ ok: false }))
      await room.prepareRoom(); await flushPromises()
      expect(room.preparingRoom.value).toBe(true)
      expect(vi.getTimerCount()).toBe(1)
    } finally { room.destroy(); switchMode.mockRestore(); getStatus.mockRestore(); vi.useRealTimers() }
  })
})
