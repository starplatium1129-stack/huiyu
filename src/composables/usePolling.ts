import { getCurrentScope, onScopeDispose, ref, type Ref } from 'vue'

/**
 * usePolling —— 轮询逻辑的通用底座（2026-08-28 工程审计 P1-9）。
 *
 * 此前轮询在 6 处各自实现（useTrainingPolling/useLegacySdTasks/useAnimaSession/
 * useControlStatus/useShotBatchMachine/useCharacterRoomSession/VideoStudioView），
 * 每套自带 timer/abort/generation 守卫，语义各异。本底座收敛共同语义：
 *   - in-flight 去重：上一次 tick 未完成时不发起下一次；
 *   - generation 守卫：stop() 后仍在飞的 tick 完成回调被丢弃，不会重启计时器；
 *   - 暂停门控：paused 为 true 时暂停计时（页面隐藏），恢复 false 自动续跑；
 *   - scope 自动清理：在组件/作用域内使用时随 dispose 自动 stop。
 *
 * tick 返回 false（或 Promise<false>）表示「轮询应结束」，等效自动 stop。
 * 替换进度：useControlStatus 已接入；useLegacySdTasks（while-await 循环语义
 * 不同，不强行套）；其余生成链路轮询按专项排期逐个迁移。
 */

export interface UsePollingOptions {
  intervalMs: number
  /** 每个轮询周期执行的回调；返回 false 表示停止轮询 */
  tick: () => void | false | Promise<void | false>
  /** 暂停门控（页面隐藏、依赖未就绪等）；true 时停表，false 恢复续跑 */
  paused?: () => boolean
  /** start 时是否立即 tick 一次（默认 true） */
  immediate?: boolean
  setInterval?: (handler: () => void, timeout: number) => number
  clearInterval?: (id: number) => void
}

export interface UsePollingHandle {
  start: () => void
  stop: () => void
  isActive: () => boolean
  /** 供 paused 门控变化时手动同步（隐藏停表/恢复续跑） */
  sync: () => void
}

export function usePolling(options: UsePollingOptions): UsePollingHandle {
  // 默认走全局定时器：node 测试环境无 window，退回 globalThis（同一函数集）。
  // node 测试环境的 setInterval 返回 Timeout 而非 number，但用法只是原样传回 clearInterval，
  // 断言为 window 形状以复用 number 句柄类型。
  const g = (typeof window !== 'undefined' ? window : globalThis) as unknown as Pick<typeof window, 'setInterval' | 'clearInterval'>
  const setTimer = options.setInterval ?? ((handler, timeout) => g.setInterval(handler, timeout))
  const clearTimer = options.clearInterval ?? ((id: number) => g.clearInterval(id))
  const immediate = options.immediate !== false
  const intervalMs = options.intervalMs

  let timer: number | null = null
  let generation = 0
  let inFlight = false
  const active: Ref<boolean> = ref(false)

  async function runTick(): Promise<void> {
    if (!active.value || inFlight || options.paused?.()) return
    const currentGeneration = generation
    inFlight = true
    try {
      const verdict = await options.tick()
      if (verdict === false && currentGeneration === generation && active.value) {
        stop()
      }
    } finally {
      inFlight = false
    }
  }

  function start(): void {
    if (active.value) return
    active.value = true
    generation += 1
    // 暂停门控在 start 前生效时：保持 active 语义（调用方已请求轮询），
    // 但不排程；paused 翻回 false 后由 sync() 续跑。
    if (options.paused && options.paused()) return
    timer = setTimer(() => { void runTick() }, intervalMs)
    if (immediate && !inFlight) void runTick()
  }

  function stop(): void {
    generation += 1
    active.value = false
    if (timer !== null) clearTimer(timer)
    timer = null
  }

  /** paused 从 true 翻回 false 时恢复计时；反之停表但保持 active 语义 */
  function sync(): void {
    if (!active.value) return
    const shouldPause = Boolean(options.paused && options.paused())
    if (shouldPause && timer !== null) {
      clearTimer(timer)
      timer = null
    } else if (!shouldPause && timer === null) {
      timer = setTimer(() => { void runTick() }, intervalMs)
      if (!inFlight) void runTick()
    }
  }

  function isActive(): boolean {
    return active.value
  }

  if (getCurrentScope()) onScopeDispose(stop)

  return { start, stop, isActive, sync }
}
