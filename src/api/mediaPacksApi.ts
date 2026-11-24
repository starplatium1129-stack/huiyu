import { apiClient } from './client'

export type MediaPackId = 'portraits' | 'showcase'

export interface MediaPackRemote {
  available: boolean
  version: string | null
  label: string
  description: string
  bytes: number
  fileCount: number
  updateAvailable: boolean
}

export interface MediaPackItem {
  id: MediaPackId
  label: string
  description: string
  installed: boolean
  source: 'bundled' | 'downloaded' | 'offline' | 'local' | 'none'
  canUninstall: boolean
  installedVersion: string | null
  installedFiles: number
  installedBytes: number
  partialBytes: number
  remote: MediaPackRemote
}

export interface MediaPacksTask {
  id: string
  state: 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled'
  packId: MediaPackId | null
  queue: MediaPackId[]
  completedPacks: MediaPackId[]
  phase: 'fetching-index' | 'downloading' | 'verifying' | 'extracting' | 'switching' | string
  bytes: number
  total: number
  filesDone: number
  filesTotal: number
  speedBps: number
  mirrorLabel: string
  message: string
  error: string | null
  startedAt: number
  finishedAt: number
}

export interface MediaPacksSettings {
  mirrorOrigin: string
  manifestUrl: string
  defaultManifestUrl: string
  onboardingDismissed: boolean
}

export interface MediaPacksStatus {
  ok: true
  busy: boolean
  storageRoot: string
  remoteReady: boolean
  remoteUpdatedAt: string | null
  remoteError: string | null
  settings: MediaPacksSettings
  onboarding: {
    shouldPrompt: boolean
    dismissed: boolean
    missingPortraits: boolean
    missingShowcase: boolean
  }
  packs: MediaPackItem[]
  task: MediaPacksTask | null
}

const common = { cache: 'no-store', cachePolicy: 'bypass', timeoutMs: 25_000 } as const

export const mediaPacksApi = {
  status(refresh = false, signal?: AbortSignal) {
    return apiClient.request<MediaPacksStatus>(
      '/api/media-packs/status' + (refresh ? '?refresh=1' : ''),
      { ...common, signal },
    )
  },
  install(packs: MediaPackId[], signal?: AbortSignal) {
    return apiClient.request<{ ok: true; task: MediaPacksTask }>('/api/media-packs/install', {
      ...common,
      method: 'POST',
      body: { packs },
      signal,
    })
  },
  cancel(signal?: AbortSignal) {
    return apiClient.request<{ ok: true; task: MediaPacksTask | null }>('/api/media-packs/cancel', {
      ...common,
      method: 'POST',
      body: {},
      signal,
    })
  },
  uninstall(packId: MediaPackId, signal?: AbortSignal) {
    return apiClient.request<{ ok: true }>('/api/media-packs/uninstall', {
      ...common,
      method: 'POST',
      body: { packId },
      signal,
    })
  },
  updateSettings(
    patch: { mirrorOrigin?: string; manifestUrl?: string; onboardingDismissed?: boolean },
    signal?: AbortSignal,
  ) {
    return apiClient.request<{ ok: true; settings: MediaPacksSettings }>('/api/media-packs/settings', {
      ...common,
      method: 'POST',
      body: patch,
      signal,
    })
  },
}
