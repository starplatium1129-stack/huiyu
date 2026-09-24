import { ApiClientError, apiClient, type ApiClient, type ApiResponseObject } from './client.ts'
import type {
  CurationData,
  HomeHeroCharacter,
  HomeHeroManifestResult,
  HomeHeroSaveResult,
  MaintenanceBuildWebResult,
  MaintenanceFailure,
  MaintenanceRunResult,
  SceneDraft,
  SceneChangesPayload,
  SceneChangesPreview,
  SceneMaintenanceSnapshot,
  SceneSaveResult,
  ScenesStateResult,
  ShowcaseSaveResult,
  TagRecord,
} from '../types/api.ts'
import type { SceneBlueprint } from '../utils/popularContent.ts'

export const MAINTENANCE_API_TIMEOUTS = {
  query: 10_000,
  upload: 120_000,
  buildWeb: 120_000,
  run: 130_000,
  scenes: 390_000,
} as const

export interface MaintenanceCallOptions {
  signal?: AbortSignal
}

export interface SaveScenesPayload {
  scenes: SceneDraft[]
  tags: TagRecord[]
  curation: CurationData
  /** 可选：热门角色蓝图（scene-blueprints.json），传入时随场景一起保存并跑内容契约校验。 */
  blueprints?: SceneBlueprint[]
  /**
   * 读取基线版本（页面加载/上次保存时的内容版本）。服务端据此拒绝用旧快照
   * 覆盖已被其他会话/构建更新的数据（计划 006 D5），缺失时保存返回 409。
   */
  baseVersion?: number
}

export interface SaveShowcasePayload {
  id: string
  image: string
  thumbnail: string
}

export interface BackupEntry {
  id: string
  label: string
  createdAt: string
  fileCount: number
}

export interface BackupListResult {
  ok: true
  entries: BackupEntry[]
}

export interface MaintenanceApi {
  buildWeb(options?: MaintenanceCallOptions): Promise<MaintenanceBuildWebResult>
  saveScenes(payload: SaveScenesPayload, options?: MaintenanceCallOptions): Promise<SceneSaveResult>
  importScenesSnapshot(payload: SceneMaintenanceSnapshot & { baseVersion: number }, options?: MaintenanceCallOptions): Promise<SceneSaveResult>
  saveSceneChanges(payload: SceneChangesPayload, options?: MaintenanceCallOptions): Promise<SceneSaveResult>
  previewSceneChanges(payload: SceneChangesPayload, options?: MaintenanceCallOptions): Promise<SceneChangesPreview>
  getScenesState(options?: MaintenanceCallOptions): Promise<ScenesStateResult>
  run(task: string, options?: MaintenanceCallOptions): Promise<MaintenanceRunResult>
  saveShowcase(payload: SaveShowcasePayload, options?: MaintenanceCallOptions): Promise<ShowcaseSaveResult>
  getHomeHero(options?: MaintenanceCallOptions): Promise<HomeHeroManifestResult>
  resetHomeHero(character: HomeHeroCharacter, options?: MaintenanceCallOptions): Promise<HomeHeroSaveResult>
  saveHomeHero(character: HomeHeroCharacter, image: string, options?: MaintenanceCallOptions): Promise<HomeHeroSaveResult>
  listBackups(options?: MaintenanceCallOptions): Promise<BackupListResult>
}

function isObject(value: unknown): value is ApiResponseObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSuccess(value: ApiResponseObject): boolean {
  return value.ok === true
}

function isSceneSave(value: ApiResponseObject): boolean {
  return value.ok === true
    && typeof value.count === 'number'
    && typeof value.backup === 'string'
    && Number.isSafeInteger(value.version)
    && isSceneSnapshot(value.snapshot)
}

function isSceneSnapshot(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as Record<string, unknown>
  return Array.isArray(snapshot.scenes) && Array.isArray(snapshot.tags)
    && Array.isArray(snapshot.blueprints) && !!snapshot.curation
    && typeof snapshot.curation === 'object' && !Array.isArray(snapshot.curation)
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function isChangeImpact(value: unknown): boolean {
  return isObject(value) && isStringList(value.added) && isStringList(value.updated) && isStringList(value.removed)
}

function isScenePreview(value: ApiResponseObject): boolean {
  return value.ok === true && Number.isSafeInteger(value.baseVersion) && Number.isSafeInteger(value.version)
    && isChangeImpact(value) && isChangeImpact(value.blueprints)
    && isStringList(value.checks) && isStringList(value.unknown)
    && Array.isArray(value.related) && value.related.every(item => isObject(item)
      && typeof item.kind === 'string' && typeof item.id === 'string' && typeof item.reason === 'string')
}

function isScenesState(value: ApiResponseObject): boolean {
  return value.ok === true
    && (typeof value.nextSceneId === 'string' || value.nextSceneId === null)
    && Number.isSafeInteger(value.version)
    && isSceneSnapshot(value.snapshot)
    && typeof value.sceneCount === 'number'
    && typeof value.retiredCount === 'number'
}

function isRunResult(value: ApiResponseObject): boolean {
  return value.ok === true
    && typeof value.task === 'string'
    && typeof value.label === 'string'
    && typeof value.output === 'string'
    && typeof value.exitCode === 'number'
}

function isHomeHeroManifest(value: ApiResponseObject): boolean {
  return value.ok === true
    && typeof value.version === 'number'
    && isObject(value.entries)
}

function isBackupList(value: ApiResponseObject): boolean {
  return value.ok === true && Array.isArray(value.entries)
}

export function maintenanceFailure(error: unknown): MaintenanceFailure | null {
  if (!(error instanceof ApiClientError) || !error.responseBody || error.responseBody.ok !== false) return null
  return error.responseBody as unknown as MaintenanceFailure
}

export function createMaintenanceApi(client: ApiClient = apiClient): MaintenanceApi {
  return {
    buildWeb(options: MaintenanceCallOptions = {}) {
      return client.request<MaintenanceBuildWebResult>('/api/maintenance/build-web', {
        method: 'POST',
        cache: 'no-store',
        signal: options.signal,
        timeoutMs: MAINTENANCE_API_TIMEOUTS.buildWeb,
        validate: isSuccess,
      })
    },

    saveScenes(payload: SaveScenesPayload, options: MaintenanceCallOptions = {}) {
      return client.request<SceneSaveResult>('/api/maintenance/scenes', {
        method: 'POST',
        cache: 'no-store',
        body: payload,
        signal: options.signal,
        timeoutMs: MAINTENANCE_API_TIMEOUTS.scenes,
        validate: isSceneSave,
      })
    },

    importScenesSnapshot(payload: SceneMaintenanceSnapshot & { baseVersion: number }, options: MaintenanceCallOptions = {}) {
      return client.request<SceneSaveResult>('/api/maintenance/scenes/import', {
        method: 'POST', cache: 'no-store', body: payload, signal: options.signal,
        timeoutMs: MAINTENANCE_API_TIMEOUTS.scenes, validate: isSceneSave,
      })
    },

    getScenesState(options: MaintenanceCallOptions = {}) {
      return client.request<ScenesStateResult>('/api/maintenance/scenes-state', {
        cache: 'no-store',
        cachePolicy: 'bypass',
        signal: options.signal,
        timeoutMs: MAINTENANCE_API_TIMEOUTS.query,
        validate: isScenesState,
      })
    },

    saveSceneChanges(payload: SceneChangesPayload, options: MaintenanceCallOptions = {}) {
      return client.request<SceneSaveResult>('/api/maintenance/scenes/changes', {
        method: 'POST', cache: 'no-store', body: payload, signal: options.signal,
        timeoutMs: MAINTENANCE_API_TIMEOUTS.scenes, validate: isSceneSave,
      })
    },

    previewSceneChanges(payload: SceneChangesPayload, options: MaintenanceCallOptions = {}) {
      return client.request<SceneChangesPreview>('/api/maintenance/scenes/preview', {
        method: 'POST', cache: 'no-store', body: payload, signal: options.signal,
        timeoutMs: MAINTENANCE_API_TIMEOUTS.scenes, validate: isScenePreview,
      })
    },

    run(task: string, options: MaintenanceCallOptions = {}) {
      return client.request<MaintenanceRunResult>('/api/maintenance/run', {
        method: 'POST',
        cache: 'no-store',
        body: { task },
        signal: options.signal,
        timeoutMs: MAINTENANCE_API_TIMEOUTS.run,
        validate: isRunResult,
      })
    },

    saveShowcase(payload: SaveShowcasePayload, options: MaintenanceCallOptions = {}) {
      return client.request<ShowcaseSaveResult>('/api/maintenance/showcase', {
        method: 'POST',
        cache: 'no-store',
        body: payload,
        signal: options.signal,
        timeoutMs: MAINTENANCE_API_TIMEOUTS.upload,
        validate: isSuccess,
      })
    },

    getHomeHero(options: MaintenanceCallOptions = {}) {
      return client.request<HomeHeroManifestResult>('/api/maintenance/home-hero', {
        cache: 'no-store',
        signal: options.signal,
        timeoutMs: MAINTENANCE_API_TIMEOUTS.query,
        validate: isHomeHeroManifest,
      })
    },

    resetHomeHero(character: HomeHeroCharacter, options: MaintenanceCallOptions = {}) {
      return client.request<HomeHeroSaveResult>('/api/maintenance/home-hero', {
        method: 'POST',
        cache: 'no-store',
        body: { character, action: 'reset' },
        signal: options.signal,
        timeoutMs: MAINTENANCE_API_TIMEOUTS.upload,
        validate: isSuccess,
      })
    },

    saveHomeHero(character: HomeHeroCharacter, image: string, options: MaintenanceCallOptions = {}) {
      return client.request<HomeHeroSaveResult>('/api/maintenance/home-hero', {
        method: 'POST',
        cache: 'no-store',
        body: { character, image },
        signal: options.signal,
        timeoutMs: MAINTENANCE_API_TIMEOUTS.upload,
        validate: isSuccess,
      })
    },

    listBackups(options: MaintenanceCallOptions = {}) {
      return client.request<BackupListResult>('/api/maintenance/backups', {
        cache: 'no-store',
        signal: options.signal,
        timeoutMs: MAINTENANCE_API_TIMEOUTS.query,
        validate: isBackupList,
      })
    },
  }
}

export const maintenanceApi = createMaintenanceApi()
