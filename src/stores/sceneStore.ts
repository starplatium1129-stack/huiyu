import type { SceneRecord as Scene } from '../types/scene'
export type { SceneRecord as Scene } from '../types/scene'

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { requireDataRecords, requireDataCollection } from '@/utils/dataRecords'
import {
  parsePopularCharacters,
  parseSceneBlueprints,
  type PopularCharacter,
  type SceneBlueprint,
} from '@/utils/popularContent.ts'

export interface CurationData {
  featured?: string[]
  tiers?: Record<string, string[]>
  curatedSceneIds?: string[]
  signatureSceneIds?: string[]
  personaCoreSceneIds?: string[]
  personaCoreReasons?: Record<string, string>
  [key: string]: unknown
}

export interface LoraMeta {
  id?: string
  name?: string
  [key: string]: unknown
}

export interface SceneIndex {
  version?: number
  total?: number
  shards?: Record<string, { file: string; count: number }>
  tiers?: { core?: string[] }
  orderedIds?: string[]
}

export interface TagMeta {
  en: string
  cn: string
  cat: string
  [key: string]: unknown
}

/**
 * 静态数据的缓存版本号。
 *
 * 服务端对 /data/*.json 已按 immutable 缓存，浏览器靠 ?v= 换 URL 拿新数据，
 * 因此这个值必须与 data/*.json 的内容一一对应：scripts/maintenance/
 * validate-content-contracts.js 会用数据内容的 sha1 派生期望值并校验，
 * 改过 data/*.json 后 `npm run validate` 会提示这里该改成什么。
 * 以前是手动计数（曾到 15），现在由内容锁定，不会再出现"改数据忘升版本"。
 */
export const DATA_VERSION = 285253322

/** 带 response.ok 检查的 JSON 读取 —— 否则 HTML 错误页会被当数据解析 */
async function fetchJson<T>(file: string, version: number): Promise<T> {
  const response = await fetch(`/data/${file}?v=${version}`)
  if (!response.ok) throw new Error(`${file} HTTP ${response.status}`)
  return (await response.json()) as T
}

const CORE_FILE = 'scenes-core.json'
const SHARD_FILES = {
  nene: 'scenes-nene.json',
  natsume: 'scenes-natsume.json',
  shared: 'scenes-shared.json',
} as const
type ShardChar = keyof typeof SHARD_FILES

function sceneNumber(scene: Scene): number {
  const match = /^sc(\d+)$/.exec(String(scene.id || ''))
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER
}

function sortScenes(list: Scene[]): Scene[] {
  return [...list].sort((left, right) => sceneNumber(left) - sceneNumber(right))
}

function mergeScenes(...lists: Array<Scene[] | undefined>): Scene[] {
  const seen = new Set<string>()
  const out: Scene[] = []
  for (const list of lists) {
    for (const scene of list || []) {
      if (!scene || !scene.id || seen.has(scene.id)) continue
      seen.add(scene.id)
      out.push(scene)
    }
  }
  return sortScenes(out)
}

export const useSceneStore = defineStore('scenes', () => {
  const scenes = ref<Scene[]>([])
  const curation = ref<CurationData>({})
  const characters = ref<Array<Record<string, unknown>>>([])
  const loras = ref<LoraMeta[]>([])
  const tags = ref<TagMeta[]>([])
  const presets = ref<Record<string, unknown> | unknown[]>([])
  const index = ref<SceneIndex | null>(null)
  const popularCharacters = ref<PopularCharacter[]>([])
  const sceneBlueprints = ref<SceneBlueprint[]>([])

  const loading = ref(false)
  const error = ref<string | null>(null)
  /** 完整数据已加载（三条角色分片齐了才算）；部分加载只算 partial。 */
  const loaded = ref(false)
  const loadedShards = ref<Set<ShardChar>>(new Set())
  /** 手动作废缓存时递增，用于绕过浏览器缓存（场景管理保存后要读到新数据） */
  const version = ref(DATA_VERSION)
  /** 最近一次加载中失败的元数据文件（可选资源失败在此可见，不阻塞完成） */
  const metaFailedFiles = ref<Set<string>>(new Set())

  /** 活跃加载数：loading 反映"任意入口在途"，避免多目标并发时先完成者提前熄灯。 */
  let activeLoads = 0
  function beginLoad() {
    activeLoads += 1
    loading.value = true
  }
  function endLoad() {
    activeLoads = Math.max(0, activeLoads - 1)
    if (activeLoads === 0) loading.value = false
  }

  // ── 元数据层：必需/可选区分 + 逐资源成功缓存 ───────────────────────────

  interface MetaSpec {
    file: string
    /** 必需资源失败必须让整次加载失败并可见；可选资源失败保留上次成功数据。 */
    required: boolean
    /** lite=true：目录页（首页/全局搜索）轻载也需要的资源。 */
    lite: boolean
    parse: (raw: unknown) => unknown
    apply: (data: unknown) => void
  }

  const META_SPECS: MetaSpec[] = [
    { file: 'curation.json', required: false, lite: true, parse: (raw) => raw ?? {}, apply: (d) => { curation.value = d as CurationData } },
    { file: 'characters.json', required: true, lite: false, parse: (raw) => requireDataRecords(raw, 'characters.json'), apply: (d) => { characters.value = d as Array<Record<string, unknown>> } },
    { file: 'loras.json', required: false, lite: false, parse: (raw) => (Array.isArray(raw) ? raw : []), apply: (d) => { loras.value = d as LoraMeta[] } },
    { file: 'tags.json', required: false, lite: false, parse: (raw) => (Array.isArray(raw) ? raw : []), apply: (d) => { tags.value = d as TagMeta[] } },
    { file: 'presets.json', required: false, lite: false, parse: (raw) => raw ?? [], apply: (d) => { presets.value = d as Record<string, unknown> | unknown[] } },
    { file: 'scenes-index.json', required: false, lite: true, parse: (raw) => raw ?? null, apply: (d) => { index.value = d as SceneIndex | null } },
    { file: 'popular-characters.json', required: true, lite: true, parse: (raw) => parsePopularCharacters(requireDataCollection(raw, 'characters')), apply: (d) => { popularCharacters.value = d as PopularCharacter[] } },
    { file: 'scene-blueprints.json', required: true, lite: false, parse: (raw) => parseSceneBlueprints(requireDataCollection(raw, 'blueprints')), apply: (d) => { sceneBlueprints.value = d as SceneBlueprint[] } },
  ]

  /** 已成功资源的解析结果：重试只补失败项，不重复请求已成功资源；force 时逐项重取。 */
  const metaOk = new Map<string, unknown>()
  let metaLoaded = false
  /** 在途元数据加载的持有者：finally 里比对持有者身份清槽，避免自引用 promise。 */
  let metaInflight: { promise: Promise<void> } | null = null

  async function runMetaLoad(force: boolean, lite = false): Promise<void> {
    const v = version.value
    const failedNow = new Set<string>()
    const requiredFailures: string[] = []
    const specs = lite ? META_SPECS.filter((spec) => spec.lite) : META_SPECS
    await Promise.all(specs.map(async (spec) => {
      if (!force && metaOk.has(spec.file)) {
        spec.apply(metaOk.get(spec.file))
        return
      }
      try {
        const parsed = spec.parse(await fetchJson(spec.file, v))
        metaOk.set(spec.file, parsed)
        spec.apply(parsed)
      } catch (e) {
        // 失败资源清除成功缓存以便重试；已应用到视图的旧数据保持不动
        metaOk.delete(spec.file)
        failedNow.add(spec.file)
        if (spec.required) requiredFailures.push(`${spec.file}: ${(e as Error)?.message ?? e}`)
      }
    }))
    metaFailedFiles.value = failedNow
    if (requiredFailures.length) {
      throw new Error(`必需数据加载失败：${requiredFailures.join('；')}`)
    }
  }

  function loadMeta(force = false, lite = false): Promise<void> {
    if (!force && metaLoaded) return Promise.resolve()
    if (!force && metaInflight) return metaInflight.promise
    const entry: { promise: Promise<void> } = { promise: Promise.resolve() }
    entry.promise = runMetaLoad(force, lite)
      .then(() => { metaLoaded = META_SPECS.every((spec) => metaOk.has(spec.file)) })
      .finally(() => { if (metaInflight === entry) metaInflight = null })
    metaInflight = entry
    return entry.promise
  }

  // ── 分片层：逐分片缓存 + 在途去重 ─────────────────────────────────────

  let shardCache: Partial<Record<ShardChar, Scene[]>> = {}
  let coreLoaded = false
  const shardInflight = new Map<ShardChar, { promise: Promise<Scene[]> }>()

  function loadShard(char: ShardChar): Promise<Scene[]> {
    const cached = shardCache[char]
    if (cached) return Promise.resolve(cached)
    const existing = shardInflight.get(char)
    if (existing) return existing.promise
    const entry: { promise: Promise<Scene[]> } = { promise: Promise.resolve([]) }
    entry.promise = fetchJson<Scene[]>(SHARD_FILES[char], version.value)
      .then((list) => {
        shardCache[char] = requireDataRecords(list, SHARD_FILES[char]) as Scene[]
        loadedShards.value = new Set([...loadedShards.value, char])
        return shardCache[char] as Scene[]
      })
      .finally(() => { if (shardInflight.get(char) === entry) shardInflight.delete(char) })
    shardInflight.set(char, entry)
    return entry.promise
  }

  // ── 视图层：按目标键去重 + 最新意图守卫 ────────────────────────────────

  /** 当前展示目标键。每次调用 load / loadCharacter / loadCore 都是一次意图申明。 */
  let viewTarget: string | null = null
  /** 同键强制重载的代际：只有该键最新一次工作才允许回写视图。 */
  let workSeq = 0
  const latestSeqByKey = new Map<string, number>()
  const inflightByKey = new Map<string, { promise: Promise<void> }>()

  /**
   * 按目标键启动/加入一个视图加载。同键并发去重；不同键各自成行。
   * work 收到 isCurrent 守卫：目标未被更新意图取代且仍是该键最新一次工作。
   * 旧响应（慢网/强制重载竞态）一律不得覆盖新意图的视图与错误态。
   */
  function beginTargetLoad(key: string, work: (isCurrent: () => boolean) => Promise<Scene[]>): Promise<void> {
    viewTarget = key
    const existing = inflightByKey.get(key)
    if (existing) return existing.promise
    const seq = ++workSeq
    latestSeqByKey.set(key, seq)
    const isCurrent = () => viewTarget === key && latestSeqByKey.get(key) === seq
    beginLoad()
    error.value = null
    const entry: { promise: Promise<void> } = { promise: Promise.resolve() }
    entry.promise = (async () => {
      try {
        const list = await work(isCurrent)
        if (isCurrent()) scenes.value = list
      } catch (e) {
        if (isCurrent()) {
          error.value = String((e as Error)?.message ?? e)
        }
      } finally {
        if (inflightByKey.get(key) === entry) inflightByKey.delete(key)
        endLoad()
      }
    })()
    inflightByKey.set(key, entry)
    return entry.promise
  }

  function resolveShard(char: string): ShardChar {
    return char === 'natsume' ? 'natsume' : char === 'triad' || char === 'shared' ? 'shared' : 'nene'
  }

  /** 只加载某角色所需的分片（shared + 目标角色），用于场景库按需浏览。 */
  function loadCharacter(char: string, force = false): Promise<void> {
    const shard = resolveShard(char)
    if (force) {
      shardCache[shard] = undefined
      loadedShards.value = new Set()
      inflightByKey.delete(`char:${shard}`)
    }
    return beginTargetLoad(`char:${shard}`, async () => {
      await loadMeta()
      const [shared, target] = await Promise.all([loadShard('shared'), loadShard(shard)])
      return mergeScenes(shared, target)
    })
  }

  /** 只加载默认"人设核心"视图所需的数据（index + shared + core 精选子集）。 */
  function loadCore(force = false): Promise<void> {
    if (force) {
      shardCache = {}
      loadedShards.value = new Set()
      inflightByKey.delete('core')
    }
    return beginTargetLoad('core', async (isCurrent) => {
      await loadMeta()
      const [shared, core] = await Promise.all([
        loadShard('shared'),
        fetchJson<Scene[]>(CORE_FILE, version.value),
      ])
      const list = mergeScenes(shared, Array.isArray(core) ? core : [])
      if (isCurrent()) coreLoaded = true
      return list
    })
  }

  function ensureCharacter(char: string): Promise<void> {
    if (loaded.value) return Promise.resolve()
    const shard = resolveShard(char)
    if (loadedShards.value.has(shard)) {
      // 目标分片已在手：直接用 shared + 目标分片重建视图，不发请求。
      viewTarget = `char:${shard}`
      scenes.value = mergeScenes(shardCache.shared || [], shardCache[shard] || [])
      return Promise.resolve()
    }
    return loadCharacter(char)
  }

  function ensureCore(): Promise<void> {
    if (loaded.value || coreLoaded) return Promise.resolve()
    return loadCore()
  }

  /**
   * 加载共享数据集。重复调用只发一次请求；已加载则直接返回。
   * @param force 场景管理保存后需要读回落盘结果时传 true
   */
  function load(force = false): Promise<void> {
    if (loaded.value && !force) return Promise.resolve()
    if (force) {
      version.value += 1
      shardCache = {}
      loadedShards.value = new Set()
      inflightByKey.delete('full')
    }
    return beginTargetLoad('full', async (isCurrent) => {
      await loadMeta(force)
      const [shared, nene, natsume] = await Promise.all([
        loadShard('shared'),
        loadShard('nene'),
        loadShard('natsume'),
      ])
      if (isCurrent()) loaded.value = true
      return mergeScenes(shared, nene, natsume)
    })
  }

  /** 场景管理写回 data/ 之后调用 */
  function reload() {
    loaded.value = false
    shardCache = {}
    loadedShards.value = new Set()
    metaLoaded = false
    return load(true)
  }

  /**
   * 目录页轻载（审计 2026-09-05 P2-02）：首页与全局搜索只吃 curation/角色目录/索引
   * 与三分片；3.4MB 场景蓝图与 prompt 元数据不在此拉取，由创作页的 load()/
   * loadCharacter()/loadCore() 依据逐资源缓存增量补拉。有意不置 loaded 标志——
   * 它只代表"重元数据也齐了"的全量完成态。
   */
  function loadHome(): Promise<void> {
    return beginTargetLoad('home', async () => {
      await loadMeta(false, true)
      const [shared, nene, natsume] = await Promise.all([
        loadShard('shared'),
        loadShard('nene'),
        loadShard('natsume'),
      ])
      return mergeScenes(shared, nene, natsume)
    })
  }

  function byId(id: string) {
    return scenes.value.find((s) => s.id === id) ?? null
  }

  const count = computed(() => scenes.value.length)

  return {
    scenes, curation, characters, loras, tags, presets, index,
    popularCharacters, sceneBlueprints,
    loading, error, loaded, loadedShards, version, metaFailedFiles,
    load, loadHome, loadCharacter, loadCore, ensureCharacter, ensureCore, reload, byId, count,
  }
})
