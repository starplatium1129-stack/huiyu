import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { useCanvasGenerationMotion } from './useCanvasGenerationMotion'
const activity={canAnimate:ref(true),lowEffects:ref(false),appearanceRevision:ref(0)}
vi.mock('./useVisualActivity',() => ({useVisualActivity:() => activity}))
const mock=vi.hoisted(() => ({start:vi.fn(),stop:vi.fn(),reveal:vi.fn()}))
vi.mock('@/utils/canvasTextureParticles',() => ({startCanvasTextureParticles:mock.start}))
const cleanups:Array<() => void>=[]
beforeEach(() => { Object.values(mock).forEach(fn => fn.mockReset()); activity.canAnimate.value=true; activity.lowEffects.value=false; mock.start.mockReturnValue({stop:mock.stop,reveal:mock.reveal}) })
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); vi.restoreAllMocks() })
async function fixture(initialSource = '/old.png') {
  const source=ref(initialSource),busy=ref(false),comparing=ref(false)
  let motion!:ReturnType<typeof useCanvasGenerationMotion>
  const wrapper=mount(defineComponent({setup() {
    const host=ref<HTMLElement | null>(null)
    motion=useCanvasGenerationMotion(host,() => source.value,() => busy.value,() => comparing.value,() => .15,() => [])
    return () => h('div',{ref:host},source.value ? h('img',{class:'cg-image-target',src:source.value}) : [])
  }}))
  const image=wrapper.find('img').exists() ? wrapper.get('img').element : undefined
  if (image) Object.defineProperties(image,{complete:{value:true},naturalWidth:{value:800},naturalHeight:{value:600}})
  cleanups.push(() => wrapper.unmount())
  return {source,busy,comparing,motion,wrapper,image}
}
it.each(['same tick','separate ticks'] as const)('keeps the same particle surface until decoded results settle in %s',async publication => {
  const {source,busy,motion,wrapper,image}=await fixture()
  source.value=''; busy.value=true; await nextTick()
  expect(mock.start).toHaveBeenCalledExactlyOnceWith(image,wrapper.element,expect.objectContaining({generation:expect.any(Object),onComplete:expect.any(Function)}))
  expect(wrapper.find('img').exists()).toBe(false)
  expect(motion.active.value).toBe(true)
  source.value='/new.png'
  if (publication==='separate ticks') await nextTick()
  busy.value=false; await nextTick()
  expect(mock.stop).not.toHaveBeenCalled()
  const decoded=wrapper.get('img').element
  const reveal={stop:mock.stop,finished:Promise.resolve()}
  mock.reveal.mockReturnValue(reveal)
  expect(motion.reveal(decoded)).toBe(reveal)
  expect(mock.reveal).toHaveBeenCalledExactlyOnceWith(decoded)
  expect(mock.start).toHaveBeenCalledOnce()
  motion.stop()
  expect(mock.stop).toHaveBeenCalledOnce()
  expect(source.value).toBe('/new.png')
})
it.each(['cancel','comparison','reduced','unmount'] as const)('releases GPU resources on %s without owning the result',async reason => {
  const {source,busy,comparing,wrapper}=await fixture()
  source.value=''; busy.value=true; await nextTick()
  if (reason==='cancel') busy.value=false
  if (reason==='comparison') comparing.value=true
  if (reason==='reduced') activity.canAnimate.value=false
  if (reason==='unmount') wrapper.unmount()
  await nextTick()
  expect(mock.stop).toHaveBeenCalledOnce()
  expect(source.value).toBe('')
})

it('leaves the ordinary progress visual available when WebGL is unavailable',async () => {
  const {source,busy,motion}=await fixture()
  mock.start.mockReturnValue(null)
  source.value=''; busy.value=true; await nextTick()
  expect(motion.active.value).toBe(false)
  expect(source.value).toBe('')
  expect(busy.value).toBe(true)
})

it('starts the same particle surface without an old image on an empty canvas',async () => {
  const {busy,motion,wrapper}=await fixture('')
  busy.value=true; await nextTick()
  expect(mock.start).toHaveBeenCalledExactlyOnceWith(null,wrapper.element,expect.objectContaining({generation:expect.any(Object)}))
  expect(motion.active.value).toBe(true)
})

it('stops unchanged old results and replaces an in-flight result when a new generation starts',async () => {
  const {source,busy,motion,image}=await fixture()
  // The image element can carry the resolved runtime URL while props stay relative.
  image!.setAttribute('src','https://runtime.example/old.png')
  busy.value=true; await nextTick()
  busy.value=false; await nextTick()
  expect(mock.stop).toHaveBeenCalledOnce()
  expect(motion.active.value).toBe(false)
  busy.value=true; await nextTick()
  source.value='/new.png'; await nextTick()
  busy.value=false; await nextTick()
  expect(mock.stop).toHaveBeenCalledOnce()
  busy.value=true; await nextTick()
  expect(mock.stop).toHaveBeenCalledTimes(2)
  expect(mock.start).toHaveBeenCalledTimes(3)
  // The previous result is now this generation's baseline, not a fresh result.
  busy.value=false; await nextTick()
  expect(mock.stop).toHaveBeenCalledTimes(3)
  expect(motion.active.value).toBe(false)
})
