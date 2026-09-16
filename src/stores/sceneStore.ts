import type { SceneRecord as Scene } from '../types/scene'
export type { SceneRecord as Scene } from '../types/scene'

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { DATA_VERSION } from 'virtual:data-version'
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
 * 运行时数据由维护链路更新，服务端用 no-cache + ETag 协商新鲜度；?v= 仍作为
 * 强制刷新时的兜底版本。Vite 的 virtual:data-version 会用同一套数据内容哈希
 * 注入，validate-content-contracts.js 负责校验数据与版本计算仍可用。
 * 改过 data/*.json 后不需要改写本文件。
 */
export { DATA_VERSION }

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
  /** 每次 force 加载都开启新的数据代际；旧响应只能完成自己的 promise，不能发布状态。 */
  let loadEpoch = 0

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

  interface MetaCacheEntry { epoch: number; data: unknown }
  interface MetaLoadResult { file: string; required: boolean; ok: boolean; error?: unknown }
  interface MetaInflightEntry { epoch: number; promise: Promise<MetaLoadResult> }

  /** 只缓存当前代际的成功解析结果；旧代际完成后不可污染新代际。 */
  const metaOk = new Map<string, MetaCacheEntry>()
  const metaInflight = new Map<string, MetaInflightEntry>()
  const metaFailuresByEpoch = new Map<number, Set<string>>()
  let metaLoadedEpoch: number | null = null

  function publishMetaResult(epoch: number, result: MetaLoadResult) {
    if (epoch !== loadEpoch) return
    const failures = metaFailuresByEpoch.get(epoch) || new Set<string>()
    if (result.ok) failures.delete(result.file)
    else failures.add(result.file)
    metaFailuresByEpoch.set(epoch, failures)
    metaFailedFiles.value = new Set(failures)
  }

  function loadMetaSpec(
    spec: MetaSpec,
    epoch: number,
    requestVersion: number,
    force: boolean,
  ): Promise<MetaLoadResult> {
    const cached = metaOk.get(spec.file)
    if (!force && cached?.epoch === epoch) {
      if (epoch === loadEpoch) spec.apply(cached.data)
      const result = { file: spec.file, required: spec.required, ok: true }
      publishMetaResult(epoch, result)
      return Promise.resolve(result)
    }

    const existing = metaInflight.get(spec.file)
    if (!force && existing?.epoch === epoch) return existing.promise

    const entry: MetaInflightEntry = { epoch, promise: Promise.resolve({ file: spec.file, required: spec.required, ok: false }) }
    entry.promise = (async () => {
      try {
        const parsed = spec.parse(await fetchJson(spec.file, requestVersion))
        // The response may belong to a previous force load. Let that caller
        // finish, but never publish its data into the current store.
        if (epoch === loadEpoch) {
          metaOk.set(spec.file, { epoch, data: parsed })
          spec.apply(parsed)
        }
        const result = { file: spec.file, required: spec.required, ok: true }
        publishMetaResult(epoch, result)
        return result
      } catch (error) {
        // Only the current epoch may invalidate its own successful cache.
        if (epoch === loadEpoch) metaOk.delete(spec.file)
        const result = { file: spec.file, required: spec.required, ok: false, error }
        publishMetaResult(epoch, result)
        return result
      } finally {
        if (metaInflight.get(spec.file) === entry) metaInflight.delete(spec.file)
      }
    })()
    metaInflight.set(spec.file, entry)
    return entry.promise
  }

  async function loadMeta(force = false, lite = false): Promise<void> {
    const epoch = loadEpoch
    const requestVersion = version.value
    if (!force && metaLoadedEpoch === epoch) return
    const specs = lite ? META_SPECS.filter((spec) => spec.lite) : META_SPECS
    const results = await Promise.all(specs.map((spec) => loadMetaSpec(spec, epoch, requestVersion, force)))
    if (epoch !== loadEpoch) return

    const requiredFailures = results
      .filter((result) => result.required && !result.ok)
      .map((result) => `${result.file}: ${(result.error as Error)?.message ?? result.error}`)
    metaLoadedEpoch = META_SPECS.every((spec) => metaOk.get(spec.file)?.epoch === epoch) ? epoch : null
    if (requiredFailures.length) {
      throw new Error(`必需数据加载失败：${requiredFailures.join('；')}`)
    }
  }

  // ── 分片层：逐分片缓存 + 在途去重 ─────────────────────────────────────

  interface ShardCacheEntry { epoch: number; list: Scene[] }
  interface ShardInflightEntry { epoch: number; promise: Promise<Scene[]> }
  let shardCache: Partial<Record<ShardChar, ShardCacheEntry>> = {}
  let coreLoaded = false
  const shardInflight = new Map<ShardChar, ShardInflightEntry>()

  function loadShard(char: ShardChar, epoch = loadEpoch, requestVersion = version.value): Promise<Scene[]> {
    const cached = shardCache[char]
    if (cached?.epoch === epoch) return Promise.resolve(cached.list)
    const existing = shardInflight.get(char)
    if (existing?.epoch === epoch) return existing.promise
    const entry: ShardInflightEntry = { epoch, promise: Promise.resolve([]) }
    entry.promise = fetchJson<Scene[]>(SHARD_FILES[char], requestVersion)
      .then((list) => {
        const parsed = requireDataRecords(list, SHARD_FILES[char]) as Scene[]
        if (epoch === loadEpoch) {
          shardCache[char] = { epoch, list: parsed }
          loadedShards.value = new Set([...loadedShards.value, char])
        }
        return parsed
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
  function beginTargetLoad(
    key: string,
    work: (isCurrent: () => boolean, epoch: number, requestVersion: number) => Promise<Scene[]>,
  ): Promise<void> {
    viewTarget = key
    const existing = inflightByKey.get(key)
    if (existing) return existing.promise
    const seq = ++workSeq
    const epoch = loadEpoch
    const requestVersion = version.value
    latestSeqByKey.set(key, seq)
    const isCurrent = () => viewTarget === key && latestSeqByKey.get(key) === seq
    beginLoad()
    error.value = null
    const entry: { promise: Promise<void> } = { promise: Promise.resolve() }
    entry.promise = (async () => {
      try {
        const list = await work(isCurrent, epoch, requestVersion)
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

  function beginNewEpoch() {
    loadEpoch += 1
    version.value += 1
    loaded.value = false
    coreLoaded = false
    shardCache = {}
    loadedShards.value = new Set()
    metaOk.clear()
    metaLoadedEpoch = null
    metaFailuresByEpoch.clear()
    metaFailedFiles.value = new Set()
    // Do not cancel or clear old transports here. Their completion handlers
    // still run, but their epoch guards make the result harmless.
  }

  function resolveShard(char: string): ShardChar {
    return char === 'natsume' ? 'natsume' : char === 'triad' || char === 'shared' ? 'shared' : 'nene'
  }

  /** 只加载某角色所需的分片（shared + 目标角色），用于场景库按需浏览。 */
  function loadCharacter(char: string, force = false): Promise<void> {
    const shard = resolveShard(char)
    if (force) {
      beginNewEpoch()
      inflightByKey.delete(`char:${shard}`)
    }
    return beginTargetLoad(`char:${shard}`, async (_isCurrent, epoch, requestVersion) => {
      await loadMeta(false)
      const [shared, target] = await Promise.all([
        loadShard('shared', epoch, requestVersion),
        loadShard(shard, epoch, requestVersion),
      ])
      return mergeScenes(shared, target)
    })
  }

  /** 只加载默认"人设核心"视图所需的数据（index + shared + core 精选子集）。 */
  function loadCore(force = false): Promise<void> {
    if (force) {
      beginNewEpoch()
      inflightByKey.delete('core')
    }
    return beginTargetLoad('core', async (_isCurrent, epoch, requestVersion) => {
      await loadMeta(false)
      const [shared, core] = await Promise.all([
        loadShard('shared', epoch, requestVersion),
        fetchJson<Scene[]>(CORE_FILE, requestVersion),
      ])
      const list = mergeScenes(shared, Array.isArray(core) ? core : [])
      if (epoch === loadEpoch) coreLoaded = true
      return list
    })
  }

  function ensureCharacter(char: string): Promise<void> {
    if (loaded.value) return Promise.resolve()
    const shard = resolveShard(char)
    const cached = shardCache[shard]
    const shared = shardCache.shared
    if (loadedShards.value.has(shard)
      && cached?.epoch === loadEpoch
      && shared?.epoch === loadEpoch) {
      // 目标分片已在手：直接用 shared + 目标分片重建视图，不发请求。
      viewTarget = `char:${shard}`
      scenes.value = mergeScenes(shared.list, cached.list)
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
    if (force) {
      beginNewEpoch()
      inflightByKey.delete('full')
    }
    if (loaded.value && !force) return Promise.resolve()
    return beginTargetLoad('full', async (_isCurrent, epoch, requestVersion) => {
      await loadMeta(false)
      const [shared, nene, natsume] = await Promise.all([
        loadShard('shared', epoch, requestVersion),
        loadShard('nene', epoch, requestVersion),
        loadShard('natsume', epoch, requestVersion),
      ])
      if (epoch === loadEpoch) loaded.value = true
      return mergeScenes(shared, nene, natsume)
    })
  }

  /** 场景管理写回 data/ 之后调用 */
  function reload() {
    return load(true)
  }

  /**
   * 目录页轻载（审计 2026-09-05 P2-02）：首页与全局搜索只吃 curation/角色目录/索引
   * 与三分片；3.4MB 场景蓝图与 prompt 元数据不在此拉取，由创作页的 load()/
   * loadCharacter()/loadCore() 依据逐资源缓存增量补拉。有意不置 loaded 标志——
   * 它只代表"重元数据也齐了"的全量完成态。
   */
  function loadHome(): Promise<void> {
    return beginTargetLoad('home', async (_isCurrent, epoch, requestVersion) => {
      await loadMeta(false, true)
      const [shared, nene, natsume] = await Promise.all([
        loadShard('shared', epoch, requestVersion),
        loadShard('nene', epoch, requestVersion),
        loadShard('natsume', epoch, requestVersion),
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
