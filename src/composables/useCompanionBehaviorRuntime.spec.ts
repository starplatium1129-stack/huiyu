import { ref, defineComponent } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCompanionBehaviorRuntime } from './useCompanionBehaviorRuntime'
import { createCompanionBehavior } from '@/utils/companionBehavior'
import { createCompanionEventDetector } from '@/utils/companionEvents'
import { COMPANION_BEHAVIOR_KEY, COMPANION_AFFECTION_KEY } from '@/utils/storageKeys'
vi.mock('@/api/controlApi', () => ({ controlApi: { getStatus: async () => ({ ok: true, sdOnline: false, ttsOnline: false, ollamaOnline: false }) } }))
vi.mock('@/storage/artworkRepository', () => ({ artworkRepository: { countImages: async () => 10 } }))
let wrapper: ReturnType<typeof mount> | undefined
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-10T12:00:00')); localStorage.clear() })
afterEach(() => { wrapper?.unmount(); vi.useRealTimers(); vi.restoreAllMocks() })
async function setup(config: object = {}) {
  localStorage.setItem(COMPANION_BEHAVIOR_KEY, JSON.stringify({ quietStartHour: 0, quietEndHour: 0, ...config }))
  const activeChar = ref('nene'), visible = ref(true)
  let behavior!: ReturnType<typeof useCompanionBehaviorRuntime>
  wrapper = mount(defineComponent({ setup() {
    behavior = useCompanionBehaviorRuntime({ activeChar, desktopWindowVisible: () => visible.value, reconcileAutoListen: vi.fn() })
    return () => null
  } }))
  await flushPromises()
  return { behavior, activeChar, visible }
}
describe('companion behavior coordination', () => {
  it('hides queued reminders immediately in DND and restores eligible reminders afterwards', async () => {
    const { behavior } = await setup()
    expect(behavior.pendingReminders.value.length).toBeGreaterThan(0)
    behavior.toggleDnd()
    expect(behavior.pendingReminders.value).toHaveLength(0)
    behavior.toggleDnd()
    expect(behavior.pendingReminders.value.length).toBeGreaterThan(0)
  })
  it('does not consume a greeting slot when DND suppressed it', async () => {
    const { behavior } = await setup({ dnd: true })
    expect(behavior.pendingReminders.value).toHaveLength(0)
    behavior.toggleDnd(); behavior.maybeGreetByTime()
    expect(behavior.pendingReminders.value).toHaveLength(1)
  })
  it('drops the previous character reminders when switching characters', async () => {
    const { behavior, activeChar } = await setup()
    const previous = behavior.pendingReminders.value.map(item => item.id)
    activeChar.value = 'natsume'
    await flushPromises()
    expect(behavior.pendingReminders.value.every(item => !previous.includes(item.id))).toBe(true)
  })
  it('applies externally changed behavior settings without remounting', async () => {
    const { behavior } = await setup()
    localStorage.setItem(COMPANION_BEHAVIOR_KEY, JSON.stringify({ enabled: false }))
    window.dispatchEvent(new StorageEvent('storage', { key: COMPANION_BEHAVIOR_KEY }))
    expect(behavior.behaviorEnabled.value).toBe(false)
    expect(behavior.pendingReminders.value).toHaveLength(0)
  })
  it('does not dequeue while disabled or inside quiet hours', () => {
    const behavior = createCompanionBehavior({ quietStartHour: 23, quietEndHour: 8 })
    behavior.noteReturn('hello')
    expect(behavior.dequeue(new Date('2026-09-10T23:30:00').getTime())).toBeNull()
    behavior.setConfig({ enabled: false })
    expect(behavior.dequeue()).toBeNull()
    behavior.setConfig({ enabled: true })
    expect(behavior.dequeue()?.line).toBe('hello')
  })
  it('does not turn a failed image count into a false generation-complete event', () => {
    const detector = createCompanionEventDetector()
    const services = { sdOnline: false, ttsOnline: false, ollamaOnline: false }
    detector.ingest({ imageCount: 10, services })
    detector.ingest({ imageCount: null, services })
    expect(detector.ingest({ imageCount: 10, services })).toEqual([])
    expect(detector.ingest({ imageCount: 11, services: { sdOnline: true, ttsOnline: true, ollamaOnline: true } })).toEqual(['sd-done', 'service-back'])
  })
  it('preserves the latest affection value and ignores invalid changes', async () => {
    vi.resetModules()
    const { useCompanionAffection } = await import('./useCompanionAffection')
    const affection = useCompanionAffection()
    affection.setScore('nene', 30)
    localStorage.setItem(COMPANION_AFFECTION_KEY, JSON.stringify({ nene: { score: 70 } }))
    expect(affection.addScore('nene', 5).newScore).toBe(75)
    expect(affection.addScore('nene', NaN).newScore).toBe(75)
    localStorage.setItem(COMPANION_AFFECTION_KEY, '{broken')
    affection.addScore('nene', 5)
    expect(localStorage.getItem(COMPANION_AFFECTION_KEY)).toBe('{broken')
  })
})
