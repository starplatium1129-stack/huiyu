import { beforeEach, describe, expect, it, vi } from 'vitest'
import { shallowMount, flushPromises } from '@vue/test-utils'
import { computed, ref } from 'vue'
import { useResultShelf, type ShelfItem } from '@/composables/prompt/useResultShelf'
import DirectorResultShelf from './DirectorResultShelf.vue'
vi.mock('@/composables/prompt/useResultShelf',()=>({useResultShelf:vi.fn()}))
const {save}=vi.hoisted(()=>({save:vi.fn()}))
vi.mock('@/composables/tasks/taskArtwork',()=>({archiveTaskResult:save}))
function setup() {
  const item:ShelfItem={key:'task:one:2',title:'候选',kind:'task',source:'/api/tasks/v1/one/results/2',taskId:'one',index:2}
  const selectedKey=ref(item.key)
  vi.mocked(useResultShelf).mockReturnValue({category:ref('candidates'),items:computed(()=>[item]),selected:computed(()=>selectedKey.value?item:undefined),selectedKey,thumbnails:ref({}),previewUrl:ref('blob:preview'),loading:ref(false),error:ref(''),retry:ref(0)})
  const wrapper=shallowMount(DirectorResultShelf,{props:{history:[],currentUrl:'blob:live',busy:false},global:{stubs:{RouterLink:true}}})
  return {wrapper,selectedKey}
}
beforeEach(()=>vi.clearAllMocks())
describe('explicit candidate delivery',()=>{
  it('archives the selected output only, with no automatic save on preview',async()=>{
    const {wrapper}=setup(); expect(save).not.toHaveBeenCalled()
    const button=wrapper.findAll('button').find(b=>b.text()==='存入作品册')!
    await button.trigger('click'); await flushPromises()
    expect(save).toHaveBeenCalledExactlyOnceWith('one',2)
    expect(wrapper.emitted('saved')).toHaveLength(1)
    expect(button.text()).toBe('已入册'); wrapper.unmount()
  })
  it('prevents duplicate saves and keeps a late status off another preview',async()=>{
    let finish!:()=>void; save.mockImplementationOnce(()=>new Promise<void>(resolve=>{finish=resolve}))
    const {wrapper,selectedKey}=setup()
    const button=wrapper.findAll('button').find(b=>b.text()==='存入作品册')!
    await button.trigger('click'); await flushPromises()
    expect(button.attributes('disabled')).toBeDefined()
    selectedKey.value=''; finish(); await flushPromises()
    expect(save).toHaveBeenCalledTimes(1); expect(wrapper.find('.shelf-preview').exists()).toBe(false); wrapper.unmount()
  })
})
