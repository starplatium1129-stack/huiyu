import { afterEach, expect, it, vi } from 'vitest'
vi.mock('./useInterfaceFeedback', () => ({ playInterfaceTone: vi.fn() }))
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it('caps ordinary notices to four but never drops the ones carrying an undo action', async () => {
  vi.useFakeTimers()
  const { useToast } = await import('./useToast')
  const toast = useToast()
  for (let index = 0; index < 6; index += 1) toast.show(`notice-${index}`)
  expect(toast.toasts.value.map(item => item.msg)).toEqual(['notice-2', 'notice-3', 'notice-4', 'notice-5'])
  for (let index = 0; index < 4; index += 1) {
    toast.show(`undo-${index}`, 'info', 1000, { label: '撤销', onClick: () => {} })
  }
  expect(toast.toasts.value.map(item => item.msg)).toEqual(['undo-0', 'undo-1', 'undo-2', 'undo-3'])
  vi.advanceTimersByTime(5000)
  expect(toast.toasts.value).toHaveLength(0)
})

it('keeps new and existing notices while either keyboard focus or hover is active', async () => {
  vi.useFakeTimers()
  const { useToast } = await import('./useToast')
  const toast = useToast()
  toast.show('可撤销的操作', 'info', 1000)
  vi.advanceTimersByTime(300)
  toast.pauseAll('focus')
  toast.pauseAll('hover')
  toast.show('另一条提示', 'info', 1000)
  toast.resumeAll('hover')
  vi.advanceTimersByTime(3000)
  expect(toast.toasts.value.map(t => t.msg)).toEqual(['可撤销的操作', '另一条提示'])
  toast.resumeAll('focus')
  vi.advanceTimersByTime(701)
  expect(toast.toasts.value.map(t => t.msg)).toEqual(['另一条提示'])
  vi.advanceTimersByTime(300)
  expect(toast.toasts.value).toHaveLength(0)
})
