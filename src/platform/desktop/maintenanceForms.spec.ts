import { afterEach, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import ChatApiSettings from '@/components/ChatApiSettings.vue'
import { maintenanceParticipants } from '../maintenanceParticipants'

vi.mock('@/platform/desktop/capabilities', () => ({ getDesktopCapabilities: () => undefined }))
afterEach(() => localStorage.clear())

it('refuses an open API editor without submitting its fields and unregisters when it closes', async () => {
  const initial = new Set(maintenanceParticipants())
  const wrapper = mount(ChatApiSettings, { props: { vendor: 'custom', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: '' } })
  await wrapper.get('input[type="url"]').setValue('https://edited.invalid/v1')
  const owned = maintenanceParticipants().filter(participant => !initial.has(participant))
  expect(owned).toHaveLength(1)
  expect(() => owned[0]()).toThrow('OPEN_API_SETTINGS')
  expect(wrapper.emitted('save')).toBeUndefined()
  expect(localStorage.getItem('aics_chat_api_drafts')).toBeNull()
  wrapper.unmount()
  expect(maintenanceParticipants()).not.toContain(owned[0])
})
