import { ApiClientError, apiClient, type ApiClient, type ApiResponseObject } from './client.ts'
import type {
  MaintenanceBuildWebResult,
  HomeHeroCharacter,
  HomeHeroManifestResult,
  HomeHeroSaveResult,
  MaintenanceFailure,
  ShowcaseSaveResult,
} from '../types/api.ts'

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
  saveShowcase(payload: SaveShowcasePayload, options?: MaintenanceCallOptions): Promise<ShowcaseSaveResult>
  getHomeHero(options?: MaintenanceCallOptions): Promise<HomeHeroManifestResult>
  resetHomeHero(character: HomeHeroCharacter, options?: MaintenanceCallOptions): Promise<HomeHeroSaveResult>
  saveHomeHero(character: HomeHeroCharacter, image: string, options?: MaintenanceCallOptions): Promise<HomeHeroSaveResult>
  listBackups(options?: MaintenanceCallOptions): Promise<BackupListResult>
}

function isObject(value: unknown): value is ApiResponseObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function isSuccess(value: ApiResponseObject): boolean { return value.ok === true }

function isHomeHeroManifest(value: ApiResponseObject): boolean {
  return value.ok === true
    && typeof value.version === 'number'
    && isObject(value.entries)
    && Object.entries(value.entries).every(([id, entry]) =>
      (id === 'nene' || id === 'natsume') && isObject(entry)
      && typeof entry.image === 'string'
      && new RegExp(`^/scene-showcase/home/${id}\\.jpg(?:\\?v=[^#]*)?$`).test(entry.image)
      && (entry.updatedAt === null || (typeof entry.updatedAt === 'string' && Number.isFinite(Date.parse(entry.updatedAt))))
      && (entry.source === undefined || entry.source === 'upload'))
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
      return client.request<MaintenanceBuildWebResult>('/api/maintenance/build-web', { method: 'POST', cache: 'no-store', signal: options.signal, timeoutMs: MAINTENANCE_API_TIMEOUTS.buildWeb, validate: isSuccess })
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
