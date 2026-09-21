import { test, expect, type Page } from '@playwright/test'
import type { Live2DNativeBridge } from '../../src/types/live2dNative'
import type { Live2DRuntimeAdapterConfig } from '../../src/live2d/types'

type Probe = {
  events: Record<string, (value?: unknown) => void>
  frames: { visible: boolean }[]
  fps: number[]
  characters: Array<{
    character: string
    textureScale?: number
    adapter?: Live2DRuntimeAdapterConfig
  }>
  destroyed: number
  snapshot: (value: unknown) => void
}

async function fixture(page: Page, legacy = false, localCharacters = false) {
  if (!localCharacters) await page.route('**/api/live2d-companions', route => route.fulfill({ json: [] }))
  await page.addInitScript(({ legacy }) => {
    localStorage.setItem('aics_companion_live2d_v1', 'true')
    localStorage.setItem('aics_live2d_quality_v1', 'compact')
    localStorage.setItem('aics_companion_behavior_v1', JSON.stringify({ enabled: false, dnd: true }))
    const probe: Probe = { events: {}, frames: [], fps: [], characters: [], destroyed: 0, snapshot: () => {} }
    Object.assign(window, { __live2dProbe: probe })
    const methods: Record<string, unknown> = {
      isDesktop: true,
      getState: () => new Promise(resolve => { probe.snapshot = resolve }),
      getSettings: async () => ({ openAtLogin: false }),
      getWorkspace: async () => ({ root: '', exists: false }),
      getWindowState: async () => ({ maximized: false, focused: true }),
      chatRelay: async () => {}, isPackaged: async () => true,
    }
    window.companionDesktop = new Proxy(methods, { get(target, key: string) {
      if (key in target) return target[key]
      if (key.startsWith('on')) return (callback: (value?: unknown) => void) => { probe.events[key] = callback; return 1 }
      return () => undefined
    } }) as unknown as NonNullable<Window['companionDesktop']>
    window.aicsLive2dNative = {
      isNativeLive2D: true, supportsTextureQuality: !legacy,
      setCharacter: async (_path, options) => { probe.characters.push(options!); return { ok: true } },
      setFrame: async frame => { probe.frames.push(frame) }, setMaxFps: async fps => { probe.fps.push(fps) },
      playMotion: async () => ({ ok: true }), setExpression: async () => ({ ok: true }),
      setMouthLevel: async () => {}, setEmotion: async () => {}, setGaze: async () => {},
      hitTest: async () => ({ areas: [] }), destroy: async () => { probe.destroyed += 1 },
      onReady: () => 1, onHitTest: () => 2, onMotionStarted: () => 3,
      onMotionFailed: () => 4, onEntranceFinished: () => 5, onStopped: () => 6, off: () => {},
    } satisfies Live2DNativeBridge
  }, { legacy })
  await page.setViewportSize({ width: 480, height: 720 })
  await page.goto('/companion')
  await page.waitForFunction(() => (window as unknown as { __live2dProbe: Probe }).__live2dProbe.events.onPowerModeChanged)
}

test('native companion keeps live visibility, power and bounds ahead of a stale startup snapshot', async ({ page }) => {
  await fixture(page)
  await page.evaluate(() => {
    const p = (window as unknown as { __live2dProbe: Probe }).__live2dProbe
    p.events.onPowerModeChanged(true)
    p.events.onWindowBoundsChanged({ x: 300, y: 100, width: 480, height: 720 })
    p.events.onShown()
  })
  await expect(page.locator('.live2d-host')).toHaveAttribute('data-state', 'ready')
  const probe = () => page.evaluate(() => {
    const p = (window as unknown as { __live2dProbe: Probe }).__live2dProbe
    return { frame: p.frames.at(-1), fps: p.fps.at(-1), character: p.characters.at(-1) }
  })
  await expect.poll(async () => (await probe()).frame?.visible).toBe(true)
  expect((await probe()).fps).toBe(30)
  expect((await probe()).character?.textureScale).toBe(4)
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('resize'))
  })
  expect((await probe()).frame?.visible).toBe(true)
  await page.evaluate(() => {
    const p = (window as unknown as { __live2dProbe: Probe }).__live2dProbe
    p.events.onVisibilityChanged(false)
    p.snapshot({ visible: true, onBatteryPower: false, alwaysOnTop: false, ignoreMouseEvents: false, live2dEnabled: true, bounds: { x: 0, y: 0, width: 200, height: 300 } })
    window.dispatchEvent(new Event('resize'))
  })
  await expect.poll(async () => (await probe()).frame?.visible).toBe(false)
  await page.waitForTimeout(250)
  expect((await probe()).frame?.visible).toBe(false)
  expect((await probe()).fps).toBe(30)
  await page.evaluate(() => (window as unknown as { __live2dProbe: Probe }).__live2dProbe.events.onShown())
  await expect.poll(async () => (await probe()).frame?.visible).toBe(true)
  await page.evaluate(() => {
    localStorage.setItem('aics_room_presentation_v1', JSON.stringify({ id: 'full-room', ts: Date.now() }))
    window.dispatchEvent(new StorageEvent('storage', { key: 'aics_room_presentation_v1' }))
  })
  await expect.poll(async () => (await probe()).frame?.visible).toBe(false)
  await page.evaluate(() => {
    (window as unknown as { __live2dProbe: Probe }).__live2dProbe.events.onVisibilityChanged(false)
    localStorage.removeItem('aics_room_presentation_v1')
    window.dispatchEvent(new StorageEvent('storage', { key: 'aics_room_presentation_v1' }))
  })
  await page.waitForTimeout(100)
  expect((await probe()).frame?.visible).toBe(false)
})

test('legacy desktop bridge retains original textures and disables unsupported quality controls', async ({ page }) => {
  await fixture(page, true)
  await page.evaluate(() => {
    const p = (window as unknown as { __live2dProbe: Probe }).__live2dProbe
    p.snapshot({ visible: true, onBatteryPower: false, alwaysOnTop: false, ignoreMouseEvents: false, live2dEnabled: true, bounds: { x: 0, y: 0, width: 480, height: 720 } })
  })
  await expect(page.locator('.live2d-host')).toHaveAttribute('data-state', 'ready')
  await page.locator('.companion-page').click({ button: 'right', position: { x: 12, y: 12 } })
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const quality = page.locator('.companion-settings-popover').getByRole('combobox', { name: 'Live2D 画质' })
  await expect(quality).toBeDisabled()
  await expect(quality).toHaveValue('original')
  expect(await page.evaluate(() => (window as unknown as { __live2dProbe: Probe }).__live2dProbe.characters.every(value => value.textureScale === undefined))).toBe(true)
})

test('native character switches carry the selected adapter profile and release the previous model', async ({ page }) => {
  await fixture(page)
  await page.evaluate(() => {
    const p = (window as unknown as { __live2dProbe: Probe }).__live2dProbe
    p.snapshot({ visible: true, onBatteryPower: false, alwaysOnTop: false, ignoreMouseEvents: false, live2dEnabled: true, bounds: { x: 0, y: 0, width: 480, height: 720 } })
  })
  await expect(page.locator('.live2d-host')).toHaveAttribute('data-state', 'ready')
  await expect(page.locator('.live2d-capability-report summary')).toContainText('待实机')
  const probe = () => page.evaluate(() => {
    const value = (window as unknown as { __live2dProbe: Probe }).__live2dProbe
    return { characters: value.characters, destroyed: value.destroyed }
  })
  await expect.poll(async () => (await probe()).characters.at(-1)?.adapter?.profileId).toBe('profile-nene-v1')
  expect((await probe()).characters.at(-1)?.adapter?.mouth).toEqual({ id: 'ParamMouthOpenY', scale: 1 })

  await page.locator('.companion-page').click({ button: 'right', position: { x: 12, y: 12 } })
  await page.getByRole('combobox', { name: '切换陪伴角色' }).selectOption('natsume')
  await expect(page.locator('.companion-page')).toHaveAttribute('data-character', 'natsume')
  await expect.poll(async () => (await probe()).characters.at(-1)?.adapter?.profileId).toBe('profile-natsume-v1')
  expect((await probe()).characters.at(-1)?.adapter?.mouth).toEqual({ id: 'ParamMouthForm3', scale: -0.5 })
  expect((await probe()).characters.at(-1)?.adapter?.blink).toEqual(['ParamEyeLOpen', 'ParamEyeLOpen2'])
  expect((await probe()).destroyed).toBeGreaterThanOrEqual(1)
})


test('a focused character picker stays visible after the desktop idle timeout', async ({ page }) => {
  test.skip(process.env.AICS_LIVE2D_IMPORTS !== '1', 'Requires imported character picker')
  await fixture(page, false, true)
  await page.evaluate(() => {
    const p = (window as unknown as { __live2dProbe: Probe }).__live2dProbe
    p.snapshot({ visible: true, onBatteryPower: false, live2dEnabled: true, bounds: { x: 0, y: 0, width: 480, height: 720 } })
  })
  const picker = page.getByRole('combobox', { name: '切换陪伴角色', exact: true })
  await picker.hover()
  await picker.focus()
  await page.waitForTimeout(3600)
  await expect(picker).toBeVisible()
  await picker.selectOption('furina')
  await expect(page.locator('.companion-page')).toHaveAttribute('data-character', 'furina')
})
