import type { CharacterDirectoryEntry } from '../types/character'
import { isLocalStudioHost } from '../utils/runtimeEnvironment'
import { runtimeFetch, runtimeResourceIdentity } from '../platform/runtimeUrl.ts'
import type { CatalogReceipt } from '../api/catalogApi'
import { catalogInvalidation } from './catalogInvalidation'
import { useBlueprintCatalog } from './useBlueprintCatalog'
import { adoptCatalogPendingPortraits } from '../utils/popularPortraitSource.ts'
import type { SceneRecord as Scene } from '../types/scene.ts'
export type { SceneRecord as Scene } from '../types/scene.ts'

import { defineStore } from 'pinia'
import { nextTick, ref, shallowRef, toRaw, watch } from 'vue'
import { DATA_VERSION } from 'virtual:data-version'
import { requireDataRecords, requireDataCollection } from '../utils/dataRecords.ts'
import {
  characterDirectoryEntry, parsePopularCharactersAsync,
  type PopularCharacter,
} from '../utils/popularContent.ts'

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
export type SceneBrowseTarget = 'core' | 'all' | 'nene' | 'natsume' | 'triad'

/**
 * 静态数据的缓存版本号。
 *
 * 运行时数据由维护链路更新，服务端用 no-cache + ETag 协商新鲜度；?v= 仍作为
 * 强制刷新时的兜底版本。Vite 的 virtual:data-version 会用同一套数据内容哈希
 * 注入，validate-content-contracts.js 负责校验数据与版本计算仍可用。
 * 改过 data/*.json 后不需要改写本文件。
 */
export { DATA_VERSION }

/** Per-file application boundary; a stalled local/remote response must not own loading forever. */
export const SCENE_DATA_TIMEOUT_MS = 15_000

/** 带 response.ok 检查的 JSON 读取 —— 否则 HTML 错误页会被当数据解析 */
async function fetchJson<T>(file: string, version: number, onMissing?: () => Promise<T>): Promise<T> {
  const signal = AbortSignal.timeout(SCENE_DATA_TIMEOUT_MS)
  try {
    const response = await runtimeFetch(`/data/${file}?v=${version}`, { signal })
    if (response.status === 404 && onMissing) return onMissing()
    if (!response.ok) {
      if (response.status === 403) throw new Error('此内容尚未审核为远程可用，请在本机工作室查看。')
      throw new Error(`${file} HTTP ${response.status}`)
    }
    return (await response.json()) as T
  } catch (error) {
    if (signal.aborted) throw new Error(`${file} 请求超时`, { cause: error })
    throw error
  }
}

const CORE_FILE = 'scenes-core.json'
const SHARD_FILES = {
  core: CORE_FILE,
  nene: 'scenes-nene.json',
  natsume: 'scenes-natsume.json',
  shared: 'scenes-shared.json',
} as const
type SceneShard = keyof typeof SHARD_FILES
type ShardChar = Exclude<SceneShard, 'core'>

function sceneNumber(scene: Scene): number {
  const match = /^sc(\d+)$/.exec(String(scene.id || ''))
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER
}

function sortScenes(list: Scene[]): Scene[] {
  return list.toSorted((left, right) => (typeof left.sortOrder === 'number' ? left.sortOrder : sceneNumber(left)) - (typeof right.sortOrder === 'number' ? right.sortOrder : sceneNumber(right)) || String(left.id).localeCompare(String(right.id)))
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
  // Catalog records are read snapshots. Editors load and save independent drafts.
  const scenes = shallowRef<Scene[]>([])
  const curation = shallowRef<CurationData>({})
  const characters = shallowRef<Array<Record<string, unknown>>>([])
  const drawingProfiles = shallowRef<Array<Record<string, unknown>>>([])
  const archiveProfiles = shallowRef<Array<Record<string, unknown>>>([])
  const loras = shallowRef<LoraMeta[]>([])
  const tags = shallowRef<TagMeta[]>([])
  const presets = shallowRef<Record<string, unknown> | unknown[]>([])
  const directoryCharacters = shallowRef<CharacterDirectoryEntry[]>([])
  const sceneTitles = shallowRef(new Map<string, string>())
  let cachedCuration: CurationData = {}
  const popularCharacters = shallowRef<PopularCharacter[]>([])
  const blueprintCatalog = useBlueprintCatalog(() => fetchJson('scene-blueprints.json', version.value))
  const { sceneBlueprints, loadBlueprintCharacter, hasBlueprintCharacter } = blueprintCatalog

  const loading = ref(false)
  const error = ref<string | null>(null)
  /** 完整数据已加载（三条角色分片齐了才算）；部分加载只算 partial。 */
  const loaded = ref(false)
  /** 手动作废缓存时递增，用于绕过浏览器缓存（场景管理保存后要读到新数据） */
  const version = ref(DATA_VERSION)
  /** 最近一次加载中失败的元数据文件（可选资源失败在此可见，不阻塞完成） */
  const metaFailedFiles = ref<Set<string>>(new Set())
  /** 每次 force 加载都开启新的数据代际；旧响应只能完成自己的 promise，不能发布状态。 */
  let loadEpoch = 0
  let catalogReceiptVersion: number | null = null

  interface MetaSpec {
    file: string
    /** 必需资源失败必须让整次加载失败并可见；可选资源失败保留上次成功数据。 */
    required: boolean
    read?: (epoch: number, version: number) => Promise<unknown>
    parse: (raw: unknown) => unknown | Promise<unknown>
    apply: (data: unknown) => void
  }

  const META_SPECS: MetaSpec[] = [
    { file: 'curation.json', required: false, parse: (raw) => raw ?? {}, apply: (d) => { cachedCuration = d as CurationData; curation.value = structuredClone(cachedCuration) } },
    { file: 'characters.json', required: true, parse: (raw) => requireDataRecords(raw, 'characters.json'), apply: (d) => { characters.value = d as Array<Record<string, unknown>>; adoptCatalogPendingPortraits(d) } },
    { file: 'loras.json', required: false, parse: (raw) => requireDataRecords(raw, 'LoRA资料'), apply: (d) => { loras.value = d as LoraMeta[] } },
    { file: 'tags.json', required: false, parse: (raw) => (Array.isArray(raw) ? raw : []), apply: (d) => { tags.value = d as TagMeta[] } },
    { file: 'presets.json', required: false, parse: (raw) => raw ?? [], apply: (d) => { presets.value = d as Record<string, unknown> | unknown[] } },
    { file: 'popular-characters.json', required: true, parse: (raw) => parsePopularCharactersAsync(requireDataCollection(raw, 'characters')), apply: (d) => { popularCharacters.value = d as PopularCharacter[]; adoptCatalogPendingPortraits(d) } },
  ]

  const directorySpec: MetaSpec = {
    file: 'popular-directory.json', required: true,
    read: (_epoch, version) => {
      const fallback = () => fetchJson<unknown>('popular-characters.json', version)
      return isLocalStudioHost() ? fetchJson('popular-directory.json', version, fallback) : fallback()
    },
    parse: raw => requireDataRecords(requireDataCollection(raw, 'characters'), '角色目录').map(characterDirectoryEntry),
    apply: data => { directoryCharacters.value = data as CharacterDirectoryEntry[]; adoptCatalogPendingPortraits(data) },
  }
  const archiveSpec: MetaSpec = {
    file: 'character-archive.json', required: true,
    read: async (epoch, version) => {
      const fullProfiles = async () => {
        const read = await loadMetaSpec(metadata('characters.json'), epoch, version)
        if (!read.ok) throw read.error
        return toRaw(characters.value)
      }
      return metaOk.has('characters.json') || !isLocalStudioHost()
        ? fullProfiles() : fetchJson('character-archive.json', version, fullProfiles)
    },
    parse: raw => requireDataRecords(raw, '角色档案'),
    apply: data => { archiveProfiles.value = data as Array<Record<string, unknown>>; adoptCatalogPendingPortraits(data) },
  }
  const drawingProfilesSpec: MetaSpec = {
    file: 'character-drawing.json', required: true,
    read: async (epoch, version) => {
      const fullProfiles = async () => {
        const read = await loadMetaSpec(metadata('characters.json'), epoch, version)
        if (!read.ok) throw read.error
        return toRaw(characters.value)
      }
      return metaOk.has('characters.json') || !isLocalStudioHost()
        ? fullProfiles() : fetchJson('character-drawing.json', version, fullProfiles)
    },
    parse: raw => requireDataRecords(raw, '绘制角色'),
    apply: data => { drawingProfiles.value = data as Array<Record<string, unknown>> },
  }
  const drawingScenesSpec: MetaSpec = {
    file: 'scenes.json', required: true,
    read: (epoch, version) => {
      if (loaded.value) return Promise.resolve(toRaw(scenes.value))
      const shards = () => Promise.all((['shared', 'nene', 'natsume'] as const)
        .map(shard => loadShard(shard, epoch, version))).then(lists => mergeScenes(...lists))
      return isLocalStudioHost() ? fetchJson('scenes.json', version, shards) : shards()
    },
    parse: raw => sortScenes(requireDataRecords(raw, '工作台场景') as Scene[]),
    apply: data => { scenes.value = data as Scene[] },
  }
  const titlesSpec: MetaSpec = {
    file: 'scene-titles.json', required: true,
    read: (epoch, version) => {
      const fallback = () => Promise.all((['shared', 'nene', 'natsume'] as const)
        .map(shard => loadShard(shard, epoch, version))).then(lists => mergeScenes(...lists))
      return isLocalStudioHost() ? fetchJson('scene-titles.json', version, fallback) : fallback()
    },
    parse: raw => new Map(requireDataRecords(raw, '场景标题').map(row => [row.id as string, typeof row.title === 'string' ? row.title : ''])),
    apply: data => { sceneTitles.value = data as Map<string, string> },
  }

  interface MetaLoadResult { file: string; required: boolean; ok: boolean; error?: unknown }
  interface MetaInflightEntry { epoch: number; promise: Promise<MetaLoadResult> }

  /** 只缓存当前代际的成功解析结果；旧代际完成后不可污染新代际。 */
  const metaOk = new Set<string>()
  const metaInflight = new Map<string, MetaInflightEntry>()
  const requestedMetadata = new Set<MetaSpec>()

  function publishMetaResult(epoch: number, result: MetaLoadResult) {
    if (epoch !== loadEpoch) return
    const failed = !result.ok
    if (metaFailedFiles.value.has(result.file) === failed) return
    const failures = new Set(metaFailedFiles.value)
    if (result.ok) failures.delete(result.file)
    else failures.add(result.file)
    metaFailedFiles.value = failures
  }

  function loadMetaSpec(
    spec: MetaSpec,
    epoch: number,
    requestVersion: number,
  ): Promise<MetaLoadResult> {
    requestedMetadata.add(spec)
    if (epoch === loadEpoch && metaOk.has(spec.file)) {
      const result = { file: spec.file, required: spec.required, ok: true }
      publishMetaResult(epoch, result)
      return Promise.resolve(result)
    }

    const existing = metaInflight.get(spec.file)
    if (existing?.epoch === epoch) return existing.promise

    const entry: MetaInflightEntry = { epoch, promise: Promise.resolve({ file: spec.file, required: spec.required, ok: false }) }
    entry.promise = (async () => {
      try {
        const raw = await (spec.read ? spec.read(epoch, requestVersion) : fetchJson(spec.file, requestVersion))
        const parsed = await spec.parse(raw)
        // The response may belong to a previous force load. Let that caller
        // finish, but never publish its data into the current store.
        if (epoch === loadEpoch) {
          spec.apply(parsed)
          metaOk.add(spec.file)
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

  async function loadOne(spec: MetaSpec) {
    const result = await loadMetaSpec(spec, loadEpoch, version.value)
    if (!result.ok) throw result.error
  }
  const metadata = (file: string) => META_SPECS.find(spec => spec.file === file)!
  const loadLoraCatalog = () => loadOne(metadata('loras.json'))
  const loadCharacterArchive = () => loadOne(archiveSpec)
  const loadCharacterProfiles = () => loadOne(metadata('characters.json'))
  const loadPresetCatalog = () => loadOne(metadata('presets.json'))
  const loadPopularCharacters = () => loadOne(metadata('popular-characters.json'))
  const loadCharacterDirectory = () => loadOne(directorySpec)
  const loadSceneTitles = () => loadOne(titlesSpec)
  const loadCuration = () => loadOne(metadata('curation.json'))

  async function loadMeta(specs = META_SPECS): Promise<void> {
    const epoch = loadEpoch
    const requestVersion = version.value
    const requests = specs.map((spec) => loadMetaSpec(spec, epoch, requestVersion))
    const results = await Promise.all(requests.filter((_request, index) => specs[index].required))
    if (epoch !== loadEpoch) return

    const requiredFailures = results
      .filter((result) => result.required && !result.ok)
      .map((result) => `${result.file}: ${(result.error as Error)?.message ?? result.error}`)
    if (requiredFailures.length) {
      throw new Error(`必需数据加载失败：${requiredFailures.join('；')}`)
    }
  }

  // ── 分片层：逐分片缓存 + 在途去重 ─────────────────────────────────────

  interface ShardCacheEntry { epoch: number; list: Scene[] }
  interface ShardInflightEntry { epoch: number; promise: Promise<Scene[]> }
  let shardCache: Partial<Record<SceneShard, ShardCacheEntry>> = {}
  const shardInflight = new Map<SceneShard, ShardInflightEntry>()

  function loadShard(char: SceneShard, epoch = loadEpoch, requestVersion = version.value): Promise<Scene[]> {
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
        }
        return parsed
      })
      .finally(() => { if (shardInflight.get(char) === entry) shardInflight.delete(char) })
    shardInflight.set(char, entry)
    return entry.promise
  }

  let fullRequest: Promise<void> | undefined
  let fullRequested = false

  function invalidate(sourceChanged = false, scope?: ReturnType<typeof catalogInvalidation>) {
    loadEpoch += 1
    loaded.value = false
    fullRequest = undefined
    loading.value = false
    if (!scope) { shardCache = {}; metaOk.clear(); catalogReceiptVersion = null }
    else {
      for (const file of scope.metadata) metaOk.delete(file)
      for (const char of Object.keys(shardCache) as SceneShard[]) {
        if (scope.shards.has(char)) delete shardCache[char]
        else shardCache[char]!.epoch = loadEpoch
      }
    }
    metaFailedFiles.value = new Set()
    blueprintCatalog.invalidate(scope?.blueprints)
    if (sourceChanged) {
      directoryCharacters.value = []; sceneTitles.value = new Map(); cachedCuration = {}
      scenes.value = []; curation.value = {}; characters.value = []; archiveProfiles.value = []; drawingProfiles.value = []; loras.value = []
      adoptCatalogPendingPortraits([])
      tags.value = []; presets.value = []; popularCharacters.value = []
      error.value = null
    }
    // Do not cancel or clear old transports here. Their completion handlers
    // still run, but their epoch guards make the result harmless.
    version.value += 1
  }
  function invalidateCatalog(receipt: CatalogReceipt) {
    if (!receipt.diffs.length && receipt.version === catalogReceiptVersion) return
    // Only consecutive own receipts prove no other writer changed an omitted
    // dependency. First saves and nonconsecutive revisions refresh broadly.
    const scope = receipt.diffs.length && catalogReceiptVersion !== null && receipt.version === catalogReceiptVersion + 1
      ? catalogInvalidation(receipt.diffs) : undefined
    invalidate(false, scope)
    catalogReceiptVersion = receipt.version
  }

  watch(runtimeResourceIdentity, () => {
    invalidate(true)
    const epoch = loadEpoch
    // Runtime publication finishes installing the transport after publishing
    // its resource identity. Reload only catalogs already requested by this UI.
    void nextTick().then(async () => {
      if (epoch !== loadEpoch) return
      const reads: Promise<unknown>[] = [...requestedMetadata].map(spec => loadMetaSpec(spec, epoch, version.value))
      if (fullRequested) reads.push(load())
      await Promise.all(reads)
    }).catch(cause => { if (epoch === loadEpoch) error.value = String(cause instanceof Error ? cause.message : cause) })
  }, { flush: 'sync' })

  function resolveShard(char: string): ShardChar {
    return char === 'natsume' ? 'natsume' : char === 'triad' || char === 'shared' ? 'shared' : 'nene'
  }

  /** Browsing needs scene shards and curation, not the studio's model/tag/blueprint catalogs. */
  async function loadBrowserScenes(target: SceneBrowseTarget): Promise<{ scenes: Scene[]; curation: CurationData }> {
    const epoch = loadEpoch, requestVersion = version.value
    const files: SceneShard[] = target === 'all' ? ['shared', 'nene', 'natsume']
      : target === 'core' ? ['shared', 'core'] : ['shared', resolveShard(target)]
    const [curationResult, lists] = await Promise.all([
      loadMetaSpec(metadata('curation.json'), epoch, requestVersion),
      Promise.all([...new Set(files)].map(file => loadShard(file, epoch, requestVersion))),
    ])
    if (epoch !== loadEpoch) throw new Error('场景目录已更新，请重新读取。')
    if (!curationResult.ok) throw curationResult.error
    // Merge creates a view-owned list of read-only catalog records.
    return { scenes: mergeScenes(...lists), curation: structuredClone(cachedCuration) }
  }

  /**
   * 加载共享数据集。重复调用只发一次请求；已加载则直接返回。
   * @param force 场景管理保存后需要读回落盘结果时传 true
   */
  function load(force = false): Promise<void> {
    if (force) invalidate()
    fullRequested = true
    if (loaded.value) return Promise.resolve()
    if (fullRequest) return fullRequest
    const epoch = loadEpoch
    loading.value = true; error.value = null
    fullRequest = Promise.all([loadMeta(), loadShard('shared'), loadShard('nene'), loadShard('natsume')])
      .then(([, shared, nene, natsume]) => {
        if (epoch !== loadEpoch) return
        scenes.value = mergeScenes(shared, nene, natsume)
        loaded.value = true
      })
      .catch(cause => { if (epoch === loadEpoch) error.value = cause instanceof Error ? cause.message : String(cause) })
      .finally(() => { if (epoch === loadEpoch) { loading.value = false; fullRequest = undefined } })
    return fullRequest
  }

  function loadCharacterShell(force = false): Promise<void> {
    if (force) invalidate()
    return loadMeta([metadata('characters.json'), metadata('popular-characters.json')])
  }
  function loadDrawingCatalog() {
    const files = ['curation.json', 'loras.json', 'tags.json']
    return Promise.all([
      loadMeta([drawingProfilesSpec, drawingScenesSpec, ...files.map(metadata)]),
      loadPresetCatalog(),
    ]).then(() => undefined)
  }

  return {
    scenes, curation, characters, loras, tags, presets,
    popularCharacters, sceneBlueprints, hasBlueprintCharacter,
    loading, error, loaded, version, metaFailedFiles,
    archiveProfiles, drawingProfiles, loadCharacterArchive, loadCharacterProfiles, loadDrawingCatalog,
    directoryCharacters, sceneTitles, loadCharacterDirectory, loadSceneTitles, loadCuration, loadPopularCharacters,
    load, loadBrowserScenes, loadBlueprintCharacter, loadCharacterShell, loadLoraCatalog, loadPresetCatalog, invalidate, invalidateCatalog,
  }
})
