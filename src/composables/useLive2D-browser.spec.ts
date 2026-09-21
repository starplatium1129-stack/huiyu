import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserLive2DBackend } from '@/live2d/browserBackend'
import type { Live2DModelHandle } from '@/live2d/types'

async function setup() {
  const model = {
    autoUpdate: true, update: vi.fn(),
    visible: true, width: 420, height: 610, x: 0, y: 0,
    scale: { x: 1, y: 1, set: vi.fn() },
    internalModel: { on: vi.fn(), motionManager: { state: { currentGroup: 'TapSkirt' as string | undefined } } },
  }
  let loaded!: (value: typeof model) => void
  let failed!: (error: Error) => void
  const ticker = { started: true, start: vi.fn(), stop: vi.fn(), add: vi.fn(), remove: vi.fn(), deltaMS: 16 }
  const app = {
    app: { ticker, render: vi.fn() },
    onModelLoaded: (callback: typeof loaded) => { loaded = callback },
    onModelError: (callback: typeof failed) => { failed = callback },
    destroy: vi.fn(),
  }
  const factory = vi.fn(() => app)
  Object.defineProperty(window, 'wl-live2d', { configurable: true, value: { wlLive2d: factory } })
  const session = await createBrowserLive2DBackend().connect({
    selector: '#host', modelUrl: '/model.json', canvasWidth: 420, canvasHeight: 610, character: 'nene',
  })
  return { model, app, ticker, session, factory, loaded: () => loaded(model), failed: () => failed(new Error('late')) }
}

afterEach(() => { Reflect.deleteProperty(window, 'wl-live2d') })

describe('browser Live2D session', () => {
  it.each(['stopAnimation', 'defaultExpression'] as const)('cancels an asynchronously reserved expression via %s without applying it later', async stop => {
    const h = await setup()
    const baseline = { name: 'default' }, delayed = { name: 'late' }
    const expressions = { currentExpression: baseline, defaultExpression: baseline, reserveExpressionIndex: -1, resetExpression: vi.fn() }
    const stopMotions = vi.fn()
    Object.assign(h.model.internalModel.motionManager, { expressionManager: expressions, stopAllMotions: stopMotions })
    let finish!: () => void
    // Mirrors the installed SDK's reservation check after loadExpression resolves.
    Object.assign(h.model, { expression: async () => {
      expressions.reserveExpressionIndex = 3
      await new Promise<void>(resolve => { finish = resolve })
      if (expressions.reserveExpressionIndex !== 3) return false
      expressions.currentExpression = delayed
      return true
    } })
    let handle!: Live2DModelHandle
    h.session.onModelLoaded(value => { handle = value }); h.loaded()
    const pending = handle.expression('late')
    expect(expressions.reserveExpressionIndex).toBe(3)
    if (stop === 'stopAnimation') handle.stopAnimation?.()
    else handle.expression('')
    finish()
    await expect(pending).resolves.toBe(false)
    expect(expressions.currentExpression).toBe(baseline)
    expect(expressions.resetExpression).toHaveBeenCalledOnce()
    if (stop === 'stopAnimation') expect(stopMotions).toHaveBeenCalledOnce()
    h.session.destroy()
  })
  it('supports Cubism 2 parameter access and makes expression reset persistent across motions', async () => {
    const h = await setup()
    const core = { setParamFloat: vi.fn(), getParamFloat: vi.fn(() => 0.7) }
    const expressions = { currentExpression: {}, defaultExpression: {}, resetExpression: vi.fn() }
    Object.assign(h.model.internalModel, { coreModel: core })
    Object.assign(h.model.internalModel.motionManager, { expressionManager: expressions })
    let handle!: Live2DModelHandle
    h.session.onModelLoaded(value => { handle = value }); h.loaded()
    handle.setParameterValueById('PARAM_MOUTH_OPEN_Y', 0.7, 1)
    expect(core.setParamFloat).toHaveBeenCalledWith('PARAM_MOUTH_OPEN_Y', 0.7, 1)
    expect(handle.getParameterValueById?.('PARAM_MOUTH_OPEN_Y')).toBe(0.7)
    expect(handle.expression('')).toBe(true)
    expect(expressions.currentExpression).toBe(expressions.defaultExpression)
    expect(expressions.resetExpression).toHaveBeenCalledOnce()
    h.session.destroy()
  })
  it('renders a first static frame for reduced motion, and caps the resume delta', async () => {
    const h = await setup()
    h.session.onModelLoaded(() => {})
    h.loaded()
    h.session.setPaused(true, true)
    h.session.setPaused(true, true)
    expect(h.model.update).toHaveBeenCalledExactlyOnceWith(0)
    expect(h.app.app.render).toHaveBeenCalledOnce()
    h.ticker.deltaMS = 5000
    h.session.setPaused(false)
    const tick = h.ticker.add.mock.calls[0]![0] as () => void
    tick()
    expect(h.model.update).toHaveBeenLastCalledWith(100)
    h.session.destroy()
  })

  it('pausing before disposal does not start a first frame or a late idle motion', async () => {
    const h = await setup()
    h.session.onModelLoaded(() => {})
    h.loaded()
    h.session.setPaused(true)
    h.session.destroy()
    expect(h.model.update).not.toHaveBeenCalled()
    expect(h.app.app.render).not.toHaveBeenCalled()
  })

  it('pausing one session leaves another model clock running', async () => {
    const a = await setup(), b = await setup()
    for (const h of [a, b]) { h.session.onModelLoaded(() => {}); h.loaded() }
    a.session.setPaused(true)
    a.model.update.mockClear()
    for (const h of [a, b]) (h.ticker.add.mock.calls[0]![0] as () => void)()
    expect(a.model.update).not.toHaveBeenCalled()
    expect(b.model.update).toHaveBeenCalledOnce()
    expect(b.ticker.stop).not.toHaveBeenCalled()
    a.session.destroy(); b.session.destroy()
  })

  it('model and render clocks pause together without changing another app shared ticker', async () => {
    const h = await setup()
    h.session.onModelLoaded(() => {})
    h.loaded()
    expect(h.model.autoUpdate).toBe(false)
    const tick = h.ticker.add.mock.calls[0]![0] as () => void
    tick()
    expect(h.model.update).toHaveBeenLastCalledWith(16)
    h.session.setPaused(true)
    h.model.update.mockClear()
    tick()
    expect(h.model.update).not.toHaveBeenCalled()
    h.session.setPaused(false)
    tick()
    expect(h.model.update).toHaveBeenCalledOnce()
    h.session.destroy()
    expect(h.ticker.remove).toHaveBeenCalledWith(tick)
    tick()
    expect(h.model.update).toHaveBeenCalledOnce()
  })

  it('reports motion ownership from the runtime, including idle and completion', async () => {
    const h = await setup()
    let handle!: Live2DModelHandle
    h.session.onModelLoaded(value => { handle = value })
    h.loaded()
    expect(handle.getActiveMotionGroup?.()).toBe('TapSkirt')
    h.model.internalModel.motionManager.state.currentGroup = 'Idle'
    expect(handle.getActiveMotionGroup?.()).toBe('Idle')
    h.model.internalModel.motionManager.state.currentGroup = undefined
    expect(handle.getActiveMotionGroup?.()).toBeNull()
    h.session.destroy()
  })

  it('visibility reads and writes the actual rendered model', async () => {
    const h = await setup()
    let handle!: Live2DModelHandle
    h.session.onModelLoaded(value => { handle = value })
    h.loaded()
    handle.visible = false
    expect(h.model.visible).toBe(false)
    h.model.visible = true
    expect(handle.visible).toBe(true)
    h.session.destroy()
    expect(h.model.visible).toBe(false)
  })

  it('destroy stops rendering once and blocks late callbacks and resume', async () => {
    const h = await setup()
    const loaded = vi.fn()
    const failed = vi.fn()
    h.session.onModelLoaded(loaded)
    h.session.onModelError(failed)
    h.session.destroy()
    h.session.destroy()
    h.ticker.started = false
    h.session.setPaused(false)
    h.loaded()
    h.failed()
    expect(h.ticker.stop).toHaveBeenCalledOnce()
    expect(h.app.destroy).toHaveBeenCalledOnce()
    expect(h.ticker.start).not.toHaveBeenCalled()
    expect(loaded).not.toHaveBeenCalled()
    expect(failed).not.toHaveBeenCalled()
    expect(h.model.visible).toBe(false)
  })
})
