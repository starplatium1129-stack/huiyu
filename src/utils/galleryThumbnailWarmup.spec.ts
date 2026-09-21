import { describe, expect, it, vi } from 'vitest'
import { createThumbnailWarmup, type ThumbnailWarmupDependencies } from './galleryThumbnailWarmup'

function harness(overrides: Partial<ThumbnailWarmupDependencies> = {}) {
  const queued = new Map<number, () => void>()
  let sequence = 0, visible = true
  let listener: (() => void) | undefined
  const cache = new Map<string, unknown>()
  const deps: ThumbnailWarmupDependencies = {
    list: vi.fn(async () => [{ image_id: 'one' }, { image_id: 'one' }, { image_id: 'two' }]),
    get: vi.fn(async key => cache.get(key)),
    put: vi.fn(async (key, value) => { cache.set(key, value) }),
    image: vi.fn(async () => new Blob(['neutral'])),
    render: vi.fn(async () => 'data:image/jpeg;base64,YQ=='),
    lock: vi.fn(async (_key, work) => work()),
    visible: () => visible,
    listen: value => { listener = value; return () => { listener = undefined } },
    schedule: work => { queued.set(++sequence, work); return sequence },
    cancel: id => { queued.delete(id) },
    ...overrides,
  }
  return { deps, queued, cache,
    hide() { visible = false; listener?.() }, show() { visible = true; listener?.() },
    async tick() { const current = [...queued.values()]; queued.clear(); current.forEach(work => work()); for (let index=0;index<20;index++) await Promise.resolve() },
  }
}

describe('optional gallery thumbnail warmup', () => {
  it('starts only while visible and visits each image once', async () => {
    const env = harness(); env.hide()
    const stop = createThumbnailWarmup(env.deps)
    expect(env.queued.size).toBe(0); expect(env.deps.list).not.toHaveBeenCalled()
    env.show(); await env.tick(); await env.tick(); await env.tick()
    expect(env.deps.get).toHaveBeenCalledTimes(2)
    expect(env.deps.render).toHaveBeenCalledTimes(2)
    expect(env.queued.size).toBe(0)
    stop()
  })
  it('pauses between storage read and image decode, then resumes the same image', async () => {
    let release!: (value: unknown) => void
    const env = harness({ list: async () => [{ image_id: 'one' }] })
    vi.mocked(env.deps.get).mockImplementationOnce(() => new Promise(resolve => { release=resolve }))
    const stop=createThumbnailWarmup(env.deps); await env.tick()
    env.hide(); release(null); await env.tick()
    expect(env.deps.image).not.toHaveBeenCalled(); expect(env.queued.size).toBe(0)
    env.show(); await env.tick()
    expect(env.deps.image).toHaveBeenCalledWith('one')
    expect(env.deps.render).toHaveBeenCalledTimes(1)
    stop()
  })
  it('rechecks cache under shared per-image locks so two pages generate only once', async () => {
    const cache=new Map<string, unknown>(), tails=new Map<string, Promise<boolean>>()
    const render=vi.fn(async ()=>'data:image/jpeg;base64,YQ==')
    const shared: Partial<ThumbnailWarmupDependencies> = {
      get: async key=>cache.get(key), put: async(key,value)=>{cache.set(key,value)},render,
      lock: (key,work)=>{ const pending=(tails.get(key)??Promise.resolve(true)).then(work);tails.set(key,pending);return pending },
    }
    const first=harness(shared),second=harness(shared)
    const stop1=createThumbnailWarmup(first.deps),stop2=createThumbnailWarmup(second.deps)
    for(let round=0;round<5;round++)await Promise.all([first.tick(),second.tick()])
    expect(render).toHaveBeenCalledTimes(2)
    expect(cache.size).toBe(2)
    stop1();stop2()
  })
  it('stopping during an image read prevents decode and future visibility scheduling', async () => {
    let release!: (value: Blob) => void
    const env=harness({image:vi.fn(()=>new Promise<Blob>(resolve=>{release=resolve}))})
    const stop=createThumbnailWarmup(env.deps);await env.tick();stop()
    release(new Blob(['neutral']));await env.tick();env.hide();env.show()
    expect(env.deps.render).not.toHaveBeenCalled();expect(env.deps.put).not.toHaveBeenCalled()
    expect(env.queued.size).toBe(0)
  })
  it('skips a failed optional thumbnail and keeps processing later images', async () => {
    const env=harness()
    vi.mocked(env.deps.render).mockRejectedValueOnce(new Error('decode failed'))
    const stop=createThumbnailWarmup(env.deps);await env.tick();await env.tick()
    expect(env.deps.render).toHaveBeenCalledTimes(2);expect(env.deps.put).toHaveBeenCalledTimes(1)
    stop()
  })
})
