import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSceneStore, DATA_VERSION } from './sceneStore'

/**
 * sceneStore 数据装载契约：
 *  - fetch 按 ?v=<DATA_VERSION> 拉取分片与元数据
 *  - 多分片合并按 sc 序号排序且跨片去重（先到先得）
 *  - 按需加载只拉目标角色分片；inflight 去重；失败落 error 态
 */

type Json = unknown
const calls: string[] = []
let routes: Record<string, Json> = {}
/** 文件 → 剩余失败次数（模拟临时 503 后恢复） */
let failOnce: Record<string, number> = {}
/** 持续失败直到手动清除（模拟可选资源长期不可用） */
let failAlways = new Set<string>()

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const url = String(input)
    calls.push(url)
    const file = url.replace(/^\/data\//, '').replace(/\?.*$/, '')
    if ((failOnce[file] ?? 0) > 0) {
      failOnce[file] -= 1
      return { ok: false, status: 503, json: async () => null } as Response
    }
    if (failAlways.has(file)) {
      return { ok: false, status: 503, json: async () => null } as Response
    }
    if (!(file in routes)) {
      return { ok: false, status: 404, json: async () => null } as Response
    }
    return { ok: true, status: 200, json: async () => routes[file] } as Response
  }))
}

function scene(id: string, extra: Record<string, unknown> = {}) {
  return { id, title: id, ...extra }
}

function response(value: Json): Response {
  return { ok: true, status: 200, json: async () => structuredClone(value) } as Response
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function revisionData(file: string, revision: string): Json {
  if (file === 'scenes-shared.json') return [scene('sc001', { title: `${revision}-shared` })]
  if (file === 'scenes-nene.json') return [scene('sc002', { title: `${revision}-nene` })]
  if (file === 'scenes-natsume.json') return [scene('sc003', { title: `${revision}-natsume` })]
  if (file === 'scenes-core.json') return [scene('sc004', { title: `${revision}-core` })]
  if (file === 'curation.json') return { revision }
  if (file === 'scenes-index.json') return { version: 1, total: 3 }
  if (file === 'characters.json') return [{ id: 'char-1', name: revision }]
  if (file === 'popular-characters.json') return { characters: [] }
  if (file === 'scene-blueprints.json') return {
    blueprints: [{
      id: 'bp-1', title: 'Blueprint', category: 'daily', description: 'A fixture blueprint',
      location: 'room', action: 'sit', timeOfDay: 'day', lighting: 'soft', camera: 'portrait',
      mood: 'calm', sceneTags: [], promptProse: 'A fixture scene', promptTokens: ['fixture'],
      negativeTokens: [], recommendedSize: '832x1216', adult: false,
    }],
  }
  return []
}

beforeEach(() => {
  calls.length = 0
  routes = {}
  failOnce = {}
  failAlways = new Set()
  localStorage.clear()
  setActivePinia(createPinia())
})

describe('sceneStore · 全量加载', () => {
  it('load() 拉齐三分片与元数据，合并去重并按 sc 序号升序', async () => {
    routes = {
      'scenes-shared.json': [scene('sc090', { char: 'triad' }), scene('sc010')],
      'scenes-nene.json': [scene('sc080'), scene('sc090', { title: '重复的应被丢弃' })],
      'scenes-natsume.json': [scene('sc100')],
      'curation.json': {},
      'characters.json': [],
      'loras.json': [],
      'tags.json': [],
      'presets.json': [],
      'popular-characters.json': { characters: [] },
      'scene-blueprints.json': { blueprints: [] },
    }
    stubFetch()
    const store = useSceneStore()
    await store.load()

    expect(store.loaded).toBe(true)
    expect(store.scenes.map(s => s.id)).toEqual(['sc010', 'sc080', 'sc090', 'sc100'])
    // 重复 id：shared 先注册，nene 分片里的重复项被丢弃
    expect(store.scenes.find(s => s.id === 'sc090')?.title).toBe('sc090')
    // 所有请求都带缓存版本号
    expect(calls.every(u => u.includes(`v=${DATA_VERSION}`))).toBe(true)
  })

  it('force 重载会递增版本号绕过浏览器缓存', async () => {
    routes = {
      'scenes-shared.json': [], 'scenes-nene.json': [], 'scenes-natsume.json': [],
      'curation.json': {}, 'characters.json': [], 'loras.json': [], 'tags.json': [],
      'presets.json': [], 'popular-characters.json': { characters: [] }, 'scene-blueprints.json': { blueprints: [] },
    }
    stubFetch()
    const store = useSceneStore()
    await store.load()
    await store.load(true)

    const versions = new Set(calls.map(u => u.split('v=')[1]))
    expect(versions.has(String(DATA_VERSION))).toBe(true)
    expect(versions.has(String(DATA_VERSION + 1))).toBe(true)
  })

  it('轻载与完整加载重叠时，完整入口必须补齐必需元数据', async () => {
    const gate = deferred<void>()
    const heldLite = new Set(['curation.json', 'scenes-index.json', 'popular-characters.json'])
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      calls.push(url)
      const file = url.replace(/^\/data\//, '').replace(/\?.*$/, '')
      if (heldLite.has(file)) await gate.promise
      return response(revisionData(file, 'new'))
    }))
    const store = useSceneStore()
    const home = store.loadHome()
    const full = store.load()
    gate.resolve()
    await Promise.all([home, full])

    expect(store.loaded).toBe(true)
    expect(store.characters).toEqual([{ id: 'char-1', name: 'new' }])
    expect(store.sceneBlueprints).toHaveLength(1)
    expect(calls.filter(url => url.includes('curation.json')).length).toBe(1)
  })

  it('force 刷新不加入旧分片请求，旧分片完成后也不能污染新缓存', async () => {
    const oldShared = deferred<Response>()
    const oldNene = deferred<Response>()
    let oldShardRequests = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      calls.push(url)
      const parsed = new URL(url, 'http://localhost')
      const file = parsed.pathname.replace(/^\/data\//, '')
      const revision = parsed.searchParams.get('v') === String(DATA_VERSION) ? 'old' : 'new'
      if (revision === 'old' && file === 'scenes-shared.json') {
        oldShardRequests += 1
        return oldShared.promise
      }
      if (revision === 'old' && file === 'scenes-nene.json') {
        oldShardRequests += 1
        return oldNene.promise
      }
      return response(revisionData(file, revision))
    }))
    const store = useSceneStore()
    const initial = store.loadCharacter('nene')
    for (let attempt = 0; attempt < 20 && oldShardRequests < 2; attempt += 1) {
      await new Promise(resolve => setImmediate(resolve))
    }
    expect(oldShardRequests).toBe(2)

    const refreshed = store.reload()
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (calls.some(url => url.includes(`scenes-nene.json?v=${DATA_VERSION + 1}`))) break
      await new Promise(resolve => setImmediate(resolve))
    }
    expect(calls.some(url => url.includes(`scenes-nene.json?v=${DATA_VERSION + 1}`))).toBe(true)
    oldShared.resolve(response(revisionData('scenes-shared.json', 'old')))
    oldNene.resolve(response(revisionData('scenes-nene.json', 'old')))
    await Promise.all([initial, refreshed])

    expect(store.loaded).toBe(true)
    expect(store.scenes.find(item => item.id === 'sc002')?.title).toBe('new-nene')
    expect(store.loadedShards).toEqual(new Set(['shared', 'nene', 'natsume']))
  })

  it('旧代际元数据晚到时，不能覆盖刷新后已发布的新值', async () => {
    const oldMetadata: Array<{ file: string; resolve: (value: Response) => void }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      calls.push(url)
      const parsed = new URL(url, 'http://localhost')
      const file = parsed.pathname.replace(/^\/data\//, '')
      const revision = parsed.searchParams.get('v') === String(DATA_VERSION) ? 'old' : 'new'
      if (revision === 'old' && !/^scenes-(?:shared|nene|natsume)\.json$/.test(file)) {
        const pending = deferred<Response>()
        oldMetadata.push({ file, resolve: pending.resolve })
        return pending.promise
      }
      return response(revisionData(file, revision))
    }))
    const store = useSceneStore()
    const initial = store.load()
    for (let attempt = 0; attempt < 20 && oldMetadata.length < 8; attempt += 1) {
      await new Promise(resolve => setImmediate(resolve))
    }
    expect(oldMetadata.length).toBe(8)

    await store.reload()
    expect(store.characters).toEqual([{ id: 'char-1', name: 'new' }])
    expect(store.curation).toEqual({ revision: 'new' })

    for (const pending of oldMetadata) pending.resolve(response(revisionData(pending.file, 'old')))
    await initial
    expect(store.characters).toEqual([{ id: 'char-1', name: 'new' }])
    expect(store.curation).toEqual({ revision: 'new' })
  })
})

describe('sceneStore · 按需加载与并发去重', () => {
  beforeEach(() => {
    routes = {
      'scenes-shared.json': [scene('sc001', { char: 'triad' })],
      'scenes-nene.json': [scene('sc002')],
      'scenes-natsume.json': [scene('sc003')],
      'curation.json': {}, 'characters.json': [], 'loras.json': [], 'tags.json': [],
      'presets.json': [], 'popular-characters.json': { characters: [] }, 'scene-blueprints.json': { blueprints: [] },
    }
  })

  it('loadCharacter 只拉 shared + 目标分片', async () => {
    stubFetch()
    const store = useSceneStore()
    await store.loadCharacter('natsume')

    expect(calls.some(u => u.includes('scenes-natsume.json'))).toBe(true)
    expect(calls.some(u => u.includes('scenes-nene.json'))).toBe(false)
    expect(store.scenes.map(s => s.id).sort()).toEqual(['sc001', 'sc003'])
  })

  it('inflight 去重：并发调用只发一轮请求', async () => {
    stubFetch()
    const store = useSceneStore()
    await Promise.all([store.loadCharacter('nene'), store.loadCharacter('nene'), store.loadCharacter('nene')])

    const neneCalls = calls.filter(u => u.includes('scenes-nene.json')).length
    expect(neneCalls).toBe(1)
  })

  it('ensureCharacter 命中已加载分片时零请求重建视图', async () => {
    stubFetch()
    const store = useSceneStore()
    await store.loadCharacter('nene')
    calls.length = 0

    await store.ensureCharacter('nene')
    expect(calls.length).toBe(0)
    expect(store.scenes.map(s => s.id)).toContain('sc002')
  })

  it('分片拉取失败落 error 态并结束 loading', async () => {
    stubFetch()
    routes = {} // 全部 404
    const store = useSceneStore()
    await store.loadCharacter('nene')

    expect(store.loading).toBe(false)
    expect(store.error).toBeTruthy()
    expect(store.loaded).toBe(false)
  })
})

describe('sceneStore · 失败恢复（审计 2026-09-05 P1-01）', () => {
  it('损坏 JSON 容器与重复角色 id 必须可见，恢复后可重新加载', async () => {
    routes = fullRoutes()
    stubFetch()
    const store = useSceneStore()
    await store.load()
    const previous = JSON.parse(JSON.stringify(store.characters))
    routes['characters.json'] = { invalid: true }
    await store.load(true)
    expect(store.error).toContain('characters.json')
    expect(store.characters).toEqual(previous)
    routes['characters.json'] = [{ id: 'same' }, { id: 'same' }]
    await store.load(true)
    expect(store.error).toContain('重复 id')
    routes = fullRoutes()
    routes['popular-characters.json'] = { characters: null }
    await store.load(true)
    expect(store.error).toContain('popular-characters.json')
    routes = fullRoutes()
    await store.load(true)
    expect(store.error).toBeNull()
  })
  const fullRoutes = () => ({
    'scenes-shared.json': [scene('sc001')],
    'scenes-nene.json': [scene('sc002')],
    'scenes-natsume.json': [scene('sc003')],
    'curation.json': {}, 'loras.json': [], 'tags.json': [], 'presets.json': [],
    'characters.json': [{ id: 'char-1', name: 'Nene' }],
    'popular-characters.json': { characters: [] },
    'scene-blueprints.json': { blueprints: [] },
  })

  it('必需元数据首载 503：不得标记 loaded，error 可见；恢复后重试补拉且不重复请求已成功资源', async () => {
    routes = fullRoutes()
    stubFetch()
    failOnce['characters.json'] = 1
    const store = useSceneStore()
    await store.load()

    // 失败可见：不能把 503 当成"成功但为空"
    expect(store.loaded).toBe(false)
    expect(store.error).toContain('characters.json')
    expect(store.characters).toEqual([])

    await store.load() // 服务恢复后原入口重试，无需整页刷新

    expect(store.loaded).toBe(true)
    expect(store.error).toBe(null)
    expect(store.characters).toEqual([{ id: 'char-1', name: 'Nene' }])
    // 已成功资源命中逐资源缓存（tags 只请求过 1 次），失败资源恰好补拉 1 次
    const fetchCount = (file: string) => calls.filter(u => u.split('?')[0].endsWith(`/${file}`)).length
    expect(fetchCount('tags.json')).toBe(1)
    expect(fetchCount('characters.json')).toBe(2)
    expect(fetchCount('scenes-nene.json')).toBe(1)
  })

  it('可选元数据失败：加载照常完成，失败单列可见；force 重载后恢复', async () => {
    routes = fullRoutes()
    stubFetch()
    failAlways.add('tags.json')
    const store = useSceneStore()
    await store.load()

    expect(store.loaded).toBe(true)
    expect(store.error).toBe(null)
    expect(store.metaFailedFiles.has('tags.json')).toBe(true)

    failAlways.clear()
    await store.load(true)
    expect(store.metaFailedFiles.has('tags.json')).toBe(false)
    expect(store.loaded).toBe(true)
  })

  it('已有成功数据后刷新失败：视图与元数据保留旧值，error 可见', async () => {
    routes = fullRoutes()
    stubFetch()
    const store = useSceneStore()
    await store.load()
    const oldCharacters = JSON.parse(JSON.stringify(store.characters))
    const oldScenes = JSON.parse(JSON.stringify(store.scenes))

    routes = {} // 全部 404
    await store.load(true)

    expect(store.error).toBeTruthy()
    expect(store.characters).toEqual(oldCharacters)
    expect(store.scenes).toEqual(oldScenes)
  })
})

describe('sceneStore · 多目标并发（审计 2026-09-05 P1-02）', () => {
  beforeEach(() => {
    routes = {
      'scenes-shared.json': [scene('sc001', { char: 'triad' })],
      'scenes-nene.json': [scene('sc002')],
      'scenes-natsume.json': [scene('sc003')],
      'curation.json': {}, 'characters.json': [], 'loras.json': [], 'tags.json': [],
      'presets.json': [], 'popular-characters.json': { characters: [] }, 'scene-blueprints.json': { blueprints: [] },
    }
  })

  it('不同角色并发：各自分片都被请求，最终视图为最后一次切换意图', async () => {
    stubFetch()
    const store = useSceneStore()
    await Promise.all([store.loadCharacter('nene'), store.loadCharacter('natsume')])

    // 回归断言：修复前夏目分片根本不会被请求
    expect(calls.some(u => u.includes('scenes-nene.json'))).toBe(true)
    expect(calls.some(u => u.includes('scenes-natsume.json'))).toBe(true)
    expect(store.scenes.map(s => s.id).sort()).toEqual(['sc001', 'sc003'])
  })

  it('快速往返切换：nene→natsume→nene 后最新意图（nene）生效', async () => {
    stubFetch()
    const store = useSceneStore()
    await Promise.all([
      store.loadCharacter('nene'),
      store.loadCharacter('natsume'),
      store.loadCharacter('nene'),
    ])

    expect(store.scenes.map(s => s.id).sort()).toEqual(['sc001', 'sc002'])
  })

  it('慢旧响应晚于新响应：旧目标完成时不得回写已切换的视图', async () => {
    let releaseNatsume!: () => void
    const natsumeGate = new Promise<void>((resolve) => { releaseNatsume = resolve })
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      calls.push(url)
      const file = url.replace(/^\/data\//, '').replace(/\?.*$/, '')
      if (file === 'scenes-natsume.json') await natsumeGate
      if (!(file in routes)) {
        return { ok: false, status: 404, json: async () => null } as Response
      }
      return { ok: true, status: 200, json: async () => routes[file] } as Response
    }))
    const store = useSceneStore()
    const slow = store.loadCharacter('natsume')
    const fast = store.loadCharacter('nene')
    await fast

    expect(store.scenes.map(s => s.id).sort()).toEqual(['sc001', 'sc002'])

    releaseNatsume()
    await slow
    // 旧目标（natsume）晚到：视图必须保持 nene，且不误报错误
    expect(store.scenes.map(s => s.id).sort()).toEqual(['sc001', 'sc002'])
    expect(store.error).toBe(null)
    expect(store.loading).toBe(false)
  })
})

describe('sceneStore · 目录页轻载（审计 2026-09-05 P2-02）', () => {
  const fullRoutes = () => ({
    'scenes-shared.json': [scene('sc001')],
    'scenes-nene.json': [scene('sc002')],
    'scenes-natsume.json': [scene('sc003')],
    'curation.json': { signatureSceneIds: ['sc002'] },
    'characters.json': [{ id: 'char-1' }],
    'loras.json': [], 'tags.json': [], 'presets.json': [],
    'popular-characters.json': { characters: [] },
    'scene-blueprints.json': { blueprints: [] },
  })
  const fetchCount = (file: string) => calls.filter(u => u.split('?')[0].endsWith(`/${file}`)).length

  it('loadHome 只拉轻元数据 + 三分片，不请求蓝图等重元数据', async () => {
    routes = fullRoutes()
    stubFetch()
    const store = useSceneStore()

    await store.loadHome()

    expect(store.scenes.map(s => s.id).sort()).toEqual(['sc001', 'sc002', 'sc003'])
    expect(store.popularCharacters).toEqual([])
    expect(fetchCount('scene-blueprints.json')).toBe(0)
    expect(fetchCount('characters.json')).toBe(0)
    expect(fetchCount('loras.json')).toBe(0)
    expect(fetchCount('scenes-nene.json')).toBe(1)
    // 轻载有意不置全量完成标志：重元数据尚未就绪
    expect(store.loaded).toBe(false)
  })

  it('轻载后全量 load() 增量补拉重元数据，已成功资源不重复请求', async () => {
    routes = fullRoutes()
    stubFetch()
    const store = useSceneStore()
    await store.loadHome()

    await store.load()

    expect(store.loaded).toBe(true)
    expect(fetchCount('scene-blueprints.json')).toBe(1)
    expect(fetchCount('characters.json')).toBe(1)
    // 轻载阶段已成功的资源不重复请求
    expect(fetchCount('popular-characters.json')).toBe(1)
    expect(fetchCount('scenes-nene.json')).toBe(1)
    expect(fetchCount('curation.json')).toBe(1)
  })
})
