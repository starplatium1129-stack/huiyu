import { describe, expect, it, vi } from 'vitest'
import { usePolling } from './usePolling'

/** 手动计时器：把 setInterval/clearInterval 换成可步进的假时钟 */
function fakeTimers() {
  const tasks = new Map<number, () => void>()
  let nextId = 1
  return {
    setInterval: vi.fn((handler: () => void, _timeout: number) => {
      const id = nextId++
      tasks.set(id, handler)
      return id
    }),
    clearInterval: vi.fn((id: number) => { tasks.delete(id) }),
    async runDue() {
      for (const handler of [...tasks.values()]) handler()
      await Promise.resolve()
      await Promise.resolve()
    },
    pendingCount: () => tasks.size,
    queuedCallbacks: () => [...tasks.values()],
  }
}

describe('usePolling —— 轮询通用底座', () => {
  it('立即回调中 stop 不会遗留定时器', () => {
    const t = fakeTimers()
    const polling = usePolling({ intervalMs: 1000, tick: () => polling.stop(), ...t })
    polling.start()
    expect(polling.isActive()).toBe(false)
    expect(t.pendingCount()).toBe(0)
  })

  it('暂停恢复的立即回调中 stop 也清理定时器', () => {
    const t = fakeTimers()
    let paused = true
    const polling = usePolling({ intervalMs: 1000, paused: () => paused, tick: () => polling.stop(), ...t })
    polling.start()
    paused = false
    polling.sync()
    expect(polling.isActive()).toBe(false)
    expect(t.pendingCount()).toBe(0)
  })

  it('停止后已经排队的回调不得继续请求', () => {
    const t = fakeTimers()
    const tick = vi.fn()
    const polling = usePolling({ intervalMs: 1000, tick, immediate: false, ...t })
    polling.start()
    const [queued] = t.queuedCallbacks()
    polling.stop()
    queued!()
    expect(tick).not.toHaveBeenCalled()
  })

  it('暂停条件已变化但尚未 sync 时不发起请求', async () => {
    const t = fakeTimers()
    let paused = false
    const tick = vi.fn()
    const polling = usePolling({ intervalMs: 1000, tick, paused: () => paused, immediate: false, ...t })
    polling.start()
    paused = true
    await t.runDue()
    expect(tick).not.toHaveBeenCalled()
    polling.stop()
  })

  it('in-flight 去重：tick 未完成时不触发下一次', async () => {
    const t = fakeTimers()
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => { release = resolve })
    const tick = vi.fn(() => gate)
    const polling = usePolling({ intervalMs: 1000, tick, ...t })

    polling.start() // 立即 tick（挂在 gate 上）
    expect(tick).toHaveBeenCalledTimes(1)
    expect(t.pendingCount()).toBe(1)
    await t.runDue() // interval 触发第二次 tick —— 应被去重
    expect(tick).toHaveBeenCalledTimes(1)

    release!()
    await Promise.resolve()
    await t.runDue()
    expect(tick).toHaveBeenCalledTimes(2)
    polling.stop()
    expect(t.pendingCount()).toBe(0)
    expect(polling.isActive()).toBe(false)
  })

  it('tick 返回 false 自动停止', async () => {
    const t = fakeTimers()
    let calls = 0
    const tick = vi.fn(() => {
      calls += 1
      return calls >= 2 ? false : undefined
    })
    const polling = usePolling({ intervalMs: 1000, tick, ...t })

    polling.start() // call 1（undefined，继续）
    await Promise.resolve() // immediate tick 的 async 链走完
    await t.runDue() // call 2（false → stop）
    await Promise.resolve()
    expect(t.pendingCount()).toBe(0)
    expect(polling.isActive()).toBe(false)
  })

  it('paused 门控：start 时暂停则不启动；sync 恢复后续跑', () => {
    const t = fakeTimers()
    let hidden = true
    const tick = vi.fn()
    const polling = usePolling({ intervalMs: 1000, tick, paused: () => hidden, ...t })

    polling.start()
    expect(t.pendingCount()).toBe(0) // 隐藏中：不跑表，但记住启动意图

    hidden = false
    polling.sync()
    expect(polling.isActive()).toBe(true)
    expect(t.pendingCount()).toBe(1)

    hidden = true
    polling.sync()
    expect(t.pendingCount()).toBe(0) // 停表但保持 active 语义
    expect(polling.isActive()).toBe(true)

    hidden = false
    polling.sync()
    expect(t.pendingCount()).toBe(1) // 恢复续跑
  })

  it('stop 后不再重启：多次 stop/start 幂等', () => {
    const t = fakeTimers()
    const tick = vi.fn()
    const polling = usePolling({ intervalMs: 1000, tick, immediate: false, ...t })

    polling.start()
    polling.start() // 幂等：不重复排程
    expect(t.pendingCount()).toBe(1)

    polling.stop()
    polling.stop()
    expect(t.pendingCount()).toBe(0)
  })
})
