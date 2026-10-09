import { mount, flushPromises } from '@vue/test-utils'
import { expect, it, vi } from 'vitest'
import ChatUserProfilePanel from './ChatUserProfilePanel.vue'
import { EMPTY_CHAT_USER_PROFILE } from '@/utils/chatUserProfile'

const profile = { ...EMPTY_CHAT_USER_PROFILE, callName: 'Initial' }
function editor(saveProfile: (profile: typeof EMPTY_CHAT_USER_PROFILE) => Promise<boolean>) {
  return mount(ChatUserProfilePanel, { props: { profile, saveProfile }, global: { stubs: { StudioSelect: true } } })
}

it('refreshes a clean editor but preserves dirty input through remote updates and failed saves, then permits retry', async () => {
  const save = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
  const wrapper = editor(save)
  try {
    await wrapper.setProps({ profile: { ...profile, callName: 'Remote' } })
    expect((wrapper.find('input').element as HTMLInputElement).value).toBe('Remote')
    await wrapper.find('input').setValue('Unsaved')
    await wrapper.setProps({ profile: { ...profile, callName: 'New remote', note: 'Other window note' } })
    await wrapper.find('.btn-primary').trigger('click'); await flushPromises()
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(save).toHaveBeenCalledWith({ ...profile, callName: 'Unsaved', note: 'Other window note' })
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('Other window note')
    expect((wrapper.find('input').element as HTMLInputElement).value).toBe('Unsaved')
    expect(wrapper.find('[role="status"]').text()).toContain('当前修改已保留')
    await wrapper.find('.btn-primary').trigger('click'); await flushPromises()
    expect(save).toHaveBeenLastCalledWith({ ...profile, callName: 'Unsaved', note: 'Other window note' })
    expect(wrapper.emitted('close')).toHaveLength(1)
  } finally { wrapper.unmount() }
})

it.each(['new text', 'initial value', 'reset'])('keeps newer %s edits when a submitted snapshot is acknowledged', async edit => {
  let acknowledge!: (saved: boolean) => void
  const save = vi.fn(() => new Promise<boolean>(resolve => { acknowledge = resolve }))
  const wrapper = editor(save)
  try {
    await wrapper.find('input').setValue('Submitted')
    await wrapper.find('.btn-primary').trigger('click')
    await wrapper.find('.btn-primary').trigger('click')
    expect(save).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('close')).toBeUndefined()
    if (edit === 'new text') await wrapper.find('textarea').setValue('Newer draft')
    else if (edit === 'initial value') await wrapper.find('input').setValue(profile.callName)
    else await wrapper.find('.profile-actions .btn-ghost').trigger('click')
    await wrapper.setProps({ profile: { ...profile, callName: 'Submitted', note: 'Remote note' } })
    acknowledge(true); await flushPromises()
    expect(wrapper.emitted('close')).toBeUndefined()
    expect((wrapper.find('input').element as HTMLInputElement).value).toBe(edit === 'new text' ? 'Submitted' : edit === 'reset' ? '' : profile.callName)
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe(edit === 'new text' ? 'Newer draft' : 'Remote note')
    expect(wrapper.find('[role="status"]').text()).toContain('当前修改尚未保存')
  } finally { wrapper.unmount() }
})

it('does not emit another close from an old save after dismissal and reopening', async () => {
  let acknowledge!: (saved: boolean) => void
  const wrapper = editor(() => new Promise<boolean>(resolve => { acknowledge = resolve }))
  const onClose = vi.fn()
  await wrapper.setProps({ onClose })
  await wrapper.find('.btn-primary').trigger('click')
  await wrapper.find('.profile-close').trigger('click')
  wrapper.unmount()
  const reopened = editor(async () => true)
  try {
    await reopened.find('input').setValue('Reopened draft')
    acknowledge(true); await flushPromises()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(reopened.emitted('close')).toBeUndefined()
    expect((reopened.find('input').element as HTMLInputElement).value).toBe('Reopened draft')
  } finally { reopened.unmount() }
})
