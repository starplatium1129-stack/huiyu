import { describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { useControlStatus } from './useControlStatus'
import type { ControlStatus } from '@/types/api'

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
    status.stopPolling()
  })
  it('preserves edits to several fields across polls and accepts acknowledged saves', () => {
    const status = useControlStatus({ showToast: vi.fn() })
    status.renderStatus(snapshot())
    status.sdHost.value = 'http://127.0.0.1:7861'
    status.voiceNenePrompt.value = 'new voice prompt'
    status.renderStatus(snapshot({ voices: { nene: { promptText: 'old voice prompt' } } } as Partial<ControlStatus>))
    expect(status.sdHost.value).toBe('http://127.0.0.1:7861')
    expect(status.voiceNenePrompt.value).toBe('new voice prompt')
    status.renderStatus(snapshot({ sdHost: 'http://127.0.0.1:7861' }))
    status.renderStatus(snapshot({ sdHost: 'http://127.0.0.1:7862' }))
    expect(status.sdHost.value).toBe('http://127.0.0.1:7862')
    status.stopPolling()
  })
  it('shows a failed connection while retaining the last known service state', async () => {
    const status = useControlStatus({ showToast: vi.fn(), api: { getStatus: vi.fn().mockRejectedValue(new Error('offline')) } as never })
    status.renderStatus(snapshot())
    await status.pollStatus(true)
    expect(status.statusError.value).toContain('无法连接')
    expect(status.comfyOnline.value).toBe(true)
    expect(status.serviceChecking.value).toBe(false)
    status.renderStatus(snapshot())
    expect(status.statusError.value).toBe('')
    status.stopPolling()
  })
})
