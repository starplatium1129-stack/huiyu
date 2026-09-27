import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, nextTick, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import type { ArtworkRecord } from '@/types/artwork'
const mocks = vi.hoisted(() => ({ getImage:vi.fn(), getThumbnail:vi.fn(), fetch:vi.fn(), thumb:vi.fn(), local:vi.fn(), callback:undefined as undefined | ((value: unknown) => void) }))
vi.mock('@/storage/artworkRepository', () => ({ artworkRepository: { getImage:mocks.getImage, getThumbnail:mocks.getThumbnail } }))
vi.mock('@/api/runtimeTasks', async () => { const { ref } = await import('vue'); return { runtimeTasks:ref([]), runtimeTasksEnabled:ref(true), runtimeResultPath:(t:{taskId:string}, i:number)=>`/api/tasks/v1/${t.taskId}/results/${i}`, fetchRuntimeResult:mocks.fetch } })
vi.mock('@/platform/desktop/runtime', () => ({ onDesktopRuntime: (cb:(value:unknown)=>void) => { mocks.callback=cb; return vi.fn() } }))
vi.mock('@/utils/runtimeEnvironment', () => ({ isLocalStudioHost:mocks.local }))
vi.mock('@/utils/imageThumb', () => ({ blobThumbDataUrl:mocks.thumb }))
import { runtimeTasks, type TaskRecord } from '@/api/runtimeTasks'
import { useResultShelf } from './useResultShelf'

function task(id = 'one'): TaskRecord { return { taskId:id, createdAt:1, resultState:'available', deliveryState:'unseen', resultRefs:[{index:0,mime:'image/png'}] } as TaskRecord }
function setup(entries:ArtworkRecord[] = []) {
  let shelf!:ReturnType<typeof useResultShelf>
  const history=ref(entries)
  const wrapper=mount(defineComponent({ setup(){ shelf=useResultShelf(history,ref(null)); return ()=>null } }))
  return { shelf,wrapper,history }
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.local.mockReturnValue(true)
  mocks.getThumbnail.mockResolvedValue('data:image/png;base64,thumb')
  mocks.getImage.mockResolvedValue(new Blob(['image'],{type:'image/png'}))
  mocks.fetch.mockResolvedValue(new Blob(['image'],{type:'image/png'})); mocks.thumb.mockResolvedValue('data:image/png;base64,thumb')
  URL.createObjectURL=vi.fn().mockReturnValue('blob:owned'); URL.revokeObjectURL=vi.fn()
  // Test adapter replaces the read-only public projection without touching production state.
  ;(runtimeTasks as unknown as {value:TaskRecord[]}).value=[]
})
describe('result shelf resource ownership', () => {
  it('previews history without mutating its recipe and releases owned URLs on return', async () => {
    const {shelf,wrapper,history}=setup([{id:'old',image_id:'img',prompt:'frozen',seed:0}])
    shelf.category.value='history'; await nextTick(); shelf.selectedKey.value='history:string:old'; await flushPromises()
    expect(shelf.previewUrl.value).toBe('blob:owned')
    expect(history.value[0]).toMatchObject({prompt:'frozen',seed:0})
    shelf.selectedKey.value=''; await nextTick()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:owned'); wrapper.unmount()
  })
  it('ignores an old image read completing after the selection changes', async () => {
    let finish!:(blob:Blob)=>void
    mocks.getImage.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}))
    const {shelf,wrapper}=setup([{id:'old',image_id:'img'}])
    shelf.category.value='history'; await nextTick(); shelf.selectedKey.value='history:string:old'; await nextTick()
    shelf.selectedKey.value=''; await nextTick(); finish(new Blob(['late'])); await flushPromises()
    expect(shelf.previewUrl.value).toBe(''); expect(URL.createObjectURL).not.toHaveBeenCalled(); wrapper.unmount()
  })
  it('does not re-fetch thumbnails on unchanged task polling', async () => {
    ;(runtimeTasks as unknown as {value:TaskRecord[]}).value=[task()]
    const {wrapper}=setup(); await flushPromises()
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
    ;(runtimeTasks as unknown as {value:TaskRecord[]}).value=[task()]; await flushPromises()
    expect(mocks.fetch).toHaveBeenCalledTimes(1); wrapper.unmount()
  })
  it('cancels in-flight task reads on unmount and never publishes their late result', async () => {
    let finish!:(blob:Blob)=>void
    mocks.fetch.mockImplementation(()=>new Promise(resolve=>{finish=resolve}))
    ;(runtimeTasks as unknown as {value:TaskRecord[]}).value=[task()]
    const {wrapper}=setup(); const signal=mocks.fetch.mock.calls[0][1] as AbortSignal
    wrapper.unmount(); expect(signal.aborted).toBe(true)
    finish(new Blob(['late'])); await flushPromises(); expect(URL.createObjectURL).not.toHaveBeenCalled()
  })
  it('does not expose private task or history thumbnails on a remote host', async () => {
    mocks.local.mockReturnValue(false)
    ;(runtimeTasks as unknown as {value:TaskRecord[]}).value=[task()]
    const {shelf,wrapper}=setup([{id:'private',image_id:'img'}]); await flushPromises()
    expect(shelf.items.value).toEqual([]); shelf.category.value='history'; await nextTick()
    expect(shelf.items.value).toEqual([]); expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.getImage).not.toHaveBeenCalled(); wrapper.unmount()
  })
})
