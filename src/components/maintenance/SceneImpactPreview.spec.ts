import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import SceneImpactPreview from './SceneImpactPreview.vue'
import type { SceneChangesPreview } from '@/types/api'

const preview: SceneChangesPreview = { ok: true, baseVersion: 42, version: 42, added: ['sc1000'], updated: [], removed: ['sc999'],
  blueprints: { added: [], updated: ['bp_001'], removed: [] }, related: [{ kind: 'curation', id: 'sc999', reason: '策展引用：reviewSceneIds' }], checks: ['保存时校验'], unknown: ['未验收真实画面'] }
const props = { preview, groups: [{ key: 'scenes-added', label: '场景 · 新增', items: [{ id: 'sc1000', title: '<img src=x>fixture' }] }],
  companions: ['标签库有修改'], busy: false, enabled: true, error: '', invalidated: false, empty: false }

describe('visible impact preview', () => {
  it('renders IDs, titles, references, companions and limits as escaped text', () => {
    const wrapper = mount(SceneImpactPreview, { props })
    expect(wrapper.text()).toContain('sc1000')
    expect(wrapper.text()).toContain('<img src=x>fixture')
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.text()).toContain('策展引用')
    expect(wrapper.text()).toContain('标签库有修改')
    expect(wrapper.text()).toContain('未验收真实画面')
    expect(wrapper.find('.impact-list').attributes('tabindex')).toBe('0')
    wrapper.unmount()
  })
  it('hides invalidated or busy results and exposes an accessible retry/error state', async () => {
    const wrapper = mount(SceneImpactPreview, { props })
    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('preview')).toHaveLength(1)
    await wrapper.setProps({ invalidated: true })
    expect(wrapper.find('[data-testid="scene-impact-result"]').exists()).toBe(false)
    expect(wrapper.get('[role="status"]').text()).toContain('失效')
    await wrapper.setProps({ busy: true, enabled: false, error: '读取失败' })
    expect(wrapper.attributes('aria-busy')).toBe('true')
    expect(wrapper.get('button').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[role="alert"]').text()).toBe('读取失败')
    wrapper.unmount()
  })
})
