import { profileLocalStorage as localStorage } from '../platform/web/profileStorage.ts'
export const QUICK_CREATE_STORAGE_KEY = 'aics_sd_last_success_v1'

export interface QuickCreateSettings {
  version: 1
  savedAt: number
  checkpoint: string
  sampler: string
  scheduler: string
  cfg: number
  steps: number
  size: string
  hiresFix: boolean
  hiresUpscaler: string
  hiresScale: number
}

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function finite(value: unknown, fallback: number): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function normalizeSize(value: unknown): string {
  const match = text(value).replace(/x/i, '×').match(/^(\d{2,5})×(\d{2,5})$/)
  return match ? `${match[1]}×${match[2]}` : ''
}

export function normalizeQuickCreate(value: unknown): QuickCreateSettings | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  const settings: QuickCreateSettings = {
    version: 1,
    savedAt: finite(source.savedAt, 0),
    checkpoint: text(source.checkpoint),
    sampler: text(source.sampler),
    scheduler: text(source.scheduler),
    cfg: finite(source.cfg, 0),
    steps: Math.max(0, Math.round(finite(source.steps, 0))),
    size: normalizeSize(source.size),
    hiresFix: Boolean(source.hiresFix),
    hiresUpscaler: text(source.hiresUpscaler),
    hiresScale: finite(source.hiresScale, 1.5),
  }
  if (!settings.sampler && !settings.cfg && !settings.steps && !settings.size) return null
  return settings
}

function storage(target?: StorageLike): StorageLike | null {
  if (target) return target
  try { return typeof globalThis.localStorage !== 'undefined' ? localStorage : null } catch { return null }
}

export function readQuickCreate(target?: StorageLike): QuickCreateSettings | null {
  try {
    const store = storage(target)
    return store ? normalizeQuickCreate(JSON.parse(store.getItem(QUICK_CREATE_STORAGE_KEY) || 'null')) : null
  } catch {
    return null
  }
}

export function writeQuickCreate(
  value: Partial<QuickCreateSettings>,
  target?: StorageLike,
): QuickCreateSettings | null {
  const settings = normalizeQuickCreate({ ...value, savedAt: finite(value.savedAt, Date.now()) })
  if (!settings) return null
  try { storage(target)?.setItem(QUICK_CREATE_STORAGE_KEY, JSON.stringify(settings)) } catch {}
  return settings
}

function shortModel(value: string): string {
  const model = text(value).split(/[\\/]/).pop()?.replace(/\.(safetensors|ckpt)$/i, '') || ''
  return model.length > 22 ? `${model.slice(0, 19)}…` : model
}

export function quickCreateSummary(value: unknown): string {
  const settings = normalizeQuickCreate(value)
  if (!settings) return ''
  return [
    shortModel(settings.checkpoint),
    settings.sampler,
    settings.steps ? `${settings.steps} steps` : '',
    settings.cfg ? `CFG ${settings.cfg}` : '',
    settings.size,
  ].filter(Boolean).join(' · ')
}

export function quickCreateUrl(sceneId: unknown): string {
  return `/prompt-builder?scene=${encodeURIComponent(String(sceneId || ''))}&quick=1`
}
